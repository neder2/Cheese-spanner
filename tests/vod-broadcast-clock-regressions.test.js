const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { createFakeChrome, evalRepoScript, waitForCondition } = require("./helpers/extension-page-fixture.js");

const VIDEO_NO = "12345";
const CLOCK_ID = "cheese-spanner-vod-broadcast-clock";
const TOGGLE_ID = "cheese-spanner-vod-title-history-toggle";
const PANEL_ID = "cheese-spanner-vod-title-history-panel";
const RETRY_DELAYS_MS = new Set([5000, 30000, 120000]);

const openDoms = new Set();
test.afterEach(() => {
    for (const dom of openDoms) {
        for (const listener of [...dom.window.chrome.testState.storageChangeListeners]) {
            listener({ vodBroadcastClockEnabled: { oldValue: true, newValue: false } }, "sync");
        }
        dom.window.close();
    }
    openDoms.clear();
});

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function rect(width, height, left, top) {
    return () => ({ width, height, left, top, right: left + width, bottom: top + height });
}

async function createFixture({ detail, watchHistory = [], fetchDetail, retryDelayMs = null, waitForClock = true }) {
    const chrome = createFakeChrome({
        local: { betterChzzkLiveWatchHistory: { entries: watchHistory } },
        sync: { liveWatchHistoryEnabled: true, vodBroadcastClockEnabled: true },
    });
    const dom = new JSDOM(
        [
            "<!doctype html><body><main>",
            '<video id="video"></video>',
            '<div class="pzp-vod-time" id="time">0:00 / 1:00</div>',
            '<div class="_container_17x81_2"><div class="_row_17x81_8">',
            `<h1 id="title">${detail.videoTitle}</h1>`,
            "</div></div></main></body>",
        ].join(""),
        { url: `https://chzzk.naver.com/video/${VIDEO_NO}`, runScripts: "outside-only", pretendToBeVisual: true }
    );
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
        close();
    };
    if (retryDelayMs !== null) {
        const nativeSetTimeout = dom.window.setTimeout.bind(dom.window);
        dom.window.setTimeout = (callback, delay = 0, ...args) =>
            nativeSetTimeout(callback, RETRY_DELAYS_MS.has(delay) ? retryDelayMs : delay, ...args);
    }

    const { document } = dom.window;
    const video = document.getElementById("video");
    video.currentTime = 2;
    video.getBoundingClientRect = rect(640, 360, 0, 0);
    document.getElementById("time").getBoundingClientRect = rect(120, 24, 16, 324);
    document.getElementById("title").getBoundingClientRect = rect(480, 36, 16, 372);

    const requests = [];
    dom.window.fetch = async (url) => {
        const videoNo = decodeURIComponent(String(url).split("/").pop());
        requests.push(videoNo);
        const content = fetchDetail ? await fetchDetail(videoNo, requests.length) : detail;
        return { ok: true, json: async () => ({ content: { videoNo, ...content } }) };
    };

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "shared", "vodTimeline.js");
    evalRepoScript(dom, "shared", "uiTheme.js");
    evalRepoScript(dom, "features", "vodBroadcastClock.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    if (waitForClock) {
        await waitForCondition(() =>
            Boolean(document.getElementById(CLOCK_ID)?.querySelector(".bcbc-time")?.textContent)
        );
    }
    return { chrome, dom, document, requests, video };
}

const SAME_CHANNEL = { channelId: "same-channel", channelName: "같은 채널" };
const A_OPEN_MS = Date.parse("2026-10-25T17:30:00+09:00");
const B_OPEN_MS = Date.parse("2026-10-25T20:00:00+09:00");
const B_DETAIL = {
    ...SAME_CHANNEL,
    videoTitle: "B 방송 새 방제",
    videoType: "REPLAY",
    liveOpenDate: "2026-10-25 20:00:00",
    duration: 3 * 60 * 60,
    publishDate: "2026-10-25 23:05:00",
};

