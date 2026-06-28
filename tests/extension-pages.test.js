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
                removeListener(listener) {
                    const index = storageChangeListeners.indexOf(listener);
                    if (index >= 0) storageChangeListeners.splice(index, 1);
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

function evalContentScripts(dom) {
    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "content.js");
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

function waitForTitleTooltipDelay() {
    return new Promise((resolve) => setTimeout(resolve, 190));
}

async function waitForCondition(predicate, { timeoutMs = 1000, intervalMs = 20 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    assert.fail("Timed out waiting for condition");
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

function evalVolumeWheelScripts(dom) {
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

test("createMutationObserverSync disconnects a pending deferred-target observer", async () => {
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

    observer.disconnect();
    target = document.createElement("div");
    document.body.appendChild(target);
    target.appendChild(document.createElement("span"));
    await waitForAsyncCallbacks();

    assert.deepEqual(events, []);
});

test("createMutationObserverSync disconnectAll prevents deferred callbacks after teardown", async () => {
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

    assert.equal(typeof observer.disconnectAll, "function");
    observer.disconnectAll();
    target = document.createElement("div");
    document.body.appendChild(target);
    target.appendChild(document.createElement("span"));
    await waitForAsyncCallbacks();

    assert.deepEqual(events, []);
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

test("shared fetchJson keeps credentialed JSON requests and HTTP errors", async () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    const calls = [];
    dom.window.fetch = async (url, init) => {
        calls.push({ init, url });
        if (calls.length === 1) {
            return {
                ok: true,
                json: async () => ({ done: true }),
            };
        }
        return {
            ok: false,
            status: 503,
            json: async () => ({}),
        };
    };

    evalRepoScript(dom, "shared", "data.js");

    const result = await dom.window.BetterChzzk.utils.fetchJson("/ok", {
        headers: { Accept: "application/json" },
        timeoutMs: 50,
    });

    assert.deepEqual(result, { done: true });
    assert.equal(calls[0].url, "/ok");
    assert.equal(calls[0].init.credentials, "include");
    assert.equal(calls[0].init.headers.Accept, "application/json");
    assert.ok(calls[0].init.signal instanceof dom.window.AbortSignal);
    await assert.rejects(() => dom.window.BetterChzzk.utils.fetchJson("/fail", { timeoutMs: 50 }), /HTTP 503/);
});

test("shared storage helpers wrap chrome storage areas", async () => {
    const chrome = createFakeChrome({ local: { oldKey: "old value" } });
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", chrome);
    evalRepoScript(dom, "shared", "data.js");

    const { startStorageChangeListener, storageGet, storageRemove, storageSet } = dom.window.BetterChzzk.utils;

    assert.deepEqual(await storageGet(chrome.storage.local, "oldKey"), { oldKey: "old value" });

    await storageSet(chrome.storage.local, { nextKey: "next value" });
    assert.deepEqual(await storageGet(chrome.storage.local, "nextKey"), { nextKey: "next value" });

    await storageRemove(chrome.storage.local, "oldKey");
    assert.equal(Object.keys(await storageGet(chrome.storage.local, "oldKey")).length, 0);

    assert.equal(Object.keys(await storageGet(null, "missing")).length, 0);
    await storageSet(null, { ignored: true });
    await storageRemove(null, "ignored");

    const listener = () => {};
    const removeListener = startStorageChangeListener(listener);
    assert.equal(chrome.testState.storageChangeListeners.includes(listener), true);
    removeListener();
    assert.equal(chrome.testState.storageChangeListeners.includes(listener), false);
    assert.equal(startStorageChangeListener(null), null);
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

    await assert.rejects(() => storageGet(failingArea, "key"), (error) => error.message === "read failed");
    await assert.rejects(() => storageSet(failingArea, { key: "value" }), (error) => error.message === "write failed");
    await assert.rejects(() => storageRemove(failingArea, "key"), (error) => error.message === "remove failed");
});

test("shared map cache helpers trim oldest entries and refresh touched keys", () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalRepoScript(dom, "shared", "data.js");

    const { touchMapEntry } = dom.window.BetterChzzk.utils;
    const map = new Map([["a", 1], ["b", 2], ["c", 3]]);

    touchMapEntry(map, "c", 3, 2);
    assert.equal(JSON.stringify([...map.entries()]), JSON.stringify([["b", 2], ["c", 3]]));

    assert.equal(touchMapEntry(map, "b", 4, 2), 4);
    assert.equal(JSON.stringify([...map.entries()]), JSON.stringify([["c", 3], ["b", 4]]));

    touchMapEntry(map, "d", 5, 2);
    assert.equal(JSON.stringify([...map.entries()]), JSON.stringify([["b", 4], ["d", 5]]));
});

test("shared string and page helpers are reused by content utilities", () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalContentScripts(dom);

    const {
        compactSpaces,
        getLiveChannelIdFromPath,
        getVodVideoNoFromPath,
        isLastPage,
        isLiveRoute,
        isPlaybackRoute,
        isVodRoute,
        normSpace,
        normalizeCompact,
    } = dom.window.BetterChzzk.utils;

    assert.equal(compactSpaces(" a\n  b\tc "), "a b c");
    assert.equal(normSpace(" a\n  b\tc "), "a b c");
    assert.equal(normalizeCompact(" A\n  b\tC "), "abc");
    assert.equal(isLastPage({ content: { totalPages: 3, page: { number: 2 } } }, [], 30), true);
    assert.equal(isLastPage({ content: { totalPages: 3, page: { number: 1 } } }, [], 30), false);
    assert.equal(isLastPage({ content: { last: true } }, [], 30), true);
    assert.equal(isLastPage({}, [1, 2], 3), true);
    assert.equal(isLastPage({}, [1, 2, 3], 3), false);
    assert.equal(isPlaybackRoute("/live/abc"), true);
    assert.equal(isPlaybackRoute("/video/123"), true);
    assert.equal(isPlaybackRoute("/category/foo"), false);
    assert.equal(isLiveRoute("/live/abc"), true);
    assert.equal(isLiveRoute("/video/123"), false);
    assert.equal(getLiveChannelIdFromPath("/live/abc"), "abc");
    assert.equal(getLiveChannelIdFromPath("/live/%ED%85%8C%EC%8A%A4%ED%8A%B8"), "\uD14C\uC2A4\uD2B8");
    assert.equal(getLiveChannelIdFromPath("/live"), "");
    assert.equal(isVodRoute("/video"), true);
    assert.equal(isVodRoute("/video/123"), true);
    assert.equal(getVodVideoNoFromPath("/video/123"), "123");
    assert.equal(getVodVideoNoFromPath("/video/abc"), "abc");
    assert.equal(getVodVideoNoFromPath("/video"), "");
});

test("shared CHZZK video field pickers keep API fallback order", () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalRepoScript(dom, "shared", "data.js");

    const { pickChzzkVideoNo, pickVideoEndDateText, pickVideoStartDateText } = dom.window.BetterChzzk.utils;

    assert.equal(pickChzzkVideoNo({ videoId: 123, id: 456 }), "123");
    assert.equal(pickChzzkVideoNo({ id: "  789  " }), "789");
    assert.equal(pickChzzkVideoNo({}), "");
    assert.equal(pickVideoStartDateText({ live: { openDate: "2026-06-22 10:00:00" } }), "2026-06-22 10:00:00");
    assert.equal(
        pickVideoStartDateText({ openDate: "open", liveOpenDate: "live", broadcastOpenDate: "broadcast" }),
        "live"
    );
    assert.equal(pickVideoEndDateText({ createdDate: "created", publishDate: "published" }), "published");
    assert.equal(pickVideoEndDateText({ publishDateAt: "at", publishDate: "published" }), "at");
});

test("shared KST helpers keep date keys and day boundaries consistent", () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalRepoScript(dom, "shared", "data.js");

    const {
        formatKstDateKey,
        formatKstDateTime,
        formatKstMonthKey,
        formatKstTime,
        getKstDateKey,
        getKstDayStartMs,
        getKstMonthStartMs,
        getKstParts,
        getNextKstDayStartMs,
        isSameKstDate,
    } = dom.window.BetterChzzk.utils;
    const ms = Date.parse("2026-06-21T15:30:05Z");

    assert.equal(JSON.stringify(getKstParts(ms)), JSON.stringify({
        year: 2026,
        month: 6,
        day: 22,
        weekday: 1,
        hours: 0,
        minutes: 30,
        seconds: 5,
    }));
    assert.equal(formatKstDateKey(getKstParts(ms)), "2026-06-22");
    assert.equal(getKstDateKey(ms), "2026-06-22");
    assert.equal(formatKstMonthKey(2026, 6), "2026-06");
    assert.equal(getKstDayStartMs("2026-06-22"), Date.parse("2026-06-21T15:00:00Z"));
    assert.equal(getKstMonthStartMs(2026, 6), Date.parse("2026-05-31T15:00:00Z"));
    assert.equal(getNextKstDayStartMs(ms), Date.parse("2026-06-22T15:00:00Z"));
    assert.equal(isSameKstDate(ms, Date.parse("2026-06-22T14:59:59Z")), true);
    assert.equal(isSameKstDate(ms, Date.parse("2026-06-22T15:00:00Z")), false);
    assert.equal(formatKstDateTime(ms, { seconds: true }), "2026.06.22 00:30:05");
    assert.equal(formatKstTime(ms), "00:30");
    assert.equal(Number.isNaN(getKstDayStartMs("bad")), true);
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

test("shared watch-session helpers derive fallback ranges and daily totals", () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalRepoScript(dom, "shared", "data.js");

    const {
        addWatchRangeToRangesByDate,
        collectWatchSessionRanges,
        getWatchSessionRanges,
        mergeDailySeconds,
        normalizeDailySeconds,
        sumWatchRangesByDate,
    } = dom.window.BetterChzzk.utils;
    const dayStart = Date.parse("2026-06-21T15:00:00Z");

    assert.equal(JSON.stringify(normalizeDailySeconds({ a: "10.5", b: -2, c: "bad", d: 0 })), JSON.stringify({ a: 10.5 }));
    assert.equal(JSON.stringify(mergeDailySeconds({ a: 2 }, { a: "1.5", b: 3 })), JSON.stringify({ a: 3.5, b: 3 }));
    assert.equal(JSON.stringify(mergeDailySeconds({}, { a: 1.6, b: 0.4 }, { round: true })), JSON.stringify({ a: 2 }));

    const direct = getWatchSessionRanges({
        watchedSeconds: 300,
        dailySeconds: { "2026-06-22": 120 },
        watchedRanges: [{ startAt: dayStart + 1000, endAt: dayStart + 6000 }],
    });
    assert.equal(JSON.stringify(direct), JSON.stringify([{ startAt: dayStart + 1000, endAt: dayStart + 6000 }]));

    const fallback = getWatchSessionRanges({
        enteredAt: dayStart + 60000,
        watchedSeconds: 120,
        dailySeconds: { "2026-06-22": 120 },
    });
    assert.equal(JSON.stringify(fallback), JSON.stringify([{ startAt: dayStart + 60000, endAt: dayStart + 180000 }]));

    const clipped = collectWatchSessionRanges([{ watchedRanges: [{ startAt: dayStart, endAt: dayStart + 10000 }] }], {
        scopeStartMs: dayStart + 3000,
        scopeEndMs: dayStart + 8000,
    });
    assert.equal(JSON.stringify(clipped), JSON.stringify([{ startAt: dayStart + 3000, endAt: dayStart + 8000 }]));

    const rangesByDate = {};
    addWatchRangeToRangesByDate(rangesByDate, {
        startAt: dayStart + 24 * 60 * 60 * 1000 - 30000,
        endAt: dayStart + 24 * 60 * 60 * 1000 + 90000,
    });
    assert.equal(JSON.stringify(sumWatchRangesByDate(rangesByDate)), JSON.stringify({
        "2026-06-22": 30,
        "2026-06-23": 90,
    }));
});

test("shared title-history helpers normalize channel-prefixed titles", () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalRepoScript(dom, "shared", "data.js");

    const {
        addTitleHistory,
        cleanEntryTitle,
        normalizeForMatch,
        normalizeTitleHistory,
        parseChzzkDate,
        pickString,
    } = dom.window.BetterChzzk.utils;
    const channelName = "\uCC44\uB110";

    assert.equal(pickString("", null, "  value  "), "value");
    assert.equal(cleanEntryTitle("\uCC44\uB110 \u00B7 \uCCAB \uC81C\uBAA9 - CHZZK", channelName), "\uCCAB \uC81C\uBAA9");
    assert.equal(normalizeForMatch("\uCCAB \uC81C\uBAA9! 123"), "\uCCAB\uC81C\uBAA9123");
    assert.equal(parseChzzkDate("2026-06-22 10:30:00").toISOString(), "2026-06-22T01:30:00.000Z");
    assert.equal(parseChzzkDate(1719000000).getTime(), 1719000000000);
    assert.equal(parseChzzkDate(" "), null);

    const rows = normalizeTitleHistory([
        { title: "\uCC44\uB110 \u00B7 \uCCAB \uC81C\uBAA9", firstSeenAt: 20, lastSeenAt: 30 },
        { title: "\uCC44\uB110 - \uCCAB \uC81C\uBAA9", firstSeenAt: 10, lastSeenAt: 40 },
        { title: "\uC81C\uBAA9 \uC5C6\uB294 \uB77C\uC774\uBE0C", firstSeenAt: 1, lastSeenAt: 2 },
    ], channelName);

    assert.equal(JSON.stringify(rows), JSON.stringify([{ title: "\uCCAB \uC81C\uBAA9", firstSeenAt: 10, lastSeenAt: 40 }]));

    const target = { channelName, titleHistory: rows };
    addTitleHistory(target, "\uCC44\uB110: \uB2E4\uC74C \uC81C\uBAA9", 50, 60);

    assert.equal(
        JSON.stringify(target.titleHistory.map((row) => row.title)),
        JSON.stringify(["\uCCAB \uC81C\uBAA9", "\uB2E4\uC74C \uC81C\uBAA9"])
    );
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

test("adblock popup keeps suppressing the legacy chzzk popup classes", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div class="popup_dimmed__zs78t" id="dimmed">',
            '<div class="popup_container__Aqx-3" id="popup">',
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
    const popup = document.getElementById("popup");
    document.body.style.overflow = "hidden";
    document.body.style.paddingRight = "15px";
    makeVisibleElement(dimmed, 1000, 800);
    makeVisibleElement(popup);

    await loadAdblockPopupPage(dom);
    await waitForAsyncCallbacks();

    assert.equal(getAdblockSuppressAttr(popup), "1");
    assert.equal(getAdblockSuppressAttr(dimmed), "1");
    assert.match(document.getElementById("betterchzzk-adblock-popup-style").textContent, /\[data-betterchzzk-suppress-adblock-popup="1"\]/);
    assert.equal(document.body.style.overflow, "");
    assert.equal(document.body.style.paddingRight, "");
});

test("adblock popup keeps suppressing legacy popup classes after css module hashes change", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div class="popup_dimmed__nextHash" id="dimmed">',
            '<div class="popup_container__nextHash" id="popup">',
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
    const popup = document.getElementById("popup");
    makeVisibleElement(dimmed, 1000, 800);
    makeVisibleElement(popup);

    await loadAdblockPopupPage(dom);

    assert.equal(getAdblockSuppressAttr(popup), "1");
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

test("options page renders defaults and dependency-disabled controls without extension storage", () => {
    const dom = createDom("options.html", "options.html");

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document, BetterChzzkSettings } = dom.window;
    const optionInputs = Array.from(document.querySelectorAll("[data-option]"));
    const notice = document.getElementById("notice");

    assert.equal(optionInputs.length, BetterChzzkSettings.OPTION_KEYS.length);
    assert.equal(queryOption(document, "skipSeconds").value, String(BetterChzzkSettings.DEFAULT_OPTIONS.skipSeconds));
    assert.equal(queryOption(document, "vodBroadcastClockEnabled").checked, false);
    assert.equal(document.getElementById("save"), null, "자동 저장 전환 후 저장 버튼은 없어야 한다");
    assert.equal(notice.dataset.state, "saved");
    assert.match(notice.textContent, /기능 \d+개/);

    const skipControl = queryOption(document, "skipControlEnabled");
    const skipKeyboard = queryOption(document, "skipKeyboardEnabled");
    const skipSeconds = queryOption(document, "skipSeconds");

    skipControl.checked = false;
    dispatch(dom, skipControl, "change");

    assert.equal(skipKeyboard.disabled, true);
    assert.equal(skipSeconds.disabled, true);
    assert.equal(skipKeyboard.closest("[data-depends-on]").classList.contains("is-disabled"), true);
});

test("options player controls merge playback defaults", () => {
    const dom = createDom("options.html", "options.html");

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document } = dom.window;
    const tabLabels = Array.from(document.querySelectorAll(".tab"), (tab) => tab.textContent.trim());
    const sectionLabels = Array.from(document.querySelectorAll(".settings-card h2"), (heading) =>
        heading.textContent.trim()
    );
    const section = queryOption(document, "skipControlEnabled").closest(".settings-card");
    const optionOrder = Array.from(section.querySelectorAll("[data-option]")).map((input) => input.dataset.option);
    const detailOrder = Array.from(section.querySelectorAll("summary")).map((summary) => summary.textContent.trim());

    assert.deepEqual(tabLabels, ["플레이어", "시청 기록", "팝업", "방송 시간", "검색", "탐색"]);
    assert.deepEqual(sectionLabels, [
        "플레이어",
        "시청 기록",
        "광고 차단 안내 팝업",
        "채널 방송 시간",
        "다시보기 검색",
        "방송 목록 필터",
    ]);
    assert.equal(section.querySelector("h2").textContent.trim(), "플레이어");
    assert.deepEqual(detailOrder, ["라이브 위치 유지 설정", "스킵 수치 설정", "볼륨 휠 설정"]);
    assert.deepEqual(optionOrder, [
        "autoQualityEnabled",
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
        "volumeWheelEnabled",
        "volumeWheelStep",
        "volumeTooltipEnabled",
        "vodBroadcastClockEnabled",
        "shortcutRescueEnabled",
    ]);
});

test("options places following controls with exploration controls", () => {
    const dom = createDom("options.html", "options.html");

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document } = dom.window;
    const previewSection = queryOption(document, "followingPreviewTooltipEnabled").closest(".settings-card");
    const explorationSection = queryOption(document, "categoryToolsEnabled").closest(".settings-card");
    const followingRefreshSection = queryOption(document, "followingRefreshEnabled").closest(".settings-card");
    const optionOrder = Array.from(explorationSection.querySelectorAll("[data-option]")).map(
        (input) => input.dataset.option
    );

    assert.equal(previewSection, explorationSection);
    assert.equal(followingRefreshSection, explorationSection);
    assert.ok(optionOrder.indexOf("followingRefreshEnabled") < optionOrder.indexOf("followingRefreshSeconds"));
    assert.ok(optionOrder.indexOf("followingRefreshSeconds") < optionOrder.indexOf("categoryToolsEnabled"));
    assert.ok(
        optionOrder.indexOf("categoryToolsLiveElapsedEnabled") <
            optionOrder.indexOf("followingPreviewTooltipEnabled")
    );
    assert.ok(optionOrder.indexOf("followingPreviewTooltipEnabled") < optionOrder.indexOf("titleTooltipEnabled"));
});

