const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { createFakeChrome, readRepoFile, waitForCondition } = require("./helpers/extension-page-fixture.js");

const LABEL_ID = "betterchzzk-live-lag-label";
const PATCHED_ATTR = "data-bctm-text-patched";

function fixture(t, { ad = false, buttonAttrs = "" } = {}) {
    const adMedia = ad ? `<div data-role="imaAdContainerEl"><video class="ad"></video></div>` : "";
    const dom = new JSDOM(
        `<!doctype html><body><div class="pzp-pc"><video class="main"></video>${adMedia}
        <div class="pzp-pc__bottom-buttons--left"><button type="button" class="pzp-pc__live-button" ${buttonAttrs}>실시간</button><span class="time">01:23:45</span></div></div></body>`,
        { url: `https://chzzk.naver.com/live/${"a".repeat(32)}`, runScripts: "outside-only", pretendToBeVisual: true }
    );
    const { window } = dom;
    const { document } = window;
    const chrome = createFakeChrome();
    window.chrome = chrome;

    const rects = new Map([
        [".main", [0, 0, 1280, 720]],
        [".ad", [0, 0, 1600, 900]],
        [".pzp-pc__bottom-buttons--left", [0, 676, 400, 44]],
        [".pzp-pc__live-button", [16, 686, 60, 24]],
        [".time", [84, 686, 80, 24]],
    ]);
    window.HTMLElement.prototype.getBoundingClientRect = function () {
        const match = [...rects].find(([selector]) => this.matches(selector));
        const [left, top, width, height] = match ? match[1] : [0, 0, 0, 0];
        return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height };
    };
    const setPlayback = (video, currentTime) => {
        Object.defineProperty(video, "seekable", {
            configurable: true,
            value: { length: 1, start: () => 0, end: () => 100 },
        });
        Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: currentTime });
    };
    const main = document.querySelector(".main");
    setPlayback(main, 80);
    if (ad) setPlayback(document.querySelector(".ad"), 40);

    for (const file of ["shared/settings.js", "shared/data.js", "content.js", "features/timeMachineLagLabel.js"]) {
        window.eval(readRepoFile(file));
    }
    const setEnabled = (enabled) => {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ timeMachineLagLabelEnabled: { newValue: enabled } }, "sync");
        }
    };
    t.after(() => {
        setEnabled(false);
        window.close();
    });
    document.dispatchEvent(new window.Event("DOMContentLoaded"));
    return { window, document, main, button: document.querySelector("button"), setEnabled };
}

test("live lag replaces the live button text behind the edge and restores it at the live edge", async (t) => {
    const h = fixture(t);
    await waitForCondition(() => h.button.textContent === "-0:20");
    assert.equal(h.button.getAttribute(PATCHED_ATTR), "1");
    assert.equal(h.document.getElementById(LABEL_ID), null);

    h.main.currentTime = 100;
    h.main.dispatchEvent(new h.window.Event("timeupdate"));
    await waitForCondition(() => h.button.textContent === "실시간");
    assert.equal(h.button.hasAttribute(PATCHED_ATTR), false);
});

test("live lag follows the main player video instead of larger native ad media", async (t) => {
    const h = fixture(t, { ad: true });
    await waitForCondition(() => h.button.hasAttribute(PATCHED_ATTR));
    assert.equal(h.button.textContent, "-0:20");
});

test("disabled live controls keep their text and show a separate label until the option is turned off", async (t) => {
    const h = fixture(t, { buttonAttrs: 'aria-disabled=" TRUE "' });
    await waitForCondition(() => h.document.getElementById(LABEL_ID)?.textContent === "-0:20");
    assert.equal(h.button.textContent, "실시간");
    assert.equal(h.button.hasAttribute(PATCHED_ATTR), false);
    assert.equal(h.document.getElementById(LABEL_ID).parentElement, h.button.parentElement);

    h.setEnabled(false);
    assert.equal(h.document.getElementById(LABEL_ID), null);
    assert.equal(h.button.textContent, "실시간");
});
