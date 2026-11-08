const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repoRoot = path.join(__dirname, "..");

function createModules(t, rows = "") {
    const dom = new JSDOM(
        `<aside class="live_chatting_area"><header class="chat-header"><strong>채팅</strong><button aria-label="더보기">⋮</button></header><div class="chat-list" role="log">${rows}</div></aside>`,
        { url: "https://chzzk.naver.com/live/test-channel", runScripts: "outside-only", pretendToBeVisual: true }
    );
    const cleanup = [];
    t.after(() => {
        for (const dispose of cleanup) dispose();
        dom.window.close();
    });
    for (const filename of [
        "shared/settings.js",
        "shared/data.js",
        "content.js",
        "features/chatTools/parser.js",
        "features/chatTools/messageStore.js",
        "features/chatTools/panel.js",
    ]) {
        dom.window.eval(fs.readFileSync(path.join(repoRoot, filename), "utf8"));
    }
    const pending = new Map();
    let nextTimer = 1;
    dom.window.setTimeout = (callback) => {
        const id = nextTimer++;
        pending.set(id, callback);
        return id;
    };
    dom.window.clearTimeout = (id) => pending.delete(id);
    const namespace = dom.window.CheeseSpanner.chatTools;
    const root = dom.window.document.querySelector(".chat-list");
    const published = [];
    const store = namespace.createMessageStore({ onChange: (messages) => published.push(messages) });
    store.adoptRoot(root);
    cleanup.push(() => store.resetRoot());
    return {
        dom,
        namespace,
        root,
        store,
        published,
        pending,
        cleanup,
        collect(row) {
            store.noteMutation(row);
            store.collect(store.parseChatMessage(row));
        },
        nextPass() {
            const callbacks = Array.from(pending.values());
            pending.clear();
            for (const callback of callbacks) callback();
        },
        snapshot() {
            return published[published.length - 1] || [];
        },
    };
}

function moderatorRow({ id = "", index = "", author = "운영자", text = "안내" } = {}) {
    return `<div class="chat-row" ${id ? `data-chat-id="${id}"` : ""} ${index ? `data-virtual-index="${index}"` : ""}><span class="badge" aria-label="매니저"></span><span class="nickname">${author}</span><span class="message">${text}</span></div>`;
}

test("the stateless parser reads current DOM without collecting, adding markers, or assigning an identity", (t) => {
    const h = createModules(t, moderatorRow({ author: "첫 작성자", text: "첫 본문" }));
    const row = h.root.firstElementChild;
    const initialMarkup = row.outerHTML;
    const first = h.namespace.parser.parseChatRow(row);
    assert.equal(first.author, "첫 작성자");
    assert.equal(first.text, "첫 본문");
    assert.equal(first.role, "manager");
    assert.equal(first.id, undefined);
    assert.equal(row.outerHTML, initialMarkup);
    assert.equal(h.published.length, 0);

    row.querySelector(".nickname").textContent = "다음 작성자";
    row.querySelector(".message").textContent = "다음 본문";
    row.querySelector(".badge").remove();
    const second = h.namespace.parser.parseChatRow(row);
    assert.equal(second.author, "다음 작성자");
    assert.equal(second.text, "다음 본문");
    assert.equal(second.role, "");
    assert.equal(first.author, "첫 작성자");
});

test("message snapshots isolate collection ownership and acknowledge only existing unread messages", (t) => {
    const h = createModules(t, moderatorRow({ id: "first" }));
    const row = h.root.firstElementChild;
    h.collect(row);
    const message = h.snapshot()[0];
    assert.equal(Object.hasOwn(message, "node"), false);
    assert.equal(Object.hasOwn(message, "sourceIdentityKey"), false);
    assert.equal(Object.isFrozen(message), true);
    assert.equal(Object.isFrozen(message.badges), true);
    assert.equal(Reflect.set(message, "text", "외부 변경"), false);
    const count = h.published.length;
    h.store.markRead(["missing-id"]);
    assert.equal(h.published.length, count);
    h.store.markRead([message.id]);
    assert.equal(h.snapshot()[0].unread, false);
    assert.equal(message.unread, true);
    assert.equal(h.snapshot()[0].recordId, message.recordId);
    h.store.markRead([message.id]);
    assert.equal(h.published.length, count + 1);

    let scrolls = 0;
    row.scrollIntoView = () => scrolls++;
    h.store.navigate(message.id, message.recordId);
    assert.equal(scrolls, 1);
    row.querySelector(".nickname").textContent = "재사용된 작성자";
    h.store.navigate(message.id, message.recordId);
    assert.equal(scrolls, 1);
    h.store.clear();
    h.collect(row);
    const replacement = h.snapshot()[0];
    assert.equal(replacement.id, message.id);
    assert.notEqual(replacement.recordId, message.recordId);
    h.store.navigate(message.id, message.recordId);
    assert.equal(scrolls, 1);
    h.store.navigate(replacement.id, replacement.recordId);
    assert.equal(scrolls, 2);
});

test("capacity eviction retains native row ownership without reviving old messages on a later mutation", (t) => {
    const h = createModules(t, moderatorRow({ id: "old" }) + moderatorRow({ id: "new", text: "최근 안내" }));
    h.store.configure({ enabled: true, maximum: 1 });
    const [oldRow, newRow] = h.root.children;
    h.collect(oldRow);
    h.collect(newRow);
    assert.deepEqual(
        Array.from(h.snapshot(), (message) => message.text),
        ["최근 안내"]
    );
    assert.equal(h.store.hasBinding(oldRow), true);
    assert.equal(oldRow.getAttribute("data-bcct-moderator-highlight"), "1");
    oldRow.querySelector(".nickname").style.color = "rgb(1, 2, 3)";
    h.collect(oldRow);
    h.store.finishScan(true);
    assert.deepEqual(
        Array.from(h.snapshot(), (message) => message.text),
        ["최근 안내"]
    );
});

test("reuse candidates restart on mutation revisions and cancel at reset before queued callbacks can publish", (t) => {
    const h = createModules(t, moderatorRow({ index: "1" }));
    const row = h.root.firstElementChild;
    h.collect(row);
    row.setAttribute("data-virtual-index", "2");
    row.querySelector(".nickname").textContent = "다음 운영자";
    h.collect(row);
    h.nextPass();
    assert.equal(h.snapshot().length, 1);
    row.querySelector(".message").textContent = "최종 안내";
    h.store.noteMutation(row);
    h.nextPass();
    assert.equal(h.snapshot().length, 1);
    h.nextPass();
    assert.equal(h.snapshot().length, 1);
    h.nextPass();
    assert.deepEqual(
        Array.from(h.snapshot(), (message) => message.text),
        ["안내", "최종 안내"]
    );

    row.setAttribute("data-virtual-index", "3");
    h.collect(row);
    const staleCallbacks = Array.from(h.pending.values());
    assert.equal(staleCallbacks.length, 1);
    h.store.resetRoot();
    h.store.clear();
    for (const callback of staleCallbacks) callback();
    assert.equal(h.pending.size, 0);
    assert.equal(h.snapshot().length, 0);
    assert.equal(row.hasAttribute("data-bcct-moderator-collected"), false);
    assert.equal(row.hasAttribute("data-bcct-moderator-highlight"), false);
});