test("manifest loads playback scripts in the expected worlds", () => {
    const manifest = JSON.parse(readRepoFile("manifest.json"));
    const mainScript = manifest.content_scripts.find((entry) => entry.world === "MAIN");
    const isolatedScript = manifest.content_scripts.find((entry) => entry.js?.includes("features/volumeWheel.js"));

    assert.ok(mainScript);
    assert.ok(isolatedScript);
    assert.ok(mainScript.js.includes("features/routeBridgePage.js"));
    assert.ok(mainScript.js.includes("features/followingPreviewPage.js"));
    assert.ok(mainScript.js.indexOf("features/routeBridgePage.js") < mainScript.js.indexOf("features/autoQualityPage.js"));
    assert.ok(
        mainScript.js.indexOf("features/routeBridgePage.js") <
            mainScript.js.indexOf("features/followingPreviewPage.js")
    );
    assert.ok(
        mainScript.js.indexOf("features/followingPreviewPage.js") <
            mainScript.js.indexOf("features/autoQualityPage.js")
    );
    assert.ok(mainScript.js.includes("features/volumeWheelPage.js"));
    assert.ok(mainScript.js.indexOf("features/volumeWheelPage.js") > mainScript.js.indexOf("features/autoQualityPage.js"));
    assert.ok(isolatedScript.js.includes("features/volumeWheel.js"));
    assert.ok(isolatedScript.js.indexOf("features/volumeWheel.js") > isolatedScript.js.indexOf("content.js"));
    assert.ok(isolatedScript.js.includes("features/shortcutRescue.js"));
    assert.ok(
        isolatedScript.js.indexOf("features/shortcutRescue.js") > isolatedScript.js.indexOf("features/followingRefresh.js")
    );
});

