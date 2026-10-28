const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { waitForCondition } = require("./helpers/wait-for-condition.js");

const repoRoot = path.join(__dirname, "..");
const REACT_PROPS_KEY = "__reactProps$cheeseSpannerTest";
const USER_URL = "https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus";
const ME = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const openDoms = new Set();

test.afterEach(() => {
    for (const dom of openDoms) {
        dom.window.CheeseSpanner?.vodOwnChat?.teardown?.();
        dom.window.close();
    }
    openDoms.clear();
});

function readRepoFile(...parts) {
    return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

// 2026-10-21 /video/7284936: 다시보기 행 `_item_`의 React props `children.props.chatMessage`에 `user`(작성 계정 해시)가
// 있고 `profile.userIdHash`와 같았어요. 닉네임은 작성 당시 값이라 비교에 쓰지 않아요.
function vodRow({ nickname = "시청자", text = "채팅", reuse = "" } = {}) {
    const reuseAttr = reuse ? ` data-virtual-index="${reuse}"` : "";
    return [
        `<div class="_item_61avy_82"${reuseAttr}>`,
        '<div class="_container_w9pvh_1">',
        '<div class="_chatting_message_w9pvh_21">',
        '<button type="button" class="_nickname_w9pvh_33" aria-haspopup="true">',
        `<span class="_nickname_1mc5x_80">${nickname}</span>`,
        "</button>",
        `<span class="_text_w9pvh_1">${text}</span>`,
        "</div>",
        "</div>",
        "</div>",
    ].join("");
}

function setMessage(item, user) {
    Object.defineProperty(item, REACT_PROPS_KEY, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: { children: { props: { chatMessage: { user, time: Date.UTC(2025, 4, 16, 12) } } } },
    });
}

function createFakeChrome(sync = {}) {
    const syncData = { ...sync };
    const localWrites = [];
    const listeners = [];
    const area = (data) => ({
        get(keys, callback) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys])
                if (Object.hasOwn(data, key)) result[key] = data[key];
            callback(result);
        },
        set(values, callback) {
            Object.assign(data, values || {});
            callback?.();
        },
    });
    const local = area({});
    const setLocal = local.set;
    local.set = (values, callback) => {
        localWrites.push(values);
        setLocal(values, callback);
    };
    return {
        runtime: {},
        storage: {
            local,
            sync: area(syncData),
            onChanged: {
                addListener: (listener) => listeners.push(listener),
                removeListener: (listener) => listeners.splice(listeners.indexOf(listener), 1),
            },
        },
        testState: {
            localWrites,
            setSync(values) {
                const changes = {};
                for (const [key, newValue] of Object.entries(values)) {
                    changes[key] = { oldValue: syncData[key], newValue };
                    syncData[key] = newValue;
                }
                for (const listener of [...listeners]) listener(changes, "sync");
            },
        },
    };
}

function createVodDom({ rows = [], url = "https://chzzk.naver.com/video/7284936", sync = {}, user = ME } = {}) {
    const dom = new JSDOM(
        [
            "<!doctype html><body>",
            '<aside id="vod-aside"><div class="_content_61avy_60" role="log"><div class="_list_61avy_67">',
            rows.map((row) => vodRow(row)).join(""),
            "</div></div></aside>",
            "</body>",
        ].join(""),
        { url, runScripts: "outside-only", pretendToBeVisual: true }
    );
    const state = { requests: [], user, fail: false };
    dom.window.chrome = createFakeChrome(sync);
    dom.window.fetch = async (requestUrl, init = {}) => {
        state.requests.push({ url: String(requestUrl), credentials: init.credentials });
        assert.equal(String(requestUrl), USER_URL);
        if (state.fail) throw new TypeError("Failed to fetch");
        const loggedIn = Boolean(state.user);
        return {
            ok: true,
            status: 200,
            json: async () => ({ code: 200, content: { loggedIn, userIdHash: loggedIn ? state.user : null } }),
        };
    };
    const items = dom.window.document.querySelectorAll("._item_61avy_82");
    rows.forEach((row, index) => {
        if (row.user !== undefined) setMessage(items[index], row.user);
    });
    openDoms.add(dom);
    return { dom, document: dom.window.document, state };
}

function load(dom) {
    for (const file of [
        "features/chatTimestampPage.js",
        "shared/settings.js",
        "shared/data.js",
        "content.js",
        "shared/uiTheme.js",
        "features/vodOwnChat.js",
    ]) {
        dom.window.eval(readRepoFile(file));
    }
}

const ownTexts = (document) =>
    Array.from(document.querySelectorAll("[data-bcoc-own] ._text_w9pvh_1"), (node) => node.textContent);
const waitFor = (predicate, message) => waitForCondition(predicate, { timeoutMs: 2000, intervalMs: 20, message });

