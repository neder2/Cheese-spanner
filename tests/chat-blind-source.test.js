const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

// 2026-10-30 치지직 웹 번들 기준: 채팅 메시지 객체는 status(NORMAL·BLIND·CBOTBLIND·HIDDEN 등)와
// 서버 원문 originalContent를 가지며, 사후 블라인드는 {...message, status}로 원문을 유지한다.
const repoRoot = path.join(__dirname, "..");
const REACT_PROPS_KEY = "__reactProps$cheeseSpannerTest";
const REACT_FIBER_KEY = "__reactFiber$cheeseSpannerTest";
const BLIND_NOTICE = "메시지가 블라인드 처리되었습니다.";
const CLEANBOT_NOTICE = "클린봇이 부적절한 표현을 감지했습니다.";

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
        remove(_keys, callback) {
            setTimeout(() => callback?.(), 0);
        },
    };
}

function createFakeChrome(sync) {
    const listeners = [];
    return {
        runtime: {},
        storage: {
            sync: createStorageArea(sync),
            local: createStorageArea(),
            onChanged: {
                addListener(listener) {
                    listeners.push(listener);
                },
                removeListener(listener) {
                    const index = listeners.indexOf(listener);
                    if (index >= 0) listeners.splice(index, 1);
                },
            },
        },
        listeners,
    };
}

function chatRow({ id, nickname = "viewer", text }) {
    return [
        `<div class="_item_sg7hy_7" data-test-row="${id}">`,
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

function createPageDom(rows, { sync = {} } = {}) {
    const dom = new JSDOM(
        [
            "<!doctype html><body>",
            '<aside id="aside-chatting" class="live_chatting_area">',
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
    const chrome = createFakeChrome({ chatToolsShowBlindEnabled: true, ...sync });
    dom.window.chrome = chrome;
    dom.window.fetch = async () => {
        throw new Error("blind source must not fetch messages");
    };
    return { dom, chrome };
}

function attachMessage(dom, id, chatMessage, { selector = "._container_1vemp_1" } = {}) {
    const element = rowOf(dom, id).querySelector(selector) || rowOf(dom, id);
    element[REACT_PROPS_KEY] = { children: { props: { chatMessage } } };
    return element[REACT_PROPS_KEY].children.props;
}

function attachLiveChatClient(dom, messageList) {
    const gameChatClient = { config: { streamingChannelId: "test-channel" }, messageList };
    dom.window.document.querySelector("[role='log']")[REACT_FIBER_KEY] = {
        return: { memoizedProps: { gameChatClient } },
    };
    return gameChatClient;
}

function requestBlindSource(dom, id) {
    const container = rowOf(dom, id).querySelector("._chatting_message_1vemp_21");
    container.dispatchEvent(
        new dom.window.CustomEvent("cheese-spanner:chat-blind-source-request", {
            bubbles: true,
            detail: JSON.stringify(["viewer", container.querySelector("._text_1vemp_1").textContent]),
        })
    );
    const response = {
        message: JSON.parse(container.getAttribute("data-bcct-source-message")),
        original: container.getAttribute("data-bcct-source-original"),
    };
    container.removeAttribute("data-bcct-source-message");
    container.removeAttribute("data-bcct-source-original");
    return response;
}

function rowOf(dom, id) {
    return dom.window.document.querySelector(`[data-test-row="${id}"]`);
}

function evalRepoScript(dom, ...parts) {
    dom.window.eval(readRepoFile(...parts));
}

function loadPageBridge(dom) {
    evalRepoScript(dom, "features", "chatTimestampPage.js");
}

function loadChatTools(dom) {
    for (const parts of [
        ["shared", "settings.js"],
        ["shared", "data.js"],
        ["content.js"],
        ["shared", "uiTheme.js"],
        ["features", "chatTools", "parser.js"],
        ["features", "chatTools", "messageStore.js"],
        ["features", "chatTools", "panel.js"],
        ["features", "chatTools.js"],
    ]) {
        evalRepoScript(dom, ...parts);
    }
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
}

function setOption(chrome, key, oldValue, newValue) {
    for (const listener of chrome.listeners) listener({ [key]: { oldValue, newValue } }, "sync");
}

function closeDom(dom, chrome) {
    setOption(chrome, "chatToolsShowBlindEnabled", true, false);
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

function settle(ms = 200) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(overrides = {}) {
    return {
        key: "user-1_1790000000000_x",
        user: "user-1",
        time: 1790000000000,
        status: "NORMAL",
        originalContent: "원래 하려던 말",
        content: "원래 하려던 말",
        profile: { userIdHash: overrides.user || "user-1", nickname: "viewer" },
        ...overrides,
    };
}

function revealOf(dom, id) {
    return rowOf(dom, id).querySelector(".bcct-blind-reveal");
}

test("a cleanbot message blinded on arrival shows the page original on the first scan", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "cleanbot", text: CLEANBOT_NOTICE }));
    t.after(() => closeDom(dom, chrome));
    attachMessage(dom, "cleanbot", message({ status: "CBOTBLIND", originalContent: "클린봇이 가린 원문" }));

    loadPageBridge(dom);
    loadChatTools(dom);
    await waitForCondition(() => revealOf(dom, "cleanbot"));

    const notice = rowOf(dom, "cleanbot").querySelector("._text_1vemp_1");
    assert.equal(revealOf(dom, "cleanbot").textContent, "클린봇이 가린 원문");
    assert.equal(notice.getAttribute("data-bcct-blind-masked"), "1");
    assert.equal(revealOf(dom, "cleanbot").previousElementSibling, notice);
    assert.equal(dom.window.document.querySelector("[data-bcct-source-original]"), null);
});

test("a reused row with the same nickname cannot borrow another account's cached original", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "reuse", text: "이전 계정의 말" }));
    t.after(() => closeDom(dom, chrome));
    const props = attachMessage(dom, "reuse", message({ originalContent: "이전 계정의 말" }));
    loadPageBridge(dom);
    loadChatTools(dom);
    await settle();
    props.chatMessage = message({
        key: "another-message",
        user: "user-2",
        status: "BLIND",
        originalContent: undefined,
    });
    rowOf(dom, "reuse").querySelector("._text_1vemp_1").textContent = BLIND_NOTICE;
    await settle();
    assert.equal(revealOf(dom, "reuse"), null);
    assert.equal(rowOf(dom, "reuse").querySelector("[data-bcct-blind-masked]"), null);
});

