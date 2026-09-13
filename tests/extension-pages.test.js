const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const {
    readRepoFile,
    createFakeChrome,
    createDom: createExtensionDom,
    evalRepoScript,
    evalFeatureModules,
    dispatch,
    queryOption,
    waitForAsyncCallbacks,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

const repoRoot = path.join(__dirname, "..");

// These tests run sequentially; close every fixture even when an assertion fails.
const openDoms = new Set();
test.afterEach((t) => {
    t.after(() => {
        for (const dom of openDoms) dom.window.close();
        openDoms.clear();
    });
});

function createDom(...args) {
    const dom = createExtensionDom(...args);
    openDoms.add(dom);
    return dom;
}

function createPageDom(html, url, chrome) {
    const dom = new JSDOM(html, {
        url,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    openDoms.add(dom);

    dom.window.chrome = chrome;
    const observers = new Set();
    const NativeObserver = dom.window.MutationObserver;
    dom.window.MutationObserver = class extends NativeObserver {
        constructor(callback) {
            super(callback);
            observers.add(this);
        }
    };
    const close = dom.window.close.bind(dom.window);
    dom.window.close = () => {
        for (const observer of observers) observer.disconnect();
        observers.clear();
        openDoms.delete(dom);
        close();
    };
    dom.window.fetch = async () => {
        throw new Error("Unexpected network request in page test");
    };

    return dom;
}

function evalContentScripts(dom) {
    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "shared", "vodTimeline.js");
}

function waitForTitleTooltipDelay() {
    return new Promise((resolve) => setTimeout(resolve, 190));
}

function captureIntervals(dom) {
    const intervals = [];

    dom.window.setInterval = (fn, ms) => {
        const id = intervals.length + 1;
        intervals.push({ id, fn, ms, cleared: false });
        return id;
    };
    dom.window.clearInterval = (id) => {
        const entry = intervals.find((interval) => interval.id === id);
        if (entry) entry.cleared = true;
    };

    return intervals;
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

function configureWatchHistoryVideo(dom, video, getCurrentTime) {
    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: getCurrentTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });
}

function createAudioCompressorFixture({ withExternalCompressor = false } = {}) {
    const chrome = createFakeChrome({
        sync: {
            audioCompressorEnabled: true,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol">',
            '<button class="pzp-pc__volume-button" id="mute" type="button"></button>',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const volumeControl = document.getElementById("vol");
    const volumeButton = document.getElementById("mute");

    makeVisibleVideo(video);
    volumeControl.getBoundingClientRect = () => ({
        width: 96,
        height: 40,
        left: 20,
        top: 320,
        right: 116,
        bottom: 360,
    });
    volumeButton.getBoundingClientRect = () => ({
        width: 40,
        height: 40,
        left: 20,
        top: 320,
        right: 60,
        bottom: 360,
    });

    if (withExternalCompressor) {
        const external = document.createElement("div");
        external.className = "pzp-pc__volume-control knife-comp";
        volumeControl.insertAdjacentElement("afterend", external);
    }

    return { chrome, dom, document, volumeControl, volumeButton };
}

async function loadAudioCompressorFeature(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "shared", "volumeControls.js");
    evalRepoScript(dom, "features", "volumeTooltip.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
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

function disableAutoQualityPage(dom) {
    dom.window.document.documentElement.setAttribute(
        "data-betterchzzk-auto-quality-state",
        JSON.stringify({ enabled: false, quality: "1080p" })
    );
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:auto-quality:state"));
}

function evalVolumeWheelScripts(dom) {
    evalRepoScript(dom, "shared", "volumeControls.js");
    evalRepoScript(dom, "features", "volumeWheelPage.js");
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "volumeWheel.js");
}

test("createMutationObserverSync observes a deferred target when it appears", async () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalContentScripts(dom);

    const { BetterChzzk, document } = dom.window;
    const events = [];
    let target = null;
    const observer = BetterChzzk.utils.createMutationObserverSync({
        target: () => target,
        schedule: () => events.push("scheduled"),
        onBodyReady: () => events.push("ready"),
    });

    target = document.createElement("div");
    document.body.appendChild(target);
    await waitForAsyncCallbacks();

    target.appendChild(document.createElement("span"));
    await waitForAsyncCallbacks();

    assert.deepEqual(events, ["ready", "scheduled"]);
    observer.disconnect();
});

test("createMutationObserverSync re-resolves a function target after it is detached and replaced", async () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalContentScripts(dom);

    const { BetterChzzk, document } = dom.window;
    const events = [];

    const firstTarget = document.createElement("div");
    document.body.appendChild(firstTarget);
    let target = firstTarget;

    const observer = BetterChzzk.utils.createMutationObserverSync({
        target: () => target,
        schedule: () => events.push("scheduled"),
        onBodyReady: (_obs, node) => events.push(node === target ? "ready:new" : "ready:other"),
    });

    // 최초 대상에서의 mutation은 정상적으로 스케줄된다.
    firstTarget.appendChild(document.createElement("span"));
    await waitForAsyncCallbacks();
    assert.deepEqual(events, ["scheduled"]);

    // 대상 노드가 통째로 교체(제거 후 새 노드로 대체)된다.
    firstTarget.remove();
    const secondTarget = document.createElement("div");
    document.body.appendChild(secondTarget);
    target = secondTarget;

    // 재연결 감시가 분리를 감지해 새 대상으로 옮겨 탄 뒤 onBodyReady로 알린다.
    await waitForCondition(() => events.includes("ready:new"));
    assert.deepEqual(events, ["scheduled", "ready:new"]);

    // 새 대상에서 발생한 mutation이 실제로 관찰된다(옛 분리 노드가 아니라 새 노드).
    secondTarget.appendChild(document.createElement("span"));
    await waitForCondition(() => events.length === 3);
    assert.deepEqual(events, ["scheduled", "ready:new", "scheduled"]);

    observer.disconnect();
});

test("startPageChangeDetection detects pushState without a DOM mutation through the page route bridge", async () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalRepoScript(dom, "features", "routeBridgePage.js");
    evalContentScripts(dom);

    const hrefs = [];
    const remove = dom.window.BetterChzzk.utils.startPageChangeDetection((event) => {
        hrefs.push(event?.detail?.href || dom.window.location.href);
    });

    dom.window.history.pushState({}, "", "/video/12345");
    await waitForCondition(() => hrefs.some((href) => href.endsWith("/video/12345")));

    remove();
    const countAfterRemove = hrefs.length;
    dom.window.history.pushState({}, "", "/video/67890");
    await waitForAsyncCallbacks();

    assert.equal(hrefs.length, countAfterRemove);
});

test("shared storage helpers reject chrome lastError", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", chrome);
    evalRepoScript(dom, "shared", "data.js");

    const failingArea = {
        get(_key, callback) {
            chrome.runtime.lastError = { message: "read failed" };
            callback({});
            chrome.runtime.lastError = null;
        },
        set(_value, callback) {
            chrome.runtime.lastError = { message: "write failed" };
            callback();
            chrome.runtime.lastError = null;
        },
        remove(_key, callback) {
            chrome.runtime.lastError = { message: "remove failed" };
            callback();
            chrome.runtime.lastError = null;
        },
    };
    const { storageGet, storageRemove, storageSet } = dom.window.BetterChzzk.utils;

    await assert.rejects(
        () => storageGet(failingArea, "key"),
        (error) => error.message === "read failed"
    );
    await assert.rejects(
        () => storageSet(failingArea, { key: "value" }),
        (error) => error.message === "write failed"
    );
    await assert.rejects(
        () => storageRemove(failingArea, "key"),
        (error) => error.message === "remove failed"
    );
});

test("shared main video helper ignores following preview player videos", () => {
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div class="bcfp-player" data-bcfp-player-mount="preview"><video id="previewVideo"></video></div>',
            '<main><video id="mainVideo"></video></main>',
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test",
        createFakeChrome()
    );
    evalContentScripts(dom);

    const { BetterChzzk, document } = dom.window;
    const previewVideo = document.getElementById("previewVideo");
    const mainVideo = document.getElementById("mainVideo");

    previewVideo.getBoundingClientRect = () => ({
        width: 800,
        height: 450,
        left: 0,
        top: 0,
        right: 800,
        bottom: 450,
    });
    mainVideo.getBoundingClientRect = () => ({
        width: 320,
        height: 180,
        left: 0,
        top: 0,
        right: 320,
        bottom: 180,
    });

    assert.equal(BetterChzzk.utils.isExtensionPreviewVideo(previewVideo), true);
    assert.equal(BetterChzzk.utils.isExtensionPreviewVideo(mainVideo), false);
    assert.equal(BetterChzzk.utils.getMainVideoElement(), mainVideo);
});

test("shared CHZZK comment helper reuses extension storage device id and page.next request shape", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/video/123", chrome);
    const requests = [];
    dom.window.fetch = async (url, init) => {
        requests.push({ init, url: String(url) });
        return {
            ok: true,
            json: async () => ({
                code: 200,
                content: { commentActive: true, comments: { data: [], page: { next: null } } },
            }),
        };
    };
    evalRepoScript(dom, "shared", "data.js");

    const { fetchChzzkCommentPage } = dom.window.BetterChzzk.utils;
    await fetchChzzkCommentPage({ limit: 10, objectId: "123", offset: 20, orderType: "DESC" });
    await fetchChzzkCommentPage({ limit: 10, objectId: "123", offset: 30, orderType: "DESC" });

    assert.equal(requests.length, 2);
    const firstUrl = new URL(requests[0].url);
    assert.equal(firstUrl.pathname, "/nng_main/nng_comment_api/v1/type/STREAMING_VIDEO/id/123/comments");
    assert.equal(firstUrl.searchParams.get("limit"), "10");
    assert.equal(firstUrl.searchParams.get("offset"), "20");
    assert.equal(firstUrl.searchParams.get("orderType"), "DESC");
    assert.equal(firstUrl.searchParams.has("pagingType"), false);
    assert.equal(requests[0].init.headers["Front-Client-Platform-Type"], "PC");
    assert.equal(requests[0].init.headers["Front-Client-Product-Type"], "web");
    assert.ok(requests[0].init.headers.deviceId);
    assert.equal(requests[1].init.headers.deviceId, requests[0].init.headers.deviceId);
    assert.equal(chrome.testState.local.betterchzzkCommentDeviceId, requests[0].init.headers.deviceId);
    assert.equal(dom.window.localStorage.getItem("betterchzzk-comment-device-id"), null);

    dom.window.close();
});

test("shared watch-range helpers normalize, merge, and sum ranges", () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalRepoScript(dom, "shared", "data.js");

    const { mergeWatchRanges, sumWatchRanges } = dom.window.BetterChzzk.utils;
    const ranges = [
        { startAt: 5000, endAt: 7000 },
        { start: 1000.4, end: 2000.6 },
        { startAt: 3200, endAt: 4500 },
        { startAt: 9000, endAt: 8500 },
    ];

    assert.equal(
        JSON.stringify(mergeWatchRanges(ranges, 1000)),
        JSON.stringify([
            { startAt: 1000, endAt: 2001 },
            { startAt: 3200, endAt: 7000 },
        ])
    );
    assert.equal(JSON.stringify(mergeWatchRanges(ranges, 1500)), JSON.stringify([{ startAt: 1000, endAt: 7000 }]));
    assert.equal(sumWatchRanges(ranges, 1000), 4.801);
});

const AD_SUPPRESS_ATTR = "data-betterchzzk-suppress-adblock-popup";
const ADBLOCK_POPUP_TITLE =
    "\uAD11\uACE0 \uCC28\uB2E8 \uD504\uB85C\uADF8\uB7A8\uC744 \uC0AC\uC6A9 \uC911\uC774\uC2E0\uAC00\uC694?";

function makeVisibleElement(el, width = 450, height = 260) {
    el.getBoundingClientRect = () => ({
        width,
        height,
        left: 0,
        top: 0,
        right: width,
        bottom: height,
    });
}

const MONTHLY_BROADCAST_WIDGET_ID = "betterchzzk-monthly-broadcast-time";
const MONTHLY_BROADCAST_CHANNEL_ID = "0123456789abcdef0123456789abcdef";

function createDeferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function createTestAbortError() {
    const error = new Error("Aborted");
    error.name = "AbortError";
    return error;
}

function waitForDeferredWithAbort(deferred, signal) {
    if (!deferred) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(createTestAbortError());

    return new Promise((resolve, reject) => {
        function cleanup() {
            signal?.removeEventListener("abort", abort);
        }

        function abort() {
            cleanup();
            reject(createTestAbortError());
        }

        signal?.addEventListener("abort", abort, { once: true });
        deferred.promise.then(
            () => {
                cleanup();
                resolve();
            },
            (error) => {
                cleanup();
                reject(error);
            }
        );
    });
}

async function createMonthlyBroadcastFixture({
    deferList = false,
    details = {},
    nowMs = Date.parse("2026-06-29T12:00:00+09:00"),
    videos = [],
    watchHistory = [],
    watchDisplay = true,
} = {}) {
    const chrome = createFakeChrome({
        local: {
            betterChzzkLiveWatchHistory: { entries: watchHistory },
        },
        sync: {
            monthlyBroadcastTimeEnabled: true,
            monthlyBroadcastTimeCalendarEnabled: true,
            monthlyBroadcastTimeWatchEnabled: watchDisplay,
            monthlyBroadcastTimeMaxCalendarPages: 5,
            monthlyBroadcastTimeMaxPages: 5,
            monthlyBroadcastTimeWindowDays: 30,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main id="channel">',
            '<section id="profile">',
            '<div id="actions"><button id="follow" type="button">팔로우</button></div>',
            "</section>",
            "</main>",
            "</body>",
        ].join(""),
        `https://chzzk.naver.com/${MONTHLY_BROADCAST_CHANNEL_ID}`,
        chrome
    );
    const { document } = dom.window;
    const listGate = deferList ? createDeferred() : null;
    const fetchCalls = [];
    const fetchInits = [];

    dom.window.Date.now = () => nowMs;
    document.getElementById("profile").getBoundingClientRect = () => ({
        width: 640,
        height: 80,
        left: 0,
        top: 0,
        right: 640,
        bottom: 80,
    });
    document.getElementById("actions").getBoundingClientRect = () => ({
        width: 280,
        height: 42,
        left: 260,
        top: 24,
        right: 540,
        bottom: 66,
    });
    document.getElementById("follow").getBoundingClientRect = () => ({
        width: 90,
        height: 34,
        left: 430,
        top: 28,
        right: 520,
        bottom: 62,
    });

    dom.window.fetch = async (url, init = {}) => {
        const href = String(url);
        fetchCalls.push(href);
        fetchInits.push({ href, init });

        if (href.includes("/service/v1/channels/")) {
            await waitForDeferredWithAbort(listGate, init.signal);
            return {
                ok: true,
                json: async () => ({
                    content: {
                        data: videos,
                        last: true,
                        page: { number: 0 },
                        totalPages: 1,
                    },
                }),
            };
        }

        if (href.includes("/service/v2/videos/")) {
            const videoNo = decodeURIComponent(href.split("/").pop());
            return {
                ok: true,
                json: async () => ({
                    content: {
                        videoNo,
                        ...(details[videoNo] || {}),
                    },
                }),
            };
        }

        throw new Error(`Unexpected monthly broadcast request: ${href}`);
    };

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalFeatureModules(dom, "monthlyBroadcastTime");
    evalRepoScript(dom, "features", "monthlyBroadcastTime.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));

    await waitForCondition(() => document.getElementById(MONTHLY_BROADCAST_WIDGET_ID));

    return {
        chrome,
        document,
        dom,
        fetchCalls,
        fetchInits,
        resolveList: () => listGate?.resolve(),
    };
}

function getMonthlyCalendarDay(document, dateKey) {
    return document.querySelector(`#${MONTHLY_BROADCAST_WIDGET_ID} .bcmb-day[data-date-key="${dateKey}"]`);
}

async function closeMonthlyBroadcastFixture(fixture) {
    for (const listener of fixture.chrome.testState.storageChangeListeners) {
        listener({ monthlyBroadcastTimeEnabled: { newValue: false } }, "sync");
    }
    await waitForAsyncCallbacks();
    fixture.dom.window.close();
}

test("monthly broadcast calendar colors KST days after async metadata load", async () => {
    const firstStartMs = Date.parse("2026-06-28T23:30:00+09:00");
    const secondStartMs = Date.parse("2026-06-28T00:30:00+09:00");
    const fixture = await createMonthlyBroadcastFixture({
        deferList: true,
        details: {
            detailStart: {
                duration: 30 * 60,
                liveCloseDate: new Date(secondStartMs + 30 * 60 * 1000).toISOString(),
                liveOpenDate: "2026-06-28T00:30:00+09:00",
                videoTitle: "Detail start fixture",
            },
        },
        videos: [
            {
                duration: 20 * 60,
                liveCloseDate: new Date(firstStartMs + 20 * 60 * 1000).toISOString(),
                liveOpenDate: "2026-06-28T23:30:00+09:00",
                videoNo: "lateStart",
                videoTitle: "Late start fixture",
                videoType: "REPLAY",
            },
            {
                duration: 30 * 60,
                videoNo: "detailStart",
                videoTitle: "Detail start fixture",
                videoType: "REPLAY",
            },
        ],
    });

    try {
        assert.equal(
            fixture.document.querySelector(`#${MONTHLY_BROADCAST_WIDGET_ID} .bcmb-day[data-has-broadcast="1"]`),
            null
        );

        fixture.resolveList();

        await waitForCondition(
            () => getMonthlyCalendarDay(fixture.document, "2026-06-28")?.getAttribute("data-has-broadcast") === "1",
            { timeoutMs: 3000 }
        );

        const day = getMonthlyCalendarDay(fixture.document, "2026-06-28");
        const tipText = day.querySelector(".bcmb-day-tip").textContent;

        assert.equal(day.getAttribute("data-date-key"), "2026-06-28");
        assert.equal(day.getAttribute("data-live"), "1");
        assert.equal(
            fixture.document.querySelector(`#${MONTHLY_BROADCAST_WIDGET_ID} .bcmb-calendar-count`).textContent,
            "총 방송 50분"
        );
        assert.ok(fixture.fetchCalls.some((href) => href.includes("/service/v2/videos/detailStart")));
        assert.equal(getMonthlyCalendarDay(fixture.document, "2026-06-27")?.getAttribute("data-has-broadcast"), null);
        assert.equal(day.querySelectorAll(".bcmb-day-tip-item").length, 2);
        assert.match(tipText, /00:30/);
        assert.match(tipText, /01:00/);
        assert.match(tipText, /23:30/);
        assert.match(tipText, /23:50/);
    } finally {
        await closeMonthlyBroadcastFixture(fixture);
    }
});

test("monthly broadcast aborts pending page fetches when disabled", async () => {
    const fixture = await createMonthlyBroadcastFixture({
        deferList: true,
        videos: [
            {
                duration: 20 * 60,
                liveCloseDate: "2026-06-28T09:20:00+09:00",
                liveOpenDate: "2026-06-28T09:00:00+09:00",
                videoNo: "abort-pending",
                videoTitle: "Abort pending fixture",
                videoType: "REPLAY",
            },
        ],
    });

    const pending = fixture.fetchInits.find((call) => call.href.includes("/service/v1/channels/"));
    assert.ok(pending?.init.signal instanceof fixture.dom.window.AbortSignal);

    await closeMonthlyBroadcastFixture(fixture);

    assert.equal(pending.init.signal.aborted, true);
});

test("monthly broadcast calendar combines split VODs into one continuous broadcast", async () => {
    const liveOpenDate = "2026-07-10 19:01:32";
    const fixture = await createMonthlyBroadcastFixture({
        nowMs: Date.parse("2026-07-13T12:00:00+09:00"),
        videos: [
            {
                duration: 7 * 60 * 60 + 55 * 60 + 56,
                liveOpenDate,
                publishDate: "2026-07-12 16:55:34",
                videoNo: "14154992",
                videoTitle: "Split segment three",
                videoType: "REPLAY",
            },
            {
                duration: 17 * 60 * 60 + 1,
                liveOpenDate,
                publishDate: "2026-07-12 14:28:21",
                videoNo: "14152282",
                videoTitle: "Split segment two",
                videoType: "REPLAY",
            },
            {
                duration: 17 * 60 * 60,
                liveOpenDate,
                publishDate: "2026-07-11 12:18:00",
                videoNo: "14137551",
                videoTitle: "Split segment one",
                videoType: "REPLAY",
            },
        ],
    });

    try {
        await waitForCondition(
            () => getMonthlyCalendarDay(fixture.document, "2026-07-10")?.getAttribute("data-has-broadcast") === "1",
            { timeoutMs: 3000 }
        );

        const day = getMonthlyCalendarDay(fixture.document, "2026-07-10");
        const items = day.querySelectorAll(".bcmb-day-tip-item");
        const broadcastText = day.querySelector(".bcmb-day-tip-row-broadcast .bcmb-day-tip-value").textContent;

        assert.equal(items.length, 1);
        assert.equal(day.getAttribute("data-video-no"), "14137551");
        assert.match(broadcastText, /19:01/);
        assert.match(broadcastText, /12:57 \(7\/12\)/);
        assert.match(broadcastText, /41시간 56분/);
        assert.equal(
            fixture.document.querySelector(`#${MONTHLY_BROADCAST_WIDGET_ID} .bcmb-calendar-count`).textContent,
            "총 방송 41시간 56분"
        );
    } finally {
        await closeMonthlyBroadcastFixture(fixture);
    }
});

function evalAdblockPopupScripts(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "adblockPopup.js");
}

function evalFollowingRefreshScripts(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "followingRefresh.js");
}

async function loadAdblockPopupPage(dom) {
    evalAdblockPopupScripts(dom);
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
}

function getAdblockSuppressAttr(el) {
    return el.getAttribute(AD_SUPPRESS_ATTR);
}

test("adblock popup runs an initial pass before DOMContentLoaded", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div class="_dimmed_10ysp_2" id="dimmed">',
            '<div class="_container_10ysp_20 _modal_10ysp_27" id="modal" role="alertdialog" aria-modal="true">',
            ADBLOCK_POPUP_TITLE,
            "</div>",
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const dimmed = document.getElementById("dimmed");
    const modal = document.getElementById("modal");
    makeVisibleElement(dimmed, 1000, 800);
    makeVisibleElement(modal);

    evalAdblockPopupScripts(dom);

    assert.equal(getAdblockSuppressAttr(modal), "1");
    assert.equal(getAdblockSuppressAttr(dimmed), "1");
});