test("an empty root remount preserves id-less records and read state only through its first hydration", (t) => {
    const h = createModules(t, moderatorRow());
    h.collect(h.root.firstElementChild);
    const first = h.snapshot()[0];
    h.store.markRead([first.id]);
    const nextRoot = h.root.cloneNode(false);
    h.root.replaceWith(nextRoot);
    h.store.adoptRoot(nextRoot);
    h.store.finishScan(false);
    nextRoot.innerHTML = moderatorRow();
    h.collect(nextRoot.firstElementChild);
    h.store.finishScan(true);
    assert.equal(h.snapshot().length, 1);
    assert.equal(h.snapshot()[0].id, first.id);
    assert.equal(h.snapshot()[0].recordId, first.recordId);
    assert.equal(h.snapshot()[0].unread, false);
    nextRoot.insertAdjacentHTML("beforeend", moderatorRow());
    h.collect(nextRoot.lastElementChild);
    assert.equal(h.snapshot().length, 2);
    assert.notEqual(h.snapshot()[1].id, first.id);
    assert.equal(h.snapshot()[1].unread, true);
});

test("a cleared list keeps id-less records in removal order only through the next hydration", (t) => {
    const h = createModules(t, moderatorRow({ text: "가" }) + moderatorRow({ text: "나" }));
    for (const row of h.root.children) h.collect(row);
    h.store.finishScan(true);
    const [first, second] = h.snapshot();
    let clearedChecks = 0;
    const clearList = () => {
        const removed = Array.from(h.root.children);
        h.root.textContent = "";
        h.store.removeSubtrees(removed, [], {
            isListCleared: () => {
                clearedChecks += 1;
                return h.root.children.length === 0;
            },
        });
    };

    clearList();
    h.store.finishScan(false);
    // 다시 받은 백로그에서 빠진 앞쪽 "가"는 뒤에 오는 같은 문구의 새 메시지와 잇지 않는다.
    h.root.innerHTML = moderatorRow({ text: "나" }) + moderatorRow({ text: "가" });
    for (const row of h.root.children) h.collect(row);
    h.store.finishScan(true);
    assert.ok(clearedChecks > 0);
    assert.deepEqual(
        Array.from(h.snapshot(), (message) => [message.text, message.recordId]),
        [
            ["가", first.recordId],
            ["나", second.recordId],
            ["가", h.snapshot()[2].recordId],
        ]
    );
    assert.notEqual(h.snapshot()[2].recordId, first.recordId);

    h.root.insertAdjacentHTML("beforeend", moderatorRow({ text: "나" }));
    h.collect(h.root.lastElementChild);
    h.store.finishScan(true);
    assert.equal(h.snapshot().length, 4, "a message after the first hydration is new");

    const lengthBefore = h.snapshot().length;
    const removed = h.root.lastElementChild;
    removed.remove();
    h.store.removeSubtrees([removed], [], { isListCleared: () => false });
    h.root.insertAdjacentHTML("beforeend", moderatorRow({ text: "나" }));
    h.collect(h.root.lastElementChild);
    h.store.finishScan(true);
    assert.equal(h.snapshot().length, lengthBefore + 1, "removing one row from a live list keeps no candidate");
});

test("retired rows stay uncollected while they hold the same message and are staged when reused", (t) => {
    const h = createModules(t, moderatorRow({ author: "이전 운영자", text: "이전 안내" }));
    const row = h.root.firstElementChild;
    h.store.retireRows([row]);
    h.collect(row);
    row.querySelector(".nickname").style.color = "rgb(1, 2, 3)";
    h.collect(row);
    h.nextPass();
    h.store.finishScan(true);
    assert.equal(h.snapshot().length, 0);
    assert.equal(row.hasAttribute("data-bcct-moderator-collected"), false);

    row.querySelector(".nickname").textContent = "다음 운영자";
    row.querySelector(".message").textContent = "다음 안내";
    h.collect(row);
    h.store.finishScan(true);
    assert.equal(h.snapshot().length, 0, "a reused node is not committed in its first mixed pass");
    h.nextPass();
    h.nextPass();
    assert.deepEqual(
        Array.from(h.snapshot(), (message) => [message.author, message.text]),
        [["다음 운영자", "다음 안내"]]
    );
});

test("retired explicit message IDs are capped and replaced by the next channel generation", (t) => {
    const h = createModules(t);
    const template = h.dom.window.document.createElement("template");
    template.innerHTML = Array.from({ length: 501 }, (_, index) => moderatorRow({ id: `old-${index}` })).join("");
    h.store.retireRows(Array.from(template.content.children));
    const collectNewNode = (id) => {
        h.root.insertAdjacentHTML("beforeend", moderatorRow({ id }));
        h.collect(h.root.lastElementChild);
        h.store.finishScan(true);
        return Array.from(h.snapshot(), (message) => message.id);
    };

    assert.equal(collectNewNode("old-500").length, 0, "the newest retired ID is blocked on a new node");
    assert.deepEqual(collectNewNode("old-0"), ["data-chat-id:old-0"], "the cap drops the oldest retired ID");
    assert.deepEqual(collectNewNode("fresh"), ["data-chat-id:old-0", "data-chat-id:fresh"]);

    // 다음 채널 이동은 이전 세대의 ID를 버리고 그때의 목록만 은퇴시킨다.
    h.store.retireRows([h.root.lastElementChild]);
    assert.deepEqual(collectNewNode("old-500"), ["data-chat-id:old-0", "data-chat-id:fresh", "data-chat-id:old-500"]);
    h.store.clear();
    assert.equal(collectNewNode("fresh").length, 0, "the current generation still blocks its retired ID");
});

test("collected explicit IDs are retired without connected rows and released by the next generation", (t) => {
    const h = createModules(t, moderatorRow({ id: "a1", text: "A 공지" }));
    h.collect(h.root.firstElementChild);
    h.store.finishScan(true);
    h.root.firstElementChild.remove();
    const collectNewNode = (id, text) => {
        h.root.insertAdjacentHTML("beforeend", moderatorRow({ id, text }));
        h.collect(h.root.lastElementChild);
        h.store.finishScan(true);
        return Array.from(h.snapshot(), (message) => message.id);
    };

    h.store.retireRows([]);
    h.store.clear();
    assert.equal(collectNewNode("a1", "A 공지").length, 0, "an already collected ID needs no connected row");
    assert.deepEqual(collectNewNode("b1", "A 공지"), ["data-chat-id:b1"], "a different ID with the same text is new");

    h.root.textContent = "";
    h.store.retireRows([]);
    h.store.clear();
    assert.deepEqual(collectNewNode("a1", "A 공지"), ["data-chat-id:a1"], "returning releases the older generation");
    assert.deepEqual(collectNewNode("b1", "A 공지"), ["data-chat-id:a1"]);
});

test("subtree replacement transfers collection ownership but drops an original-text cache from the removed DOM", (t) => {
    const h = createModules(t, moderatorRow());
    const oldRow = h.root.firstElementChild;
    const parsed = h.store.parseChatMessage(oldRow);
    h.store.cacheOriginal(oldRow, parsed);
    h.collect(oldRow);
    const first = h.snapshot()[0];
    h.store.markRead([first.id]);
    assert.equal(h.store.originalText(oldRow, parsed), "안내");

    const nextRow = oldRow.cloneNode(true);
    oldRow.replaceWith(nextRow);
    h.store.removeSubtrees([oldRow], [nextRow]);
    assert.equal(h.store.originalText(oldRow, parsed), "");
    assert.equal(h.store.hasBinding(oldRow), false);
    h.collect(nextRow);
    h.store.finishScan(true);
    assert.equal(h.snapshot().length, 1);
    assert.equal(h.snapshot()[0].recordId, first.recordId);
    assert.equal(h.snapshot()[0].unread, false);
    assert.equal(h.store.hasBinding(nextRow), true);
});