test("a page message must match the visible author and contain complete identity fields", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "mixed", nickname: "새 작성자", text: BLIND_NOTICE }));
    t.after(() => closeDom(dom, chrome));
    const props = attachMessage(dom, "mixed", message({ status: "BLIND" }));
    loadPageBridge(dom);
    loadChatTools(dom);
    await settle();
    assert.equal(revealOf(dom, "mixed"), null, "old props cannot supply the new author's original");
    props.chatMessage = message({
        key: null,
        status: "BLIND",
        profile: { userIdHash: "user-1", nickname: "새 작성자" },
    });
    rowOf(dom, "mixed").querySelector("._text_1vemp_1").textContent = CLEANBOT_NOTICE;
    await settle();
    assert.equal(revealOf(dom, "mixed"), null, "incomplete identity is not an original source");
    props.chatMessage = message({ status: "BLIND", profile: { userIdHash: "user-1", nickname: "새 작성자" } });
    rowOf(dom, "mixed").querySelector("._text_1vemp_1").textContent = BLIND_NOTICE;
    await waitForCondition(() => revealOf(dom, "mixed"));
    assert.equal(revealOf(dom, "mixed").textContent, "원래 하려던 말");
});

test("normal page messages cannot fall back to an earlier DOM original", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "normal-cache", text: "이전 말" }));
    t.after(() => closeDom(dom, chrome));
    const props = attachMessage(dom, "normal-cache", message());
    loadPageBridge(dom);
    loadChatTools(dom);
    await settle();
    props.chatMessage = message({ key: "next-message", originalContent: BLIND_NOTICE, content: BLIND_NOTICE });
    rowOf(dom, "normal-cache").querySelector("._text_1vemp_1").textContent = BLIND_NOTICE;
    await settle();
    assert.equal(revealOf(dom, "normal-cache"), null);
});

