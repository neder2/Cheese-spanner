const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const {
    createFakeChrome,
    dispatchTrusted,
    evalRepoScript,
    waitForAsyncCallbacks,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

const SETTINGS_STORE_MESSAGE_TYPE = "cheese-spanner:settings-store";
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
    await waitForCondition(() => document.getElementById("cheese-spanner-skip-pill"));
    return document.getElementById("cheese-spanner-skip-pill");
}

// Models the user's wheel; page-dispatched wheels never change the amount (see extension-pages.test.js).
function wheelOn(dom, target, init) {
    return dispatchTrusted(target, new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }));
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

test("skip seconds ignore an older save's echo while a newer save is still in flight", async (t) => {
    const page = await openSkipPage(t, { path: "/live/test-channel", sync: { skipSeconds: 10 } });
    const { chrome, dom, document, state } = page;
    const pill = await waitForSkipPill(document);
    const value = () => pill.querySelector(".bc-value").textContent;
    const held = [];
    chrome.runtime.sendMessage = (message, callback) => {
        // Every save stays unanswered until the test answers it, like a slow worker queue.
        if (message?.type === SETTINGS_STORE_MESSAGE_TYPE) held.push({ values: { ...message.values }, callback });
    };

    wheelOn(dom, pill, { deltaY: -100 });
    await delay(SKIP_SAVE_DEBOUNCE_WAIT_MS);
    wheelOn(dom, pill, { deltaY: -100 });
    await delay(SKIP_SAVE_DEBOUNCE_WAIT_MS);
    assert.deepEqual(
        held.map((row) => row.values),
        [{ skipSeconds: 11 }, { skipSeconds: 12 }]
    );
    assert.equal(value(), "12");

    // The first save lands and echoes while the second is still waiting in the queue.
    emitSyncChange(chrome, { skipSeconds: { oldValue: 10, newValue: 11 } });
    held[0].callback({ ok: true });
    await nextTask();
    assert.equal(value(), "12");

    // Even if the newer save fails, this document keeps the user's latest choice.
    held[1].callback({ ok: false, error: "storage-write-failed" });
    await nextTask();
    assert.equal(value(), "12");
    page.keydown(document.body, "ArrowLeft");
    assert.equal(state.currentTime, 20);

    // A value stored elsewhere after the saves settle still replaces it.
    emitSyncChange(chrome, { skipSeconds: { oldValue: 11, newValue: 30 } });
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

// Holds the pause-resume restore retries (the only 180 ms timer in skipControl) so a test steps them with the fake
// clock instead of waiting the real 8 s window. Every other timer keeps the real scheduler.
const RESUME_RESTORE_RETRY_MS = 180;

function holdResumeRestoreRetries(t, dom) {
    const win = dom.window;
    const realSetTimeout = win.setTimeout;
    const realClearTimeout = win.clearTimeout;
    const held = new Map();
    let nextId = -1;
    win.setTimeout = function (callback, ms, ...args) {
        if (ms !== RESUME_RESTORE_RETRY_MS) return realSetTimeout.call(win, callback, ms, ...args);
        const id = nextId;
        nextId -= 1;
        held.set(id, () => callback(...args));
        return id;
    };
    win.clearTimeout = function (id) {
        if (held.delete(id)) return;
        realClearTimeout.call(win, id);
    };
    t.after(() => {
        win.setTimeout = realSetTimeout;
        win.clearTimeout = realClearTimeout;
    });
    return {
        get pending() {
            return held.size;
        },
        runDue() {
            const due = [...held.values()];
            held.clear();
            for (const run of due) run();
        },
    };
}

async function openResumeRestorePage(t, { sync = {} } = {}) {
    const page = await openSkipPage(t, {
        path: "/live/test-channel",
        sync: { skipLivePauseResumeEnabled: true, skipSeconds: 10, ...sync },
        video: { currentTime: 100, end: 200, playbackRate: 1 },
        fakeClock: true,
    });
    const video = page.document.getElementById("video");
    Object.defineProperty(video, "playbackRate", {
        configurable: true,
        get: () => page.state.playbackRate,
        set: (value) => {
            page.state.playbackRate = Number(value);
        },
    });
    const retries = holdResumeRestoreRetries(t, page.dom);
    return {
        ...page,
        retries,
        // K pause (user-armed snapshot at the current time), 20 s paused, then the browser's resume events.
        pauseAndResume({ resumeAt, events }) {
            page.keydown(page.document.body, "k");
            page.state.paused = true;
            page.fire("pause");
            page.clock.advance(20000);
            page.state.end += 20;
            page.state.paused = false;
            page.state.currentTime = resumeAt;
            for (const type of events) page.fire(type);
        },
        // One restore retry period of native playback at the current rate.
        tick() {
            page.clock.advance(RESUME_RESTORE_RETRY_MS);
            page.state.currentTime += (RESUME_RESTORE_RETRY_MS / 1000) * page.state.playbackRate;
            retries.runDue();
        },
    };
}

test("pause-resume restore leaves the user's own arrow skip after resuming", async (t) => {
    const page = await openResumeRestorePage(t);
    const { state, document, retries } = page;

    // The native jump to the live edge at resume is still undone.
    page.pauseAndResume({ resumeAt: state.end, events: ["play"] });
    assert.deepEqual(state.writes, [100]);
    for (let index = 0; index < 5; index += 1) page.tick();
    assert.ok(Math.abs(state.currentTime - 100.9) < 1e-6, `before the skip: ${state.currentTime}`);

    state.writes.length = 0;
    const event = page.keydown(document.body, "ArrowRight");
    assert.equal(event.defaultPrevented, true);
    assert.ok(Math.abs(state.currentTime - 110.9) < 1e-6);

    for (let index = 0; index < 5; index += 1) page.tick();
    // The skip rebuffers; its playing must not restart the restore toward the paused position.
    page.fire("playing");
    for (let index = 0; index < 5; index += 1) page.tick();

    assert.equal(state.writes.length, 1, `writes: ${state.writes}`);
    assert.ok(Math.abs(state.currentTime - 112.7) < 1e-6, `after the skip: ${state.currentTime}`);
    assert.equal(retries.pending, 0);
});

test("pause-resume restore leaves a seek-bar seek and its rebuffer playing after resuming", async (t) => {
    const page = await openResumeRestorePage(t);
    const { state, retries } = page;

    page.pauseAndResume({ resumeAt: 100, events: ["play", "playing"] });
    for (let index = 0; index < 10; index += 1) page.tick();
    assert.deepEqual(state.writes, []);

    page.armBySeekbar(150);
    page.fire("playing");
    for (let index = 0; index < 5; index += 1) page.tick();

    assert.deepEqual(state.writes, []);
    assert.ok(Math.abs(state.currentTime - 150.9) < 1e-6, `after the seek: ${state.currentTime}`);
    assert.equal(retries.pending, 0);
});

test("pause-resume restore keeps one window when play and playing both arrive", async (t) => {
    const page = await openResumeRestorePage(t);
    const { state, retries } = page;

    page.pauseAndResume({ resumeAt: 100, events: ["play", "playing"] });

    // 5 s into the 8 s window a native jump to the live edge is still undone.
    for (let index = 0; index < 28; index += 1) page.tick();
    assert.deepEqual(state.writes, []);
    const expected = state.currentTime + 0.18;
    state.currentTime = state.end;
    page.clock.advance(RESUME_RESTORE_RETRY_MS);
    retries.runDue();
    assert.equal(state.writes.length, 1, "restored 5 s after resuming");
    assert.ok(Math.abs(state.currentTime - expected) < 1e-6, `restored to ${state.currentTime}`);
    assert.equal(retries.pending, 1, "one retry chain");

    // The restore still ends with its window; it is not a continuous position lock.
    for (let index = 0; index < 30 && retries.pending; index += 1) page.tick();
    assert.equal(retries.pending, 0);
    state.writes.length = 0;
    state.currentTime = state.end;
    page.fire("playing");
    retries.runDue();
    assert.deepEqual(state.writes, []);
});

test("pause-resume restore follows a faster playback rate instead of rewinding it", async (t) => {
    const page = await openResumeRestorePage(t);
    const { state, retries } = page;

    page.pauseAndResume({ resumeAt: 100, events: ["play"] });
    state.playbackRate = 2; // Space hold or a fixed-rate shortcut right after resuming
    for (let index = 0; index < 20; index += 1) page.tick();

    assert.deepEqual(state.writes, []);
    assert.ok(Math.abs(state.currentTime - 107.2) < 1e-6, `at 2x: ${state.currentTime}`);

    // A native jump at 2x is still undone to the rate-aware position.
    state.currentTime = state.end;
    page.clock.advance(RESUME_RESTORE_RETRY_MS);
    retries.runDue();
    assert.equal(state.writes.length, 1);
    assert.ok(Math.abs(state.currentTime - 107.56) < 1e-6, `restored to ${state.currentTime}`);
});

test("arrow seek yields to the extension's VOD comment tabs and multiview window controls", async (t) => {
    // The yielded selectors mirror markup owned by these modules; keep them in step.
    const repoRoot = require("node:path").join(__dirname, "..");
    const read = (...parts) => require("node:fs").readFileSync(require("node:path").join(repoRoot, ...parts), "utf8");
    const vodView = read("features", "vodComments", "view.js");
    assert.match(vodView, /TABLIST_ID = "cheese-spanner-vod-comment-tabs"/);
    assert.match(vodView, /button\.setAttribute\("role", "tab"\)/);
    const layout = read("features", "liveMultiview", "layoutControls.js");
    assert.match(layout, /el\("div", "bcmv-corner"\)/);
    assert.match(layout, /cell\.tabIndex = 0/);

    const pressOn = (page, widget, key) => {
        widget.focus();
        let ownerHandled = 0;
        const owner = () => {
            ownerHandled += 1;
        };
        widget.parentElement.addEventListener("keydown", owner);
        const before = page.state.currentTime;
        const event = page.keydown(widget, key);
        widget.parentElement.removeEventListener("keydown", owner);
        return { event, ownerHandled, moved: page.state.currentTime - before };
    };

    const vod = await openSkipPage(t, {
        path: "/video/123",
        sync: { skipSeconds: 5 },
        video: { currentTime: 100, duration: 3600, end: 3600 },
    });
    const tablist = vod.document.createElement("div");
    tablist.id = "cheese-spanner-vod-comment-tabs";
    tablist.setAttribute("role", "tablist");
    tablist.innerHTML =
        '<button id="chatTab" type="button" role="tab">채팅</button>' +
        '<button id="commentTab" type="button" role="tab">댓글</button>';
    vod.document.body.append(tablist);
    for (const key of ["ArrowRight", "ArrowLeft"]) {
        const result = pressOn(vod, vod.document.getElementById("chatTab"), key);
        assert.equal(result.event.defaultPrevented, false, key);
        assert.equal(result.ownerHandled, 1, key);
        assert.equal(result.moved, 0, key);
    }
    // A plain button elsewhere still seeks.
    const other = vod.document.createElement("button");
    vod.document.body.append(other);
    const otherResult = pressOn(vod, other, "ArrowRight");
    assert.equal(otherResult.event.defaultPrevented, true);
    assert.equal(otherResult.moved, 5);

    const live = await openSkipPage(t, {
        path: "/live/test-channel",
        sync: { skipSeconds: 5 },
        video: { currentTime: 100, end: 200 },
    });
    const overlay = live.document.createElement("div");
    overlay.className = "bcmv-overlay";
    overlay.innerHTML =
        '<div class="bcmv-cell" data-bcmv-channel="a" tabindex="0">' +
        '<div class="bcmv-corner" data-corner="se" tabindex="0" role="button"></div></div>' +
        '<div class="bcmv-cell" data-bcmv-channel="b"><button id="cellButton" type="button">음소거</button></div>';
    live.document.body.append(overlay);
    for (const widget of [overlay.querySelector(".bcmv-cell"), overlay.querySelector(".bcmv-corner")]) {
        for (const key of ["ArrowRight", "ArrowLeft"]) {
            const result = pressOn(live, widget, key);
            assert.equal(result.event.defaultPrevented, false, `${widget.className} ${key}`);
            assert.equal(result.ownerHandled, 1, `${widget.className} ${key}`);
            assert.equal(result.moved, 0, `${widget.className} ${key}`);
        }
    }
    // A button inside a tile-mode cell (no tabindex on the cell) is not a multiview arrow widget.
    const cellButton = pressOn(live, live.document.getElementById("cellButton"), "ArrowRight");
    assert.equal(cellButton.event.defaultPrevented, true);
    assert.equal(cellButton.moved, 5);
});

// Restore retries while the video does not move (buffering after play or a rebuffer).
function stallFor(page, ticks) {
    for (let index = 0; index < ticks; index += 1) {
        page.clock.advance(RESUME_RESTORE_RETRY_MS);
        page.retries.runDue();
    }
}

// The native jump to the live edge with its playing event, then the next retry.
function nativeJumpWithPlaying(page) {
    page.state.currentTime = page.state.end;
    page.fire("playing");
    page.clock.advance(RESUME_RESTORE_RETRY_MS);
    page.retries.runDue();
}

test("pause-resume restore does not count a buffering stall as played time", async (t) => {
    // No progress for about 3 s after play: the jump is undone to the paused position, not 3 s past it.
    const stalled = await openResumeRestorePage(t);
    stalled.pauseAndResume({ resumeAt: 100, events: ["play", "waiting"] });
    stallFor(stalled, 17);
    assert.deepEqual(stalled.state.writes, []);
    nativeJumpWithPlaying(stalled);
    assert.equal(stalled.state.writes.length, 1);
    assert.ok(Math.abs(stalled.state.currentTime - 100) < 0.25, `after a stall: ${stalled.state.currentTime}`);

    // About 2 s of normal playback, then about 3 s of rebuffering: the played 2 s stay, the stall does not count.
    const partial = await openResumeRestorePage(t);
    partial.pauseAndResume({ resumeAt: 100, events: ["play", "playing"] });
    for (let index = 0; index < 11; index += 1) partial.tick();
    const played = partial.state.currentTime;
    assert.ok(Math.abs(played - 101.98) < 1e-6, `played: ${played}`);
    partial.fire("waiting");
    stallFor(partial, 17);
    nativeJumpWithPlaying(partial);
    assert.equal(partial.state.writes.length, 1);
    assert.ok(
        Math.abs(partial.state.currentTime - played) < 0.25,
        `after play and a stall: ${partial.state.currentTime}`
    );
    // Playback after the restore keeps one chain within the original window.
    assert.equal(partial.retries.pending, 1);
});

test("pause-resume restore keeps undoing native jumps after non-seek arrow keys but ends on a real seek", async (t) => {
    // Arrows that a focused volume slider, menu item or multiview grip uses do not end the restore.
    const widgets = await openResumeRestorePage(t);
    const corner = widgets.document.createElement("div");
    corner.className = "bcmv-corner";
    corner.tabIndex = 0;
    widgets.document.body.append(corner);
    widgets.pauseAndResume({ resumeAt: 100, events: ["play", "playing"] });
    for (const widget of [
        widgets.document.getElementById("volumeSlider"),
        widgets.document.getElementById("rateItem"),
        corner,
    ]) {
        widgets.tick();
        widget.focus();
        const before = widgets.state.currentTime;
        const event = widgets.keydown(widget, "ArrowRight");
        assert.equal(event.defaultPrevented, false, widget.id || widget.className);
        assert.equal(widgets.state.currentTime, before, widget.id || widget.className);
        widgets.state.writes.length = 0;
        const expected = before + 0.18;
        nativeJumpWithPlaying(widgets);
        assert.equal(widgets.state.writes.length, 1, `restored after ${widget.id || widget.className}`);
        assert.ok(Math.abs(widgets.state.currentTime - expected) < 1e-6, `restored to ${widgets.state.currentTime}`);
    }

    // During a stall, a volume arrow is not a seek either.
    const stalled = await openResumeRestorePage(t);
    stalled.pauseAndResume({ resumeAt: 100, events: ["play", "waiting"] });
    stallFor(stalled, 12);
    const volume = stalled.document.getElementById("volumeSlider");
    volume.focus();
    stalled.keydown(volume, "ArrowRight");
    stallFor(stalled, 1);
    nativeJumpWithPlaying(stalled);
    assert.equal(stalled.state.writes.length, 1);
    assert.ok(Math.abs(stalled.state.currentTime - 100) < 0.25, `after a stall: ${stalled.state.currentTime}`);

    // Contrast: the player's own L seek and a seek-bar seek during a stall are left where the user put them.
    const nativeKey = await openResumeRestorePage(t);
    nativeKey.pauseAndResume({ resumeAt: 100, events: ["play", "waiting"] });
    stallFor(nativeKey, 12);
    nativeKey.keydown(nativeKey.document.body, "l");
    nativeKey.state.currentTime = 110;
    nativeKey.fire("seeking");
    nativeKey.fire("seeked");
    nativeKey.fire("playing");
    for (let index = 0; index < 5; index += 1) nativeKey.tick();
    assert.deepEqual(nativeKey.state.writes, []);
    assert.ok(Math.abs(nativeKey.state.currentTime - 110.9) < 1e-6, `after L: ${nativeKey.state.currentTime}`);
    assert.equal(nativeKey.retries.pending, 0);

    const seekbar = await openResumeRestorePage(t);
    seekbar.pauseAndResume({ resumeAt: 100, events: ["play", "waiting"] });
    stallFor(seekbar, 12);
    seekbar.armBySeekbar(150);
    seekbar.fire("playing");
    for (let index = 0; index < 5; index += 1) seekbar.tick();
    assert.deepEqual(seekbar.state.writes, []);
    assert.ok(Math.abs(seekbar.state.currentTime - 150.9) < 1e-6, `after the seek bar: ${seekbar.state.currentTime}`);
    assert.equal(seekbar.retries.pending, 0);
});

// One restore retry period in which native playback moved by `moved` seconds (whatever the nominal rate).
function stepBy(page, moved, ms = RESUME_RESTORE_RETRY_MS) {
    page.clock.advance(ms);
    page.state.currentTime += moved;
    page.retries.runDue();
}

test("pause-resume restore keeps the real progress of repeated partial stalls and coarse time updates", async (t) => {
    // 2x, but each 180 ms retry period only plays 100 ms (0.2 s of media): about 3.4 s of these short stalls must not
    // move the restore target ahead of where the video really was.
    const pulsed = await openResumeRestorePage(t);
    pulsed.pauseAndResume({ resumeAt: 100, events: ["play", "playing"] });
    pulsed.state.playbackRate = 2;
    for (let index = 0; index < 19; index += 1) stepBy(pulsed, 0.2);
    const pulsedAt = pulsed.state.currentTime;
    assert.ok(Math.abs(pulsedAt - 103.8) < 1e-6, `pulsed: ${pulsedAt}`);
    assert.deepEqual(pulsed.state.writes, []);
    nativeJumpWithPlaying(pulsed);
    assert.equal(pulsed.state.writes.length, 1);
    // The jump's own retry period is credited with the played share (0.2 of 0.36 s), not the full 2x period.
    assert.ok(
        Math.abs(pulsed.state.currentTime - (pulsedAt + 0.2)) < 0.05,
        `after partial stalls: ${pulsed.state.currentTime}`
    );

    // 2x with currentTime updated every 360 ms (0 then 0.72 s per retry): normal playback, nothing to undo.
    const stepped = await openResumeRestorePage(t);
    stepped.pauseAndResume({ resumeAt: 100, events: ["play", "playing"] });
    stepped.state.playbackRate = 2;
    for (let index = 0; index < 30; index += 1) stepBy(stepped, index % 2 ? 0.72 : 0);
    assert.deepEqual(stepped.state.writes, [], `coarse updates: ${stepped.state.writes}`);
    const steppedAt = stepped.state.currentTime;
    assert.ok(Math.abs(steppedAt - 110.8) < 1e-6, `stepped: ${steppedAt}`);
    // A real jump is still undone near the position the video had reached.
    nativeJumpWithPlaying(stepped);
    assert.equal(stepped.state.writes.length, 1);
    assert.ok(
        Math.abs(stepped.state.currentTime - steppedAt) < 0.4,
        `after coarse updates: ${stepped.state.currentTime}`
    );

    // A late retry (busy main thread) at 2x and a stall followed by a catch-up are normal playback too.
    const late = await openResumeRestorePage(t);
    late.pauseAndResume({ resumeAt: 100, events: ["play", "playing"] });
    late.state.playbackRate = 2;
    for (let index = 0; index < 5; index += 1) stepBy(late, 0.36);
    stepBy(late, 2.9, 1450);
    for (let index = 0; index < 4; index += 1) stepBy(late, 0);
    stepBy(late, 0.72);
    for (let index = 0; index < 5; index += 1) stepBy(late, 0.36);
    assert.deepEqual(late.state.writes, [], `late retry: ${late.state.writes}`);
});

test("pause-resume restore stays cancelled after a user seek even across blur or a late retry", async (t) => {
    // Every case below must keep the user's position and leave no restore or snapshot behind.
    async function expectSeekKept(label, seek, landedAt) {
        const page = await openResumeRestorePage(t);
        page.pauseAndResume({ resumeAt: 100, events: ["play", "playing"] });
        for (let index = 0; index < 5; index += 1) page.tick();
        seek(page);
        page.fire("playing");
        for (let index = 0; index < 5; index += 1) page.tick();
        assert.deepEqual(page.state.writes, [], `${label}: ${page.state.writes}`);
        assert.ok(Math.abs(page.state.currentTime - (landedAt + 0.9)) < 1e-6, `${label}: ${page.state.currentTime}`);
        assert.equal(page.retries.pending, 0, label);
        // The snapshot is gone too: a later native jump with playing is not pulled back to the paused position.
        page.state.currentTime = page.state.end;
        page.fire("playing");
        page.retries.runDue();
        assert.deepEqual(page.state.writes, [], `${label} snapshot`);
    }
    const blur = (page) => page.dom.window.dispatchEvent(new page.dom.window.Event("blur"));
    const nativeL = (page, { busyMs = 0, eventsBeforeRetry = true } = {}) => {
        page.keydown(page.document.body, "l");
        page.state.currentTime = 110;
        if (busyMs) page.clock.advance(busyMs);
        if (eventsBeforeRetry) {
            page.fire("seeking");
            page.fire("seeked");
        } else {
            page.retries.runDue();
        }
    };

    await expectSeekKept("seek bar", (page) => page.armBySeekbar(150), 150);
    await expectSeekKept(
        "seek bar then blur",
        (page) => {
            page.armBySeekbar(150);
            blur(page);
        },
        150
    );
    await expectSeekKept(
        "L then blur",
        (page) => {
            nativeL(page);
            blur(page);
        },
        110
    );
    await expectSeekKept("L with a 1.45 s busy thread", (page) => nativeL(page, { busyMs: 1450 }), 110);
    await expectSeekKept(
        "L seen first by a 1.45 s late retry",
        (page) => nativeL(page, { busyMs: 1450, eventsBeforeRetry: false }),
        110
    );

    // Blur, tab hide or focus moves that arrive before the move's seeking event (r3-m2 order: click -> currentTime
    // write -> element blur -> seeking). currentTime already reports the move, so the seek is still the user's.
    const elementBlur = (page, element = page.document.getElementById("seekbar")) =>
        element.dispatchEvent(new page.dom.window.FocusEvent("blur", { bubbles: false }));
    const hideTab = (page, hidden) => {
        Object.defineProperty(page.document, "hidden", { configurable: true, get: () => hidden });
        page.document.dispatchEvent(new page.dom.window.Event("visibilitychange"));
    };
    const clickSeekbar = (page, phase) => {
        const seekbar = page.document.getElementById("seekbar");
        seekbar.dispatchEvent(new page.dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        phase?.("down");
        seekbar.dispatchEvent(new page.dom.window.Event("pointerup", { bubbles: true, cancelable: true }));
        phase?.("up");
    };
    const mediaEvents = (page) => {
        page.fire("seeking");
        page.fire("seeked");
    };
    await expectSeekKept(
        "seek bar move, element blur, then seeking",
        (page) => {
            clickSeekbar(page);
            page.state.currentTime = 150;
            elementBlur(page);
            mediaEvents(page);
        },
        150
    );
    await expectSeekKept(
        "seek bar move, window blur, then seeking",
        (page) => {
            clickSeekbar(page);
            page.state.currentTime = 150;
            blur(page);
            mediaEvents(page);
        },
        150
    );
    await expectSeekKept(
        "seek bar move, window blur, retry before seeking",
        (page) => {
            clickSeekbar(page);
            page.state.currentTime = 150;
            blur(page);
            page.clock.advance(RESUME_RESTORE_RETRY_MS);
            page.retries.runDue();
            mediaEvents(page);
        },
        150
    );
    await expectSeekKept(
        "L move, hidden tab, then seeking",
        (page) => {
            page.keydown(page.document.body, "l");
            page.state.currentTime = 110;
            hideTab(page, true);
            mediaEvents(page);
            hideTab(page, false);
        },
        110
    );
    // Focus leaving the chat input when the seek bar is pressed must not drop a seek that the release applies.
    await expectSeekKept(
        "chat input blurred by the seek-bar press, seek applied on release",
        (page) => {
            const chatInput = page.document.createElement("input");
            page.document.body.append(chatInput);
            clickSeekbar(page, (phase) => {
                if (phase === "down") elementBlur(page, chatInput);
                if (phase === "up") page.state.currentTime = 150;
            });
            mediaEvents(page);
        },
        150
    );

    // Contrast: a blur or tab hide without a move still drops the intent, so the native jump that follows (the
    // return from another window or tab) is undone; a focus move alone never ends the protection either.
    for (const [label, loseFocus] of [
        ["window blur", (page) => blur(page)],
        [
            "hidden tab",
            (page) => {
                hideTab(page, true);
                hideTab(page, false);
            },
        ],
        [
            "element blur after the grace",
            (page) => {
                elementBlur(page);
                for (let index = 0; index < 8; index += 1) page.tick();
            },
        ],
    ]) {
        const page = await openResumeRestorePage(t);
        page.pauseAndResume({ resumeAt: 100, events: ["play", "playing"] });
        for (let index = 0; index < 5; index += 1) page.tick();
        clickSeekbar(page);
        loseFocus(page);
        assert.deepEqual(page.state.writes, [], `${label}: no move, no write`);
        assert.equal(page.retries.pending, 1, `${label}: the restore keeps running`);
        const expected = page.state.currentTime + 0.18;
        nativeJumpWithPlaying(page);
        assert.equal(page.state.writes.length, 1, `${label}: native jump undone`);
        assert.ok(Math.abs(page.state.currentTime - expected) < 1e-6, `${label}: ${page.state.currentTime}`);
    }

    // Contrast: a small explicit seek inside the allowed drift is kept as is, and the protection continues from it.
    const small = await openResumeRestorePage(t);
    small.pauseAndResume({ resumeAt: 100, events: ["play", "playing"] });
    for (let index = 0; index < 5; index += 1) small.tick();
    clickSeekbar(small);
    small.state.currentTime += 1;
    blur(small);
    mediaEvents(small);
    for (let index = 0; index < 8; index += 1) small.tick();
    assert.deepEqual(small.state.writes, [], `small seek: ${small.state.writes}`);
    assert.ok(Math.abs(small.state.currentTime - 103.34) < 1e-6, `small seek kept: ${small.state.currentTime}`);
    const smallExpected = small.state.currentTime + 0.18;
    nativeJumpWithPlaying(small);
    assert.equal(small.state.writes.length, 1, "a native jump after the small seek is undone");
    assert.ok(Math.abs(small.state.currentTime - smallExpected) < 1e-6, `after small seek: ${small.state.currentTime}`);

    // Contrast: an L the player ignored does not excuse a native jump that comes after the next retries.
    const ignored = await openResumeRestorePage(t);
    ignored.pauseAndResume({ resumeAt: 100, events: ["play", "playing"] });
    for (let index = 0; index < 5; index += 1) ignored.tick();
    ignored.keydown(ignored.document.body, "l");
    for (let index = 0; index < 8; index += 1) ignored.tick();
    const expected = ignored.state.currentTime + 0.18;
    nativeJumpWithPlaying(ignored);
    assert.equal(ignored.state.writes.length, 1, "native jump after an ignored L");
    assert.ok(Math.abs(ignored.state.currentTime - expected) < 1e-6, `restored to ${ignored.state.currentTime}`);
});

test("keys inside the stream info panel are neither a live seek intent nor a skip, outside keys still are", async (t) => {
    // The stream info panel (streamInfo.js) sits inside the player and owns every key pressed in it.
    async function openWithPanel() {
        const page = await openResumeRestorePage(t);
        const panel = page.document.createElement("div");
        panel.id = "cheese-spanner-stream-info";
        const close = page.document.createElement("button");
        close.type = "button";
        close.setAttribute("aria-label", "스트림 정보 닫기");
        panel.append(close);
        page.document.getElementById("playerRoot").append(panel);
        let panelKeys = 0;
        panel.addEventListener("keydown", () => {
            panelKeys += 1;
        });
        page.pauseAndResume({ resumeAt: 100, events: ["play", "playing"] });
        for (let index = 0; index < 5; index += 1) page.tick();
        return { ...page, close, panelKeys: () => panelKeys };
    }

    for (const key of ["l", "j", "ArrowRight", "ArrowLeft"]) {
        const page = await openWithPanel();
        page.close.focus();
        const event = page.keydown(page.close, key);
        assert.equal(event.defaultPrevented, false, `${key} keeps its default in the panel`);
        assert.equal(page.panelKeys(), 1, `${key} reaches the panel's own handler`);
        assert.deepEqual(page.state.writes, [], `${key} in the panel does not seek`);
        // The next native jump is not excused as the user's seek: it is undone.
        const expected = page.state.currentTime + 0.18;
        nativeJumpWithPlaying(page);
        assert.equal(page.state.writes.length, 1, `native jump after ${key} in the panel is undone`);
        assert.ok(Math.abs(page.state.currentTime - expected) < 1e-6, `${key}: ${page.state.currentTime}`);
    }

    // Contrast: L outside the panel is the user's seek, so the move it makes is kept.
    const outside = await openWithPanel();
    outside.keydown(outside.document.body, "l");
    outside.state.currentTime = 110;
    outside.fire("seeking");
    outside.fire("seeked");
    for (let index = 0; index < 5; index += 1) outside.tick();
    assert.deepEqual(outside.state.writes, []);
    assert.ok(Math.abs(outside.state.currentTime - 110.9) < 1e-6, `outside: ${outside.state.currentTime}`);
    // An outside arrow keeps the configured skip.
    const arrow = await openWithPanel();
    const before = arrow.state.currentTime;
    assert.equal(arrow.keydown(arrow.document.body, "ArrowRight").defaultPrevented, true);
    assert.ok(Math.abs(arrow.state.currentTime - (before + 10)) < 1e-6, `outside arrow: ${arrow.state.currentTime}`);
});

// Live ad wrappers from the 2026-11-05 public bundle. The mid-roll wrapper is a sibling outside the main player and
// toggles its display; its #midPlayer placeholder and the ad video are larger than the main mini player.
function appendLiveAdWrapper(page, { id = "midAdPlayerWrapper", display = "block" } = {}) {
    const { document } = page;
    const wrapper = document.createElement("div");
    wrapper.id = id;
    if (id === "midAdPlayerWrapper") {
        wrapper.style.display = display;
        wrapper.innerHTML = '<video id="midPlayer"></video><div id="midAdVideoContainer"></div>';
    } else {
        wrapper.innerHTML = '<video id="preAdContentPlayer"></video><div id="preAdVideoContainer"></div>';
    }
    document.body.append(wrapper);
    const placeholder = wrapper.querySelector("video");
    const ad = { currentTime: 5, paused: false, writes: [] };
    Object.defineProperty(placeholder, "currentTime", {
        configurable: true,
        get: () => ad.currentTime,
        set: (value) => {
            ad.writes.push(Number(value));
            ad.currentTime = Number(value);
        },
    });
    Object.defineProperty(placeholder, "paused", { configurable: true, get: () => ad.paused });
    placeholder.getBoundingClientRect = rect(0, 0, 1920, 1080);
    return { wrapper, placeholder, ad };
}

// Past the 160 ms DOM sync throttle and its animation frame.
async function waitForSkipDomSync() {
    await delay(250);
    await waitForAsyncCallbacks();
}

test("arrow and paused frame-step keys pass a live mid-roll through without seeking the main or the ad video", async (t) => {
    const page = await openSkipPage(t, { path: "/live/test-channel", video: { currentTime: 100, end: 200 } });
    const { document, state } = page;
    const { wrapper, ad } = appendLiveAdWrapper(page);
    await waitForSkipDomSync();

    for (const key of ["ArrowRight", "ArrowLeft"]) {
        const event = page.keydown(document.body, key);
        assert.equal(event.defaultPrevented, false, `${key} stays with the native player during the ad`);
    }
    state.paused = true;
    ad.paused = true;
    for (const key of [".", ","]) {
        const event = page.keydown(document.body, key);
        assert.equal(event.defaultPrevented, false, `${key} stays with the native player during the ad`);
    }
    assert.deepEqual(state.writes, [], "the hidden main is not seeked");
    assert.deepEqual(ad.writes, [], "the ad placeholder is not seeked");

    // After the break the configured skip applies to the main video again.
    wrapper.style.display = "none";
    await waitForSkipDomSync();
    const after = page.keydown(document.body, "ArrowRight");
    assert.equal(after.defaultPrevented, true);
    assert.equal(state.writes.length, 1);
    assert.deepEqual(ad.writes, []);
});

test("a live mid-roll keeps the pause snapshot and time-shift guard on the main video", async (t) => {
    const page = await openResumeRestorePage(t);
    const { document, dom, state } = page;
    // K pause arms the user's snapshot at 100.
    page.keydown(document.body, "k");
    state.paused = true;
    page.fire("pause");

    // The mid-roll in its native order: hidden wrapper, then the ad video, then the wrapper shows.
    const { wrapper, placeholder } = appendLiveAdWrapper(page, { display: "none" });
    await waitForSkipDomSync();
    const adVideo = document.createElement("video");
    adVideo.getBoundingClientRect = rect(0, 0, 1920, 1080);
    wrapper.querySelector("#midAdVideoContainer").append(adVideo);
    await waitForSkipDomSync();
    wrapper.style.display = "block";
    await waitForSkipDomSync();
    placeholder.dispatchEvent(new dom.window.Event("pause"));
    adVideo.dispatchEvent(new dom.window.Event("pause"));
    assert.deepEqual(state.writes, []);
    wrapper.style.display = "none";
    await waitForSkipDomSync();

    // Resuming the main after the ad still undoes the native jump to the live edge.
    page.clock.advance(20000);
    state.end += 20;
    state.paused = false;
    state.currentTime = state.end;
    page.fire("play");
    assert.deepEqual(state.writes, [100], "the snapshot survived the mid-roll");

    // Contrast: a larger non-ad video does replace the main through the same DOM sync and clears the snapshot.
    const replaced = await openResumeRestorePage(t);
    replaced.keydown(replaced.document.body, "k");
    replaced.state.paused = true;
    replaced.fire("pause");
    const other = replaced.document.createElement("video");
    other.getBoundingClientRect = rect(0, 0, 1920, 1080);
    replaced.document.body.append(other);
    await waitForSkipDomSync();
    replaced.clock.advance(20000);
    replaced.state.end += 20;
    replaced.state.paused = false;
    replaced.state.currentTime = replaced.state.end;
    replaced.fire("play");
    assert.deepEqual(replaced.state.writes, [], "a replaced main video drops its snapshot");
});

test("live mid-roll arrows mark a user seek only inside the main player", async (t) => {
    const page = await openSkipPage(t, {
        path: "/live/test-channel",
        sync: { skipLivePauseResumeEnabled: true },
        fakeClock: true,
    });
    const { document, state, clock, fire } = page;
    appendLiveAdWrapper(page);
    await waitForSkipDomSync();

    // Inside the main player the native key binding can move the hidden main, so the move is the user's.
    page.armBySeekbar(32);
    clock.advance(2000);
    state.writes.length = 0;
    const inside = page.keydown(document.getElementById("playerRoot"), "ArrowRight");
    assert.equal(inside.defaultPrevented, false);
    clock.advance(100);
    state.currentTime = state.end - 0.5;
    fire("seeking");
    assert.deepEqual(state.writes, [], "an arrow inside the main player excuses the move");
    assert.equal(state.currentTime, state.end - 0.5);

    // Outside the player the arrow is not a seek of the main, so the next native jump is still undone.
    const armedAt = state.end - 8;
    page.armBySeekbar(armedAt);
    clock.advance(2000);
    state.writes.length = 0;
    const outside = page.keydown(document.body, "ArrowRight");
    assert.equal(outside.defaultPrevented, false);
    clock.advance(100);
    state.currentTime = state.end - 0.5;
    fire("seeking");
    assert.equal(state.writes.length, 1, "an arrow outside the main player does not excuse a native jump");
    assert.ok(Math.abs(state.currentTime - (armedAt + 2.1)) < 0.01, `restored to ${state.currentTime}`);
});

test("a live pre-roll placeholder is never a seek target", async (t) => {
    const page = await openSkipPage(t, { path: "/live/test-channel", video: { currentTime: 100, end: 200 } });
    const { document } = page;
    document.getElementById("video").remove();
    const { ad } = appendLiveAdWrapper(page, { id: "preAdPlayerWrapper" });
    ad.paused = true;
    await waitForSkipDomSync();

    for (const key of ["ArrowRight", "."]) {
        const event = page.keydown(document.body, key);
        assert.equal(event.defaultPrevented, false, key);
    }
    assert.deepEqual(ad.writes, [], "the pre-roll content placeholder is not seeked");
});

test("VOD ad break arrows and paused frame-step keys stay with the native player instead of seeking the hidden VOD", async (t) => {
    // 2026-11-05 public bundle: during an IMA/GV ad the pzp root carries pzp-pc--adbreak and native seekAvailable is
    // false, while the shared main-video pick skips the ad container and returns the VOD behind the ad.
    const page = await openSkipPage(t, {
        path: "/video/123",
        sync: { skipSeconds: 5 },
        video: { currentTime: 100, duration: 3600, end: 3600 },
    });
    const { document, state } = page;
    const playerRoot = document.getElementById("playerRoot");
    const adContainer = document.createElement("div");
    adContainer.dataset.role = "imaAdContainerEl";
    adContainer.innerHTML = '<video id="vodAd"></video>';
    playerRoot.append(adContainer);
    const adVideo = adContainer.querySelector("video");
    const ad = { currentTime: 3, paused: false, writes: [] };
    Object.defineProperty(adVideo, "currentTime", {
        configurable: true,
        get: () => ad.currentTime,
        set: (value) => {
            ad.writes.push(Number(value));
            ad.currentTime = Number(value);
        },
    });
    Object.defineProperty(adVideo, "paused", { configurable: true, get: () => ad.paused });
    adVideo.getBoundingClientRect = rect(0, 0, 640, 360);
    playerRoot.classList.add("pzp-pc--adbreak");

    for (const key of ["ArrowRight", "ArrowLeft"]) {
        const event = page.keydown(document.body, key);
        assert.equal(event.defaultPrevented, false, `${key} stays with the native player during the ad`);
    }
    state.paused = true;
    ad.paused = true;
    for (const key of [".", ","]) {
        const event = page.keydown(document.body, key);
        assert.equal(event.defaultPrevented, false, `${key} stays with the native player during the ad`);
    }
    assert.deepEqual(state.writes, [], "the VOD behind the ad keeps its position");
    assert.deepEqual(ad.writes, [], "the ad video is not seeked");

    // After the break the configured skip applies to the VOD again.
    playerRoot.classList.remove("pzp-pc--adbreak");
    adContainer.remove();
    state.paused = false;
    const after = page.keydown(document.body, "ArrowRight");
    assert.equal(after.defaultPrevented, true);
    assert.deepEqual(state.writes, [105]);
});