async function loadVideoSearchPage(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "videoSearch.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();
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

    const makeVideos = (count, offset = 0) => Array.from({ length: count }, (_, index) => ({
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

test("following refresh stays idle when the native following refresh button is unavailable", async () => {
    const chrome = createFakeChrome({ sync: { followingRefreshSeconds: 10 } });
    const dom = createPageDom("<!doctype html><body><main></main></body>", "https://chzzk.naver.com/", chrome);
    const intervals = captureIntervals(dom);
    const events = { visibility: 0, focus: 0 };

    dom.window.document.addEventListener("visibilitychange", () => {
        events.visibility += 1;
    });
    dom.window.addEventListener("focus", () => {
        events.focus += 1;
    });

    evalFollowingRefreshScripts(dom);
    await waitForAsyncCallbacks();

    assert.equal(intervals.length, 1);

    intervals[0].fn();

    assert.equal(events.visibility, 0);
    assert.equal(events.focus, 0);
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

test("options page autosaves toggles immediately and number inputs after a debounce", async () => {
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
    const autoQuality = queryOption(document, "autoQualityEnabled");

    assert.equal(skipSeconds.value, "15");
    assert.equal(videoComment.disabled, true);

    autoQuality.checked = false;
    dispatch(dom, autoQuality, "change");
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.sync.autoQualityEnabled, false, "체크박스는 변경 즉시 저장된다");

    skipSeconds.value = "17";
    dispatch(dom, skipSeconds, "input");
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.sync.skipSeconds, 15, "숫자 입력은 디바운스 전에는 저장되지 않는다");
    assert.equal(document.getElementById("notice").dataset.state, "saving");

    await new Promise((resolve) => setTimeout(resolve, 600));

    assert.equal(chrome.testState.sync.skipSeconds, 17, "타이핑이 멎으면 자동 저장된다");
    assert.equal(document.getElementById("notice").dataset.state, "saved");

    skipSeconds.value = "9999";
    dispatch(dom, skipSeconds, "input");
    await new Promise((resolve) => setTimeout(resolve, 600));

    assert.equal(skipSeconds.value, "600", "autosave should show the clamped numeric value");
    assert.equal(chrome.testState.sync.skipSeconds, 600);
});

test("options page shows initial storage read failures without overwriting existing sync options", async () => {
    const chrome = createFakeChrome({
        sync: {
            autoQualityEnabled: true,
        },
    });
    chrome.storage.sync.get = (_keys, callback) => {
        setTimeout(() => {
            chrome.runtime.lastError = { message: "load failed" };
            callback({});
            chrome.runtime.lastError = null;
        }, 0);
    };
    const dom = createDom("options.html", "options.html", chrome);

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    const autoQuality = queryOption(document, "autoQualityEnabled");
    const message = document.getElementById("message");

    assert.equal(document.getElementById("notice").dataset.state, "error");
    assert.equal(message.textContent, "설정을 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.");

    autoQuality.checked = false;
    dispatch(dom, autoQuality, "change");
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.sync.autoQualityEnabled, true);
    assert.equal(document.getElementById("notice").dataset.state, "error");
    assert.equal(
        message.textContent,
        "설정을 불러오지 못해 저장하지 않았습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요."
    );
});

test("options page shows storage write failures without updating saved options", async () => {
    const chrome = createFakeChrome({
        sync: {
            autoQualityEnabled: true,
        },
    });
    const dom = createDom("options.html", "options.html", chrome);

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    chrome.storage.sync.set = (_values, callback) => {
        setTimeout(() => {
            chrome.runtime.lastError = { message: "write failed" };
            callback();
            chrome.runtime.lastError = null;
        }, 0);
    };

    const { document } = dom.window;
    const autoQuality = queryOption(document, "autoQualityEnabled");

    autoQuality.checked = false;
    dispatch(dom, autoQuality, "change");
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.sync.autoQualityEnabled, true);
    assert.equal(document.getElementById("notice").dataset.state, "error");
    assert.equal(
        document.getElementById("message").textContent,
        "설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요."
    );
});

test("options page snaps out-of-range numbers back on change and saves the clamped value", async () => {
    const chrome = createFakeChrome();
    const dom = createDom("options.html", "options.html", chrome);

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    const skipSeconds = queryOption(document, "skipSeconds");

    skipSeconds.value = "9999";
    dispatch(dom, skipSeconds, "input");
    dispatch(dom, skipSeconds, "change");
    await waitForAsyncCallbacks();

    assert.equal(skipSeconds.value, "600", "범위 밖 값은 입력을 마치면 보정값으로 되돌려 보여준다");
    assert.equal(chrome.testState.sync.skipSeconds, 600);

    skipSeconds.value = "";
    dispatch(dom, skipSeconds, "input");
    dispatch(dom, skipSeconds, "change");
    await waitForAsyncCallbacks();

    assert.equal(skipSeconds.value, "600", "빈 칸은 마지막 저장값으로 복원된다");
    assert.equal(chrome.testState.sync.skipSeconds, 600);
});

test("options reset asks for confirmation before restoring defaults", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipSeconds: 15,
        },
    });
    const dom = createDom("options.html", "options.html", chrome);

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    const skipSeconds = queryOption(document, "skipSeconds");
    const resetButton = document.getElementById("reset");

    dom.window.confirm = () => false;
    resetButton.click();
    await waitForAsyncCallbacks();

    assert.equal(skipSeconds.value, "15", "확인을 거부하면 아무것도 바뀌지 않는다");
    assert.equal(chrome.testState.sync.skipSeconds, 15);

    dom.window.confirm = () => true;
    resetButton.click();
    await waitForAsyncCallbacks();

    assert.equal(skipSeconds.value, "5");
    assert.equal(chrome.testState.sync.skipSeconds, 5);
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