test("a channel change removes old originals and rejects the same backlog remounted in the next channel", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "old-channel", text: BLIND_NOTICE }));
    t.after(() => closeDom(dom, chrome));
    evalRepoScript(dom, "features", "routeBridgePage.js");
    const oldMessage = message({ status: "BLIND" });
    attachMessage(dom, "old-channel", oldMessage);
    loadPageBridge(dom);
    loadChatTools(dom);
    await waitForCondition(() => revealOf(dom, "old-channel"));
    dom.window.history.pushState({}, "", "/live/next-channel");
    await settle();
    assert.equal(revealOf(dom, "old-channel"), null);
    dom.window.document.querySelector('[role="log"]').innerHTML = chatRow({ id: "remounted", text: BLIND_NOTICE });
    attachMessage(dom, "remounted", { ...oldMessage });
    await settle();
    assert.equal(revealOf(dom, "remounted"), null);
    attachMessage(
        dom,
        "remounted",
        message({ key: "new-channel-message", status: "CBOTBLIND", originalContent: "새 방송 원문" })
    );
    rowOf(dom, "remounted").querySelector("._text_1vemp_1").textContent = CLEANBOT_NOTICE;
    await waitForCondition(() => revealOf(dom, "remounted"));
    assert.equal(revealOf(dom, "remounted").textContent, "새 방송 원문");
});

test("a row changed during the page response is left as a native notice", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "changing", text: BLIND_NOTICE }));
    t.after(() => closeDom(dom, chrome));
    attachMessage(dom, "changing", message({ status: "BLIND" }));
    loadPageBridge(dom);
    dom.window.document.addEventListener(
        "cheese-spanner:chat-blind-source-request",
        () => {
            rowOf(dom, "changing").querySelector("._nickname_o04z9_57").textContent = "다른 작성자";
        },
        { once: true }
    );
    loadChatTools(dom);
    await settle();
    assert.equal(revealOf(dom, "changing"), null);
    assert.equal(dom.window.document.querySelector("[data-bcct-source-original]"), null);
});

test("a message already blinded before the first scan is restored without a DOM cache", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "blind", text: BLIND_NOTICE }));
    t.after(() => closeDom(dom, chrome));
    attachMessage(dom, "blind", message({ status: "BLIND", originalContent: "  처음부터 가려진 말  " }));

    loadPageBridge(dom);
    loadChatTools(dom);
    await waitForCondition(() => revealOf(dom, "blind"));

    assert.equal(revealOf(dom, "blind").textContent, "처음부터 가려진 말");
});

test("a later blind uses the updated page message of the current row", async (t) => {
    const { dom, chrome } = createPageDom(
        chatRow({ id: "first", text: "다른 말" }) + chatRow({ id: "later", text: "화면에 그린 본문" })
    );
    t.after(() => closeDom(dom, chrome));
    attachMessage(dom, "first", message({ user: "user-2", originalContent: "다른 말", content: "다른 말" }));
    const props = attachMessage(
        dom,
        "later",
        message({ originalContent: "사후 블라인드 원문", content: "화면에 그린 본문" })
    );

    loadPageBridge(dom);
    loadChatTools(dom);
    await settle();
    assert.equal(revealOf(dom, "later"), null);

    // 치지직 notiBlindListener처럼 같은 메시지 객체를 status만 바꿔 다시 렌더링한다.
    props.chatMessage = { ...props.chatMessage, status: "HIDDEN" };
    rowOf(dom, "later").querySelector("._text_1vemp_1").textContent = BLIND_NOTICE;
    await waitForCondition(() => revealOf(dom, "later"));

    // DOM 캐시(화면에 그린 본문)보다 현재 행의 페이지 원문을 먼저 쓴다.
    assert.equal(revealOf(dom, "later").textContent, "사후 블라인드 원문");
    assert.equal(revealOf(dom, "first"), null);
});

