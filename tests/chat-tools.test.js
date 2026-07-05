const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repoRoot = path.join(__dirname, "..");
const MODERATOR_CACHE_STORAGE_KEY = "betterChzzkChatToolsModeratorCache";

function readRepoFile(...parts) {
    return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

function createStorageArea(initialData = {}) {
    const data = { ...initialData };

    return {
        data,
        get(keys, callback) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                if (Object.hasOwn(data, key)) result[key] = data[key];
            }
            setTimeout(() => callback(result), 0);
        },
        set(values, callback) {
            Object.assign(data, values || {});
            setTimeout(() => callback?.(), 0);
        },
        remove(keys, callback) {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                delete data[key];
            }
            setTimeout(() => callback?.(), 0);
        },
    };
}

function createFakeChrome(sync = {}, local = {}) {
    const syncArea = createStorageArea(sync);
    const localArea = createStorageArea(local);
    const storageChangeListeners = [];

    return {
        runtime: {},
        storage: {
            sync: syncArea,
            local: localArea,
            onChanged: {
                addListener(listener) {
                    storageChangeListeners.push(listener);
                },
                removeListener(listener) {
                    const index = storageChangeListeners.indexOf(listener);
                    if (index >= 0) storageChangeListeners.splice(index, 1);
                },
            },
        },
        testState: {
            sync: syncArea.data,
            local: localArea.data,
            storageChangeListeners,
        },
    };
}

function createPageDom(rows, sync = {}, local = {}) {
    const chrome = createFakeChrome(
        {
            chatToolsEnabled: true,
            chatToolsShowBlindEnabled: true,
            ...sync,
        },
        local
    );
    const dom = new JSDOM(
        [
            "<!doctype html>",
            "<body>",
            '<aside class="live_chatting_area">',
            '<div class="chat-header">',
            '<button class="chat-collapse" type="button" aria-label="채팅 접기">접기</button>',
            "<strong>채팅</strong>",
            '<button class="chat-more" type="button" aria-label="더보기">⋮</button>',
            "</div>",
            '<div class="chat-list" role="log">',
            rows,
            "</div>",
            "</aside>",
            "</body>",
        ].join(""),
        {
            url: "https://chzzk.naver.com/live/test-channel",
            runScripts: "outside-only",
            pretendToBeVisual: true,
        }
    );

    dom.window.chrome = chrome;
    dom.window.fetch = async () => {
        throw new Error("chat tools must not fetch messages");
    };

    return { chrome, dom };
}

function evalRepoScript(dom, ...parts) {
    dom.window.eval(readRepoFile(...parts));
}

function loadChatTools(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "chatTools.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
}

function closeChatToolsDom(dom) {
    for (const listener of dom.window.chrome?.testState?.storageChangeListeners || []) {
        listener({ chatToolsEnabled: { oldValue: true, newValue: false } }, "sync");
    }
    dom.window.close();
}

function waitForCondition(predicate, { timeoutMs = 1500, intervalMs = 20 } = {}) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const tick = () => {
            try {
                if (predicate()) {
                    resolve();
                    return;
                }
                if (Date.now() - startedAt > timeoutMs) {
                    reject(new Error("Timed out waiting for condition"));
                    return;
                }
                setTimeout(tick, intervalMs);
            } catch (error) {
                reject(error);
            }
        };
        tick();
    });
}

function moderatorRows(document) {
    return Array.from(document.querySelectorAll(".bcct-moderator-row"));
}

function openModeratorPanel(document) {
    const trigger = document.querySelector(".bcct-moderator-trigger");
    trigger?.click();
    return trigger;
}

test("blind message with hidden original text replaces the notice with a strikethrough original", async (t) => {
    const { dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="blind-1">',
            '<span class="nickname">viewer</span>',
            '<span class="message">블라인드 처리된 메시지입니다.</span>',
            '<span class="message-hidden" style="display:none">숨겨진 원문입니다</span>',
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);

    await waitForCondition(() => dom.window.document.querySelector(".bcct-blind-reveal"));

    const reveal = dom.window.document.querySelector(".bcct-blind-reveal");
    assert.equal(reveal.textContent, "숨겨진 원문입니다");
    // 블라인드 문구는 가려지고 원문이 그 자리에 들어간다.
    const notice = dom.window.document.querySelector('[data-chat-id="blind-1"] .message');
    assert.equal(notice.getAttribute("data-bcct-blind-masked"), "1");
    assert.equal(reveal.previousElementSibling, notice);
});

