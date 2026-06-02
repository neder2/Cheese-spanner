const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

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
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                delete data[key];
            }
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
            },
        },
        testState: {
            sync: syncArea.data,
            local: localArea.data,
            storageChangeListeners,
        },
    };
}

function createDom(htmlFile, urlPath, chrome) {
    const dom = new JSDOM(readRepoFile(htmlFile), {
        url: `chrome-extension://better-chzzk/${urlPath}`,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });

    dom.window.chrome = chrome;
    dom.window.confirm = () => true;
    dom.window.fetch = async () => {
        throw new Error("Unexpected network request in page test");
    };

    return dom;
}

function createPageDom(html, url, chrome) {
    const dom = new JSDOM(html, {
        url,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });

    dom.window.chrome = chrome;
    dom.window.fetch = async () => {
        throw new Error("Unexpected network request in page test");
    };

    return dom;
}

function evalRepoScript(dom, ...parts) {
    dom.window.eval(readRepoFile(...parts));
}

function dispatch(dom, element, type) {
    element.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
}

function queryOption(document, key) {
    return document.querySelector(`[data-option="${key}"]`);
}

function waitForAsyncCallbacks() {
    return new Promise((resolve) => setTimeout(resolve, 20));
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

function createVideoTrackList(tracks, selectedIndex = 0) {
    const trackList = {
        length: tracks.length,
        selectedIndex,
        item(index) {
            return this[index] || null;
        },
        addEventListener() {},
        removeEventListener() {},
    };

    tracks.forEach((track, index) => {
        track.selected = index === selectedIndex;
        trackList[index] = track;
    });

    return trackList;
}

function requestAutoQualityApply(dom, quality = "1080p") {
    const requestId = `test-${Date.now()}-${Math.random()}`;
    const { document } = dom.window;
    document.documentElement.setAttribute(
        "data-betterchzzk-auto-quality-request",
        JSON.stringify({ requestId, quality })
    );
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:auto-quality:apply"));
    return JSON.parse(document.documentElement.getAttribute("data-betterchzzk-auto-quality-result"));
}

test("options page renders defaults and dependency-disabled controls without extension storage", () => {
    const dom = createDom("options.html", "options.html");

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document, BetterChzzkSettings } = dom.window;
    const optionInputs = Array.from(document.querySelectorAll("[data-option]"));
    const saveButton = document.getElementById("save");
    const notice = document.getElementById("notice");

    assert.equal(optionInputs.length, BetterChzzkSettings.OPTION_KEYS.length);
    assert.equal(queryOption(document, "skipSeconds").value, String(BetterChzzkSettings.DEFAULT_OPTIONS.skipSeconds));
    assert.equal(queryOption(document, "vodBroadcastClockEnabled").checked, false);
    assert.equal(saveButton.disabled, true);
    assert.equal(notice.dataset.state, "saved");
    assert.match(notice.textContent, /1080p/);

    const skipControl = queryOption(document, "skipControlEnabled");
    const skipKeyboard = queryOption(document, "skipKeyboardEnabled");
    const skipSeconds = queryOption(document, "skipSeconds");

    skipControl.checked = false;
    dispatch(dom, skipControl, "change");

    assert.equal(saveButton.disabled, false);
    assert.equal(skipKeyboard.disabled, true);
    assert.equal(skipSeconds.disabled, true);
    assert.equal(skipKeyboard.closest("[data-depends-on]").classList.contains("is-disabled"), true);
});

test("options playback controls show live settings before VOD settings", () => {
    const dom = createDom("options.html", "options.html");

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document } = dom.window;
    const section = queryOption(document, "skipControlEnabled").closest(".settings-card");
    const optionOrder = Array.from(section.querySelectorAll("[data-option]")).map((input) => input.dataset.option);
    const detailOrder = Array.from(section.querySelectorAll("summary")).map((summary) => summary.textContent.trim());

    assert.equal(section.querySelector("h2").textContent.trim(), "라이브/다시보기 조작");
    assert.deepEqual(detailOrder, ["라이브 위치 유지 설정", "스킵 수치 설정"]);
    assert.deepEqual(optionOrder, [
        "skipControlEnabled",
        "skipKeyboardEnabled",
        "skipLivePauseResumeEnabled",
        "skipLivePauseResumeDepthMinutes",
        "timeMachineLagLabelEnabled",
        "skipPillEnabled",
        "skipLivePillEnabled",
        "skipSeconds",
        "skipWheelStep",
        "skipWheelShiftStep",
        "skipWheelAltStep",
        "vodBroadcastClockEnabled",
    ]);
});