test("title tooltip accepts channel root links as card links", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><article class="card">',
            '<a class="card_title" href="/0123456789abcdef0123456789abcdef">채널 루트 링크의 잘리는 방송 제목</a>',
            "</article></main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/",
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
    assert.equal(tip.textContent, "채널 루트 링크의 잘리는 방송 제목");
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

test("title tooltip ignores titles that fit", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><article class="card">',
            '<a class="card_title" href="/live/abc">짧은 제목</a>',
            "</article></main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/lives",
        chrome
    );
    const { document } = dom.window;
    const title = document.querySelector(".card_title");

    Object.defineProperty(title, "scrollWidth", { configurable: true, get: () => 100 });
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

test("title tooltip keeps pending hover when moving inside the same title", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><article class="card">',
            '<a class="card_title" href="/live/abc"><span>자식 이동 중에도 유지되는 긴 방송 제목</span></a>',
            "</article></main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/lives",
        chrome
    );
    const { document } = dom.window;
    const title = document.querySelector(".card_title");
    const child = title.querySelector("span");

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
    await new Promise((resolve) => setTimeout(resolve, 80));
    child.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    title.dispatchEvent(new dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: child }));
    await new Promise((resolve) => setTimeout(resolve, 110));

    const tip = document.querySelector(".bctt-tooltip[data-show='1']");
    assert.ok(tip);
    assert.equal(tip.textContent, "자식 이동 중에도 유지되는 긴 방송 제목");
    assert.equal(title.getAttribute("data-bctt-active"), "1");
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
    dom.window.addEventListener("wheel", () => {
        nativeWheelCount += 1;
        video.volume = 1;
    }, { capture: true });

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
    assert.ok(Math.abs(video.volume - 0.50) < 1e-6, "휠 다운이면 -5%");
    assert.equal(down.defaultPrevented, true);
    assert.equal(slider.value, "50");
});

