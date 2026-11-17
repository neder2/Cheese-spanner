const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { waitForCondition } = require("./helpers/wait-for-condition.js");

const repoRoot = path.join(__dirname, "..");
const CHANNEL_A = "a".repeat(32);
const CHANNEL_B = "b".repeat(32);
const USER = "c".repeat(32);
const MESSAGE_TIME = 1794700800000;
const ROLE_BADGE = '<img alt="채팅 운영자" src="https://ssl.pstatic.net/badge/manager.png">';
const BLIND_NOTICE = "메시지가 블라인드 처리되었습니다.";
const read = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");

// Same measured native layout as chat-tools-modules/chat-blind-source. Native identity
// belongs to React's message, not a fixture-only DOM message ID or virtual-row index.
function nativeRow({ nickname = "진행담당", body = "첫 공지", badge = ROLE_BADGE } = {}) {
    return [
        '<div class="_item_8lqsk_7"><div class="_container_w9pvh_1"><div class="_chatting_message_w9pvh_21">',
        '<button type="button" class="_nickname_w9pvh_33" aria-haspopup="true" aria-expanded="false">',
        '<span class="_container_1mc5x_2 _is_message_1mc5x_5 _is_ellipsis_1mc5x_109">',
        badge,
        `<span class="_nickname_1mc5x_80"><span class="_ellipsis_8bw0p_6"><span class="_text_8bw0p_2">${nickname}</span></span></span>`,
        "</span></button>",
        `<span class="_text_w9pvh_1">${body}</span>`,
        "</div></div></div>",
    ].join("");
}

function message({
    key = "native-1",
    nickname = "진행담당",
    text = "첫 공지",
    role = "streaming_chat_manager",
    user = USER,
    time = MESSAGE_TIME,
    status = "NORMAL",
} = {}) {
    return {
        key,
        user,
        time,
        type: 1,
        status,
        content: text,
        originalContent: text,
        profile: { userIdHash: user, nickname, userRoleCode: role, verifiedMarkType: null },
    };
}

function attachMessage(row, source) {
    row.querySelector('[class*="chatting_message"]').__reactProps$nativeCollection = {
        children: { props: { chatMessage: source } },
    };
}

const bodyOf = (row) => row.querySelector("._text_w9pvh_1");
const snapshotValues = (messages) => Array.from(messages, ({ author, role, text }) => ({ author, role, text }));

function createDom(rows, url = `/live/${CHANNEL_A}`) {
    const aside = url.startsWith("/video/") ? "vod-aside" : "aside-chatting";
    return new JSDOM(
        `<!doctype html><body><aside id="${aside}" class="live_chatting_area"><header class="chat-header"><strong>채팅</strong><button type="button" aria-label="더보기">⋮</button></header><div class="chat-list" role="log">${rows}</div></aside></body>`,
        { url: `https://chzzk.naver.com${url}`, runScripts: "outside-only", pretendToBeVisual: true }
    );
}

function load(dom, files) {
    for (const file of files) dom.window.eval(read(file));
}

function createModules(t, rows = nativeRow(), { nativeBridge = true } = {}) {
    const dom = createDom(rows);
    const { window } = dom;
    load(dom, [
        "shared/settings.js",
        "shared/data.js",
        "content.js",
        ...(nativeBridge ? ["features/chatTimestampPage.js"] : []),
        "features/chatTools/parser.js",
        "features/chatTools/messageStore.js",
    ]);
    const pending = new Map();
    let nextTimer = 1;
    window.setTimeout = (callback) => {
        const id = nextTimer++;
        pending.set(id, callback);
        return id;
    };
    window.clearTimeout = (id) => pending.delete(id);
    const published = [];
    const store = window.CheeseSpanner.chatTools.createMessageStore({
        onChange: (messages) => published.push(messages),
    });
    const root = window.document.querySelector('[role="log"]');
    store.adoptRoot(root);
    t.after(() => {
        store.resetRoot();
        pending.clear();
        window.dispatchEvent(new window.Event("pagehide"));
        window.close();
    });
    return {
        dom,
        root,
        store,
        published,
        pending,
        collect(row) {
            store.noteMutation(row);
            store.collect(store.parseChatMessage(row));
        },
        settle() {
            // Advance the existing two-pass stabilization without wall-clock sleeps.
            // A bounded drain also detects an accidentally self-rescheduling transition.
            for (let pass = 0; pending.size && pass < 8; pass++) {
                const callbacks = Array.from(pending.values());
                pending.clear();
                for (const callback of callbacks) callback();
            }
            assert.equal(pending.size, 0, "native row stabilization must finish");
        },
        snapshot() {
            return published.at(-1) || [];
        },
    };
}