test("options page loads stored values and writes normalized changes", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipSeconds: 15,
            videoSearchEnabled: false,
        },
    });
    const dom = createDom("options.html", "options.html", chrome);

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    const skipSeconds = queryOption(document, "skipSeconds");
    const videoComment = queryOption(document, "videoSearchCommentEnabled");
    const saveButton = document.getElementById("save");

    assert.equal(skipSeconds.value, "15");
    assert.equal(videoComment.disabled, true);
    assert.equal(saveButton.disabled, true);

    skipSeconds.value = "17";
    dispatch(dom, skipSeconds, "input");

    assert.equal(saveButton.disabled, false);

    saveButton.click();
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.sync.skipSeconds, 17);
    assert.equal(saveButton.disabled, true);
    assert.equal(document.getElementById("notice").dataset.state, "saved");
});

test("auto quality falls back to the highest selectable lower track", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            "<main>",
            '<video id="video"></video>',
            "</main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const tracks = [
        { id: "auto", label: "auto 1080p", height: 1080 },
        { id: "480", label: "480p", height: 480, kind: "main" },
        { id: "720", label: "720p", height: 720, kind: "main" },
    ];
    const trackList = createVideoTrackList(tracks, 1);

    video.currentTime = 2;
    Object.defineProperty(video, "paused", {
        configurable: true,
        get: () => false,
    });
    makeVisibleVideo(video);
    Object.defineProperty(video, "videoTracks", {
        configurable: true,
        get: () => trackList,
    });

    evalRepoScript(dom, "features", "autoQualityPage.js");

    const result = requestAutoQualityApply(dom, "1080p");

    assert.equal(result.status, "selected");
    assert.equal(result.selected.height, 720);
    assert.equal(result.previous.height, 480);
    assert.equal(trackList.selectedIndex, 2);
    assert.equal(tracks[2].selected, true);
    assert.equal(tracks[1].selected, false);
});

test("auto quality treats an already selected fallback track as stable", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            "<main>",
            '<video id="video"></video>',
            "</main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const tracks = [
        { id: "auto", label: "auto 1080p", height: 1080 },
        { id: "720", label: "720p", height: 720, kind: "main" },
        { id: "480", label: "480p", height: 480, kind: "main" },
    ];
    const trackList = createVideoTrackList(tracks, 1);

    video.currentTime = 2;
    makeVisibleVideo(video);
    Object.defineProperty(video, "videoTracks", {
        configurable: true,
        get: () => trackList,
    });

    evalRepoScript(dom, "features", "autoQualityPage.js");

    const result = requestAutoQualityApply(dom, "1080p");

    assert.equal(result.status, "already");
    assert.equal(result.selected.height, 720);
    assert.equal(trackList.selectedIndex, 1);
    assert.equal(tracks[1].selected, true);
});

test("VOD replay chat fix ignores currentTime-only URL changes on the same VOD", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            "<main>",
            '<video id="video"></video>',
            "</main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const scheduledTimers = [];

    dom.window.setTimeout = (callback, delay) => {
        scheduledTimers.push({ callback, delay });
        return scheduledTimers.length;
    };
    dom.window.clearTimeout = () => {};
    video.currentTime = 20;
    makeVisibleVideo(video);

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "vodReplayChatFix.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();

    scheduledTimers.length = 0;
    dom.window.history.pushState({}, "", "/video/12345?currentTime=30");
    document.body.appendChild(document.createElement("div"));
    await waitForAsyncCallbacks();

    assert.equal(scheduledTimers.length, 0);
    assert.equal(dom.window.sessionStorage.getItem("betterchzzk:vod-chat-reload:/video/12345"), null);
});