function previousBroadcastRecord(overrides = {}) {
    return {
        id: "live:a",
        ...SAME_CHANNEL,
        liveId: "100",
        title: "A 방송 둘째 방제",
        liveOpenDate: "2026-10-25 17:30:00",
        firstWatchedAt: A_OPEN_MS + 5 * 60 * 1000,
        lastWatchedAt: Date.parse("2026-10-25T19:40:00+09:00"),
        titleHistory: [
            { title: "A 방송 첫 방제", firstSeenAt: A_OPEN_MS, lastSeenAt: A_OPEN_MS + 3600000 },
            { title: "A 방송 둘째 방제", firstSeenAt: A_OPEN_MS + 3600000, lastSeenAt: A_OPEN_MS + 7800000 },
        ],
        ...overrides,
    };
}

test("VOD previous titles never adopt the same channel's earlier broadcast that ended before this replay began", async () => {
    for (const [label, record] of [
        ["with its own live open time", previousBroadcastRecord()],
        ["without a live open time", previousBroadcastRecord({ liveOpenDate: "" })],
    ]) {
        const { document, dom } = await createFixture({ detail: B_DETAIL, watchHistory: [record] });
        await wait(400);
        assert.equal(document.getElementById(TOGGLE_ID), null, `A's record ${label} is not B's title history`);
        assert.doesNotMatch(document.getElementById(PANEL_ID)?.textContent || "", /A 방송/);
        dom.window.close();
        openDoms.delete(dom);
    }
});

test("VOD previous titles still adopt the replay's own broadcast record without a replay video number", async () => {
    // Contrast: same channel and the same live open time is this broadcast even without liveId in the detail.
    const own = previousBroadcastRecord({
        id: "live:b",
        liveId: "200",
        title: "B 방송 새 방제",
        liveOpenDate: "2026-10-25 20:00:00",
        firstWatchedAt: B_OPEN_MS + 60000,
        lastWatchedAt: B_OPEN_MS + 3600000,
        titleHistory: [
            { title: "B 방송 첫 방제", firstSeenAt: B_OPEN_MS, lastSeenAt: B_OPEN_MS + 1800000 },
            { title: "B 방송 새 방제", firstSeenAt: B_OPEN_MS + 1800000, lastSeenAt: B_OPEN_MS + 3600000 },
        ],
    });
    const { document } = await createFixture({ detail: B_DETAIL, watchHistory: [previousBroadcastRecord(), own] });
    await waitForCondition(() => document.getElementById(TOGGLE_ID));
    document.getElementById(TOGGLE_ID).click();
    await waitForCondition(() => document.getElementById(PANEL_ID)?.hidden === false);
    const panelText = document.getElementById(PANEL_ID).textContent;
    assert.match(panelText, /B 방송 첫 방제/);
    assert.doesNotMatch(panelText, /A 방송/);
});