test("panel snapshots preserve text nodes on backfill and replace a new record even if the native ID repeats", (t) => {
    const h = createModules(t);
    const navigations = [];
    const panel = h.namespace.createPanel({
        onNavigate: (...args) => navigations.push(args),
        onRead: () => {},
        onRequestSync: () => {},
    });
    h.cleanup.push(() => panel.remove());
    panel.mount(h.root);
    const first = {
        id: "data-chat-id:reused",
        recordId: 1,
        author: "처음 작성자",
        role: "manager",
        text: "처음 본문",
        badges: [],
        authorColor: "",
        timestamp: "",
        unread: true,
    };
    panel.render([first]);
    const oldRow = h.dom.window.document.querySelector(".bcct-moderator-row");
    const oldText = oldRow.querySelector(".bcct-moderator-row__text").firstChild;
    panel.render([{ ...first, unread: false, authorColor: "rgb(1, 2, 3)" }]);
    assert.equal(h.dom.window.document.querySelector(".bcct-moderator-row"), oldRow);
    assert.equal(oldRow.querySelector(".bcct-moderator-row__text").firstChild, oldText);
    panel.render([{ ...first, recordId: 2, author: "새 작성자", text: "새 본문" }]);
    const nextRow = h.dom.window.document.querySelector(".bcct-moderator-row");
    assert.notEqual(nextRow, oldRow);
    assert.equal(nextRow.querySelector(".bcct-moderator-row__author").textContent, "새 작성자");
    assert.equal(nextRow.querySelector(".bcct-moderator-row__text").textContent, "새 본문");
    oldRow.click();
    nextRow.click();
    assert.deepEqual(navigations, [
        [first.id, 1],
        [first.id, 2],
    ]);
    assert.equal(first.unread, true);
});

function moderatorRowTexts(h) {
    return Array.from(h.snapshot(), (message) => [message.text, message.recordId, message.unread]);
}

function collectCapacityBacklog(h, rowsHtml) {
    h.store.configure({ enabled: true, maximum: 2 });
    h.root.innerHTML = rowsHtml;
    for (const row of h.root.children) h.collect(row);
    h.store.finishScan(true);
    h.store.markRead(Array.from(h.snapshot(), (message) => message.id));
    return moderatorRowTexts(h);
}

const idlessBacklog = () => ["공지 0", "공지 1", "공지 2"].map((text) => moderatorRow({ text })).join("");
const explicitBacklog = () =>
    ["c0", "c1", "c2"].map((id, index) => moderatorRow({ id, text: `공지 ${index}` })).join("");

test("a wholly replaced root re-binds capacity-evicted backlog rows instead of collecting them again", (t) => {
    for (const backlog of [idlessBacklog, explicitBacklog]) {
        const h = createModules(t);
        const before = collectCapacityBacklog(h, backlog());
        assert.deepEqual(
            before.map(([text, , unread]) => [text, unread]),
            [
                ["공지 1", false],
                ["공지 2", false],
            ]
        );
        const nextRoot = h.root.cloneNode(false);
        nextRoot.innerHTML = backlog();
        h.root.replaceWith(nextRoot);
        h.store.adoptRoot(nextRoot);
        for (const row of nextRoot.children) h.collect(row);
        h.store.finishScan(true);
        assert.deepEqual(moderatorRowTexts(h), before, `${backlog.name}: records, order and read state are kept`);

        // 대조: 후보를 소비한 뒤 실제로 도착한 같은 문구·새 ID 메시지는 새 미확인 기록이에요.
        nextRoot.insertAdjacentHTML(
            "beforeend",
            backlog === explicitBacklog ? moderatorRow({ id: "c3", text: "공지 0" }) : moderatorRow({ text: "공지 0" })
        );
        h.collect(nextRoot.lastElementChild);
        h.store.finishScan(true);
        assert.deepEqual(
            Array.from(h.snapshot(), (message) => [message.text, message.unread]),
            [
                ["공지 2", false],
                ["공지 0", true],
            ]
        );
    }
});

test("same-root redraws and a cleared list re-bind capacity-evicted backlog rows instead of collecting them again", (t) => {
    for (const backlog of [idlessBacklog, explicitBacklog]) {
        for (const mode of ["replace", "clear"]) {
            const h = createModules(t);
            const before = collectCapacityBacklog(h, backlog());
            const removed = Array.from(h.root.children);
            if (mode === "replace") {
                // 같은 root에서 행 노드만 새로 그린 한 번의 childList 교체예요.
                h.root.innerHTML = backlog();
                h.store.removeSubtrees(removed, Array.from(h.root.children), { isListCleared: () => false });
            } else {
                // 같은 방송 재연결: 목록을 먼저 비우고 다음 배치에 같은 백로그를 다시 붙여요.
                h.root.textContent = "";
                h.store.removeSubtrees(removed, [], { isListCleared: () => h.root.children.length === 0 });
                h.store.finishScan(false);
                h.root.innerHTML = backlog();
            }
            for (const row of h.root.children) h.collect(row);
            h.store.finishScan(true);
            assert.deepEqual(moderatorRowTexts(h), before, `${backlog.name}/${mode}: records, order and read state`);
        }
    }
});

// 2026-10-30 비로그인 Chrome for Testing 실측 행(/live/0b33823ac81de48d5b78a38cdbc0ab94, /live/9381e7d6816e6d915a44a13c0195b202).
// 본문 span 안에 button > img만 있고 img는 alt="" · title 없음이에요. 닉네임 버튼에는 배지 img(alt="")가 있어요.
const MEASURED_CHEATKEY_BADGE =
    '<span class="_wrapper_1mc5x_30"><span class="_icon_1mc5x_15" style="width: 18px; height: 18px;"><span class="_container_1nwpy_2"><img src="https://ssl.pstatic.net/static/nng/glive/badge/cheatkey_24m.png" alt="" width="18" height="18"></span></span></span>';
// 역할 신호가 img alt라는 기존 실측(2026-07) 구조를 같은 배지 자리에 넣어요.
const ROLE_BADGE =
    '<span class="_wrapper_1mc5x_30"><span class="_icon_1mc5x_15" style="width: 18px; height: 18px;"><span class="_container_1nwpy_2"><img src="https://example.test/manager.png" alt="채팅 운영자" width="18" height="18"></span></span></span>';

function measuredEmoticon(file) {
    return `<button type="button" class="_button_w9pvh_18"><img alt="" width="24" height="24" src="https://ssl.pstatic.net/static/nng/glive/icon/${file}.png"></button>`;
}

function measuredChatRow({ badge = "", nickname, body, index = "" }) {
    return [
        `<div class="_item_8lqsk_7"${index ? ` data-virtual-index="${index}"` : ""}><div class="_container_w9pvh_1"><div class="_chatting_message_w9pvh_21">`,
        '<button type="button" class="_nickname_w9pvh_33" aria-haspopup="true" aria-expanded="false">',
        '<span class="_container_1mc5x_2 _is_message_1mc5x_5 _is_ellipsis_1mc5x_109" style="margin-right: 4px;">',
        badge,
        `<span class="_nickname_1mc5x_80" style="color: rgb(236, 168, 67);"><span class="_ellipsis_8bw0p_6"><span class="_text_8bw0p_2">${nickname}</span></span></span>`,
        "</span></button>",
        `<span class="_text_w9pvh_1">${body}</span>`,
        "</div></div></div>",
    ].join("");
}

