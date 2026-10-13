const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const {
    createFakeChrome,
    evalRepoScript,
    waitForAsyncCallbacks,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

const SETTINGS_STORE_MESSAGE_TYPE = "betterchzzk:settings-store";
// Longer than the 250 ms skipSeconds save debounce.
const SKIP_SAVE_DEBOUNCE_WAIT_MS = 320;

const PLAYER_HTML = [
    "<!doctype html>",
    "<body>",
    '<div class="pzp pzp-pc" id="playerRoot">',
    '<video id="video"></video>',
    '<div class="pzp-pc__progress-slider" id="seekbar" role="slider" tabindex="0" aria-valuenow="0"></div>',
    '<div class="pzp-pc__bottom-buttons--left" id="controls">',
    '<button class="pzp-pc__playback-switch" id="play" type="button">Play</button>',
    '<div class="pzp-pc__volume-slider" id="volumeSlider" role="slider" tabindex="0" aria-valuenow="50" aria-label="음량"></div>',
    "</div>",
    '<div class="pzp-pc__settings" role="menu">',
    '<div class="pzp-ui-setting-home-item" id="qualityItem" role="menuitem" tabindex="0">화질</div>',
    '<div class="pzp-ui-setting-pane-item" id="rateItem" role="menuitemradio" aria-checked="false" tabindex="0">1.0x</div>',
    "</div>",
    "</div>",
    "</body>",
].join("");

function createTimeRanges(ranges) {
    return {
        length: ranges.length,
        start: (index) => ranges[index][0],
        end: (index) => ranges[index][1],
    };
}

function rect(left, top, width, height) {
    return () => ({ left, top, width, height, right: left + width, bottom: top + height });
}

function nextTask() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitSyncChange(chrome, changes) {
    for (const listener of [...chrome.testState.storageChangeListeners]) listener(changes, "sync");
}

async function openSkipPage(t, { path, sync = {}, video: initial = {}, fakeClock = false }) {
    const chrome = createFakeChrome({ sync: { skipControlEnabled: true, ...sync } });
    const dom = new JSDOM(PLAYER_HTML, {
        url: `https://chzzk.naver.com${path}`,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    dom.window.chrome = chrome;
    dom.window.fetch = async () => {
        throw new Error("Unexpected network request in skip control test");
    };
    const observers = new Set();
    const NativeObserver = dom.window.MutationObserver;
    dom.window.MutationObserver = class extends NativeObserver {
        constructor(callback) {
            super(callback);
            observers.add(this);
        }
    };
    t.after(async () => {
        emitSyncChange(chrome, { skipControlEnabled: { oldValue: true, newValue: false } });
        await waitForAsyncCallbacks();
        for (const observer of observers) observer.disconnect();
        dom.window.close();
    });

    let now = 10000;
    if (fakeClock) Object.defineProperty(dom.window.performance, "now", { configurable: true, value: () => now });

    const { document } = dom.window;
    const video = document.getElementById("video");
    // Writes are recorded only for extension seeks; tests move native playback through state.currentTime.
    const state = { currentTime: 32, paused: false, duration: Infinity, end: 40, writes: [], ...initial };
    Object.defineProperty(video, "currentTime", {
        configurable: true,
        get: () => state.currentTime,
        set: (value) => {
            state.writes.push(Number(value));
            state.currentTime = Number(value);
        },
    });
    Object.defineProperty(video, "paused", { configurable: true, get: () => state.paused });
    Object.defineProperty(video, "duration", { configurable: true, get: () => state.duration });
    Object.defineProperty(video, "buffered", { configurable: true, get: () => createTimeRanges([[0, state.end]]) });
    Object.defineProperty(video, "seekable", { configurable: true, get: () => createTimeRanges([[0, state.end]]) });
    video.getBoundingClientRect = rect(0, 0, 640, 360);
    document.getElementById("seekbar").getBoundingClientRect = rect(40, 302, 560, 12);
    document.getElementById("controls").getBoundingClientRect = rect(16, 316, 180, 40);
    document.getElementById("play").getBoundingClientRect = rect(20, 318, 36, 36);
    document.getElementById("volumeSlider").getBoundingClientRect = rect(64, 326, 80, 20);

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "shared", "vodTimeline.js");
    evalRepoScript(dom, "features", "skipControl.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();

    const fire = (type) => video.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
    return {
        chrome,
        dom,
        document,
        state,
        fire,
        clock: {
            advance(ms) {
                now += ms;
            },
        },
        // Seek-bar drag that the guard records as an explicit user seek.
        armBySeekbar(time) {
            const seekbar = document.getElementById("seekbar");
            seekbar.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
            state.currentTime = time;
            fire("seeking");
            fire("seeked");
            seekbar.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true, cancelable: true }));
        },
        keydown(target, key) {
            const event = new dom.window.KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true });
            target.dispatchEvent(event);
            return event;
        },
    };
}