test("VOD previous-title panel stays open and focused while an unrelated watch-history write is re-read", async () => {
    const startMs = Date.parse("2026-10-25T12:00:00+09:00");
    const record = {
        id: "live:own",
        ...SAME_CHANNEL,
        replayVideoNo: VIDEO_NO,
        title: "현재 방제",
        firstWatchedAt: startMs,
        lastWatchedAt: startMs + 3600000,
        titleHistory: [
            { title: "처음 방제", firstSeenAt: startMs, lastSeenAt: startMs + 1000 },
            { title: "현재 방제", firstSeenAt: startMs + 1000, lastSeenAt: startMs + 3600000 },
        ],
    };
    const { chrome, document, dom, video } = await createFixture({
        detail: { ...SAME_CHANNEL, videoTitle: "현재 방제", liveOpenDate: "2026-10-25 12:00:00", duration: 3600 },
        watchHistory: [record],
    });
    await waitForCondition(() => document.getElementById(TOGGLE_ID));
    const button = document.getElementById(TOGGLE_ID);
    button.focus();
    button.click();
    await waitForCondition(() => button.getAttribute("aria-expanded") === "true");
    assert.equal(document.activeElement, button);

    // Another tab's live watch flush: the re-read is slow and unrelated to this replay.
    const local = chrome.storage.local;
    const fastGet = local.get.bind(local);
    let reads = 0;
    local.get = (keys, callback) => {
        reads += 1;
        setTimeout(() => fastGet(keys, callback), 300);
    };
    const otherEntry = {
        id: "live:other",
        channelId: "other",
        title: "다른 방송",
        firstWatchedAt: 1,
        lastWatchedAt: 2,
    };
    local.data.betterChzzkLiveWatchHistory = { entries: [record, otherEntry] };
    for (const listener of [...chrome.testState.storageChangeListeners]) {
        listener({ betterChzzkLiveWatchHistory: { newValue: local.data.betterChzzkLiveWatchHistory } }, "local");
    }
    for (let index = 0; index < 4; index += 1) {
        video.dispatchEvent(new dom.window.Event("timeupdate"));
        await wait(60);
        assert.equal(document.getElementById(TOGGLE_ID), button, "the button node survives the pending re-read");
        assert.equal(button.getAttribute("aria-expanded"), "true");
    }
    await waitForCondition(() => reads === 1);
    await wait(400);
    assert.equal(document.getElementById(TOGGLE_ID), button);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.equal(document.getElementById(PANEL_ID).hidden, false);
    assert.equal(document.activeElement, button, "keyboard focus stays on the toggle");
});

test("VOD previous-title panel still clears when the re-read no longer finds the record", async () => {
    // Contrast: keeping the rows during a re-read must not resurrect a deleted record afterwards.
    const startMs = Date.parse("2026-10-25T12:00:00+09:00");
    const record = {
        id: "live:own",
        ...SAME_CHANNEL,
        replayVideoNo: VIDEO_NO,
        title: "현재 방제",
        firstWatchedAt: startMs,
        lastWatchedAt: startMs + 3600000,
        titleHistory: [
            { title: "처음 방제", firstSeenAt: startMs, lastSeenAt: startMs + 1000 },
            { title: "현재 방제", firstSeenAt: startMs + 1000, lastSeenAt: startMs + 3600000 },
        ],
    };
    const { chrome, document } = await createFixture({
        detail: { ...SAME_CHANNEL, videoTitle: "현재 방제", liveOpenDate: "2026-10-25 12:00:00", duration: 3600 },
        watchHistory: [record],
    });
    await waitForCondition(() => document.getElementById(TOGGLE_ID));
    chrome.storage.local.data.betterChzzkLiveWatchHistory = { entries: [] };
    for (const listener of [...chrome.testState.storageChangeListeners]) {
        listener({ betterChzzkLiveWatchHistory: { newValue: { entries: [] } } }, "local");
    }
    await waitForCondition(() => document.getElementById(TOGGLE_ID) === null);
});

test("VOD broadcast clock retries a failed first detail request on the same replay", async () => {
    const detail = { videoTitle: "재시도 영상", liveOpenDate: "2026-10-25 12:00:00", duration: 3600 };
    const { document, requests } = await createFixture({
        detail,
        retryDelayMs: 20,
        waitForClock: false,
        fetchDetail: async (_videoNo, attempt) => {
            if (attempt === 1) throw new TypeError("Failed to fetch");
            return detail;
        },
    });
    await waitForCondition(() => Boolean(document.getElementById(CLOCK_ID)?.querySelector(".bcbc-time")?.textContent));
    assert.deepEqual(requests, [VIDEO_NO, VIDEO_NO]);
});

test("VOD broadcast clock bounds retries when the detail keeps failing", async () => {
    const { document, requests } = await createFixture({
        detail: { videoTitle: "계속 실패" },
        retryDelayMs: 10,
        waitForClock: false,
        fetchDetail: async () => {
            throw new TypeError("Failed to fetch");
        },
    });
    await waitForCondition(() => requests.length === 4);
    await wait(300);
    assert.equal(requests.length, 4, "three bounded retries after the first failure");
    assert.equal(document.getElementById(CLOCK_ID), null);
});