test("message bodies keep emoticon images as ordered tokens without mixing nickname badges", (t) => {
    const h = createModules(t);
    h.root.innerHTML = [
        measuredChatRow({
            badge: MEASURED_CHEATKEY_BADGE,
            nickname: "퇴근이없어",
            body: measuredEmoticon("c_57").repeat(3),
        }),
        measuredChatRow({ nickname: "Eluna", body: measuredEmoticon("f_32") }),
        measuredChatRow({ nickname: "푸대21", body: "프롸임 등급이제" }),
        measuredChatRow({
            badge: MEASURED_CHEATKEY_BADGE,
            nickname: "섞어",
            body: `안녕 ${measuredEmoticon("c_57")} 하세요${measuredEmoticon("f_32")}`,
        }),
        // 번들 정적 분석상 이름이 title에 들어가는 형태와 검증할 수 없는 src는 이름/일반 토큰으로 남겨요.
        measuredChatRow({
            nickname: "이름",
            body: '<img title="웃음" src="https://nng-phinf.pstatic.net/glive/emoji/a.png"><img alt="" src="https://example.test/x_1.png">',
        }),
        // 본문 안에 역할 배지처럼 보이는 이미지는 본문 토큰으로 쓰지 않아요.
        measuredChatRow({
            nickname: "배지",
            body: '본문<img alt="매니저" src="https://ssl.pstatic.net/b/manager.png">',
        }),
    ].join("");
    const parsed = Array.from(h.root.children, (row) => h.namespace.parser.parseChatRow(row));
    assert.deepEqual(
        parsed.map((message) => [message.author, message.text]),
        [
            ["퇴근이없어", "[이모티콘:c_57] [이모티콘:c_57] [이모티콘:c_57]"],
            ["Eluna", "[이모티콘:f_32]"],
            ["푸대21", "프롸임 등급이제"],
            ["섞어", "안녕 [이모티콘:c_57] 하세요 [이모티콘:f_32]"],
            ["이름", "[이모티콘:웃음] [이모티콘]"],
            ["배지", "본문"],
        ]
    );
    for (const message of parsed) {
        assert.equal(message.textEl?.className, "_text_w9pvh_1", `${message.author}: the body span is the text target`);
        assert.equal(message.role, "");
    }
    assert.equal(
        h.namespace.parser.getVisibleText(h.root.firstElementChild),
        "퇴근이없어",
        "other readers keep image-free visible text"
    );
});

test("emoticon-only moderator messages are collected with distinct identities across remount and row reuse", (t) => {
    const h = createModules(t);
    const backlog = () =>
        [
            measuredChatRow({ badge: ROLE_BADGE, nickname: "운영자", body: measuredEmoticon("c_57").repeat(3) }),
            measuredChatRow({ badge: ROLE_BADGE, nickname: "운영자", body: measuredEmoticon("f_32") }),
            // 같은 운영자가 같은 이모티콘을 실제로 다시 보낸 메시지예요.
            measuredChatRow({ badge: ROLE_BADGE, nickname: "운영자", body: measuredEmoticon("c_57").repeat(3) }),
        ].join("");
    h.root.innerHTML = backlog();
    for (const row of h.root.children) h.collect(row);
    h.store.finishScan(true);
    const before = moderatorRowTexts(h);
    assert.deepEqual(
        before.map(([text]) => text),
        [
            "[이모티콘:c_57] [이모티콘:c_57] [이모티콘:c_57]",
            "[이모티콘:f_32]",
            "[이모티콘:c_57] [이모티콘:c_57] [이모티콘:c_57]",
        ]
    );
    assert.equal(new Set(before.map(([, recordId]) => recordId)).size, 3);
    h.store.markRead(Array.from(h.snapshot(), (message) => message.id));
    const read = moderatorRowTexts(h);

    // 같은 메시지의 root 교체 재마운트는 새 기록을 만들지 않고 순서·읽음을 유지해요.
    const nextRoot = h.root.cloneNode(false);
    nextRoot.innerHTML = backlog();
    h.root.replaceWith(nextRoot);
    h.store.adoptRoot(nextRoot);
    for (const row of nextRoot.children) h.collect(row);
    h.store.finishScan(true);
    assert.deepEqual(moderatorRowTexts(h), read);

    // 같은 행 노드가 다른 이모티콘 메시지로 재사용되면 안정화 뒤 새 미확인 기록이 돼요.
    const reused = nextRoot.lastElementChild;
    reused.setAttribute("data-virtual-index", "9");
    reused.querySelector("._text_w9pvh_1").innerHTML = measuredEmoticon("f_32") + measuredEmoticon("c_57");
    h.collect(reused);
    h.nextPass();
    h.nextPass();
    h.nextPass();
    h.store.finishScan(true);
    assert.deepEqual(
        Array.from(h.snapshot(), (message) => [message.text, message.unread]),
        [
            ["[이모티콘:c_57] [이모티콘:c_57] [이모티콘:c_57]", false],
            ["[이모티콘:f_32]", false],
            ["[이모티콘:c_57] [이모티콘:c_57] [이모티콘:c_57]", false],
            ["[이모티콘:f_32] [이모티콘:c_57]", true],
        ]
    );
});

// 표시 토큰은 alt/title을 줄이거나 src의 파일 이름만 남기므로 서로 다른 이미지가 같은 문자열이 될 수 있어요.
// 정체성(재사용·재마운트·binding)은 표시와 별개로 원래 alt·title·src 값과 순서·개수로 비교해요.
function emoticonImage({ src = "", alt = "", title = "" } = {}) {
    const attrs = [`alt="${alt}"`, title ? `title="${title}"` : "", src ? `src="${src}"` : ""].filter(Boolean);
    return `<button type="button" class="_button_w9pvh_18"><img ${attrs.join(" ")} width="24" height="24"></button>`;
}

const ICON_BASE = "https://ssl.pstatic.net/static/nng/glive";
const SAME_DISPLAY_IMAGE_PAIRS = [
    // 같은 파일 이름의 다른 경로
    [{ src: `${ICON_BASE}/icon/c_57.png` }, { src: `${ICON_BASE}/other/c_57.png` }, "[이모티콘:c_57]"],
    // 같은 alt의 다른 이미지
    [
        { alt: "웃음", src: `${ICON_BASE}/icon/a_1.png` },
        { alt: "웃음", src: `${ICON_BASE}/icon/b_2.png` },
        "[이모티콘:웃음]",
    ],
    // 같은 title의 다른 이미지
    [
        { title: "인사", src: "https://nng-phinf.pstatic.net/glive/emoji/x.png" },
        { title: "인사", src: "https://nng-phinf.pstatic.net/glive/emoji/y.png" },
        "[이모티콘:인사]",
    ],
];