test("adblock popup suppresses the current chzzk alertdialog modal after it appears", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/live/test-channel", chrome);
    const { document } = dom.window;
    document.body.style.overflow = "hidden";
    document.body.style.paddingRight = "15px";

    await loadAdblockPopupPage(dom);

    const dimmed = document.createElement("div");
    dimmed.id = "dimmed";
    dimmed.className = "_dimmed_10ysp_2";
    const modal = document.createElement("div");
    modal.id = "modal";
    modal.className = "_container_10ysp_20 _modal_10ysp_27";
    modal.setAttribute("role", "alertdialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = `<strong>${ADBLOCK_POPUP_TITLE}</strong><p>\uAD11\uACE0 \uCC28\uB2E8 \uD504\uB85C\uADF8\uB7A8 \uC0AC\uC6A9 \uC2DC \uC7AC\uC0DD \uD658\uACBD\uC5D0 \uC601\uD5A5\uC744 \uBBF8\uCE60 \uC218 \uC788\uC2B5\uB2C8\uB2E4.</p>`;
    dimmed.appendChild(modal);
    makeVisibleElement(dimmed, 1000, 800);
    makeVisibleElement(modal);
    document.body.appendChild(dimmed);

    await waitForAsyncCallbacks();

    assert.equal(getAdblockSuppressAttr(modal), "1");
    assert.equal(getAdblockSuppressAttr(dimmed), "1");
    assert.equal(document.body.style.overflow, "");
    assert.equal(document.body.style.paddingRight, "");
});

test("adblock popup does not suppress unrelated extension alertdialogs", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div class="_dimmed_10ysp_2" id="dimmed">',
            '<div class="_container_10ysp_20 _modal_10ysp_27" id="modal" role="alertdialog" aria-modal="true">',
            "\uD655\uC7A5 \uD504\uB85C\uADF8\uB7A8 \uC124\uCE58 \uC548\uB0B4",
            "</div>",
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const dimmed = document.getElementById("dimmed");
    const modal = document.getElementById("modal");
    makeVisibleElement(dimmed, 1000, 800);
    makeVisibleElement(modal);

    await loadAdblockPopupPage(dom);

    assert.equal(getAdblockSuppressAttr(modal), null);
    assert.equal(getAdblockSuppressAttr(dimmed), null);
});

test("shared selector registry preserves lookup priority and warns once per stale anchor", async () => {
    const dom = createPageDom(
        `
        <div id="generic-dimmed" class="overlay"></div>
        <div id="legacy-dimmed" class="popup_dimmed__zs78t"></div>
        <div id="popup-start" class="popup_container__newHash"></div>
        <div id="popup-second" class="other popup_container__newerHash"></div>
        `,
        "https://chzzk.naver.com/live/selector-test",
        createFakeChrome()
    );
    const warnings = [];
    dom.window.console.warn = (...args) => warnings.push(args.join(" "));

    evalRepoScript(dom, "shared", "selectors.js");

    const { CHZZK, queryChain, queryChainAll, watchSelector } = dom.window.BetterChzzk.selectors;
    assert.equal(queryChain(dom.window.document, CHZZK.popupDimmed)?.id, "legacy-dimmed");
    assert.deepEqual(
        Array.from(queryChainAll(dom.window.document, CHZZK.popupDimmed), (element) => element.id),
        ["legacy-dimmed"]
    );
    assert.equal(queryChain(dom.window.document, CHZZK.popupContainer)?.id, "popup-start");

    dom.window.document.querySelector("#popup-start").remove();
    assert.equal(queryChain(dom.window.document, CHZZK.popupContainer)?.id, "popup-second");

    watchSelector("playerRoot", dom.window.document, 0);
    watchSelector("playerRoot", dom.window.document, 0);
    await waitForAsyncCallbacks();

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /selector stale: playerRoot/);
    dom.window.close();
});

test("manifest loads shared and playback scripts in the expected worlds", () => {
    const manifest = JSON.parse(readRepoFile("manifest.json"));
    const packageJson = JSON.parse(readRepoFile("package.json"));
    const packageLock = JSON.parse(readRepoFile("package-lock.json"));
    const updateHistory = readRepoFile("docs", "update-history.md");
    const mainScript = manifest.content_scripts.find((entry) => entry.world === "MAIN");
    const isolatedScript = manifest.content_scripts.find((entry) => entry.js?.includes("features/volumeWheel.js"));
    const vodCommentModules = [
        "features/vodComments/model.js",
        "features/vodComments/repository.js",
        "features/vodComments/nativeAdapter.js",
        "features/vodComments/view.js",
    ];

    assert.ok(mainScript);
    assert.ok(isolatedScript);
    assert.equal(manifest.version, "1.3.6");
    assert.equal(packageJson.version, manifest.version);
    assert.equal(packageLock.version, manifest.version);
    assert.equal(packageLock.packages[""].version, manifest.version);
    assert.equal(updateHistory.match(/^##\s+(\d+\.\d+\.\d+)/m)?.[1], manifest.version);
    assert.deepEqual(manifest.permissions, ["storage", "scripting"]);
    assert.deepEqual(manifest.host_permissions, [
        "https://api.chzzk.naver.com/*",
        "https://apis.naver.com/*",
        "https://chzzk.naver.com/*",
    ]);
    assert.deepEqual(manifest.optional_host_permissions, ["https://*.pstatic.net/*"]);
    assert.ok(mainScript.js.includes("features/routeBridgePage.js"));
    assert.equal(mainScript.js.includes("features/followingPreviewPage.js"), false);
    assert.ok(
        mainScript.js.indexOf("features/routeBridgePage.js") < mainScript.js.indexOf("features/autoQualityPage.js")
    );
    assert.ok(mainScript.js.includes("features/volumeWheelPage.js"));
    assert.ok(
        mainScript.js.indexOf("features/volumeWheelPage.js") > mainScript.js.indexOf("features/autoQualityPage.js")
    );
    assert.ok(isolatedScript.js.includes("features/volumeWheel.js"));
    assert.ok(isolatedScript.js.includes("features/sidebarCustomization.js"));
    assert.ok(
        isolatedScript.js.indexOf("features/sidebarCustomization.js") <
            isolatedScript.js.indexOf("features/followingRefresh.js")
    );
    assert.ok(isolatedScript.js.includes("vendor/hls.light.min.js"));
    assert.ok(isolatedScript.js.includes("features/followingPreviewTooltip.js"));
    assert.ok(isolatedScript.js.includes("shared/selectors.js"));
    assert.ok(isolatedScript.js.indexOf("shared/selectors.js") > isolatedScript.js.indexOf("shared/data.js"));
    assert.ok(isolatedScript.js.indexOf("shared/selectors.js") < isolatedScript.js.indexOf("content.js"));
    assert.ok(isolatedScript.js.includes("shared/vodTimeline.js"));
    assert.ok(isolatedScript.js.indexOf("shared/vodTimeline.js") > isolatedScript.js.indexOf("content.js"));
    assert.ok(
        isolatedScript.js.indexOf("shared/vodTimeline.js") < isolatedScript.js.indexOf("features/vodBroadcastClock.js")
    );
    assert.ok(
        isolatedScript.js.indexOf("shared/vodTimeline.js") <
            isolatedScript.js.indexOf("features/monthlyBroadcastTime.js")
    );
    assert.ok(isolatedScript.js.indexOf("features/volumeWheel.js") > isolatedScript.js.indexOf("content.js"));
    assert.ok(
        isolatedScript.js.indexOf("vendor/hls.light.min.js") <
            isolatedScript.js.indexOf("features/followingPreviewTooltip.js")
    );
    assert.ok(isolatedScript.js.includes("features/chatTools.js"));
    assert.ok(
        isolatedScript.js.indexOf("features/chatTools.js") > isolatedScript.js.indexOf("features/rewardAutoCollect.js")
    );
    assert.ok(
        isolatedScript.js.indexOf("features/chatTools.js") < isolatedScript.js.indexOf("features/videoSearch.js")
    );
    assert.ok(isolatedScript.js.includes("features/vodCommentTabs.js"));
    assert.ok(
        isolatedScript.js.indexOf("features/vodCommentTabs.js") >
            isolatedScript.js.indexOf("features/vodReplayChatFix.js")
    );
    for (const modulePath of vodCommentModules) {
        assert.ok(isolatedScript.js.includes(modulePath));
        assert.ok(isolatedScript.js.indexOf(modulePath) < isolatedScript.js.indexOf("features/vodCommentTabs.js"));
    }
    assert.deepEqual(
        vodCommentModules.map((modulePath) => isolatedScript.js.indexOf(modulePath)),
        [...vodCommentModules]
            .map((modulePath) => isolatedScript.js.indexOf(modulePath))
            .sort((left, right) => left - right)
    );
    assert.ok(isolatedScript.js.includes("features/holdSpeed.js"));
    assert.equal(isolatedScript.js.includes("features/shortcutRescue.js"), false);
    assert.equal(fs.existsSync(path.join(repoRoot, "features/shortcutRescue.js")), false);
    assert.ok(
        isolatedScript.js.indexOf("features/skipControl.js") < isolatedScript.js.indexOf("features/holdSpeed.js")
    );
});

async function loadVideoSearchPage(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalFeatureModules(dom, "videoSearch");
    evalRepoScript(dom, "features", "videoSearch.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();
}

async function loadCategoryToolsPage(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalFeatureModules(dom, "categoryTools");
    evalRepoScript(dom, "features", "categoryTools.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();
}

function setElementRect(el, { left = 0, top = 0, width = 100, height = 40 } = {}) {
    el.getBoundingClientRect = () => ({
        x: left,
        y: top,
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
    });
}

function createCategoryToolsDom(chrome) {
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<nav id="tabs">',
            "<button>라이브</button>",
            "<button>동영상</button>",
            "<button>클립</button>",
            "</nav>",
            '<main id="grid">',
            '<article id="card-a"><a href="/live/channel-a"><strong>Alpha live</strong><span>LIVE 10명</span></a></article>',
            '<article id="card-b"><a href="/live/channel-b"><strong>Beta live</strong><span>LIVE 20명</span></a></article>',
            "</main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/category/game/test/lives",
        chrome
    );
    const { document } = dom.window;
    setElementRect(document.getElementById("tabs"), { left: 16, top: 20, width: 360, height: 40 });
    document.querySelectorAll("#tabs button").forEach((button, index) => {
        setElementRect(button, { left: 24 + index * 80, top: 24, width: 70, height: 32 });
    });
    setElementRect(document.getElementById("grid"), { left: 16, top: 100, width: 760, height: 560 });
    setElementRect(document.getElementById("card-a"), { left: 24, top: 120, width: 320, height: 180 });
    setElementRect(document.querySelector('#card-a a[href="/live/channel-a"]'), {
        left: 24,
        top: 120,
        width: 320,
        height: 180,
    });
    setElementRect(document.getElementById("card-b"), { left: 24, top: 5000, width: 320, height: 180 });
    setElementRect(document.querySelector('#card-b a[href="/live/channel-b"]'), {
        left: 24,
        top: 5000,
        width: 320,
        height: 180,
    });
    return dom;
}

function createGlobalLivesDom(chrome, { nestedScroll = false } = {}) {
    const scrollOpen = nestedScroll ? '<div id="scroll-shell" style="overflow-y:auto">' : "";
    const scrollClose = nestedScroll ? "</div>" : "";
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<section id="global-section">',
            '<nav id="global-tabs"><a href="/lives" aria-current="page">라이브</a><a href="/videos">동영상</a></nav>',
            '<div id="native-filter"><input type="search" placeholder="태그 검색" aria-label="태그 검색"></div>',
            '<div id="sort-row">',
            '<button aria-selected="true">인기</button>',
            "<button>최신</button>",
            "<button>추천</button>",
            "</div>",
            scrollOpen,
            '<main id="grid">',
            '<article id="live-card-a">' +
                '<a class="_thumbnail" href="/live/native-a">' +
                '<picture><source srcset="https://nng-phinf.pstatic.net/a-source.jpg" ' +
                'data-srcset="https://nng-phinf.pstatic.net/a-lazy-source.jpg">' +
                '<img src="https://nng-phinf.pstatic.net/a.jpg" srcset="https://nng-phinf.pstatic.net/a-2x.jpg 2x" ' +
                'data-src="https://nng-phinf.pstatic.net/a-lazy.jpg" width="320" height="180" alt=""></picture></a>' +
                '<a class="_title" href="/live/native-a"><strong class="_live_title">Native A</strong></a>' +
                "<span>LIVE 10명</span>" +
                '<a class="_image" href="/live/native-a">' +
                '<img class="_profile" src="https://nng-phinf.pstatic.net/profile-a.jpg" width="40" height="40" alt="">' +
                '<span class="_blind">Template Channel 채널로 이동</span></a>' +
                '<a class="_channel" href="/live/native-a" aria-label="Template Channel 채널로 이동" ' +
                'title="Template Channel"><span class="_ellipsis"><span class="_text">Template Channel</span></span>' +
                '<span class="_blind">Template Channel 채널로 이동</span>' +
                '<span data-bcgt-follower-wrap="1"><span data-bcgt-follower-badge="1">44.7만</span></span>' +
                "</a></article>",
            '<article id="live-card-b">' +
                '<a class="_thumbnail" href="/live/native-b">' +
                '<picture><source srcset="https://nng-phinf.pstatic.net/b-source.jpg" ' +
                'data-srcset="https://nng-phinf.pstatic.net/b-lazy-source.jpg">' +
                '<img src="https://nng-phinf.pstatic.net/b.jpg" srcset="https://nng-phinf.pstatic.net/b-2x.jpg 2x" ' +
                'data-src="https://nng-phinf.pstatic.net/b-lazy.jpg" width="320" height="180" alt=""></picture></a>' +
                '<a class="_title" href="/live/native-b"><strong class="_live_title">Native B</strong></a>' +
                "<span>LIVE 20명</span>" +
                '<a class="_image" href="/live/native-b">' +
                '<img class="_profile" src="https://nng-phinf.pstatic.net/profile-b.jpg" width="40" height="40" alt="">' +
                '<span class="_blind">Second Template Channel 채널로 이동</span></a>' +
                '<a class="_channel" href="/live/native-b" aria-label="Second Template Channel 채널로 이동" ' +
                'title="Second Template Channel">' +
                '<span class="_ellipsis"><span class="_text">Second Template Channel</span></span>' +
                '<span class="_blind">Second Template Channel 채널로 이동</span>' +
                '<span data-bcgt-follower-wrap="1"><span data-bcgt-follower-badge="1">99.9만</span></span>' +
                "</a></article>",
            '<div id="native-sentinel">Loading</div>',
            "</main>",
            scrollClose,
            "</section>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/lives",
        chrome
    );
    const { document } = dom.window;
    setElementRect(document.getElementById("global-section"), { left: 16, top: 96, width: 1160, height: 1200 });
    setElementRect(document.getElementById("global-tabs"), { left: 32, top: 112, width: 1120, height: 48 });
    document.querySelectorAll("#global-tabs a").forEach((tab, index) => {
        setElementRect(tab, { left: 40 + index * 88, top: 120, width: 76, height: 32 });
    });
    setElementRect(document.getElementById("native-filter"), { left: 32, top: 168, width: 1120, height: 68 });
    setElementRect(document.querySelector("#native-filter input"), { left: 896, top: 184, width: 240, height: 36 });
    setElementRect(document.getElementById("sort-row"), { left: 32, top: 209, width: 1120, height: 44 });
    document.querySelectorAll("#sort-row button").forEach((button, index) => {
        setElementRect(button, { left: 40 + index * 70, top: 215, width: 60, height: 32 });
    });
    setElementRect(document.getElementById("grid"), { left: 32, top: 280, width: 1120, height: 900 });
    setElementRect(document.getElementById("live-card-a"), { left: 40, top: 300, width: 320, height: 240 });
    setElementRect(document.querySelector("#live-card-a a._thumbnail"), {
        left: 40,
        top: 300,
        width: 320,
        height: 180,
    });
    setElementRect(document.getElementById("live-card-b"), { left: 384, top: 300, width: 320, height: 240 });
    setElementRect(document.querySelector("#live-card-b a._thumbnail"), {
        left: 384,
        top: 300,
        width: 320,
        height: 180,
    });
    // global-lives 카드 판정은 링크 내부 미디어의 실제 rect(120x70 이상)를 요구한다.
    setElementRect(document.querySelector("#live-card-a img"), { left: 40, top: 300, width: 320, height: 180 });
    setElementRect(document.querySelector("#live-card-b img"), { left: 384, top: 300, width: 320, height: 180 });

    const getDefaultRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function getFixtureRect() {
        if (this.id === "betterchzzk-category-tools") {
            return {
                x: 300,
                y: 213,
                left: 300,
                top: 213,
                right: 820,
                bottom: 253,
                width: 520,
                height: 40,
            };
        }
        return getDefaultRect.call(this);
    };
    if (nestedScroll) {
        const shell = document.getElementById("scroll-shell");
        Object.defineProperties(shell, {
            clientHeight: { configurable: true, value: 600 },
            scrollHeight: { configurable: true, value: 2400 },
        });
    }
    return dom;
}

// 주입 카드가 경과 시간 배지 interval을 살려두므로, 기능을 꺼서 타이머를 정리하고 창을 닫는다.
async function closeCategoryToolsFixture(dom, chrome) {
    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ categoryToolsEnabled: { newValue: false } }, "sync");
    }
    await waitForAsyncCallbacks();
    dom.window.close();
}

const DEFAULT_GLOBAL_LIVES_FIXTURE = [
    {
        liveId: 500000,
        openDate: "2026-04-01 01:00:00",
        adult: false,
        channelId: "old-1",
        channelName: "Old Channel One",
        title: "Oldest live",
        views: 250,
    },
    {
        liveId: 500500,
        openDate: "2026-04-03 01:00:00",
        adult: false,
        channelId: "old-2",
        channelName: "Old Channel Two",
        title: "Second oldest",
        views: 50,
    },
    { liveId: 501000, openDate: "2026-04-05 01:00:00", adult: true, channelId: "old-adult", title: "Adult live" },
    ...Array.from({ length: 9 }, (_, index) => ({
        liveId: 999991 + index,
        openDate: `2026-07-06 0${index}:00:00`,
        adult: false,
        channelId: `new-${index}`,
        title: `Recent ${index}`,
    })),
];

// /v1/lives 목업: liveId가 openDate와 단조 증가하는 가상 라이브 목록.
// 커서(liveId) 미만을 내림차순으로 페이지네이션해 실제 API의 커서 점프 동작을 흉내 낸다.
function createGlobalLivesApiMock(lives = DEFAULT_GLOBAL_LIVES_FIXTURE) {
    return function livesResponse(href) {
        const url = new URL(href);
        const size = Number(url.searchParams.get("size")) || 50;
        const cursor = url.searchParams.get("liveId");
        let rows = lives.slice().sort((a, b) => b.liveId - a.liveId);
        if (cursor !== null) rows = rows.filter((row) => row.liveId < Number(cursor));
        const pageRows = rows.slice(0, size);
        const hasMore = rows.length > pageRows.length;
        return {
            content: {
                data: pageRows.map((row) => ({
                    liveId: row.liveId,
                    liveTitle: row.title,
                    liveImageUrl: row.imageUrl || `https://nng-phinf.pstatic.net/${row.channelId}_{type}.jpg`,
                    concurrentUserCount: row.views ?? 5,
                    openDate: row.openDate,
                    adult: row.adult,
                    tags: [],
                    liveCategoryValue: "테스트",
                    channel: {
                        channelId: row.channelId,
                        channelName: row.channelName || row.channelId,
                        channelImageUrl: row.channelImageUrl || "",
                    },
                })),
                page: hasMore
                    ? { next: { concurrentUserCount: 0, liveId: pageRows[pageRows.length - 1].liveId } }
                    : { next: null },
            },
        };
    };
}

function createVideoSearchDom(chrome) {
    return createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main id="app">',
            '<section id="grid">',
            '<article><a href="/video/100"><strong>Existing 100</strong><span>1:00</span></a></article>',
            '<article><a href="/video/101"><strong>Existing 101</strong><span>1:00</span></a></article>',
            "</section>",
            "</main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/0123456789abcdef0123456789abcdef/videos",
        chrome
    );
}

function getVideoSearchInput(dom) {
    return dom.window.document.querySelector("#betterchzzk-video-search-bar input");
}