// R2-125: same channel and a start a few minutes away is a quick restart, not this broadcast.
const RESTART_OPEN_MS = B_OPEN_MS - 15 * 60 * 1000;

function restartRecord(overrides = {}) {
    return previousBroadcastRecord({
        id: "live:restart",
        liveId: "150",
        replayVideoNo: "99999",
        liveOpenDate: "2026-10-25 19:45:00",
        firstWatchedAt: RESTART_OPEN_MS + 60 * 1000,
        lastWatchedAt: B_OPEN_MS - 11 * 60 * 1000,
        titleHistory: [
            { title: "A 방송 첫 방제", firstSeenAt: RESTART_OPEN_MS, lastSeenAt: RESTART_OPEN_MS + 120000 },
            { title: "B 방송 새 방제", firstSeenAt: RESTART_OPEN_MS + 120000, lastSeenAt: B_OPEN_MS - 11 * 60000 },
        ],
        ...overrides,
    });
}

test("VOD previous titles never adopt a same-channel broadcast that restarted 15 minutes earlier", async () => {
    for (const [label, record] of [
        ["linked to another replay", restartRecord()],
        ["without a replay link", restartRecord({ replayVideoNo: "" })],
        [
            "without a replay link, watched until five minutes before",
            restartRecord({ replayVideoNo: "", lastWatchedAt: B_OPEN_MS - 5 * 60000 }),
        ],
        [
            "without a replay link or live open time",
            restartRecord({ replayVideoNo: "", liveOpenDate: "", lastWatchedAt: B_OPEN_MS - 5 * 60000 }),
        ],
    ]) {
        const { document, dom } = await createFixture({ detail: B_DETAIL, watchHistory: [record] });
        await wait(400);
        assert.equal(document.getElementById(TOGGLE_ID), null, `the restarted broadcast's record ${label}`);
        assert.doesNotMatch(document.getElementById(PANEL_ID)?.textContent || "", /A 방송/);
        dom.window.close();
        openDoms.delete(dom);
    }
});

// R2-125 (r3): no overlap grace; a record that ended 54 seconds before this broadcast began did not watch it.
test("VOD previous titles never adopt a same-channel broadcast that ended 54 seconds before this one began", async () => {
    const quickOpenMs = B_OPEN_MS - 223 * 1000;
    const quickRecord = (overrides) =>
        restartRecord({
            id: "live:quick",
            liveId: "",
            replayVideoNo: "",
            liveOpenDate: "2026-10-25 19:56:17",
            firstWatchedAt: quickOpenMs,
            lastWatchedAt: B_OPEN_MS - 54 * 1000,
            titleHistory: [
                { title: "A 방송 첫 방제", firstSeenAt: quickOpenMs, lastSeenAt: quickOpenMs + 60000 },
                { title: "B 방송 새 방제", firstSeenAt: quickOpenMs + 60000, lastSeenAt: B_OPEN_MS - 54 * 1000 },
            ],
            ...overrides,
        });
    for (const [label, record] of [
        ["with its own live open time", quickRecord()],
        ["without a live open time", quickRecord({ liveOpenDate: "" })],
    ]) {
        const { document, dom } = await createFixture({ detail: B_DETAIL, watchHistory: [record] });
        await wait(400);
        assert.equal(document.getElementById(TOGGLE_ID), null, `the quickly restarted broadcast's record ${label}`);
        dom.window.close();
        openDoms.delete(dom);
    }

    // Contrast: this broadcast's own record without a live open time that joined 30 seconds in is adopted.
    const own = previousBroadcastRecord({
        id: "live:b-joined-late",
        liveId: "",
        title: "B 방송 새 방제",
        liveOpenDate: "",
        firstWatchedAt: B_OPEN_MS + 30 * 1000,
        lastWatchedAt: B_OPEN_MS + 20 * 60000,
        titleHistory: [
            { title: "B 방송 첫 방제", firstSeenAt: B_OPEN_MS + 30 * 1000, lastSeenAt: B_OPEN_MS + 9 * 60000 },
            { title: "B 방송 새 방제", firstSeenAt: B_OPEN_MS + 9 * 60000, lastSeenAt: B_OPEN_MS + 20 * 60000 },
        ],
    });
    const { document, dom } = await createFixture({ detail: B_DETAIL, watchHistory: [quickRecord(), own] });
    await waitForCondition(() => document.getElementById(TOGGLE_ID));
    document.getElementById(TOGGLE_ID).click();
    await waitForCondition(() => document.getElementById(PANEL_ID)?.hidden === false);
    const panelText = document.getElementById(PANEL_ID).textContent;
    assert.match(panelText, /B 방송 첫 방제/);
    assert.doesNotMatch(panelText, /A 방송/);
    dom.window.close();
    openDoms.delete(dom);
});