function createController(t, rows, { url = `/live/${CHANNEL_A}` } = {}) {
    const dom = createDom(rows, url);
    const { window } = dom;
    const listeners = [];
    const options = {
        chatToolsModeratorBoxEnabled: true,
        chatToolsShowBlindEnabled: false,
        chatKeywordFilterEnabled: false,
    };
    const area = (values = {}) => ({
        get(keys, callback) {
            const result = Object.fromEntries(
                (Array.isArray(keys) ? keys : [keys])
                    .filter((key) => Object.hasOwn(values, key))
                    .map((key) => [key, values[key]])
            );
            setTimeout(() => callback(result), 0);
        },
        set(_values, callback) {
            setTimeout(() => callback?.(), 0);
        },
        remove(_keys, callback) {
            setTimeout(() => callback?.(), 0);
        },
    });
    window.chrome = {
        runtime: {},
        storage: {
            sync: area(options),
            local: area(),
            onChanged: {
                addListener: (listener) => listeners.push(listener),
                removeListener: (listener) => listeners.splice(listeners.indexOf(listener), 1),
            },
        },
    };
    window.fetch = async () => {
        assert.fail("native chat collection must not fetch chat messages");
    };
    load(dom, [
        "shared/settings.js",
        "shared/data.js",
        "content.js",
        "shared/uiTheme.js",
        "features/routeBridgePage.js",
        "features/chatTimestampPage.js",
        "features/chatTools/parser.js",
        "features/chatTools/messageStore.js",
        "features/chatTools/panel.js",
    ]);
    const published = [];
    const namespace = window.CheeseSpanner.chatTools;
    const createStore = namespace.createMessageStore;
    namespace.createMessageStore = (config) =>
        createStore({
            ...config,
            onChange(messages) {
                published.push(messages);
                config.onChange?.(messages);
            },
        });
    let started = false;
    t.after(() => {
        window.dispatchEvent(new window.Event("pagehide"));
        window.close();
    });
    return {
        dom,
        root: window.document.querySelector('[role="log"]'),
        published,
        start() {
            assert.equal(started, false);
            started = true;
            load(dom, ["features/chatTools.js"]);
            window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
        },
        snapshot() {
            return published.at(-1) || [];
        },
    };
}

test("successive native messages keep independent records when one DOM row is reused at least three times", (t) => {
    const h = createModules(t);
    const row = h.root.firstElementChild;
    const texts = ["첫 공지", "두 번째 공지", "반복 공지", "반복 공지"];
    const recordIds = [];
    for (let index = 0; index < texts.length; index++) {
        attachMessage(row, message({ key: `reuse-${index}`, text: texts[index], time: MESSAGE_TIME + index }));
        bodyOf(row).textContent = texts[index];
        h.collect(row);
        h.settle();
        const snapshot = h.snapshot();
        assert.deepEqual(
            Array.from(snapshot, (item) => item.text),
            texts.slice(0, index + 1)
        );
        assert.deepEqual(
            Array.from(snapshot.slice(0, index), (item) => item.recordId),
            recordIds
        );
        assert.equal(snapshot[index].unread, true, "only the new native message starts unread");
        recordIds.push(snapshot[index].recordId);
        h.store.markRead([snapshot[index].id]);
        assert.ok(h.snapshot().every((item) => item.unread === false));
    }
    assert.equal(new Set(recordIds).size, 4, "repeated text from distinct native keys remains distinct");
});