test("blind mask survives a React-style className reset without flickering", async (t) => {
    const { dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="blind-rerender">',
            '<span class="nickname">viewer</span>',
            '<span class="message">블라인드 처리된 메시지입니다.</span>',
            '<span class="message-hidden" style="display:none">재렌더에도 남을 원문</span>',
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);

    await waitForCondition(() => dom.window.document.querySelector(".bcct-blind-reveal"));

    const notice = dom.window.document.querySelector('[data-chat-id="blind-rerender"] .message');
    assert.equal(notice.getAttribute("data-bcct-blind-masked"), "1");

    // 치지직(React)이 리스트를 재렌더하며 className 을 원래 값으로 다시 설정하는
    // 상황을 재현한다. 클래스 기반 가림이었다면 이 시점에 문구가 다시 보인다.
    notice.setAttribute("class", "message");

    // mutation 사이클이 지나가도 data 속성 기반 가림은 유지되어야 한다.
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(notice.getAttribute("data-bcct-blind-masked"), "1");
    const reveal = dom.window.document.querySelector('[data-chat-id="blind-rerender"] .bcct-blind-reveal');
    assert.equal(reveal.textContent, "재렌더에도 남을 원문");
    assert.equal(reveal.previousElementSibling, notice);
});

test("blind message without any recoverable original keeps the notice untouched", async (t) => {
    const { dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="blind-known">',
            '<span class="nickname">viewer</span>',
            '<span class="message">블라인드 처리된 메시지입니다.</span>',
            '<span class="message-hidden" style="display:none">복원 가능한 원문</span>',
            "</div>",
            '<div class="chat-row" data-chat-id="blind-unknown">',
            '<span class="nickname">viewer</span>',
            '<span class="message">블라인드 처리된 메시지입니다.</span>',
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);

    // 원문이 있는 행이 처리될 때까지 기다리면 없는 행도 같은 사이클에서 처리된 상태다.
    await waitForCondition(() => dom.window.document.querySelector(".bcct-blind-reveal"));

    const unknownRow = dom.window.document.querySelector('[data-chat-id="blind-unknown"]');
    assert.equal(unknownRow.querySelector(".bcct-blind-reveal"), null);
    assert.equal(unknownRow.querySelector("[data-bcct-blind-masked]"), null);
    assert.match(unknownRow.textContent, /블라인드 처리된 메시지입니다/);
});

test("message blinded after the fact is restored from the cached original", async (t) => {
    // 실제 치지직 마크업 기준: 사후 블라인드는 mutation 경로로 재파싱되며
    // 그때 row 는 처음 스캔 때와 다른 노드로 잡힌다.
    const { dom } = createPageDom(realChzzkChatRow({ nickname: "일반 시청자", text: "원래 하려던 말" }));
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);

    // 첫 sync 가 끝나 원문이 캐시될 때까지 기다린다 (trigger 생성은 sync 안에서 일어난다).
    await waitForCondition(() => dom.window.document.querySelector(".bcct-moderator-trigger"));

    // 치지직이 원문을 지우고 블라인드 문구로 바꾸는 상황을 재현한다.
    const notice = dom.window.document.querySelector("._text_1vemp_1");
    notice.textContent = "메시지가 블라인드 처리되었습니다.";

    await waitForCondition(() => dom.window.document.querySelector(".bcct-blind-reveal"));

    const reveal = dom.window.document.querySelector(".bcct-blind-reveal");
    assert.equal(reveal.textContent, "원래 하려던 말");
    assert.equal(notice.getAttribute("data-bcct-blind-masked"), "1");
    assert.equal(reveal.previousElementSibling, notice);
});

test("an open profile card inside a chat row is not blinded or collected", async (t) => {
    const { dom } = createPageDom(realChzzkChatRow({ nickname: "일반 시청자", text: "그냥 채팅" }));
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);
    await waitForCondition(() => dom.window.document.querySelector(".bcct-moderator-trigger"));

    // 닉네임 클릭으로 프로필 카드가 행 안에 펼쳐진 상황을 재현한다.
    const nicknameButton = dom.window.document.querySelector("._nickname_1vemp_37");
    nicknameButton.setAttribute("aria-expanded", "true");
    nicknameButton.insertAdjacentHTML(
        "afterend",
        [
            '<div class="_layer_profile_1abc_1">',
            '<strong class="_nickname_profile_1abc_5">일반 시청자</strong>',
            "<div>메시지 6 임시 제한 0 활동 제한 0</div>",
            '<button type="button">메시지 상단 고정</button>',
            '<button type="button">채팅 운영자 임명</button>',
            '<button type="button">임시 제한</button>',
            '<button type="button">활동 제한</button>',
            '<button type="button">메시지 신고</button>',
            '<button type="button">메시지 삭제</button>',
            "</div>",
        ].join("")
    );

    await new Promise((resolve) => setTimeout(resolve, 300));

    // 카드가 블라인드로 오인되어 가려지거나 원문 취소선이 붙으면 안 된다.
    assert.equal(dom.window.document.querySelector(".bcct-blind-reveal"), null);
    assert.equal(dom.window.document.querySelector("[data-bcct-blind-masked]"), null);
    // 카드 내용("운영자" 등)이 방송자/매니저 메시지로 수집되어도 안 된다.
    assert.equal(moderatorRows(dom.window.document).length, 0);
});