function searchVideoSearchInput(dom, value) {
    const input = getVideoSearchInput(dom);
    assert.ok(input);
    input.value = value;
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

test("category filter stays open during automatic refresh and closes only on user outside clicks or its toggle", async (t) => {
    const chrome = createFakeChrome({
        sync: { categoryToolsFollowerBadgesEnabled: false, categoryToolsLiveElapsedEnabled: false },
    });
    const dom = createCategoryToolsDom(chrome);
    t.after(() => closeCategoryToolsFixture(dom, chrome));
    const { document } = dom.window;
    const intervals = captureIntervals(dom);
    const sidebar = document.createElement("aside");
    sidebar.innerHTML = '<a href="/following">팔로잉</a><button type="button" aria-label="새로고침">새로고침</button>';
    document.body.appendChild(sidebar);
    const refreshButton = sidebar.querySelector("button");
    let refreshes = 0;
    refreshButton.addEventListener("click", () => refreshes++);
    dom.window.fetch = async () => ({ ok: true, json: async () => ({ content: { data: [], page: { next: null } } }) });

    // jsdom clicks are untrusted. Capture document listeners to exercise the user-origin branch explicitly.
    const documentClicks = [];
    const addEventListener = document.addEventListener.bind(document);
    document.addEventListener = (type, listener, options) => {
        if (type === "click") documentClicks.push(listener);
        addEventListener(type, listener, options);
    };
    const userClick = (target, detail = 1) => {
        for (const listener of documentClicks) listener({ target, isTrusted: true, detail });
    };

    await loadCategoryToolsPage(dom);
    await waitForCondition(() => document.getElementById("betterchzzk-category-tools"));
    evalRepoScript(dom, "features", "followingRefresh.js");
    const bar = document.getElementById("betterchzzk-category-tools");
    const menu = document.getElementById("betterchzzk-category-filter-menu");
    const filter = bar.querySelector(".bcgt-filter");
    const assertOpen = () => {
        assert.equal(bar.getAttribute("data-menu-open"), "1");
        assert.equal(menu.getAttribute("data-open"), "1");
    };
    const assertClosed = () => {
        assert.equal(bar.getAttribute("data-menu-open"), "0");
        assert.equal(menu.getAttribute("data-open"), "0");
    };

    filter.click();
    assertOpen();
    const refreshTimer = intervals.find((entry) => entry.ms === 30000 && !entry.cleared);
    assert.ok(refreshTimer);
    refreshTimer.fn();
    assert.equal(refreshes, 1, "automatic sidebar refresh still runs");
    assertOpen();
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    assert.equal(refreshes, 2, "returning to the visible tab still refreshes the sidebar");
    assertOpen();

    const preset = menu.querySelector('[data-filter-kind="views"][data-filter-min="100"]');
    userClick(preset);
    preset.click();
    assertOpen();
    const input = menu.querySelector('[data-filter-min-input="views"]');
    userClick(input);
    input.value = "200";
    dispatch(dom, input, "input");
    assertOpen();
    menu.querySelector("[data-filter-reset]").click();
    dom.window.dispatchEvent(new dom.window.Event("scroll"));
    dom.window.dispatchEvent(new dom.window.Event("resize"));
    menu.dispatchEvent(new dom.window.MouseEvent("mouseleave"));
    assertOpen();

    userClick(filter.querySelector("span"));
    assertOpen();
    filter.click();
    assertClosed();
    for (const [target, detail] of [
        [refreshButton, 1],
        [refreshButton, 0],
        [bar.querySelector("input"), 1],
    ]) {
        filter.click();
        assertOpen();
        userClick(target, detail);
        assertClosed();
    }
});

test("category injected search results join the current pass without rescanning the card list", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            categoryToolsFollowerBadgesEnabled: true,
            categoryToolsFollowerFetchDelayMs: 0,
            categoryToolsLiveElapsedEnabled: true,
        },
    });
    const dom = createGlobalLivesDom(chrome);
    t.after(() => closeCategoryToolsFixture(dom, chrome));
    const { document } = dom.window;
    const response = createGlobalLivesApiMock(
        ["a", "b", "c"].map((id, index) => ({
            liveId: 100 + index,
            openDate: "2026-07-10 10:00:00",
            channelId: "native-" + id,
            channelName: "Channel " + id,
            title: "Match " + id,
            views: 10,
        }))
    );
    dom.window.fetch = async (url) => ({
        ok: true,
        json: async () =>
            String(url).includes("/v1/channels/") ? { content: { followerCount: 100 } } : response(String(url)),
    });
    await loadCategoryToolsPage(dom);
    await waitForCondition(() => document.querySelectorAll('[data-bcgt-card="1"]').length === 2);
    await waitForCondition(
        () => document.querySelector('#live-card-a [data-bcgt-follower-badge="1"]')?.title === "팔로워 100명"
    );
    const badgeWrap = document.querySelector('#live-card-a [data-bcgt-follower-wrap="1"]');
    const queryBadge = badgeWrap.querySelector.bind(badgeWrap);
    let badgeReads = 0;
    badgeWrap.querySelector = (selector) => {
        const result = queryBadge(selector);
        if (result?.getAttribute("data-bcgt-follower-badge") === "1") badgeReads++;
        return result;
    };
    const thumbnail = document.querySelector("#live-card-a ._thumbnail");
    const queryElapsed = thumbnail.querySelector.bind(thumbnail);
    let elapsedReads = 0;
    thumbnail.querySelector = (selector) => {
        const result = queryElapsed(selector);
        if (result?.getAttribute("data-bcgt-live-elapsed-badge") === "1") elapsedReads++;
        return result;
    };
    const grid = document.getElementById("grid");
    const append = grid.appendChild.bind(grid);
    let inserted = false;
    let rescans = 0;
    grid.appendChild = (node) => {
        if (node.querySelector?.('[data-bcgt-injected="1"]')) inserted = true;
        return append(node);
    };
    for (const root of [grid, ...grid.querySelectorAll("article")]) {
        const queryAll = root.querySelectorAll.bind(root);
        root.querySelectorAll = (selector) => {
            const result = queryAll(selector);
            if (inserted && result.length && [...result].every((node) => node.tagName === "A")) rescans++;
            return result;
        };
    }
    const input = document.querySelector('#betterchzzk-category-tools input[type="search"]');
    input.value = "Match";
    dispatch(dom, input, "input");
    await waitForCondition(() => document.querySelector(".bcgt-status")?.textContent === "3 / 3");
    assert.equal(inserted, true);
    assert.equal(elapsedReads, 1, "the elapsed badge is synchronized once per filtered apply");
    assert.equal(badgeReads, 1, "a filtered apply visits the existing badge once after computing its rows");
    assert.equal(rescans, 0, "new cards are consumed directly, without another full card enumeration");
    const injected = document.querySelector('[data-bcgt-injected="1"]');
    assert.equal(injected.getAttribute("data-bcgt-card-id"), "native-c");
    assert.notEqual(injected.getAttribute("data-bcgt-hide"), "1");
});

test("category search bounds injected cards and continues cached results on scroll", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            categoryToolsFollowerBadgesEnabled: false,
            categoryToolsLiveElapsedEnabled: false,
        },
    });
    const dom = createGlobalLivesDom(chrome);
    t.after(() => closeCategoryToolsFixture(dom, chrome));
    const clock = useFakePerformanceNow(dom);
    const { document } = dom.window;
    const grid = document.getElementById("grid");
    setElementRect(grid, { left: 32, top: 280, width: 1120, height: 4000 });
    setElementRect(document.getElementById("global-section"), { left: 16, top: 96, width: 1160, height: 4600 });
    const thumbnail =
        "https://livecloud-thumb.akamaized.net/chzzk/livecloud/KR/stream/26428721/live/21061396/record/58999967/thumbnail/image_{type}.jpg";
    const response = createGlobalLivesApiMock(
        Array.from({ length: 150 }, (_, index) => ({
            liveId: 1000 - index,
            channelId: index === 0 ? "native-a" : index === 1 ? "native-b" : `match-${index}`,
            title: `Match ${index}`,
            views: 20,
            imageUrl: thumbnail,
            channelImageUrl: "https://nng-phinf.pstatic.net/MjAy/image.png",
        }))
    );
    let requests = 0;
    dom.window.fetch = async (url) => {
        requests++;
        return { ok: true, json: async () => response(String(url)) };
    };
    await loadCategoryToolsPage(dom);
    await waitForCondition(() => document.querySelector(".bcgt-live-count")?.textContent.includes("150"));
    const input = document.querySelector('#betterchzzk-category-tools input[type="search"]');
    input.value = "Match";
    dispatch(dom, input, "input");
    await waitForCondition(() => document.querySelector(".bcgt-status")?.textContent.endsWith(" / 150"));
    const injected = () => [...grid.querySelectorAll('[data-bcgt-injected="1"]')];
    const firstCount = injected().length;
    assert.ok(firstCount > 0 && firstCount <= 24, `first render should be bounded, got ${firstCount}`);
    const image = injected()[0].querySelector("a._thumbnail img");
    assert.equal(image.getAttribute("src"), thumbnail.replace("{type}", "720"));
    assert.equal(image.getAttribute("loading"), "lazy");
    assert.equal(image.getAttribute("decoding"), "async");
    assert.equal(
        injected()[0].querySelector("img._profile").getAttribute("src"),
        "https://nng-phinf.pstatic.net/MjAy/image.png?type=f160_160_na"
    );
    const requestsBeforeScroll = requests;
    let previousCount = firstCount;
    grid.getBoundingClientRect = () => ({
        left: 32,
        top: 0,
        width: 1120,
        height: 200,
        bottom: injected().length > previousCount ? 4000 : 200,
        right: 1152,
    });
    while (injected().length < 148) {
        previousCount = injected().length;
        clock.advance(1000);
        dom.window.dispatchEvent(new dom.window.Event("scroll"));
        await waitForCondition(() => injected().length > previousCount);
        assert.ok(injected().length <= previousCount + 24, "scroll adds only one bounded render batch");
    }
    await waitForCondition(() => document.querySelector(".bcgt-status")?.textContent === "150 / 150");
    assert.equal(new Set(injected().map((card) => card.getAttribute("data-bcgt-card-id"))).size, 148);
    assert.equal(requests, requestsBeforeScroll, "cached pages should not be fetched again");
    input.value = "No matching broadcast";
    dispatch(dom, input, "input");
    await waitForCondition(() => document.querySelector(".bcgt-status")?.textContent.startsWith("0 /"));
    assert.equal(injected().length, 0, "a new query discards obsolete extension-owned cards");
});

test("category tools hydrates newly visible follower badges on scroll without a full apply pass", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            categoryToolsFollowerFetchDelayMs: 0,
            categoryToolsFollowerFetchMaxPerPass: 10,
        },
    });
    const dom = createCategoryToolsDom(chrome);
    t.after(() => closeCategoryToolsFixture(dom, chrome));
    const clock = useFakePerformanceNow(dom);
    const { document } = dom.window;
    const requests = [];

    dom.window.fetch = async (url) => {
        const href = String(url);
        requests.push(href);

        if (href.includes("/v2/categories/")) {
            return {
                ok: true,
                json: async () => ({
                    content: {
                        data: [
                            {
                                liveTitle: "Alpha live",
                                concurrentUserCount: 10,
                                channel: { channelId: "channel-a", channelName: "Alpha" },
                            },
                            {
                                liveTitle: "Beta live",
                                concurrentUserCount: 20,
                                channel: { channelId: "channel-b", channelName: "Beta" },
                            },
                        ],
                        page: { next: null },
                    },
                }),
            };
        }

        const channelId = decodeURIComponent(href.match(/\/v1\/channels\/([^/?#]+)/)?.[1] || "");
        return {
            ok: true,
            json: async () => ({
                content: {
                    followerCount: channelId === "channel-a" ? 100 : 200,
                },
            }),
        };
    };

    await loadCategoryToolsPage(dom);

    await waitForCondition(() => requests.some((href) => href.includes("/v1/channels/channel-a")));
    assert.equal(requests.filter((href) => href.includes("/v2/categories/")).length, 1);
    assert.equal(
        requests.some((href) => href.includes("/v1/channels/channel-b")),
        false
    );

    let cardScans = 0;
    for (const root of [document.getElementById("grid"), ...document.querySelectorAll("#grid article")]) {
        const queryAll = root.querySelectorAll.bind(root);
        root.querySelectorAll = (selector) => {
            const result = queryAll(selector);
            if (result.length && [...result].every((node) => node.tagName === "A")) cardScans++;
            return result;
        };
    }

    clock.advance(1000);
    setElementRect(document.getElementById("card-b"), { left: 24, top: 220, width: 320, height: 180 });
    setElementRect(document.querySelector('#card-b a[href="/live/channel-b"]'), {
        left: 24,
        top: 220,
        width: 320,
        height: 180,
    });
    dom.window.dispatchEvent(new dom.window.Event("scroll"));

    await waitForCondition(() => requests.some((href) => href.includes("/v1/channels/channel-b")));
    assert.equal(cardScans, 0, "scroll hydration uses the remembered rows instead of scanning the card list");
    assert.equal(requests.filter((href) => href.includes("/v2/categories/")).length, 1);
    assert.deepEqual(
        requests
            .filter((href) => href.includes("/v1/channels/"))
            .map((href) => decodeURIComponent(href.match(/\/v1\/channels\/([^/?#]+)/)?.[1] || "")),
        ["channel-a", "channel-b"]
    );
});

test("category follower filtering continues candidates that do not yet have a DOM card", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            categoryToolsFollowerBadgesEnabled: false,
            categoryToolsLiveElapsedEnabled: false,
            categoryToolsFollowerFetchMaxPerPass: 2,
            categoryToolsFollowerFetchDelayMs: 0,
        },
    });
    const dom = createGlobalLivesDom(chrome);
    t.after(() => closeCategoryToolsFixture(dom, chrome));
    const { document } = dom.window;
    const counts = new Map();
    const response = createGlobalLivesApiMock(
        ["native-a", "native-b", "candidate-c"].map((channelId, i) => ({
            channelId,
            liveId: 300 - i,
            title: channelId,
            views: 10,
        }))
    );
    dom.window.fetch = async (url) => {
        const match = String(url).match(/\/channels\/([^/]+)\/followers\/count/);
        if (!match) return { ok: true, json: async () => response(String(url)) };
        assert.equal(counts.has(match[1]), false, "a channel lookup is not duplicated");
        return new Promise((resolve) =>
            counts.set(match[1], (count) =>
                resolve({ ok: true, json: async () => ({ content: { followerCount: count } }) })
            )
        );
    };
    await loadCategoryToolsPage(dom);
    await waitForCondition(() => document.querySelector('[data-filter-min-input="followers"]'));
    const minimum = document.querySelector('[data-filter-min-input="followers"]');
    minimum.value = "1";
    dispatch(dom, minimum, "input");
    await waitForCondition(() => counts.size === 2);
    assert.match(document.querySelector('[data-bcgt-empty="1"]').textContent, /확인하고/);
    counts.get("native-a")(0);
    counts.get("native-b")(0);
    await waitForCondition(() => counts.has("candidate-c"));
    counts.get("candidate-c")(1000);
    await waitForCondition(() => document.querySelector(".bcgt-status")?.textContent === "1 / 3");
    assert.ok(document.querySelector('[data-bcgt-injected="1"][data-bcgt-card-id="candidate-c"]'));
    assert.equal(document.querySelector(".bcgt-status").textContent, "1 / 3");
    assert.equal(counts.size, 3);
});

test("category tools respect the currently observed viewer-order tab labels", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            categoryToolsFollowerBadgesEnabled: false,
            categoryToolsLiveElapsedEnabled: false,
        },
    });
    const dom = createGlobalLivesDom(chrome);
    t.after(() => closeCategoryToolsFixture(dom, chrome));
    const { document } = dom.window;
    const sortRow = document.getElementById("sort-row");
    sortRow.innerHTML = ["시청자순", "시청자역순", "최신순", "추천순"]
        .map((label, i) => `<button role="tab" aria-selected="${i === 0}">${label}</button>`)
        .join("");
    const tabs = [...sortRow.children];
    tabs.forEach((tab, i) => setElementRect(tab, { left: 40 + i * 100, top: 215, width: 90, height: 32 }));
    const response = createGlobalLivesApiMock(
        ["native-a", "native-b", "native-c"].map((channelId, i) => ({
            channelId,
            liveId: 500 - i,
            title: `Native ${i}`,
            views: 10,
        }))
    );
    dom.window.fetch = async (url) => ({ ok: true, json: async () => response(String(url)) });
    await loadCategoryToolsPage(dom);
    await waitForCondition(() => document.querySelector("#betterchzzk-category-tools input"));
    const input = document.querySelector("#betterchzzk-category-tools input");
    input.value = "Native";
    dispatch(dom, input, "input");
    await waitForCondition(() => document.querySelector(".bcgt-status")?.textContent === "3 / 3");
    tabs[0].setAttribute("aria-selected", "false");
    tabs[1].setAttribute("aria-selected", "true");
    tabs[1].click();
    await waitForCondition(() => document.querySelector(".bcgt-status")?.textContent === "2 / 2");
    assert.equal(
        document.querySelector('[data-bcgt-injected="1"]'),
        null,
        "a popularity API card must not be inserted into the reversed native list"
    );
});

test("global lives duration filter uses openDate and keeps the native list path", async () => {
    const chrome = createFakeChrome({ sync: { categoryToolsFollowerBadgesEnabled: false } });
    const dom = createGlobalLivesDom(chrome);
    const now = Date.parse("2026-07-10T12:00:00Z");
    dom.window.Date.now = () => now;

    const { document } = dom.window;
    const grid = document.getElementById("grid");
    const sentinel = document.getElementById("native-sentinel");
    const addNativeCard = ({ cardId, channelId, title, top }) => {
        const card = document.getElementById("live-card-b").cloneNode(true);
        card.id = cardId;
        for (const anchor of card.querySelectorAll("a[href]")) {
            anchor.setAttribute("href", "/live/" + channelId);
        }
        card.querySelector("._live_title").textContent = title;
        grid.insertBefore(card, sentinel);
        setElementRect(card, { left: 40, top, width: 320, height: 240 });
        setElementRect(card.querySelector("a._thumbnail"), { left: 40, top, width: 320, height: 180 });
        setElementRect(card.querySelector("img"), { left: 40, top, width: 320, height: 180 });
        return card;
    };
    const missingDateCard = addNativeCard({
        cardId: "live-card-missing",
        channelId: "native-missing",
        title: "Missing open date",
        top: 560,
    });
    const futureDateCard = addNativeCard({
        cardId: "live-card-future",
        channelId: "native-future",
        title: "Future open date",
        top: 820,
    });

    const livesResponse = createGlobalLivesApiMock([
        {
            liveId: 500005,
            openDate: "2026-07-10T09:00:00Z",
            adult: false,
            channelId: "native-a",
            channelName: "Native Channel A",
            title: "Native A metadata",
            views: 250,
        },
        {
            liveId: 500004,
            openDate: "2026-07-10T11:30:00Z",
            adult: false,
            channelId: "native-b",
            channelName: "Native Channel B",
            title: "Native B metadata",
            views: 50,
        },
        {
            liveId: 500003,
            openDate: "",
            adult: false,
            channelId: "native-missing",
            channelName: "Missing Date Channel",
            title: "Missing date metadata",
            views: 30,
        },
        {
            liveId: 500002,
            openDate: "2026-07-10T13:00:00Z",
            adult: false,
            channelId: "native-future",
            channelName: "Future Date Channel",
            title: "Future date metadata",
            views: 20,
        },
        {
            liveId: 500001,
            openDate: "2026-07-10T08:30:00Z",
            adult: false,
            channelId: "injected-pass",
            channelName: "Duration Match Channel",
            title: "Injected duration match",
            views: 100,
            imageUrl: "https://evil.example/injected.jpg",
            channelImageUrl: "https://evil.example/profile.jpg",
        },
    ]);
    const requests = [];
    dom.window.fetch = async (url) => {
        const href = String(url);
        requests.push(href);
        if (href.includes("/v1/lives")) {
            return { ok: true, json: async () => livesResponse(href) };
        }
        return { ok: true, json: async () => ({ content: {} }) };
    };

    await loadCategoryToolsPage(dom);

    try {
        await waitForCondition(() => document.querySelector('[data-filter-options="duration"] .bcgt-option'));

        assert.equal(document.querySelector('[data-bcgt-time-chip="1"]'), null);
        assert.equal(
            requests.some((href) => href.includes("sortType=LATEST")),
            false
        );

        const toolbar = document.getElementById("betterchzzk-category-tools");
        const filterButton = toolbar.querySelector(".bcgt-filter");
        filterButton.click();

        const menu = document.getElementById("betterchzzk-category-filter-menu");
        const durationGroup = menu.querySelector('[data-filter-group="duration"]');
        assert.equal(durationGroup.hidden, false);
        assert.equal(menu.getAttribute("data-open"), "1");

        const durationRanges = Array.from(
            menu.querySelectorAll('[data-filter-kind="duration"]'),
            (button) => button.getAttribute("data-filter-min") + ":" + button.getAttribute("data-filter-max")
        );
        assert.deepEqual(durationRanges, [
            "0:0",
            "0:3600",
            "3600:7200",
            "7200:14400",
            "14400:21600",
            "21600:43200",
            "43200:86400",
            "86400:0",
        ]);

        const twoToFourHours = menu.querySelector(
            '[data-filter-kind="duration"][data-filter-min="7200"][data-filter-max="14400"]'
        );
        twoToFourHours.click();

        await waitForCondition(
            () =>
                document.getElementById("live-card-a").getAttribute("data-bcgt-hide") !== "1" &&
                document.getElementById("live-card-b").getAttribute("data-bcgt-hide") === "1" &&
                missingDateCard.getAttribute("data-bcgt-hide") === "1" &&
                futureDateCard.getAttribute("data-bcgt-hide") === "1" &&
                document.querySelector('[data-bcgt-injected="1"][data-bcgt-card-id="injected-pass"]'),
            { timeoutMs: 3000 }
        );

        assert.equal(toolbar.querySelector(".bcgt-filter-label").textContent, "필터 1");
        const injected = document.querySelector('[data-bcgt-injected="1"][data-bcgt-card-id="injected-pass"]');
        const injectedChannel = injected.querySelector("a._channel");
        const injectedPreviewHost = injected.querySelector('[data-bcgt-live-preview-host="1"]');
        assert.equal(injected.querySelector("a._title").textContent, "Injected duration match");
        assert.equal(injected.getAttribute("data-bcgt-live-id"), "500001");
        assert.equal(injected.getAttribute("data-bcgt-channel-id"), "injected-pass");
        assert.ok(injectedPreviewHost);
        assert.equal(injectedPreviewHost.getAttribute("href"), "/live/injected-pass");
        assert.equal(injectedChannel.querySelector("._text").textContent, "Duration Match Channel");
        assert.equal(injectedChannel.getAttribute("href"), "/live/injected-pass");
        assert.equal(injectedChannel.getAttribute("aria-label"), "Duration Match Channel 채널로 이동");
        assert.equal(injected.querySelector('[data-bcgt-follower-badge="1"]'), null);
        const injectedThumbnail = injected.querySelector("a._thumbnail img");
        const injectedThumbnailSource = injected.querySelector("a._thumbnail source");
        for (const attr of [
            "src",
            "srcset",
            "data-src",
            "data-original",
            "data-lazy-src",
            "data-srcset",
            "data-lazy-srcset",
        ]) {
            assert.equal(injectedThumbnail.hasAttribute(attr), false);
            assert.equal(injectedThumbnailSource.hasAttribute(attr), false);
        }
        const injectedProfile = injected.querySelector("img._profile");
        assert.match(injectedProfile.getAttribute("src"), /^data:image\/svg\+xml,/);
        assert.equal(injected.innerHTML.includes("evil.example"), false);

        const durationMin = menu.querySelector('[data-filter-min-input="duration"]');
        const durationMax = menu.querySelector('[data-filter-max-input="duration"]');
        durationMin.value = "0.25";
        durationMin.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        durationMax.value = "1";
        durationMax.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

        await waitForCondition(
            () =>
                document.getElementById("live-card-a").getAttribute("data-bcgt-hide") === "1" &&
                document.getElementById("live-card-b").getAttribute("data-bcgt-hide") !== "1" &&
                missingDateCard.getAttribute("data-bcgt-hide") === "1" &&
                futureDateCard.getAttribute("data-bcgt-hide") === "1" &&
                !injected.isConnected,
            { timeoutMs: 3000 }
        );
        assert.equal(toolbar.querySelector(".bcgt-filter-label").textContent, "필터 1");

        menu.querySelector("[data-filter-reset]").click();
        await waitForCondition(
            () =>
                document.querySelector('[data-bcgt-injected="1"]') === null &&
                [
                    document.getElementById("live-card-a"),
                    document.getElementById("live-card-b"),
                    missingDateCard,
                    futureDateCard,
                ].every((card) => card.getAttribute("data-bcgt-hide") !== "1"),
            { timeoutMs: 3000 }
        );

        assert.equal(toolbar.querySelector(".bcgt-filter-label").textContent, "필터");
        assert.equal(toolbar.getAttribute("data-has-filter"), "0");
        assert.equal(document.querySelector('[data-bcgt-time-chip="1"]'), null);
        assert.equal(
            requests.some((href) => href.includes("sortType=LATEST")),
            false
        );
    } finally {
        await closeCategoryToolsFixture(dom, chrome);
    }
});

