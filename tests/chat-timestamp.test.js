const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repoRoot = path.join(__dirname, "..");
const REACT_PROPS_KEY = "__reactProps$betterChzzkTest";
const SOURCE_REQUEST_EVENT = "betterchzzk:chat-timestamp-source-request";

function readRepoFile(...parts) {
    return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

function serverTime(hours, minutes, seconds = 0) {
    return new Date(2026, 6, 10, hours, minutes, seconds).getTime();
}

function realChatRow({ chatId = "", nickname = "시청자", text = "채팅", reuseSignal = "" } = {}) {
    const chatIdAttr = chatId ? ` data-chat-id="${chatId}"` : "";
    const reuseAttr = reuseSignal ? ` data-virtual-index="${reuseSignal}"` : "";
    return [
        `<div class="_item_sg7hy_7"${chatIdAttr}${reuseAttr}>`,
        '<div class="_container_1vemp_1">',
        '<div class="_chatting_message_1vemp_21">',
        '<button type="button" class="_nickname_1vemp_37" aria-haspopup="true" aria-expanded="false">',
        `<span class="_nickname_o04z9_57">${nickname}</span>`,
        "</button>",
        `<span class="_text_1vemp_1">${text}</span>`,
        "</div>",
        "</div>",
        "</div>",
    ].join("");
}

function makeReactProps(messageTime, messageChangeHandler) {
    return {
        children: {
            props: {
                chatMessage: { time: messageTime },
                messageChangeHandler,
            },
        },
    };
}

function attachReactMessage(row, messageTime, { key = REACT_PROPS_KEY, messageChangeHandler } = {}) {
    Object.defineProperty(row, key, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: makeReactProps(messageTime, messageChangeHandler),
    });
}

function replaceReactMessage(row, messageTime, messageChangeHandler) {
    row[REACT_PROPS_KEY] = makeReactProps(messageTime, messageChangeHandler);
}

function createFakeChrome(initialSync = {}) {
    const syncData = { ...initialSync };
    const changeListeners = [];
    const createArea = (data = {}) => ({
        get(keys, callback) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                if (Object.hasOwn(data, key)) result[key] = data[key];
            }
            callback(result);
        },
        set(values, callback) {
            Object.assign(data, values || {});
            callback?.();
        },
        remove(keys, callback) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
            callback?.();
        },
    });
    return {
        runtime: {},
        storage: {
            local: createArea(),
            sync: createArea(syncData),
            onChanged: {
                addListener(listener) {
                    changeListeners.push(listener);
                },
                removeListener(listener) {
                    const index = changeListeners.indexOf(listener);
                    if (index >= 0) changeListeners.splice(index, 1);
                },
            },
        },
        testState: {
            setSync(values) {
                const changes = {};
                for (const [key, newValue] of Object.entries(values || {})) {
                    changes[key] = { oldValue: syncData[key], newValue };
                    syncData[key] = newValue;
                }
                for (const listener of [...changeListeners]) listener(changes, "sync");
            },
        },
    };
}

function createPageDom(
    rows = [],
    { url = "https://chzzk.naver.com/live/test-channel", sync = { chatTimestampEnabled: true } } = {}
) {
    const dom = new JSDOM(
        [
            "<!doctype html>",
            "<body>",
            '<aside id="aside-chatting">',
            '<div class="_container_sg7hy_1" role="log">',
            '<div class="_wrapper_sg7hy_25">',
            rows.map(realChatRow).join(""),
            "</div>",
            "</div>",
            "</aside>",
            "</body>",
        ].join(""),
        { url, runScripts: "outside-only", pretendToBeVisual: true }
    );
    dom.window.chrome = createFakeChrome(sync);

    const renderedRows = dom.window.document.querySelectorAll("._item_sg7hy_7");
    rows.forEach((rowOptions, index) => {
        if (!Object.hasOwn(rowOptions, "messageTime")) return;
        const row = renderedRows[index];
        attachReactMessage(row, rowOptions.messageTime, {
            messageChangeHandler: rowOptions.messageChangeHandler,
        });
    });
    return dom;
}