test("a live restriction restores both originals when the host props stay normal", async (t) => {
    const originals = ["먼저 올라온 채팅", "나중에 올라온 채팅"];
    const { dom, chrome } = createPageDom(originals.map((text, i) => chatRow({ id: i, text })).join(""));
    t.after(() => closeDom(dom, chrome));
    const messages = originals.map((originalContent, i) =>
        message({ key: `message-${i}`, time: 1790000000000 + i, originalContent, content: originalContent })
    );
    const props = messages.map((value, i) => attachMessage(dom, i, value));
    const client = attachLiveChatClient(dom, messages);

    const normalReads = new Set();
    dom.window.document.addEventListener("cheese-spanner:chat-blind-source-request", (event) => {
        const response = JSON.parse(event.target.getAttribute("data-bcct-source-message"));
        if (response?.status === "NORMAL") normalReads.add(response.key);
    });
    loadPageBridge(dom);
    loadChatTools(dom);
    await waitForCondition(() => normalReads.size === messages.length);
    assert.ok(originals.every((_, i) => revealOf(dom, i) === null));

    // The native client replaces each entry. React can update the body without refreshing the host's props.
    client.messageList = messages.map((entry) => ({ ...entry, status: "HIDDEN" }));
    for (let i = 0; i < messages.length; i++) rowOf(dom, i).querySelector("._text_1vemp_1").textContent = BLIND_NOTICE;
    await waitForCondition(() => originals.every((_, i) => revealOf(dom, i)));

    for (let i = 0; i < messages.length; i++) {
        assert.equal(props[i].chatMessage.status, "NORMAL");
        assert.equal(revealOf(dom, i).textContent, originals[i]);
        assert.equal(rowOf(dom, i).querySelector("._text_1vemp_1").getAttribute("data-bcct-blind-masked"), "1");
    }
    assert.equal(dom.window.document.querySelector("[data-bcct-source-original], [data-bcct-source-message]"), null);
});

test("a notice uses the live list only for the same key, author account, time, and channel", (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "blind", text: BLIND_NOTICE }));
    t.after(() => closeDom(dom, chrome));
    const anchor = message();
    attachMessage(dom, "blind", anchor);
    const hidden = { ...anchor, status: "HIDDEN", originalContent: "목록에 있는 원문" };
    const client = attachLiveChatClient(dom, [
        { ...hidden, key: "another-message" },
        { ...hidden, user: "user-2", profile: { userIdHash: "user-2", nickname: "viewer" } },
        { ...hidden, time: anchor.time + 1 },
    ]);
    loadPageBridge(dom);
    assert.equal(requestBlindSource(dom, "blind").original, null);

    client.messageList.push(hidden);
    client.config.streamingChannelId = "another-channel";
    assert.equal(requestBlindSource(dom, "blind").original, null);

    client.config.streamingChannelId = "test-channel";
    const reply = requestBlindSource(dom, "blind");
    assert.equal(reply.message.status, "HIDDEN");
    assert.equal(reply.original, hidden.originalContent);

    rowOf(dom, "blind").querySelector("._text_1vemp_1").textContent = anchor.originalContent;
    const normal = requestBlindSource(dom, "blind");
    assert.equal(normal.message.status, "NORMAL");
    assert.equal(normal.original, null);
});

test("a current normal or invalid list entry cannot disclose a stale blind original", (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "blind", text: BLIND_NOTICE }));
    t.after(() => closeDom(dom, chrome));
    const anchor = message({ status: "HIDDEN" });
    attachMessage(dom, "blind", anchor);
    const client = attachLiveChatClient(dom, [{ ...anchor, status: "NORMAL" }]);
    loadPageBridge(dom);
    const normal = requestBlindSource(dom, "blind");
    assert.equal(normal.message.status, "NORMAL");
    assert.equal(normal.original, null);

    client.messageList[0] = { ...anchor, profile: { userIdHash: anchor.user, nickname: "someone else" } };
    assert.deepEqual(requestBlindSource(dom, "blind"), { message: null, original: null });
});

test("the existing notice recheck reads a later list update with unchanged normal host props", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "delayed", text: BLIND_NOTICE }));
    t.after(() => closeDom(dom, chrome));
    const anchor = message({ originalContent: "" });
    const props = attachMessage(dom, "delayed", anchor);
    const client = attachLiveChatClient(dom, [anchor]);
    let requests = 0;
    dom.window.document.addEventListener("cheese-spanner:chat-blind-source-request", () => {
        requests++;
    });
    loadPageBridge(dom);
    loadChatTools(dom);
    await waitForCondition(() => requests > 0);
    assert.equal(revealOf(dom, "delayed"), null);

    client.messageList[0] = { ...anchor, status: "HIDDEN", originalContent: "늦게 목록에 들어온 원문" };
    await waitForCondition(() => revealOf(dom, "delayed"));
    assert.equal(revealOf(dom, "delayed").textContent, "늦게 목록에 들어온 원문");
    assert.equal(props.chatMessage, anchor);
});