test("emoticon identity keeps full image values apart when display tokens collide", (t) => {
    for (const [first, second, display] of SAME_DISPLAY_IMAGE_PAIRS) {
        const label = `${first.src} -> ${second.src}`;
        // 같은 행·같은 img에서 src만 바뀐 재사용은 안정화 뒤 다른 메시지로 기록돼요.
        const h = createModules(t);
        h.root.innerHTML = measuredChatRow({ badge: ROLE_BADGE, nickname: "운영자", body: emoticonImage(first) });
        const row = h.root.firstElementChild;
        const img = row.querySelector("._text_w9pvh_1 img");
        const firstParsed = h.namespace.parser.parseChatRow(row);
        h.collect(row);
        h.store.finishScan(true);
        img.setAttribute("src", second.src);
        const secondParsed = h.namespace.parser.parseChatRow(row);
        assert.equal(firstParsed.text, display, `${label}: display token`);
        assert.equal(secondParsed.text, display, `${label}: display token collides`);
        assert.notEqual(firstParsed.textKey, secondParsed.textKey, `${label}: identity keeps the full src`);
        h.collect(row);
        h.nextPass();
        h.nextPass();
        h.nextPass();
        h.store.finishScan(true);
        const records = h.snapshot();
        assert.deepEqual(
            Array.from(records, (message) => [message.text, message.unread]),
            [
                [display, true],
                [display, true],
            ],
            `${label}: src-only reuse is a new record`
        );
        assert.notEqual(records[0].recordId, records[1].recordId);
        assert.ok(
            Array.from(records).every(
                (message) => !message.text.includes(ICON_BASE) && !message.text.includes("\u001f")
            ),
            "the identity value is never shown"
        );

        // root 교체 재마운트에서 같은 표시 토큰의 다른 이미지는 이전 기록에 붙지 않고 새로 기록돼요.
        const r = createModules(t);
        r.root.innerHTML = measuredChatRow({ badge: ROLE_BADGE, nickname: "운영자", body: emoticonImage(first) });
        r.collect(r.root.firstElementChild);
        r.store.finishScan(true);
        r.store.markRead(Array.from(r.snapshot(), (message) => message.id));
        const nextRoot = r.root.cloneNode(false);
        nextRoot.innerHTML = [
            measuredChatRow({ badge: ROLE_BADGE, nickname: "운영자", body: emoticonImage(second) }),
            measuredChatRow({ badge: ROLE_BADGE, nickname: "운영자", body: emoticonImage(first) }),
        ].join("");
        r.root.replaceWith(nextRoot);
        r.store.adoptRoot(nextRoot);
        for (const nextRow of nextRoot.children) r.collect(nextRow);
        r.store.finishScan(true);
        assert.deepEqual(
            Array.from(r.snapshot(), (message) => [message.text, message.unread]),
            [
                [display, false],
                [display, true],
            ],
            `${label}: remount binds only the same image and records the other once`
        );
        assert.equal(r.snapshot()[0].recordId, 1, `${label}: the remounted record keeps its identity`);
    }
});

test("emoticon identity keeps image order and count, and nickname badge changes stay the same message", (t) => {
    const a = { src: `${ICON_BASE}/icon/c_57.png` };
    const b = { src: `${ICON_BASE}/icon/f_32.png` };
    const parse = (body) => {
        const h = createModules(t);
        h.root.innerHTML = measuredChatRow({ badge: ROLE_BADGE, nickname: "운영자", body });
        return h.namespace.parser.parseChatRow(h.root.firstElementChild);
    };
    const keys = [
        emoticonImage(a) + emoticonImage(b),
        emoticonImage(b) + emoticonImage(a),
        emoticonImage(a),
        emoticonImage(a) + emoticonImage(a),
    ].map((body) => parse(body).textKey);
    assert.equal(new Set(keys).size, keys.length, "order and count are part of the identity");
    const plain = parse("일반 안내");
    assert.equal(plain.textKey, plain.text, "text-only bodies keep text as their identity");

    // 대조: 닉네임 영역 배지 src가 바뀌어도 본문 정체성은 같아서 같은 기록으로 남아요.
    const h = createModules(t);
    h.root.innerHTML = measuredChatRow({
        badge: ROLE_BADGE + MEASURED_CHEATKEY_BADGE,
        nickname: "운영자",
        body: emoticonImage(a),
    });
    const row = h.root.firstElementChild;
    h.collect(row);
    h.store.finishScan(true);
    const [before] = h.snapshot();
    const keyBefore = h.namespace.parser.parseChatRow(row).textKey;
    row.querySelector("._nickname_w9pvh_33 img[src*='cheatkey']").setAttribute(
        "src",
        "https://ssl.pstatic.net/static/nng/glive/badge/cheatkey_36m.png"
    );
    assert.equal(h.namespace.parser.parseChatRow(row).textKey, keyBefore);
    h.collect(row);
    h.nextPass();
    h.nextPass();
    h.nextPass();
    h.store.finishScan(true);
    assert.deepEqual(
        Array.from(h.snapshot(), (message) => [message.recordId, message.text]),
        [[before.recordId, "[이모티콘:c_57]"]]
    );
});

test("a body image whose src arrives late is recorded once with its final token", (t) => {
    const h = createModules(t);
    h.root.innerHTML = [
        measuredChatRow({ badge: ROLE_BADGE, nickname: "운영자", body: emoticonImage({}) }),
        // 대조: 끝내 이름·src가 없는 이미지도 안정화 뒤 개수만 남긴 토큰으로 기록돼요.
        measuredChatRow({ badge: ROLE_BADGE, nickname: "운영자", body: `안내 ${emoticonImage({})}` }),
    ].join("");
    const [late, never] = h.root.children;
    h.collect(late);
    h.collect(never);
    h.store.finishScan(true);
    assert.equal(h.snapshot().length, 0, "an unnamed, src-less image is not recorded before it settles");
    late.querySelector("._text_w9pvh_1 img").setAttribute("src", `${ICON_BASE}/icon/c_57.png`);
    h.collect(late);
    h.nextPass();
    h.nextPass();
    h.nextPass();
    h.store.finishScan(true);
    const records = Array.from(h.snapshot(), (message) => message.text);
    assert.equal(records.length, 2);
    assert.deepEqual(new Set(records), new Set(["[이모티콘:c_57]", "안내 [이모티콘]"]));
    // 이미 기록된 뒤 다시 파싱해도 중복 기록이 생기지 않아요.
    h.collect(late);
    h.collect(never);
    h.nextPass();
    h.nextPass();
    h.store.finishScan(true);
    assert.equal(h.snapshot().length, 2);
});

// 재마운트된 ID 없는 행의 본문 이미지가 아직 이름·src 없이 그려지면 안정화를 기다려요. 그 사이 scan이 끝나도
// 이 행을 덮는 재마운트 후보는 행·세대에 남아, 최종 확인에서 같은 기록·읽음·원본 이동 대상으로 이어져요.
function settleLoadingBodyImage(h, row) {
    row.querySelector("._text_w9pvh_1 img").setAttribute("src", `${ICON_BASE}/icon/c_57.png`);
    h.collect(row);
    h.nextPass();
    h.nextPass();
    h.nextPass();
    h.store.finishScan(true);
}

const settledEmoticonRow = () =>
    measuredChatRow({
        badge: ROLE_BADGE,
        nickname: "운영자",
        body: emoticonImage({ src: `${ICON_BASE}/icon/c_57.png` }),
    });
const loadingEmoticonRow = () => measuredChatRow({ badge: ROLE_BADGE, nickname: "운영자", body: emoticonImage({}) });

