const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM, VirtualConsole } = require("jsdom");

const repoRoot = path.join(__dirname, "..");

function readRepoFile(...parts) {
    return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

function createStorageArea(initialData = {}) {
    const data = { ...initialData };

    return {
        data,
        get(keys, callback) {
            const result = {};
            if (Array.isArray(keys)) {
                for (const key of keys) {
                    if (Object.hasOwn(data, key)) result[key] = data[key];
                }
            } else if (typeof keys === "string") {
                if (Object.hasOwn(data, keys)) result[keys] = data[keys];
            } else if (keys && typeof keys === "object") {
                Object.assign(result, keys);
                for (const key of Object.keys(keys)) {
                    if (Object.hasOwn(data, key)) result[key] = data[key];
                }
            } else {
                Object.assign(result, data);
            }
            setTimeout(() => callback(result), 0);
        },
        set(values, callback) {
            Object.assign(data, values || {});
            setTimeout(() => callback?.(), 0);
        },
        remove(keys, callback) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
            setTimeout(() => callback?.(), 0);
        },
    };
}

function createFakeChrome({ sync = {}, local = {} } = {}) {
    const syncArea = createStorageArea(sync);
    const localArea = createStorageArea(local);
    const storageChangeListeners = [];

    return {
        runtime: {},
        storage: {
            sync: syncArea,
            local: localArea,
            onChanged: {
                addListener(listener) {
                    storageChangeListeners.push(listener);
                },
                removeListener(listener) {
                    const index = storageChangeListeners.indexOf(listener);
                    if (index >= 0) storageChangeListeners.splice(index, 1);
                },
            },
        },
        testState: {
            storageChangeListeners,
        },
    };
}

function createPageDom(html, url, chrome) {
    const dom = new JSDOM(html, {
        url,
        runScripts: "outside-only",
        pretendToBeVisual: true,
        virtualConsole: new VirtualConsole(),
    });
    dom.window.chrome = chrome;
    dom.window.fetch = async () => {
        throw new Error("Unexpected network request in playback lifecycle test");
    };
    return dom;
}

function evalRepoScript(dom, ...parts) {
    dom.window.eval(readRepoFile(...parts));
}

function evalContentScripts(dom) {
    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "shared", "vodTimeline.js");
}

function waitForAsyncCallbacks(delayMs = 30) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForCondition(predicate, { timeoutMs = 1500, intervalMs = 20 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
        if (predicate()) return;
        await waitForAsyncCallbacks(intervalMs);
    }
    assert.fail("Timed out waiting for playback lifecycle condition");
}

function makeVisibleVideo(video) {
    video.getBoundingClientRect = () => ({
        width: 640,
        height: 360,
        left: 0,
        top: 0,
        right: 640,
        bottom: 360,
    });
}

function createTimeRanges(ranges) {
    return {
        length: ranges.length,
        start(index) {
            return ranges[index][0];
        },
        end(index) {
            return ranges[index][1];
        },
    };
}

function dispatchStorageChange(chrome, changes, areaName) {
    for (const listener of [...chrome.testState.storageChangeListeners]) listener(changes, areaName);
}

function disableOptions(chrome, changes) {
    dispatchStorageChange(chrome, changes, "sync");
}

test("live timeshift guard accepts native Arrow and L seeks when custom keyboard handling is disabled", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipControlEnabled: true,
            skipKeyboardEnabled: false,
            skipLivePauseResumeEnabled: true,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div class="pzp pzp-pc">',
            '<video id="video"></video>',
            '<div class="pzp-pc__progress-slider" id="seekbar" role="slider"></div>',
            '<div class="pzp-pc__bottom-buttons--left" id="controls"></div>',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const seekbar = document.getElementById("seekbar");
    const state = { currentTime: 32, paused: false, edge: 40 };
    let now = 1000;

    Object.defineProperty(dom.window.performance, "now", { configurable: true, value: () => now });
    Object.defineProperty(video, "currentTime", {
        configurable: true,
        get: () => state.currentTime,
        set: (value) => {
            state.currentTime = Number(value);
        },
    });
    Object.defineProperty(video, "paused", { configurable: true, get: () => state.paused });
    Object.defineProperty(video, "buffered", {
        configurable: true,
        get: () => createTimeRanges([[0, state.edge]]),
    });
    Object.defineProperty(video, "seekable", {
        configurable: true,
        get: () => createTimeRanges([[0, state.edge]]),
    });
    makeVisibleVideo(video);
    seekbar.getBoundingClientRect = () => ({
        width: 560,
        height: 12,
        left: 40,
        top: 302,
        right: 600,
        bottom: 314,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "skipControl.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks(60);

    const armAt = (time) => {
        seekbar.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        state.currentTime = time;
        video.dispatchEvent(new dom.window.Event("seeking", { bubbles: true }));
        video.dispatchEvent(new dom.window.Event("seeked", { bubbles: true }));
        seekbar.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true, cancelable: true }));
        now += 2000;
    };
    const runNativeForwardSeek = (key, code) => {
        const event = new dom.window.KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true });
        document.body.dispatchEvent(event);
        assert.equal(event.defaultPrevented, false);
        state.currentTime = 37;
        video.dispatchEvent(new dom.window.Event("seeking", { bubbles: true }));
        video.dispatchEvent(new dom.window.Event("seeked", { bubbles: true }));
        assert.equal(state.currentTime, 37);
    };

    armAt(32);
    runNativeForwardSeek("ArrowRight", "ArrowRight");
    armAt(32);
    runNativeForwardSeek("l", "KeyL");

    disableOptions(chrome, { skipControlEnabled: { oldValue: true, newValue: false } });
    await waitForAsyncCallbacks();
    dom.window.close();
});

