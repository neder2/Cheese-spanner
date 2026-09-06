const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

// 2026-09-05: 오프라인 채널 /6c837d7222ccc4431ca7835a4340be8e의 #about 탭과
// 공식 /live/{channelId}/chat에서 채팅 화면이 열리는 것을 비로그인 상태로 확인했다.
const CHANNEL_A = "a".repeat(32);
const CHANNEL_B = "b".repeat(32);
const LINK_ID = "betterchzzk-channel-chat-link";
function channelMarkup(id) {
    return `<a href="https://game.naver.com/profile/${id}">프로필</a>
    <div role="tablist"><button role="tab" type="button">홈</button>
    <button role="tab" type="button" id="videos">동영상</button>
    <button role="tab" type="button" id="about" class="native-tab" aria-selected="true" aria-controls="about-PANEL">정보</button></div>`;
}
function createPage(t, { enabled = true, markup = channelMarkup(CHANNEL_A), route = `/${CHANNEL_A}` } = {}) {
    const dom = new JSDOM(`<!doctype html><body><main id="layout-body">${markup}</main></body>`, {
        url: `https://chzzk.naver.com${route}`,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    const listeners = [];
    dom.window.chrome = {
        runtime: {},
        storage: {
            sync: {
                get(_keys, callback) {
                    callback({ channelChatLinkEnabled: enabled });
                },
            },
            onChanged: {
                addListener(listener) {
                    listeners.push(listener);
                },
                removeListener() {},
            },
        },
    };
    dom.window.fetch = () => {
        assert.fail("channel chat links must not issue network requests");
    };
    for (const file of [
        "shared/settings.js",
        "shared/data.js",
        "content.js",
        "features/routeBridgePage.js",
        "features/channelChatLink.js",
    ]) {
        dom.window.eval(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
    }
    return {
        dom,
        document: dom.window.document,
        setEnabled(value) {
            for (const listener of listeners) listener({ channelChatLinkEnabled: { newValue: value } }, "sync");
        },
    };
}
async function waitFor(predicate) {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("channel chat link did not reach the expected state");
}

test("channel chat link follows information without copying selected-tab semantics or fetching data", async (t) => {
    const { document } = createPage(t);
    const about = document.getElementById("about");
    const originalHtml = about.outerHTML;
    await waitFor(() => document.getElementById(LINK_ID));
    const link = document.getElementById(LINK_ID);
    assert.equal(about.nextElementSibling, link);
    assert.equal(link.tagName, "A");
    assert.equal(link.textContent, "채팅");
    assert.equal(link.href, `https://chzzk.naver.com/live/${CHANNEL_A}`);
    assert.equal(link.target, "");
    assert.equal(link.className, "native-tab");
    assert.equal(link.getAttribute("aria-label"), "채팅이 있는 라이브 화면으로 이동");
    assert.equal(link.hasAttribute("aria-selected"), false);
    assert.equal(link.hasAttribute("aria-controls"), false);
    assert.equal(about.outerHTML, originalHtml);
    link.remove();
    await waitFor(() => document.getElementById(LINK_ID)?.isConnected);
    about.className = "native-tab-updated";
    await waitFor(() => document.getElementById(LINK_ID).className === about.className);
    assert.equal(document.querySelectorAll(`#${LINK_ID}`).length, 1);
});

test("chat link survives delayed tabs and remounts, and option changes clean up immediately", async (t) => {
    const { dom, document, setEnabled } = createPage(t, { enabled: false, markup: "" });
    const main = document.getElementById("layout-body");
    main.innerHTML = channelMarkup(CHANNEL_A);
    setEnabled(true);
    await waitFor(() => document.getElementById(LINK_ID));
    setEnabled(false);
    assert.equal(document.getElementById(LINK_ID), null);
    assert.equal(document.getElementById("betterchzzk-channel-chat-link-style"), null);
    main.innerHTML = "";
    setEnabled(true);
    assert.equal(document.getElementById(LINK_ID), null);
    main.innerHTML = channelMarkup(CHANNEL_A);
    await waitFor(() => document.getElementById(LINK_ID));
    const replacement = document.createElement("main");
    replacement.id = "layout-body";
    replacement.innerHTML = channelMarkup(CHANNEL_A);
    main.replaceWith(replacement);
    await waitFor(() => document.getElementById(LINK_ID)?.isConnected);
    dom.window.history.pushState({}, "", "/lives");
    await waitFor(() => !document.getElementById(LINK_ID));
    dom.window.history.pushState({}, "", `/${CHANNEL_A}/about`);
    await waitFor(() => document.getElementById(LINK_ID));
    assert.equal(document.querySelectorAll(`#${LINK_ID}`).length, 1);
});

test("SPA channel changes reject stale clicks and wait for the matching native channel header", async (t) => {
    const { dom, document } = createPage(t);
    await waitFor(() => document.getElementById(LINK_ID));
    const stale = document.getElementById(LINK_ID);
    dom.window.history.pushState({}, "", `/${CHANNEL_B}/videos`);
    const click = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
    stale.dispatchEvent(click);
    assert.equal(click.defaultPrevented, true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(document.getElementById(LINK_ID), null);
    document.getElementById("layout-body").innerHTML = channelMarkup(CHANNEL_B);
    await waitFor(() => document.getElementById(LINK_ID));
    assert.equal(document.getElementById(LINK_ID).getAttribute("href"), `/live/${CHANNEL_B}`);
});

test("live/chat and unrelated routes never receive a channel link even with matching markup", async (t) => {
    for (const route of ["/following", `/live/${CHANNEL_A}`, `/live/${CHANNEL_A}/chat`, "/video/123", "/%zz/about"]) {
        const { document } = createPage(t, { route });
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(document.getElementById(LINK_ID), null);
    }
});
