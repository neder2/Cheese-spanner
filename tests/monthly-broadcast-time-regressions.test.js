const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { evalFeatureModules, waitForCondition } = require("./helpers/extension-page-fixture.js");

const repoRoot = path.join(__dirname, "..");
const CHANNEL = "c".repeat(32);
const HOUR_MS = 60 * 60 * 1000;
const SPLIT_SECONDS = 17 * 60 * 60;

function kstText(ms) {
    return new Date(ms + 9 * HOUR_MS).toISOString().slice(0, 19).replace("T", " ");
}

function fixture({
    fetchJson,
    clock = { now: Date.parse("2026-07-20T12:00:00+09:00") },
    local = null,
    storageGet = null,
} = {}) {
    const dom = new JSDOM("<!doctype html><body></body>", {
        url: `https://chzzk.naver.com/${CHANNEL}`,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const { window } = dom;
    window.Date.now = () => clock.now;
    window.HTMLCanvasElement.prototype.getContext = () => null;
    const reads = [];
    const storageListeners = new Set();
    if (local) {
        window.chrome = {
            runtime: {},
            storage: {
                local: {
                    get(key, callback) {
                        reads.push(key);
                        if (storageGet) storageGet(key, callback);
                        else setTimeout(() => callback({ [key]: local[key] }), 0);
                    },
                },
            },
        };
    }
    for (const file of ["shared/settings.js", "shared/data.js", "shared/vodTimeline.js"]) {
        window.eval(fs.readFileSync(path.join(repoRoot, file), "utf8"));
    }
    const calls = [];
    Object.assign(window.CheeseSpanner.utils, {
        normSpace: (value) => String(value || "").trim(),
        injectStyleOnce() {},
        bindFeatureOptions() {},
        onReady() {},
        createThrottledDomSync: (callback) => callback,
        createMutationObserverSync: () => ({ disconnect() {} }),
        startPageChangeDetection: () => () => {},
        startStorageChangeListener(listener) {
            storageListeners.add(listener);
            return () => storageListeners.delete(listener);
        },
        isVisible: (element) => element.isConnected,
        fetchJson(url, init) {
            calls.push(url);
            return fetchJson ? fetchJson(url, init) : Promise.resolve({ content: { data: [], last: true } });
        },
    });
    evalFeatureModules(dom, "monthlyBroadcastTime");
    const source = fs.readFileSync(path.join(repoRoot, "features/monthlyBroadcastTime.js"), "utf8");
    const end = source.lastIndexOf("})();");
    window.eval(
        `${source.slice(0, end)}window.hooks = {
            calculateStats, calculateCalendarMonth, applyOptions, loadingTokens, calendarLoadingTokens,
            ensureWatchHistoryLoaded,
            fetchVideoPageCached: repository.fetchVideoPageCached,
            getChannelWatchSeconds: () => getChannelWatchSeconds(${JSON.stringify(CHANNEL)}),
            configure(options) { featureOptions = CheeseSpannerSettings.normalizeOptions(options); },
            setChannel(channelId) { currentChannelId = channelId; },
            onRerender(callback) {
                const render = rerenderCurrentCalendar;
                rerenderCurrentCalendar = (...args) => {
                    callback(getChannelWatchSeconds(${JSON.stringify(CHANNEL)}));
                    return render(...args);
                };
            }
        };${source.slice(end)}`
    );
    window.hooks.setChannel(CHANNEL);
    return { dom, window, hooks: window.hooks, calls, reads, clock, storageListeners };
}

function flush(ms = 0) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// R2-117
test("monthly calendar off→on re-reads watch history that changed while the display was off", async (t) => {
    const local = { betterChzzkLiveWatchHistory: { entries: [] } };
    const f = fixture({ local });
    t.after(() => {
        f.hooks.applyOptions(f.window.CheeseSpannerSettings.normalizeOptions({ monthlyBroadcastTimeEnabled: false }));
        f.dom.window.close();
    });
    const options = (overrides) =>
        f.window.CheeseSpannerSettings.normalizeOptions({
            monthlyBroadcastTimeEnabled: true,
            monthlyBroadcastTimeCalendarEnabled: true,
            monthlyBroadcastTimeWatchEnabled: true,
            ...overrides,
        });

    f.hooks.applyOptions(options());
    await waitForCondition(() => f.reads.length === 1);
    await flush(10);
    assert.equal(f.hooks.getChannelWatchSeconds(), 0);

    f.hooks.applyOptions(options({ monthlyBroadcastTimeCalendarEnabled: false }));
    // Another tab records one hour while this tab ignores storage changes.
    local.betterChzzkLiveWatchHistory = {
        entries: [{ id: "live:1", channelId: CHANNEL, watchedSeconds: 3600, firstWatchedAt: 1, lastWatchedAt: 2 }],
    };
    f.hooks.applyOptions(options());
    await waitForCondition(() => f.hooks.getChannelWatchSeconds() === 3600);
    assert.equal(f.reads.length, 2);

    // Contrast: a calendar toggle while 'my watch' stays off has nothing to refresh.
    f.hooks.applyOptions(options({ monthlyBroadcastTimeWatchEnabled: false }));
    f.hooks.applyOptions(
        options({ monthlyBroadcastTimeWatchEnabled: false, monthlyBroadcastTimeCalendarEnabled: false })
    );
    f.hooks.applyOptions(options({ monthlyBroadcastTimeWatchEnabled: false }));
    await flush(20);
    assert.equal(f.reads.length, 2);
});

// R1-22
test("monthly watch matching keeps a restarted broadcast's time out of the next broadcast", (t) => {
    const f = fixture();
    t.after(() => f.dom.window.close());
    const model = f.window.CheeseSpanner.monthlyBroadcastModel;
    const aStart = Date.parse("2026-07-10T20:00:00+09:00");
    const bStart = Date.parse("2026-07-10T22:05:00+09:00");
    const entries = model.normalizeWatchHistory({
        entries: [
            {
                id: "live:A",
                channelId: CHANNEL,
                liveId: "A",
                replayVideoNo: "100",
                liveOpenDate: kstText(aStart),
                firstWatchedAt: aStart,
                lastWatchedAt: aStart + 2 * HOUR_MS,
                watchedSeconds: 7200,
            },
        ],
    });
    const a = { startMs: aStart, endMs: aStart + 2 * HOUR_MS, duration: 7200, exact: true, videoNos: ["100"] };
    const b = { startMs: bStart, endMs: bStart + HOUR_MS, duration: 3600, exact: true, videoNos: ["101"] };

    assert.equal(model.getStartWatchInfo(entries, CHANNEL, b).seconds, 0, "A's record must not fill B");
    assert.equal(model.getStartWatchInfo(entries, CHANNEL, a).seconds, 7200);

    // The same record without its replay link is still excluded by its own live open time.
    const unlinked = model.normalizeWatchHistory({
        entries: [{ ...entries[0], replayVideoNo: "", liveOpenDate: kstText(aStart), watchedSeconds: 7200 }],
    });
    assert.equal(model.getStartWatchInfo(unlinked, CHANNEL, b).seconds, 0);

    // Contrast: B's own record without a replay link matches by its live open time.
    const own = model.normalizeWatchHistory({
        entries: [
            {
                id: "live:B",
                channelId: CHANNEL,
                liveOpenDate: kstText(bStart),
                firstWatchedAt: bStart + 60000,
                lastWatchedAt: bStart + 30 * 60000,
                watchedSeconds: 1800,
            },
        ],
    });
    assert.equal(model.getStartWatchInfo(own, CHANNEL, b).seconds, 1800);
    // A list-estimated start keeps the wider tolerance for its publish delay.
    const estimated = { ...b, startMs: bStart + 40 * 60000, exact: false, videoNos: [] };
    assert.equal(model.getStartWatchInfo(own, CHANNEL, estimated).seconds, 1800);
});

// R1-25
test("monthly recent total places split VOD segments after the broadcast start at the window boundary", async (t) => {
    const startMs = Date.parse("2026-06-30T19:00:00+09:00");
    const segments = [1, 2, 3].map((index) => ({
        videoNo: 300 + index,
        videoType: "REPLAY",
        duration: SPLIT_SECONDS,
        // The list has no live open time; the publish time follows each segment's real end.
        publishDate: kstText(startMs + index * SPLIT_SECONDS * 1000 + 5 * 60000),
    }));
    const f = fixture({
        clock: { now: Date.parse("2026-07-31T12:00:00+09:00") },
        fetchJson: async (url) => {
            if (url.includes("/service/v2/videos/")) {
                const videoNo = Number(url.split("/").pop());
                const row = segments.find((segment) => segment.videoNo === videoNo);
                return { content: { ...row, liveOpenDate: kstText(startMs) } };
            }
            return { content: { data: [...segments].reverse(), last: true } };
        },
    });
    t.after(() => f.dom.window.close());
    f.hooks.configure({ monthlyBroadcastTimeWindowDays: 30, monthlyBroadcastTimeCalendarEnabled: false });
    const token = Symbol();
    f.hooks.loadingTokens.set(CHANNEL, token);
    const result = await f.hooks.calculateStats(CHANNEL, token);

    // Window 07-01 12:00 ~ now: the first segment ends exactly at the boundary, the other two are inside.
    assert.equal(result.totalSeconds, 2 * SPLIT_SECONDS);
    assert.equal(result.replayCount, 2);
    assert.equal(result.complete, true);
});

// R2-118
test("monthly page cache never mixes a refreshed first page with an older later page", async (t) => {
    const clock = { now: Date.parse("2026-07-20T12:00:00+09:00") };
    const firstDay = Date.parse("2026-07-19T20:00:00+09:00");
    const replays = Array.from({ length: 90 }, (_, index) => ({
        videoNo: 1000 - index,
        videoType: "REPLAY",
        duration: 7200,
        liveOpenDate: kstText(firstDay - index * 24 * HOUR_MS),
        publishDate: kstText(firstDay - index * 24 * HOUR_MS + 2 * HOUR_MS),
    }));
    const list = { rows: replays };
    const f = fixture({
        clock,
        fetchJson: async (url) => {
            const page = Number(new URL(url).searchParams.get("page"));
            const data = list.rows.slice(page * 30, page * 30 + 30);
            return { content: { data, last: page * 30 + 30 >= list.rows.length } };
        },
    });
    t.after(() => f.dom.window.close());
    const calendarMay = async () => {
        const token = Symbol();
        f.hooks.calendarLoadingTokens.set(CHANNEL, token);
        return f.hooks.calculateCalendarMonth(CHANNEL, 2026, 5, token);
    };
    const mayCount = (month) => Object.values(month.startsByDate).reduce((sum, starts) => sum + starts.length, 0);

    // t=0 the average reads pages 0-1; t=6 min a past-month walk adds page 2.
    await f.hooks.fetchVideoPageCached(CHANNEL, 0);
    await f.hooks.fetchVideoPageCached(CHANNEL, 1);
    clock.now += 6 * 60000;
    await f.hooks.fetchVideoPageCached(CHANNEL, 2);
    assert.equal(f.calls.length, 3);

    // Contrast: inside the same snapshot every page is reused.
    const cached = await calendarMay();
    assert.equal(mayCount(cached), 31);
    assert.equal(f.calls.length, 3);

    // t=11 min a new replay shifts the offset list by one before pages 0-1 expire but page 2 does not.
    clock.now += 5 * 60000;
    list.rows = [
        {
            videoNo: 1001,
            videoType: "REPLAY",
            duration: 3600,
            liveOpenDate: kstText(clock.now - HOUR_MS),
            publishDate: kstText(clock.now),
        },
        ...replays,
    ];
    const month = await calendarMay();
    assert.equal(month.partial, false);
    assert.equal(mayCount(month), 31, "the May 21 replay pushed onto page 2 must not disappear");
    assert.ok(month.startsByDate["2026-05-21"]?.length);
});

function delayedWatchHistory(seconds) {
    return {
        entries: seconds
            ? [{ id: "live:1", channelId: CHANNEL, watchedSeconds: seconds, firstWatchedAt: 1, lastWatchedAt: 2 }]
            : [],
    };
}

function delayedReadFixture(t, initialSeconds) {
    const local = { betterChzzkLiveWatchHistory: delayedWatchHistory(initialSeconds) };
    const heldReads = [];
    // Each read captures the stored value when it starts and answers only when the test releases it.
    const f = fixture({
        local,
        storageGet(key, callback) {
            const value = local[key];
            heldReads.push(() => callback({ [key]: value }));
        },
    });
    const rendered = [];
    f.hooks.onRerender((seconds) => rendered.push(seconds));
    t.after(() => {
        f.hooks.applyOptions(f.window.CheeseSpannerSettings.normalizeOptions({ monthlyBroadcastTimeEnabled: false }));
        while (heldReads.length) heldReads.shift()();
        f.dom.window.close();
    });
    const options = (overrides) =>
        f.window.CheeseSpannerSettings.normalizeOptions({
            monthlyBroadcastTimeEnabled: true,
            monthlyBroadcastTimeCalendarEnabled: true,
            monthlyBroadcastTimeWatchEnabled: true,
            ...overrides,
        });
    const release = async () => {
        assert.ok(heldReads.length, "a read is waiting");
        heldReads.shift()();
        await flush(10);
    };
    return { f, local, heldReads, rendered, options, release };
}

// R2-117: a toggle back on while an older read is still running must not be lost to the loading guard.
for (const [label, off] of [
    ["the calendar", { monthlyBroadcastTimeCalendarEnabled: false }],
    ["the whole feature", { monthlyBroadcastTimeEnabled: false }],
]) {
    test(`monthly watch history re-reads after a delayed read when ${label} turns off and on meanwhile`, async (t) => {
        const { f, local, heldReads, rendered, options, release } = delayedReadFixture(t, 3600);

        f.hooks.applyOptions(options());
        assert.equal(heldReads.length, 1);
        f.hooks.applyOptions(options(off));
        // Another tab saves two hours while this tab ignores storage changes.
        local.betterChzzkLiveWatchHistory = delayedWatchHistory(7200);
        f.hooks.applyOptions(options());

        await release();
        await waitForCondition(() => heldReads.length === 1, { message: "the newer state is read again" });
        await release();
        assert.equal(f.hooks.getChannelWatchSeconds(), 7200);
        assert.equal(f.reads.length, 2);
        assert.deepEqual(rendered, [7200], "the stale one-hour read is neither applied nor rendered");
    });
}

test("monthly feature off→on renders the fresh watch history read after a completed earlier read", async (t) => {
    // Contrast without an overlapping read: the install read itself must re-render, since the widget can be
    // drawn from the old entries before it answers.
    const { f, local, heldReads, rendered, options, release } = delayedReadFixture(t, 3600);
    f.hooks.applyOptions(options());
    await release();
    assert.deepEqual(rendered, [3600]);

    f.hooks.applyOptions(options({ monthlyBroadcastTimeEnabled: false }));
    local.betterChzzkLiveWatchHistory = delayedWatchHistory(7200);
    f.hooks.applyOptions(options());
    assert.equal(heldReads.length, 1, "one read covers the install and the display turning on");
    await release();
    assert.equal(f.hooks.getChannelWatchSeconds(), 7200);
    assert.deepEqual(rendered, [3600, 7200]);
    assert.equal(f.reads.length, 2);
});

test("monthly delayed watch history read never restores a record deleted while it was running", async (t) => {
    const { f, local, heldReads, options, release } = delayedReadFixture(t, 3600);
    f.hooks.applyOptions(options());
    assert.equal(heldReads.length, 1);

    // The record is deleted in another tab; the storage change is applied after its debounce.
    local.betterChzzkLiveWatchHistory = delayedWatchHistory(0);
    for (const listener of f.storageListeners) {
        listener({ betterChzzkLiveWatchHistory: { newValue: local.betterChzzkLiveWatchHistory } }, "local");
    }
    await flush(350);
    assert.equal(f.hooks.getChannelWatchSeconds(), 0);

    await release();
    assert.equal(f.hooks.getChannelWatchSeconds(), 0, "the read that began before the deletion is discarded");
    await flush(20);
    assert.equal(heldReads.length, 0);
});

// R2-117 (r3): a storage notification still waiting for its debounce is older than a read that starts later.
function notifyWatchHistory(f, value) {
    for (const listener of f.storageListeners) {
        listener({ betterChzzkLiveWatchHistory: { newValue: value } }, "local");
    }
}

for (const failRead of [false, true]) {
    test(`monthly watch history ignores an older pending storage notification after the calendar turns back on${
        failRead ? " and its read fails" : ""
    }`, async (t) => {
        const { f, local, heldReads, rendered, options, release } = delayedReadFixture(t, 0);
        f.hooks.applyOptions(options());
        await release();
        assert.equal(f.hooks.getChannelWatchSeconds(), 0);

        // Two hours are saved and notified; before the debounce runs the calendar turns off, the record is deleted
        // while changes are ignored, and the calendar turns back on and reads the empty history.
        local.betterChzzkLiveWatchHistory = delayedWatchHistory(7200);
        notifyWatchHistory(f, local.betterChzzkLiveWatchHistory);
        f.hooks.applyOptions(options({ monthlyBroadcastTimeCalendarEnabled: false }));
        local.betterChzzkLiveWatchHistory = delayedWatchHistory(0);
        f.hooks.applyOptions(options());
        assert.equal(heldReads.length, 1);
        if (failRead) {
            f.window.chrome.runtime.lastError = { message: "read failed" };
            heldReads.shift()();
            delete f.window.chrome.runtime.lastError;
        } else {
            await release();
        }
        assert.equal(f.hooks.getChannelWatchSeconds(), 0);

        await flush(400);
        assert.equal(f.hooks.getChannelWatchSeconds(), 0, "the older notification never rolls the display back");
        assert.ok(!rendered.includes(7200));
    });
}

test("monthly watch history keeps a storage notification that arrives after a read started", async (t) => {
    const { f, local, heldReads, options, release } = delayedReadFixture(t, 0);
    f.hooks.applyOptions(options());
    assert.equal(heldReads.length, 1);

    // The read captured the empty history; the newer two hours arrive while it is still running and it answers
    // before their debounce runs.
    local.betterChzzkLiveWatchHistory = delayedWatchHistory(7200);
    notifyWatchHistory(f, local.betterChzzkLiveWatchHistory);
    await release();
    assert.equal(f.hooks.getChannelWatchSeconds(), 0);
    await flush(400);
    assert.equal(f.hooks.getChannelWatchSeconds(), 7200);
    assert.equal(f.reads.length, 1);
});

test("monthly watch history keeps the newest notification when the read that replaced it fails", async (t) => {
    // Contrast: while the display stays on, a pending notification is the newest known state. A read that starts
    // on top of it and then fails must not lose it.
    const { f, local, heldReads, options } = delayedReadFixture(t, 0);
    f.hooks.applyOptions(options());
    f.window.chrome.runtime.lastError = { message: "read failed" };
    heldReads.shift()();
    delete f.window.chrome.runtime.lastError;
    await flush(10);

    local.betterChzzkLiveWatchHistory = delayedWatchHistory(7200);
    notifyWatchHistory(f, local.betterChzzkLiveWatchHistory);
    f.hooks.ensureWatchHistoryLoaded();
    assert.equal(heldReads.length, 1);
    f.window.chrome.runtime.lastError = { message: "read failed" };
    heldReads.shift()();
    delete f.window.chrome.runtime.lastError;
    await flush(400);
    assert.equal(f.hooks.getChannelWatchSeconds(), 7200);
});

// R1-22: an exact start a few minutes after the record's own open time is a restart, not the same broadcast.
test("monthly watch matching keeps a short broadcast's time out of a restart a few minutes later", (t) => {
    const f = fixture();
    t.after(() => f.dom.window.close());
    const model = f.window.CheeseSpanner.monthlyBroadcastModel;
    const aStart = Date.parse("2026-07-10T20:00:00+09:00");
    const bStart = Date.parse("2026-07-10T20:15:00+09:00");
    const a = { startMs: aStart, endMs: aStart + 600000, duration: 600, exact: true, videoNos: ["100"] };
    const b = { startMs: bStart, endMs: bStart + HOUR_MS, duration: 3600, exact: true, videoNos: ["101"] };
    const recordA = {
        id: "live:A",
        channelId: CHANNEL,
        replayVideoNo: "100",
        liveOpenDate: kstText(aStart),
        firstWatchedAt: aStart,
        lastWatchedAt: aStart + 600000,
        watchedSeconds: 600,
    };

    for (const [label, row] of [
        ["linked to its own replay", recordA],
        ["without a replay link", { ...recordA, replayVideoNo: "" }],
        ["without a replay link or live open time", { ...recordA, replayVideoNo: "", liveOpenDate: "" }],
    ]) {
        const entries = model.normalizeWatchHistory({ entries: [row] });
        assert.equal(model.getStartWatchInfo(entries, CHANNEL, b).seconds, 0, `A's record ${label} must not fill B`);
        assert.equal(model.getStartWatchInfo(entries, CHANNEL, a).seconds, 600, `A's record ${label} stays on A`);
    }

    // Contrast: B's own record still matches B even if its live open time differs from the replay's by minutes.
    const own = model.normalizeWatchHistory({
        entries: [
            {
                id: "live:B",
                channelId: CHANNEL,
                liveOpenDate: kstText(bStart + 5 * 60000),
                firstWatchedAt: bStart + 6 * 60000,
                lastWatchedAt: bStart + 40 * 60000,
                watchedSeconds: 2040,
            },
        ],
    });
    assert.equal(model.getStartWatchInfo(own, CHANNEL, b).seconds, 2040);
    assert.equal(model.getStartWatchInfo(own, CHANNEL, a).seconds, 0);
});

// R1-22 (r3): no overlap grace for an exact start; a record that ended seconds before a restart did not watch it.
test("monthly watch matching keeps a record that ended 54 seconds before a restart out of it", (t) => {
    const f = fixture();
    t.after(() => f.dom.window.close());
    const model = f.window.CheeseSpanner.monthlyBroadcastModel;
    const bStart = Date.parse("2026-07-10T20:15:00+09:00");
    const aStart = bStart - 223 * 1000;
    const a = { startMs: aStart, endMs: aStart + 169 * 1000, duration: 169, exact: true, videoNos: ["100"] };
    const b = { startMs: bStart, endMs: bStart + HOUR_MS, duration: 3600, exact: true, videoNos: ["101"] };
    const recordA = {
        id: "live:A",
        channelId: CHANNEL,
        replayVideoNo: "",
        liveOpenDate: kstText(aStart),
        firstWatchedAt: aStart,
        lastWatchedAt: bStart - 54 * 1000,
        watchedSeconds: 169,
    };

    for (const [label, row] of [
        ["without a replay link", recordA],
        ["without a replay link or live open time", { ...recordA, liveOpenDate: "" }],
        ["linked to its own replay", { ...recordA, replayVideoNo: "100" }],
    ]) {
        const entries = model.normalizeWatchHistory({ entries: [row] });
        assert.equal(model.getStartWatchInfo(entries, CHANNEL, b).seconds, 0, `A's record ${label} must not fill B`);
        assert.equal(model.getStartWatchInfo(entries, CHANNEL, a).seconds, 169, `A's record ${label} stays on A`);
    }

    // Contrast: B's own records still match B, with a live open time minutes off or none at all, even when they
    // joined seconds after B started.
    const own = (overrides) =>
        model.normalizeWatchHistory({
            entries: [
                {
                    id: "live:B",
                    channelId: CHANNEL,
                    liveOpenDate: kstText(bStart + 5 * 60000),
                    firstWatchedAt: bStart + 30 * 1000,
                    lastWatchedAt: bStart + 30 * 60000,
                    watchedSeconds: 1770,
                    ...overrides,
                },
            ],
        });
    assert.equal(model.getStartWatchInfo(own(), CHANNEL, b).seconds, 1770);
    assert.equal(model.getStartWatchInfo(own({ liveOpenDate: "" }), CHANNEL, b).seconds, 1770);
    assert.equal(model.getStartWatchInfo(own(), CHANNEL, a).seconds, 0);

    // Contrast: a list-estimated start keeps its publish-delay grace.
    const estimated = { ...b, exact: false, startMs: bStart + 5 * 60000, endMs: bStart + 5 * 60000 + HOUR_MS };
    const late = model.normalizeWatchHistory({
        entries: [
            {
                ...recordA,
                id: "live:B2",
                liveOpenDate: "",
                firstWatchedAt: bStart,
                lastWatchedAt: bStart + 4 * 60000,
                watchedSeconds: 240,
            },
        ],
    });
    assert.equal(model.getStartWatchInfo(late, CHANNEL, estimated).seconds, 240);
});

test("monthly watch matching keeps a split broadcast record linked to a segment the list did not reach", (t) => {
    const f = fixture();
    t.after(() => f.dom.window.close());
    const model = f.window.CheeseSpanner.monthlyBroadcastModel;
    const startMs = Date.parse("2026-07-10T10:00:00+09:00");
    // Only the second and third segments were listed; the record links the unseen first segment.
    const split = {
        startMs,
        endMs: startMs + 2 * SPLIT_SECONDS * 1000,
        duration: 2 * SPLIT_SECONDS,
        exact: true,
        videoNos: ["202", "201"],
    };
    const record = (overrides) =>
        model.normalizeWatchHistory({
            entries: [
                {
                    id: "live:split",
                    channelId: CHANNEL,
                    replayVideoNo: "200",
                    liveOpenDate: kstText(startMs),
                    firstWatchedAt: startMs + 20 * HOUR_MS,
                    lastWatchedAt: startMs + 22 * HOUR_MS,
                    watchedSeconds: 7200,
                    ...overrides,
                },
            ],
        });
    assert.equal(model.getStartWatchInfo(record(), CHANNEL, split).seconds, 7200);
    assert.equal(
        model.getStartWatchInfo(record({ liveOpenDate: kstText(startMs + 30000) }), CHANNEL, split).seconds,
        7200
    );
    assert.equal(model.getStartWatchInfo(record({ replayVideoNo: "201" }), CHANNEL, split).seconds, 7200);
    // A link outside this start with a live open time minutes away is another broadcast.
    assert.equal(
        model.getStartWatchInfo(record({ liveOpenDate: kstText(startMs - 10 * 60000) }), CHANNEL, split).seconds,
        0
    );
});

// R1-25: real split segments publish hours after they end (e.g. 8-9 h), so neither the first listed segment
// nor the publish time places a later segment; its confirmed links do.
const SPLIT_START_MS = Date.parse("2026-06-29T19:00:00+09:00");
const SPLIT_PUBLISH_DELAYS_MS = [16 * 60000, 8 * HOUR_MS, 9 * HOUR_MS];

function splitSegments() {
    return [0, 1, 2].map((index) => ({
        videoNo: 300 + index,
        videoType: "REPLAY",
        duration: SPLIT_SECONDS,
        publishDate: kstText(SPLIT_START_MS + (index + 1) * SPLIT_SECONDS * 1000 + SPLIT_PUBLISH_DELAYS_MS[index]),
    }));
}

const EARLIER_REPLAY = {
    videoNo: 299,
    videoType: "REPLAY",
    duration: 3600,
    publishDate: kstText(Date.parse("2026-06-28T11:10:00+09:00")),
};

function splitDetail(row) {
    const older = row.videoNo === 300 ? EARLIER_REPLAY : { videoNo: row.videoNo - 1, duration: SPLIT_SECONDS };
    const liveOpenDate = row.videoNo === 299 ? "2026-06-28 10:00:00" : kstText(SPLIT_START_MS);
    return {
        ...row,
        liveOpenDate,
        nextVideo: row.videoNo === 299 ? null : { videoNo: older.videoNo, duration: older.duration },
    };
}

function splitStatsFixture(t, { pages, failDetail = () => false }) {
    const rows = [...pages.flat(), EARLIER_REPLAY];
    const f = fixture({
        clock: { now: Date.parse("2026-07-31T12:00:00+09:00") },
        fetchJson: async (url) => {
            if (url.includes("/service/v2/videos/")) {
                const videoNo = Number(url.split("/").pop());
                if (failDetail(videoNo)) throw new Error("detail unavailable");
                return { content: splitDetail(rows.find((row) => row.videoNo === videoNo)) };
            }
            const page = Number(new URL(url).searchParams.get("page"));
            return { content: { data: pages[page] || [], last: page >= pages.length - 1 } };
        },
    });
    t.after(() => f.dom.window.close());
    return f;
}

async function recentStats(f, options) {
    f.hooks.configure({ monthlyBroadcastTimeWindowDays: 30, monthlyBroadcastTimeCalendarEnabled: false, ...options });
    const token = Symbol();
    f.hooks.loadingTokens.set(CHANNEL, token);
    return f.hooks.calculateStats(CHANNEL, token);
}

test("monthly recent total places split segments whose first segment was not hydrated", async (t) => {
    // Window 07-01 12:00 ~ now. The first segment ends 06-30 12:00, outside the month detail range.
    const f = splitStatsFixture(t, { pages: [[...splitSegments()].reverse().concat(EARLIER_REPLAY)] });
    const result = await recentStats(f);

    assert.equal(result.totalSeconds, 10 * 60 * 60, "the last segment runs 07-01 05:00~22:00");
    assert.equal(result.replayCount, 1);
    assert.equal(result.complete, true);
});

test("monthly recent total places a split segment whose earlier segments are beyond the page cap", async (t) => {
    const fillers = Array.from({ length: 29 }, (_, index) => {
        const startMs = Date.parse("2026-07-30T20:00:00+09:00") - index * 24 * HOUR_MS;
        return {
            videoNo: 1000 - index,
            videoType: "REPLAY",
            duration: 3600,
            liveOpenDate: kstText(startMs),
            publishDate: kstText(startMs + HOUR_MS + 600000),
        };
    });
    const [first, second, third] = splitSegments();
    const f = splitStatsFixture(t, {
        pages: [
            [...fillers, third],
            [second, first],
        ],
    });
    const result = await recentStats(f, { monthlyBroadcastTimeMaxPages: 1 });

    assert.equal(result.totalSeconds, 29 * 3600 + 10 * 60 * 60);
    assert.equal(result.replayCount, 30);
    assert.equal(
        f.calls.some((url) => url.includes("page=1")),
        false,
        "the list page cap still holds; only the linked details are read"
    );
});

test("monthly recent total marks a split segment with an unreadable earlier link as incomplete", async (t) => {
    const f = splitStatsFixture(t, {
        pages: [[...splitSegments()].reverse().concat(EARLIER_REPLAY)],
        failDetail: (videoNo) => videoNo === 301,
    });
    const result = await recentStats(f);

    assert.ok(result.totalSeconds < 10 * 60 * 60 + 3600, "an unconfirmed offset is not guessed upward");
    assert.equal(result.complete, false, "the total is shown as a lower bound");
});

// R1-25 (r3): exact totals for a failed middle detail and for a chain longer than the eight-link cap.
function longSplitFixture(
    t,
    {
        startMs,
        nowMs,
        count,
        delaysMs,
        failVideoNo = null,
        failVideoNos = [],
        durations = Array(count).fill(SPLIT_SECONDS),
    }
) {
    const failing = new Set([failVideoNo, ...failVideoNos].filter((videoNo) => videoNo !== null));
    // `count` segments of one broadcast (full 17 hours unless `durations` says otherwise), newest first in the
    // list, without liveOpenDate in rows.
    let endMs = startMs;
    const rows = Array.from({ length: count }, (_, index) => {
        endMs += durations[index] * 1000;
        return {
            videoNo: 300 + index,
            videoType: "REPLAY",
            duration: durations[index],
            publishDate: kstText(endMs + delaysMs[index]),
        };
    });
    const detailRequests = [];
    const f = fixture({
        clock: { now: nowMs },
        fetchJson: async (url) => {
            if (url.includes("/service/v2/videos/")) {
                const videoNo = Number(url.split("/").pop());
                detailRequests.push(videoNo);
                if (failing.has(videoNo)) throw new Error("detail unavailable");
                const row = rows.find((candidate) => candidate.videoNo === videoNo);
                if (!row) return { content: null };
                return {
                    content: {
                        ...row,
                        liveOpenDate: kstText(startMs),
                        nextVideo:
                            videoNo === 300
                                ? { videoNo: 299, duration: 3600 }
                                : { videoNo: videoNo - 1, duration: durations[videoNo - 301] },
                    },
                };
            }
            return { content: { data: [...rows].reverse(), last: true } };
        },
    });
    t.after(() => f.dom.window.close());
    return { f, detailRequests };
}

test("monthly recent total never counts a failed middle segment's publish estimate over the placed last segment", async (t) => {
    // 06-29 19:00 start; segments end 06-30 12:00, 07-01 05:00, 07-01 22:00 and are published 16 minutes,
    // 8 hours and 5 minutes later. The window starts 07-01 12:00, so only ten hours of the last segment count.
    // The middle detail fails: its publish estimate (06-30 20:00~07-01 13:00) would add an hour that overlaps
    // the last segment, which its own detail places at 07-01 05:00.
    const { f } = longSplitFixture(t, {
        startMs: Date.parse("2026-06-29T19:00:00+09:00"),
        nowMs: Date.parse("2026-07-31T12:00:00+09:00"),
        count: 3,
        delaysMs: [16 * 60000, 8 * HOUR_MS, 5 * 60000],
        failVideoNo: 301,
    });
    const result = await recentStats(f);

    assert.equal(result.totalSeconds, 10 * 60 * 60);
    assert.equal(result.replayCount, 1);
    assert.equal(result.complete, false, "the unreadable link still marks the total as a lower bound");
});

test("monthly recent total places a segment beyond the eight-link cap and marks it incomplete", async (t) => {
    // Ten segments from 06-24 10:00; the tenth runs 06-30 19:00~07-01 12:00 and the window starts 07-01 08:00.
    const { f, detailRequests } = longSplitFixture(t, {
        startMs: Date.parse("2026-06-24T10:00:00+09:00"),
        nowMs: Date.parse("2026-07-31T08:00:00+09:00"),
        count: 10,
        delaysMs: Array(10).fill(5 * 60000),
    });
    const result = await recentStats(f);

    assert.equal(result.totalSeconds, 4 * 60 * 60);
    assert.equal(result.replayCount, 1);
    assert.equal(result.complete, false, "eight links do not confirm the chain's end");
    assert.ok(detailRequests.length <= 9, "one hydrated detail plus at most eight links");
});

test("monthly recent total keeps a fully confirmed split chain complete with exact publish delays", async (t) => {
    // Contrast: the same three segments with every detail readable stay exact and complete.
    const { f } = longSplitFixture(t, {
        startMs: Date.parse("2026-06-29T19:00:00+09:00"),
        nowMs: Date.parse("2026-07-31T12:00:00+09:00"),
        count: 3,
        delaysMs: [16 * 60000, 8 * HOUR_MS, 5 * 60000],
    });
    const result = await recentStats(f);

    assert.equal(result.totalSeconds, 10 * 60 * 60);
    assert.equal(result.replayCount, 1);
    assert.equal(result.complete, true);
});

// R1-25 (r4): a full-length segment whose own detail failed has no proven start; its publish estimate is only
// an upper bound on its position. Codex r3 condition: 06-29 19:00 start, four 17-hour segments published 16 minutes,
// 8 hours, 8 hours and 5 minutes after they end, now 07-31 12:00 and a 30-day window from 07-01 12:00. The true
// window time is the third segment's 07-01 12:00~22:00 plus the fourth's 07-01 22:00~07-02 15:00 (97200 s).
const FOUR_SPLIT = {
    startMs: Date.parse("2026-06-29T19:00:00+09:00"),
    nowMs: Date.parse("2026-07-31T12:00:00+09:00"),
    count: 4,
    delaysMs: [16 * 60000, 8 * HOUR_MS, 8 * HOUR_MS, 5 * 60000],
};
const FOUR_SPLIT_TRUE_SECONDS = 27 * 60 * 60;

test("monthly recent total never counts the publish estimates of two consecutive failed split details", async (t) => {
    // The second segment's estimate (06-30 20:00~07-01 13:00) overlaps no detail-placed segment, so moving it
    // in front of one could not remove its false hour inside the window.
    const { f } = longSplitFixture(t, { ...FOUR_SPLIT, failVideoNos: [301, 302] });
    const result = await recentStats(f);

    assert.ok(result.totalSeconds <= FOUR_SPLIT_TRUE_SECONDS, `${result.totalSeconds} is not a lower bound`);
    assert.equal(result.totalSeconds, 17 * 60 * 60, "only the detail-placed fourth segment is proven");
    assert.equal(result.replayCount, 1);
    assert.equal(result.complete, false, "the excluded segments leave the total a lower bound");
});

for (const [label, failVideoNos] of [
    ["third", [302]],
    ["second", [301]],
]) {
    test(`monthly recent total excludes a single failed ${label} split detail and stays a lower bound`, async (t) => {
        const { f } = longSplitFixture(t, { ...FOUR_SPLIT, failVideoNos });
        const result = await recentStats(f);

        assert.ok(result.totalSeconds <= FOUR_SPLIT_TRUE_SECONDS, `${result.totalSeconds} is not a lower bound`);
        assert.equal(result.totalSeconds, 17 * 60 * 60);
        assert.equal(result.replayCount, 1);
        assert.equal(result.complete, false);
    });
}

test("monthly recent total keeps the four-segment chain exact and complete when every detail is read", async (t) => {
    const { f } = longSplitFixture(t, FOUR_SPLIT);
    const result = await recentStats(f);

    assert.equal(result.totalSeconds, FOUR_SPLIT_TRUE_SECONDS);
    assert.equal(result.replayCount, 2);
    assert.equal(result.complete, true);
});

test("monthly window overlap only marks an excluded split estimate that could reach the window", (t) => {
    const f = fixture();
    t.after(() => f.dom.window.close());
    const model = f.window.CheeseSpanner.monthlyBroadcastModel;
    const windowStart = Date.parse("2026-07-01T12:00:00+09:00");
    const now = Date.parse("2026-07-31T12:00:00+09:00");
    const estimate = (publishText, duration, unresolved) => ({
        videoNo: "1",
        type: "REPLAY",
        duration,
        startedAt: null,
        startIsExact: false,
        endedAt: new Date(Date.parse(publishText)),
        ...(unresolved ? { startDetailUnresolved: true } : {}),
    });
    const summarize = (video) => ({ ...model.summarizeWindowOverlap([video], windowStart, now) });

    // Published before the window: the segment ended even earlier, so leaving it out loses nothing.
    assert.deepEqual(summarize(estimate("2026-07-01T11:00:00+09:00", SPLIT_SECONDS, true)), {
        totalSeconds: 0,
        replayCount: 0,
        incomplete: false,
    });
    // Published inside the window: unknown time is left out and the total is marked as a lower bound.
    assert.deepEqual(summarize(estimate("2026-07-10T11:00:00+09:00", SPLIT_SECONDS, true)), {
        totalSeconds: 0,
        replayCount: 0,
        incomplete: true,
    });
    // r5: a shorter replay whose detail failed has no proven start either (a short last split segment published
    // hours later can lie wholly before the window), so the length no longer keeps its estimate in the total.
    assert.deepEqual(summarize(estimate("2026-07-10T11:00:00+09:00", 7200, true)), {
        totalSeconds: 0,
        replayCount: 0,
        incomplete: true,
    });
    // Contrast: the same two hours with a detail-read start still count exactly.
    assert.deepEqual(
        summarize({
            ...estimate("2026-07-10T11:00:00+09:00", 7200, false),
            startedAt: new Date(Date.parse("2026-07-10T09:00:00+09:00")),
            startIsExact: true,
        }),
        { totalSeconds: 7200, replayCount: 1, incomplete: false }
    );
    // Contrast: a never-requested estimate keeps the old estimate; the repository requests every replay that can
    // reach the window, so none is left in the recent total.
    assert.deepEqual(summarize(estimate("2026-07-10T11:00:00+09:00", SPLIT_SECONDS, false)), {
        totalSeconds: SPLIT_SECONDS,
        replayCount: 1,
        incomplete: false,
    });
});

// R1-25 (r5): the recent window can start in the previous month. Codex r4 condition: now 07-10 12:00, a 30-day
// window from 06-10 12:00, four 17-hour segments from 06-09 19:00 published 8, 8, 8 hours and 5 minutes after
// they end. The first segment ends exactly at the window start, so the true total is the other three (183600 s).
const LAST_MONTH_SPLIT = {
    startMs: Date.parse("2026-06-09T19:00:00+09:00"),
    nowMs: Date.parse("2026-07-10T12:00:00+09:00"),
    count: 4,
    delaysMs: [8 * HOUR_MS, 8 * HOUR_MS, 8 * HOUR_MS, 5 * 60000],
};
const LAST_MONTH_SPLIT_TRUE_SECONDS = 3 * SPLIT_SECONDS;

test("monthly recent total reads the details of window replays in the previous month", async (t) => {
    const { f, detailRequests } = longSplitFixture(t, LAST_MONTH_SPLIT);
    const result = await recentStats(f);

    // Without details the publish estimates (8 hours late) moved the first segment into the window: 212400 s.
    assert.equal(result.totalSeconds, LAST_MONTH_SPLIT_TRUE_SECONDS);
    assert.equal(result.replayCount, 3);
    assert.equal(result.complete, true);
    for (const videoNo of [300, 301, 302, 303]) {
        assert.ok(detailRequests.includes(videoNo), `segment ${videoNo} needs its own detail start`);
    }
});

test("monthly recent total leaves a failed previous-month detail out as a lower bound", async (t) => {
    const { f } = longSplitFixture(t, { ...LAST_MONTH_SPLIT, failVideoNos: [300] });
    const result = await recentStats(f);

    assert.ok(result.totalSeconds <= LAST_MONTH_SPLIT_TRUE_SECONDS, `${result.totalSeconds} is not a lower bound`);
    assert.equal(result.complete, false);
});

test("monthly calendar month still reads only details that can reach the month", async (t) => {
    // Contrast: the calendar walk has no recent window, so a June-only segment's detail is not requested for July.
    const { f, detailRequests } = longSplitFixture(t, LAST_MONTH_SPLIT);
    const token = Symbol();
    f.hooks.calendarLoadingTokens.set(CHANNEL, token);
    await f.hooks.calculateCalendarMonth(CHANNEL, 2026, 7, token);

    assert.deepEqual(detailRequests, []);
});

// R1-25 (r5): a short last split segment published hours after it ends. 06-30 09:00 start; the 17-hour first
// segment ends 07-01 02:00 and the 2-hour last one 07-01 04:00, published 10 hours later at 07-01 14:00. The
// window starts 07-01 12:00, so the true window time is zero; the publish estimate (12:00~14:00) is not.
const SHORT_LAST_SPLIT = {
    startMs: Date.parse("2026-06-30T09:00:00+09:00"),
    nowMs: Date.parse("2026-07-31T12:00:00+09:00"),
    count: 2,
    durations: [SPLIT_SECONDS, 2 * 60 * 60],
    delaysMs: [16 * 60000, 10 * HOUR_MS],
};

test("monthly recent total never counts the publish estimate of a short last split whose detail failed", async (t) => {
    const { f } = longSplitFixture(t, { ...SHORT_LAST_SPLIT, failVideoNos: [301] });
    const result = await recentStats(f);

    assert.equal(result.totalSeconds, 0, "the 2-hour estimate inside the window is not proven");
    assert.equal(result.replayCount, 0);
    assert.equal(result.complete, false, "the left-out segment leaves the total a lower bound");
});

test("monthly recent total places a short last split exactly when its detail is read", async (t) => {
    // Contrast: the same segments with readable details are placed before the window and the empty total is exact.
    const { f } = longSplitFixture(t, SHORT_LAST_SPLIT);
    const result = await recentStats(f);

    assert.equal(result.totalSeconds, 0);
    assert.equal(result.replayCount, 0);
    assert.equal(result.complete, true);
});