test("volume wheel stays inert until settings publish while keeping early listener priority", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol">',
            '<button class="pzp-pc__volume-button" type="button"></button>',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const vol = document.getElementById("vol");

    video.volume = 0.5;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    vol.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });

    evalRepoScript(dom, "features", "volumeWheelPage.js");

    let nativeWheelCount = 0;
    dom.window.addEventListener("wheel", () => {
        nativeWheelCount += 1;
        video.volume = 1;
    }, { capture: true });

    const beforeSettings = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(beforeSettings, "deltaY", { value: -100 });
    vol.dispatchEvent(beforeSettings);

    assert.equal(video.volume, 1);
    assert.equal(beforeSettings.defaultPrevented, false);
    assert.equal(nativeWheelCount, 1);

    video.volume = 0.5;
    nativeWheelCount = 0;

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "volumeWheel.js");
    await waitForAsyncCallbacks();

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    vol.dispatchEvent(up);

    assert.ok(Math.abs(video.volume - 0.55) < 1e-6);
    assert.equal(up.defaultPrevented, true);
    assert.equal(nativeWheelCount, 0);
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

    assert.ok(Math.abs(video.volume - 0.50) < 1e-6);
    assert.equal(slider.value, "0.5");
});

test("volume wheel avoids native slider feedback on unit-range aria sliders", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol">',
            '<button class="pzp-pc__volume-button" type="button"></button>',
            '<div id="slider" role="slider" aria-label="\uBCFC\uB968" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0.5"></div>',
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

    let syntheticSliderEvents = 0;
    slider.addEventListener("input", () => {
        syntheticSliderEvents += 1;
        video.volume = 1;
    });
    slider.addEventListener("change", () => {
        syntheticSliderEvents += 1;
        video.volume = 0;
    });

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    vol.dispatchEvent(up);

    assert.ok(Math.abs(video.volume - 0.55) < 1e-6);
    assert.equal(slider.getAttribute("aria-valuenow"), "0.5");
    assert.notEqual(slider.getAttribute("aria-valuenow"), "1");
    assert.equal(slider.hasAttribute("aria-valuetext"), false);
    assert.equal(syntheticSliderEvents, 0);

    const down = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(down, "deltaY", { value: 100 });
    vol.dispatchEvent(down);

    assert.ok(Math.abs(video.volume - 0.50) < 1e-6);
    assert.equal(slider.getAttribute("aria-valuenow"), "0.5");

    video.volume = 0.04;
    video.muted = false;
    const downToMute = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(downToMute, "deltaY", { value: 100 });
    vol.dispatchEvent(downToMute);

    assert.equal(video.volume, 0);
    assert.equal(video.muted, true);
    assert.equal(slider.getAttribute("aria-valuenow"), "0.5");

    const upFromMute = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(upFromMute, "deltaY", { value: -100 });
    vol.dispatchEvent(upFromMute);

    assert.ok(Math.abs(video.volume - 0.05) < 1e-6);
    assert.equal(video.muted, false);
    assert.equal(slider.getAttribute("aria-valuenow"), "0.5");

    video.volume = 1;
    video.muted = false;
    const downFromMax = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(downFromMax, "deltaY", { value: 100 });
    vol.dispatchEvent(downFromMax);

    assert.ok(Math.abs(video.volume - 0.95) < 1e-6);
    assert.equal(slider.getAttribute("aria-valuenow"), "0.5");
    assert.equal(syntheticSliderEvents, 0);
});