test("VOD previous titles still adopt this broadcast's records that lack a live open time or match its open", async () => {
    // Contrast: an older record without liveOpenDate that watched this broadcast, and one whose live open
    // time is this replay's start, are the same broadcast.
    for (const record of [
        previousBroadcastRecord({
            id: "live:b-old",
            liveId: "",
            title: "B 방송 새 방제",
            liveOpenDate: "",
            firstWatchedAt: B_OPEN_MS + 2 * 60000,
            lastWatchedAt: B_OPEN_MS + 30 * 60000,
            titleHistory: [
                { title: "B 방송 첫 방제", firstSeenAt: B_OPEN_MS + 2 * 60000, lastSeenAt: B_OPEN_MS + 9 * 60000 },
                { title: "B 방송 새 방제", firstSeenAt: B_OPEN_MS + 9 * 60000, lastSeenAt: B_OPEN_MS + 30 * 60000 },
            ],
        }),
        previousBroadcastRecord({
            id: "live:b-linked-elsewhere",
            liveId: "",
            title: "B 방송 새 방제",
            replayVideoNo: "99999",
            liveOpenDate: "2026-10-25 20:00:20",
            firstWatchedAt: B_OPEN_MS + 2 * 60000,
            lastWatchedAt: B_OPEN_MS + 30 * 60000,
            titleHistory: [
                { title: "B 방송 첫 방제", firstSeenAt: B_OPEN_MS + 2 * 60000, lastSeenAt: B_OPEN_MS + 9 * 60000 },
                { title: "B 방송 새 방제", firstSeenAt: B_OPEN_MS + 9 * 60000, lastSeenAt: B_OPEN_MS + 30 * 60000 },
            ],
        }),
    ]) {
        const { document, dom } = await createFixture({ detail: B_DETAIL, watchHistory: [restartRecord(), record] });
        await waitForCondition(() => document.getElementById(TOGGLE_ID), { message: record.id });
        document.getElementById(TOGGLE_ID).click();
        await waitForCondition(() => document.getElementById(PANEL_ID)?.hidden === false);
        const panelText = document.getElementById(PANEL_ID).textContent;
        assert.match(panelText, /B 방송 첫 방제/, record.id);
        assert.doesNotMatch(panelText, /A 방송/, record.id);
        dom.window.close();
        openDoms.delete(dom);
    }
});