test("video search stores the comment device id in extension storage only", async () => {
    const chrome = createFakeChrome({ sync: { videoSearchCommentDelayMs: 0 } });
    const dom = createVideoSearchDom(chrome);
    const requests = [];

    dom.window.fetch = async (url, init = {}) => {
        requests.push({ url: String(url), init });
        if (String(url).includes("/videos?")) {
            return {
                ok: true,
                json: async () => ({
                    content: {
                        data: [{ videoNo: "200", videoTitle: "unmatched title" }],
                        last: true,
                    },
                }),
            };
        }
        return {
            ok: true,
            json: async () => ({
                content: {
                    comments: {
                        data: [{ comment: { content: "needle comment" } }],
                    },
                },
            }),
        };
    };

    await loadVideoSearchPage(dom);
    await waitForCondition(() => getVideoSearchInput(dom));

    searchVideoSearchInput(dom, "needle");
    await waitForCondition(() => requests.some((request) => request.init?.headers?.deviceId));

    const commentRequest = requests.find((request) => request.init?.headers?.deviceId);
    assert.ok(commentRequest.init.headers.deviceId);
    assert.equal(chrome.testState.local.betterchzzkCommentDeviceId, commentRequest.init.headers.deviceId);
    assert.equal(dom.window.localStorage.getItem("betterchzzk-comment-device-id"), null);
});

test("video search skips generic comment and progress fallbacks", async () => {
    const chrome = createFakeChrome({ sync: { videoSearchCommentDelayMs: 0 } });
    const dom = createVideoSearchDom(chrome);
    const { document } = dom.window;
    const requests = [];

    document
        .querySelector('a[href="/video/100"]')
        .insertAdjacentHTML("afterbegin", '<img src="https://example.com/template-thumb.jpg" alt="">');

    dom.window.fetch = async (url, init = {}) => {
        requests.push({ url: String(url), init });
        if (String(url).includes("/videos?")) {
            return {
                ok: true,
                json: async () => ({
                    content: {
                        data: [
                            {
                                videoNo: "100",
                                videoTitle: "Existing 100",
                                duration: 100,
                                thumbnailImageUrl: "https://example.com/index-thumb.jpg",
                                watchTimeline: { lastPlaybackSeconds: 50 },
                            },
                        ],
                        last: true,
                    },
                }),
            };
        }
        return {
            ok: true,
            json: async () => ({
                content: {
                    comments: {
                        data: [{ comment: { content: "alpha" } }, { comment: { content: "beta" } }],
                    },
                },
            }),
        };
    };

    await loadVideoSearchPage(dom);
    await waitForCondition(() => getVideoSearchInput(dom));

    searchVideoSearchInput(dom, "alphabeta");
    await waitForCondition(() => requests.some((request) => request.init?.headers?.deviceId));
    await waitForCondition(() => document.querySelector('[data-bcvs-injected="1"]'));

    const card = document.querySelector('[data-bcvs-injected="1"]');
    assert.ok(card);
    assert.equal(card.querySelector('[data-bcvs-comment-icon="1"]'), null);
    assert.equal(card.querySelector('[data-bcvs-watch-progress="1"]'), null);
});

test("video search retries after an index fetch failure instead of caching partial results as complete", async () => {
    const chrome = createFakeChrome({
        sync: {
            videoSearchCommentEnabled: false,
            videoSearchMaxPages: 2,
        },
    });
    const dom = createVideoSearchDom(chrome);
    const pageCalls = [];
    let failSecondPage = true;

    const makeVideos = (count, offset = 0) =>
        Array.from({ length: count }, (_, index) => ({
            videoNo: String(300 + offset + index),
            videoTitle: `needle indexed ${offset + index}`,
        }));

    dom.window.fetch = async (url) => {
        const parsed = new URL(String(url));
        const page = parsed.searchParams.get("page") || "0";
        pageCalls.push(page);

        if (page === "1" && failSecondPage) {
            failSecondPage = false;
            throw new Error("temporary index failure");
        }

        return {
            ok: true,
            json: async () => ({
                content: {
                    data: page === "0" ? makeVideos(30) : makeVideos(1, 30),
                    last: page === "1",
                },
            }),
        };
    };

    await loadVideoSearchPage(dom);
    await waitForCondition(() => getVideoSearchInput(dom));

    searchVideoSearchInput(dom, "needle");
    await waitForCondition(() => pageCalls.filter((page) => page === "1").length === 1);
    await waitForAsyncCallbacks();

    searchVideoSearchInput(dom, "needle");
    await waitForCondition(() => pageCalls.filter((page) => page === "1").length === 2);
});

test("following refresh clicks the native following sidebar refresh button", async () => {
    const chrome = createFakeChrome({ sync: { followingRefreshSeconds: 10 } });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div id="app">',
            "<nav>",
            '<section id="following">',
            "<header>",
            "<strong>\uD314\uB85C\uC789 \uCC44\uB110</strong>",
            '<button id="followingRefresh" type="button" aria-label="\uC0C8\uB85C\uACE0\uCE68"></button>',
            '<button type="button" aria-label="\uC811\uAE30"></button>',
            "</header>",
            '<a href="/following?tab=LIVE">\uC804\uCCB4\uBCF4\uAE30</a>',
            "</section>",
            '<section id="categories">',
            "<header>",
            "<strong>\uC778\uAE30 \uCE74\uD14C\uACE0\uB9AC</strong>",
            '<button id="categoryRefresh" type="button" aria-label="\uC0C8\uB85C\uACE0\uCE68"></button>',
            "</header>",
            "</section>",
            "</nav>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const { document } = dom.window;
    const clicks = { following: 0, categories: 0 };
    const originalQuerySelectorAll = document.querySelectorAll.bind(document);
    let refreshButtonQueries = 0;

    document.getElementById("followingRefresh").addEventListener("click", () => {
        clicks.following += 1;
    });
    document.getElementById("categoryRefresh").addEventListener("click", () => {
        clicks.categories += 1;
    });
    document.querySelectorAll = (selector) => {
        if (selector === 'button[aria-label], [role="button"][aria-label]') refreshButtonQueries += 1;
        return originalQuerySelectorAll(selector);
    };

    evalFollowingRefreshScripts(dom);
    await waitForAsyncCallbacks();

    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].ms, 10000);

    intervals[0].fn();

    assert.equal(clicks.following, 1);
    assert.equal(clicks.categories, 0);
    assert.equal(refreshButtonQueries, 1);

    intervals[0].fn();

    assert.equal(clicks.following, 2);
    assert.equal(clicks.categories, 0);
    assert.equal(refreshButtonQueries, 1, "캐시된 팔로잉 새로고침 버튼은 다시 탐색하지 않는다");
});

test("following refresh runs immediately when a hidden tab becomes visible", async () => {
    const chrome = createFakeChrome({ sync: { followingRefreshSeconds: 10 } });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            "<nav>",
            '<section id="following">',
            "<strong>팔로잉 채널</strong>",
            '<button id="followingRefresh" type="button" aria-label="새로고침"></button>',
            '<a href="/following?tab=LIVE">전체보기</a>',
            "</section>",
            "</nav>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const { document } = dom.window;
    let visibilityState = "hidden";
    let refreshClicks = 0;

    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibilityState,
    });
    document.getElementById("followingRefresh").addEventListener("click", () => {
        refreshClicks += 1;
    });

    evalFollowingRefreshScripts(dom);
    await waitForAsyncCallbacks();

    intervals[0].fn();
    assert.equal(refreshClicks, 0, "숨겨진 동안에는 주기 새로고침을 건너뛴다");

    visibilityState = "visible";
    document.dispatchEvent(new dom.window.Event("visibilitychange"));

    assert.equal(refreshClicks, 1, "탭으로 복귀하면 즉시 새로고침한다");
    assert.equal(intervals[0].cleared, true);
    assert.equal(intervals.length, 2);
    assert.equal(intervals[1].ms, 10000, "복귀 시점부터 새 주기를 시작한다");

    chrome.testState.storageChangeListeners[0](
        {
            followingRefreshEnabled: {
                oldValue: true,
                newValue: false,
            },
        },
        "sync"
    );
    visibilityState = "hidden";
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    visibilityState = "visible";
    document.dispatchEvent(new dom.window.Event("visibilitychange"));

    assert.equal(intervals[1].cleared, true);
    assert.equal(refreshClicks, 1, "기능을 끄면 복귀 새로고침 리스너도 정리한다");
});

test("following refresh ignores the VOD comment refresh control before the native button", async () => {
    const chrome = createFakeChrome({ sync: { followingRefreshSeconds: 10 } });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div id="app">',
            '<aside id="betterchzzk-vod-comment-aside">',
            '<div id="betterchzzk-vod-comment-panel">',
            '<button id="commentRefresh" type="button" aria-label="댓글 새로고침"></button>',
            "</div>",
            "</aside>",
            "<nav>",
            '<section id="following">',
            "<strong>팔로잉 채널</strong>",
            '<button id="followingRefresh" type="button" aria-label="새로고침"></button>',
            '<a href="/following?tab=LIVE">전체보기</a>',
            "</section>",
            "</nav>",
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/video/123",
        chrome
    );
    const intervals = captureIntervals(dom);
    const { document } = dom.window;
    const clicks = { comments: 0, following: 0 };

    document.getElementById("commentRefresh").addEventListener("click", () => {
        clicks.comments += 1;
    });
    document.getElementById("followingRefresh").addEventListener("click", () => {
        clicks.following += 1;
    });

    evalFollowingRefreshScripts(dom);
    await waitForAsyncCallbacks();

    intervals[0].fn();

    assert.equal(clicks.comments, 0);
    assert.equal(clicks.following, 1);
});

test("following refresh restarts the timer when the custom interval changes", async () => {
    const chrome = createFakeChrome({ sync: { followingRefreshSeconds: 10 } });
    const dom = createPageDom("<!doctype html><body><main></main></body>", "https://chzzk.naver.com/", chrome);
    const intervals = captureIntervals(dom);

    evalFollowingRefreshScripts(dom);
    await waitForAsyncCallbacks();

    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].ms, 10000);

    chrome.testState.storageChangeListeners[0](
        {
            followingRefreshSeconds: {
                oldValue: 10,
                newValue: 45,
            },
        },
        "sync"
    );

    assert.equal(intervals[0].cleared, true);
    assert.equal(intervals.length, 2);
    assert.equal(intervals[1].ms, 45000);
});

test("title tooltip shows full text when a card title is truncated", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><article class="card">',
            '<a class="card_title" href="/live/abc">아주 길어서 잘리는 방송 제목 전체 내용</a>',
            "</article></main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/lives",
        chrome
    );
    const { document } = dom.window;
    const title = document.querySelector(".card_title");

    Object.defineProperty(title, "scrollWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(title, "clientWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(title, "scrollHeight", { configurable: true, get: () => 20 });
    Object.defineProperty(title, "clientHeight", { configurable: true, get: () => 20 });
    title.getBoundingClientRect = () => ({
        left: 40,
        top: 120,
        right: 240,
        bottom: 140,
        width: 200,
        height: 20,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForTitleTooltipDelay();

    const tip = document.querySelector(".bctt-tooltip[data-show='1']");
    assert.ok(tip, "툴팁이 표시되어야 한다");
    assert.equal(tip.textContent, "아주 길어서 잘리는 방송 제목 전체 내용");
    assert.equal(title.getAttribute("data-bctt-active"), "1");
});

test("title tooltip excludes hidden navigation text from the full title", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><article class="card">',
            '<a class="card_title" href="/live/abc">',
            "JDG vs BLG | LPL Split 2 Playoff BO5 패자조 노코인 징비록 지면 끝",
            '<span class="blind">라이브 엔드로 이동</span>',
            "</a>",
            "</article></main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/lives",
        chrome
    );
    const { document } = dom.window;
    const title = document.querySelector(".card_title");

    Object.defineProperty(title, "scrollWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(title, "clientWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(title, "scrollHeight", { configurable: true, get: () => 20 });
    Object.defineProperty(title, "clientHeight", { configurable: true, get: () => 20 });
    title.getBoundingClientRect = () => ({
        left: 40,
        top: 120,
        right: 240,
        bottom: 140,
        width: 200,
        height: 20,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForTitleTooltipDelay();

    const tip = document.querySelector(".bctt-tooltip[data-show='1']");
    assert.ok(tip);
    assert.equal(tip.textContent, "JDG vs BLG | LPL Split 2 Playoff BO5 패자조 노코인 징비록 지면 끝");
    assert.equal(tip.textContent.includes("라이브 엔드로 이동"), false);
});

test("title tooltip stays disabled when the option is off", async () => {
    const chrome = createFakeChrome({
        sync: {
            titleTooltipEnabled: false,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><article class="card">',
            '<a class="card_title" href="/live/abc">잘려야 하는 긴 방송 제목</a>',
            "</article></main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/lives",
        chrome
    );
    const { document } = dom.window;
    const title = document.querySelector(".card_title");

    Object.defineProperty(title, "scrollWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(title, "clientWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(title, "scrollHeight", { configurable: true, get: () => 20 });
    Object.defineProperty(title, "clientHeight", { configurable: true, get: () => 20 });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForTitleTooltipDelay();

    assert.equal(document.querySelector(".bctt-tooltip[data-show='1']"), null);
    assert.equal(title.hasAttribute("data-bctt-active"), false);
});

test("title tooltip reacts to option changes without leaving stale UI", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><article class="card">',
            '<a class="card_title" href="/live/abc">옵션 변경 중에도 잘리는 방송 제목 전체 내용</a>',
            "</article></main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/lives",
        chrome
    );
    const { document } = dom.window;
    const title = document.querySelector(".card_title");

    Object.defineProperty(title, "scrollWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(title, "clientWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(title, "scrollHeight", { configurable: true, get: () => 20 });
    Object.defineProperty(title, "clientHeight", { configurable: true, get: () => 20 });
    title.getBoundingClientRect = () => ({
        left: 40,
        top: 120,
        right: 240,
        bottom: 140,
        width: 200,
        height: 20,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForTitleTooltipDelay();
    assert.ok(document.querySelector(".bctt-tooltip[data-show='1']"));
    assert.equal(title.getAttribute("data-bctt-active"), "1");

    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ titleTooltipEnabled: { newValue: false } }, "sync");
    }
    await waitForAsyncCallbacks();
    assert.equal(document.querySelector(".bctt-tooltip"), null);
    assert.equal(document.getElementById("betterchzzk-title-tooltip-style"), null);
    assert.equal(title.hasAttribute("data-bctt-active"), false);

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForTitleTooltipDelay();
    assert.equal(document.querySelector(".bctt-tooltip[data-show='1']"), null);

    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ titleTooltipEnabled: { newValue: true } }, "sync");
    }
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForTitleTooltipDelay();
    const tip = document.querySelector(".bctt-tooltip[data-show='1']");
    assert.ok(tip);
    assert.equal(tip.textContent, "옵션 변경 중에도 잘리는 방송 제목 전체 내용");
    assert.equal(title.getAttribute("data-bctt-active"), "1");
});

test("volume wheel raises and lowers media volume over the volume control", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
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
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const vol = document.getElementById("vol");
    const slider = document.getElementById("slider");

    video.volume = 0.5;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    vol.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    let nativeWheelCount = 0;
    dom.window.addEventListener(
        "wheel",
        () => {
            nativeWheelCount += 1;
            video.volume = 1;
        },
        { capture: true }
    );

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    vol.dispatchEvent(up);
    assert.ok(Math.abs(video.volume - 0.55) < 1e-6, "휠 업이면 +5%");
    assert.equal(up.defaultPrevented, true);
    assert.equal(nativeWheelCount, 0);
    assert.equal(slider.value, "50");

    const down = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(down, "deltaY", { value: 100 });
    vol.dispatchEvent(down);
    assert.ok(Math.abs(video.volume - 0.5) < 1e-6, "휠 다운이면 -5%");
    assert.equal(down.defaultPrevented, true);
    assert.equal(slider.value, "50");
});

test("volume wheel ignores following preview videos when choosing media volume", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div class="bcfp-player" data-bcfp-player-mount="preview">',
            '<video id="previewVideo"></video>',
            "</div>",
            '<div class="pzp-pc" id="playerRoot">',
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol">',
            '<button class="pzp-pc__volume-button" type="button"></button>',
            "</div>",
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const previewVideo = document.getElementById("previewVideo");
    const vol = document.getElementById("vol");

    video.volume = 0.5;
    previewVideo.volume = 0.1;
    previewVideo.getBoundingClientRect = () => ({
        width: 800,
        height: 450,
        left: 0,
        top: 0,
        right: 800,
        bottom: 450,
    });
    video.getBoundingClientRect = () => ({ width: 320, height: 180, left: 0, top: 0, right: 320, bottom: 180 });
    vol.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    vol.dispatchEvent(up);

    assert.ok(Math.abs(video.volume - 0.55) < 1e-6);
    assert.ok(Math.abs(previewVideo.volume - 0.1) < 1e-6);
    assert.equal(up.defaultPrevented, true);
});

test("volume wheel removes the page wheel listener after pushState leaves playback routes", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/live/test-channel", chrome);
    const nativeAddEventListener = dom.window.addEventListener.bind(dom.window);
    const nativeRemoveEventListener = dom.window.removeEventListener.bind(dom.window);
    const activeWheelListeners = new Set();

    dom.window.addEventListener = (type, listener, options) => {
        if (type === "wheel") activeWheelListeners.add(listener);
        return nativeAddEventListener(type, listener, options);
    };
    dom.window.removeEventListener = (type, listener, options) => {
        if (type === "wheel") activeWheelListeners.delete(listener);
        return nativeRemoveEventListener(type, listener, options);
    };

    evalRepoScript(dom, "features", "routeBridgePage.js");
    evalVolumeWheelScripts(dom);
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    assert.equal(activeWheelListeners.size, 1);

    dom.window.history.pushState({}, "", "/following");
    await waitForCondition(() => activeWheelListeners.size === 0);

    assert.equal(dom.window.location.pathname, "/following");
});

test("volume wheel respects unit-range native sliders", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol">',
            '<button class="pzp-pc__volume-button" type="button"></button>',
            '<input id="slider" type="range" min="0" max="1" step="0.01" value="0.5">',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const vol = document.getElementById("vol");
    const slider = document.getElementById("slider");

    video.volume = 0.5;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    vol.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    vol.dispatchEvent(up);

    assert.ok(Math.abs(video.volume - 0.55) < 1e-6);
    assert.equal(slider.value, "0.5");
    assert.notEqual(slider.value, "1");

    const down = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(down, "deltaY", { value: 100 });
    vol.dispatchEvent(down);

    assert.ok(Math.abs(video.volume - 0.5) < 1e-6);
    assert.equal(slider.value, "0.5");
});

test("volume wheel ignores non-volume areas and disabled option", async () => {
    const chrome = createFakeChrome({
        sync: {
            volumeWheelEnabled: false,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol"><button class="pzp-pc__volume-button" type="button"></button></div>',
            '<div id="outside">outside</div>',
            '<input id="outsideSlider" type="range" min="0" max="100" value="70">',
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const vol = document.getElementById("vol");
    const outside = document.getElementById("outside");
    const outsideSlider = document.getElementById("outsideSlider");

    video.volume = 0.5;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    vol.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });
    outside.getBoundingClientRect = () => ({ width: 100, height: 20, left: 80, top: 320, right: 180, bottom: 340 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const disabledWheel = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(disabledWheel, "deltaY", { value: -100 });
    vol.dispatchEvent(disabledWheel);
    assert.equal(video.volume, 0.5);
    assert.equal(disabledWheel.defaultPrevented, false);

    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ volumeWheelEnabled: { newValue: true } }, "sync");
    }
    await waitForAsyncCallbacks();

    const outsideWheel = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(outsideWheel, "deltaY", { value: -100 });
    outside.dispatchEvent(outsideWheel);
    assert.equal(video.volume, 0.5);
    assert.equal(outsideWheel.defaultPrevented, false);

    const downToMute = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(downToMute, "deltaY", { value: 100 });
    video.volume = 0.03;
    video.muted = false;
    vol.dispatchEvent(downToMute);
    assert.equal(video.volume, 0);
    assert.equal(video.muted, true);
    assert.equal(outsideSlider.value, "70");

    const upFromMute = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(upFromMute, "deltaY", { value: -100 });
    vol.dispatchEvent(upFromMute);
    assert.ok(Math.abs(video.volume - 0.05) < 1e-6);
    assert.equal(video.muted, false);
    assert.equal(outsideSlider.value, "70");
});

test("volume wheel keeps muted playback unchanged outside actual volume controls", async () => {
    const dom = createPageDom(
        '<body><div class="pzp pzp-pc pzp-pc--muted"><video></video><div id="canvas"></div><button id="play" type="button">재생</button><button id="sound" type="button" aria-label="음소거 해제"></button></div></body>',
        "https://chzzk.naver.com/live/test-channel",
        createFakeChrome()
    );
    const { document } = dom.window;
    const video = document.querySelector("video");
    for (const element of document.querySelectorAll("body *")) makeVisibleVideo(element);
    video.volume = 0.6;
    video.muted = true;
    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    for (const target of [video, document.getElementById("canvas"), document.getElementById("play")]) {
        for (const deltaY of [-100, 100]) {
            const event = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY });
            target.dispatchEvent(event);
            assert.equal(event.defaultPrevented, false, "ordinary scrolling stays available while muted");
            assert.equal(video.muted, true);
            assert.equal(video.volume, 0.6);
        }
    }
    const volumeWheel = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
    document.getElementById("sound").dispatchEvent(volumeWheel);
    assert.equal(volumeWheel.defaultPrevented, true);
    assert.equal(video.muted, false);
    assert.ok(Math.abs(video.volume - 0.05) < 1e-6);
});

