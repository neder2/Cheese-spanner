const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { createFakeChrome, readRepoFile, waitForCondition } = require("./helpers/extension-page-fixture.js");

const OWN_CONTROLS = ["betterchzzk-skip-pill", "betterchzzk-live-fast-forward", "betterchzzk-audio-compressor"];
const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

async function fixture(t, route) {
    const chrome = createFakeChrome({
        sync: { playerZoomEnabled: true, playerZoomMode: "always", audioCompressorEnabled: true },
    });
    const dom = new JSDOM(
        `<!doctype html><div class="pzp-pc pzp-pc--controls">
        <div class="pzp-pc__video"><video style="object-fit:contain"></video></div>
        <div class="pzp-pc__bottom"><div class="pzp-pc__bottom-buttons-left">
            <button class="pzp-pc__playback-switch" aria-label="재생"></button>
            <div class="pzp-pc__volume-control"><button class="pzp-pc__volume-button" aria-label="음량"></button></div>
            <div class="pzp-pc__vod-time">00:30 / 10:00</div>
        </div><div class="pzp-pc__bottom-buttons-right"></div></div></div>`,
        {
            url: `https://chzzk.naver.com${route}`,
            runScripts: "outside-only",
            pretendToBeVisual: true,
        }
    );
    const w = dom.window;
    const doc = w.document;
    w.chrome = chrome;
    const observers = [];
    const NativeObserver = w.MutationObserver;
    w.MutationObserver = class extends NativeObserver {
        constructor(callback) {
            super(callback);
            observers.push(this);
        }
    };
    let viewport = box(100, 60, 800, 450);
    const video = doc.querySelector("video");
    const player = doc.querySelector(".pzp-pc");
    w.HTMLElement.prototype.getBoundingClientRect = function () {
        if (this instanceof w.HTMLVideoElement) {
            const transform = this.style.transform.match(
                /^translate\(([-\d.e+]+)px, ([-\d.e+]+)px\) scale\(([-\d.e+]+)\)$/
            );
            const [, x = 0, y = 0, scale = 1] = transform || [];
            return box(
                viewport.left + Number(x),
                viewport.top + Number(y),
                viewport.width * Number(scale),
                viewport.height * Number(scale)
            );
        }
        if (this.contains(video)) return viewport;
        if (this.closest(".pzp-pc__bottom")) return box(viewport.left + 20, viewport.bottom - 40, 340, 40);
        return box(0, 0, 0, 0);
    };
    Object.defineProperties(video, {
        videoWidth: { value: 1920 },
        videoHeight: { value: 1080 },
        readyState: { value: 4 },
        duration: { value: 600 },
        seekable: { value: { length: 1, start: () => 0, end: () => 600 } },
        buffered: { value: { length: 1, start: () => 0, end: () => 600 } },
    });
    video.currentTime = 30;
    video.play = async () => {};
    const change = (updates) => {
        Object.assign(chrome.testState.sync, updates);
        const changes = Object.fromEntries(Object.entries(updates).map(([key, value]) => [key, { newValue: value }]));
        for (const listener of chrome.testState.storageChangeListeners) listener(changes, "sync");
    };
    t.after(() => {
        change({
            playerZoomEnabled: false,
            skipControlEnabled: false,
            audioCompressorEnabled: false,
            volumeTooltipEnabled: false,
        });
        for (const observer of observers) observer.disconnectAll ? observer.disconnectAll() : observer.disconnect();
        dom.window.close();
    });
    for (const file of [
        "shared/settings.js",
        "shared/data.js",
        "shared/selectors.js",
        "content.js",
        "shared/volumeControls.js",
        "features/skipControl.js",
        "features/volumeTooltip.js",
        "features/playerZoom.js",
    ])
        w.eval(readRepoFile(file));
    doc.dispatchEvent(new w.Event("DOMContentLoaded"));
    const ids = OWN_CONTROLS.filter((id) => route.startsWith("/live/") || !id.includes("fast-forward"));
    await waitForCondition(() => ids.every((id) => doc.getElementById(id)));
    const removed = [];
    const removals = new w.MutationObserver((mutations) => {
        for (const mutation of mutations)
            for (const node of mutation.removedNodes) {
                for (const id of ids) if (node.id === id || node.querySelector?.(`#${id}`)) removed.push(id);
            }
    });
    removals.observe(player, { childList: true, subtree: true });
    const zoom = (scale, clientX = 300, clientY = 100) => {
        const current = Number(video.style.transform.match(/scale\(([^)]+)\)/)?.[1] || 1);
        const event = new w.WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
            deltaY: (-Math.log(scale / current) / Math.log(1.2)) * 100,
        });
        video.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
    };
    // Both controls use up to 240ms delayed sync. Observe beyond that window to catch removals.
    const settleControls = () => new Promise((resolve) => w.setTimeout(resolve, 360));
    return {
        w,
        doc,
        video,
        player,
        ids,
        removed,
        zoom,
        settleControls,
        change,
        resize(next) {
            viewport = next;
            w.dispatchEvent(new w.Event("resize"));
        },
    };
}