test("normal user messages are not collected but manager and broadcaster messages are", async (t) => {
    const { dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="normal-1">',
            '<span class="nickname">viewer</span>',
            '<span class="message">일반 채팅</span>',
            "</div>",
            '<div class="chat-row" data-chat-id="manager-1">',
            '<span class="badge" aria-label="매니저"></span>',
            '<span class="nickname">manager</span>',
            '<span class="message">관리자 안내</span>',
            "</div>",
            '<div class="chat-row" data-chat-id="owner-1">',
            '<span class="badge" aria-label="스트리머"></span>',
            '<span class="nickname">streamer</span>',
            '<span class="message">방송자 공지</span>',
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);

    await waitForCondition(() => moderatorRows(dom.window.document).length === 2);

    const trigger = dom.window.document.querySelector(".bcct-moderator-trigger");
    const menuButton = dom.window.document.querySelector(".chat-more");
    const header = dom.window.document.querySelector(".chat-header");
    assert.equal(trigger.tagName, "BUTTON");
    assert.equal(trigger.parentElement, menuButton.parentElement);
    assert.equal(trigger.parentElement.getAttribute("data-bcct-moderator-actions"), "1");
    assert.equal(trigger.parentElement.parentElement, header);
    assert.equal(trigger.nextElementSibling, menuButton);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(dom.window.document.querySelector(".bcct-moderator-box").dataset.open, "0");

    trigger.click();

    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.equal(dom.window.document.querySelector(".bcct-moderator-box").dataset.open, "1");

    const collectedText = moderatorRows(dom.window.document)
        .map((row) => row.textContent)
        .join("\n");
    assert.doesNotMatch(collectedText, /일반 채팅/);
    assert.match(collectedText, /관리자 안내/);
    assert.match(collectedText, /방송자 공지/);
});

// 실제 치지직 라이브 채팅 마크업 (2026-07 실측): 역할 신호는 img alt뿐이고,
// 클래스는 전부 해시이며 닉네임 버튼 내부 컨테이너에 _is_message_ 클래스가 있다.
// 닉네임과 본문을 함께 감싸는 _chatting_message_ 컨테이너 때문에 본문 파싱이
// 닉네임을 포함하지 않는지도 이 중첩 구조로 검증한다.
function realChzzkChatRow({ badgeImg = "", nickname, text, chatId = "", nicknameColor = "rgb(217, 176, 79)" }) {
    return [
        `<div class="_item_sg7hy_7"${chatId ? ` data-chat-id="${chatId}"` : ""}>`,
        '<div class="_container_1vemp_1">',
        '<div class="_chatting_message_1vemp_21">',
        '<button type="button" class="_nickname_1vemp_37" aria-haspopup="true" aria-expanded="false">',
        '<span class="_container_o04z9_2 _is_message_o04z9_5 _is_ellipsis_o04z9_86" style="margin-right: 4px;">',
        badgeImg
            ? [
                  '<span class="_wrapper_o04z9_23">',
                  '<span class="_icon_o04z9_15" style="width: 18px; height: 18px;">',
                  `<span class="_container_1jo9t_2">${badgeImg}</span>`,
                  "</span>",
                  "</span>",
              ].join("")
            : "",
        `<span class="_nickname_o04z9_57"${nicknameColor ? ` style="color: ${nicknameColor};"` : ""}>${nickname}</span>`,
        "</span>",
        "</button>",
        `<span class="_text_1vemp_1">${text}</span>`,
        "</div>",
        "</div>",
        "</div>",
    ].join("");
}