test("audio compressor button yields to an existing external cheese-knife compressor", async () => {
    const { dom, document } = createAudioCompressorFixture({ withExternalCompressor: true });

    await loadAudioCompressorFeature(dom);

    assert.equal(document.getElementById("betterchzzk-audio-compressor"), null);
});

test("audio compressor has its own control after the native volume control", async () => {
    const { dom, document, volumeControl, volumeButton } = createAudioCompressorFixture();

    await loadAudioCompressorFeature(dom);

    await waitForCondition(() => document.getElementById("betterchzzk-audio-compressor"));
    const button = document.getElementById("betterchzzk-audio-compressor");

    const control = document.getElementById("betterchzzk-audio-compressor-control");
    assert.equal(control.previousElementSibling, volumeControl);
    assert.equal(button.parentElement, control);
    assert.equal(control.firstElementChild, button);
    assert.equal(volumeButton.parentElement, volumeControl);
    assert.ok(button.nextElementSibling.contains(document.getElementById("betterchzzk-audio-compressor-volume")));
    assert.equal(button.classList.contains(["knife", "audio", "compressor"].join("-")), false);
});

test("audio compressor button tooltip reports graph setup failures", async () => {
    const { dom, document } = createAudioCompressorFixture();

    dom.window.AudioContext = class {
        constructor() {
            this.state = "running";
            this.currentTime = 0;
        }

        createMediaElementSource() {
            throw new Error("media source already connected");
        }

        close() {}
    };

    await loadAudioCompressorFeature(dom);
    await waitForCondition(() => document.getElementById("betterchzzk-audio-compressor"));

    const button = document.getElementById("betterchzzk-audio-compressor");
    button.click();

    assert.equal(button.dataset.betterChzzkReady, "0");
    assert.equal(button.getAttribute("tooltip"), "오디오 컴프레서(사용할 수 없음)");
    assert.equal(button.getAttribute("aria-label"), "오디오 컴프레서(사용할 수 없음)");
});

test("quality selection saves, reloads and follows the auto quality toggle", async (t) => {
    const chrome = createFakeChrome();
    const dom = createDom("options.html", "options.html", chrome);
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();
    const { document } = dom.window;
    const select = queryOption(document, "autoQualityPreferred");
    assert.equal(select.value, "1080p");
    assert.deepEqual(
        Array.from(select.options, (option) => option.value),
        ["1080p", "720p", "480p"]
    );
    select.value = "720p";
    dispatch(dom, select, "change");
    document.getElementById("save").click();
    await waitForAsyncCallbacks();
    assert.equal(chrome.testState.sync.autoQualityPreferred, "720p");
    const toggle = queryOption(document, "autoQualityEnabled");
    toggle.checked = false;
    dispatch(dom, toggle, "change");
    assert.equal(select.disabled, true);
    toggle.checked = true;
    dispatch(dom, toggle, "change");
    assert.equal(select.disabled, false);
    assert.equal(select.value, "720p");
    const reopened = createDom("options.html", "options.html", chrome);
    t.after(() => reopened.window.close());
    evalRepoScript(reopened, "shared", "settings.js");
    evalRepoScript(reopened, "options.js");
    await waitForAsyncCallbacks();
    assert.equal(queryOption(reopened.window.document, "autoQualityPreferred").value, "720p");
});

test("saved quality changes cross the page bridge and switch existing tracks", async (t) => {
    const chrome = createFakeChrome({ sync: { autoQualityPreferred: "720p", adblockPopupEnabled: false } });
    const dom = createPageDom(
        '<body><video id="video"></video></body>',
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    t.after(() => {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ autoQualityEnabled: { newValue: false } }, "sync");
        }
        disableAutoQualityPage(dom);
        dom.window.close();
    });
    const video = dom.window.document.getElementById("video");
    const tracks = [480, 720, 1080].map((height) => ({
        id: String(height),
        label: `${height}p`,
        height,
        kind: "main",
    }));
    const trackList = createVideoTrackList(tracks, 2);
    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "videoTracks", { configurable: true, get: () => trackList });
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "autoQualityPage.js");
    evalRepoScript(dom, "features", "autoQuality.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    await waitForCondition(() => trackList.selectedIndex === 1);
    assert.equal(trackList.selectedIndex, 1);
    for (const [quality, index] of [
        ["480p", 0],
        ["1080p", 2],
    ]) {
        for (const listener of chrome.testState.storageChangeListeners)
            listener({ autoQualityPreferred: { newValue: quality } }, "sync");
        await waitForCondition(() => trackList.selectedIndex === index);
        assert.equal(trackList.selectedIndex, index);
        const state = JSON.parse(
            dom.window.document.documentElement.getAttribute("data-betterchzzk-auto-quality-state")
        );
        assert.equal(state.quality, quality);
    }
});

test("auto quality falls back to the highest selectable lower track", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
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

test("auto quality retries by directly discovering videoTracks after they appear", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
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
    makeVisibleVideo(video);
    evalRepoScript(dom, "features", "autoQualityPage.js");

    const pending = requestAutoQualityApply(dom, "1080p");
    assert.equal(pending.status, "pending");

    Object.defineProperty(video, "videoTracks", {
        configurable: true,
        get: () => trackList,
    });

    const result = requestAutoQualityApply(dom, "1080p");
    assert.equal(result.status, "selected");
    assert.equal(result.selected.height, 720);
    assert.equal(trackList.selectedIndex, 2);
});

test("auto quality reopens VOD page apply when the stable video is replaced", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const tracks = [
        { id: "auto", label: "auto 1080p", height: 1080 },
        { id: "1080", label: "1080p", height: 1080, kind: "main", selected: true },
    ];

    const trackCallbacks = new Set();
    const trackList = createVideoTrackList(tracks, 1);
    trackList.addEventListener = (_type, callback) => trackCallbacks.add(callback);

    video.currentTime = 2;
    makeVisibleVideo(video);
    Object.defineProperty(video, "duration", {
        configurable: true,
        get: () => 120,
    });
    Object.defineProperty(video, "videoTracks", {
        configurable: true,
        get: () => trackList,
    });

    evalRepoScript(dom, "features", "autoQualityPage.js");

    const result = requestAutoQualityApply(dom, "1080p");
    assert.equal(result.status, "already");

    const scheduledTimers = [];
    dom.window.setTimeout = (callback, delay) => {
        scheduledTimers.push({ callback, delay });
        return scheduledTimers.length;
    };
    dom.window.clearTimeout = () => {};

    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:auto-quality:state"));
    assert.equal(scheduledTimers.length, 0);
    assert.ok(trackCallbacks.size > 0, "quality discovery subscribes to the native track list");
    for (const callback of trackCallbacks) callback(new dom.window.Event("change"));
    assert.equal(scheduledTimers.length, 0, "a late track notification does not restart a stable VOD");

    const replacement = document.createElement("video");
    replacement.currentTime = 2;
    makeVisibleVideo(replacement);
    Object.defineProperty(replacement, "duration", {
        configurable: true,
        get: () => 120,
    });
    Object.defineProperty(replacement, "videoTracks", {
        configurable: true,
        get: () =>
            createVideoTrackList(
                [
                    { id: "auto", label: "auto 1080p", height: 1080 },
                    { id: "1080", label: "1080p", height: 1080, kind: "main" },
                ],
                0
            ),
    });
    document.querySelector("main").replaceChildren(replacement);

    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:auto-quality:state"));
    assert.equal(scheduledTimers.length, 1);
    assert.equal(scheduledTimers[0].delay, 0);
});

test("auto quality ignores the following preview video when choosing the main player", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div data-bcfp-tooltip="1"><video id="preview" class="bcfp-player" data-bcfp-player-mount="preview"></video></div>',
            '<pzp-player><video id="main"></video></pzp-player>',
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const preview = document.getElementById("preview");
    const main = document.getElementById("main");
    const tracks = [
        { id: "auto", label: "auto 1080p", height: 1080 },
        { id: "480", label: "480p", height: 480, kind: "main" },
        { id: "720", label: "720p", height: 720, kind: "main" },
    ];
    const trackList = createVideoTrackList(tracks, 1);

    main.currentTime = 2;
    preview.currentTime = 5;
    makeVisibleVideo(main);
    preview.getBoundingClientRect = () => ({
        width: 800,
        height: 450,
        left: 0,
        top: 0,
        right: 800,
        bottom: 450,
    });
    Object.defineProperty(main, "videoTracks", {
        configurable: true,
        get: () => trackList,
    });

    evalRepoScript(dom, "features", "autoQualityPage.js");

    const result = requestAutoQualityApply(dom, "1080p");
    assert.equal(result.status, "selected");
    assert.equal(trackList.selectedIndex, 2);
    assert.equal(preview.currentTime, 5);
    disableAutoQualityPage(dom);
    await waitForAsyncCallbacks();
    dom.window.close();
});

test("auto quality playback restore stops at an SPA route boundary", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
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
    const scheduledTimers = [];
    const clearedTimers = new Set();

    dom.window.setTimeout = (callback, delay) => {
        const id = scheduledTimers.length + 1;
        scheduledTimers.push({ callback, delay, id });
        return id;
    };
    dom.window.clearTimeout = (id) => clearedTimers.add(id);
    video.currentTime = 30;
    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "videoTracks", {
        configurable: true,
        get: () => trackList,
    });

    evalRepoScript(dom, "features", "autoQualityPage.js");
    assert.equal(requestAutoQualityApply(dom, "1080p").status, "selected");

    const restoreTimer = scheduledTimers.find(({ delay }) => delay === 250);
    assert.ok(restoreTimer);

    dom.window.history.pushState({}, "", "/video/67890");
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));

    const replacement = document.createElement("video");
    let playCalls = 0;
    replacement.currentTime = 0;
    replacement.play = () => {
        playCalls += 1;
        return Promise.resolve();
    };
    makeVisibleVideo(replacement);
    Object.defineProperty(replacement, "paused", { configurable: true, get: () => true });
    document.querySelector("main").replaceChildren(replacement);

    assert.equal(clearedTimers.has(restoreTimer.id), true);
    restoreTimer.callback();
    assert.equal(replacement.currentTime, 0);
    assert.equal(playCalls, 0);
    disableAutoQualityPage(dom);
    await waitForAsyncCallbacks();
    dom.window.close();
});

test("auto quality page hook leaves videoTracks descriptors untouched outside playback routes", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/category/game/lives", chrome);
    const target = {};
    const getter = () => createVideoTrackList([{ id: "720", label: "720p", height: 720 }]);

    evalRepoScript(dom, "features", "autoQualityPage.js");

    dom.window.Object.defineProperty(target, "videoTracks", {
        configurable: true,
        get: getter,
    });

    assert.equal(getter.__betterChzzkVideoTracksWrapped, undefined);
    assert.equal(Object.getOwnPropertyDescriptor(target, "videoTracks").get, getter);
});

test("auto quality publishes state without writing a page localStorage cache", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        "<!doctype html><body><video></video></body>",
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "autoQuality.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    assert.ok(dom.window.document.documentElement.getAttribute("data-betterchzzk-auto-quality-state"));
    assert.equal(dom.window.localStorage.getItem("betterchzzk:auto-quality:state-cache"), null);
});

test("live watch history sends cumulative session snapshots between flushes", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let mediaTime = 0;

    t.after(async () => {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    assert.equal(typeof tick, "function");
    assert.equal(typeof flush, "function");

    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTime += 10;
        tick();
    }
    flush();

    await waitForCondition(
        () =>
            chrome.testState.runtimeMessages.filter((message) => message?.operation?.kind === "upsertSessionSnapshot")
                .length === 1
    );

    clock.advance(10000);
    mediaTime += 10;
    tick();
    flush();

    await waitForCondition(
        () =>
            chrome.testState.runtimeMessages.filter((message) => message?.operation?.kind === "upsertSessionSnapshot")
                .length === 2
    );
    assert.equal(Object.keys(chrome.testState.local.betterChzzkLiveWatchHistory.entries).length, 1);
});

test("live watch history follows an in-flight open snapshot with the closed state", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    let releaseFirstResponse = null;
    chrome.runtime.sendMessage = (message, callback) => {
        const isFirstSnapshot = message?.operation?.kind === "upsertSessionSnapshot" && releaseFirstResponse === null;
        if (!isFirstSnapshot) {
            originalSendMessage(message, callback);
            return;
        }
        originalSendMessage(message, (response) => {
            releaseFirstResponse = () => callback?.(response);
        });
    };
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let mediaTime = 0;

    t.after(() => dom.window.close());

    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(() => typeof releaseFirstResponse === "function");

    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
    }
    await waitForAsyncCallbacks();
    releaseFirstResponse();

    await waitForCondition(
        () =>
            chrome.testState.runtimeMessages.filter((message) => message?.operation?.kind === "upsertSessionSnapshot")
                .length === 2
    );
    const snapshots = chrome.testState.runtimeMessages.filter(
        (message) => message?.operation?.kind === "upsertSessionSnapshot"
    );
    assert.equal(snapshots[0].operation.session.closed, false);
    assert.equal(snapshots[1].operation.session.closed, true);
    await waitForCondition(
        () => Object.values(chrome.testState.local.betterChzzkLiveWatchHistory.entries)[0].sessionDetails[0].closed
    );
});

test("live watch history starts the next SPA live session while the previous close is in flight", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    let snapshotCallCount = 0;
    let releaseClosedResponse = null;
    chrome.runtime.sendMessage = (message, callback) => {
        if (message?.operation?.kind !== "upsertSessionSnapshot") {
            originalSendMessage(message, callback);
            return;
        }
        snapshotCallCount += 1;
        if (snapshotCallCount === 2) {
            originalSendMessage(message, (response) => {
                releaseClosedResponse = () => callback?.(response);
            });
            return;
        }
        originalSendMessage(message, callback);
    };
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video-a"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/channel-a",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    let mediaTimeA = 0;
    let mediaTimeB = 0;

    function configurePlayingVideo(video, getMediaTime) {
        makeVisibleVideo(video);
        Object.defineProperty(video, "paused", { configurable: true, get: () => false });
        Object.defineProperty(video, "ended", { configurable: true, get: () => false });
        Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
        Object.defineProperty(video, "currentTime", { configurable: true, get: getMediaTime });
        Object.defineProperty(video, "readyState", {
            configurable: true,
            get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
        });
    }

    t.after(async () => {
        releaseClosedResponse?.();
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    const videoA = dom.window.document.getElementById("video-a");
    configurePlayingVideo(videoA, () => mediaTimeA);

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTimeA += 10;
        tick();
    }
    flush();
    await waitForCondition(() => chrome.testState.runtimeMessages.length === 1);

    const videoB = dom.window.document.createElement("video");
    videoB.id = "video-b";
    configurePlayingVideo(videoB, () => mediaTimeB);
    videoA.replaceWith(videoB);
    dom.window.history.pushState({}, "", "/live/channel-b");
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:routechange", {
            detail: { href: dom.window.location.href, source: "test" },
        })
    );
    await waitForCondition(() => typeof releaseClosedResponse === "function");

    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTimeB += 10;
        tick();
    }
    flush();
    await waitForCondition(() => chrome.testState.runtimeMessages.length === 3);

    const [openA, closedA, openB] = chrome.testState.runtimeMessages.map((message) => message.operation);
    assert.equal(openA.entry.channelId, "channel-a");
    assert.equal(closedA.entry.channelId, "channel-a");
    assert.equal(closedA.session.closed, true);
    assert.equal(closedA.session.watchedSeconds, 60);
    assert.equal(openB.entry.channelId, "channel-b");
    assert.equal(openB.session.closed, false);
    assert.equal(openB.session.watchedSeconds, 60);
    assert.notEqual(openB.session.id, openA.session.id);
});

test("live watch history requires media progress before counting watch time", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let mediaTime = 0;

    t.after(async () => {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    assert.equal(typeof tick, "function");
    assert.equal(typeof flush, "function");

    for (let index = 0; index < 7; index += 1) {
        clock.advance(10000);
        tick();
    }
    flush();
    await waitForAsyncCallbacks();
    assert.equal(
        chrome.testState.runtimeMessages.filter((message) => message?.operation?.kind === "upsertSessionSnapshot")
            .length,
        0
    );

    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(
        () =>
            chrome.testState.runtimeMessages.filter((message) => message?.operation?.kind === "upsertSessionSnapshot")
                .length === 1
    );
    const entry = Object.values(chrome.testState.local.betterChzzkLiveWatchHistory.entries)[0];
    assert.equal(entry.watchedSeconds, 60);
});

test("live watch history migrates a flushed provisional record when live detail arrives later", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    let releaseProvisionalResponse = null;
    let provisionalResponseHeld = false;
    chrome.runtime.sendMessage = (message, callback) => {
        if (message?.operation?.kind === "upsertSessionSnapshot" && !provisionalResponseHeld) {
            provisionalResponseHeld = true;
            originalSendMessage(message, () => {
                releaseProvisionalResponse = () =>
                    callback?.({ ok: true, result: { status: "ignored", reason: "deleted", barrier: Date.now() } });
            });
            return;
        }
        originalSendMessage(message, callback);
    };
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let mediaTime = 0;
    let resolveLiveDetail = null;

    t.after(async () => {
        releaseProvisionalResponse?.();
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    dom.window.fetch = () =>
        new Promise((resolve) => {
            resolveLiveDetail = () =>
                resolve({
                    ok: true,
                    json: async () => ({ content: { liveId: "late-live" } }),
                });
        });
    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForCondition(() => typeof resolveLiveDetail === "function");

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(() => typeof releaseProvisionalResponse === "function");
    const provisionalRecordId = chrome.testState.runtimeMessages[0].operation.recordId;
    assert.match(provisionalRecordId, /^channel:test-channel:provisional:/);

    resolveLiveDetail();
    await waitForCondition(() =>
        chrome.testState.runtimeMessages.some((message) => message?.operation?.kind === "migrateRecordId")
    );
    await waitForCondition(() => chrome.testState.local.betterChzzkLiveWatchHistory.entries["live:late-live"]);
    const history = chrome.testState.local.betterChzzkLiveWatchHistory;
    assert.equal(history.entries[provisionalRecordId], undefined);
    assert.equal(history.entries["live:late-live"].watchedSeconds, 60);
    assert.equal(history.entries["live:late-live"].liveId, "late-live");
    assert.equal(history.recordAliases[provisionalRecordId].targetRecordId, "live:late-live");

    releaseProvisionalResponse();
    releaseProvisionalResponse = null;
    await waitForCondition(
        () =>
            chrome.testState.runtimeMessages.filter((message) => message?.operation?.kind === "upsertSessionSnapshot")
                .length === 2
    );
    const snapshots = chrome.testState.runtimeMessages.filter(
        (message) => message?.operation?.kind === "upsertSessionSnapshot"
    );
    assert.equal(snapshots[1].operation.recordId, "live:late-live");
    assert.equal(snapshots[1].operation.session.id, snapshots[0].operation.session.id);
});

test("live watch history ignores a late live A response after moving to live B", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<head><title>라이브 A 페이지 제목</title></head>",
            '<body><main><video id="video"></video></main></body>',
        ].join(""),
        "https://chzzk.naver.com/live/channel-a",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    const liveDetailResolvers = new Map();
    let mediaTime = 0;

    t.after(async () => {
        for (const release of liveDetailResolvers.values()) release();
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    dom.window.fetch = (url) =>
        new Promise((resolve) => {
            const channelId = String(url).includes("/channel-b/") ? "channel-b" : "channel-a";
            liveDetailResolvers.set(channelId, (overrides = {}) =>
                resolve({
                    ok: true,
                    json: async () => ({
                        content: {
                            channelId,
                            channelName: channelId === "channel-b" ? "채널 B" : "채널 A",
                            liveId: channelId === "channel-b" ? "live-b" : "live-a",
                            liveImageUrl:
                                channelId === "channel-b" ? "https://example.com/b.jpg" : "https://example.com/a.jpg",
                            liveTitle: channelId === "channel-b" ? "방송 B" : "방송 A",
                            ...overrides,
                        },
                    }),
                })
            );
        });
    configureWatchHistoryVideo(dom, video, () => mediaTime);

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForCondition(() => liveDetailResolvers.has("channel-a"));

    dom.window.history.pushState({}, "", "/live/channel-b");
    dom.window.document.title = "라이브 B 페이지 제목";
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:routechange", {
            detail: { href: dom.window.location.href, source: "test" },
        })
    );
    await waitForCondition(() => liveDetailResolvers.has("channel-b"));

    liveDetailResolvers.get("channel-b")();
    await waitForAsyncCallbacks();
    liveDetailResolvers.get("channel-a")();
    await waitForAsyncCallbacks();

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(
        () => chrome.testState.local.betterChzzkLiveWatchHistory?.entries?.["live:live-b"]?.watchedSeconds === 60
    );

    const history = chrome.testState.local.betterChzzkLiveWatchHistory;
    const entryB = history.entries["live:live-b"];
    assert.deepEqual(Object.keys(history.entries), ["live:live-b"]);
    assert.equal(entryB.channelId, "channel-b");
    assert.equal(entryB.liveId, "live-b");
    assert.equal(entryB.title, "방송 B");
    assert.equal(entryB.thumbnailUrl, "https://example.com/b.jpg");
    assert.deepEqual(
        entryB.titleHistory.map((row) => row.title),
        ["방송 B"]
    );
    assert.equal(JSON.stringify(entryB).includes("방송 A"), false);
    assert.equal(JSON.stringify(entryB).includes("live-a"), false);
    assert.equal(JSON.stringify(entryB).includes("a.jpg"), false);
});