test("late MAIN metadata corrects the existing DOM role of the same native message", async (t) => {
    for (const role of ["streaming_chat_manager", "common_user", "manager"]) {
        await t.test(role, (t) => {
            const text = "브리지 준비 전 공지";
            const h = createModules(t, nativeRow({ body: text, badge: "" }), { nativeBridge: false });
            const row = h.root.firstElementChild;
            row.querySelector("._ellipsis_8bw0p_6").insertAdjacentHTML(
                "beforeend",
                '<i class="_icon_8bw0p_17 _mark_8bw0p_75 _is_partner_8bw0p_75"><span class="blind">인증 마크</span></i>'
            );
            const source = message({ key: "late-native", text, role });
            attachMessage(row, source);
            h.collect(row);
            h.settle();
            const first = h.snapshot()[0];
            assert.equal(h.snapshot().length, 1);
            assert.equal(first.role, "partner");
            h.store.markRead([first.id]);
            const authorHtml = row.querySelector("button").innerHTML;
            const bodyHtml = bodyOf(row).innerHTML;

            // React already owns this exact message. Only MAIN availability changes: the author,
            // body, DOM role and mutation revision remain unchanged during native identity hydration.
            load(h.dom, ["features/chatTimestampPage.js"]);
            h.store.collect(h.store.parseChatMessage(row));
            h.settle();
            assert.equal(row.querySelector("button").innerHTML, authorHtml);
            assert.equal(bodyOf(row).innerHTML, bodyHtml);
            if (role !== "streaming_chat_manager") {
                assert.equal(h.snapshot().length, 0, "known non-collection metadata retracts the DOM-only record");
                return;
            }

            assert.equal(h.snapshot().length, 1, "identity hydration cannot create a second record");
            assert.equal(h.snapshot()[0].id, first.id);
            assert.equal(h.snapshot()[0].recordId, first.recordId);
            assert.equal(h.snapshot()[0].role, "manager");
            assert.equal(h.snapshot()[0].unread, false, "correcting the role cannot make a read message unread");
            h.store.collect(h.store.parseChatMessage(row));
            h.settle();
            assert.equal(h.snapshot().length, 1, "rechecking the hydrated role remains idempotent");
            assert.equal(h.snapshot()[0].recordId, first.recordId);

            // The same DOM can subsequently carry another genuine message with identical visible
            // content. Its ordinary role must not retract the earlier, confirmed native record.
            attachMessage(row, message({ key: "next-ordinary", text, role: "common_user", time: MESSAGE_TIME + 1 }));
            h.collect(row);
            h.settle();
            assert.equal(h.snapshot().length, 1);
            assert.equal(h.snapshot()[0].recordId, first.recordId);
            assert.equal(h.snapshot()[0].unread, false);

            attachMessage(row, message({ key: "next-manager", text, time: MESSAGE_TIME + 2 }));
            h.collect(row);
            h.settle();
            assert.equal(h.snapshot().length, 2, "a different native key remains a distinct message");
            assert.equal(h.snapshot()[0].recordId, first.recordId);
            assert.notEqual(h.snapshot()[1].recordId, first.recordId);
            assert.deepEqual(
                Array.from(h.snapshot(), (item) => item.unread),
                [false, true]
            );
        });
    }
});