test("volume wheel works on VOD playback routes", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol">',
            '<button class="pzp-pc__volume-button" type="button"></button>',
            '<input id="slider" type="range" min="0" max="100" value="40">',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/video/test-video",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const vol = document.getElementById("vol");
    const slider = document.getElementById("slider");

    video.volume = 0.4;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    vol.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    vol.dispatchEvent(up);

    assert.ok(Math.abs(video.volume - 0.45) < 1e-6);
    assert.equal(up.defaultPrevented, true);
    assert.equal(slider.value, "40");
});

test("volume wheel detects aria-labeled native buttons without volume classes", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__bottom-buttons--left" id="controls">',
            '<button class="pzp-button" id="vol" type="button" aria-label="\uC74C\uC18C\uAC70">',
            '<span id="icon" aria-hidden="true"></span>',
            "</button>",
            '<input id="slider" type="range" min="0" max="1" step="0.01" value="0.5" aria-label="\uBCFC\uB968">',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const controls = document.getElementById("controls");
    const button = document.getElementById("vol");
    const icon = document.getElementById("icon");
    const slider = document.getElementById("slider");

    video.volume = 0.5;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    controls.getBoundingClientRect = () => ({ width: 160, height: 40, left: 20, top: 320, right: 180, bottom: 360 });
    button.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    icon.dispatchEvent(up);

    assert.ok(Math.abs(video.volume - 0.55) < 1e-6);
    assert.equal(up.defaultPrevented, true);
    assert.equal(slider.value, "0.5");
});