test("RECLAIM and FILTERED use verified native originals", async (t) => {
    const statuses = ["RECLAIM", "FILTERED"];
    const { dom, chrome } = createPageDom(statuses.map((id) => chatRow({ id, text: BLIND_NOTICE })).join(""));
    t.after(() => closeDom(dom, chrome));
    for (const status of statuses) {
        attachMessage(dom, status, message({ key: status, status, originalContent: `원문 ${status}` }));
    }

    loadPageBridge(dom);
    loadChatTools(dom);
    await waitForCondition(() => statuses.every((status) => revealOf(dom, status)));
    for (const status of statuses) assert.equal(revealOf(dom, status).textContent, `원문 ${status}`);
});

test("a later blind can recover an original verified against the same visible native message", async (t) => {
    const original = "처음부터 보였던 원문";
    const { dom, chrome } = createPageDom(chatRow({ id: "cached", text: original }));
    t.after(() => closeDom(dom, chrome));
    const props = attachMessage(dom, "cached", message({ originalContent: original, content: original }));
    const normalOriginals = [];
    dom.window.document.addEventListener("cheese-spanner:chat-blind-source-request", (event) => {
        const identity = JSON.parse(event.target.getAttribute("data-bcct-source-message"));
        if (identity?.status !== "NORMAL") return;
        normalOriginals.push(event.target.getAttribute("data-bcct-source-original"));
    });

    loadPageBridge(dom);
    loadChatTools(dom);
    await waitForCondition(() => normalOriginals.length > 0);
    assert.ok(normalOriginals.every((value) => value === null));
    props.chatMessage = { ...props.chatMessage, status: "HIDDEN", originalContent: BLIND_NOTICE };
    rowOf(dom, "cached").querySelector("._text_1vemp_1").textContent = BLIND_NOTICE;
    await waitForCondition(() => revealOf(dom, "cached"));
    assert.equal(revealOf(dom, "cached").textContent, original);
    assert.equal(dom.window.document.querySelector("[data-bcct-source-original], [data-bcct-source-message]"), null);
});

for (const ending of ["option disable", "chat root replacement"]) {
    test(`a verified native original is cleared on ${ending}`, async (t) => {
        const original = "처음에 확인한 본문";
        const { dom, chrome } = createPageDom(chatRow({ id: "lifetime", text: original }), {
            sync: { chatKeywordFilterWords: "다른 문구" },
        });
        t.after(() => closeDom(dom, chrome));
        const props = attachMessage(dom, "lifetime", message({ originalContent: original, content: original }));
        const observedStatuses = new Set();
        dom.window.document.addEventListener("cheese-spanner:chat-blind-source-request", (event) => {
            observedStatuses.add(JSON.parse(event.target.getAttribute("data-bcct-source-message"))?.status);
        });
        loadPageBridge(dom);
        loadChatTools(dom);
        await waitForCondition(() => observedStatuses.has("NORMAL"));

        const hidden = { ...props.chatMessage, status: "HIDDEN", originalContent: "" };
        if (ending === "option disable") {
            setOption(chrome, "chatToolsShowBlindEnabled", true, false);
            props.chatMessage = hidden;
            rowOf(dom, "lifetime").querySelector("._text_1vemp_1").textContent = BLIND_NOTICE;
            setOption(chrome, "chatToolsShowBlindEnabled", false, true);
        } else {
            const root = rowOf(dom, "lifetime").parentElement;
            const replacement = root.cloneNode(false);
            replacement.innerHTML = chatRow({ id: "lifetime", text: BLIND_NOTICE });
            root.replaceWith(replacement);
            attachMessage(dom, "lifetime", hidden);
        }

        await waitForCondition(() => observedStatuses.has("HIDDEN"), { timeoutMs: 2500 });
        assert.equal(revealOf(dom, "lifetime"), null);
        assert.equal(rowOf(dom, "lifetime").querySelector("[data-bcct-blind-masked]"), null);
    });
}