test("VOD previous titles adopt a split broadcast's record through the replay's confirmed segment links", async () => {
    const splitOpenMs = Date.parse("2026-10-07T10:37:59+09:00");
    const segmentMs = 17 * 60 * 60 * 1000;
    const finalSegment = {
        ...SAME_CHANNEL,
        videoTitle: "분할 방송 마지막 방제",
        videoType: "REPLAY",
        liveOpenDate: "2026-10-07 10:37:59",
        duration: 2836,
        publishDate: "2026-10-08 04:51:03",
        nextVideo: { videoNo: "12344", duration: 61201 },
    };
    const firstSegment = {
        ...SAME_CHANNEL,
        videoTitle: "분할 방송 마지막 방제",
        videoType: "REPLAY",
        liveOpenDate: "2026-10-07 10:37:59",
        duration: 61201,
        publishDate: "2026-10-08 03:52:57",
        nextVideo: { videoNo: "12000", duration: 3600 },
    };
    const watchedTitles = [
        { title: "분할 방송 첫 방제", firstSeenAt: splitOpenMs + 60000, lastSeenAt: splitOpenMs + segmentMs },
        {
            title: "분할 방송 마지막 방제",
            firstSeenAt: splitOpenMs + segmentMs,
            lastSeenAt: splitOpenMs + segmentMs + 40 * 60000,
        },
    ];
    for (const record of [
        // Linked to the first segment, with a live open time minutes from the replay's start.
        {
            id: "live:split-linked",
            ...SAME_CHANNEL,
            replayVideoNo: "12344",
            liveOpenDate: "2026-10-07 10:41:00",
            firstWatchedAt: splitOpenMs + segmentMs + 5 * 60000,
            lastWatchedAt: splitOpenMs + segmentMs + 40 * 60000,
            titleHistory: watchedTitles,
        },
        // No link or open time; it watched only during this final segment.
        {
            id: "live:split-watched",
            ...SAME_CHANNEL,
            firstWatchedAt: splitOpenMs + segmentMs + 5 * 60000,
            lastWatchedAt: splitOpenMs + segmentMs + 40 * 60000,
            titleHistory: watchedTitles,
        },
    ]) {
        const { document, dom, requests } = await createFixture({
            detail: finalSegment,
            watchHistory: [record],
            fetchDetail: async (videoNo) => (videoNo === "12344" ? firstSegment : finalSegment),
        });
        await waitForCondition(() => document.getElementById(TOGGLE_ID), { message: record.id });
        assert.deepEqual(requests, [VIDEO_NO, "12344"]);
        document.getElementById(TOGGLE_ID).click();
        await waitForCondition(() => document.getElementById(PANEL_ID)?.hidden === false);
        assert.match(document.getElementById(PANEL_ID).textContent, /분할 방송 첫 방제/, record.id);
        dom.window.close();
        openDoms.delete(dom);
    }
});

