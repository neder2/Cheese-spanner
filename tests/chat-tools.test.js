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

test("blind message with hidden original text gets a reveal area", async (t) => {
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
    assert.match(reveal.textContent, /숨겨진 원문입니다/);
    assert.equal(reveal.dataset.empty, "0");
});

test("blind message without client-side original text shows only a placeholder", async (t) => {
    const { dom } = createPageDom(
        [
            '<div class="chat-row" data-chat-id="blind-2">',
            '<span class="nickname">viewer</span>',
            '<span class="message">블라인드 처리된 메시지입니다.</span>',
            "</div>",
        ].join("")
    );
    t.after(() => closeChatToolsDom(dom));

    loadChatTools(dom);

    await waitForCondition(() => dom.window.document.querySelector(".bcct-blind-reveal"));

    const reveal = dom.window.document.querySelector(".bcct-blind-reveal");
    assert.match(reveal.textContent, /\[블라인드 메시지: 원문 없음\]/);
    assert.equal(reveal.dataset.empty, "1");
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