function createChatRow(dom, options) {
    const template = dom.window.document.createElement("template");
    template.innerHTML = realChatRow(options);
    const row = template.content.firstElementChild;
    if (Object.hasOwn(options, "messageTime")) {
        attachReactMessage(row, options.messageTime, { messageChangeHandler: options.messageChangeHandler });
    }
    return row;
}

function installMutableClock(dom, initialDate = new Date(2026, 6, 10, 20, 0, 0)) {
    const NativeDate = dom.window.Date;
    let currentTime = initialDate.getTime();

    class MutableDate extends NativeDate {
        constructor(...args) {
            super(...(args.length ? args : [currentTime]));
        }

        static now() {
            return currentTime;
        }
    }

    dom.window.Date = MutableDate;
    return {
        set(hours, minutes, seconds = 0) {
            currentTime = new NativeDate(2026, 6, 10, hours, minutes, seconds).getTime();
        },
    };
}

function evalRepoScript(dom, ...parts) {
    dom.window.eval(readRepoFile(...parts));
}

function loadChatTimestamp(dom) {
    evalRepoScript(dom, "features", "chatTimestampPage.js");
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "chatTimestamp.js");
}

function loadChatTimestampIsolatedFirst(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "chatTimestamp.js");
}

function closePageDom(dom) {
    dom.window.BetterChzzk?.chatTimestamp?.teardownRuntime?.();
    dom.window.close();
}

function waitForCondition(predicate, { timeoutMs = 1600, intervalMs = 20 } = {}) {
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

test("existing server-loaded chats use their original time and timestamp CSS has no brackets", () => {
    const messageTime = serverTime(17, 52, 30);
    const dom = createPageDom([{ chatId: "first", nickname: "시청자", text: "안녕하세요", messageTime }]);
    installMutableClock(dom);
    loadChatTimestamp(dom);

    const message = dom.window.document.querySelector("._chatting_message_1vemp_21");
    assert.equal(message.getAttribute("data-bcmt-source-time"), String(messageTime));
    assert.equal(message.getAttribute("data-bcmt-time"), "17:52");
    assert.equal(message.textContent, "시청자안녕하세요");
    assert.equal(message.firstElementChild.tagName, "BUTTON");

    const style = dom.window.document.getElementById("betterchzzk-chat-timestamp-style");
    assert.match(style.textContent, /content:\s*attr\(data-bcmt-time\)/);
    assert.doesNotMatch(style.textContent, /content:[^;]*\[/);
    assert.match(style.textContent, /--Content-Neutral-Cool-Base, #9da5b6/);
    assert.match(style.textContent, /font-size:\s*inherit/);
    assert.doesNotMatch(style.textContent, /font-size:\s*11px/);
    closePageDom(dom);
});

test("initial backlog, prepended history, and live appends keep distinct server times", async () => {
    const dom = createPageDom([
        { chatId: "server-a", text: "서버 채팅 A", messageTime: serverTime(17, 50) },
        { chatId: "server-b", text: "서버 채팅 B", messageTime: serverTime(17, 51) },
    ]);
    installMutableClock(dom);
    loadChatTimestamp(dom);

    const wrapper = dom.window.document.querySelector("._wrapper_sg7hy_25");
    assert.equal(wrapper.querySelector('[data-chat-id="server-a"] [data-bcmt-time]')?.dataset.bcmtTime, "17:50");
    assert.equal(wrapper.querySelector('[data-chat-id="server-b"] [data-bcmt-time]')?.dataset.bcmtTime, "17:51");

    wrapper.prepend(createChatRow(dom, { chatId: "history", text: "과거 채팅", messageTime: serverTime(17, 40) }));
    wrapper.append(createChatRow(dom, { chatId: "live", text: "실시간 채팅", messageTime: serverTime(17, 53) }));

    await waitForCondition(
        () => wrapper.querySelector('[data-chat-id="history"] [data-bcmt-time]')?.dataset.bcmtTime === "17:40"
    );
    assert.equal(wrapper.querySelector('[data-chat-id="live"] [data-bcmt-time]')?.dataset.bcmtTime, "17:53");
    assert.equal(wrapper.querySelectorAll("[data-bcmt-time]").length, 4);
    closePageDom(dom);
});

test("a new row issues one source request instead of rescanning the existing backlog", async () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
        chatId: `backlog-${index}`,
        text: `기존 채팅 ${index}`,
        messageTime: serverTime(17, index),
    }));
    const dom = createPageDom(rows);
    installMutableClock(dom);
    let requestCount = 0;
    dom.window.document.addEventListener(
        SOURCE_REQUEST_EVENT,
        () => {
            requestCount += 1;
        },
        true
    );
    loadChatTimestamp(dom);
    assert.equal(requestCount, rows.length);

    requestCount = 0;
    const wrapper = dom.window.document.querySelector("._wrapper_sg7hy_25");
    wrapper.append(createChatRow(dom, { chatId: "only-new", text: "새 채팅", messageTime: serverTime(17, 55) }));
    await waitForCondition(
        () => wrapper.querySelector('[data-chat-id="only-new"] [data-bcmt-time]')?.dataset.bcmtTime === "17:55"
    );
    assert.equal(requestCount, 1);
    closePageDom(dom);
});

