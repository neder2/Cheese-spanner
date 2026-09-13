const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM, VirtualConsole } = require("jsdom");

const repoRoot = path.join(__dirname, "..");
const AUDIO_COMPRESSOR_ACTIVE_STORAGE_KEY = "betterchzzk:audio-compressor-active";
const AUDIO_COMPRESSOR_TABS_STORAGE_KEY = "betterchzzk:audio-compressor-tabs";

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
            nextTabId: 0,
        },
    };
}

function createPageDom(html, url, chrome, tabId = ++chrome.testState.nextTabId) {
    const dom = new JSDOM(html, {
        url,
        runScripts: "outside-only",
        pretendToBeVisual: true,
        virtualConsole: new VirtualConsole(),
    });
    dom.testTabId = tabId;
    dom.window.chrome = {
        ...chrome,
        runtime: {
            ...chrome.runtime,
            sendMessage(message, callback) {
                assert.equal(message.type, "betterchzzk:audio-compressor-state");
                const states = chrome.storage.local.data[AUDIO_COMPRESSOR_TABS_STORAGE_KEY] || [];
                let state = states.find((saved) => saved.tabId === tabId) || { active: false, volume: 1 };
                if (message.kind === "set") {
                    state = { tabId, ...message.state };
                    chrome.storage.local.data[AUDIO_COMPRESSOR_TABS_STORAGE_KEY] = states
                        .filter((saved) => saved.tabId !== tabId)
                        .concat(state);
                }
                setTimeout(() => callback({ ok: true, state }), 0);
            },
        },
    };
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

async function createCompressorPage(
    t,
    chrome,
    { channel = "test-channel", tabId, initialState = null, storageUnavailable = false } = {}
) {
    const dom = createPageDom(
        '<body><div class="pzp-pc"><video id="video"></video><div class="pzp-pc__volume-control" id="volume"><button class="pzp-pc__volume-button" id="mute" type="button"></button></div></div></body>',
        `https://chzzk.naver.com/live/${channel}`,
        chrome,
        tabId
    );
    t.after(() => {
        dom.window.dispatchEvent(new dom.window.Event("pagehide"));
        dom.window.close();
    });
    if (initialState !== null)
        chrome.storage.local.data[AUDIO_COMPRESSOR_TABS_STORAGE_KEY] = [{ tabId: dom.testTabId, ...initialState }];
    if (storageUnavailable)
        dom.window.chrome.runtime.sendMessage = (_message, callback) => setTimeout(() => callback({ ok: false }), 0);
    const { document } = dom.window;
    const video = document.getElementById("video");
    const contexts = [];
    class AudioNode {
        constructor(name) {
            this.name = name;
            this.outputs = new Set();
        }
        connect(node) {
            this.outputs.add(node.name);
        }
        disconnect() {
            this.outputs.clear();
        }
    }
    class AudioParam {
        setTargetAtTime(value) {
            this.value = value;
        }
    }
    dom.window.AudioContext = class {
        constructor() {
            this.currentTime = 0;
            this.state = "running";
            this.destination = new AudioNode("destination");
            contexts.push(this);
        }
        createMediaElementSource() {
            return (this.source = new AudioNode("source"));
        }
        createDynamicsCompressor() {
            const node = new AudioNode("compressor");
            for (const name of ["attack", "knee", "ratio", "release", "threshold"]) node[name] = new AudioParam();
            return (this.compressor = node);
        }
        createGain() {
            const node = new AudioNode("gain");
            node.gain = new AudioParam();
            return (this.gain = node);
        }
        close() {
            this.state = "closed";
            return Promise.resolve();
        }
    };
    makeVisibleVideo(video);
    document.getElementById("volume").getBoundingClientRect = () => ({
        width: 120,
        height: 40,
        left: 20,
        top: 320,
        right: 140,
        bottom: 360,
    });
    document.getElementById("mute").getBoundingClientRect = () => ({
        width: 40,
        height: 40,
        left: 20,
        top: 320,
        right: 60,
        bottom: 360,
    });
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "shared", "volumeControlsPage.js");
    evalRepoScript(dom, "features", "volumeWheelPage.js");
    evalRepoScript(dom, "features", "volumeWheel.js");
    evalRepoScript(dom, "shared", "volumeControls.js");
    evalRepoScript(dom, "features", "volumeTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForCondition(() => document.getElementById("betterchzzk-audio-compressor"));
    return {
        dom,
        document,
        video,
        contexts,
        button: () => document.getElementById("betterchzzk-audio-compressor"),
        tabId: dom.testTabId,
    };
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
    evalRepoScript(dom, "shared", "volumeControls.js");
    evalRepoScript(dom, "features", "volumeTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForCondition(() => document.getElementById("betterchzzk-audio-compressor"));

    document.getElementById("betterchzzk-audio-compressor").click();
    assert.equal(contexts.length, 1);
    await waitForAsyncCallbacks();
    assert.equal(
        chrome.storage.local.data[AUDIO_COMPRESSOR_TABS_STORAGE_KEY].find((state) => state.tabId === dom.testTabId)
            .active,
        true
    );
    const context = contexts[0];

    disableOptions(chrome, { audioCompressorEnabled: { oldValue: true, newValue: false } });
    await waitForAsyncCallbacks();
    assert.equal(document.getElementById("betterchzzk-audio-compressor"), null);
    assert.equal(
        chrome.storage.local.data[AUDIO_COMPRESSOR_TABS_STORAGE_KEY].find((state) => state.tabId === dom.testTabId)
            .active,
        true
    );
    disableOptions(chrome, { audioCompressorEnabled: { oldValue: false, newValue: true } });
    await waitForCondition(
        () => document.getElementById("betterchzzk-audio-compressor")?.dataset.betterChzzkAudioCompressor === "1"
    );
    assert.equal(contexts.length, 1, "showing the control again must reuse the user's active preference");

    dom.window.history.pushState({}, "", "/lives");
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));
    await waitForAsyncCallbacks();
    assert.equal(context.closeCalls, 0, "the mini-player reuses the media element and still needs its audio graph");
    assert.equal(
        chrome.storage.local.data[AUDIO_COMPRESSOR_TABS_STORAGE_KEY].find((state) => state.tabId === dom.testTabId)
            .active,
        true
    );

    dom.window.history.pushState({}, "", "/live/test-channel");
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));
    await waitForAsyncCallbacks();
    assert.equal(contexts.length, 1, "returning to the same media element must reuse its existing graph");
    const returnedButton = document.getElementById("betterchzzk-audio-compressor");
    assert.ok(returnedButton, "the compressor control should return on the playback route");
    assert.equal(returnedButton.dataset.betterChzzkAudioCompressor, "1");
    assert.equal(returnedButton.dataset.betterChzzkReady, "1");
    assert.equal(contexts.length, 1, "restoring the compressor must reuse the preserved graph");
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

    returnedButton.click();
    await waitForAsyncCallbacks();
    assert.equal(returnedButton.dataset.betterChzzkAudioCompressor, "0");
    assert.equal(
        chrome.storage.local.data[AUDIO_COMPRESSOR_TABS_STORAGE_KEY].find((state) => state.tabId === dom.testTabId)
            .active,
        false
    );

    dom.window.history.pushState({}, "", "/lives");
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));
    await waitForAsyncCallbacks();
    dom.window.history.pushState({}, "", "/live/test-channel");
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));
    await waitForAsyncCallbacks();
    const disabledButton = document.getElementById("betterchzzk-audio-compressor");
    assert.equal(disabledButton.dataset.betterChzzkAudioCompressor, "0");
    assert.equal(contexts.length, 1, "an off preference must not create another graph after navigation");

    const finalPageHide = new dom.window.Event("pagehide");
    Object.defineProperty(finalPageHide, "persisted", { value: false });
    dom.window.dispatchEvent(finalPageHide);
    assert.equal(context.closeCalls, 1);
    dom.window.close();
});