test("live watch history splits same-channel broadcasts when live detail changes", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<head><title>A DOM 제목</title></head>",
            "<body>",
            "<main>",
            '<video id="video"></video>',
            "</main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let nowMs = Date.parse("2026-07-10T12:00:00+09:00");
    let mediaTime = 0;
    let apiLiveId = "broadcast-a";
    let apiTitle = "A 방송";
    let metadataRefreshCallback = null;
    let metadataTimerId = 60000;
    const metadataTimerIds = new Set();
    const originalSetTimeout = dom.window.setTimeout.bind(dom.window);
    const originalClearTimeout = dom.window.clearTimeout.bind(dom.window);
    dom.window.setTimeout = (callback, delayMs, ...args) => {
        if (delayMs === 60000) {
            const id = metadataTimerId++;
            metadataTimerIds.add(id);
            metadataRefreshCallback = () => callback(...args);
            return id;
        }
        return originalSetTimeout(callback, delayMs, ...args);
    };
    dom.window.clearTimeout = (id) => {
        if (metadataTimerIds.has(id)) {
            metadataTimerIds.delete(id);
            return;
        }
        originalClearTimeout(id);
    };

    t.after(async () => {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    dom.window.Date.now = () => nowMs;
    dom.window.fetch = async () => ({
        ok: true,
        json: async () => ({
            content: {
                channelName: "테스트 채널",
                liveId: apiLiveId,
                liveTitle: apiTitle,
            },
        }),
    });
    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForCondition(() => typeof metadataRefreshCallback === "function");

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        nowMs += 10000;
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(
        () => chrome.testState.local.betterChzzkLiveWatchHistory?.entries?.["live:broadcast-a"]?.watchedSeconds === 60
    );

    apiLiveId = "broadcast-b";
    apiTitle = "B 방송";
    dom.window.document.title = "B DOM 제목";
    metadataRefreshCallback();
    await waitForCondition(() =>
        chrome.testState.runtimeMessages.some(
            (message) =>
                message?.operation?.kind === "upsertSessionSnapshot" &&
                message.operation.recordId === "live:broadcast-a" &&
                message.operation.session.closed === true
        )
    );
    await waitForAsyncCallbacks();

    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        nowMs += 10000;
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(
        () => chrome.testState.local.betterChzzkLiveWatchHistory?.entries?.["live:broadcast-b"]?.watchedSeconds === 60
    );
    video.dispatchEvent(new dom.window.Event("ended"));
    await waitForCondition(
        () =>
            chrome.testState.local.betterChzzkLiveWatchHistory.entries["live:broadcast-b"].sessionDetails[0].closed ===
            true
    );

    const history = chrome.testState.local.betterChzzkLiveWatchHistory;
    const entryA = history.entries["live:broadcast-a"];
    const entryB = history.entries["live:broadcast-b"];
    assert.equal(Object.keys(history.entries).length, 2);
    assert.equal(entryA.watchedSeconds, 60);
    assert.equal(entryB.watchedSeconds, 60);
    assert.equal(entryA.title, "A 방송");
    assert.equal(entryB.title, "B 방송");
    assert.equal(entryA.sessionDetails[0].title, "A 방송");
    assert.equal(entryB.sessionDetails[0].title, "B 방송");
    assert.notEqual(entryA.sessionDetails[0].id, entryB.sessionDetails[0].id);
    assert.equal(
        entryA.titleHistory.some((row) => row.title === "B 방송"),
        false
    );
    assert.equal(
        entryB.titleHistory.some((row) => row.title === "A 방송"),
        false
    );
});

test("VOD replay chat fix ignores currentTime-only URL changes on the same VOD", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
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
    evalContentScripts(dom);
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

async function createVodBroadcastClockFixture(
    detail,
    { currentTime = 2, linkedDetails = {}, videoNo = "12345", watchHistory = [] } = {}
) {
    const chrome = createFakeChrome({
        local: {
            betterChzzkLiveWatchHistory: { entries: watchHistory },
        },
        sync: {
            liveWatchHistoryEnabled: watchHistory.length > 0,
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
            '<h1 id="title">Split VOD fixture</h1>',
            "</main>",
            "</body>",
        ].join(""),
        `https://chzzk.naver.com/video/${videoNo}`,
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const time = document.getElementById("time");
    const title = document.getElementById("title");

    video.currentTime = currentTime;
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
    dom.window.fetch = async (url) => {
        const requestedVideoNo = decodeURIComponent(String(url).split("/").pop());
        const requestedDetail = requestedVideoNo === videoNo ? detail : linkedDetails[requestedVideoNo];
        assert.ok(requestedDetail, `unexpected VOD detail request: ${requestedVideoNo}`);
        return {
            ok: true,
            json: async () => ({
                content: {
                    videoNo: requestedVideoNo,
                    videoTitle: "Split VOD fixture",
                    ...requestedDetail,
                },
            }),
        };
    };

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "vodBroadcastClock.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));

    await waitForCondition(() => {
        const clock = document.getElementById("betterchzzk-vod-broadcast-clock");
        return Boolean(clock?.querySelector(".bcbc-time")?.textContent);
    });

    return {
        clock: document.getElementById("betterchzzk-vod-broadcast-clock"),
        chrome,
        dom,
        video,
    };
}

test("VOD broadcast clock keeps normal VOD start time without a split offset", async () => {
    const originalStart = Date.parse("2026-06-28T00:00:00+09:00");
    const durationSeconds = 60 * 60;
    const { clock } = await createVodBroadcastClockFixture({
        liveOpenDate: "2026-06-28 00:00:00",
        duration: durationSeconds,
        publishDate: new Date(originalStart + durationSeconds * 1000).toISOString(),
    });

    assert.equal(clock.querySelector(".bcbc-time").textContent, "00:00:02");
    assert.match(clock.title, /2026-06-28 00:00:00 KST/);
    assert.equal(clock.title.includes("VOD"), false);
});

test("VOD broadcast clock rejects an explicit live id conflict even when the replay video number matches", async () => {
    const originalStart = Date.parse("2026-06-28T00:00:00+09:00");
    const durationSeconds = 60 * 60;
    const { chrome, dom } = await createVodBroadcastClockFixture(
        {
            channelId: "same-channel",
            channelName: "같은 채널",
            liveId: "actual-live",
            liveOpenDate: "2026-06-28 00:00:00",
            duration: durationSeconds,
            publishDate: new Date(originalStart + durationSeconds * 1000).toISOString(),
        },
        {
            watchHistory: [
                {
                    id: "conflicting-live",
                    channelId: "same-channel",
                    channelName: "같은 채널",
                    liveId: "different-live",
                    replayVideoNo: "12345",
                    title: "Split VOD fixture",
                    firstWatchedAt: originalStart,
                    lastWatchedAt: originalStart + 1000,
                    titleHistory: [
                        {
                            title: "충돌한 방송의 이전 방제",
                            firstSeenAt: originalStart - 2000,
                            lastSeenAt: originalStart - 1000,
                        },
                    ],
                },
                {
                    id: "matching-live",
                    channelId: "same-channel",
                    channelName: "같은 채널",
                    liveId: "actual-live",
                    title: "Split VOD fixture",
                    firstWatchedAt: originalStart,
                    lastWatchedAt: originalStart + 1000,
                    titleHistory: [
                        {
                            title: "현재 방송의 이전 방제",
                            firstSeenAt: originalStart - 2000,
                            lastSeenAt: originalStart - 1000,
                        },
                    ],
                },
            ],
        }
    );

    try {
        await waitForCondition(() =>
            dom.window.document
                .getElementById("betterchzzk-vod-title-history-panel")
                ?.textContent.includes("현재 방송의 이전 방제")
        );
        const panelText = dom.window.document.getElementById("betterchzzk-vod-title-history-panel").textContent;
        assert.match(panelText, /현재 방송의 이전 방제/);
        assert.doesNotMatch(panelText, /충돌한 방송의 이전 방제/);
    } finally {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener(
                {
                    liveWatchHistoryEnabled: { oldValue: true, newValue: false },
                    vodBroadcastClockEnabled: { oldValue: true, newValue: false },
                },
                "sync"
            );
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    }
});

test("VOD broadcast clock applies a 17h split offset for the second VOD segment", async () => {
    const originalStart = Date.parse("2026-06-28T00:00:00+09:00");
    const durationSeconds = 60 * 60;
    const secondSegmentStart = originalStart + 17 * 60 * 60 * 1000;
    const { clock } = await createVodBroadcastClockFixture({
        liveOpenDate: "2026-06-28 00:00:00",
        duration: durationSeconds,
        publishDate: new Date(secondSegmentStart + durationSeconds * 1000).toISOString(),
    });

    assert.equal(clock.querySelector(".bcbc-time").textContent, "17:00:02");
    assert.match(clock.title, /2026-06-28 17:00:00 KST/);
    assert.match(clock.title, /2026-06-28 00:00:00 KST/);
    assert.match(clock.title, /\+17:00:00/);
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
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "vodBroadcastClock.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();

    assert.equal(document.getElementById("betterchzzk-vod-broadcast-clock"), null);
});

function bindLiveTimeShiftVideoState(video, state) {
    Object.defineProperty(video, "currentTime", {
        configurable: true,
        get: () => state.currentTime,
        set: (value) => {
            state.currentTime = Number(value);
        },
    });
    Object.defineProperty(video, "paused", {
        configurable: true,
        get: () => state.paused,
    });
    Object.defineProperty(video, "buffered", {
        configurable: true,
        get: () => createTimeRanges([[0, state.bufferedEnd]]),
    });
    Object.defineProperty(video, "seekable", {
        configurable: true,
        get: () => createTimeRanges([[0, state.seekableEnd]]),
    });
    makeVisibleVideo(video);
}

function createLiveTimeShiftGuardDom(chrome) {
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div class="pzp pzp-pc" id="playerRoot">',
            '<video id="video"></video>',
            '<div class="pzp-pc__progress-slider" id="seekbar" role="slider" aria-valuenow="0"></div>',
            '<div class="pzp-pc__bottom-buttons--left" id="controls">',
            '<div class="pzp-pc__volume-slider" id="volumeSlider" role="slider" aria-valuenow="50" aria-label="\uC74C\uB7C9"></div>',
            '<button class="pzp-pc__playback-switch" id="play" type="button">Play</button>',
            "</div>",
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const seekbar = document.getElementById("seekbar");
    const volumeSlider = document.getElementById("volumeSlider");
    const controls = document.getElementById("controls");
    const play = document.getElementById("play");
    const state = {
        bufferedEnd: 40,
        currentTime: 32,
        paused: false,
        seekableEnd: 40,
    };

    bindLiveTimeShiftVideoState(video, state);
    seekbar.getBoundingClientRect = () => ({
        width: 560,
        height: 12,
        left: 40,
        top: 302,
        right: 600,
        bottom: 314,
    });
    controls.getBoundingClientRect = () => ({
        width: 180,
        height: 40,
        left: 16,
        top: 316,
        right: 196,
        bottom: 356,
    });
    volumeSlider.getBoundingClientRect = () => ({
        width: 80,
        height: 20,
        left: 64,
        top: 326,
        right: 144,
        bottom: 346,
    });
    play.getBoundingClientRect = () => ({
        width: 36,
        height: 36,
        left: 20,
        top: 318,
        right: 56,
        bottom: 354,
    });

    return { controls, document, dom, play, seekbar, state, video, volumeSlider };
}

async function loadSkipControlPage(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "skipControl.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();
}

function dispatchVideoEvent(dom, video, type) {
    video.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
}

function armLiveTimeShiftGuard(dom, video, state, currentTime = 32) {
    const seekbar = dom.window.document.getElementById("seekbar");
    seekbar?.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
    state.currentTime = currentTime;
    dispatchVideoEvent(dom, video, "seeking");
    dispatchVideoEvent(dom, video, "seeked");
    seekbar?.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true, cancelable: true }));
}

function waitForLiveTimeShiftSync() {
    return new Promise((resolve) => setTimeout(resolve, 650));
}

test("skip pill wheel decrement keeps one second as the minimum step", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipSeconds: 1,
        },
    });
    const { document, dom, state } = createLiveTimeShiftGuardDom(chrome);

    try {
        await loadSkipControlPage(dom);
        const pill = document.getElementById("betterchzzk-skip-pill");
        assert.ok(pill);

        const wheel = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
        Object.defineProperty(wheel, "deltaY", { value: 100 });
        pill.dispatchEvent(wheel);

        assert.equal(wheel.defaultPrevented, true);
        assert.equal(pill.querySelector(".bc-value").textContent, "1");

        const key = new dom.window.KeyboardEvent("keydown", {
            key: "ArrowRight",
            code: "ArrowRight",
            bubbles: true,
            cancelable: true,
        });
        document.body.dispatchEvent(key);

        assert.equal(key.defaultPrevented, true);
        assert.equal(state.currentTime, 33);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

function useFakePerformanceNow(dom, initialNow = 1000) {
    let now = initialNow;
    Object.defineProperty(dom.window.performance, "now", {
        configurable: true,
        value: () => now,
    });
    return {
        advance(milliseconds) {
            now += milliseconds;
        },
    };
}

async function closeSkipControlPage(dom, chrome) {
    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ skipControlEnabled: { newValue: false } }, "sync");
    }
    await waitForAsyncCallbacks();
    dom.window.close();
}