test("control viewport follows pan and resize, then clears on reset, disable and video replacement", async (t) => {
    const f = await fixture(t, "/live/test-channel");
    const viewport = (video = f.video) => {
        const rect = f.w.BetterChzzk.utils.getVideoViewportRect(video);
        return box(rect.left, rect.top, rect.width, rect.height);
    };
    const original = f.ids.map((id) => f.doc.getElementById(id));
    f.zoom(1.5);
    for (const [type, x, y, buttons] of [
        ["pointerdown", 300, 100, 1],
        ["pointermove", 500, 200, 1],
        ["pointerup", 500, 200, 0],
    ]) {
        const event = new f.w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, buttons });
        Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
        f.video.dispatchEvent(event);
    }
    assert.deepEqual(viewport(), box(100, 60, 800, 450));
    const resized = box(80, 50, 960, 540);
    f.resize(resized);
    assert.deepEqual(viewport(), resized);
    await f.settleControls();
    assert.deepEqual(f.removed, []);
    for (const node of original) assert.ok(node.isConnected);
    f.doc.getElementById("betterchzzk-player-zoom-reset").click();
    assert.deepEqual(viewport(), f.video.getBoundingClientRect());
    f.zoom(1.5);
    f.change({ playerZoomEnabled: false });
    assert.deepEqual(viewport(), f.video.getBoundingClientRect());
    f.change({ playerZoomEnabled: true });
    f.zoom(1.5);
    f.w.history.replaceState(null, "", "/live/another-channel");
    f.w.dispatchEvent(new f.w.Event("betterchzzk:routechange"));
    assert.deepEqual(viewport(), f.video.getBoundingClientRect());
    f.zoom(1.5);
    const replacement = f.doc.createElement("video");
    f.video.replaceWith(replacement);
    await waitForCondition(() => f.video.style.transform === "");
    assert.deepEqual(viewport(), f.video.getBoundingClientRect(), "the detached video's zoom record is cleared");
    replacement.style.transform = "translate(10px, 20px) scale(2)";
    assert.deepEqual(
        viewport(replacement),
        replacement.getBoundingClientRect(),
        "unowned transforms keep their native geometry"
    );
});

for (const route of ["/live/test-channel", "/video/123"]) {
    test(`zoom keeps left player controls attached above 150% on ${route}`, async (t) => {
        const f = await fixture(t, route);
        const original = f.ids.map((id) => f.doc.getElementById(id));
        f.zoom(1.5);
        const enlarged = f.video.getBoundingClientRect();
        assert.ok(enlarged.bottom > 660, "the transformed video extends below the native control area");
        await f.settleControls();
        assert.deepEqual(f.removed, [], "zoom must not remove and recreate any left control");
        f.ids.forEach((id, i) => assert.equal(f.doc.getElementById(id), original[i], id));
        for (let i = 0; i < 3; i++) f.zoom(5);
        assert.ok(f.video.style.transform.endsWith("scale(5)"));
        await f.settleControls();
        assert.deepEqual(f.removed, []);
        for (const node of original) assert.ok(node.isConnected);
    });
}