test("VOD replay chat observer retries after the DOM has stayed quiet for the settle window", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        '<!doctype html><body><main><video id="video"></video></main></body>',
        "https://chzzk.naver.com/category/game/lives",
        chrome
    );
    const { document } = dom.window;
    const timers = new Map();
    let nextTimerId = 1;
    let now = 0;

    Object.defineProperty(dom.window.performance, "now", { configurable: true, value: () => now });
    dom.window.setTimeout = (callback, delay) => {
        const id = nextTimerId++;
        timers.set(id, { callback, delay });
        return id;
    };
    dom.window.clearTimeout = (id) => timers.delete(id);
    makeVisibleVideo(document.getElementById("video"));

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "vodReplayChatFix.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    dom.window.history.pushState({}, "", "/video/12345");
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));
    now = 10000;
    document.body.appendChild(document.createElement("div"));
    await waitForAsyncCallbacks();

    const settleTimerEntry = [...timers.entries()].find(([, timer]) => timer.delay === 2500);
    assert.ok(settleTimerEntry, "observer retry should wait for the full DOM settle window");

    const [settleTimerId, settleTimer] = settleTimerEntry;
    timers.delete(settleTimerId);
    now = 12500;
    settleTimer.callback();

    assert.ok(Number(dom.window.sessionStorage.getItem("betterchzzk:vod-chat-reload:/video/12345")) > 0);
    dom.window.close();
});

test("VOD replay chat observer stops deferring after continuous layout mutations", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        '<!doctype html><body><main><video id="video"></video></main></body>',
        "https://chzzk.naver.com/category/game/lives",
        chrome
    );
    const { document } = dom.window;
    const timers = new Map();
    let nextTimerId = 1;
    let now = 0;

    Object.defineProperty(dom.window.performance, "now", { configurable: true, value: () => now });
    dom.window.setTimeout = (callback, delay) => {
        const id = nextTimerId++;
        timers.set(id, { callback, delay });
        return id;
    };
    dom.window.clearTimeout = (id) => timers.delete(id);
    makeVisibleVideo(document.getElementById("video"));

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "vodReplayChatFix.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    dom.window.history.pushState({}, "", "/video/12345");
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));

    for (const mutationAt of [10000, 12000, 14000, 15999]) {
        now = mutationAt;
        document.body.appendChild(document.createElement("div"));
        await waitForAsyncCallbacks();
    }

    const deadlineTimerEntry = [...timers.entries()].find(([, timer]) => timer.delay === 1);
    assert.ok(deadlineTimerEntry, "continuous mutations should retain a fixed maximum settle deadline");

    const [deadlineTimerId, deadlineTimer] = deadlineTimerEntry;
    timers.delete(deadlineTimerId);
    now = 16000;
    deadlineTimer.callback();

    assert.ok(Number(dom.window.sessionStorage.getItem("betterchzzk:vod-chat-reload:/video/12345")) > 0);
    dom.window.close();
});