test("a remounted id-less message whose body image is still loading keeps its record through stabilization", (t) => {
    for (const mode of ["root", "replace", "clear"]) {
        const h = createModules(t);
        h.root.innerHTML = settledEmoticonRow();
        h.collect(h.root.firstElementChild);
        h.store.finishScan(true);
        const [before] = h.snapshot();
        assert.equal(before.text, "[이모티콘:c_57]");
        h.store.markRead([before.id]);

        let root = h.root;
        const removed = Array.from(root.children);
        if (mode === "root") {
            const nextRoot = root.cloneNode(false);
            nextRoot.innerHTML = loadingEmoticonRow();
            root.replaceWith(nextRoot);
            h.store.adoptRoot(nextRoot);
            root = nextRoot;
        } else if (mode === "replace") {
            root.innerHTML = loadingEmoticonRow();
            h.store.removeSubtrees(removed, Array.from(root.children), { isListCleared: () => false });
        } else {
            root.textContent = "";
            h.store.removeSubtrees(removed, [], { isListCleared: () => root.children.length === 0 });
            h.store.finishScan(false);
            root.innerHTML = loadingEmoticonRow();
        }
        const row = root.firstElementChild;
        h.collect(row);
        h.store.finishScan(true);
        assert.equal(h.snapshot().length, 1, `${mode}: nothing is recorded while the image loads`);
        settleLoadingBodyImage(h, row);
        assert.deepEqual(
            moderatorRowTexts(h),
            [["[이모티콘:c_57]", before.recordId, false]],
            `${mode}: the existing record, order and read state are kept`
        );
        assert.equal(h.snapshot()[0].id, before.id);
        let scrolled = 0;
        row.scrollIntoView = () => {
            scrolled += 1;
        };
        h.store.navigate(before.id, before.recordId);
        assert.equal(scrolled, 1, `${mode}: the record moves to the redrawn native row`);

        // 대조: 첫 hydration 뒤 실제로 도착한 같은 내용의 메시지는 이미지가 늦게 채워져도 새 미확인 기록이에요.
        root.insertAdjacentHTML("beforeend", loadingEmoticonRow());
        const fresh = root.lastElementChild;
        h.collect(fresh);
        h.store.finishScan(true);
        settleLoadingBodyImage(h, fresh);
        assert.deepEqual(
            Array.from(h.snapshot(), (message) => [message.text, message.unread]),
            [
                ["[이모티콘:c_57]", false],
                ["[이모티콘:c_57]", true],
            ],
            `${mode}: a later message with the same content is new`
        );
        assert.notEqual(h.snapshot()[1].recordId, before.recordId);
    }
});

test("a loading remount row that is removed before it settles drops its reserved candidates", (t) => {
    const h = createModules(t);
    h.root.innerHTML = settledEmoticonRow();
    h.collect(h.root.firstElementChild);
    h.store.finishScan(true);
    const [before] = h.snapshot();
    h.store.markRead([before.id]);

    const nextRoot = h.root.cloneNode(false);
    nextRoot.innerHTML = loadingEmoticonRow();
    h.root.replaceWith(nextRoot);
    h.store.adoptRoot(nextRoot);
    const staged = nextRoot.firstElementChild;
    h.collect(staged);
    h.store.finishScan(true);
    // 안정화 전에 행이 사라지면 맡아 둔 후보도 함께 사라져요.
    staged.remove();
    h.store.removeSubtrees([staged], [], { isListCleared: () => false });
    h.nextPass();
    h.store.finishScan(false);

    nextRoot.insertAdjacentHTML("beforeend", loadingEmoticonRow());
    const fresh = nextRoot.lastElementChild;
    h.collect(fresh);
    h.store.finishScan(true);
    settleLoadingBodyImage(h, fresh);
    assert.deepEqual(
        Array.from(h.snapshot(), (message) => [message.recordId === before.recordId, message.unread]),
        [
            [true, false],
            [false, true],
        ]
    );
});

test("identical loading rows of a cleared list re-bind their own records once each in removal order", (t) => {
    const h = createModules(t);
    h.root.innerHTML = settledEmoticonRow() + settledEmoticonRow();
    for (const row of h.root.children) h.collect(row);
    h.store.finishScan(true);
    const before = moderatorRowTexts(h);
    assert.equal(before.length, 2);
    h.store.markRead([h.snapshot()[0].id]);

    const removed = Array.from(h.root.children);
    h.root.textContent = "";
    h.store.removeSubtrees(removed, [], { isListCleared: () => h.root.children.length === 0 });
    h.store.finishScan(false);
    h.root.innerHTML = loadingEmoticonRow() + loadingEmoticonRow();
    const rows = Array.from(h.root.children);
    for (const row of rows) h.collect(row);
    h.store.finishScan(true);
    for (const row of rows) row.querySelector("._text_w9pvh_1 img").setAttribute("src", `${ICON_BASE}/icon/c_57.png`);
    for (const row of rows) h.collect(row);
    h.nextPass();
    h.nextPass();
    h.nextPass();
    h.store.finishScan(true);
    assert.deepEqual(moderatorRowTexts(h), [
        [before[0][0], before[0][1], false],
        [before[1][0], before[1][1], true],
    ]);
});

// 재마운트된 백로그는 이전 목록과 같은 상대 순서예요. 앞 행이 이미지 로딩으로 안정화를 기다리는 동안 뒤 행이
// 먼저 확정되거나 먼저 안정화돼도, 후보는 행의 순서대로 소비돼야 기록별 원본 행 대응·읽음·기록 수가 보존돼요.
const emoticonFileRow = (file) =>
    measuredChatRow({
        badge: ROLE_BADGE,
        nickname: "운영자",
        body: emoticonImage({ src: `${ICON_BASE}/icon/${file}.png` }),
    });
const plainModeratorRow = (text) => measuredChatRow({ badge: ROLE_BADGE, nickname: "운영자", body: text });

function settleBodyImage(h, row, file = "c_57") {
    row.querySelector("._text_w9pvh_1 img").setAttribute("src", `${ICON_BASE}/icon/${file}.png`);
    h.collect(row);
    h.nextPass();
    h.nextPass();
    h.nextPass();
    h.store.finishScan(true);
}

// 뒤 행은 이미지가 채워져 안정화 기준을 넘기고, 앞 행은 그동안 계속 채워지는 중(mutation)이에요.
function settleLaterRowFirst(h, earlier, later, { earlierFile = "c_57", laterFile = "c_57" } = {}) {
    later.querySelector("._text_w9pvh_1 img").setAttribute("src", `${ICON_BASE}/icon/${laterFile}.png`);
    h.collect(later);
    for (let pass = 0; pass < 4; pass += 1) {
        h.collect(earlier);
        h.nextPass();
    }
    h.store.finishScan(true);
    settleBodyImage(h, earlier, earlierFile);
}

function remountBacklog(h, mode, rowsHtml) {
    let root = h.root;
    const removed = Array.from(root.children);
    if (mode === "root") {
        const nextRoot = root.cloneNode(false);
        nextRoot.innerHTML = rowsHtml;
        root.replaceWith(nextRoot);
        h.store.adoptRoot(nextRoot);
        root = nextRoot;
    } else if (mode === "replace") {
        root.innerHTML = rowsHtml;
        h.store.removeSubtrees(removed, Array.from(root.children), { isListCleared: () => false });
    } else {
        root.textContent = "";
        h.store.removeSubtrees(removed, [], { isListCleared: () => root.children.length === 0 });
        h.store.finishScan(false);
        root.innerHTML = rowsHtml;
    }
    const rows = Array.from(root.children);
    for (const row of rows) h.collect(row);
    h.store.finishScan(true);
    return rows;
}