test("audio compressor restores its active graph from tab storage after reload", async () => {
    const chrome = createFakeChrome({
        sync: { audioCompressorEnabled: true },
    });
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
    chrome.storage.local.data[AUDIO_COMPRESSOR_TABS_STORAGE_KEY] = [{ tabId: dom.testTabId, active: true, volume: 1 }];
    const { document } = dom.window;
    const video = document.getElementById("video");
    const volume = document.getElementById("volume");
    const mute = document.getElementById("mute");
    const connections = [];

    class FakeNode {
        constructor(name) {
            this.name = name;
        }
        connect(node) {
            connections.push(`${this.name}->${node.name}`);
        }
        disconnect() {}
    }
    class FakeParam {
        setTargetAtTime(value) {
            this.value = value;
        }
    }
    class FakeAudioContext {
        constructor() {
            this.currentTime = 0;
            this.destination = new FakeNode("destination");
            this.state = "running";
        }
        createMediaElementSource() {
            return new FakeNode("source");
        }
        createDynamicsCompressor() {
            const node = new FakeNode("compressor");
            node.attack = new FakeParam();
            node.knee = new FakeParam();
            node.ratio = new FakeParam();
            node.release = new FakeParam();
            node.threshold = new FakeParam();
            return node;
        }
        createGain() {
            const node = new FakeNode("gain");
            node.gain = new FakeParam();
            return node;
        }
        close() {
            this.state = "closed";
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
    evalRepoScript(dom, "shared", "volumeControls.js");
    evalRepoScript(dom, "features", "volumeTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForCondition(
        () => document.getElementById("betterchzzk-audio-compressor")?.dataset.betterChzzkAudioCompressor === "1"
    );

    const button = document.getElementById("betterchzzk-audio-compressor");
    assert.equal(button.getAttribute("aria-pressed"), "true");
    assert.equal(button.dataset.betterChzzkReady, "1");
    assert.deepEqual(connections, ["source->compressor", "compressor->gain", "gain->destination"]);
    dom.window.close();
});

test("audio compressor state stays independent across tabs and ignores the old shared preference", async (t) => {
    const chrome = createFakeChrome({
        sync: { audioCompressorEnabled: true },
        local: { [AUDIO_COMPRESSOR_ACTIVE_STORAGE_KEY]: true },
    });
    const a = await createCompressorPage(t, chrome, { channel: "channel-a" });
    const b = await createCompressorPage(t, chrome, { channel: "channel-b" });
    assert.equal(a.button().getAttribute("aria-pressed"), "false");
    assert.equal(b.button().getAttribute("aria-pressed"), "false");
    a.video.volume = 0.2;
    b.video.volume = 0.8;
    a.button().click();
    await waitForAsyncCallbacks();
    assert.equal(a.button().getAttribute("aria-pressed"), "true");
    assert.equal(b.button().getAttribute("aria-pressed"), "false");
    assert.equal(b.contexts.length, 0);
    dispatchStorageChange(chrome, { [AUDIO_COMPRESSOR_ACTIVE_STORAGE_KEY]: { newValue: false } }, "local");
    assert.equal(a.button().getAttribute("aria-pressed"), "true");
    dispatchStorageChange(chrome, { [AUDIO_COMPRESSOR_ACTIVE_STORAGE_KEY]: { newValue: true } }, "local");
    assert.equal(b.button().getAttribute("aria-pressed"), "false");
    const c = await createCompressorPage(t, chrome, { channel: "channel-c" });
    assert.equal(c.button().getAttribute("aria-pressed"), "false");
    const reloadedA = await createCompressorPage(t, chrome, { channel: "channel-a", tabId: a.tabId });
    assert.equal(reloadedA.button().getAttribute("aria-pressed"), "true");
    assert.equal(a.video.volume, 0.2);
    assert.equal(b.video.volume, 0.8);
    a.button().click();
    await waitForAsyncCallbacks();
    assert.equal(
        chrome.storage.local.data[AUDIO_COMPRESSOR_ACTIVE_STORAGE_KEY],
        true,
        "tab choices never overwrite the old shared preference"
    );
});

test("audio compressor has a separate output slider and wheel without changing playback volume", async (t) => {
    const chrome = createFakeChrome({ sync: { audioCompressorEnabled: true, audioCompressorMakeupGain: 2 } });
    const page = await createCompressorPage(t, chrome);
    const { dom, document, video, contexts } = page;
    const control = document.getElementById("betterchzzk-audio-compressor-control");
    const slider = document.getElementById("betterchzzk-audio-compressor-volume");
    assert.ok(slider, "a dedicated compressor slider is present");
    assert.equal(control.previousElementSibling, document.getElementById("volume"));
    assert.equal(control.firstElementChild, page.button());
    assert.ok(page.button().nextElementSibling.contains(slider), "output slider is to the right of the compressor");
    assert.equal(slider.getAttribute("aria-label"), "컴프레서 볼륨");
    assert.equal(slider.value, "100");
    video.volume = 0.2;
    page.button().click();
    slider.value = "40";
    slider.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(video.volume, 0.2);
    assert.equal(contexts[0].gain.gain.value, 0.8);
    assert.equal(slider.getAttribute("aria-valuetext"), "40%");
    for (const target of [page.button(), slider]) {
        const wheel = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
        target.dispatchEvent(wheel);
        assert.equal(wheel.defaultPrevented, true);
    }
    await waitForAsyncCallbacks();
    assert.equal(slider.value, "50");
    assert.equal(contexts[0].gain.gain.value, 1);
    assert.equal(video.volume, 0.2, "compressor wheel never reaches the MAIN-world playback wheel");
    document
        .getElementById("mute")
        .dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 }));
    await waitForAsyncCallbacks();
    assert.equal(video.volume, 0.25);
    assert.equal(slider.value, "50");
    assert.equal(contexts[0].gain.gain.value, 1);
    page.button().click();
    assert.equal(contexts[0].gain.gain.value, 1, "bypass uses unscaled playback audio");
    slider.value = "0";
    slider.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(contexts[0].gain.gain.value, 1, "editing an inactive compressor does not attenuate normal audio");
    assert.equal(video.volume, 0.25);
    page.button().click();
    assert.equal(contexts[0].gain.gain.value, 0);
    assert.equal(video.muted, false, "compressor output zero does not change the native mute control");
});