test("the page-ready handshake recovers backlog when isolated world loads first", async () => {
    const dom = createPageDom([
        { chatId: "isolated-first", text: "먼저 스캔된 채팅", messageTime: serverTime(17, 58) },
    ]);
    installMutableClock(dom);
    loadChatTimestampIsolatedFirst(dom);

    const message = dom.window.document.querySelector("._chatting_message_1vemp_21");
    assert.equal(message.hasAttribute("data-bcmt-time"), false);

    evalRepoScript(dom, "features", "chatTimestampPage.js");
    await waitForCondition(() => message.getAttribute("data-bcmt-time") === "17:58");
    closePageDom(dom);
});

test("id-less duplicate rows retain their own server times", () => {
    const dom = createPageDom([
        { nickname: "같은 시청자", text: "같은 내용", messageTime: serverTime(18, 8) },
        { nickname: "같은 시청자", text: "같은 내용", messageTime: serverTime(18, 9) },
    ]);
    installMutableClock(dom);
    loadChatTimestamp(dom);

    assert.deepEqual(
        Array.from(dom.window.document.querySelectorAll("[data-bcmt-time]"), (message) => message.dataset.bcmtTime),
        ["18:08", "18:09"]
    );
    closePageDom(dom);
});

test("missing, string, seconds, and implausible future source times never fall back to current time", () => {
    const milliseconds = serverTime(17, 52);
    const dom = createPageDom([
        { chatId: "missing", text: "props 없음" },
        { chatId: "string", text: "문자열", messageTime: String(milliseconds) },
        { chatId: "seconds", text: "초 단위", messageTime: Math.floor(milliseconds / 1000) },
        { chatId: "nan", text: "NaN", messageTime: NaN },
        { chatId: "future", text: "미래", messageTime: serverTime(20, 10) },
    ]);
    installMutableClock(dom);
    loadChatTimestamp(dom);

    assert.equal(dom.window.document.querySelectorAll("[data-bcmt-source-time]").length, 0);
    assert.equal(dom.window.document.querySelectorAll("[data-bcmt-time]").length, 0);
    assert.equal(dom.window.document.querySelector('[data-bcmt-time="20:00"]'), null);
    closePageDom(dom);
});

test("the MAIN bridge reads outer React props and never invokes page callbacks", () => {
    let callbackCalls = 0;
    const validTime = serverTime(17, 54);
    const dom = createPageDom([{ chatId: "bridge", text: "브리지" }]);
    installMutableClock(dom);
    const row = dom.window.document.querySelector('[data-chat-id="bridge"]');
    attachReactMessage(row, "invalid", { key: "__reactProps$old" });
    attachReactMessage(row, validTime, {
        key: "__reactProps$current",
        messageChangeHandler: () => {
            callbackCalls += 1;
        },
    });
    evalRepoScript(dom, "features", "chatTimestampPage.js");

    const message = row.querySelector("._chatting_message_1vemp_21");
    message.dispatchEvent(new dom.window.Event(SOURCE_REQUEST_EVENT, { bubbles: true }));
    assert.equal(message.getAttribute("data-bcmt-source-time"), String(validTime));
    assert.equal(callbackCalls, 0);

    const outside = createChatRow(dom, { chatId: "outside", messageTime: serverTime(17, 55) });
    dom.window.document.body.append(outside);
    outside
        .querySelector("._chatting_message_1vemp_21")
        .dispatchEvent(new dom.window.Event(SOURCE_REQUEST_EVENT, { bubbles: true }));
    assert.equal(outside.querySelector("[data-bcmt-source-time]"), null);
    dom.window.close();
});