test("real chzzk markup: badge img alt collects broadcaster and manager, not viewers", async (t) => {
    const { dom } = createPageDom(
        [
            realChzzkChatRow({ nickname: "일반 시청자", text: "그냥 일반 채팅" }),
            realChzzkChatRow({
                badgeImg:
                    '<img src="https://ssl.pstatic.net/static/nng/glive/icon/streamer.png" alt="스트리머" width="18" height="18">',
                nickname: "부지런한 휴먼 989",
                text: "asd",
            }),
            realChzzkChatRow({
                badgeImg: [
                    '<img src="https://ssl.pstatic.net/static/nng/glive/icon/manager.png" alt="방송 매니저" width="18" height="18">',
                    '<img src="https://nng-phinf.pstatic.net/subscription/badge3.png" alt="3개월 구독" width="18" height="18">',
                ].join(""),
                nickname: "성실한 부계정",
                text: "매니저 안내 메시지",
            }),
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);

    await waitForCondition(() => moderatorRows(dom.window.document).length === 2);

    openModeratorPanel(dom.window.document);
    const rows = moderatorRows(dom.window.document);
    const collectedText = rows.map((row) => row.textContent).join("\n");
    assert.doesNotMatch(collectedText, /그냥 일반 채팅/);
    assert.match(collectedText, /부지런한 휴먼 989/);
    assert.match(collectedText, /asd/);
    assert.match(collectedText, /성실한 부계정/);
    assert.match(collectedText, /매니저 안내 메시지/);
    // 닉네임+본문을 함께 감싸는 컨테이너를 본문으로 오인해 닉네임이 섞이면 안 된다.
    const texts = rows.map((row) => row.querySelector(".bcct-moderator-row__text").textContent);
    assert.deepEqual(texts, ["asd", "매니저 안내 메시지"]);
    // 본 채팅창과 같은 실제 뱃지 아이콘이 순서대로 함께 표시된다.
    const broadcasterBadges = rows[0].querySelectorAll(".bcct-moderator-row__badge");
    assert.equal(broadcasterBadges.length, 1);
    assert.match(broadcasterBadges[0].getAttribute("src"), /icon\/streamer\.png$/);
    assert.equal(broadcasterBadges[0].getAttribute("alt"), "스트리머");
    const managerBadges = rows[1].querySelectorAll(".bcct-moderator-row__badge");
    assert.equal(managerBadges.length, 2);
    assert.match(managerBadges[0].getAttribute("src"), /icon\/manager\.png$/);
    assert.match(managerBadges[1].getAttribute("src"), /subscription\/badge3\.png$/);
    assert.equal(managerBadges[1].getAttribute("alt"), "3개월 구독");
    // 닉네임 색상도 본 채팅창과 동일하게 복원된다.
    const broadcasterAuthor = rows[0].querySelector(".bcct-moderator-row__author");
    assert.equal(broadcasterAuthor.textContent, "부지런한 휴먼 989");
    assert.equal(broadcasterAuthor.style.color, "rgb(217, 176, 79)");
});

test("sr-only badge descriptions are not mixed into the collected nickname or text", async (t) => {
    // 실측(대형 방송, dtc6c 계열 닉네임 컨테이너): 아이콘의 <span class="blind">
    // 는 네이버 공통 sr-only 클래스로 clip/absolute 처리라 화면에 안 보이지만
    // display:none 이 아니어서 예전에는 getVisibleText 가 "명예훈장"/"인증 마크"
    // 를 닉네임에 섞어 수집했다.
    const { dom } = createPageDom(
        [
            '<div class="_item_sg7hy_7" data-chat-id="sronly-badge-1">',
            '<div class="_container_1vemp_1">',
            '<div class="_chatting_message_1vemp_21">',
            '<button type="button" class="_nickname_1vemp_37" aria-haspopup="true" aria-expanded="false">',
            '<strong class="_name_1hyev_92">',
            '<span class="_truncate_dtc6c_2" style="overflow-wrap: break-word;">',
            '<img src="https://ssl.pstatic.net/static/nng/glive/icon/streamer.png" alt="스트리머" width="18" height="18">',
            '<i class="_icon_dtc6c_17" style="width: 16px; height: 16px; margin-top: 1px;">',
            '<span class="blind">명예훈장</span>',
            "</i>",
            '<i class="_icon_dtc6c_17" style="width: 16px; margin-top: 1px; background-image: url(\'https://nng-phinf.pstatic.net/badge.PNG\');">',
            '<span class="blind">인증 마크</span>',
            "</i>",
            '<span class="_text_dtc6c_2">앰큐베이터</span>',
            "</span>",
            "</strong>",
            "</button>",
            '<span class="_text_1vemp_1">2025 치지직컵 2위 소감입니다</span>',
            "</div>",
            "</div>",
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);

    await waitForCondition(() => moderatorRows(dom.window.document).length === 1);

    openModeratorPanel(dom.window.document);
    const row = moderatorRows(dom.window.document)[0];
    // sr-only 뱃지 설명 없이 실제 닉네임만 수집된다.
    assert.equal(row.querySelector(".bcct-moderator-row__author").textContent, "앰큐베이터");
    // 본문에도 sr-only 텍스트가 섞이지 않는다.
    assert.equal(row.querySelector(".bcct-moderator-row__text").textContent, "2025 치지직컵 2위 소감입니다");
    assert.doesNotMatch(row.textContent, /명예훈장|인증 마크/);
});

test("role words in normal message text are not collected", async (t) => {
    const { dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="normal-role-words" aria-label="viewer: 방장 텍스트">',
            '<span class="nickname">viewer</span>',
            '<span class="message" aria-label="방장이라고 말한 채팅">방장 streamer owner broadcaster words in chat only</span>',
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);

    await waitForCondition(() => dom.window.document.querySelector(".bcct-moderator-box"));
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(moderatorRows(dom.window.document).length, 0);
});

test("role data on the nickname area still collects broadcaster messages", async (t) => {
    const { dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="nickname-role-data">',
            '<span class="nickname" data-author-type="broadcaster">channel</span>',
            '<span class="message">nickname role signal</span>',
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);

    await waitForCondition(() => moderatorRows(dom.window.document).length === 1);

    assert.match(moderatorRows(dom.window.document)[0].textContent, /nickname role signal/);
});

test("visible role-only badge text still collects broadcaster messages", async (t) => {
    const { dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="visible-broadcaster-badge">',
            '<span class="badge">streamer</span>',
            '<span class="nickname">channel</span>',
            '<span class="message">visible badge signal</span>',
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);

    await waitForCondition(() => moderatorRows(dom.window.document).length === 1);

    assert.match(moderatorRows(dom.window.document)[0].textContent, /visible badge signal/);
});

test("moderator trigger stays in the chat header when a pinned notice has its own menu", async (t) => {
    const { dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="manager-pinned-header">',
            '<span class="badge" aria-label="manager"></span>',
            '<span class="nickname">manager</span>',
            '<span class="message">notice should not own the trigger</span>',
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    const header = dom.window.document.querySelector(".chat-header");
    header.insertAdjacentHTML(
        "beforebegin",
        [
            '<div class="chat-header pinned-notice" aria-label="pinned notice">',
            "<span>Pinned message</span>",
            '<button class="notice-more" type="button" aria-label="more menu">...</button>',
            "</div>",
        ].join("")
    );

    loadChatTools(dom);

    await waitForCondition(() => moderatorRows(dom.window.document).length === 1);

    const trigger = dom.window.document.querySelector(".bcct-moderator-trigger");
    const menuButton = dom.window.document.querySelector(".chat-more");
    const pinnedNotice = dom.window.document.querySelector(".pinned-notice");
    assert.equal(pinnedNotice.querySelector(".bcct-moderator-trigger"), null);
    assert.equal(trigger.parentElement, menuButton.parentElement);
    assert.equal(trigger.parentElement.parentElement, header);
    assert.equal(trigger.nextElementSibling, menuButton);
});

test("moderator trigger does not move into the chat input controls", async (t) => {
    const { dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="manager-input-menu">',
            '<span class="badge" aria-label="manager"></span>',
            '<span class="nickname">manager</span>',
            '<span class="message">input controls should not own the trigger</span>',
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    dom.window.document
        .querySelector(".chat-list")
        .insertAdjacentHTML(
            "afterend",
            [
                '<div class="chat-input-controls" aria-label="chat input">',
                '<button class="chat-input-menu" type="button" aria-label="emoji menu">menu</button>',
                '<textarea aria-label="chat input"></textarea>',
                "</div>",
            ].join("")
        );

    loadChatTools(dom);

    await waitForCondition(() => moderatorRows(dom.window.document).length === 1);

    const trigger = dom.window.document.querySelector(".bcct-moderator-trigger");
    const menuButton = dom.window.document.querySelector(".chat-more");
    const inputControls = dom.window.document.querySelector(".chat-input-controls");
    assert.equal(inputControls.querySelector(".bcct-moderator-trigger"), null);
    assert.equal(trigger.parentElement, menuButton.parentElement);
    assert.equal(trigger.nextElementSibling, menuButton);
});

test("duplicate mutations do not duplicate collected manager messages", async (t) => {
    const { dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="manager-dup">',
            '<span class="badge" aria-label="매니저"></span>',
            '<span class="nickname">manager</span>',
            '<span class="message">한 번만 수집</span>',
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);
    await waitForCondition(() => moderatorRows(dom.window.document).length === 1);

    dom.window.document.querySelector(".chat-row").appendChild(dom.window.document.createElement("span"));
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(moderatorRows(dom.window.document).length, 1);
});

test("nested chat row candidates are processed as a single outer row", async (t) => {
    const { dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="manager-nested-outer">',
            '<span class="badge" aria-label="매니저"></span>',
            '<span class="nickname">manager</span>',
            '<span class="message">',
            '<span class="chat-message">중첩 후보가 있어도 한 번만 수집</span>',
            "</span>",
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);
    await waitForCondition(() => moderatorRows(dom.window.document).length === 1);

    assert.match(moderatorRows(dom.window.document)[0].textContent, /중첩 후보가 있어도 한 번만 수집/);
});

test("added chat rows are processed without reparsing the whole list", async (t) => {
    const { dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="normal-before-add">',
            '<span class="nickname">viewer</span>',
            '<span class="message">기존 일반 채팅</span>',
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);
    await waitForCondition(() => dom.window.document.querySelector(".bcct-moderator-box"));

    dom.window.document
        .querySelector(".chat-list")
        .insertAdjacentHTML(
            "beforeend",
            [
                '<div class="chat-row" data-chat-id="manager-added-incremental">',
                '<span class="badge" aria-label="매니저"></span>',
                '<span class="nickname">manager</span>',
                '<span class="message">증분 추가 수집</span>',
                "</div>",
            ].join("")
        );

    await waitForCondition(() => moderatorRows(dom.window.document).length === 1);

    assert.match(moderatorRows(dom.window.document)[0].textContent, /증분 추가 수집/);
});

test("dirty blind rows are reparsed when hidden original text changes", async (t) => {
    const { dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="blind-dirty-update">',
            '<span class="nickname">viewer</span>',
            '<span class="message">블라인드 처리된 메시지입니다.</span>',
            '<span class="message-hidden" style="display:none">처음 숨김 원문</span>',
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);
    await waitForCondition(() =>
        /처음 숨김 원문/.test(dom.window.document.querySelector(".bcct-blind-reveal")?.textContent || "")
    );

    dom.window.document.querySelector(".message-hidden").textContent = "바뀐 숨김 원문";

    await waitForCondition(() =>
        /바뀐 숨김 원문/.test(dom.window.document.querySelector(".bcct-blind-reveal")?.textContent || "")
    );
});

test("moderator box trims old messages at the configured maximum", async (t) => {
    const rows = Array.from({ length: 25 }, (_, index) =>
        [
            `<div class="chat-row" data-chat-id="manager-${index}">`,
            '<span class="badge" aria-label="매니저"></span>',
            `<span class="nickname">manager-${index}</span>`,
            `<span class="message">관리자 메시지 ${index}</span>`,
            "</div>",
        ].join("")
    ).join("");
    const { dom } = createPageDom(rows, { chatToolsMaxModeratorMessages: 20 });
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);

    await waitForCondition(() => moderatorRows(dom.window.document).length === 20);

    const collectedText = moderatorRows(dom.window.document)
        .map((row) => row.textContent)
        .join("\n");
    assert.doesNotMatch(collectedText, /관리자 메시지 0/);
    assert.match(collectedText, /관리자 메시지 24/);
});

test("moderator cache restores messages collected while watching the same live", async (t) => {
    const { chrome, dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="manager-cache-1">',
            '<span class="badge" aria-label="매니저"></span>',
            '<span class="nickname">manager</span>',
            '<span class="message">잠깐 저장할 안내</span>',
            "</div>",
        ].join(""),
        { chatToolsCacheModeratorMessagesEnabled: true }
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);

    await waitForCondition(() => {
        const entry = chrome.testState.local[MODERATOR_CACHE_STORAGE_KEY]?.entries?.["live:test-channel"];
        return entry?.messages?.length === 1;
    });

    const cachedLocal = chrome.testState.local;
    const { dom: restoredDom } = createPageDom("", { chatToolsCacheModeratorMessagesEnabled: true }, cachedLocal);
    t.after(() => closeChatToolsDom(restoredDom));

    loadChatTools(restoredDom);

    await waitForCondition(() => moderatorRows(restoredDom.window.document).length === 1);
    openModeratorPanel(restoredDom.window.document);
    assert.match(moderatorRows(restoredDom.window.document)[0].textContent, /잠깐 저장할 안내/);
});

function fakeLiveDetailFetch(liveId, status = "OPEN") {
    return async () => ({
        ok: true,
        json: async () => ({ content: { status, liveId } }),
    });
}

test("restored legacy cache entries get badges and color backfilled from the live DOM", async (t) => {
    // 뱃지/색상이 없던 구버전 저장분을 캐시에서 먼저 복원한 뒤(빈 DOM 으로 로드),
    // 같은 메시지가 나중에 DOM 에 나타나 재파싱되는 실사용 순서를 재현한다. 캐시
    // 항목 id 는 getMessageId 의 `${attr}:${value}` 형식이라 data-chat-id 값과
    // 맞춰야 같은 항목으로 매칭돼 백필 분기를 탄다.
    const now = Date.now();
    const local = {
        [MODERATOR_CACHE_STORAGE_KEY]: {
            version: 1,
            entries: {
                "live:test-channel": {
                    savedAt: now,
                    expiresAt: now + 60 * 60 * 1000,
                    liveId: "300",
                    messages: [
                        {
                            id: "data-chat-id:manager-backfill-1",
                            author: "성실한 부계정",
                            role: "manager",
                            text: "백필 대상 안내",
                            // badges/authorColor 없음 (구버전 저장분)
                        },
                    ],
                },
            },
        },
    };

    // 처음에는 DOM 에 해당 메시지가 없어 캐시 복원만으로 뱃지 없는 행이 뜬다.
    const { dom } = createPageDom("", { chatToolsCacheModeratorMessagesEnabled: true }, local);
    t.after(() => closeChatToolsDom(dom));

    dom.window.fetch = fakeLiveDetailFetch(300);
    loadChatTools(dom);

    // 캐시 복원분은 뱃지/색상이 없다.
    await waitForCondition(() => moderatorRows(dom.window.document).length === 1);
    assert.equal(moderatorRows(dom.window.document)[0].querySelector(".bcct-moderator-row__badge"), null);
    assert.equal(moderatorRows(dom.window.document)[0].querySelector(".bcct-moderator-row__author").style.color, "");

    // 이제 같은 id 의 원본 채팅 행이 DOM 에 나타나면 재파싱으로 뱃지/색상이 백필된다.
    dom.window.document.querySelector(".chat-list").insertAdjacentHTML(
        "beforeend",
        realChzzkChatRow({
            badgeImg:
                '<img src="https://ssl.pstatic.net/static/nng/glive/icon/manager.png" alt="방송 매니저" width="18" height="18">',
            nickname: "성실한 부계정",
            text: "백필 대상 안내",
            chatId: "manager-backfill-1",
        })
    );

    await waitForCondition(() => {
        const rows = moderatorRows(dom.window.document);
        if (rows.length !== 1) return false;
        const badge = rows[0].querySelector(".bcct-moderator-row__badge");
        const author = rows[0].querySelector(".bcct-moderator-row__author");
        return Boolean(badge) && author?.style.color === "rgb(217, 176, 79)";
    });

    openModeratorPanel(dom.window.document);
    const row = moderatorRows(dom.window.document)[0];
    assert.match(row.textContent, /백필 대상 안내/);
    const badge = row.querySelector(".bcct-moderator-row__badge");
    assert.match(badge.getAttribute("src"), /icon\/manager\.png$/);
    assert.equal(badge.getAttribute("alt"), "방송 매니저");
    assert.equal(row.querySelector(".bcct-moderator-row__author").style.color, "rgb(217, 176, 79)");
    // 백필로 새 행이 중복 추가되지 않고 그대로 1개여야 한다.
    assert.equal(moderatorRows(dom.window.document).length, 1);
});

test("nickname color applied after collection is backfilled into the moderator box", async (t) => {
    // 치지직이 메시지 삽입 직후 닉네임 색 인라인 style 을 한 박자 늦게 적용하는
    // 상황을 재현한다. 색 없이 수집된 뒤 style mutation 이 재파싱을 일으켜
    // 백필이 발동해야 한다.
    const { dom } = createPageDom(
        realChzzkChatRow({
            badgeImg:
                '<img src="https://ssl.pstatic.net/static/nng/glive/icon/streamer.png" alt="스트리머" width="18" height="18">',
            nickname: "부지런한 휴먼 989",
            text: "색은 나중에 옵니다",
            chatId: "broadcaster-late-color",
            nicknameColor: "",
        })
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);

    await waitForCondition(() => moderatorRows(dom.window.document).length === 1);
    assert.equal(moderatorRows(dom.window.document)[0].querySelector(".bcct-moderator-row__author").style.color, "");

    // 치지직이 뒤늦게 닉네임 색을 적용한다 (style attribute mutation 발생).
    const nickname = dom.window.document.querySelector("._nickname_o04z9_57");
    nickname.style.color = "rgb(217, 176, 79)";

    await waitForCondition(() => {
        const author = moderatorRows(dom.window.document)[0]?.querySelector(".bcct-moderator-row__author");
        return author?.style.color === "rgb(217, 176, 79)";
    });

    // 백필로 행이 중복되지 않아야 한다.
    assert.equal(moderatorRows(dom.window.document).length, 1);
});

test("moderator cache is scoped to a single live session", async (t) => {
    const { chrome, dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="manager-session-1">',
            '<span class="badge" aria-label="매니저"></span>',
            '<span class="nickname">manager</span>',
            '<span class="message">이번 방송 안내</span>',
            "</div>",
        ].join(""),
        { chatToolsCacheModeratorMessagesEnabled: true }
    );
    t.after(() => closeChatToolsDom(dom));

    dom.window.fetch = fakeLiveDetailFetch(100);
    loadChatTools(dom);

    await waitForCondition(() => {
        const entry = chrome.testState.local[MODERATOR_CACHE_STORAGE_KEY]?.entries?.["live:test-channel"];
        return entry?.messages?.length === 1 && entry?.liveId === "100";
    });

    // 같은 방송(liveId 100)에서 다시 접속하면 복원된다.
    const { dom: sameSessionDom } = createPageDom(
        "",
        { chatToolsCacheModeratorMessagesEnabled: true },
        chrome.testState.local
    );
    t.after(() => closeChatToolsDom(sameSessionDom));
    sameSessionDom.window.fetch = fakeLiveDetailFetch(100);
    loadChatTools(sameSessionDom);

    await waitForCondition(() => moderatorRows(sameSessionDom.window.document).length === 1);

    // 다음 방송(liveId 200)에서는 이전 수집분이 버려진다.
    const { chrome: nextChrome, dom: nextSessionDom } = createPageDom(
        "",
        { chatToolsCacheModeratorMessagesEnabled: true },
        chrome.testState.local
    );
    t.after(() => closeChatToolsDom(nextSessionDom));
    nextSessionDom.window.fetch = fakeLiveDetailFetch(200);
    loadChatTools(nextSessionDom);

    // 폐기된 캐시는 이후 저장 사이클에서 storage 에서도 사라진다.
    await waitForCondition(() => {
        const entry = nextChrome.testState.local[MODERATOR_CACHE_STORAGE_KEY]?.entries?.["live:test-channel"];
        return !entry;
    });
    assert.equal(moderatorRows(nextSessionDom.window.document).length, 0);
});

test("turning off moderator cache removes the stored messages", async (t) => {
    const { chrome, dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="manager-cache-clear">',
            '<span class="badge" aria-label="매니저"></span>',
            '<span class="nickname">manager</span>',
            '<span class="message">끄면 지울 안내</span>',
            "</div>",
        ].join(""),
        { chatToolsCacheModeratorMessagesEnabled: true }
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);

    await waitForCondition(() => Boolean(chrome.testState.local[MODERATOR_CACHE_STORAGE_KEY]));

    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ chatToolsCacheModeratorMessagesEnabled: { oldValue: true, newValue: false } }, "sync");
    }

    await waitForCondition(() => !chrome.testState.local[MODERATOR_CACHE_STORAGE_KEY]);
});