test("audio compressor output survives tab reload, options and remounts without affecting another tab", async (t) => {
    const chrome = createFakeChrome({ sync: { audioCompressorEnabled: true } });
    const a = await createCompressorPage(t, chrome, { channel: "channel-a" });
    const b = await createCompressorPage(t, chrome, { channel: "channel-b" });
    a.button().click();
    const slider = a.document.getElementById("betterchzzk-audio-compressor-volume");
    slider.value = "30";
    slider.dispatchEvent(new a.dom.window.Event("input", { bubbles: true }));
    assert.equal(b.document.getElementById("betterchzzk-audio-compressor-volume").value, "100");
    disableOptions(chrome, { audioCompressorEnabled: { newValue: false } });
    assert.equal(a.document.getElementById("betterchzzk-audio-compressor-control"), null);
    assert.equal(a.contexts[0].gain.gain.value, 1);
    disableOptions(chrome, { audioCompressorEnabled: { newValue: true } });
    assert.equal(a.document.getElementById("betterchzzk-audio-compressor-volume").value, "30");
    assert.equal(a.contexts[0].gain.gain.value, 0.3);
    disableOptions(chrome, { audioCompressorMakeupGain: { newValue: 2 } });
    assert.equal(a.document.getElementById("betterchzzk-audio-compressor-volume").value, "30");
    assert.equal(a.contexts[0].gain.gain.value, 0.6);
    const oldControl = a.document.getElementById("betterchzzk-audio-compressor-control");
    oldControl.remove();
    await waitForCondition(() => a.document.getElementById("betterchzzk-audio-compressor-control"));
    assert.equal(a.document.getElementById("betterchzzk-audio-compressor-control"), oldControl);
    assert.equal(a.document.querySelectorAll("#betterchzzk-audio-compressor-volume").length, 1);
    const reloaded = await createCompressorPage(t, chrome, { tabId: a.tabId });
    assert.equal(reloaded.button().getAttribute("aria-pressed"), "true");
    assert.equal(reloaded.document.getElementById("betterchzzk-audio-compressor-volume").value, "30");
    assert.equal(b.button().getAttribute("aria-pressed"), "false");
});

