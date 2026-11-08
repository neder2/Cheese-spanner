const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { createFakeChrome, evalRepoScript, waitForAsyncCallbacks } = require("./helpers/extension-page-fixture.js");

const openDoms = new Set();

test.afterEach(() => {
    for (const dom of openDoms) dom.window.close();
    openDoms.clear();
});

function waitForTitleTooltipDelay() {
    return new Promise((resolve) => setTimeout(resolve, 190));
}

function waitForFrame(dom) {
    return new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve()));
}

async function createTitleTooltipDom() {
    const dom = new JSDOM(
        [
            "<!doctype html>",
            "<body>",
            '<aside id="chatList"><div>chat</div></aside>',
            '<main id="scroller"><article class="card">',
            '<a class="card_title" href="/live/abc">아주 길어서 잘리는 방송 제목 전체 내용</a>',
            "</article></main>",
            "</body>",
        ].join(""),
        { pretendToBeVisual: true, runScripts: "outside-only", url: "https://chzzk.naver.com/lives" }
    );
    openDoms.add(dom);
    dom.window.chrome = createFakeChrome();
    const { document } = dom.window;
    const title = document.querySelector(".card_title");
    Object.defineProperty(title, "scrollWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(title, "clientWidth", { configurable: true, get: () => 200 });
    title.getBoundingClientRect = () => ({ left: 40, top: 120, right: 240, bottom: 140, width: 200, height: 20 });

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    return { document, dom, title };
}

test("a scroll in another area such as the chat list does not cancel a pending title tooltip", async () => {
    const { document, dom, title } = await createTitleTooltipDom();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    document.getElementById("chatList").dispatchEvent(new dom.window.Event("scroll"));
    await waitForFrame(dom);
    await waitForTitleTooltipDelay();

    const tip = document.querySelector(".bctt-tooltip[data-show='1']");
    assert.ok(tip, "the tooltip still opens after an unrelated scroll");
    assert.equal(tip.textContent, "아주 길어서 잘리는 방송 제목 전체 내용");
    assert.equal(title.getAttribute("data-bctt-active"), "1");

    document.getElementById("chatList").dispatchEvent(new dom.window.Event("scroll"));
    await waitForFrame(dom);
    assert.ok(document.querySelector(".bctt-tooltip[data-show='1']"), "an open tooltip only repositions");
});

test("a scroll that moves the pending title still cancels its open", async () => {
    const { document, dom, title } = await createTitleTooltipDom();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    document.getElementById("scroller").dispatchEvent(new dom.window.Event("scroll"));
    await waitForFrame(dom);
    await waitForTitleTooltipDelay();

    assert.equal(document.querySelector(".bctt-tooltip[data-show='1']"), null);
    assert.equal(title.hasAttribute("data-bctt-active"), false);
});
