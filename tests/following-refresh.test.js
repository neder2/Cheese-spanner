const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { createFakeChrome, evalRepoScript, waitForAsyncCallbacks } = require("./helpers/extension-page-fixture.js");

function createPage(t, html) {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {
        url: "https://chzzk.naver.com/live/test-channel",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    dom.window.chrome = createFakeChrome({ sync: { followingRefreshSeconds: 10 } });
    const intervals = [];
    dom.window.setInterval = (fn, ms) => {
        intervals.push({ fn, ms });
        return intervals.length;
    };
    dom.window.clearInterval = () => {};
    const clicks = [];
    dom.window.document.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (button?.id) clicks.push(button.id);
    });
    return { dom, intervals, clicks };
}

async function start(page) {
    evalRepoScript(page.dom, "shared", "settings.js");
    evalRepoScript(page.dom, "shared", "data.js");
    evalRepoScript(page.dom, "content.js");
    evalRepoScript(page.dom, "features", "followingRefresh.js");
    await waitForAsyncCallbacks();
    assert.equal(page.intervals.length, 1);
    return () => page.intervals[0].fn();
}

const CATEGORY_SECTION =
    '<nav aria-label="인기 카테고리"><header><strong>인기 카테고리</strong><button id="categoryRefresh" type="button" aria-label="새로고침"></button></header><ul><li><a href="/category/GAME/talk">토크</a></li></ul></nav>';

test("following refresh never presses another section's refresh button while the following one is missing", async (t) => {
    // The measured section with its refresh button folded away.
    const measured = createPage(
        t,
        `<aside id="sidebar">${CATEGORY_SECTION}<nav aria-label="팔로우"><header><strong>팔로잉 채널</strong><button type="button" aria-expanded="false" aria-label="접힘, 펼치기"></button></header></nav></aside>`
    );
    const tickMeasured = await start(measured);
    tickMeasured();
    tickMeasured();
    assert.deepEqual(measured.clicks, [], "a folded following section has nothing to refresh");

    // Without the measured label, the sidebar text still says 팔로잉 but the only refresh button is another section's.
    const fallback = createPage(
        t,
        `<aside id="sidebar">${CATEGORY_SECTION}<div><strong>팔로잉 채널</strong><a href="/following?tab=LIVE">전체보기</a></div></aside>`
    );
    const tickFallback = await start(fallback);
    tickFallback();
    assert.deepEqual(fallback.clicks, []);
});

test("following refresh picks the following section's button even when another section's comes first", async (t) => {
    const measured = createPage(
        t,
        `<aside id="sidebar">${CATEGORY_SECTION}<nav aria-label="팔로우"><header><strong>팔로잉 채널</strong><button id="followingRefresh" type="button" aria-label="새로고침"></button></header></nav></aside>`
    );
    const tickMeasured = await start(measured);
    tickMeasured();
    tickMeasured();
    assert.deepEqual(measured.clicks, ["followingRefresh", "followingRefresh"]);

    const fallback = createPage(
        t,
        `<aside id="sidebar">${CATEGORY_SECTION}<section><header><strong>팔로잉 채널</strong><button id="followingRefresh" type="button" aria-label="새로고침"></button></header></section></aside>`
    );
    const tickFallback = await start(fallback);
    tickFallback();
    assert.deepEqual(fallback.clicks, ["followingRefresh"]);
});