test("late page data restores only the matching blind rows without a DOM update", async (t) => {
    const { dom, chrome } = createPageDom(
        chatRow({ id: "status", text: BLIND_NOTICE }) +
            chatRow({ id: "original", text: BLIND_NOTICE }) +
            chatRow({ id: "reuse", text: BLIND_NOTICE }),
        { sync: { chatKeywordFilterWords: "숨길 원문" } }
    );
    t.after(() => closeDom(dom, chrome));
    const status = attachMessage(dom, "status", message({ key: "status", originalContent: "상태가 늦게 바뀐 원문" }));
    const original = attachMessage(
        dom,
        "original",
        message({ key: "original", status: "HIDDEN", originalContent: "" })
    );
    const reuse = attachMessage(dom, "reuse", message({ key: "reuse", status: "HIDDEN", originalContent: "" }));
    const requested = new Set();
    dom.window.document.addEventListener(
        "cheese-spanner:chat-blind-source-request",
        (event) => requested.add(event.target.closest("[data-test-row]")),
        true
    );

    loadPageBridge(dom);
    loadChatTools(dom);
    await waitForCondition(() => requested.size === 3);
    for (const id of ["status", "original", "reuse"]) assert.equal(revealOf(dom, id), null);

    status.chatMessage = { ...status.chatMessage, status: "HIDDEN" };
    original.chatMessage = { ...original.chatMessage, originalContent: "숨길 원문" };
    reuse.chatMessage = { ...reuse.chatMessage, key: "reused-message", originalContent: "다른 메시지의 원문" };

    await waitForCondition(() => revealOf(dom, "status") && revealOf(dom, "original"), { timeoutMs: 3000 });
    assert.equal(revealOf(dom, "status").textContent, "상태가 늦게 바뀐 원문");
    assert.equal(revealOf(dom, "original").textContent, "숨길 원문");
    assert.equal(rowOf(dom, "original").getAttribute("data-bcct-keyword-filtered"), "1");
    assert.equal(revealOf(dom, "reuse"), null);
    assert.match(rowOf(dom, "reuse").textContent, /블라인드 처리되었습니다/);
});

test("a continued blind notice stops retrying after four attempts even when rescanned", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "unavailable", text: BLIND_NOTICE }));
    t.after(() => closeDom(dom, chrome));
    attachMessage(dom, "unavailable", message({ status: "HIDDEN", originalContent: "" }));
    const timers = new Map();
    let timerId = -1;
    const setTimeout = dom.window.setTimeout.bind(dom.window);
    const clearTimeout = dom.window.clearTimeout.bind(dom.window);
    t.mock.method(dom.window, "setTimeout", (callback, delay, ...args) => {
        if (callback.name !== "recheckBlindSources") return setTimeout(callback, delay, ...args);
        timers.set(timerId, callback);
        return timerId--;
    });
    t.mock.method(dom.window, "clearTimeout", (id) => {
        if (id < 0) timers.delete(id);
        else clearTimeout(id);
    });
    let requests = 0;
    dom.window.document.addEventListener("cheese-spanner:chat-blind-source-request", () => requests++, true);

    loadPageBridge(dom);
    loadChatTools(dom);
    await waitForCondition(() => timers.size === 1);
    const initialRequests = requests;
    for (let i = 0; i < 4; i++) {
        assert.equal(timers.size, 1);
        const [[id, retry]] = timers;
        timers.delete(id);
        retry();
    }
    assert.equal(requests, initialRequests + 4);
    assert.equal(timers.size, 0);

    dom.window.dispatchEvent(new dom.window.Event("cheese-spanner:chat-timestamp-page-ready"));
    await waitForCondition(() => requests > initialRequests + 4);
    assert.equal(timers.size, 0);
    assert.equal(revealOf(dom, "unavailable"), null);
});

test("rescanning an unchanged notice does not attach a different message's original", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "reuse", text: BLIND_NOTICE }));
    t.after(() => closeDom(dom, chrome));
    const props = attachMessage(dom, "reuse", message({ status: "HIDDEN", originalContent: "" }));
    let requests = 0;
    dom.window.document.addEventListener("cheese-spanner:chat-blind-source-request", () => requests++, true);

    loadPageBridge(dom);
    loadChatTools(dom);
    await waitForCondition(() => requests > 0);
    const previousRequests = requests;
    props.chatMessage = { ...props.chatMessage, key: "new-message", originalContent: "새 메시지 원문" };
    dom.window.dispatchEvent(new dom.window.Event("cheese-spanner:chat-timestamp-page-ready"));
    await waitForCondition(() => requests > previousRequests);
    assert.equal(revealOf(dom, "reuse"), null);

    rowOf(dom, "reuse").setAttribute("data-chat-id", "new-message");
    await waitForCondition(() => revealOf(dom, "reuse"));
    assert.equal(revealOf(dom, "reuse").textContent, "새 메시지 원문");
});

