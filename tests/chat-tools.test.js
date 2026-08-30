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
            chatToolsShowBlindEnabled: true,
            chatToolsModeratorBoxEnabled: true,
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
        listener(
            {
                chatToolsShowBlindEnabled: { oldValue: true, newValue: false },
                chatToolsModeratorBoxEnabled: { oldValue: true, newValue: false },
            },
            "sync"
        );
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

test("welcome message removal stays off by default and survives enable, remount, and re-enable", async (t) => {
    const { chrome, dom } = createPageDom(
        '<div class="_item_8lqsk_7 _big_padding_8lqsk_53">' +
            '<div class="_container_s1cb2_1 _welcome_s1cb2_18">채팅방에 오신 것을 환영합니다!</div>' +
            "</div>" +
            '<div class="_item_8lqsk_7">일반 채팅</div>',
        {
            chatWelcomeMessageRemovalEnabled: false,
            chatToolsShowBlindEnabled: false,
            chatToolsModeratorBoxEnabled: false,
        }
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(chrome.testState.storageChangeListeners.length > 0);

    const chatLog = dom.window.document.querySelector("[role='log']");
    let welcomeRow = chatLog.firstElementChild;
    let welcome = welcomeRow.firstElementChild;
    let ordinaryChat = welcomeRow.nextElementSibling;

    assert.equal(dom.window.document.getElementById("betterchzzk-chat-welcome-message-style"), null);
    assert.notEqual(dom.window.getComputedStyle(welcomeRow).display, "none");
    assert.notEqual(dom.window.getComputedStyle(welcome).display, "none");
    assert.notEqual(dom.window.getComputedStyle(ordinaryChat).display, "none");

    for (const listener of chrome.testState.storageChangeListeners) {
        listener(
            {
                chatWelcomeMessageRemovalEnabled: { oldValue: false, newValue: true },
            },
            "sync"
        );
    }
    await waitForCondition(() => dom.window.document.getElementById("betterchzzk-chat-welcome-message-style"));

    chatLog.innerHTML =
        '<div class="_item_8lqsk_7 _big_padding_8lqsk_53">' +
        '<div class="_container_s1cb2_1 _welcome_s1cb2_18">채팅방에 다시 오신 것을 환영합니다!</div>' +
        "</div>" +
        '<div class="_item_8lqsk_7">새 일반 채팅</div>';
    welcomeRow = chatLog.firstElementChild;
    welcome = welcomeRow.firstElementChild;
    ordinaryChat = welcomeRow.nextElementSibling;

    assert.equal(dom.window.document.querySelectorAll("#betterchzzk-chat-welcome-message-style").length, 1);
    assert.equal(dom.window.getComputedStyle(welcomeRow).display, "none");
    assert.equal(dom.window.getComputedStyle(welcome).display, "none");
    assert.notEqual(dom.window.getComputedStyle(ordinaryChat).display, "none");

    for (const listener of chrome.testState.storageChangeListeners) {
        listener(
            {
                chatWelcomeMessageRemovalEnabled: { oldValue: true, newValue: false },
            },
            "sync"
        );
    }

    assert.equal(dom.window.document.getElementById("betterchzzk-chat-welcome-message-style"), null);
    assert.notEqual(dom.window.getComputedStyle(welcomeRow).display, "none");
    assert.notEqual(dom.window.getComputedStyle(welcome).display, "none");

    for (const listener of chrome.testState.storageChangeListeners) {
        listener(
            {
                chatWelcomeMessageRemovalEnabled: { oldValue: false, newValue: true },
            },
            "sync"
        );
    }

    assert.equal(dom.window.document.querySelectorAll("#betterchzzk-chat-welcome-message-style").length, 1);
    assert.equal(dom.window.getComputedStyle(welcomeRow).display, "none");
    assert.equal(dom.window.getComputedStyle(welcome).display, "none");
});

test("welcome message removal restores a remounted welcome row when disabled", async (t) => {
    const { chrome, dom } = createPageDom("", {
        chatWelcomeMessageRemovalEnabled: true,
        chatToolsShowBlindEnabled: false,
        chatToolsModeratorBoxEnabled: false,
    });
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);
    await waitForCondition(() => dom.window.document.getElementById("betterchzzk-chat-welcome-message-style"));

    const chatLog = dom.window.document.querySelector("[role='log']");
    chatLog.innerHTML =
        '<div class="_item_8lqsk_7 _big_padding_8lqsk_53">' +
        '<div class="_container_s1cb2_1 _welcome_s1cb2_18">채팅방에 오신 것을 환영합니다!</div>' +
        "</div>" +
        '<div class="_item_8lqsk_7">일반 채팅</div>';
    const welcomeRow = chatLog.firstElementChild;
    const welcome = welcomeRow.firstElementChild;
    const ordinaryChat = welcomeRow.nextElementSibling;

    assert.equal(dom.window.getComputedStyle(welcomeRow).display, "none");
    assert.equal(dom.window.getComputedStyle(welcome).display, "none");
    assert.notEqual(dom.window.getComputedStyle(ordinaryChat).display, "none");

    for (const listener of chrome.testState.storageChangeListeners) {
        listener(
            {
                chatWelcomeMessageRemovalEnabled: { oldValue: true, newValue: false },
            },
            "sync"
        );
    }

    assert.equal(dom.window.document.getElementById("betterchzzk-chat-welcome-message-style"), null);
    assert.notEqual(dom.window.getComputedStyle(welcomeRow).display, "none");
    assert.notEqual(dom.window.getComputedStyle(welcome).display, "none");
});

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