test("the logged-in account's replay chats are highlighted by account hash, not nickname", async () => {
    const { dom, document, state } = createVodDom({
        rows: [
            { user: ME, nickname: "옛 닉네임", text: "내 채팅" },
            { user: OTHER, nickname: "지금 닉네임", text: "다른 사람" },
            { user: ME, nickname: "지금 닉네임", text: "또 내 채팅" },
        ],
    });
    load(dom);
    await waitFor(() => ownTexts(document).length === 2, "own chats were not highlighted");
    assert.deepEqual(ownTexts(document), ["내 채팅", "또 내 채팅"]);
    assert.deepEqual(state.requests, [{ url: USER_URL, credentials: "include" }]);
    assert.deepEqual(dom.window.chrome.testState.localWrites, [], "the account hash is not stored");
    const css = document.getElementById("cheese-spanner-vod-own-chat-style").textContent;
    assert.match(css, /\[data-bcoc-own\]\{[^}]*background-color:var\(--bct-brand-weak\)/);
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i, "colors only through the shared theme");
});

test("new and reused replay rows follow the message now shown in them", async () => {
    const { dom, document } = createVodDom({ rows: [{ user: OTHER, text: "다른 사람" }] });
    load(dom);
    await waitFor(() => document.querySelector("[data-bcoc-source-user]"), "the first row was not checked");
    assert.deepEqual(ownTexts(document), []);

    const list = document.querySelector("._list_61avy_67");
    const template = document.createElement("template");
    template.innerHTML = vodRow({ text: "새 내 채팅" });
    const added = template.content.firstElementChild;
    setMessage(added, ME);
    list.appendChild(added);
    await waitFor(() => ownTexts(document).includes("새 내 채팅"), "an appended own chat was not highlighted");

    // 가상 목록이 같은 노드에 다른 사람의 메시지를 넣었어요.
    setMessage(added, OTHER);
    added.querySelector("._text_w9pvh_1").textContent = "재사용된 다른 사람";
    await waitFor(() => ownTexts(document).length === 0, "a reused row kept the previous highlight");
});

test("logged-out, failed, malformed, or live pages leave chats unmarked", async () => {
    const loggedOut = createVodDom({ rows: [{ user: ME, text: "내 채팅" }], user: "" });
    load(loggedOut.dom);
    await waitFor(() => loggedOut.state.requests.length === 1, "login status was not checked");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(ownTexts(loggedOut.document), []);

    const failed = createVodDom({ rows: [{ user: ME, text: "내 채팅" }] });
    failed.state.fail = true;
    load(failed.dom);
    await waitFor(() => failed.state.requests.length === 1, "login status was not checked");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(ownTexts(failed.document), []);

    const malformed = createVodDom({ rows: [{ user: "<script>", text: "이상한 값" }], user: "<script>" });
    load(malformed.dom);
    await waitFor(() => malformed.state.requests.length === 1, "login status was not checked");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(ownTexts(malformed.document), []);
    assert.equal(malformed.document.querySelector("[data-bcoc-source-user]"), null);

    const live = createVodDom({ rows: [{ user: ME, text: "내 채팅" }], url: "https://chzzk.naver.com/live/abc" });
    load(live.dom);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(live.state.requests, [], "live pages send no login check for this feature");
    assert.deepEqual(ownTexts(live.document), []);
});

test("switching accounts re-checks and moves the highlight", async () => {
    const { dom, document, state } = createVodDom({
        rows: [
            { user: ME, text: "첫 계정" },
            { user: OTHER, text: "둘째 계정" },
        ],
    });
    load(dom);
    await waitFor(() => ownTexts(document).length === 1, "own chat was not highlighted");
    state.user = OTHER;
    dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: "userStatus.idhash" }));
    await waitFor(() => ownTexts(document)[0] === "둘째 계정", "the highlight did not follow the new account");
    assert.equal(ownTexts(document).length, 1);
});

test("the option is on by default and turning it off removes every marker", async () => {
    const { dom, document } = createVodDom({ rows: [{ user: ME, text: "내 채팅" }] });
    load(dom);
    assert.equal(dom.window.CheeseSpannerSettings.DEFAULT_OPTIONS.vodOwnChatHighlightEnabled, true);
    assert.ok(dom.window.CheeseSpannerSettings.FEATURE_KEYS.includes("vodOwnChatHighlightEnabled"));
    await waitFor(() => ownTexts(document).length === 1, "own chat was not highlighted");

    dom.window.chrome.testState.setSync({ vodOwnChatHighlightEnabled: false });
    await waitFor(() => !document.querySelector("[data-bcoc-own]"), "turning off kept the highlight");
    assert.equal(document.querySelector("[data-bcoc-source-user]"), null);
    assert.equal(document.getElementById("cheese-spanner-vod-own-chat-style"), null);

    const optionsHtml = readRepoFile("options.html");
    assert.match(optionsHtml, /data-option="vodOwnChatHighlightEnabled"/);
    const manifest = JSON.parse(readRepoFile("manifest.json"));
    const isolated = manifest.content_scripts.find((entry) => entry.js?.includes("features/vodOwnChat.js")).js;
    assert.ok(isolated.indexOf("features/vodOwnChat.js") > isolated.indexOf("content.js"));
    assert.ok(isolated.indexOf("features/vodOwnChat.js") > isolated.indexOf("shared/uiTheme.js"));
});