test("invalid or incomplete native metadata preserves a DOM record until ordinary status is confirmed", (t) => {
    const text = "메타데이터 확인 중 공지";
    const h = createModules(t, nativeRow({ body: text, badge: "" }), { nativeBridge: false });
    const row = h.root.firstElementChild;
    row.querySelector("._ellipsis_8bw0p_6").insertAdjacentHTML(
        "beforeend",
        '<i class="_icon_8bw0p_17 _mark_8bw0p_75 _is_partner_8bw0p_75"><span class="blind">인증 마크</span></i>'
    );
    const source = message({ key: "partial-native", text, role: "unrecognized_role" });
    source.profile.verifiedMarkType = "UNRECOGNIZED";
    attachMessage(row, source);
    h.collect(row);
    h.settle();
    const first = h.snapshot()[0];
    assert.equal(first.role, "partner");
    h.store.markRead([first.id]);
    const authorHtml = row.querySelector("button").innerHTML;
    const bodyHtml = bodyOf(row).innerHTML;
    load(h.dom, ["features/chatTimestampPage.js"]);

    for (const [role, grade] of [
        ["unrecognized_role", "UNRECOGNIZED"],
        ["common_user", "UNRECOGNIZED"],
        ["unrecognized_role", null],
        ["common_user", undefined],
    ]) {
        source.profile.userRoleCode = role;
        if (grade === undefined) delete source.profile.verifiedMarkType;
        else source.profile.verifiedMarkType = grade;
        // No author/body/identity change accompanies these partial metadata snapshots.
        h.store.collect(h.store.parseChatMessage(row));
        h.settle();
        assert.equal(h.snapshot().length, 1, "uncertain role metadata cannot delete the existing DOM record");
        assert.equal(h.snapshot()[0].id, first.id);
        assert.equal(h.snapshot()[0].recordId, first.recordId);
        assert.equal(h.snapshot()[0].role, "partner");
        assert.equal(h.snapshot()[0].unread, false);
    }

    source.profile.userRoleCode = "common_user";
    source.profile.verifiedMarkType = null;
    h.store.collect(h.store.parseChatMessage(row));
    h.settle();
    assert.equal(
        h.snapshot().length,
        0,
        "later known ordinary metadata still retracts the provisional DOM classification"
    );
    assert.equal(row.querySelector("button").innerHTML, authorHtml);
    assert.equal(bodyOf(row).innerHTML, bodyHtml);
});

test("a normal native snapshot never attributes an old body to a newly rendered manager", (t) => {
    const h = createModules(t, nativeRow({ nickname: "이전 시청자", body: "이전 시청자 본문", badge: "" }));
    const row = h.root.firstElementChild;
    attachMessage(
        row,
        message({ key: "viewer-old", nickname: "이전 시청자", text: "이전 시청자 본문", role: "common_user" })
    );
    h.collect(row);
    assert.equal(h.snapshot().length, 0);

    attachMessage(
        row,
        message({ key: "manager-new", text: "운영자의 실제 새 공지", user: "d".repeat(32), time: MESSAGE_TIME + 1 })
    );
    row.querySelector("._nickname_1mc5x_80").textContent = "진행담당";
    row.querySelector("button").insertAdjacentHTML("afterbegin", ROLE_BADGE);
    h.collect(row);
    h.settle();
    assert.ok(
        h.published.every((items) => items.every((item) => item.text !== "이전 시청자 본문")),
        "elapsed stabilization passes cannot make mismatched native content valid"
    );

    bodyOf(row).textContent = "운영자의 실제 새 공지";
    h.collect(row);
    h.settle();
    assert.deepEqual(snapshotValues(h.snapshot()), [
        { author: "진행담당", role: "manager", text: "운영자의 실제 새 공지" },
    ]);
});