test("cleanbot notice with a hidden original is restored on the initial scan", async (t) => {
    const { dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="cleanbot-initial">',
            '<span class="nickname">viewer</span>',
            '<span class="message">클린봇이 부적절한 표현을 감지했습니다.</span>',
            '<span class="original-text" data-message-original="숨겨진 클린봇 원문" style="display:none">숨겨진 클린봇 원문</span>',
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);
    await waitForCondition(() => dom.window.document.querySelector(".bcct-moderator-trigger"));

    const row = dom.window.document.querySelector('[data-chat-id="cleanbot-initial"]');
    const notice = row.querySelector(".message");
    const reveal = row.querySelector(".bcct-blind-reveal");
    assert.equal(reveal?.textContent, "숨겨진 클린봇 원문");
    assert.equal(notice.getAttribute("data-bcct-blind-masked"), "1");
    assert.equal(reveal?.previousElementSibling, notice);
});

test("ordinary chat mentioning cleanbot is not classified as a blind notice", async (t) => {
    const { dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="cleanbot-mention">',
            '<span class="nickname">viewer</span>',
            '<span class="message">오늘 클린봇 설정을 바꿨나요?</span>',
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);
    await waitForCondition(() => dom.window.document.querySelector(".bcct-moderator-trigger"));

    const row = dom.window.document.querySelector('[data-chat-id="cleanbot-mention"]');
    const parsed = dom.window.BetterChzzk.chatTools.parseChatMessage(row);
    assert.equal(parsed.isBlind, false);
    assert.equal(row.querySelector(".bcct-blind-reveal"), null);
    assert.equal(row.querySelector("[data-bcct-blind-masked]"), null);
});

test("a pinned wrapper cache never leaks one chat original into another blind chat", async (t) => {
    const { dom } = createPageDom("");
    t.after(() => closeChatToolsDom(dom));

    const { wrapper } = installRealChzzkPinnedWrapper(
        dom.window.document,
        [
            '<div class="pinned-entry-shell">',
            '<span class="nickname">첫 시청자</span>',
            '<span class="message">A의 캐시된 원문</span>',
            "</div>",
        ].join("")
    );
    loadChatTools(dom);
    await waitForCondition(() => dom.window.document.querySelector(".bcct-moderator-trigger"));

    wrapper.insertAdjacentHTML(
        "beforeend",
        [
            '<div class="chat-row">',
            '<span class="nickname">둘째 시청자</span>',
            '<span class="message">블라인드 처리된 메시지입니다.</span>',
            "</div>",
        ].join("")
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    const blindRow = wrapper.querySelector(".chat-row");
    const notice = blindRow.querySelector(".message");
    assert.equal(blindRow.querySelector(".bcct-blind-reveal"), null);
    assert.equal(notice.getAttribute("data-bcct-blind-masked"), null);
    assert.doesNotMatch(blindRow.textContent, /A의 캐시된 원문/);
});

test("reusing a chat row for a new message id invalidates the previous original cache", async (t) => {
    const { dom } = createPageDom(
        realChzzkChatRow({ chatId: "reused-a", nickname: "viewer", text: "재사용 전 A 원문" })
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);
    await waitForCondition(() => dom.window.document.querySelector(".bcct-moderator-trigger"));

    const row = dom.window.document.querySelector('[data-chat-id="reused-a"]');
    const notice = row.querySelector("._text_1vemp_1");
    row.setAttribute("data-chat-id", "reused-b");
    notice.textContent = "블라인드 처리된 메시지입니다.";

    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(row.querySelector(".bcct-blind-reveal"), null);
    assert.equal(notice.getAttribute("data-bcct-blind-masked"), null);
    assert.doesNotMatch(row.textContent, /재사용 전 A 원문/);
});

test("id-less moderator rows with identical content keep distinct message identities", async (t) => {
    const repeated = realChzzkChatRow({
        badgeImg: '<img src="https://example.test/manager.png" alt="채팅 운영자">',
        nickname: "같은 운영자",
        text: "반복 안내",
    });
    const { dom } = createPageDom(`${repeated}${repeated}`);
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);
    await waitForCondition(() => moderatorRows(dom.window.document).length === 2);

    assert.deepEqual(
        moderatorRows(dom.window.document).map((row) => row.querySelector(".bcct-moderator-row__text")?.textContent),
        ["반복 안내", "반복 안내"]
    );
});