async function waitForSkipPill(document) {
    await waitForCondition(() => document.getElementById("betterchzzk-skip-pill"));
    return document.getElementById("betterchzzk-skip-pill");
}

function wheelOn(dom, target, init) {
    const event = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
}

test("live timeshift guard yields to a native forward jump that keeps repeating", async (t) => {
    const page = await openSkipPage(t, {
        path: "/live/test-channel",
        sync: { skipLivePauseResumeEnabled: true },
        fakeClock: true,
    });
    const { state, clock, fire } = page;

    page.armBySeekbar(32);
    clock.advance(2000); // past the user seek grace
    state.writes.length = 0;

    // A native jump back to the live edge every 250 ms for 60 s (e.g. stall recovery skipping a buffer gap).
    let firstJumpRestored = false;
    for (let index = 0; index < 240; index += 1) {
        clock.advance(250);
        state.end += 0.25;
        state.currentTime = state.end - 0.5;
        fire("seeking");
        if (index === 0) firstJumpRestored = state.end - state.currentTime > 4;
        await nextTask();
    }

    assert.equal(firstJumpRestored, true, "a single forced live-edge jump is still restored");
    assert.ok(state.writes.length >= 1 && state.writes.length <= 3, `restores: ${state.writes.length}`);
    assert.equal(state.currentTime, state.end - 0.5, "the guard leaves the repeated jump to the native player");

    // The next explicit user seek arms the guard again with a fresh restore budget.
    const armedAt = state.end - 8;
    page.armBySeekbar(armedAt);
    clock.advance(2000);
    const writesBefore = state.writes.length;
    state.currentTime = state.end - 0.5;
    fire("seeking");

    assert.equal(state.writes.length, writesBefore + 1);
    assert.ok(Math.abs(state.currentTime - (armedAt + 2)) < 0.01, `restored to ${state.currentTime}`);
});

test("arrow seek yields to a focused volume slider and settings menu items but keeps the seek bar", async (t) => {
    const page = await openSkipPage(t, {
        path: "/video/123",
        sync: { skipSeconds: 10 },
        video: { currentTime: 100, duration: 3600, end: 3600 },
    });
    const { document, state } = page;

    for (const id of ["volumeSlider", "qualityItem", "rateItem"]) {
        const widget = document.getElementById(id);
        widget.focus();
        let nativeHandled = false;
        const native = () => {
            nativeHandled = true;
        };
        widget.addEventListener("keydown", native);
        const before = state.currentTime;
        const event = page.keydown(widget, "ArrowLeft");
        widget.removeEventListener("keydown", native);

        assert.equal(document.activeElement, widget, id);
        assert.equal(event.defaultPrevented, false, id);
        assert.equal(nativeHandled, true, id);
        assert.equal(state.currentTime, before, id);
    }

    const seekbar = document.getElementById("seekbar");
    seekbar.focus();
    const seekbarEvent = page.keydown(seekbar, "ArrowRight");
    assert.equal(seekbarEvent.defaultPrevented, true);
    assert.equal(state.currentTime, 110);

    seekbar.blur();
    const pageEvent = page.keydown(document.body, "ArrowLeft");
    assert.equal(pageEvent.defaultPrevented, true);
    assert.equal(state.currentTime, 100);
});

test("skip pill wheel follows the dominant axis and leaves Ctrl+wheel zoom to the browser", async (t) => {
    const page = await openSkipPage(t, { path: "/live/test-channel", sync: { skipSeconds: 10 } });
    const { dom, document } = page;
    const pill = await waitForSkipPill(document);
    const value = () => pill.querySelector(".bc-value").textContent;

    // Chromium delivers Shift+wheel as deltaX with deltaY 0; wheel up is negative.
    let event = wheelOn(dom, pill, { shiftKey: true, deltaX: -100 });
    assert.equal(event.defaultPrevented, true);
    assert.equal(value(), "15");
    wheelOn(dom, pill, { shiftKey: true, deltaX: 100 });
    assert.equal(value(), "10");

    // Horizontal trackpad swipes use the dominant axis.
    wheelOn(dom, pill, { deltaX: -40, deltaY: 2 });
    assert.equal(value(), "11");
    wheelOn(dom, pill, { deltaX: 40 });
    assert.equal(value(), "10");

    event = wheelOn(dom, pill, { deltaX: 0, deltaY: 0 });
    assert.equal(event.defaultPrevented, false);
    assert.equal(value(), "10");

    // Ctrl+wheel and trackpad pinch (ctrlKey) stay with the browser zoom.
    event = wheelOn(dom, pill, { ctrlKey: true, deltaY: -100 });
    assert.equal(event.defaultPrevented, false);
    assert.equal(value(), "10");

    event = wheelOn(dom, pill, { deltaY: -100 });
    assert.equal(event.defaultPrevented, true);
    assert.equal(value(), "11");
    await delay(SKIP_SAVE_DEBOUNCE_WAIT_MS);
});