test("volume wheel ignores volume-like controls outside the playback area", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div id="chatSettings">',
            '<button id="chatVolume" type="button" aria-label="volume notification"></button>',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const chatVolume = document.getElementById("chatVolume");

    video.volume = 0.5;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    chatVolume.getBoundingClientRect = () => ({ width: 120, height: 32, left: 700, top: 40, right: 820, bottom: 72 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    chatVolume.dispatchEvent(up);

    assert.equal(video.volume, 0.5);
    assert.equal(up.defaultPrevented, false);
});

test("volume wheel detects a single visible sibling slider without syncing it", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__bottom-buttons--left" id="controls">',
            '<button class="pzp-button" id="vol" type="button" aria-label="\uC74C\uC18C\uAC70">',
            '<span id="icon" aria-hidden="true"></span>',
            "</button>",
            '<input id="slider" type="range" min="0" max="1" step="0.01" value="0.5">',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const controls = document.getElementById("controls");
    const button = document.getElementById("vol");
    const icon = document.getElementById("icon");
    const slider = document.getElementById("slider");

    video.volume = 0.5;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    controls.getBoundingClientRect = () => ({ width: 160, height: 40, left: 20, top: 320, right: 180, bottom: 360 });
    button.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });
    slider.getBoundingClientRect = () => ({ width: 80, height: 16, left: 70, top: 332, right: 150, bottom: 348 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    icon.dispatchEvent(up);

    assert.ok(Math.abs(video.volume - 0.55) < 1e-6);
    assert.equal(up.defaultPrevented, true);
    assert.equal(slider.value, "0.5");
});