test("virtual row reuse replaces the timestamp and invalid replacement data clears stale markers", async () => {
    const dom = createPageDom([
        { chatId: "message-a", reuseSignal: "1", text: "첫 채팅", messageTime: serverTime(17, 52) },
    ]);
    installMutableClock(dom);
    loadChatTimestamp(dom);

    const row = dom.window.document.querySelector("._item_sg7hy_7");
    const message = row.querySelector("._chatting_message_1vemp_21");
    replaceReactMessage(row, serverTime(17, 56));
    row.setAttribute("data-chat-id", "message-b");
    row.setAttribute("data-virtual-index", "2");
    row.querySelector("._text_1vemp_1").textContent = "다음 채팅";

    await waitForCondition(() => message.getAttribute("data-bcmt-time") === "17:56");
    assert.equal(message.getAttribute("data-bcmt-source-time"), String(serverTime(17, 56)));

    replaceReactMessage(row, "invalid");
    row.querySelector("._text_1vemp_1").textContent = "잘못된 시각";
    await waitForCondition(() => !message.hasAttribute("data-bcmt-time"));
    assert.equal(message.hasAttribute("data-bcmt-source-time"), false);
    closePageDom(dom);
});

test("a later observable row update retries after React props become available", async () => {
    const dom = createPageDom([{ chatId: "late-props", text: "props 준비 전" }]);
    installMutableClock(dom);
    loadChatTimestamp(dom);

    const row = dom.window.document.querySelector('[data-chat-id="late-props"]');
    const message = row.querySelector("._chatting_message_1vemp_21");
    assert.equal(message.hasAttribute("data-bcmt-time"), false);

    attachReactMessage(row, serverTime(18, 10));
    row.querySelector("._text_1vemp_1").textContent = "props 준비 후";
    await waitForCondition(() => message.getAttribute("data-bcmt-time") === "18:10");
    closePageDom(dom);
});

test("blind-message transitions and nickname remounts preserve the same server time without callbacks", async () => {
    let callbackCalls = 0;
    const messageTime = serverTime(17, 57);
    const dom = createPageDom([
        {
            chatId: "blind",
            nickname: "시청자",
            text: "원래 채팅",
            messageTime,
            messageChangeHandler: () => {
                callbackCalls += 1;
            },
        },
    ]);
    installMutableClock(dom);
    loadChatTimestamp(dom);

    const message = dom.window.document.querySelector("._chatting_message_1vemp_21");
    message.querySelector("._text_1vemp_1").textContent = "클린봇이 부적절한 표현을 감지했습니다.";
    const oldButton = message.querySelector("button");
    oldButton.replaceWith(oldButton.cloneNode(true));
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(message.getAttribute("data-bcmt-time"), "17:57");
    assert.equal(callbackCalls, 0);
    closePageDom(dom);
});

test("chat root replacement immediately restores server-loaded times", async () => {
    const dom = createPageDom([{ chatId: "before", text: "교체 전", messageTime: serverTime(17, 50) }]);
    installMutableClock(dom);
    loadChatTimestamp(dom);

    const document = dom.window.document;
    const newAside = document.createElement("aside");
    newAside.id = "aside-chatting";
    newAside.innerHTML = '<div role="log"><div class="replacement-wrapper"></div></div>';
    const replacementWrapper = newAside.querySelector(".replacement-wrapper");
    replacementWrapper.append(createChatRow(dom, { chatId: "after", text: "교체 후", messageTime: serverTime(18, 1) }));
    document.querySelector("#aside-chatting").replaceWith(newAside);

    await waitForCondition(
        () => document.querySelector('[data-chat-id="after"] [data-bcmt-time]')?.dataset.bcmtTime === "18:01"
    );
    replacementWrapper.append(
        createChatRow(dom, { chatId: "after-live", text: "교체 후 실시간", messageTime: serverTime(18, 2) })
    );
    await waitForCondition(
        () => document.querySelector('[data-chat-id="after-live"] [data-bcmt-time]')?.dataset.bcmtTime === "18:02"
    );
    closePageDom(dom);
});