test("a normal message that only looks like a notice is never replaced", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "typed", text: BLIND_NOTICE }));
    t.after(() => closeDom(dom, chrome));
    attachMessage(dom, "typed", message({ originalContent: BLIND_NOTICE, content: BLIND_NOTICE }));

    loadPageBridge(dom);
    loadChatTools(dom);
    await settle();

    assert.equal(revealOf(dom, "typed"), null);
    assert.equal(rowOf(dom, "typed").querySelector("[data-bcct-blind-masked]"), null);
});

test("unverified native originals never fall back to cached or hidden DOM text", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "missing-source", text: "과거 화면 본문" }));
    t.after(() => closeDom(dom, chrome));
    const props = attachMessage(dom, "missing-source", message());
    loadPageBridge(dom);
    loadChatTools(dom);
    await settle();
    props.chatMessage = { ...props.chatMessage, status: "BLIND", originalContent: undefined };
    rowOf(dom, "missing-source").querySelector("._text_1vemp_1").textContent = BLIND_NOTICE;
    rowOf(dom, "missing-source").setAttribute("data-message-original", "다른 DOM 원문");
    await settle();
    assert.equal(revealOf(dom, "missing-source"), null);
});

test("malformed identity and unknown statuses cannot disclose a page original", async (t) => {
    const invalid = [
        { key: "" },
        { user: "" },
        { time: NaN },
        { time: Date.now() + 24 * 60 * 60 * 1000 },
        { status: "UNKNOWN" },
        { profile: { nickname: "viewer", userIdHash: "different-account" } },
    ];
    const { dom, chrome } = createPageDom(
        invalid.map((_, i) => chatRow({ id: `invalid-${i}`, text: BLIND_NOTICE })).join("")
    );
    t.after(() => closeDom(dom, chrome));
    invalid.forEach((value, i) => attachMessage(dom, `invalid-${i}`, message({ status: "BLIND", ...value })));
    loadPageBridge(dom);
    loadChatTools(dom);
    await settle();
    assert.equal(dom.window.document.querySelector(".bcct-blind-reveal"), null);
    assert.equal(dom.window.document.querySelector("[data-bcct-source-message], [data-bcct-source-original]"), null);
});

test("pagehide clears originals and pending work, and pageshow resumes only an enabled feature", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "lifecycle", text: BLIND_NOTICE }));
    t.after(() => closeDom(dom, chrome));
    attachMessage(dom, "lifecycle", message({ status: "BLIND" }));
    loadPageBridge(dom);
    loadChatTools(dom);
    await waitForCondition(() => revealOf(dom, "lifecycle"));
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    setOption(chrome, "chatToolsShowBlindEnabled", true, false);
    setOption(chrome, "chatToolsShowBlindEnabled", false, true);
    await settle();
    assert.equal(revealOf(dom, "lifecycle"), null);
    dom.window.dispatchEvent(new dom.window.Event("pageshow"));
    await waitForCondition(() => revealOf(dom, "lifecycle"));
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    setOption(chrome, "chatToolsShowBlindEnabled", true, false);
    dom.window.dispatchEvent(new dom.window.Event("pageshow"));
    await settle();
    assert.equal(revealOf(dom, "lifecycle"), null);
});

test("the nearest normal message stops the search before an ancestor blind message", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "nested", text: BLIND_NOTICE }));
    t.after(() => closeDom(dom, chrome));
    attachMessage(dom, "nested", message({ status: "NORMAL", originalContent: "" }), {
        selector: "._chatting_message_1vemp_21",
    });
    attachMessage(dom, "nested", message({ user: "other", status: "BLIND", originalContent: "다른 메시지 원문" }));

    loadPageBridge(dom);
    loadChatTools(dom);
    await settle();

    assert.equal(revealOf(dom, "nested"), null);
});

test("blind messages without a usable page original keep the notice", async (t) => {
    const { dom, chrome } = createPageDom(
        chatRow({ id: "missing", text: BLIND_NOTICE }) +
            chatRow({ id: "blank", text: BLIND_NOTICE }) +
            chatRow({ id: "object", text: BLIND_NOTICE }) +
            chatRow({ id: "notice", text: BLIND_NOTICE })
    );
    t.after(() => closeDom(dom, chrome));
    attachMessage(dom, "missing", message({ status: "BLIND", originalContent: undefined }));
    attachMessage(dom, "blank", message({ status: "BLIND", originalContent: "   " }));
    attachMessage(dom, "object", message({ status: "BLIND", originalContent: { text: "객체" } }));
    attachMessage(dom, "notice", message({ status: "BLIND", originalContent: CLEANBOT_NOTICE }));

    loadPageBridge(dom);
    loadChatTools(dom);
    await settle();

    for (const id of ["missing", "blank", "object", "notice"]) {
        assert.equal(revealOf(dom, id), null, id);
        assert.match(rowOf(dom, id).textContent, /블라인드 처리되었습니다/);
    }
    assert.equal(dom.window.document.querySelector("[data-bcct-source-original]"), null);
});