test("live timeshift guard does not roll back keyboard seeks into the near-live gray zone", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipSeconds: 5,
        },
    });
    const { document, dom, state, video } = createLiveTimeShiftGuardDom(chrome);

    try {
        await loadSkipControlPage(dom);
        armLiveTimeShiftGuard(dom, video, state, 32);

        const event = new dom.window.KeyboardEvent("keydown", {
            key: "ArrowRight",
            code: "ArrowRight",
            bubbles: true,
            cancelable: true,
        });
        document.body.dispatchEvent(event);

        assert.equal(event.defaultPrevented, true);
        assert.equal(video.currentTime, 37);

        await waitForLiveTimeShiftSync();

        assert.equal(video.currentTime, 37);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live timeshift guard ignores delayed live startup without user intent", async () => {
    const chrome = createFakeChrome();
    const { dom, state, video } = createLiveTimeShiftGuardDom(chrome);

    try {
        state.bufferedEnd = 1000;
        state.currentTime = 970;
        state.seekableEnd = 1000;
        await loadSkipControlPage(dom);

        dispatchVideoEvent(dom, video, "timeupdate");

        assert.equal(video.currentTime, 970);

        state.currentTime = 1000;
        dispatchVideoEvent(dom, video, "timeupdate");

        assert.equal(video.currentTime, 1000);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live pause snapshot restores a user-paused time-shift", async () => {
    const chrome = createFakeChrome();
    const { dom, play, state, video } = createLiveTimeShiftGuardDom(chrome);

    try {
        state.bufferedEnd = 1000;
        state.currentTime = 970;
        state.seekableEnd = 1000;
        await loadSkipControlPage(dom);

        play.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        state.paused = true;
        dispatchVideoEvent(dom, video, "pause");

        state.paused = false;
        state.currentTime = 1000;
        dispatchVideoEvent(dom, video, "play");

        assert.ok(video.currentTime >= 970 && video.currentTime < 972);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live pause snapshot restores when the user pauses from the video surface", async () => {
    const chrome = createFakeChrome();
    const { dom, state, video } = createLiveTimeShiftGuardDom(chrome);

    try {
        state.bufferedEnd = 1000;
        state.currentTime = 970;
        state.seekableEnd = 1000;
        await loadSkipControlPage(dom);

        video.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        state.paused = true;
        dispatchVideoEvent(dom, video, "pause");

        state.paused = false;
        state.currentTime = 1000;
        dispatchVideoEvent(dom, video, "play");

        assert.ok(video.currentTime >= 970 && video.currentTime < 972);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live pause snapshot is discarded when the video element is replaced on the same live route", async () => {
    const chrome = createFakeChrome();
    const { document, dom, play, state, video } = createLiveTimeShiftGuardDom(chrome);
    const clock = useFakePerformanceNow(dom);
    const nextVideo = document.createElement("video");
    const nextState = {
        bufferedEnd: 1000,
        currentTime: 1000,
        paused: false,
        seekableEnd: 1000,
    };

    bindLiveTimeShiftVideoState(nextVideo, nextState);

    try {
        state.bufferedEnd = 1000;
        state.currentTime = 970;
        state.seekableEnd = 1000;
        await loadSkipControlPage(dom);

        play.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        state.paused = true;
        dispatchVideoEvent(dom, video, "pause");

        video.replaceWith(nextVideo);
        await waitForAsyncCallbacks();
        await waitForAsyncCallbacks();
        await waitForLiveTimeShiftSync();

        dispatchVideoEvent(dom, nextVideo, "play");
        dispatchVideoEvent(dom, nextVideo, "playing");

        assert.equal(nextVideo.currentTime, 1000);

        armLiveTimeShiftGuard(dom, nextVideo, nextState, 970);
        clock.advance(1300);
        nextState.currentTime = 1000;
        dispatchVideoEvent(dom, nextVideo, "seeking");

        assert.ok(nextVideo.currentTime >= 970 && nextVideo.currentTime < 972);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("skip controls ignore following preview video when choosing the live player", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipSeconds: 5,
        },
    });
    const { document, dom, state, video } = createLiveTimeShiftGuardDom(chrome);
    const previewMount = document.createElement("div");
    const previewVideo = document.createElement("video");
    const previewState = {
        bufferedEnd: 80,
        currentTime: 10,
        paused: false,
        seekableEnd: 80,
    };

    previewMount.className = "bcfp-player";
    previewMount.setAttribute("data-bcfp-player-mount", "preview");
    previewMount.appendChild(previewVideo);
    document.body.prepend(previewMount);

    Object.defineProperty(previewVideo, "currentTime", {
        configurable: true,
        get: () => previewState.currentTime,
        set: (value) => {
            previewState.currentTime = Number(value);
        },
    });
    Object.defineProperty(previewVideo, "paused", {
        configurable: true,
        get: () => previewState.paused,
    });
    Object.defineProperty(previewVideo, "buffered", {
        configurable: true,
        get: () => createTimeRanges([[0, previewState.bufferedEnd]]),
    });
    Object.defineProperty(previewVideo, "seekable", {
        configurable: true,
        get: () => createTimeRanges([[0, previewState.seekableEnd]]),
    });
    previewVideo.getBoundingClientRect = () => ({
        width: 800,
        height: 450,
        left: 0,
        top: 0,
        right: 800,
        bottom: 450,
    });
    video.getBoundingClientRect = () => ({
        width: 320,
        height: 180,
        left: 0,
        top: 0,
        right: 320,
        bottom: 180,
    });

    try {
        await loadSkipControlPage(dom);

        const event = new dom.window.KeyboardEvent("keydown", {
            key: "ArrowRight",
            code: "ArrowRight",
            bubbles: true,
            cancelable: true,
        });
        document.body.dispatchEvent(event);

        assert.equal(event.defaultPrevented, true);
        assert.equal(state.currentTime, 37);
        assert.equal(previewState.currentTime, 10);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live timeshift guard accepts seekbar pointer seeks as user intent", async () => {
    const chrome = createFakeChrome();
    const { dom, seekbar, state, video } = createLiveTimeShiftGuardDom(chrome);

    try {
        await loadSkipControlPage(dom);
        armLiveTimeShiftGuard(dom, video, state, 32);

        seekbar.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        video.currentTime = 35;
        dispatchVideoEvent(dom, video, "seeking");
        dispatchVideoEvent(dom, video, "seeked");

        assert.equal(video.currentTime, 35);

        await waitForLiveTimeShiftSync();

        assert.equal(video.currentTime, 35);

        seekbar.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 1300));
        video.currentTime = 39;
        dispatchVideoEvent(dom, video, "seeking");

        assert.ok(video.currentTime >= 35 && video.currentTime < 37.5);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live timeshift guard ignores non-seek slider gestures for forced live-edge jumps", async () => {
    const chrome = createFakeChrome();
    const { dom, state, video, volumeSlider } = createLiveTimeShiftGuardDom(chrome);
    const clock = useFakePerformanceNow(dom);

    try {
        await loadSkipControlPage(dom);
        armLiveTimeShiftGuard(dom, video, state, 32);
        clock.advance(1300);

        volumeSlider.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        video.currentTime = 39;
        dispatchVideoEvent(dom, video, "seeking");

        assert.ok(video.currentTime >= 32 && video.currentTime < 34);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
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
        evalContentScripts(dom);
        evalRepoScript(dom, "features", "skipControl.js");
        document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
        await waitForAsyncCallbacks();
        await waitForAsyncCallbacks();

        const button = document.getElementById("betterchzzk-live-fast-forward");
        assert.ok(button);
        assert.equal(button.parentElement, controls);
        assert.equal(button.previousElementSibling, play, "fast forward keeps its original position after playback");
        assert.equal(button.getAttribute("label"), "\uBE68\uB9AC \uAC10\uAE30");
        assert.equal(button.getAttribute("aria-label"), "\uBE68\uB9AC \uAC10\uAE30");
        assert.equal(button.getAttribute("tooltip"), "\uBE68\uB9AC \uAC10\uAE30");
        assert.equal(button.hasAttribute("title"), false);
        assert.equal(button.classList.contains("knife-ff"), true);
        assert.ok(button.querySelector("ui-next-media-icon.bc-live-ff-icon svg"));
        assert.equal(button.querySelector(".betterchzzk-player-tooltip").textContent, "빨리 감기");
        assert.equal(button.querySelector(".bc-live-ff-icon").textContent.trim(), "");
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

test("live fast-forward button jumps to the seekable live edge on a time-machine channel", async () => {
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
    // 타임머신 채널: forward 버퍼 끝(42)은 라이브 엣지(seekable.end=200)보다 한참 뒤.
    Object.defineProperty(video, "buffered", {
        configurable: true,
        get: () => createTimeRanges([[0, 42]]),
    });
    Object.defineProperty(video, "seekable", {
        configurable: true,
        get: () => createTimeRanges([[0, 200]]),
    });

    try {
        evalRepoScript(dom, "shared", "settings.js");
        evalContentScripts(dom);
        evalRepoScript(dom, "features", "skipControl.js");
        document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
        await waitForAsyncCallbacks();
        await waitForAsyncCallbacks();

        const button = document.getElementById("betterchzzk-live-fast-forward");
        assert.ok(button);
        assert.equal(button.disabled, false);

        button.click();

        assert.equal(video.currentTime, 200);
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
        evalContentScripts(dom);
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

function setupPlaybackShortcutDom(chrome) {
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div class="pzp pzp-pc" id="playerRoot">',
            '<video id="video"></video>',
            '<div class="pzp-pc__bottom-buttons--left" id="controls">',
            '<button class="pzp-pc__playback-switch" id="play" type="button"></button>',
            '<button class="pzp-pc__volume-button" id="mute" type="button" aria-label="음소거"></button>',
            '<button class="pzp-pc__viewmode-button" id="theater" type="button" aria-label="넓은 화면"></button>',
            '<div id="customTextbox" role="textbox" tabindex="0"></div>',
            "</div>",
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const state = { paused: true, clicks: { play: 0, mute: 0, theater: 0 } };

    Object.defineProperty(video, "paused", { configurable: true, get: () => state.paused });
    video.play = () => {
        state.paused = false;
        return Promise.resolve();
    };
    video.pause = () => {
        state.paused = true;
    };
    makeVisibleVideo(video);

    for (const id of ["play", "mute", "theater"]) {
        const button = document.getElementById(id);
        button.getBoundingClientRect = () => ({ width: 36, height: 36, left: 20, top: 318, right: 56, bottom: 354 });
        button.addEventListener("click", () => {
            state.clicks[id] += 1;
            if (id === "play") state.paused = !state.paused;
        });
    }

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "holdSpeed.js");

    return { dom, document, video, state };
}

function dispatchShortcutKey(
    dom,
    code,
    key,
    { type = "keydown", target = dom.window.document.body, repeat = false } = {}
) {
    const event = new dom.window.KeyboardEvent(type, {
        code,
        key,
        bubbles: true,
        cancelable: true,
        repeat,
    });
    target.dispatchEvent(event);
    return event;
}

function waitForShortcutEffects() {
    return new Promise((resolve) => setTimeout(resolve, 150));
}

test("hold speed preserves live Space hold and short press without a second toggle", async () => {
    const chrome = createFakeChrome();
    const { dom, state, video } = setupPlaybackShortcutDom(chrome);

    try {
        await waitForAsyncCallbacks();

        const holdDown = dispatchShortcutKey(dom, "Space", " ");
        assert.equal(holdDown.defaultPrevented, true);
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(video.playbackRate, 2);
        assert.equal(state.paused, true);

        const holdUp = dispatchShortcutKey(dom, "Space", " ", { type: "keyup" });
        assert.equal(holdUp.defaultPrevented, true);
        assert.equal(video.playbackRate, 1);
        assert.equal(state.paused, true);

        dispatchShortcutKey(dom, "Space", " ");
        dispatchShortcutKey(dom, "Space", " ", { type: "keyup" });
        await waitForShortcutEffects();
        assert.equal(state.paused, false, "the short Space press must toggle playback once");
        assert.equal(state.clicks.play, 0, "the short press must not also click the native play button");
    } finally {
        dom.window.close();
    }
});

test("native playback shortcuts pass through without synthetic control clicks", async (t) => {
    const chrome = createFakeChrome({ sync: { holdSpeedEnabled: false } });
    const { dom, state, video } = setupPlaybackShortcutDom(chrome);
    t.after(() => dom.window.close());
    await waitForAsyncCallbacks();
    for (const target of [dom.window.document.body, video]) {
        for (const [code, key] of [
            ["Space", " "],
            ["KeyM", "m"],
            ["KeyF", "f"],
            ["KeyT", "t"],
        ]) {
            let received = 0;
            const nativeHandler = (event) => {
                if (event.code === code) received++;
            };
            dom.window.document.addEventListener("keydown", nativeHandler);
            const event = dispatchShortcutKey(dom, code, key, { target });
            assert.equal(event.defaultPrevented, false, `${code} remains available to the native handler`);
            assert.equal(received, 1);
            dom.window.document.removeEventListener("keydown", nativeHandler);
        }
    }
    await waitForShortcutEffects();
    assert.deepEqual(state.clicks, { play: 0, mute: 0, theater: 0 });
    assert.equal(state.paused, true);
});

test("history page renders only canonical CHZZK live links from stored rows", async () => {
    const startedAt = Date.now() - 60000;
    const dateKey = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const entry = (id, title, liveUrl, channelId = "") => ({
        id,
        channelId,
        channelName: "Security Test Channel",
        title,
        liveUrl,
        firstWatchedAt: startedAt,
        lastWatchedAt: startedAt + 60000,
        watchedSeconds: 60,
        dailySeconds: { [dateKey]: 60 },
        sessions: 1,
    });
    const chrome = createFakeChrome({
        local: {
            betterChzzkLiveWatchHistory: {
                entries: {
                    "live:trusted": entry(
                        "live:trusted",
                        "Trusted legacy link",
                        "https://chzzk.naver.com/live/trusted-channel?from=legacy#title"
                    ),
                    "live:external": entry("live:external", "External link", "https://evil.example/phish"),
                    "live:script": entry("live:script", "Script link", "javascript:alert(1)"),
                    "live:channel": entry(
                        "live:channel",
                        "Channel-derived link",
                        "https://evil.example/ignored",
                        "safe-channel"
                    ),
                },
            },
        },
    });
    const dom = createDom("history.html", "history.html", chrome);

    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "history.js");
    await waitForAsyncCallbacks();

    const titles = Array.from(dom.window.document.querySelectorAll(".history-item-main > :first-child"));
    const findTitle = (text) => titles.find((node) => node.textContent === text);
    assert.ok(findTitle("Trusted legacy link"), dom.window.document.getElementById("historyList").innerHTML);
    assert.equal(findTitle("Trusted legacy link").href, "https://chzzk.naver.com/live/trusted-channel");
    assert.equal(findTitle("External link").tagName, "STRONG");
    assert.equal(findTitle("Script link").tagName, "STRONG");
    assert.equal(findTitle("Channel-derived link").getAttribute("href"), "#");
    assert.equal(dom.window.document.getElementById("historyList").innerHTML.includes("evil.example"), false);
    dom.window.close();
});

test("history page counts overlapping tab ranges once while keeping a single merged session row", async () => {
    const startMs = Date.parse("2026-06-29T09:00:00+09:00");
    const watchedSeconds = 10 * 60;
    const dateKey = "2026-06-29";
    const session = (id) => ({
        dailySeconds: { [dateKey]: watchedSeconds },
        enteredAt: startMs,
        id,
        leftAt: startMs + watchedSeconds * 1000,
        watchedRanges: [{ startAt: startMs, endAt: startMs + watchedSeconds * 1000 }],
        watchedSeconds,
    });
    const chrome = createFakeChrome({
        local: {
            betterChzzkLiveWatchHistory: {
                entries: {
                    "live:overlapping-tabs": {
                        channelId: "test-channel",
                        channelName: "테스트 채널",
                        dailySeconds: { [dateKey]: watchedSeconds * 2 },
                        firstWatchedAt: startMs,
                        id: "live:overlapping-tabs",
                        lastWatchedAt: startMs + watchedSeconds * 1000,
                        liveId: "overlapping-tabs",
                        sessionDetails: [session("tab-a"), session("tab-b")],
                        title: "동시 탭 기록",
                        watchedSeconds: watchedSeconds * 2,
                    },
                },
            },
        },
    });
    const dom = createDom("history.html", "history.html", chrome);

    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "history.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    assert.equal(document.getElementById("totalWatchTime").textContent, "10분");
    assert.equal(document.getElementById("monthWatchTime").textContent, "10분");
    assert.match(document.querySelector(`[data-date="${dateKey}"]`).getAttribute("aria-label"), /10분/);
    document.querySelector(".history-entry-detail").click();
    assert.equal(document.querySelectorAll(".history-session-item").length, 1);
    assert.match(document.querySelector(".history-session-item").textContent, /시청10분/);
    dom.window.close();
});

test("history totals deduplicate recorded time across broadcasts without changing individual durations", async (t) => {
    const base = Date.parse("2026-06-30T23:00:00+09:00");
    for (const scenario of [
        {
            name: "identical",
            spans: [
                [0, 600],
                [0, 600],
            ],
            seconds: 600,
            june: 600,
            july: 0,
        },
        {
            name: "partial",
            spans: [
                [0, 600],
                [300, 900],
            ],
            seconds: 900,
            june: 900,
            july: 0,
        },
        {
            name: "nested",
            spans: [
                [0, 1200],
                [300, 600],
                [0, 1200],
            ],
            seconds: 1200,
            june: 1200,
            july: 0,
        },
        {
            name: "disjoint",
            spans: [
                [0, 600],
                [900, 1500],
            ],
            seconds: 1200,
            june: 1200,
            july: 0,
        },
        {
            name: "short gap",
            spans: [
                [0, 600],
                [601, 1201],
            ],
            seconds: 1200,
            june: 1200,
            july: 0,
        },
        {
            name: "month boundary",
            spans: [
                [3000, 4200],
                [3300, 4500],
            ],
            seconds: 1500,
            june: 600,
            july: 900,
        },
        {
            name: "missing ranges",
            spans: [
                [0, 600],
                [0, 600],
            ],
            legacy: true,
            seconds: 1200,
            june: 1200,
            july: 0,
        },
        {
            name: "partial ranges",
            spans: [
                [0, 600],
                [0, 600],
            ],
            residual: 300,
            seconds: 900,
            june: 900,
            july: 0,
        },
    ]) {
        await t.test(scenario.name, async (t) => {
            const rows = scenario.spans.map(([start, end], index) => {
                const startAt = base + start * 1000;
                const endAt = base + end * 1000;
                const residual = index === 1 ? scenario.residual || 0 : 0;
                const watchedSeconds = end - start + residual;
                const dailySeconds = {};
                if (start < 3600) dailySeconds["2026-06-30"] = Math.min(end, 3600) - start + residual;
                if (end > 3600) dailySeconds["2026-07-01"] = end - Math.max(start, 3600);
                return {
                    id: `live:overlap-${index}`,
                    channelId: `channel-${index}`,
                    channelName: `채널 ${index}`,
                    title: `방송 ${index}`,
                    firstWatchedAt: startAt,
                    lastWatchedAt: endAt,
                    watchedSeconds,
                    dailySeconds,
                    sessionDetails: [
                        {
                            id: `session-${index}`,
                            enteredAt: startAt,
                            leftAt: endAt,
                            watchedSeconds,
                            dailySeconds,
                            watchedRanges: scenario.legacy && index === 1 ? [] : [{ startAt, endAt }],
                        },
                    ],
                };
            });
            const chrome = createFakeChrome({ local: { betterChzzkLiveWatchHistory: { entries: rows } } });
            const dom = createDom("history.html", "history.html", chrome);
            t.after(() => dom.window.close());
            evalRepoScript(dom, "shared", "data.js");
            evalRepoScript(dom, "history.js");
            await waitForAsyncCallbacks();
            const { window } = dom;
            assert.equal(window.getUniqueWatchSecondsForScope(), scenario.seconds);
            assert.equal(window.getUniqueWatchSecondsForMonth(2026, 6), scenario.june);
            assert.equal(window.getUniqueWatchSecondsForMonth(2026, 7), scenario.july);
            assert.equal(window.getDayTotals(2026, 6)["2026-06-30"] || 0, scenario.june);
            assert.equal(window.getDayTotals(2026, 7)["2026-07-01"] || 0, scenario.july);
            assert.equal(
                window.document.getElementById("totalWatchTime").textContent,
                window.formatDuration(scenario.seconds)
            );
            const normalized = window.normalizeHistory({ entries: rows });
            assert.deepEqual(
                Array.from(normalized, (row) => row.watchedSeconds).sort((a, b) => a - b),
                rows.map((row) => row.watchedSeconds).sort((a, b) => a - b)
            );
            const dateKey = scenario.july ? "2026-07-01" : "2026-06-30";
            const monthSeconds = scenario.july || scenario.june;
            assert.equal(
                window.document.getElementById("monthWatchTime").textContent,
                window.formatDuration(monthSeconds)
            );
            assert.ok(
                window.document
                    .querySelector(`[data-date="${dateKey}"]`)
                    .getAttribute("aria-label")
                    .includes(window.formatDuration(monthSeconds))
            );
            assert.deepEqual(
                Array.from(window.document.querySelectorAll(".history-item-time"), (node) => node.textContent).sort(),
                rows.map((row) => window.formatDuration(row.dailySeconds[dateKey])).sort()
            );
        });
    }
});

for (const permissionGranted of [false, true]) {
    test("multiview option handles permission " + (permissionGranted ? "approval" : "denial"), async (t) => {
        const chrome = createFakeChrome({ sync: { liveMultiviewEnabled: false }, permissionGranted });
        const dom = createDom("options.html", "options.html", chrome);
        t.after(() => dom.window.close());
        evalRepoScript(dom, "shared", "settings.js");
        evalRepoScript(dom, "options.js");
        await waitForAsyncCallbacks();
        const input = queryOption(dom.window.document, "liveMultiviewEnabled");
        input.checked = true;
        dispatch(dom, input, "change");
        dom.window.document.getElementById("save").click();
        await waitForAsyncCallbacks();
        assert.equal(chrome.testState.permissionRequests.length, 1);
        assert.deepEqual(Array.from(chrome.testState.permissionRequests[0].origins), ["https://*.pstatic.net/*"]);
        assert.equal(input.checked, permissionGranted);
        assert.equal(chrome.testState.sync.liveMultiviewEnabled, permissionGranted);
        if (permissionGranted) {
            const volume = queryOption(dom.window.document, "volumeWheelStep");
            volume.value = "6";
            dispatch(dom, volume, "input");
            dom.window.document.getElementById("save").click();
            await waitForAsyncCallbacks();
            assert.equal(chrome.testState.permissionRequests.length, 1, "already enabled media must not request again");
        }
    });
}

test("volume wheel ignores multiview secondary videos when choosing media volume", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div class="bcfp-player" data-bcfp-player-mount="preview">',
            '<video id="previewVideo"></video>',
            "</div>",
            '<div class="pzp-pc" id="playerRoot">',
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol">',
            '<button class="pzp-pc__volume-button" type="button"></button>',
            "</div>",
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const previewVideo = document.getElementById("previewVideo");
    const vol = document.getElementById("vol");
    previewVideo.parentElement.removeAttribute("class");
    previewVideo.parentElement.removeAttribute("data-bcfp-player-mount");
    previewVideo.parentElement.removeAttribute("data-bcfp-tooltip");
    previewVideo.removeAttribute("class");
    previewVideo.removeAttribute("data-bcfp-player-mount");
    previewVideo.setAttribute("data-bcmv-video", "1");

    video.volume = 0.5;
    previewVideo.volume = 0.1;
    previewVideo.getBoundingClientRect = () => ({
        width: 800,
        height: 450,
        left: 0,
        top: 0,
        right: 800,
        bottom: 450,
    });
    video.getBoundingClientRect = () => ({ width: 320, height: 180, left: 0, top: 0, right: 320, bottom: 180 });
    vol.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    vol.dispatchEvent(up);

    assert.ok(Math.abs(video.volume - 0.55) < 1e-6);
    assert.ok(Math.abs(previewVideo.volume - 0.1) < 1e-6);
    assert.equal(up.defaultPrevented, true);
});

test("auto quality ignores the multiview secondary video when choosing the main player", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div data-bcfp-tooltip="1"><video id="preview" class="bcfp-player" data-bcfp-player-mount="preview"></video></div>',
            '<pzp-player><video id="main"></video></pzp-player>',
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const preview = document.getElementById("preview");
    const main = document.getElementById("main");
    preview.parentElement.removeAttribute("class");
    preview.parentElement.removeAttribute("data-bcfp-player-mount");
    preview.parentElement.removeAttribute("data-bcfp-tooltip");
    preview.removeAttribute("class");
    preview.removeAttribute("data-bcfp-player-mount");
    preview.setAttribute("data-bcmv-video", "1");
    const tracks = [
        { id: "auto", label: "auto 1080p", height: 1080 },
        { id: "480", label: "480p", height: 480, kind: "main" },
        { id: "720", label: "720p", height: 720, kind: "main" },
    ];
    const trackList = createVideoTrackList(tracks, 1);

    main.currentTime = 2;
    preview.currentTime = 5;
    makeVisibleVideo(main);
    preview.getBoundingClientRect = () => ({
        width: 800,
        height: 450,
        left: 0,
        top: 0,
        right: 800,
        bottom: 450,
    });
    Object.defineProperty(main, "videoTracks", {
        configurable: true,
        get: () => trackList,
    });

    evalRepoScript(dom, "features", "autoQualityPage.js");

    const result = requestAutoQualityApply(dom, "1080p");
    assert.equal(result.status, "selected");
    assert.equal(trackList.selectedIndex, 2);
    assert.equal(preview.currentTime, 5);
    disableAutoQualityPage(dom);
    await waitForAsyncCallbacks();
    dom.window.close();
});

test("skip controls ignore multiview secondary video when choosing the live player", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipSeconds: 5,
        },
    });
    const { document, dom, state, video } = createLiveTimeShiftGuardDom(chrome);
    const previewMount = document.createElement("div");
    const previewVideo = document.createElement("video");
    const previewState = {
        bufferedEnd: 80,
        currentTime: 10,
        paused: false,
        seekableEnd: 80,
    };

    previewMount.className = "bcfp-player";
    previewMount.setAttribute("data-bcfp-player-mount", "preview");
    previewMount.appendChild(previewVideo);
    document.body.prepend(previewMount);
    previewMount.removeAttribute("class");
    previewMount.removeAttribute("data-bcfp-player-mount");
    previewMount.removeAttribute("data-bcfp-tooltip");
    previewVideo.removeAttribute("class");
    previewVideo.removeAttribute("data-bcfp-player-mount");
    previewVideo.setAttribute("data-bcmv-video", "1");

    Object.defineProperty(previewVideo, "currentTime", {
        configurable: true,
        get: () => previewState.currentTime,
        set: (value) => {
            previewState.currentTime = Number(value);
        },
    });
    Object.defineProperty(previewVideo, "paused", {
        configurable: true,
        get: () => previewState.paused,
    });
    Object.defineProperty(previewVideo, "buffered", {
        configurable: true,
        get: () => createTimeRanges([[0, previewState.bufferedEnd]]),
    });
    Object.defineProperty(previewVideo, "seekable", {
        configurable: true,
        get: () => createTimeRanges([[0, previewState.seekableEnd]]),
    });
    previewVideo.getBoundingClientRect = () => ({
        width: 800,
        height: 450,
        left: 0,
        top: 0,
        right: 800,
        bottom: 450,
    });
    video.getBoundingClientRect = () => ({
        width: 320,
        height: 180,
        left: 0,
        top: 0,
        right: 320,
        bottom: 180,
    });

    try {
        await loadSkipControlPage(dom);

        const event = new dom.window.KeyboardEvent("keydown", {
            key: "ArrowRight",
            code: "ArrowRight",
            bubbles: true,
            cancelable: true,
        });
        document.body.dispatchEvent(event);

        assert.equal(event.defaultPrevented, true);
        assert.equal(state.currentTime, 37);
        assert.equal(previewState.currentTime, 10);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

function changePlayerDisplayOptions(chrome, updates) {
    Object.assign(chrome.testState.sync, updates);
    const changes = Object.fromEntries(Object.entries(updates).map(([key, value]) => [key, { newValue: value }]));
    for (const listener of chrome.testState.storageChangeListeners) listener(changes, "sync");
}

function registerPlayerDisplayCleanup(t, dom) {
    const observers = [];
    const NativeObserver = dom.window.MutationObserver;
    dom.window.MutationObserver = class extends NativeObserver {
        constructor(callback) {
            super(callback);
            observers.push(this);
        }
    };
    t.after(() => {
        for (const observer of observers) observer.disconnectAll ? observer.disconnectAll() : observer.disconnect();
        dom.window.close();
    });
}

async function createVolumeTooltipPage(t, pathname = "/live/test-channel") {
    const chrome = createFakeChrome({ sync: { volumeTooltipEnabled: true, audioCompressorEnabled: true } });
    const dom = createPageDom(
        `<!doctype html><body><div class="pzp-pc">
        <video id="main-video"></video><div class="pzp-pc__volume-control" id="volume-area">
        <button type="button" class="pzp-pc__volume-button" id="speaker"><span id="speaker-icon"></span></button>
        <div class="pzp-pc__volume-slider" id="slider"><span id="thumb"></span></div></div>
        <button type="button" aria-label="음량" id="label-volume"></button>
        <div class="bcmv-cell"><video data-bcmv-video></video><input type="range" aria-label="볼륨" id="secondary-volume"></div>
        <button type="button" id="unrelated">재생</button></div></body>`,
        `https://chzzk.naver.com${pathname}`,
        chrome
    );
    registerPlayerDisplayCleanup(t, dom);
    const document = dom.window.document;
    for (const node of document.querySelectorAll("video,button,div,span,input")) {
        node.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 });
    }
    makeVisibleVideo(document.getElementById("main-video"));
    document.getElementById("main-video").getBoundingClientRect = () => ({
        left: 100,
        top: 80,
        right: 900,
        bottom: 530,
        width: 800,
        height: 450,
    });
    document.getElementById("volume-area").getBoundingClientRect = () => ({
        left: 120,
        top: 470,
        right: 400,
        bottom: 510,
        width: 280,
        height: 40,
    });
    document.getElementById("slider").getBoundingClientRect = () => ({
        left: 200,
        top: 483,
        right: 280,
        bottom: 493,
        width: 80,
        height: 10,
    });
    const nativeRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
        if (this.id !== "betterchzzk-volume-tooltip") return nativeRect.call(this);
        const left = Number.parseFloat(this.style.left || "0") - 30;
        const top = Number.parseFloat(this.style.top || "0") - 30;
        return { left, top, right: left + 60, bottom: top + 30, width: 60, height: 30 };
    };
    const secondary = document.querySelector("[data-bcmv-video]");
    secondary.getBoundingClientRect = () => ({ left: 0, top: 0, right: 2000, bottom: 1000, width: 2000, height: 1000 });
    evalVolumeWheelScripts(dom);
    evalRepoScript(dom, "features", "volumeTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    const hover = (id) =>
        document.getElementById(id).dispatchEvent(
            new dom.window.MouseEvent("mouseover", {
                bubbles: true,
                clientY: document.getElementById("slider").getBoundingClientRect().top + 5,
            })
        );
    return {
        dom,
        document,
        chrome,
        hover,
        video: document.getElementById("main-video"),
        tooltip: () => document.getElementById("betterchzzk-volume-tooltip"),
    };
}