test("remounting an earlier native message after row reuse preserves records, read state and navigation", (t) => {
    const h = createModules(t);
    const original = h.root.firstElementChild;
    const firstSource = message();
    attachMessage(original, firstSource);
    h.collect(original);
    const first = h.snapshot()[0];
    h.store.markRead([first.id]);
    const secondSource = message({ key: "native-2", text: "다음 공지", time: MESSAGE_TIME + 1 });
    attachMessage(original, secondSource);
    bodyOf(original).textContent = secondSource.originalContent;
    h.collect(original);
    h.settle();
    const second = h.snapshot()[1];
    original.remove();
    h.store.removeSubtrees([original], [], { isListCleared: () => true });
    h.store.finishScan(false);

    h.root.insertAdjacentHTML("beforeend", nativeRow());
    const returned = h.root.firstElementChild;
    attachMessage(returned, firstSource);
    h.collect(returned);
    h.store.finishScan(true);
    h.settle();
    assert.deepEqual(
        Array.from(h.snapshot(), (item) => item.recordId),
        [first.recordId, second.recordId]
    );
    assert.deepEqual(
        Array.from(h.snapshot(), (item) => item.unread),
        [false, true]
    );
    let scrolls = 0;
    returned.scrollIntoView = () => scrolls++;
    h.store.navigate(first.id, first.recordId);
    assert.equal(scrolls, 1, "the existing record follows the newly mounted native row");
    assert.doesNotMatch(JSON.stringify(h.snapshot()), /native-1|native-2|cccccccccccccccccccccccccccccccc/);
});

test("capacity-evicted native keys stay retired through a root replacement and a late backlog remount", (t) => {
    const h = createModules(t);
    h.store.configure({ enabled: true, maximum: 1 });
    const row = h.root.firstElementChild;
    const firstSource = message();
    const secondSource = message({ key: "native-2", text: "현재 공지", time: MESSAGE_TIME + 1 });
    attachMessage(row, firstSource);
    h.collect(row);
    attachMessage(row, secondSource);
    bodyOf(row).textContent = secondSource.originalContent;
    h.collect(row);
    h.settle();
    const retained = h.snapshot()[0];
    h.store.markRead([retained.id]);

    const replacement = h.root.cloneNode(false);
    replacement.innerHTML = nativeRow() + nativeRow({ body: secondSource.originalContent });
    attachMessage(replacement.firstElementChild, firstSource);
    attachMessage(replacement.lastElementChild, secondSource);
    h.root.replaceWith(replacement);
    h.store.adoptRoot(replacement);
    for (const returned of replacement.children) h.collect(returned);
    h.store.finishScan(true);
    h.settle();
    assert.equal(h.snapshot().length, 1);
    assert.equal(h.snapshot()[0].recordId, retained.recordId);
    assert.equal(h.snapshot()[0].text, "현재 공지");
    assert.equal(h.snapshot()[0].unread, false, "evicted backlog cannot replace the retained read record");
});

test("a channel change rejects delayed native keys from retained and evicted messages on fresh DOM nodes", (t) => {
    const h = createModules(t);
    h.store.configure({ enabled: true, maximum: 1 });
    const row = h.root.firstElementChild;
    const oldSources = [message(), message({ key: "native-2", text: "두 번째 공지", time: MESSAGE_TIME + 1 })];
    for (const source of oldSources) {
        attachMessage(row, source);
        bodyOf(row).textContent = source.originalContent;
        h.collect(row);
        h.settle();
    }
    h.store.retireRows([row]);
    h.store.clear();
    h.store.resetRoot();
    h.dom.window.history.replaceState({}, "", `/live/${CHANNEL_B}`);
    const replacement = h.root.cloneNode(false);
    h.root.replaceWith(replacement);
    h.store.adoptRoot(replacement);
    for (const source of oldSources) {
        replacement.insertAdjacentHTML("beforeend", nativeRow({ body: source.originalContent }));
        const returned = replacement.lastElementChild;
        attachMessage(returned, source);
        h.collect(returned);
    }
    h.store.finishScan(true);
    h.settle();
    assert.equal(h.snapshot().length, 0, "both retained and evicted identities belong to the previous channel");

    replacement.insertAdjacentHTML("beforeend", nativeRow({ body: "새 채널 공지" }));
    const fresh = replacement.lastElementChild;
    attachMessage(fresh, message({ key: "new-channel", text: "새 채널 공지", time: MESSAGE_TIME + 2 }));
    h.collect(fresh);
    h.settle();
    assert.deepEqual(
        Array.from(h.snapshot(), (item) => item.text),
        ["새 채널 공지"]
    );
});

