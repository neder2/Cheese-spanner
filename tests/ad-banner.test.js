const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const source = fs.readFileSync(path.join(__dirname, "../features/adBanner.js"), "utf8");

test("banner setting hides only measured slots and restores them without touching their DOM", (t) => {
    const dom = new JSDOM(
        '<!doctype html><html><body><div id="home_banner" style="min-height:80px"><iframe title="AD"></iframe></div><div id="live_end_banner"></div><div id="vod_end_banner"></div><div id="event_banner">행사 안내</div><div class="pzp-pc"><video></video></div></body></html>',
        { url: "https://chzzk.naver.com/", runScripts: "outside-only" }
    );
    t.after(() => dom.window.close());
    const { window } = dom;
    const { document } = window;
    let setOptions;
    window.BetterChzzk = {
        utils: {
            bindFeatureOptions(fn) {
                setOptions = fn;
            },
            onReady(fn) {
                fn();
            },
            injectStyleOnce(id, cssText) {
                if (document.getElementById(id)) return;
                const style = document.createElement("style");
                style.id = id;
                style.textContent = cssText;
                document.documentElement.append(style);
            },
        },
    };
    const banner = document.getElementById("home_banner");
    const original = banner.outerHTML;
    window.eval(source);
    assert.equal(document.querySelector("style"), null);
    setOptions({ adBannerEnabled: false, adblockPopupEnabled: true });
    assert.equal(document.querySelector("style"), null);
    setOptions({ adBannerEnabled: true, adblockPopupEnabled: false });
    for (const id of ["live_rs_banner", "vod_rs_banner"]) {
        const slot = document.createElement("div");
        slot.id = id;
        document.body.append(slot);
        assert.equal(window.getComputedStyle(slot).display, "none");
    }
    setOptions({ adBannerEnabled: true });
    assert.equal(document.querySelectorAll("style").length, 1);
    assert.equal(window.getComputedStyle(banner).display, "none");
    assert.equal(window.getComputedStyle(document.getElementById("live_end_banner")).display, "none");
    assert.equal(window.getComputedStyle(document.getElementById("vod_end_banner")).display, "none");
    assert.notEqual(window.getComputedStyle(document.getElementById("event_banner")).display, "none");
    assert.notEqual(window.getComputedStyle(document.querySelector(".pzp-pc")).display, "none");
    assert.equal(banner.outerHTML, original);

    window.history.replaceState(null, "", "/live/test-channel");
    const replacement = document.createElement("div");
    replacement.id = "live_end_banner";
    document.getElementById("live_end_banner").replaceWith(replacement);
    assert.equal(window.getComputedStyle(replacement).display, "none");

    setOptions({ adBannerEnabled: false });
    assert.notEqual(window.getComputedStyle(document.getElementById("vod_rs_banner")).display, "none");
    assert.equal(document.querySelector("style"), null);
    assert.notEqual(window.getComputedStyle(banner).display, "none");
    assert.notEqual(window.getComputedStyle(replacement).display, "none");
    assert.equal(banner.outerHTML, original);
});