function navigationTargets(h, rows) {
    const targets = [];
    for (const [index, row] of rows.entries()) row.scrollIntoView = () => targets.push(index);
    return Array.from(h.snapshot(), (message) => {
        targets.length = 0;
        h.store.navigate(message.id, message.recordId);
        return targets.length === 1 ? targets[0] : null;
    });
}

{
    const scenarios = [
        {
            name: "pending+ready",
            backlog: () => emoticonFileRow("c_57") + plainModeratorRow("다른 안내"),
            redraw: () => loadingEmoticonRow() + plainModeratorRow("다른 안내"),
            settle: (h, [first]) => settleBodyImage(h, first, "c_57"),
        },
        {
            name: "reverse settle",
            backlog: () => emoticonFileRow("c_57") + emoticonFileRow("c_58"),
            redraw: () => loadingEmoticonRow() + loadingEmoticonRow(),
            settle: (h, [first, second]) =>
                settleLaterRowFirst(h, first, second, { earlierFile: "c_57", laterFile: "c_58" }),
        },
    ];
    for (const scenario of scenarios) {
        for (const mode of ["root", "replace", "clear"]) {
            const label = `${scenario.name}/${mode}`;
            test(`a loading row ahead of a ready or earlier-settling row keeps every remounted record (${label})`, (t) => {
                const h = createModules(t);
                h.root.innerHTML = scenario.backlog();
                for (const row of h.root.children) h.collect(row);
                h.store.finishScan(true);
                h.store.markRead([h.snapshot()[0].id]);
                const before = moderatorRowTexts(h);
                assert.equal(before.length, 2);

                const rows = remountBacklog(h, mode, scenario.redraw());
                assert.equal(h.snapshot().length, 2, `${label}: nothing new while the first row loads`);
                scenario.settle(h, rows);
                assert.deepEqual(moderatorRowTexts(h), before, `${label}: records, order and read state are kept`);
                assert.deepEqual(navigationTargets(h, rows), [0, 1], `${label}: each record moves to its own new row`);
            });
        }
    }
}

for (const mode of ["root", "replace", "clear"]) {
    test(`a loading row ahead of a ready row keeps a capacity-evicted record from returning as new (${mode})`, (t) => {
        const h = createModules(t);
        const backlog = emoticonFileRow("c_57") + plainModeratorRow("안내 1") + plainModeratorRow("안내 2");
        const before = collectCapacityBacklog(h, backlog);
        assert.deepEqual(
            before.map(([text]) => text),
            ["안내 1", "안내 2"]
        );
        const rows = remountBacklog(
            h,
            mode,
            loadingEmoticonRow() + plainModeratorRow("안내 1") + plainModeratorRow("안내 2")
        );
        settleBodyImage(h, rows[0], "c_57");
        assert.deepEqual(moderatorRowTexts(h), before, `${mode}: the evicted message does not push out recent records`);
        assert.deepEqual(navigationTargets(h, rows), [1, 2], `${mode}: retained records keep their own rows`);
    });
}

{
    const settles = [
        ["pending+ready", (h, [first]) => settleBodyImage(h, first)],
        ["reverse settle", (h, [first, second]) => settleLaterRowFirst(h, first, second)],
    ];
    for (const [name, settle] of settles) {
        for (const mode of ["root", "replace", "clear"]) {
            const label = `${name}/${mode}`;
            test(`identical id-less records keep their own new rows when the first redrawn row loads late (${label})`, (t) => {
                const h = createModules(t);
                h.root.innerHTML = settledEmoticonRow() + settledEmoticonRow();
                for (const row of h.root.children) h.collect(row);
                h.store.finishScan(true);
                h.store.markRead([h.snapshot()[0].id]);
                const before = moderatorRowTexts(h);
                assert.deepEqual(
                    before.map(([, , unread]) => unread),
                    [false, true]
                );

                const redraw =
                    name === "pending+ready"
                        ? loadingEmoticonRow() + settledEmoticonRow()
                        : loadingEmoticonRow() + loadingEmoticonRow();
                const rows = remountBacklog(h, mode, redraw);
                settle(h, rows);
                assert.deepEqual(moderatorRowTexts(h), before, `${label}: records and read state are kept`);
                assert.deepEqual(
                    navigationTargets(h, rows),
                    [0, 1],
                    `${label}: the read record stays on the first row`
                );
            });
        }
    }
}

test("a loading row that settles as a different message does not hold the later row's record", (t) => {
    // 대조: 앞 대기 행이 백로그에 없던 다른 내용으로 안정화되면 새 기록이고, 뒤 행은 자기 기록에 이어져요.
    // 비운 목록에서 그 행보다 앞선 빠진 후보는 그 뒤의 같은 문구 새 메시지와 잇지 않는 기존 규칙도 유지돼요.
    for (const mode of ["root", "replace", "clear"]) {
        const h = createModules(t);
        h.root.innerHTML = emoticonFileRow("c_57") + plainModeratorRow("다른 안내");
        for (const row of h.root.children) h.collect(row);
        h.store.finishScan(true);
        h.store.markRead(Array.from(h.snapshot(), (message) => message.id));
        const before = moderatorRowTexts(h);

        const rows = remountBacklog(h, mode, loadingEmoticonRow() + plainModeratorRow("다른 안내"));
        settleBodyImage(h, rows[0], "c_99");
        const after = moderatorRowTexts(h);
        assert.deepEqual(after.slice(0, 2), before, `${mode}: existing records are kept`);
        assert.equal(after.length, 3, `${mode}: the different message is a new record`);
        assert.deepEqual([after[2][0], after[2][2]], ["[이모티콘:c_99]", true]);
        assert.deepEqual(navigationTargets(h, rows), [null, 1, 0], `${mode}: rows map to their own records`);

        if (mode === "clear") {
            h.root.insertAdjacentHTML("beforeend", emoticonFileRow("c_57"));
            h.collect(h.root.lastElementChild);
            h.store.finishScan(true);
            assert.equal(h.snapshot().length, 4, "a later message with the missing content is new");
            assert.equal(h.snapshot()[3].unread, true);
        }
    }
});

test("a row waiting behind a loading row still re-binds its record when that row is removed", (t) => {
    // 대조: 행 순서 대기는 앞 행이 사라지면(제거 취소) 풀려요. 뒤 행은 자기 기록에 이어지고, 사라진 앞 행의 후보는
    // 나중에 도착한 같은 내용 메시지에 쓰이지 않아요.
    for (const mode of ["root", "replace", "clear"]) {
        const h = createModules(t);
        h.root.innerHTML = emoticonFileRow("c_57") + plainModeratorRow("다른 안내");
        for (const row of h.root.children) h.collect(row);
        h.store.finishScan(true);
        h.store.markRead(Array.from(h.snapshot(), (message) => message.id));
        const before = moderatorRowTexts(h);

        const [loading, ready] = remountBacklog(h, mode, loadingEmoticonRow() + plainModeratorRow("다른 안내"));
        const root = ready.parentElement;
        loading.remove();
        h.store.removeSubtrees([loading], [], { isListCleared: () => false });
        h.nextPass();
        h.nextPass();
        h.nextPass();
        h.store.finishScan(false);
        assert.deepEqual(moderatorRowTexts(h), before, `${mode}: no record is added or lost`);
        assert.deepEqual(navigationTargets(h, [ready]), [null, 0], `${mode}: the waiting row keeps its own record`);

        root.insertAdjacentHTML("beforeend", emoticonFileRow("c_57"));
        h.collect(root.lastElementChild);
        h.store.finishScan(true);
        assert.equal(h.snapshot().length, 3, `${mode}: a later message with the removed row's content is new`);
        assert.equal(h.snapshot()[2].unread, true);
    }
});