test("disabling the option removes UI and stops collecting new chat rows", async (t) => {
    const { chrome, dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="manager-enabled">',
            '<span class="badge" aria-label="매니저"></span>',
            '<span class="nickname">manager</span>',
            '<span class="message">활성 상태 메시지</span>',
            "</div>",
            '<div class="chat-row" data-chat-id="blind-enabled">',
            '<span class="message">블라인드 처리된 메시지입니다.</span>',
            '<span style="display:none">숨겨진 원문</span>',
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);
    await waitForCondition(
        () => moderatorRows(dom.window.document).length === 1 && dom.window.document.querySelector(".bcct-blind-reveal")
    );

    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ chatToolsEnabled: { oldValue: true, newValue: false } }, "sync");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(dom.window.document.querySelector(".bcct-moderator-box"), null);
    assert.equal(dom.window.document.querySelector(".bcct-moderator-trigger"), null);
    assert.equal(dom.window.document.querySelector("[data-bcct-moderator-actions]"), null);
    assert.equal(dom.window.document.querySelector(".chat-more").parentElement.className, "chat-header");
    assert.equal(dom.window.document.querySelector(".bcct-blind-reveal"), null);

    dom.window.document
        .querySelector(".chat-list")
        .insertAdjacentHTML(
            "beforeend",
            [
                '<div class="chat-row" data-chat-id="manager-disabled">',
                '<span class="badge" aria-label="매니저"></span>',
                '<span class="message">비활성 상태 메시지</span>',
                "</div>",
            ].join("")
        );
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(dom.window.document.querySelector(".bcct-moderator-box"), null);
});