test("VOD previous-title panel follows its toggle below the header and closes once the toggle scrolls away", async () => {
    const startMs = Date.parse("2026-10-25T12:00:00+09:00");
    const record = {
        id: "live:own",
        ...SAME_CHANNEL,
        replayVideoNo: VIDEO_NO,
        title: "현재 방제",
        firstWatchedAt: startMs,
        lastWatchedAt: startMs + 3600000,
        titleHistory: [
            { title: "처음 방제", firstSeenAt: startMs, lastSeenAt: startMs + 1000 },
            { title: "현재 방제", firstSeenAt: startMs + 1000, lastSeenAt: startMs + 3600000 },
        ],
    };
    const { document, dom } = await createFixture({
        detail: { ...SAME_CHANNEL, videoTitle: "현재 방제", liveOpenDate: "2026-10-25 12:00:00", duration: 3600 },
        watchHistory: [record],
    });
    await waitForCondition(() => document.getElementById(TOGGLE_ID));
    // CHZZK's fixed 60px top bar (#header, z-index 10000).
    const header = document.createElement("div");
    header.id = "header";
    header.getBoundingClientRect = rect(1024, 60, 0, 0);
    document.body.prepend(header);
    // CHZZK's fixed expanded sidebar (aside#sidebar, left 0, 240px, z-index 9999) that the panel sits below.
    const sidebar = document.createElement("div");
    sidebar.id = "sidebar";
    sidebar.getBoundingClientRect = rect(240, 768, 0, 0);
    document.body.prepend(sidebar);
    const wrap = document.getElementById("cheese-spanner-vod-title-history");
    let wrapTop = 200;
    let wrapLeft = 500;
    wrap.getBoundingClientRect = () => rect(24, 24, wrapLeft, wrapTop)();
    const button = document.getElementById(TOGGLE_ID);
    const panel = document.getElementById(PANEL_ID);
    const panelTop = () => panel.style.getPropertyValue("--bcbc-title-history-top");

    button.click();
    await waitForCondition(() => button.getAttribute("aria-expanded") === "true" && panelTop() === "230px");
    assert.equal(panel.hidden, false);

    wrapTop = 120;
    dom.window.dispatchEvent(new dom.window.Event("scroll"));
    await waitForCondition(() => panelTop() === "150px", { message: "the panel did not follow its toggle" });
    assert.equal(panel.hidden, false);

    // The toggle slid under the header: the panel closes instead of staying pinned at the top over the header.
    wrapTop = 20;
    dom.window.dispatchEvent(new dom.window.Event("scroll"));
    await waitForCondition(() => button.getAttribute("aria-expanded") === "false", {
        message: "the panel stayed open after its toggle scrolled under the header",
    });
    assert.equal(panel.hidden, true);
    await wait(300);
    assert.equal(panel.hidden, true, "a later sync does not reopen it");

    // The same holds when the toggle leaves the bottom of the viewport.
    wrapTop = 300;
    button.click();
    await waitForCondition(() => button.getAttribute("aria-expanded") === "true" && panelTop() === "330px");
    wrapTop = 900;
    dom.window.dispatchEvent(new dom.window.Event("resize"));
    await waitForCondition(() => button.getAttribute("aria-expanded") === "false", {
        message: "the panel stayed open after its toggle left the viewport",
    });
    assert.equal(panel.hidden, true);

    // In a narrow window the right-edge clamp would push a wide panel (jsdom 0 rect -> max width) to left 28px
    // under the sidebar; it narrows and starts just right of the sidebar instead.
    Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 800 });
    wrapTop = 200;
    button.click();
    await waitForCondition(() => button.getAttribute("aria-expanded") === "true" && panelTop() === "230px");
    assert.equal(panel.style.getPropertyValue("--bcbc-title-history-left"), "246px", "the panel is under the sidebar");
    assert.equal(panel.style.maxWidth, "542px");
    // A toggle behind the sidebar has left the visible area too.
    wrapLeft = 100;
    dom.window.dispatchEvent(new dom.window.Event("scroll"));
    await waitForCondition(() => button.getAttribute("aria-expanded") === "false", {
        message: "the panel stayed open after its toggle went behind the sidebar",
    });
    assert.equal(panel.hidden, true);

    // With the sidebar moved to the right (panelResize.js right:0) the visible area ends at its left edge: the
    // panel still opens beside its toggle, and only a toggle behind the right sidebar closes it.
    sidebar.getBoundingClientRect = rect(240, 768, 560, 0);
    wrapLeft = 300;
    button.click();
    await waitForCondition(() => button.getAttribute("aria-expanded") === "true" && panelTop() === "230px");
    await wait(300);
    assert.equal(button.getAttribute("aria-expanded"), "true", "a right sidebar does not close the panel at once");
    assert.equal(panel.style.getPropertyValue("--bcbc-title-history-left"), "12px");
    assert.equal(panel.style.maxWidth, "542px");
    wrapLeft = 600;
    dom.window.dispatchEvent(new dom.window.Event("scroll"));
    await waitForCondition(() => button.getAttribute("aria-expanded") === "false", {
        message: "the panel stayed open after its toggle went behind the right sidebar",
    });

    // Below the mini player (1000), the ad mini layers (1001), the header (10000) and PiP/modals (20000).
    const css = document.getElementById("cheese-spanner-vod-broadcast-clock-style").textContent;
    const zIndex = Number(css.match(/#cheese-spanner-vod-title-history-panel\{[^}]*z-index:(\d+);/)?.[1]);
    assert.ok(zIndex < 1000, `panel z-index ${zIndex} paints over CHZZK's floating player`);
});