test("the mutation controller never publishes staged native author/body mixtures, including removed rows", async (t) => {
    for (const detached of [false, true]) {
        await t.test(detached ? "removed before the collection batch" : "kept in the native list", async (t) => {
            const f = createController(t, nativeRow({ nickname: "이전 시청자", body: "이전 시청자 본문", badge: "" }));
            const original = f.root.firstElementChild;
            attachMessage(
                original,
                message({ key: "viewer-old", nickname: "이전 시청자", text: "이전 시청자 본문", role: "common_user" })
            );
            f.start();
            await waitForCondition(() => Boolean(f.dom.window.document.querySelector(".bcct-moderator-trigger")));
            const source = message({
                key: "manager-new",
                text: "운영자의 실제 새 공지",
                user: "d".repeat(32),
                time: MESSAGE_TIME + 1,
            });
            attachMessage(original, source);
            original.querySelector("._nickname_1mc5x_80").textContent = source.profile.nickname;
            original.querySelector("button").insertAdjacentHTML("afterbegin", ROLE_BADGE);
            await Promise.resolve();
            if (detached) {
                original.remove();
                await Promise.resolve();
            }
            // The measured failure occurs when a row leaves the list before the 120ms
            // collection batch. Finish the native DOM in the next task, inside that window.
            await new Promise((resolve) => setTimeout(resolve, 20));
            assert.ok(
                f.published.every((items) => items.every((item) => item.text !== "이전 시청자 본문")),
                "removing a staged native row must not publish the new manager with the old viewer's body"
            );
            if (detached) {
                f.root.insertAdjacentHTML("beforeend", nativeRow({ body: source.originalContent }));
                attachMessage(f.root.lastElementChild, source);
            } else bodyOf(original).textContent = source.originalContent;
            await waitForCondition(() => f.snapshot().some((item) => item.text === source.originalContent));
            assert.ok(
                f.published.every((items) => items.every((item) => item.text !== "이전 시청자 본문")),
                "no published snapshot may combine the new manager with the old viewer's body"
            );
            assert.deepEqual(snapshotValues(f.snapshot()), [
                { author: "진행담당", role: "manager", text: "운영자의 실제 새 공지" },
            ]);
        });
    }
});

test("enabling native collection does not reveal blind originals or activate the collection panel on VOD", async (t) => {
    await t.test("blind-original display remains disabled", async (t) => {
        const f = createController(t, nativeRow({ body: BLIND_NOTICE }));
        attachMessage(f.root.firstElementChild, message({ text: "표시하면 안 되는 원문", status: "BLIND" }));
        f.start();
        await waitForCondition(() => Boolean(f.dom.window.document.querySelector(".bcct-moderator-trigger")));
        assert.equal(bodyOf(f.root.firstElementChild).textContent, BLIND_NOTICE);
        assert.equal(f.dom.window.document.querySelector(".bcct-blind-reveal"), null);
        assert.ok(f.published.every((items) => items.every((item) => item.text !== "표시하면 안 되는 원문")));
    });
    await t.test("VOD keeps collection inactive", async (t) => {
        const f = createController(t, nativeRow(), { url: "/video/123" });
        attachMessage(f.root.firstElementChild, message());
        f.start();
        await waitForCondition(() => f.published.length > 0);
        bodyOf(f.root.firstElementChild).textContent = "다시보기 공지";
        attachMessage(f.root.firstElementChild, message({ text: "다시보기 공지" }));
        // Cover the controller's 120ms scan and the two existing 100ms stabilization passes.
        await new Promise((resolve) => setTimeout(resolve, 350));
        assert.equal(f.snapshot().length, 0);
        assert.equal(f.dom.window.document.querySelector(".bcct-moderator-trigger"), null);
        assert.equal(bodyOf(f.root.firstElementChild).textContent, "다시보기 공지");
    });
});
