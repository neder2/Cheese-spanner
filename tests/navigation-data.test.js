const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repoRoot = path.join(__dirname, "..");

function evaluateFeature(fileName, { url, options = {}, utils = {}, namespaces = {}, hooks }) {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
        url,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const { window } = dom;
    const source = fs.readFileSync(path.join(repoRoot, "features", fileName), "utf8");
    const closeIndex = source.lastIndexOf("})();");
    assert.notEqual(closeIndex, -1, `${fileName} should end with an IIFE`);

    window.BetterChzzkSettings = {
        normalizeOptions: () => ({
            adblockPopupEnabled: true,
            categoryToolsEnabled: true,
            categoryToolsMaxMetadataPages: 12,
            categoryToolsFollowerBadgesEnabled: false,
            categoryToolsLiveElapsedEnabled: false,
            categoryToolsHideGlobalTagSearch: false,
            categoryToolsFollowerFetchMaxPerPass: 6,
            categoryToolsFollowerFetchConcurrency: 2,
            categoryToolsFollowerFetchDelayMs: 0,
            monthlyBroadcastTimeEnabled: true,
            monthlyBroadcastTimeCalendarEnabled: false,
            monthlyBroadcastTimeWatchEnabled: false,
            monthlyBroadcastTimeWindowDays: 30,
            monthlyBroadcastTimeMaxPages: 2,
            monthlyBroadcastTimeMaxCalendarPages: 2,
            videoSearchEnabled: true,
            videoSearchCommentEnabled: false,
            videoSearchMaxPages: 2,
            videoSearchRenderBatchSize: 80,
            videoSearchCommentDelayMs: 0,
            videoSearchCommentMaxVideos: 60,
            videoSearchCommentMaxPagesPerVideo: 1,
            ...options,
        }),
    };
    window.BetterChzzk = {
        ...namespaces,
        utils: {
            addWatchRangeToRangesByDate() {},
            bindFeatureOptions() {},
            collectWatchSessionRanges: () => [],
            createMutationObserverSync: () => ({ disconnect() {} }),
            createThrottledDomSync: () => () => {},
            fetchJson: async () => ({ content: { data: [], last: true } }),
            formatKstDateKey: ({ year, month, day }) =>
                `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
            formatKstMonthKey: ({ year, month }) => `${year}-${String(month).padStart(2, "0")}`,
            formatKstTime: () => "00:00",
            getKstDateKey: () => "2026-07-10",
            getKstParts: () => ({ year: 2026, month: 7, day: 10, hour: 0, minute: 0, second: 0 }),
            injectStyleOnce() {},
            isLastPage: (json, rows, pageSize) => Boolean(json?.content?.last) || rows.length < pageSize,
            isVisible: (element) => {
                const rect = element?.getBoundingClientRect?.();
                return Boolean(rect && rect.width > 0 && rect.height > 0);
            },
            mergeDailySeconds(target, source) {
                for (const [dateKey, seconds] of Object.entries(source || {})) {
                    target[dateKey] = (Number(target[dateKey]) || 0) + (Number(seconds) || 0);
                }
                return target;
            },
            mergeDailySecondsMax(target, source) {
                const result = { ...(target || {}) };
                for (const [dateKey, seconds] of Object.entries(source || {})) {
                    result[dateKey] = Math.max(Number(result[dateKey]) || 0, Number(seconds) || 0);
                }
                return result;
            },
            mergeWatchRanges: (ranges) => ranges || [],
            mutationMatchesSelector: () => false,
            normSpace: (value) =>
                String(value || "")
                    .replace(/\s+/g, " ")
                    .trim(),
            normalizeCompact: (value) =>
                String(value || "")
                    .replace(/\s+/g, "")
                    .toLowerCase(),
            normalizeDailySeconds: (value) => ({ ...(value || {}) }),
            onReady() {},
            pickArray: (content) => (Array.isArray(content?.data) ? content.data : null),
            pickChzzkVideoNo: (video) => String(video?.videoNo || ""),
            pickVideoEndDateText: (video) => video?.endDate || "",
            pickVideoStartDateText: (video) => video?.publishDate || "",
            parseChzzkDate: (value) => {
                if (!value) return null;
                const date = new Date(value);
                return Number.isNaN(date.getTime()) ? null : date;
            },
            setLoadingReason(reasons, on, reason, apply) {
                if (on) reasons.add(reason);
                else reasons.delete(reason);
                apply();
            },
            sleep: async () => {},
            startPageChangeDetection: () => () => {},
            startStorageChangeListener: () => () => {},
            storageGet: async () => ({}),
            storageSet: async () => {},
            sumWatchRanges: () => 0,
            sumWatchRangesByDate: () => ({}),
            touchMapEntry(map, key, value, maxEntries) {
                map.delete(key);
                map.set(key, value);
                while (map.size > maxEntries) map.delete(map.keys().next().value);
            },
            ...utils,
        },
    };

    const instrumented = `${source.slice(0, closeIndex)}globalThis.__navigationDataHooks = ${hooks};\n${source.slice(
        closeIndex
    )}`;
    window.eval(instrumented);
    return { dom, hooks: window.__navigationDataHooks };
}

test("category metadata backs off persistent failures and recovers", async () => {
    let requestCount = 0;
    let retryScheduleCount = 0;
    const { dom, hooks } = evaluateFeature("categoryTools.js", {
        url: "https://chzzk.naver.com/category/game/test/lives",
        utils: {
            createThrottledDomSync: () => () => {
                retryScheduleCount += 1;
            },
            fetchJson: async () => {
                requestCount += 1;
                if (requestCount <= 2) throw new Error("temporary metadata failure");
                return {
                    content: {
                        data: [
                            {
                                liveTitle: "Recovered live",
                                channel: { channelId: "channel-a", channelName: "Alpha" },
                            },
                        ],
                        page: { next: null },
                    },
                };
            },
        },
        hooks: `{
            ensureMetadata,
            getMetadataState: () => ({
                complete: metadataComplete,
                size: metadataMap.size,
                retryAt: metadataRetryAt,
                retryDelayMs: metadataRetryDelayMs
            })
        }`,
    });
    const route = { scope: "category", categoryType: "game", categoryId: "test", tab: "lives" };
    let now = 10000;
    const timers = [];
    dom.window.Date.now = () => now;
    dom.window.setTimeout = (callback, delay) => {
        const timer = { id: timers.length + 1, callback, delay, cleared: false };
        timers.push(timer);
        return timer.id;
    };
    dom.window.clearTimeout = (id) => {
        const timer = timers.find((candidate) => candidate.id === id);
        if (timer) timer.cleared = true;
    };

    try {
        await hooks.ensureMetadata(route);
        assert.equal(hooks.getMetadataState().complete, false);
        assert.equal(hooks.getMetadataState().size, 0);
        assert.equal(hooks.getMetadataState().retryAt, 11000);
        assert.equal(hooks.getMetadataState().retryDelayMs, 2000);
        assert.equal(timers[0].delay, 1000);

        for (let index = 0; index < 5; index++) {
            now += 160;
            await hooks.ensureMetadata(route);
        }
        assert.equal(requestCount, 1, "160ms apply passes must not hammer the failed endpoint");

        now = 11000;
        timers[0].callback();
        assert.equal(retryScheduleCount, 1);
        await hooks.ensureMetadata(route);
        assert.equal(requestCount, 2);
        assert.equal(hooks.getMetadataState().retryAt, 13000);
        assert.equal(hooks.getMetadataState().retryDelayMs, 4000);
        assert.equal(timers[1].delay, 2000);

        for (let index = 0; index < 12; index++) {
            now += 160;
            await hooks.ensureMetadata(route);
        }
        assert.equal(requestCount, 2);

        now = 13000;
        timers[1].callback();
        assert.equal(retryScheduleCount, 2);
        const metadata = await hooks.ensureMetadata(route);
        assert.equal(requestCount, 3);
        assert.equal(metadata.get("channel-a")?.title, "Recovered live");
        assert.equal(hooks.getMetadataState().complete, true);
        assert.equal(hooks.getMetadataState().size, 1);
        assert.equal(hooks.getMetadataState().retryAt, 0);
        assert.equal(hooks.getMetadataState().retryDelayMs, 1000);
    } finally {
        dom.window.close();
    }
});

test("category route parsing tolerates malformed percent encoding", () => {
    const { dom, hooks } = evaluateFeature("categoryTools.js", {
        url: "https://chzzk.naver.com/category/%E0%A4%A/%E0%A4%A/lives",
        hooks: "{ getRoute }",
    });

    try {
        const route = hooks.getRoute();
        assert.equal(route.scope, "category");
        assert.equal(route.categoryType, "%E0%A4%A");
        assert.equal(route.categoryId, "%E0%A4%A");
        assert.equal(route.tab, "lives");
    } finally {
        dom.window.close();
    }
});

test("video search refreshes a completed index after its freshness window", async () => {
    let requestCount = 0;
    const { dom, hooks } = evaluateFeature("videoSearch.js", {
        url: "https://chzzk.naver.com/channel-a/videos",
        utils: {
            fetchJson: async () => {
                requestCount += 1;
                return {
                    content: {
                        data: [{ videoNo: String(requestCount), videoTitle: `Video ${requestCount}` }],
                        last: true,
                    },
                };
            },
        },
        hooks: `{
            buildIndex,
            getIndex: (channelId) => channelIndex.get(channelId),
            setSearchContext: (channelId, query) => {
                currentChannelId = channelId;
                currentQuery = query;
            }
        }`,
    });

    try {
        hooks.setSearchContext("channel-a", "video");
        const first = await hooks.buildIndex("channel-a");
        assert.equal(first.complete, true);
        assert.ok(first.completedAt > 0);

        const cached = await hooks.buildIndex("channel-a");
        assert.strictEqual(cached, first);
        assert.equal(requestCount, 1);

        first.completedAt = 1;
        const refreshed = await hooks.buildIndex("channel-a");
        assert.notStrictEqual(refreshed, first);
        assert.equal(requestCount, 2);
        assert.deepEqual(
            Array.from(refreshed.videos, (video) => video.videoNo),
            ["2"]
        );
    } finally {
        dom.window.close();
    }
});

test("adblock popup restores only scroll styles that it changed", () => {
    let applyOptions = null;
    const { dom, hooks } = evaluateFeature("adblockPopup.js", {
        url: "https://chzzk.naver.com/live/channel-a",
        utils: {
            bindFeatureOptions(callback) {
                applyOptions = callback;
            },
        },
        hooks: "{ unlockBodyScrollIfOnlySuppressedPopups }",
    });
    const { document } = dom.window;
    const popup = document.createElement("div");
    popup.setAttribute("role", "alertdialog");
    popup.setAttribute("data-betterchzzk-suppress-adblock-popup", "1");
    document.body.appendChild(popup);

    try {
        document.body.style.cssText = "overflow: hidden; padding-right: 17px; color: red";
        hooks.unlockBodyScrollIfOnlySuppressedPopups();
        assert.equal(document.body.style.overflow, "");
        assert.equal(document.body.style.paddingRight, "");

        applyOptions({ adblockPopupEnabled: false });
        assert.equal(document.body.style.overflow, "hidden");
        assert.equal(document.body.style.paddingRight, "17px");
        assert.equal(document.body.style.color, "red");

        applyOptions({ adblockPopupEnabled: true });
        popup.setAttribute("data-betterchzzk-suppress-adblock-popup", "1");
        hooks.unlockBodyScrollIfOnlySuppressedPopups();
        document.body.style.overflowY = "auto";
        document.body.style.paddingRight = "23px";

        applyOptions({ adblockPopupEnabled: false });
        assert.equal(document.body.style.overflow, "");
        assert.equal(document.body.style.overflowY, "auto");
        assert.equal(document.body.style.paddingRight, "23px");
        assert.equal(document.body.style.color, "red");
    } finally {
        dom.window.close();
    }
});

test("monthly video detail merge reuses the shared timeline normalization without changing title fallback", () => {
    const normalizedStartMs = Date.parse("2026-07-10T10:20:30+09:00");
    const normalizedEndMs = normalizedStartMs + 42 * 1000;
    const missingEndDetail = {
        duration: 0,
        liveTitle: "  Live title fallback  ",
    };
    const detail = {
        duration: 999,
        endDate: "2026-07-12T00:00:00Z",
        publishDate: "2026-07-11T00:00:00Z",
        title: "  Detail   fallback title  ",
        videoTitle: "",
    };
    let normalizedSource = null;
    const { dom, hooks } = evaluateFeature("monthlyBroadcastTime.js", {
        url: `https://chzzk.naver.com/${"c".repeat(32)}`,
        namespaces: {
            vodTimeline: {
                normalizeVideoDetail(source) {
                    normalizedSource = source;
                    if (source === missingEndDetail) {
                        return {
                            durationSeconds: NaN,
                            endMs: NaN,
                            startMs: NaN,
                            title: "Live title fallback",
                        };
                    }
                    return {
                        durationSeconds: 42,
                        endMs: normalizedEndMs,
                        startMs: normalizedStartMs,
                        title: "normalized title must not replace the existing fallback",
                    };
                },
            },
        },
        hooks: "{ mergeVideoDetail }",
    });
    const video = {
        duration: 1,
        endedAt: new Date(0),
        startedAt: new Date(0),
        startIsExact: false,
        title: "List title",
    };

    try {
        hooks.mergeVideoDetail(video, detail);

        assert.strictEqual(normalizedSource, detail);
        assert.equal(video.duration, 42);
        assert.equal(video.startedAt.getTime(), normalizedStartMs);
        assert.equal(video.endedAt.getTime(), normalizedEndMs);
        assert.equal(video.startIsExact, true);
        assert.equal(video.title, "Detail fallback title");

        const existingStart = new Date("2026-07-09T00:00:00Z");
        const existingEnd = new Date("2026-07-09T01:00:00Z");
        const videoWithoutNormalizedEnd = {
            duration: 3600,
            endedAt: existingEnd,
            startedAt: existingStart,
            startIsExact: false,
            title: "List title",
        };
        hooks.mergeVideoDetail(videoWithoutNormalizedEnd, missingEndDetail);

        assert.equal(videoWithoutNormalizedEnd.duration, 3600);
        assert.strictEqual(videoWithoutNormalizedEnd.startedAt, existingStart);
        assert.strictEqual(videoWithoutNormalizedEnd.endedAt, existingEnd);
        assert.equal(videoWithoutNormalizedEnd.startIsExact, false);
        assert.equal(videoWithoutNormalizedEnd.title, "Live title fallback");
    } finally {
        dom.window.close();
    }
});

test("monthly watch matching uses replay video number instead of live id", () => {
    const channelId = "b".repeat(32);
    const { dom, hooks } = evaluateFeature("monthlyBroadcastTime.js", {
        url: `https://chzzk.naver.com/${channelId}`,
        hooks: `{
            loadWatchHistory: (raw) => { watchHistoryEntries = normalizeWatchHistory(raw); },
            getStartWatchInfo
        }`,
    });

    try {
        hooks.loadWatchHistory({
            entries: [
                {
                    id: "live:A",
                    channelId,
                    liveId: "A",
                    replayVideoNo: "B",
                    watchedSeconds: 180,
                },
            ],
        });

        const liveIdVod = hooks.getStartWatchInfo(channelId, {
            duration: 600,
            startMs: Date.parse("2026-07-10T00:00:00Z"),
            videoNos: ["A"],
        });
        const replayVod = hooks.getStartWatchInfo(channelId, {
            duration: 600,
            startMs: Date.parse("2026-07-11T00:00:00Z"),
            videoNos: ["B"],
        });

        assert.equal(liveIdVod.seconds, 0);
        assert.equal(replayVod.seconds, 180);
        assert.equal(replayVod.percent, 30);
    } finally {
        dom.window.close();
    }
});