test("SPA route changes clear markers outside live and restore original times on return", async () => {
    const dom = createPageDom([{ chatId: "route", text: "라우트 채팅", messageTime: serverTime(18, 3) }]);
    installMutableClock(dom);
    loadChatTimestamp(dom);

    const message = dom.window.document.querySelector("._chatting_message_1vemp_21");
    assert.equal(message.getAttribute("data-bcmt-time"), "18:03");

    dom.window.history.pushState({}, "", "/video/1234");
    dom.window.dispatchEvent(new dom.window.CustomEvent("betterchzzk:routechange", { detail: { source: "test" } }));
    await waitForCondition(() => !message.hasAttribute("data-bcmt-time"));
    assert.equal(message.hasAttribute("data-bcmt-source-time"), false);

    dom.window.history.pushState({}, "", "/live/test-channel");
    dom.window.dispatchEvent(new dom.window.CustomEvent("betterchzzk:routechange", { detail: { source: "test" } }));
    await waitForCondition(() => message.getAttribute("data-bcmt-time") === "18:03");
    closePageDom(dom);
});

test("the independent default-off option stamps existing server rows when enabled and clears immediately", async () => {
    const dom = createPageDom([{ chatId: "before-enable", text: "켜기 전", messageTime: serverTime(18, 4) }], {
        sync: {},
    });
    installMutableClock(dom);
    loadChatTimestamp(dom);

    const document = dom.window.document;
    const wrapper = document.querySelector("._wrapper_sg7hy_25");
    assert.equal(dom.window.BetterChzzkSettings.DEFAULT_OPTIONS.chatTimestampEnabled, false);
    assert.equal(dom.window.BetterChzzkSettings.FEATURE_KEYS.includes("chatTimestampEnabled"), true);
    assert.equal(document.getElementById("betterchzzk-chat-timestamp-style"), null);
    assert.equal(wrapper.querySelector("[data-bcmt-time]"), null);

    dom.window.chrome.testState.setSync({ chatTimestampEnabled: true });
    assert.equal(wrapper.querySelector('[data-chat-id="before-enable"] [data-bcmt-time]')?.dataset.bcmtTime, "18:04");
    assert.ok(document.getElementById("betterchzzk-chat-timestamp-style"));

    dom.window.chrome.testState.setSync({ chatTimestampEnabled: false });
    assert.equal(wrapper.querySelector("[data-bcmt-time], [data-bcmt-source-time]"), null);
    assert.equal(document.getElementById("betterchzzk-chat-timestamp-style"), null);
    wrapper.append(createChatRow(dom, { chatId: "while-off", text: "꺼진 동안", messageTime: serverTime(18, 5) }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(wrapper.querySelector('[data-chat-id="while-off"] [data-bcmt-time]'), null);

    dom.window.chrome.testState.setSync({ chatTimestampEnabled: true });
    assert.equal(wrapper.querySelector('[data-chat-id="before-enable"] [data-bcmt-time]')?.dataset.bcmtTime, "18:04");
    assert.equal(wrapper.querySelector('[data-chat-id="while-off"] [data-bcmt-time]')?.dataset.bcmtTime, "18:05");

    const optionsHtml = readRepoFile("options.html");
    assert.match(optionsHtml, /data-option="chatTimestampEnabled"/);
    assert.match(optionsHtml, /타임스탬프 표시/);
    closePageDom(dom);
});

test("system controls and non-live chat logs are not timestamped", () => {
    const liveDom = createPageDom([
        { chatId: "live-message", text: "일반 라이브 채팅", messageTime: serverTime(18, 6) },
    ]);
    installMutableClock(liveDom);
    const fixed = liveDom.window.document.createElement("div");
    fixed.className = "_fixed_message_abcd_1";
    fixed.innerHTML = '<button type="button" aria-haspopup="true">더보기 메뉴</button>';
    liveDom.window.document.querySelector("[role='log']").prepend(fixed);
    loadChatTimestamp(liveDom);

    assert.equal(fixed.querySelector("[data-bcmt-time], [data-bcmt-source-time]"), null);
    assert.equal(
        liveDom.window.document.querySelector('[data-chat-id="live-message"] [data-bcmt-time]')?.dataset.bcmtTime,
        "18:06"
    );
    closePageDom(liveDom);

    const vodDom = createPageDom([{ chatId: "vod", text: "다시보기 채팅", messageTime: serverTime(18, 6) }], {
        url: "https://chzzk.naver.com/video/1234",
    });
    installMutableClock(vodDom);
    loadChatTimestamp(vodDom);

    assert.equal(vodDom.window.document.querySelectorAll("[data-bcmt-time]").length, 0);
    assert.equal(vodDom.window.document.querySelectorAll("[data-bcmt-source-time]").length, 0);
    closePageDom(vodDom);
});

test("timestamp metadata does not change chatTools author or message parsing", () => {
    const dom = createPageDom([
        { chatId: "parse", nickname: "파싱 시청자", text: "파싱 본문", messageTime: serverTime(18, 7) },
    ]);
    installMutableClock(dom);
    evalRepoScript(dom, "features", "chatTimestampPage.js");
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "chatTools.js");
    evalRepoScript(dom, "features", "chatTimestamp.js");

    const row = dom.window.document.querySelector("._item_sg7hy_7");
    const parsed = dom.window.BetterChzzk.chatTools.parseChatMessage(row);
    assert.equal(row.querySelector("[data-bcmt-time]")?.dataset.bcmtTime, "18:07");
    assert.equal(parsed.author, "파싱 시청자");
    assert.equal(parsed.text, "파싱 본문");
    closePageDom(dom);
});

test("manifest loads the timestamp bridge in MAIN world and the UI feature in isolated world", () => {
    const manifest = JSON.parse(readRepoFile("manifest.json"));
    const mainEntryIndex = manifest.content_scripts.findIndex((entry) => entry.world === "MAIN");
    const isolatedEntryIndex = manifest.content_scripts.findIndex((entry) => !entry.world);
    const mainEntry = manifest.content_scripts[mainEntryIndex];
    const isolatedEntry = manifest.content_scripts[isolatedEntryIndex];
    const mainScripts = mainEntry?.js || [];
    const isolatedScripts = isolatedEntry?.js || [];
    const routeBridgeIndex = mainScripts.indexOf("features/routeBridgePage.js");
    const pageTimestampIndex = mainScripts.indexOf("features/chatTimestampPage.js");
    const autoQualityIndex = mainScripts.indexOf("features/autoQualityPage.js");
    const chatToolsIndex = isolatedScripts.indexOf("features/chatTools.js");
    const timestampIndex = isolatedScripts.indexOf("features/chatTimestamp.js");
    const videoSearchIndex = isolatedScripts.indexOf("features/videoSearch.js");

    assert.ok(mainEntryIndex >= 0 && mainEntryIndex < isolatedEntryIndex);
    assert.equal(mainEntry.run_at, "document_start");
    assert.equal(isolatedEntry.run_at, "document_start");
    assert.ok(routeBridgeIndex >= 0);
    assert.ok(pageTimestampIndex > routeBridgeIndex);
    assert.ok(autoQualityIndex > pageTimestampIndex);
    assert.ok(timestampIndex > chatToolsIndex);
    assert.ok(videoSearchIndex > timestampIndex);
    assert.equal(
        manifest.web_accessible_resources.some((entry) => entry.resources?.includes("features/chatTimestampPage.js")),
        false
    );
    assert.match(readRepoFile("THIRD_PARTY_NOTICES.md"), /chatTimestampPage\.js/);
});