test("volume wheel ignores hidden volume controls", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol">',
            '<button class="pzp-pc__volume-button" type="button"></button>',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const vol = document.getElementById("vol");

    video.volume = 0.5;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    vol.getBoundingClientRect = () => ({ width: 0, height: 0, left: 20, top: 320, right: 20, bottom: 320 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    vol.dispatchEvent(up);

    assert.equal(video.volume, 0.5);
    assert.equal(up.defaultPrevented, false);
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

test("auto quality retries by directly discovering videoTracks after they appear", () => {
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

test("auto quality treats an active preferred track as already selected", () => {
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
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const tracks = [
        { id: "auto", label: "auto 1080p", height: 1080 },
        { id: "1080", label: "1080p", height: 1080, kind: "main", active: true },
        { id: "720", label: "720p", height: 720, kind: "main" },
    ];
    const trackList = createVideoTrackList(tracks, -1);

    video.currentTime = 2;
    makeVisibleVideo(video);
    Object.defineProperty(video, "videoTracks", {
        configurable: true,
        get: () => trackList,
    });

    evalRepoScript(dom, "features", "autoQualityPage.js");

    const result = requestAutoQualityApply(dom, "1080p");

    assert.equal(result.status, "already");
    assert.equal(result.selected.height, 1080);
    assert.equal(trackList.selectedIndex, -1);
    assert.equal(tracks[1].selected, false);
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

test("auto quality page hook unpatches defineProperty APIs outside playback routes", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/live/test-channel", chrome);
    const nativeDefineProperty = dom.window.Object.defineProperty;
    const nativeDefineProperties = dom.window.Object.defineProperties;
    const nativeReflectDefineProperty = dom.window.Reflect.defineProperty;

    evalRepoScript(dom, "features", "autoQualityPage.js");

    assert.notEqual(dom.window.Object.defineProperty, nativeDefineProperty);
    assert.notEqual(dom.window.Object.defineProperties, nativeDefineProperties);
    assert.notEqual(dom.window.Reflect.defineProperty, nativeReflectDefineProperty);

    dom.window.history.pushState({}, "", "/category/game/lives");
    dom.window.dispatchEvent(new dom.window.CustomEvent("betterchzzk:routechange", {
        detail: { href: dom.window.location.href, source: "test" },
    }));

    assert.equal(dom.window.Object.defineProperty, nativeDefineProperty);
    assert.equal(dom.window.Object.defineProperties, nativeDefineProperties);
    assert.equal(dom.window.Reflect.defineProperty, nativeReflectDefineProperty);

    dom.window.history.pushState({}, "", "/video/12345");
    dom.window.dispatchEvent(new dom.window.CustomEvent("betterchzzk:routechange", {
        detail: { href: dom.window.location.href, source: "test" },
    }));

    assert.notEqual(dom.window.Object.defineProperty, nativeDefineProperty);
});

test("auto quality publishes state without writing a page localStorage cache", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom("<!doctype html><body><video></video></body>", "https://chzzk.naver.com/live/test-channel", chrome);

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "autoQuality.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    assert.ok(dom.window.document.documentElement.getAttribute("data-betterchzzk-auto-quality-state"));
    assert.equal(dom.window.localStorage.getItem("betterchzzk:auto-quality:state-cache"), null);
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
    evalContentScripts(dom);
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
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "vodBroadcastClock.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();

    assert.equal(document.getElementById("betterchzzk-vod-broadcast-clock"), null);
});

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
    state.currentTime = currentTime;
    dispatchVideoEvent(dom, video, "timeupdate");
}

function waitForLiveTimeShiftSync() {
    return new Promise((resolve) => setTimeout(resolve, 650));
}

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

test("live timeshift guard keeps protection while a long seekbar drag is held", async () => {
    const chrome = createFakeChrome();
    const { dom, seekbar, state, video } = createLiveTimeShiftGuardDom(chrome);

    try {
        await loadSkipControlPage(dom);
        armLiveTimeShiftGuard(dom, video, state, 32);

        seekbar.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 1300));

        video.currentTime = 35.5;
        dispatchVideoEvent(dom, video, "seeking");
        dispatchVideoEvent(dom, video, "seeked");

        assert.equal(video.currentTime, 35.5, "유예보다 길게 잡고 있어도 드래그 중에는 롤백하지 않는다");

        seekbar.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true, cancelable: true }));
        video.currentTime = 38;
        dispatchVideoEvent(dom, video, "seeking");

        assert.equal(video.currentTime, 38, "드래그를 놓은 직후 커밋된 시크도 사용자 의도로 수용한다");
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live timeshift guard ignores non-seek slider gestures for forced live-edge jumps", async () => {
    const chrome = createFakeChrome();
    const { dom, state, video, volumeSlider } = createLiveTimeShiftGuardDom(chrome);

    try {
        await loadSkipControlPage(dom);
        armLiveTimeShiftGuard(dom, video, state, 32);

        volumeSlider.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        video.currentTime = 39;
        dispatchVideoEvent(dom, video, "seeking");

        assert.ok(video.currentTime >= 32 && video.currentTime < 34);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live timeshift guard expires a held seekbar gesture when pointerup is missed", async () => {
    const chrome = createFakeChrome();
    const { dom, seekbar, state, video } = createLiveTimeShiftGuardDom(chrome);
    const clock = useFakePerformanceNow(dom);

    try {
        state.paused = true;
        await loadSkipControlPage(dom);
        armLiveTimeShiftGuard(dom, video, state, 32);

        seekbar.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        clock.advance(8100);
        video.currentTime = 39;
        dispatchVideoEvent(dom, video, "seeking");

        assert.ok(video.currentTime >= 32 && video.currentTime < 34);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live timeshift guard still restores forced live-edge jumps without a user gesture", async () => {
    const chrome = createFakeChrome();
    const { dom, state, video } = createLiveTimeShiftGuardDom(chrome);

    try {
        await loadSkipControlPage(dom);
        armLiveTimeShiftGuard(dom, video, state, 32);

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

function setupShortcutRescueDom(chrome) {
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
    evalRepoScript(dom, "features", "shortcutRescue.js");

    return { dom, document, video, state };
}

function dispatchShortcutKey(dom, code, key) {
    const event = new dom.window.KeyboardEvent("keydown", {
        code,
        key,
        bubbles: true,
        cancelable: true,
    });
    dom.window.document.body.dispatchEvent(event);
    return event;
}

function waitForRescueProbe() {
    return new Promise((resolve) => setTimeout(resolve, 150));
}

test("shortcut rescue takes over once the native shortcut pipeline stays unresponsive", async () => {
    const chrome = createFakeChrome();
    const { dom, state } = setupShortcutRescueDom(chrome);
    await waitForAsyncCallbacks();

    const firstTheater = dispatchShortcutKey(dom, "KeyT", "t");
    assert.equal(state.clicks.theater, 1, "관찰할 수 없는 화면 전환 키도 첫 입력에서 버튼 클릭으로 처리된다");
    assert.equal(firstTheater.defaultPrevented, true);

    dispatchShortcutKey(dom, "Space", " ");
    await waitForRescueProbe();
    assert.equal(state.clicks.play, 1, "첫 미반응 키는 짧은 프로브 후 소급 실행된다");
    assert.equal(state.paused, false);

    const immediate = dispatchShortcutKey(dom, "Space", " ");
    assert.equal(state.clicks.play, 2, "첫 미반응 확정 후에는 지연 없이 즉시 실행된다");
    assert.equal(state.paused, true);
    assert.equal(immediate.defaultPrevented, true);

    dispatchShortcutKey(dom, "KeyM", "m");
    assert.equal(state.clicks.mute, 1);
});

test("shortcut rescue keeps a pending observable probe when view mode is rescued first", async () => {
    const chrome = createFakeChrome();
    const { dom, state } = setupShortcutRescueDom(chrome);
    await waitForAsyncCallbacks();

    dispatchShortcutKey(dom, "Space", " ");
    dispatchShortcutKey(dom, "KeyT", "t");
    assert.equal(state.clicks.theater, 1);

    await waitForRescueProbe();
    assert.equal(state.clicks.play, 1);
    assert.equal(state.paused, false);
});

test("shortcut rescue stays inactive while the native pipeline handles keys", async () => {
    const chrome = createFakeChrome();
    const { dom, state } = setupShortcutRescueDom(chrome);
    await waitForAsyncCallbacks();

    dom.window.addEventListener("keydown", (event) => {
        if (event.code === "Space") state.paused = !state.paused;
    });

    dispatchShortcutKey(dom, "Space", " ");
    await waitForRescueProbe();
    assert.equal(state.clicks.play, 0, "네이티브가 처리하면 폴백은 개입하지 않는다");
    assert.equal(state.paused, false);

    dispatchShortcutKey(dom, "Space", " ");
    await waitForRescueProbe();
    assert.equal(state.clicks.play, 0, "생존 확정 후에는 프로브도 하지 않는다");
    assert.equal(state.paused, true);
});

test("shortcut rescue does nothing when the option is disabled", async () => {
    const chrome = createFakeChrome({
        sync: {
            shortcutRescueEnabled: false,
        },
    });
    const { dom, state } = setupShortcutRescueDom(chrome);
    await waitForAsyncCallbacks();

    dispatchShortcutKey(dom, "Space", " ");
    await waitForRescueProbe();
    assert.equal(state.clicks.play, 0);
    assert.equal(state.paused, true);
});

test("history page loads local watch history state without crashing", async () => {
    const chrome = createFakeChrome();
    const dom = createDom("history.html", "history.html", chrome);

    evalRepoScript(dom, "shared", "data.js");
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