test("volume tooltip covers main volume controls while staying anchored to the slider", async (t) => {
    const { dom, document, hover, video, tooltip } = await createVolumeTooltipPage(t);
    video.volume = 0.35;
    hover("slider");
    const original = tooltip();
    assert.equal(original.textContent, "35%");
    assert.equal(original.style.left, "240px");
    assert.equal(original.style.top, "473px");
    document.getElementById("slider").dispatchEvent(
        new dom.window.MouseEvent("mouseout", {
            bubbles: true,
            relatedTarget: document.getElementById("thumb"),
            clientY: 488,
        })
    );
    assert.equal(tooltip(), original);
    for (const id of ["slider", "thumb"]) {
        hover(id);
        assert.equal(tooltip(), original);
        const wheel = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
        document.getElementById(id).dispatchEvent(wheel);
        assert.equal(wheel.defaultPrevented, true, id);
        await waitForAsyncCallbacks();
        assert.equal(tooltip().textContent, `${Math.round(video.volume * 100)}%`);
    }
    for (const [volume, muted, label] of [
        [0, false, "0%"],
        [1, false, "100%"],
        [0.8, true, "80%"],
    ]) {
        video.volume = volume;
        video.muted = muted;
        video.dispatchEvent(new dom.window.Event("volumechange"));
        assert.equal(tooltip().textContent, label);
    }
    document.getElementById("thumb").dispatchEvent(
        new dom.window.MouseEvent("mouseout", {
            bubbles: true,
            relatedTarget: document.getElementById("betterchzzk-audio-compressor"),
            clientY: 488,
        })
    );
    assert.equal(tooltip(), null, "the compressor has its own output percentage");
    for (const id of ["volume-area", "speaker", "speaker-icon"]) {
        hover(id);
        assert.equal(tooltip(), original, id);
        assert.equal(tooltip().style.left, "240px", id);
        assert.equal(tooltip().style.top, "473px", id);
    }
    for (const id of [
        "label-volume",
        "unrelated",
        "secondary-volume",
        "betterchzzk-audio-compressor",
        "betterchzzk-audio-compressor-volume",
    ]) {
        hover(id);
        assert.equal(tooltip(), null, id);
    }
    // Tooltip hit testing must not change the existing wheel controls.
    for (const id of ["volume-area", "speaker", "label-volume"]) {
        const wheel = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
        document.getElementById(id).dispatchEvent(wheel);
        assert.equal(wheel.defaultPrevented, true, id);
        assert.equal(tooltip(), null);
    }
    const secondaryWheel = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
    document.getElementById("secondary-volume").dispatchEvent(secondaryWheel);
    assert.equal(secondaryWheel.defaultPrevented, false);
});

test("volume percentage stays fixed as the volume bar expands", async (t) => {
    const { dom, document, hover, video, tooltip } = await createVolumeTooltipPage(t);
    const slider = document.getElementById("slider");
    for (const width of [8, 40, 80]) {
        slider.getBoundingClientRect = () => ({
            left: 200,
            top: 483,
            right: 200 + width,
            bottom: 493,
            width,
            height: 10,
        });
        hover("slider");
        assert.equal(tooltip().style.left, "240px", `bar width ${width}`);
        video.dispatchEvent(new dom.window.Event("volumechange"));
        assert.equal(tooltip().style.left, "240px", "volume updates keep the same anchor");
    }
});

test("player tooltips share native typography and percentage follows the native tooltip height", async (t) => {
    const { dom, document, hover, video, tooltip } = await createVolumeTooltipPage(t);
    const speaker = document.getElementById("speaker");
    speaker.getBoundingClientRect = () => ({ left: 120, top: 470, right: 156, bottom: 506, width: 36, height: 36 });
    const native = document.createElement("span");
    native.className = "pzp-button__tooltip pzp-button__tooltip--top";
    native.style.cssText =
        "font:400 13px Arial;line-height:normal;padding:6px 12px;border-radius:14px;background:rgba(0,0,0,.6);color:white;position:absolute;top:-38px";
    speaker.append(native);
    for (const theme of ["theme_light", "theme_dark"]) {
        document.documentElement.className = theme;
        hover("slider");
        const style = dom.window.getComputedStyle(tooltip());
        assert.equal(style.fontSize, "13px");
        assert.equal(style.fontWeight, "400");
        assert.equal(style.padding, "6px 12px");
        assert.equal(style.borderRadius, "14px");
        assert.equal(tooltip().style.top, "462px");
        const compressor = document.querySelector("#betterchzzk-audio-compressor .betterchzzk-player-tooltip");
        assert.ok(compressor.classList.contains("pzp-button__tooltip--top"));
        assert.equal(dom.window.getComputedStyle(compressor).fontWeight, "400");
    }
    native.style.top = "-52px";
    video.dispatchEvent(new dom.window.Event("volumechange"));
    assert.equal(tooltip().style.top, "448px", "native player size changes update the percentage position");
});

test("volume tooltip leaves with the native volume region even while the bar is still expanded", async (t) => {
    const { dom, document, hover, tooltip } = await createVolumeTooltipPage(t);
    const root = document.querySelector(".pzp-pc");
    const slider = document.getElementById("slider");
    for (const y of [467, 482, 494, 509]) {
        hover("slider");
        assert.ok(tooltip());
        slider.dispatchEvent(
            new dom.window.MouseEvent("mouseout", {
                bubbles: true,
                relatedTarget: root,
                clientX: 240,
                clientY: y,
            })
        );
        assert.equal(tooltip(), null, `native region left at y=${y}`);
        root.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true, clientX: 240, clientY: y }));
        root.dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true, clientX: 240, clientY: y }));
        assert.equal(tooltip(), null, "the collapsing bar must not reopen the tooltip");
    }
    for (const id of ["speaker", "thumb"]) {
        hover(id);
        assert.ok(tooltip(), id);
    }
    hover("betterchzzk-audio-compressor");
    assert.equal(tooltip(), null, "the playback percentage is not shown over the compressor");
    slider.dispatchEvent(
        new dom.window.MouseEvent("mouseout", {
            bubbles: true,
            relatedTarget: document.getElementById("volume-area"),
        })
    );
    assert.equal(tooltip(), null, "hide already in the wrapper padding, before native collapse");
    hover("volume-area");
    assert.ok(tooltip(), "horizontal wrapper space remains enabled");
    for (const y of [475, 501, 474, 502]) {
        document
            .getElementById("volume-area")
            .dispatchEvent(new dom.window.MouseEvent("mousemove", { bubbles: true, clientX: 180, clientY: y }));
        assert.equal(Boolean(tooltip()), y >= 475 && y <= 501, `vertical boundary at ${y}`);
    }
    slider.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));
    assert.equal(tooltip(), null);
});

test("volume tooltip stays inside the main video when its slider moves near an edge or into fullscreen", async (t) => {
    const { dom, document, hover, video, tooltip } = await createVolumeTooltipPage(t);
    const slider = document.getElementById("slider");
    slider.getBoundingClientRect = () => ({ left: 100, top: 95, right: 130, bottom: 105, width: 30, height: 10 });
    hover("thumb");
    assert.equal(tooltip().style.left, "140px");
    assert.equal(tooltip().style.top, "110px");
    const original = tooltip();
    slider.getBoundingClientRect = () => ({ left: 870, top: 483, right: 900, bottom: 493, width: 30, height: 10 });
    video.dispatchEvent(new dom.window.Event("volumechange"));
    assert.equal(tooltip(), original);
    assert.equal(tooltip().style.left, "870px");
    assert.equal(tooltip().style.top, "473px");
    const root = document.querySelector(".pzp-pc");
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: root });
    document.dispatchEvent(new dom.window.Event("fullscreenchange"));
    assert.equal(tooltip(), null);
    hover("slider");
    assert.equal(tooltip().parentElement, root);
    assert.equal(tooltip().style.left, "870px");
    assert.equal(tooltip().style.top, "473px");
    slider.remove();
    await waitForAsyncCallbacks();
    assert.equal(tooltip(), null);
});

test("volume tooltip cleans up options, routes, fullscreen and replaced video on VOD", async (t) => {
    const { dom, document, chrome, hover, video, tooltip } = await createVolumeTooltipPage(t, "/video/123");
    hover("slider");
    changePlayerDisplayOptions(chrome, { volumeTooltipEnabled: false });
    await waitForAsyncCallbacks();
    assert.equal(tooltip(), null);
    hover("slider");
    assert.equal(tooltip(), null);
    changePlayerDisplayOptions(chrome, { volumeTooltipEnabled: true });
    await waitForAsyncCallbacks();
    hover("slider");
    assert.ok(tooltip());
    const replacement = document.createElement("video");
    makeVisibleVideo(replacement);
    replacement.volume = 0.67;
    video.replaceWith(replacement);
    await waitForAsyncCallbacks();
    assert.equal(tooltip(), null);
    hover("slider");
    assert.equal(tooltip().textContent, "67%");
    video.volume = 0.1;
    video.dispatchEvent(new dom.window.Event("volumechange"));
    assert.equal(tooltip().textContent, "67%");
    document.dispatchEvent(new dom.window.Event("fullscreenchange"));
    assert.equal(tooltip(), null);
    hover("slider");
    dom.window.history.pushState({}, "", "/lives");
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));
    await waitForAsyncCallbacks();
    assert.equal(tooltip(), null);
    hover("slider");
    assert.equal(tooltip(), null);
});

test("skip amount wheel stays independent from volume when the pill copies volume styling", async (t) => {
    const { dom, document, hover, video, tooltip } = await createVolumeTooltipPage(t);
    const controls = document.createElement("div");
    controls.className = "pzp-pc__bottom-buttons--left";
    controls.getBoundingClientRect = () => ({ left: 120, top: 470, right: 420, bottom: 510, width: 300, height: 40 });
    document.querySelector(".pzp-pc").append(controls);
    controls.append(document.getElementById("volume-area"));
    evalRepoScript(dom, "features", "skipControl.js");
    await waitForAsyncCallbacks();
    const pill = document.getElementById("betterchzzk-skip-pill");
    assert.ok(pill);
    assert.ok(pill.className.includes("volume"), "the native reference's volume class is inherited");
    pill.getBoundingClientRect = controls.getBoundingClientRect;
    const value = pill.querySelector(".bc-value");
    value.id = "skip-value-text";
    video.volume = 0.35;
    hover("skip-value-text");
    assert.equal(tooltip(), null, "skip amount must not show a volume tooltip");
    const before = Number(value.textContent);
    for (const [target, deltaY, expected] of [
        [value, -100, before + 1],
        [pill, 100, before],
    ]) {
        const event = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY });
        target.dispatchEvent(event);
        await waitForAsyncCallbacks();
        assert.equal(event.defaultPrevented, true);
        assert.equal(Number(value.textContent), expected);
        assert.equal(video.volume, 0.35);
    }
    hover("speaker");
    document.getElementById("speaker").dispatchEvent(
        new dom.window.WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            deltaY: -100,
        })
    );
    await waitForAsyncCallbacks();
    assert.ok(Math.abs(video.volume - 0.4) < 1e-9);
    assert.equal(Number(value.textContent), before);
    assert.equal(tooltip().textContent, "40%");
    hover("slider");
    assert.equal(tooltip().textContent, "40%");
});

// Native structure measured on 2026-09-06; hashed suffixes are fixture data only.
const LIVE_DISPLAY_HTML = `<!doctype html><body><main id="layout-body">
    <div class="player_header"><div class="header_info"><div class="_box_1m3jr_140">
    <em id="top-live" class="_live_bhwhs_17 _large_bhwhs_31">LIVE</em></div></div></div>
    <button type="button" id="live-edge">실시간</button><em id="profile-live" class="_live_bhwhs_17">LIVE</em>
    <div class="_row_17x81_8 _status_17x81_19"><div class="_data_17x81_70" id="live-status">
    <strong class="_count_17x81_83">427명 시청 중</strong><span class="_count_17x81_83" id="streaming">06:25:14 스트리밍 중</span>
    </div></div><div id="chat"></div></main></body>`;

async function createLiveDisplayPage(
    t,
    { fetch, options = { hideLiveBadgeEnabled: true, liveStartTimeEnabled: true } } = {}
) {
    const chrome = createFakeChrome({ sync: options });
    const dom = createPageDom(LIVE_DISPLAY_HTML, "https://chzzk.naver.com/live/first-channel", chrome);
    registerPlayerDisplayCleanup(t, dom);
    const calls = [];
    dom.window.fetch = async (url, init) => {
        calls.push({ url, signal: init.signal });
        if (fetch) return fetch(url, init);
        return { ok: true, json: async () => ({ content: { status: "OPEN", openDate: "2026-09-06 06:23:31" } }) };
    };
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "livePlayerDisplay.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    return {
        dom,
        chrome,
        calls,
        document: dom.window.document,
        clock: () => dom.window.document.getElementById("betterchzzk-live-start-time"),
    };
}

test("live display hides only header badge and remounts the KST start clock without refetch", async (t) => {
    const { dom, document, chrome, calls, clock } = await createLiveDisplayPage(t);
    assert.equal(clock().textContent, "시작 06:23");
    assert.equal(document.getElementById("streaming").nextElementSibling, clock());
    assert.equal(dom.window.getComputedStyle(document.getElementById("top-live")).display, "none");
    assert.notEqual(dom.window.getComputedStyle(document.getElementById("profile-live")).display, "none");
    assert.notEqual(dom.window.getComputedStyle(document.getElementById("live-edge")).display, "none");
    const status = document.getElementById("live-status");
    status.replaceWith(status.cloneNode(true));
    document.querySelectorAll("#betterchzzk-live-start-time").forEach((node) => node.remove());
    await waitForAsyncCallbacks();
    assert.equal(clock().textContent, "시작 06:23");
    assert.equal(document.querySelectorAll("#betterchzzk-live-start-time").length, 1);
    for (let index = 0; index < 5; index += 1) {
        document.getElementById("streaming").textContent = `${index}:00:00 스트리밍 중`;
        await waitForAsyncCallbacks();
    }
    assert.equal(calls.length, 1);
    changePlayerDisplayOptions(chrome, { hideLiveBadgeEnabled: false });
    await waitForAsyncCallbacks();
    assert.notEqual(dom.window.getComputedStyle(document.getElementById("top-live")).display, "none");
    assert.ok(clock());
    changePlayerDisplayOptions(chrome, { liveStartTimeEnabled: false });
    await waitForAsyncCallbacks();
    assert.equal(clock(), null);
    assert.equal(document.getElementById("betterchzzk-live-player-display-style"), null);
    document.getElementById("streaming").textContent = "07:00:00 스트리밍 중";
    await waitForAsyncCallbacks();
    assert.equal(clock(), null);
    assert.equal(calls.length, 1);
});

test("live start clock aborts old routes and ignores late responses and disabled requests", async (t) => {
    const pending = [];
    const { dom, document, chrome, calls, clock } = await createLiveDisplayPage(t, {
        fetch: () => new Promise((resolve) => pending.push(resolve)),
    });
    dom.window.history.pushState({}, "", "/live/second-channel");
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));
    await waitForAsyncCallbacks();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].signal.aborted, true);
    const reply = (openDate) => ({ ok: true, json: async () => ({ content: { status: "OPEN", openDate } }) });
    pending[1](reply("2026-09-05T15:05:00Z"));
    await waitForAsyncCallbacks();
    assert.equal(clock().textContent, "시작 00:05");
    pending[0](reply("2026-09-06 12:00:00"));
    await waitForAsyncCallbacks();
    assert.equal(clock().textContent, "시작 00:05");
    dom.window.history.pushState({}, "", "/live/third-channel");
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));
    await waitForAsyncCallbacks();
    assert.equal(clock(), null);
    changePlayerDisplayOptions(chrome, { liveStartTimeEnabled: false });
    await waitForAsyncCallbacks();
    assert.equal(calls[2].signal.aborted, true);
    pending[2](reply("2026-09-06 17:00:00"));
    await waitForAsyncCallbacks();
    assert.equal(clock(), null);
    dom.window.history.pushState({}, "", "/video/123");
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));
    await waitForAsyncCallbacks();
    assert.equal(document.documentElement.hasAttribute("data-bclpd-hide-live"), false);
    assert.equal(calls.length, 3);
});

test("live start clock omits failed, missing, invalid and closed responses without mutation retries", async (t) => {
    for (const content of [
        null,
        { status: "OPEN" },
        { status: "OPEN", openDate: "invalid" },
        { status: "CLOSE", openDate: "2026-09-06 06:23:31" },
    ]) {
        await t.test(JSON.stringify(content), async (subtest) => {
            const { document, calls, clock } = await createLiveDisplayPage(subtest, {
                fetch: async () => {
                    if (!content) throw new Error("network failure");
                    return { ok: true, json: async () => ({ content }) };
                },
            });
            document.getElementById("streaming").textContent = "07:00:00 스트리밍 중";
            await waitForAsyncCallbacks();
            assert.equal(clock(), null);
            assert.equal(calls.length, 1);
        });
    }
});

test("live display defaults make no requests and enabling the clock starts one lookup", async (t) => {
    const { chrome, calls, clock } = await createLiveDisplayPage(t, { options: {} });
    assert.equal(calls.length, 0);
    assert.equal(clock(), null);
    changePlayerDisplayOptions(chrome, { hideLiveBadgeEnabled: true });
    await waitForAsyncCallbacks();
    assert.equal(calls.length, 0);
    changePlayerDisplayOptions(chrome, { liveStartTimeEnabled: true });
    await waitForAsyncCallbacks();
    assert.equal(calls.length, 1);
    assert.equal(clock().textContent, "시작 06:23");
});

test("volume shared helper is registered before consumers in both worlds", () => {
    const manifest = JSON.parse(readRepoFile("manifest.json"));
    for (const entry of manifest.content_scripts) {
        const consumer = entry.world === "MAIN" ? "features/volumeWheelPage.js" : "features/volumeTooltip.js";
        const provider = entry.world === "MAIN" ? "shared/volumeControlsPage.js" : "shared/volumeControls.js";
        assert.ok(entry.js.indexOf(provider) >= 0);
        assert.ok(entry.js.indexOf(provider) < entry.js.indexOf(consumer));
    }
});

test("volume providers survive Chromium's extension-wide script path de-duplication", async (t) => {
    const main = createAudioCompressorFixture(),
        isolated = createAudioCompressorFixture();
    registerPlayerDisplayCleanup(t, main.dom);
    registerPlayerDisplayCleanup(t, isolated.dom);
    isolated.chrome.storage.sync.data.volumeTooltipEnabled = true;
    const worlds = { MAIN: main.dom, ISOLATED: isolated.dom };
    for (const dom of Object.values(worlds)) {
        evalRepoScript(dom, "shared", "settings.js");
        evalContentScripts(dom);
    }
    const seen = new Set();
    // Chromium records executed file paths per extension, before selecting the execution world.
    for (const entry of JSON.parse(readRepoFile("manifest.json")).content_scripts) {
        const dom = worlds[entry.world || "ISOLATED"];
        for (const file of entry.js) {
            if (seen.has(file)) continue;
            seen.add(file);
            if (file === "shared/volumeControls.js" || file === "shared/volumeControlsPage.js") {
                evalRepoScript(dom, ...file.split("/"));
            }
        }
    }
    for (const dom of Object.values(worlds))
        assert.equal(typeof dom.window.BetterChzzkVolumeControls?.getVolumeControlCandidates, "function");
    evalRepoScript(main.dom, "features", "volumeWheelPage.js");
    assert.doesNotThrow(() => evalRepoScript(isolated.dom, "features", "volumeTooltip.js"));
    isolated.dom.window.document.dispatchEvent(new isolated.dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForCondition(() => isolated.document.getElementById("betterchzzk-audio-compressor"));
    const slider = isolated.document.createElement("div");
    slider.className = "pzp-pc__volume-slider";
    slider.getBoundingClientRect = isolated.volumeControl.getBoundingClientRect;
    isolated.volumeControl.append(slider);
    const sliderRect = slider.getBoundingClientRect();
    slider.dispatchEvent(
        new isolated.dom.window.MouseEvent("mouseover", {
            bubbles: true,
            clientY: sliderRect.top + sliderRect.height / 2,
        })
    );
    assert.ok(isolated.document.getElementById("betterchzzk-volume-tooltip"));
});

test("MAIN volume provider stays identical to the canonical shared implementation", () => {
    const body = (source) => source.slice(source.indexOf("(() => {"));
    assert.equal(
        body(readRepoFile("shared", "volumeControlsPage.js")),
        body(readRepoFile("shared", "volumeControls.js"))
    );
});

test("live start clock waits for delayed status without scanning on unrelated chat mutations", async (t) => {
    let resolveFetch;
    const { dom, document, calls, clock } = await createLiveDisplayPage(t, {
        fetch: () =>
            new Promise((resolve) => {
                resolveFetch = resolve;
            }),
    });
    const statusRow = document.getElementById("live-status").parentElement;
    statusRow.remove();
    resolveFetch({ ok: true, json: async () => ({ content: { status: "OPEN", openDate: "2026-09-06 06:23:31" } }) });
    await waitForAsyncCallbacks();
    assert.equal(clock(), null);
    let scans = 0;
    const originalQuery = document.querySelectorAll.bind(document);
    document.querySelectorAll = (selector) => {
        if (selector.includes("_status_")) scans += 1;
        return originalQuery(selector);
    };
    document.getElementById("chat").append(document.createElement("span"));
    await waitForAsyncCallbacks();
    assert.equal(scans, 0);
    document.getElementById("layout-body").append(statusRow);
    await waitForAsyncCallbacks();
    assert.equal(clock().textContent, "시작 06:23");
    const layout = document.getElementById("layout-body");
    const replacement = layout.cloneNode(true);
    replacement.querySelector("#betterchzzk-live-start-time").remove();
    layout.replaceWith(replacement);
    await waitForCondition(() => clock()?.isConnected);
    assert.equal(calls.length, 1);
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    assert.equal(clock(), null);
    dom.window.dispatchEvent(new dom.window.Event("pageshow"));
    await waitForAsyncCallbacks();
    assert.equal(calls.length, 2);
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    assert.equal(calls[1].signal.aborted, true);
    resolveFetch({ ok: true, json: async () => ({ content: { status: "OPEN", openDate: "2026-09-06 06:23:31" } }) });
    await waitForAsyncCallbacks();
    assert.equal(clock(), null);
});

test("multiview separator arrow keys do not seek the main video", async (t) => {
    const chrome = createFakeChrome({ sync: { skipSeconds: 5 } });
    const { dom, document, video } = createLiveTimeShiftGuardDom(chrome);
    t.after(() => closeSkipControlPage(dom, chrome));
    await loadSkipControlPage(dom);
    const baseline = video.currentTime;
    document.body.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
            key: "ArrowLeft",
            code: "ArrowLeft",
            bubbles: true,
            cancelable: true,
        })
    );
    assert.equal(video.currentTime, baseline - 5, "the ordinary skip shortcut must be active");
    const separator = document.createElement("div");
    separator.setAttribute("role", "separator");
    separator.tabIndex = 0;
    document.body.append(separator);
    let resized = false;
    separator.addEventListener("keydown", (event) => {
        resized = true;
        event.preventDefault();
        event.stopPropagation();
    });
    const before = video.currentTime;
    separator.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
            key: "ArrowRight",
            code: "ArrowRight",
            bubbles: true,
            cancelable: true,
        })
    );
    assert.equal(resized, true);
    assert.equal(video.currentTime, before);
});