test("audio compressor validates tab state and works when extension storage is unavailable", async (t) => {
    const chrome = createFakeChrome({ sync: { audioCompressorEnabled: true } });
    for (const [initialState, expectedVolume] of [
        [{ active: "true" }, "100"],
        [{ active: false, volume: -4 }, "0"],
        [{ volume: 4 }, "100"],
        [{ volume: 0.333 }, "33"],
        [{ volume: "0.5" }, "100"],
    ]) {
        const page = await createCompressorPage(t, chrome, { initialState });
        assert.equal(page.button().getAttribute("aria-pressed"), "false");
        assert.equal(page.document.getElementById("betterchzzk-audio-compressor-volume").value, expectedVolume);
    }
    const page = await createCompressorPage(t, chrome, { storageUnavailable: true });
    page.button().click();
    const slider = page.document.getElementById("betterchzzk-audio-compressor-volume");
    slider.value = "25";
    slider.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
    assert.equal(page.button().getAttribute("aria-pressed"), "true");
    assert.equal(page.contexts[0].gain.gain.value, 0.25);
});

test("audio compressor wheel follows the wheel option and clamps without toggling playback", async (t) => {
    const chrome = createFakeChrome({ sync: { audioCompressorEnabled: true, volumeWheelEnabled: false } });
    const page = await createCompressorPage(t, chrome);
    const slider = page.document.getElementById("betterchzzk-audio-compressor-volume");
    const wheel = (deltaY) => {
        const event = new page.dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY });
        slider.dispatchEvent(event);
        return event;
    };
    page.video.volume = 0.4;
    assert.equal(wheel(100).defaultPrevented, false);
    assert.equal(slider.value, "100");
    disableOptions(chrome, { volumeWheelEnabled: { newValue: true }, volumeWheelStep: { newValue: 50 } });
    wheel(-100);
    assert.equal(slider.value, "100");
    wheel(100);
    assert.equal(slider.value, "50");
    wheel(100);
    wheel(100);
    assert.equal(slider.value, "0");
    assert.equal(page.button().getAttribute("aria-pressed"), "false");
    assert.equal(page.contexts.length, 0);
    assert.equal(page.video.volume, 0.4);
});