test("VOD replay chat fix runs even when the old stored option is disabled", async () => {
    const chrome = createFakeChrome({
        sync: {
            vodReplayChatFixEnabled: false,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            "<main>",
            '<video id="video"></video>',
            "</main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const scheduledTimers = [];

    dom.window.setTimeout = (callback, delay) => {
        scheduledTimers.push({ callback, delay });
        return scheduledTimers.length;
    };
    dom.window.clearTimeout = () => {};
    makeVisibleVideo(video);

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "vodReplayChatFix.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();

    scheduledTimers.length = 0;
    dom.window.history.pushState({}, "", "/video/67890");
    document.body.appendChild(document.createElement("div"));
    await waitForAsyncCallbacks();

    assert.deepEqual(
        scheduledTimers
            .map(({ delay }) => delay)
            .filter((delay) => delay >= 12000),
        [12000, 16000, 22000]
    );
});

test("VOD broadcast clock stays hidden when the broadcast start time is unavailable", async () => {
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
            "<main>",
            '<video id="video"></video>',
            '<div class="pzp-vod-time" id="time">0:00 / 1:00</div>',
            "</main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const time = document.getElementById("time");

    video.getBoundingClientRect = () => ({
        width: 640,
        height: 360,
        left: 0,
        top: 0,
        right: 640,
        bottom: 360,
    });
    time.getBoundingClientRect = () => ({
        width: 120,
        height: 24,
        left: 16,
        top: 324,
        right: 136,
        bottom: 348,
    });
    dom.window.fetch = async () => ({
        ok: true,
        json: async () => ({ content: { videoNo: "12345", videoTitle: "VOD without start time" } }),
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "vodBroadcastClock.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();

    assert.equal(document.getElementById("betterchzzk-vod-broadcast-clock"), null);
});

test("live fast-forward button seeks to the buffered live edge", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipLivePauseResumeEnabled: false,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__bottom-buttons--left" id="controls">',
            '<button class="pzp-pc__playback-switch" id="play" type="button">Play</button>',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const controls = document.getElementById("controls");
    const play = document.getElementById("play");

    video.currentTime = 12;
    video.getBoundingClientRect = () => ({
        width: 640,
        height: 360,
        left: 0,
        top: 0,
        right: 640,
        bottom: 360,
    });
    controls.getBoundingClientRect = () => ({
        width: 180,
        height: 40,
        left: 16,
        top: 316,
        right: 196,
        bottom: 356,
    });
    play.getBoundingClientRect = () => ({
        width: 36,
        height: 36,
        left: 20,
        top: 318,
        right: 56,
        bottom: 354,
    });
    Object.defineProperty(video, "buffered", {
        configurable: true,
        get: () => createTimeRanges([[0, 42]]),
    });

    try {
        evalRepoScript(dom, "shared", "settings.js");
        evalRepoScript(dom, "content.js");
        evalRepoScript(dom, "features", "skipControl.js");
        document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
        await waitForAsyncCallbacks();
        await waitForAsyncCallbacks();

        const button = document.getElementById("betterchzzk-live-fast-forward");
        assert.ok(button);
        assert.equal(button.getAttribute("label"), "\uBE68\uB9AC \uAC10\uAE30");
        assert.equal(button.getAttribute("aria-label"), "\uBE68\uB9AC \uAC10\uAE30");
        assert.equal(button.getAttribute("tooltip"), "\uBE68\uB9AC \uAC10\uAE30");
        assert.equal(button.hasAttribute("title"), false);
        assert.equal(button.classList.contains("knife-ff"), true);
        assert.ok(button.querySelector("ui-next-media-icon.bc-live-ff-icon svg"));
        assert.equal(button.textContent.trim(), "");
        assert.equal(button.disabled, false);

        button.click();

        assert.equal(video.currentTime, 42);
    } finally {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ skipControlEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    }
});

test("live fast-forward button does not duplicate an external knife button", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipLivePauseResumeEnabled: false,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__bottom-buttons--left" id="controls">',
            '<button class="pzp-pc__playback-switch" id="play" type="button">Play</button>',
            '<button class="knife-ff" id="external-ff" type="button" aria-label="\uBE68\uB9AC \uAC10\uAE30"></button>',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const controls = document.getElementById("controls");
    const play = document.getElementById("play");
    const externalButton = document.getElementById("external-ff");

    video.getBoundingClientRect = () => ({
        width: 640,
        height: 360,
        left: 0,
        top: 0,
        right: 640,
        bottom: 360,
    });
    controls.getBoundingClientRect = () => ({
        width: 220,
        height: 40,
        left: 16,
        top: 316,
        right: 236,
        bottom: 356,
    });
    play.getBoundingClientRect = () => ({
        width: 36,
        height: 36,
        left: 20,
        top: 318,
        right: 56,
        bottom: 354,
    });
    externalButton.getBoundingClientRect = () => ({
        width: 36,
        height: 36,
        left: 64,
        top: 318,
        right: 100,
        bottom: 354,
    });

    try {
        evalRepoScript(dom, "shared", "settings.js");
        evalRepoScript(dom, "content.js");
        evalRepoScript(dom, "features", "skipControl.js");
        document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
        await waitForAsyncCallbacks();
        await waitForAsyncCallbacks();

        assert.equal(document.getElementById("betterchzzk-live-fast-forward"), null);
        assert.equal(document.getElementById("external-ff"), externalButton);
    } finally {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ skipControlEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    }
});

test("history page loads local watch history state without crashing", async () => {
    const chrome = createFakeChrome();
    const dom = createDom("history.html", "history.html", chrome);

    evalRepoScript(dom, "history.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;

    assert.equal(document.getElementById("notice").dataset.state, "saved");
    assert.match(document.getElementById("notice").textContent, /0/);
    assert.match(document.getElementById("totalLiveCount").textContent, /0/);
    assert.equal(document.getElementById("weekdays").children.length, 7);
    assert.ok(document.getElementById("calendarDays").children.length >= 28);
    assert.equal(document.getElementById("deleteSelectedHistory").disabled, true);
    assert.equal(chrome.testState.storageChangeListeners.length, 1);
});