test("a stale source attribute is ignored when the page bridge does not answer", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "stale", text: BLIND_NOTICE }));
    t.after(() => closeDom(dom, chrome));
    rowOf(dom, "stale")
        .querySelector("._chatting_message_1vemp_21")
        .setAttribute("data-bcct-source-original", "이전 행의 원문");

    loadChatTools(dom);
    await settle();

    assert.equal(revealOf(dom, "stale"), null);
    assert.equal(dom.window.document.querySelector("[data-bcct-source-original]"), null);
});

test("the page bridge answers only for message containers inside the live chat log", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "inside", text: BLIND_NOTICE }));
    t.after(() => dom.window.close());
    void chrome;
    const outside = dom.window.document.createElement("div");
    outside.innerHTML = chatRow({ id: "outside", text: BLIND_NOTICE });
    dom.window.document.body.append(outside);
    attachMessage(dom, "outside", message({ status: "BLIND", originalContent: "밖의 원문" }));

    loadPageBridge(dom);
    const container = rowOf(dom, "outside").querySelector("._chatting_message_1vemp_21");
    container.dispatchEvent(new dom.window.Event("cheese-spanner:chat-blind-source-request", { bubbles: true }));

    assert.equal(container.hasAttribute("data-bcct-source-original"), false);
});

test("a page bridge that becomes ready late re-requests already scanned blind rows", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "late", text: BLIND_NOTICE }));
    t.after(() => closeDom(dom, chrome));
    attachMessage(dom, "late", message({ status: "BLIND", originalContent: "늦게 받은 원문" }));

    loadChatTools(dom);
    await settle();
    assert.equal(revealOf(dom, "late"), null);

    loadPageBridge(dom);
    await waitForCondition(() => revealOf(dom, "late"));
    assert.equal(revealOf(dom, "late").textContent, "늦게 받은 원문");
});

test("turning the blind option off removes page originals from the row", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "off", text: BLIND_NOTICE }));
    t.after(() => dom.window.close());
    attachMessage(dom, "off", message({ status: "BLIND", originalContent: "끄면 사라질 원문" }));

    loadPageBridge(dom);
    loadChatTools(dom);
    await waitForCondition(() => revealOf(dom, "off"));

    setOption(chrome, "chatToolsShowBlindEnabled", true, false);
    await waitForCondition(() => !revealOf(dom, "off"));

    assert.equal(rowOf(dom, "off").querySelector("[data-bcct-blind-masked]"), null);
    assert.doesNotMatch(rowOf(dom, "off").textContent, /끄면 사라질 원문/);
});

test("turning the blind option off cancels a pending source recheck with keyword filtering still enabled", async (t) => {
    const { dom, chrome } = createPageDom(chatRow({ id: "off", text: BLIND_NOTICE }), {
        sync: { chatKeywordFilterWords: "숨길 원문" },
    });
    t.after(() => closeDom(dom, chrome));
    const props = attachMessage(dom, "off", message({ status: "HIDDEN", originalContent: "" }));
    let requests = 0;
    dom.window.document.addEventListener("cheese-spanner:chat-blind-source-request", () => requests++, true);

    loadPageBridge(dom);
    loadChatTools(dom);
    await waitForCondition(() => requests > 0);
    await settle();
    const initialRequests = requests;
    await waitForCondition(() => requests > initialRequests, { timeoutMs: 3000 });

    setOption(chrome, "chatToolsShowBlindEnabled", true, false);
    props.chatMessage = { ...props.chatMessage, originalContent: "숨길 원문" };
    const requestsAtDisable = requests;
    await settle(1200);

    assert.ok(dom.window.document.getElementById("cheese-spanner-chat-keyword-filter-style"));
    assert.equal(requests, requestsAtDisable);
    assert.equal(revealOf(dom, "off"), null);
    assert.equal(rowOf(dom, "off").getAttribute("data-bcct-keyword-filtered"), null);
});