test("skip seconds keep a pending or failed wheel value until storage changes elsewhere", async (t) => {
    const page = await openSkipPage(t, { path: "/live/test-channel", sync: { skipSeconds: 10 } });
    const { chrome, dom, document, state } = page;
    const pill = await waitForSkipPill(document);
    const value = () => pill.querySelector(".bc-value").textContent;
    const saves = [];
    let failSaves = false;
    const forward = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (message, callback) => {
        if (message?.type === SETTINGS_STORE_MESSAGE_TYPE) {
            saves.push({ ...message.values }); // copy out of the page realm for deepEqual
            if (failSaves) {
                setTimeout(() => callback?.({ ok: false, error: "storage-write-failed" }), 0);
                return;
            }
        }
        forward(message, callback);
    };

    // An unrelated option change during the save debounce keeps the new value and still saves it.
    wheelOn(dom, pill, { deltaY: -100 });
    assert.equal(value(), "11");
    emitSyncChange(chrome, { volumeWheelStep: { oldValue: 5, newValue: 6 } });
    assert.equal(value(), "11");
    await delay(SKIP_SAVE_DEBOUNCE_WAIT_MS);
    assert.deepEqual(saves.at(-1), { skipSeconds: 11 });

    // The late echo of that save does not revert a newer value that is still waiting to be saved.
    wheelOn(dom, pill, { deltaY: -100 });
    assert.equal(value(), "12");
    emitSyncChange(chrome, { skipSeconds: { oldValue: 10, newValue: 11 } });
    assert.equal(value(), "12");
    await delay(SKIP_SAVE_DEBOUNCE_WAIT_MS);
    assert.deepEqual(saves.at(-1), { skipSeconds: 12 });
    emitSyncChange(chrome, { skipSeconds: { oldValue: 11, newValue: 12 } });

    // A failed save keeps the value in this document across unrelated option changes.
    failSaves = true;
    wheelOn(dom, pill, { deltaY: -100 });
    await delay(SKIP_SAVE_DEBOUNCE_WAIT_MS);
    assert.deepEqual(saves.at(-1), { skipSeconds: 13 });
    emitSyncChange(chrome, { volumeWheelStep: { oldValue: 6, newValue: 7 } });
    assert.equal(value(), "13");
    page.keydown(document.body, "ArrowLeft");
    assert.equal(state.currentTime, 19);

    // A value stored elsewhere (options page or another tab) still replaces it.
    emitSyncChange(chrome, { skipSeconds: { oldValue: 12, newValue: 30 } });
    assert.equal(value(), "30");
});

test("volume wheel leaves Ctrl+wheel and trackpad pinch zoom to the browser", async (t) => {
    const chrome = createFakeChrome();
    const dom = new JSDOM(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol">',
            '<button class="pzp-pc__volume-button" type="button"></button>',
            '<input id="slider" type="range" min="0" max="100" value="50">',
            "</div>",
            "</body>",
        ].join(""),
        { url: "https://chzzk.naver.com/live/test-channel", runScripts: "outside-only", pretendToBeVisual: true }
    );
    t.after(() => dom.window.close());
    dom.window.chrome = chrome;
    dom.window.fetch = async () => {
        throw new Error("Unexpected network request in volume wheel test");
    };
    const { document } = dom.window;
    const video = document.getElementById("video");
    const vol = document.getElementById("vol");
    video.volume = 0.5;
    video.getBoundingClientRect = rect(0, 0, 640, 360);
    vol.getBoundingClientRect = rect(20, 320, 40, 40);

    evalRepoScript(dom, "shared", "volumeControlsPage.js");
    evalRepoScript(dom, "features", "volumeWheelPage.js");
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "volumeWheel.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const pinch = wheelOn(dom, vol, { ctrlKey: true, deltaY: -100 });
    assert.equal(pinch.defaultPrevented, false);
    await nextTask();
    assert.equal(video.volume, 0.5);

    const up = wheelOn(dom, vol, { deltaY: -100 });
    assert.equal(up.defaultPrevented, true);
    assert.ok(Math.abs(video.volume - 0.55) < 1e-6);
});