test("reusing an id-less moderator row with a new virtual index collects the next message", async (t) => {
    const { dom } = createPageDom(
        realChzzkChatRow({
            badgeImg: '<img src="https://example.test/manager.png" alt="채팅 운영자">',
            nickname: "첫 운영자",
            text: "첫 안내",
        })
    );
    t.after(() => closeChatToolsDom(dom));

    const row = dom.window.document.querySelector("._item_sg7hy_7");
    row.setAttribute("data-virtual-index", "1");
    loadChatTools(dom);
    await waitForCondition(() => moderatorRows(dom.window.document).length === 1);

    row.setAttribute("data-virtual-index", "2");
    row.querySelector("._nickname_o04z9_57").textContent = "다음 운영자";
    row.querySelector("._text_1vemp_1").textContent = "다음 안내";

    await waitForCondition(() => moderatorRows(dom.window.document).length === 2);

    assert.deepEqual(
        moderatorRows(dom.window.document).map((item) => item.querySelector(".bcct-moderator-row__text")?.textContent),
        ["첫 안내", "다음 안내"]
    );
});

test("a long-lived mixed reuse state is retracted when the same generation becomes a viewer", async (t) => {
    const originalText = "이미 정상 수집된 운영자 안내";
    const { dom } = createPageDom(
        realChzzkChatRow({
            badgeImg: '<img src="https://example.test/manager.png" alt="채팅 운영자">',
            nickname: "기존 운영자",
            text: originalText,
        })
    );
    t.after(() => closeChatToolsDom(dom));

    const document = dom.window.document;
    const row = document.querySelector("._item_sg7hy_7");
    let scrollCalls = 0;
    row.scrollIntoView = () => {
        scrollCalls += 1;
    };
    row.setAttribute("data-virtual-index", "1");

    loadChatTools(dom);
    await waitForCondition(() => moderatorRows(document).length === 1);

    row.setAttribute("data-virtual-index", "2");
    row.querySelector("._nickname_o04z9_57").textContent = "일반 시청자";

    // 현재 안정화 기준을 넘어 잘못된 전환 항목이 실제로 만들어진 뒤에도
    // 500ms 이상 같은 혼합 상태를 유지한다.
    await waitForCondition(() => moderatorRows(document).length === 2);
    const staleTransitionRow = moderatorRows(document)[1];
    await new Promise((resolve) => setTimeout(resolve, 550));

    row.querySelector('img[alt="채팅 운영자"]')?.remove();
    row.querySelector("._text_1vemp_1").textContent = "일반 시청자의 최종 채팅";

    await waitForCondition(
        () =>
            moderatorRows(document).length === 1 &&
            document.querySelector(".bcct-moderator-trigger__count")?.textContent === "1"
    );

    const collected = moderatorRows(document);
    assert.equal(collected[0].querySelector(".bcct-moderator-row__author")?.textContent, "기존 운영자");
    assert.equal(collected[0].querySelector(".bcct-moderator-row__text")?.textContent, originalText);
    assert.doesNotMatch(document.querySelector(".bcct-moderator-box__list")?.textContent || "", /일반 시청자/);
    assert.doesNotMatch(document.querySelector(".bcct-moderator-box__list")?.textContent || "", /최종 채팅/);
    assert.equal(row.hasAttribute("data-bcct-moderator-collected"), false);

    staleTransitionRow.click();
    collected[0].click();
    assert.equal(scrollCalls, 0);
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

function installRealChzzkPinnedWrapper(document, rows = "") {
    const root = document.querySelector(".chat-list");
    root.className = "chat-list _container_sg7hy_1 _exist_fixed_message_sg7hy_83";
    root.innerHTML = `<div class="_wrapper_sg7hy_25">${rows}</div>`;
    return {
        root,
        wrapper: root.querySelector("._wrapper_sg7hy_25"),
    };
}

test("real chzzk pinned root dynamically collects a manager row without data-chat-id", async (t) => {
    const { dom } = createPageDom("");
    t.after(() => closeChatToolsDom(dom));

    const { root, wrapper } = installRealChzzkPinnedWrapper(dom.window.document);
    loadChatTools(dom);
    await waitForCondition(() => dom.window.document.querySelector(".bcct-moderator-box"));

    wrapper.insertAdjacentHTML(
        "beforeend",
        realChzzkChatRow({
            badgeImg: '<img src="https://example.test/chzzk-role-pinned.png" alt="채팅 운영자" width="18" height="18">',
            nickname: "고정 공지 매니저",
            text: "고정 공지 아래에서 추가된 안내",
        })
    );

    await waitForCondition(() => moderatorRows(dom.window.document).length === 1);

    const sourceRow = wrapper.querySelector("._item_sg7hy_7");
    assert.equal(sourceRow.hasAttribute("data-chat-id"), false);
    assert.equal(sourceRow.getAttribute("data-bcct-moderator-collected"), "1");
    assert.equal(wrapper.hasAttribute("data-bcct-moderator-collected"), false);
    assert.equal(root.hasAttribute("data-bcct-moderator-collected"), false);
    assert.equal(
        moderatorRows(dom.window.document)[0].querySelector(".bcct-moderator-row__text").textContent,
        "고정 공지 아래에서 추가된 안내"
    );
});

test("real chzzk markup: badge img alt collects broadcaster and manager, not viewers", async (t) => {
    const { dom } = createPageDom(
        [
            realChzzkChatRow({ nickname: "일반 시청자", text: "그냥 일반 채팅" }),
            realChzzkChatRow({
                badgeImg: '<img src="https://example.test/chzzk-role-a.png" alt="스트리머" width="18" height="18">',
                nickname: "부지런한 휴먼 989",
                text: "asd",
            }),
            realChzzkChatRow({
                badgeImg: [
                    '<img src="https://example.test/chzzk-role-b.png" alt="방송 매니저" width="18" height="18">',
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
    assert.equal(broadcasterBadges[0].getAttribute("src"), "https://example.test/chzzk-role-a.png");
    assert.equal(broadcasterBadges[0].getAttribute("alt"), "스트리머");
    const managerBadges = rows[1].querySelectorAll(".bcct-moderator-row__badge");
    assert.equal(managerBadges.length, 2);
    assert.equal(managerBadges[0].getAttribute("src"), "https://example.test/chzzk-role-b.png");
    assert.match(managerBadges[1].getAttribute("src"), /subscription\/badge3\.png$/);
    assert.equal(managerBadges[1].getAttribute("alt"), "3개월 구독");
    // 닉네임 색상도 본 채팅창과 동일하게 복원된다.
    const broadcasterAuthor = rows[0].querySelector(".bcct-moderator-row__author");
    assert.equal(broadcasterAuthor.textContent, "부지런한 휴먼 989");
    assert.equal(broadcasterAuthor.style.color, "rgb(217, 176, 79)");
});

test("real chzzk markup: the renamed 채팅 운영자 badge is collected as manager", async (t) => {
    // 치지직이 매니저 칭호를 "채팅 운영자"로 바꾼 마크업. 아이콘 URL 이 함께
    // 바뀌어도 alt 텍스트만으로 감지되어야 한다.
    const { dom } = createPageDom(
        [
            realChzzkChatRow({ nickname: "일반 시청자", text: "그냥 일반 채팅" }),
            realChzzkChatRow({
                badgeImg: '<img src="https://example.test/chzzk-role-c.png" alt="채팅 운영자" width="18" height="18">',
                nickname: "부지런한 봇지기",
                text: "운영자 공지입니다",
                chatId: "chat-operator-rename-1",
            }),
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);

    await waitForCondition(() => moderatorRows(dom.window.document).length === 1);

    openModeratorPanel(dom.window.document);
    const row = moderatorRows(dom.window.document)[0];
    assert.match(row.textContent, /운영자 공지입니다/);
    assert.doesNotMatch(row.textContent, /그냥 일반 채팅/);
    assert.equal(row.querySelector(".bcct-moderator-row__author").textContent, "부지런한 봇지기");
    const badge = row.querySelector(".bcct-moderator-row__badge");
    assert.equal(badge.getAttribute("alt"), "채팅 운영자");
    assert.equal(badge.getAttribute("src"), "https://example.test/chzzk-role-c.png");
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
            '<img src="https://example.test/chzzk-role-d.png" alt="스트리머" width="18" height="18">',
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

test("moderator trigger moves to a native chat header that mounts later", async (t) => {
    const { dom } = createPageDom("");
    t.after(() => closeChatToolsDom(dom));

    const document = dom.window.document;
    const panelRoot = document.querySelector("aside.live_chatting_area");
    document.querySelector(".chat-header").remove();

    loadChatTools(dom);
    await waitForCondition(() => document.querySelector(".bcct-moderator-trigger"));
    assert.equal(document.querySelector(".bcct-moderator-trigger").parentElement, panelRoot);

    panelRoot.insertAdjacentHTML(
        "afterbegin",
        [
            '<div class="chat-header">',
            "<strong>채팅</strong>",
            '<button class="chat-more" type="button" aria-label="더보기">⋮</button>',
            "</div>",
        ].join("")
    );
    document
        .querySelector(".chat-list")
        .insertAdjacentHTML("beforeend", '<div class="chat-row"><span class="message">새 채팅</span></div>');

    const mountedHeader = document.querySelector(".chat-header");
    await waitForCondition(() => mountedHeader.querySelector(".bcct-moderator-trigger"));

    const trigger = mountedHeader.querySelector(".bcct-moderator-trigger");
    const menuButton = mountedHeader.querySelector(".chat-more");
    assert.equal(trigger.nextElementSibling, menuButton);
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

test("panel toggles do not create a mutation feedback loop on the broad chat root", async (t) => {
    const { dom } = createPageDom("");
    t.after(() => closeChatToolsDom(dom));

    const chatList = dom.window.document.querySelector(".chat-list");
    chatList.removeAttribute("role");
    chatList.className = "_container_sg7hy_1";

    loadChatTools(dom);
    await waitForCondition(() => dom.window.document.querySelector(".bcct-moderator-trigger"));
    await new Promise((resolve) => setTimeout(resolve, 300));

    const trigger = dom.window.document.querySelector(".bcct-moderator-trigger");
    const originalGetAttribute = trigger.getAttribute.bind(trigger);
    let moderatorStateReads = 0;
    trigger.getAttribute = (name) => {
        if (name === "aria-expanded" || name === "aria-label") moderatorStateReads += 1;
        return originalGetAttribute(name);
    };

    trigger.click();
    await new Promise((resolve) => setTimeout(resolve, 700));

    assert.equal(moderatorStateReads, 2);
});

test("a capped batch of moderator messages renders the final list once", async (t) => {
    const initialRows = Array.from({ length: 20 }, (_, index) =>
        realChzzkChatRow({
            badgeImg: '<img src="https://example.test/manager.png" alt="채팅 운영자">',
            nickname: `manager-${index}`,
            text: `기존 운영자 안내 ${index}`,
            chatId: `manager-existing-${index}`,
        })
    ).join("");
    const { dom } = createPageDom(initialRows, {
        chatToolsShowBlindEnabled: false,
        chatToolsMaxModeratorMessages: 20,
    });
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);
    await waitForCondition(() => moderatorRows(dom.window.document).length === 20);

    const list = dom.window.document.querySelector(".bcct-moderator-box__list");
    const originalAppendChild = list.appendChild.bind(list);
    let appendedRows = 0;
    list.appendChild = (node) => {
        if (node.classList?.contains("bcct-moderator-row")) appendedRows += 1;
        return originalAppendChild(node);
    };

    const addedRows = Array.from({ length: 10 }, (_, index) =>
        realChzzkChatRow({
            badgeImg: '<img src="https://example.test/manager.png" alt="채팅 운영자">',
            nickname: `new-manager-${index}`,
            text: `새 운영자 안내 ${index}`,
            chatId: `manager-added-batch-${index}`,
        })
    ).join("");
    dom.window.document.querySelector(".chat-list").insertAdjacentHTML("beforeend", addedRows);

    await waitForCondition(() =>
        moderatorRows(dom.window.document).some(
            (row) => row.querySelector(".bcct-moderator-row__text")?.textContent === "새 운영자 안내 9"
        )
    );

    assert.equal(moderatorRows(dom.window.document).length, 20);
    assert.ok(appendedRows <= 20, `expected one final render, got ${appendedRows} row appends`);
    assert.deepEqual(
        moderatorRows(dom.window.document).map((row) => row.querySelector(".bcct-moderator-row__text")?.textContent),
        [
            ...Array.from({ length: 10 }, (_, index) => `기존 운영자 안내 ${index + 10}`),
            ...Array.from({ length: 10 }, (_, index) => `새 운영자 안내 ${index}`),
        ]
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

test("feature init removes the legacy moderator cache key from storage.local", async (t) => {
    // 제거된 「방송 중 모아보기 유지」 옵션이 storage.local 에 남긴 잔존 캐시가
    // 기능 초기화 시 한 번 지워져야 한다.
    const { chrome, dom } = createPageDom("", undefined, {
        [MODERATOR_CACHE_STORAGE_KEY]: { version: 1, entries: { "live:test-channel": { messages: [] } } },
        keepThisKey: 1,
    });
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);

    await waitForCondition(() => !Object.hasOwn(chrome.testState.local, MODERATOR_CACHE_STORAGE_KEY));
    // 다른 키는 건드리지 않는다.
    assert.equal(chrome.testState.local.keepThisKey, 1);
});

test("chat tools toggle independently and stop the runtime when both are disabled", async (t) => {
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
        listener({ chatToolsShowBlindEnabled: { oldValue: true, newValue: false } }, "sync");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.ok(dom.window.document.querySelector(".bcct-moderator-box"));
    assert.equal(dom.window.document.querySelector(".bcct-blind-reveal"), null);

    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ chatToolsModeratorBoxEnabled: { oldValue: true, newValue: false } }, "sync");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(dom.window.document.querySelector(".bcct-moderator-box"), null);
    assert.equal(dom.window.document.querySelector(".bcct-moderator-trigger"), null);
    assert.equal(dom.window.document.querySelector("[data-bcct-moderator-actions]"), null);
    assert.equal(dom.window.document.querySelector(".chat-more").parentElement.className, "chat-header");

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

test("moderator collection reconnects after a pinned chat root is wholly replaced", async (t) => {
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
    newList.className = "chat-list _container_sg7hy_1 _exist_fixed_message_sg7hy_83";
    newList.setAttribute("role", "log");
    newList.innerHTML = '<div class="_wrapper_sg7hy_25"></div>';
    area.appendChild(newList);

    // 새 pinned root의 wrapper에 data-chat-id 없는 실제 매니저 행이 도착한다.
    const wrapper = newList.querySelector("._wrapper_sg7hy_25");
    wrapper.insertAdjacentHTML(
        "beforeend",
        realChzzkChatRow({
            badgeImg:
                '<img src="https://example.test/chzzk-role-reconnect.png" alt="채팅 운영자" width="18" height="18">',
            nickname: "교체 후 매니저",
            text: "교체 후 실제 수집",
        })
    );

    // 재연결 감시가 분리를 감지해 새 root로 옮겨 타고 full-scan이 돌아
    // 트리거가 다시 붙고 새 매니저 메시지가 실제로 수집되어야 한다.
    await waitForCondition(
        () => document.querySelector(".bcct-moderator-trigger") && moderatorRows(document).length === 1
    );

    const trigger = document.querySelector(".bcct-moderator-trigger");
    assert.equal(trigger.tagName, "BUTTON");
    const sourceRow = wrapper.querySelector("._item_sg7hy_7");
    const collectedSource = wrapper.querySelector("[data-bcct-moderator-collected]");
    assert.equal(sourceRow.hasAttribute("data-chat-id"), false);
    assert.ok(collectedSource);
    assert.ok(sourceRow.contains(collectedSource));
    assert.equal(wrapper.hasAttribute("data-bcct-moderator-collected"), false);
    assert.equal(newList.hasAttribute("data-bcct-moderator-collected"), false);
    const collected = moderatorRows(document)[0];
    assert.equal(collected.querySelector(".bcct-moderator-row__author").textContent, "교체 후 매니저");
    assert.equal(collected.querySelector(".bcct-moderator-row__text").textContent, "교체 후 실제 수집");
});