// 치지직이 목록을 행 하나씩 지우면 한 observer 배치에 제거 레코드가 여러 개 와요. runtime처럼 모든 제거가 끝난 뒤
// 레코드마다 removeSubtrees를 부르고, 목록 비움 확인은 배치당 한 번만 해요.
function clearListRowByRow(h, root = h.root) {
    const removed = Array.from(root.children);
    for (const row of removed) row.remove();
    let cleared = null;
    const isListCleared = () => {
        if (cleared === null) cleared = root.children.length === 0;
        return cleared;
    };
    for (const row of removed) h.store.removeSubtrees([row], [], { isListCleared });
    h.store.finishScan(false);
}

test("a list cleared row by row does not merge a repeated message into the missing earlier record", (t) => {
    const h = createModules(t, moderatorRow({ text: "가" }) + moderatorRow({ text: "나" }));
    for (const row of h.root.children) h.collect(row);
    h.store.finishScan(true);
    h.store.markRead(Array.from(h.snapshot(), (message) => message.id));
    const [first, second] = h.snapshot();

    clearListRowByRow(h);
    // 다시 받은 백로그는 "나"부터예요. 그 뒤의 "가"는 빠진 앞 기록이 아니라 같은 문구의 새 메시지예요.
    h.root.innerHTML = moderatorRow({ text: "나" }) + moderatorRow({ text: "가" });
    const rows = Array.from(h.root.children);
    for (const row of rows) h.collect(row);
    h.store.finishScan(true);

    const after = moderatorRowTexts(h);
    assert.deepEqual(after.slice(0, 2), [
        ["가", first.recordId, false],
        ["나", second.recordId, false],
    ]);
    assert.equal(after.length, 3, "the repeated message is a new record");
    assert.equal(after[2][0], "가");
    assert.notEqual(after[2][1], first.recordId);
    assert.equal(after[2][2], true, "the new record is unread");
    assert.deepEqual(navigationTargets(h, rows), [null, 0, 1], "only the redrawn record and the new one have rows");
});

test("a list cleared row by row keeps a repeated message apart from a capacity-evicted record", (t) => {
    const h = createModules(t);
    const before = collectCapacityBacklog(
        h,
        moderatorRow({ text: "가" }) + moderatorRow({ text: "나" }) + moderatorRow({ text: "다" })
    );
    assert.deepEqual(
        before.map(([text]) => text),
        ["나", "다"]
    );

    clearListRowByRow(h);
    h.root.innerHTML = moderatorRow({ text: "나" }) + moderatorRow({ text: "다" }) + moderatorRow({ text: "가" });
    const rows = Array.from(h.root.children);
    for (const row of rows) h.collect(row);
    h.store.finishScan(true);

    const after = moderatorRowTexts(h);
    assert.deepEqual(after[0], before[1], "the redrawn read record is kept");
    assert.equal(after.length, 2);
    assert.equal(after[1][0], "가", "the repeated message reaches the panel");
    assert.equal(after[1][2], true);
    assert.ok(!before.some(([, recordId]) => recordId === after[1][1]));
    assert.deepEqual(navigationTargets(h, rows), [1, 2]);
});

test("a list cleared row by row still re-binds every record redrawn in the same order", (t) => {
    // 대조: 제거 레코드가 여러 개여도 같은 순서로 다시 받은 백로그는 기존 기록·읽음·원본 이동 대상을 그대로 이어요.
    const h = createModules(
        t,
        moderatorRow({ text: "가" }) + moderatorRow({ text: "나" }) + moderatorRow({ text: "가" })
    );
    for (const row of h.root.children) h.collect(row);
    h.store.finishScan(true);
    h.store.markRead([h.snapshot()[0].id]);
    const before = moderatorRowTexts(h);

    clearListRowByRow(h);
    h.root.innerHTML = moderatorRow({ text: "가" }) + moderatorRow({ text: "나" }) + moderatorRow({ text: "가" });
    const rows = Array.from(h.root.children);
    for (const row of rows) h.collect(row);
    h.store.finishScan(true);
    assert.deepEqual(moderatorRowTexts(h), before);
    assert.deepEqual(navigationTargets(h, rows), [0, 1, 2]);

    // 첫 hydration이 끝난 뒤 다시 행별로 비우면 새 비움 범위예요. 이전 범위의 후보는 남지 않아요.
    clearListRowByRow(h);
    h.root.innerHTML = moderatorRow({ text: "나" });
    h.collect(h.root.firstElementChild);
    h.store.finishScan(true);
    h.root.insertAdjacentHTML("beforeend", moderatorRow({ text: "가" }));
    h.collect(h.root.lastElementChild);
    h.store.finishScan(true);
    assert.equal(h.snapshot().length, 4, "a message after the next hydration is new");
    assert.equal(h.snapshot()[3].unread, true);
});

{
    const scenarios = [
        {
            name: "pending+ready",
            backlog: () => emoticonFileRow("c_57") + plainModeratorRow("다른 안내"),
            redraw: () => loadingEmoticonRow() + plainModeratorRow("다른 안내"),
            settle: (h, [first]) => settleBodyImage(h, first, "c_57"),
        },
        {
            name: "reverse settle",
            backlog: () => emoticonFileRow("c_57") + emoticonFileRow("c_58"),
            redraw: () => loadingEmoticonRow() + loadingEmoticonRow(),
            settle: (h, [first, second]) =>
                settleLaterRowFirst(h, first, second, { earlierFile: "c_57", laterFile: "c_58" }),
        },
        {
            name: "identical pending+ready",
            backlog: () => settledEmoticonRow() + settledEmoticonRow(),
            redraw: () => loadingEmoticonRow() + settledEmoticonRow(),
            settle: (h, [first]) => settleBodyImage(h, first),
        },
    ];
    for (const scenario of scenarios) {
        test(`a loading row of a list cleared row by row keeps every record in row order (${scenario.name})`, (t) => {
            // 대조: 행별 제거로 비운 목록에서도 앞 로딩 행 대기·역순 안정화 보호가 유지돼요.
            const h = createModules(t);
            h.root.innerHTML = scenario.backlog();
            for (const row of h.root.children) h.collect(row);
            h.store.finishScan(true);
            h.store.markRead([h.snapshot()[0].id]);
            const before = moderatorRowTexts(h);

            clearListRowByRow(h);
            h.root.innerHTML = scenario.redraw();
            const rows = Array.from(h.root.children);
            for (const row of rows) h.collect(row);
            h.store.finishScan(true);
            assert.equal(h.snapshot().length, 2, "nothing new while the first row loads");
            scenario.settle(h, rows);
            assert.deepEqual(moderatorRowTexts(h), before);
            assert.deepEqual(navigationTargets(h, rows), [0, 1]);
        });
    }
}