test("VOD title history reloads storage changes and ignores the older pending snapshot", async () => {
    const historyKey = "betterChzzkLiveWatchHistory";
    const startMs = Date.parse("2026-06-28T00:00:00+09:00");
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
            vodBroadcastClockEnabled: true,
        },
    });
    const pendingHistoryGets = [];
    chrome.storage.local.get = (keys, callback) => pendingHistoryGets.push({ callback, keys });

    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><video id="video"></video><div class="pzp-vod-time" id="time">0:02 / 1:00</div></main>',
            '<h1 id="title">Current title</h1>',
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const time = document.getElementById("time");
    const title = document.getElementById("title");

    video.currentTime = 2;
    makeVisibleVideo(video);
    time.getBoundingClientRect = () => ({
        width: 120,
        height: 24,
        left: 16,
        top: 324,
        right: 136,
        bottom: 348,
    });
    title.getBoundingClientRect = () => ({
        width: 480,
        height: 36,
        left: 16,
        top: 372,
        right: 496,
        bottom: 408,
    });
    dom.window.fetch = async () => ({
        ok: true,
        json: async () => ({
            content: {
                duration: 3600,
                liveOpenDate: "2026-06-28 00:00:00",
                publishDate: new Date(startMs + 3600 * 1000).toISOString(),
                videoNo: "12345",
                videoTitle: "Current title",
            },
        }),
    });

    const snapshot = (previousTitle) => ({
        entries: [
            {
                firstWatchedAt: startMs,
                id: "history-12345",
                lastWatchedAt: startMs + 1000,
                replayVideoNo: "12345",
                title: "Current title",
                titleHistory: [
                    {
                        firstSeenAt: startMs - 2000,
                        lastSeenAt: startMs - 1000,
                        title: previousTitle,
                    },
                ],
            },
        ],
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "vodBroadcastClock.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));

    await waitForCondition(() => pendingHistoryGets.length === 1);
    dispatchStorageChange(
        chrome,
        { [historyKey]: { oldValue: snapshot("Old previous title"), newValue: snapshot("New previous title") } },
        "local"
    );
    await waitForCondition(() => pendingHistoryGets.length === 2);

    pendingHistoryGets[1].callback({ [historyKey]: snapshot("New previous title") });
    await waitForCondition(() =>
        document.getElementById("betterchzzk-vod-title-history-panel")?.textContent.includes("New previous title")
    );

    pendingHistoryGets[0].callback({ [historyKey]: snapshot("Old previous title") });
    await waitForAsyncCallbacks(250);

    const panelText = document.getElementById("betterchzzk-vod-title-history-panel").textContent;
    assert.match(panelText, /New previous title/);
    assert.doesNotMatch(panelText, /Old previous title/);

    disableOptions(chrome, {
        liveWatchHistoryEnabled: { oldValue: true, newValue: false },
        vodBroadcastClockEnabled: { oldValue: true, newValue: false },
    });
    await waitForAsyncCallbacks();
    dom.window.close();
});

test("VOD broadcast clock keeps inferred metadata when an older segment fetch throws AbortError without cancellation", async () => {
    const startMs = Date.parse("2026-06-28T00:00:00+09:00");
    const splitMs = 17 * 60 * 60 * 1000;
    const durationSeconds = 60 * 60;
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: false,
            vodBroadcastClockEnabled: true,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><video id="video"></video><div class="pzp-vod-time" id="time">0:02 / 1:00:00</div></main>',
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const time = document.getElementById("time");
    const requests = [];

    video.currentTime = 2;
    makeVisibleVideo(video);
    time.getBoundingClientRect = () => ({
        width: 140,
        height: 24,
        left: 16,
        top: 324,
        right: 156,
        bottom: 348,
    });
    dom.window.fetch = async (url, init = {}) => {
        requests.push({ signal: init.signal, url: String(url) });
        if (String(url).endsWith("/older-segment")) {
            assert.equal(init.signal?.aborted, false, "the older request should fail without cancellation");
            throw new dom.window.DOMException("The operation was aborted.", "AbortError");
        }

        return {
            ok: true,
            json: async () => ({
                content: {
                    duration: durationSeconds,
                    liveCloseDate: new Date(startMs + splitMs + durationSeconds * 1000).toISOString(),
                    liveOpenDate: "2026-06-28T00:00:00+09:00",
                    nextVideo: {
                        duration: splitMs / 1000,
                        videoNo: "older-segment",
                    },
                    videoNo: "12345",
                },
            }),
        };
    };

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "vodBroadcastClock.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));

    await waitForCondition(() => document.getElementById("betterchzzk-vod-broadcast-clock"));

    const clock = document.getElementById("betterchzzk-vod-broadcast-clock");
    assert.deepEqual(
        requests.map(({ url }) => url.split("/").pop()),
        ["12345", "older-segment"]
    );
    assert.equal(requests[1].signal.aborted, false);
    assert.equal(clock.querySelector(".bcbc-time").textContent, "17:00:02");
    assert.match(clock.title, /방송 기준 시작: 2026-06-28 17:00:00 KST/);
    assert.match(clock.title, /분할 VOD 보정: \+17:00:00/);
    assert.match(clock.title, /원본 방송 시작: 2026-06-28 00:00:00 KST/);

    dom.window.close();
});

