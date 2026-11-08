const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repoRoot = path.join(__dirname, "..");

function readRepoFile(...parts) {
    return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

test("live route parsing rejects malformed URI escapes without throwing", () => {
    const dom = new JSDOM("<!doctype html><body></body>", {
        url: "https://chzzk.naver.com/",
        runScripts: "outside-only",
    });
    dom.window.eval(readRepoFile("content.js"));

    const { getLiveChannelIdFromPath } = dom.window.CheeseSpanner.utils;
    assert.equal(getLiveChannelIdFromPath("/live/%E0%A4%A"), "");
    assert.equal(getLiveChannelIdFromPath("/live/%"), "");
    assert.equal(getLiveChannelIdFromPath("/live/%ED%85%8C%EC%8A%A4%ED%8A%B8"), "테스트");
    dom.window.close();
});

test("main video selection excludes native ad media and extension previews during replacement", (t) => {
    const dom = new JSDOM(
        '<!doctype html><video id="main"></video><div data-role="gvAdContainerEl"><video id="gv"></video></div><div data-role="imaAdContainerEl"><video id="ima"></video></div><div id="midAdPlayerWrapper"><video id="midPlayer"></video></div><div data-bcfp-tooltip="1"><video></video></div>' +
            // Live pre-roll (2026-11-05 public bundle): the IMA content video placeholder beside the ad container.
            '<div id="preAdPlayerWrapper"><video id="preAdContentPlayer"></video><div id="preAdVideoContainer"></div></div>',
        { url: "https://chzzk.naver.com/video/123", runScripts: "outside-only" }
    );
    t.after(() => dom.window.close());
    const w = dom.window;
    const main = w.document.getElementById("main");
    for (const video of w.document.querySelectorAll("video"))
        video.getBoundingClientRect = () => ({ width: video === main ? 320 : 1920, height: 1080 });
    w.eval(readRepoFile("content.js"));
    assert.equal(w.CheeseSpanner.utils.getMainVideoElement(), main);
    main.remove();
    assert.equal(w.CheeseSpanner.utils.getMainVideoElement(), null, "ads never become the fallback main video");
    const replacement = w.document.createElement("video");
    w.document.body.append(replacement);
    assert.equal(w.CheeseSpanner.utils.getMainVideoElement(), replacement);
});

test("native ad break signal follows the pre-roll mount and the mid-roll wrapper display", (t) => {
    const dom = new JSDOM("<!doctype html><body></body>", {
        url: "https://chzzk.naver.com/live/test-channel",
        runScripts: "outside-only",
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    w.eval(readRepoFile("content.js"));
    const { isNativeAdBreakActive, NATIVE_AD_MEDIA_SELECTOR } = w.CheeseSpanner.utils;
    assert.equal(typeof isNativeAdBreakActive, "function");
    assert.equal(isNativeAdBreakActive(), false);

    // The mid-roll wrapper stays mounted and shows the ad break through its display.
    const mid = w.document.createElement("div");
    mid.id = "midAdPlayerWrapper";
    mid.style.display = "none";
    mid.innerHTML = '<video id="midPlayer"></video><div id="midAdVideoContainer"></div>';
    w.document.body.append(mid);
    assert.equal(isNativeAdBreakActive(), false, "a hidden mid-roll wrapper is not an ad break");
    mid.style.display = "block";
    assert.equal(isNativeAdBreakActive(), true, "a shown mid-roll wrapper is an ad break");
    mid.style.display = "none";
    assert.equal(isNativeAdBreakActive(), false, "the break ends when the wrapper hides again");

    // The pre-roll wrapper is mounted only for the pre-roll.
    const pre = w.document.createElement("div");
    pre.id = "preAdPlayerWrapper";
    pre.innerHTML = '<video id="preAdContentPlayer"></video><div id="preAdVideoContainer"></div>';
    w.document.body.append(pre);
    assert.equal(isNativeAdBreakActive(), true, "a mounted pre-roll wrapper is an ad break");
    pre.remove();
    assert.equal(isNativeAdBreakActive(), false, "the pre-roll ends at its unmount");

    for (const selector of [
        '[data-role="imaAdContainerEl"]',
        '[data-role="gvAdContainerEl"]',
        "#preAdPlayerWrapper",
        "#midAdPlayerWrapper",
    ]) {
        assert.ok(String(NATIVE_AD_MEDIA_SELECTOR).includes(selector), selector);
    }
});

test("a VOD ad break is an ad break for playback keys but not a live one for player buttons", (t) => {
    // 2026-11-05 public bundle: VOD IMA/GV ads play inside the player and mark its pzp root pzp-pc--adbreak.
    const dom = new JSDOM(
        '<!doctype html><body><div class="pzp pzp-pc" id="root"><video id="main"></video>' +
            '<div data-role="imaAdContainerEl"><video id="ad"></video></div></div></body>',
        { url: "https://chzzk.naver.com/video/123", runScripts: "outside-only" }
    );
    t.after(() => dom.window.close());
    const w = dom.window;
    w.eval(readRepoFile("content.js"));
    const { isNativeAdBreakActive, isLiveAdBreakActive } = w.CheeseSpanner.utils;
    const root = w.document.getElementById("root");
    assert.equal(isNativeAdBreakActive(), false);
    root.classList.add("pzp-pc--adbreak");
    assert.equal(isNativeAdBreakActive(), true, "the main player's ad break class marks the break");
    assert.equal(isLiveAdBreakActive(), false, "a VOD ad inside the player is not a live wrapper break");
    root.classList.remove("pzp-pc--adbreak");
    assert.equal(isNativeAdBreakActive(), false);

    // An ad break class on an unrelated player (e.g. a nested preview) does not mark the main one.
    const other = w.document.createElement("div");
    other.className = "pzp pzp-pc pzp-pc--adbreak";
    w.document.body.append(other);
    assert.equal(isNativeAdBreakActive(), false, "another player's ad break is ignored");
});

test("visible area ignores detached, hidden, and zero-sized controls", (t) => {
    const dom = new JSDOM("<!doctype html><body></body>", {
        url: "https://chzzk.naver.com/",
        runScripts: "outside-only",
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    w.eval(readRepoFile("content.js"));
    const { getVisibleArea } = w.CheeseSpanner.utils;
    const control = w.document.createElement("button");
    control.getBoundingClientRect = () => ({ width: 40, height: 20 });
    assert.equal(getVisibleArea(control), 0);
    w.document.body.append(control);
    assert.equal(getVisibleArea(control), 800);
    for (const style of ["display: none", "visibility: hidden"]) {
        control.style.cssText = style;
        assert.equal(getVisibleArea(control), 0);
    }
    control.style.cssText = "";
    control.getBoundingClientRect = () => ({ width: 0, height: 20 });
    assert.equal(getVisibleArea(control), 0);
    assert.equal(getVisibleArea(null), 0);
    assert.equal(getVisibleArea(w.document.createTextNode("control")), 0);
});