test("moderator trigger returns after the chat root node is wholly replaced and new chat arrives", async (t) => {
    // 재현: 채팅 접기/펼치기·플레이어 모드 전환 등으로 채팅 메시지 목록(chat root)
    // 노드가 통째로 새 노드로 교체되면, 옛 root를 관찰하던 observer는 새 메시지
    // mutation을 못 받아 syncChatTools가 영영 안 돌고 트리거가 복구되지 않았다.
    const { dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="seed-1">',
            '<span class="nickname">viewer</span>',
            '<span class="message">첫 메시지</span>',
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);

    // 첫 sync에서 트리거가 붙는다.
    await waitForCondition(() => dom.window.document.querySelector(".bcct-moderator-trigger"));

    const document = dom.window.document;
    const area = document.querySelector(".live_chatting_area");
    const oldList = document.querySelector(".chat-list");

    // 트리거/액션 그룹을 제거해 "버튼이 사라진" 상태를 만든다. 재연결 로직이
    // 없으면 이 뒤로 새 메시지가 와도 옛 분리 노드만 관찰해 복구되지 않는다.
    document.querySelector("[data-bcct-moderator-actions]")?.remove();
    assert.equal(document.querySelector(".bcct-moderator-trigger"), null);

    // chat root 노드를 통째로 새 노드로 교체한다(옛 노드는 DOM에서 분리).
    oldList.remove();
    const newList = document.createElement("div");
    newList.className = "chat-list";
    newList.setAttribute("role", "log");
    area.appendChild(newList);

    // 새 root에 새 채팅 메시지가 도착한다.
    newList.insertAdjacentHTML(
        "beforeend",
        [
            '<div class="chat-row" data-chat-id="after-swap-1">',
            '<span class="nickname">viewer</span>',
            '<span class="message">교체 후 메시지</span>',
            "</div>",
        ].join("")
    );

    // 재연결 감시가 분리를 감지해 새 root로 옮겨 타고 full-scan이 돌아
    // 트리거가 다시 붙어야 한다.
    await waitForCondition(() => document.querySelector(".bcct-moderator-trigger"));

    const trigger = document.querySelector(".bcct-moderator-trigger");
    assert.equal(trigger.tagName, "BUTTON");
    // 새 root가 실제 관찰 대상이 되었는지: 새 메시지 행이 파싱 처리되었는지로 확인한다.
    assert.ok(document.querySelector('[data-chat-id="after-swap-1"]'));
});