test("VOD broadcast clock aborts pending metadata before switching to another VOD", async () => {
    const chrome = createFakeChrome({
        sync: {
            vodBroadcastClockEnabled: true,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><video id="video"></video><div class="pzp-vod-time">0:00 / 1:00</div></main>',
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    let resolveResponse;
    let requestSignal = null;
    dom.window.fetch = (_url, init = {}) => {
        requestSignal = init.signal;
        return new Promise((resolve) => {
            resolveResponse = resolve;
        });
    };
    makeVisibleVideo(dom.window.document.getElementById("video"));

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "vodBroadcastClock.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));

    await waitForCondition(() => requestSignal instanceof dom.window.AbortSignal);
    dom.window.history.pushState({}, "", "/video/67890");
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));
    await waitForCondition(() => requestSignal.aborted);

    resolveResponse({
        ok: true,
        json: async () => ({
            content: {
                duration: 3600,
                liveOpenDate: "2026-06-28T00:00:00+09:00",
                videoNo: "12345",
            },
        }),
    });
    await waitForAsyncCallbacks(80);

    assert.equal(dom.window.document.getElementById("betterchzzk-vod-broadcast-clock"), null);
    dom.window.close();
});

test("audio compressor preserves its graph across SPA mini-player and BFCache transitions", async () => {
    const chrome = createFakeChrome({ sync: { audioCompressorEnabled: true } });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="volume">',
            '<button class="pzp-pc__volume-button" id="mute" type="button"></button>',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const volume = document.getElementById("volume");
    const mute = document.getElementById("mute");
    const contexts = [];

    class FakeNode {
        connect() {}
        disconnect() {}
    }
    class FakeParam {
        setTargetAtTime(value) {
            this.value = value;
        }
    }
    class FakeAudioContext {
        constructor() {
            this.closeCalls = 0;
            this.currentTime = 0;
            this.destination = new FakeNode();
            this.resumeCalls = 0;
            this.state = "running";
            contexts.push(this);
        }
        createMediaElementSource() {
            return new FakeNode();
        }
        createDynamicsCompressor() {
            const node = new FakeNode();
            node.attack = new FakeParam();
            node.knee = new FakeParam();
            node.ratio = new FakeParam();
            node.release = new FakeParam();
            node.threshold = new FakeParam();
            return node;
        }
        createGain() {
            const node = new FakeNode();
            node.gain = new FakeParam();
            return node;
        }
        close() {
            this.closeCalls += 1;
            this.state = "closed";
            return Promise.resolve();
        }
        resume() {
            this.resumeCalls += 1;
            this.state = "running";
            return Promise.resolve();
        }
    }

    dom.window.AudioContext = FakeAudioContext;
    makeVisibleVideo(video);
    volume.getBoundingClientRect = () => ({
        width: 96,
        height: 40,
        left: 20,
        top: 320,
        right: 116,
        bottom: 360,
    });
    mute.getBoundingClientRect = () => ({
        width: 40,
        height: 40,
        left: 20,
        top: 320,
        right: 60,
        bottom: 360,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "volumeTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForCondition(() => document.getElementById("betterchzzk-audio-compressor"));

    document.getElementById("betterchzzk-audio-compressor").click();
    assert.equal(contexts.length, 1);
    const context = contexts[0];

    dom.window.history.pushState({}, "", "/lives");
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));
    await waitForAsyncCallbacks();
    assert.equal(context.closeCalls, 0, "the mini-player reuses the media element and still needs its audio graph");

    dom.window.history.pushState({}, "", "/live/test-channel");
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));
    await waitForAsyncCallbacks();
    assert.equal(contexts.length, 1, "returning to the same media element must reuse its existing graph");
    const returnedButton = document.getElementById("betterchzzk-audio-compressor");
    assert.ok(returnedButton, "the compressor control should return on the playback route");
    returnedButton.click();
    await waitForAsyncCallbacks();
    assert.equal(returnedButton.dataset.betterChzzkAudioCompressor, "1");
    assert.equal(returnedButton.dataset.betterChzzkReady, "1");
    assert.equal(contexts.length, 1, "reactivating the compressor must reuse the preserved graph");
    assert.equal(context.closeCalls, 0);

    const persistedPageHide = new dom.window.Event("pagehide");
    Object.defineProperty(persistedPageHide, "persisted", { value: true });
    dom.window.dispatchEvent(persistedPageHide);
    assert.equal(context.closeCalls, 0);

    context.state = "suspended";
    const persistedPageShow = new dom.window.Event("pageshow");
    Object.defineProperty(persistedPageShow, "persisted", { value: true });
    dom.window.dispatchEvent(persistedPageShow);
    await waitForAsyncCallbacks();
    assert.equal(context.resumeCalls, 1);
    assert.equal(context.closeCalls, 0);

    const finalPageHide = new dom.window.Event("pagehide");
    Object.defineProperty(finalPageHide, "persisted", { value: false });
    dom.window.dispatchEvent(finalPageHide);
    assert.equal(context.closeCalls, 1);
    dom.window.close();
});
