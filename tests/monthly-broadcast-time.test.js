const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { evalFeatureModules, waitForCondition } = require("./helpers/extension-page-fixture.js");

const repoRoot = path.join(__dirname, "..");
const CHANNEL = "a".repeat(32);
const NOW = Date.parse("2026-07-20T12:00:00+09:00");

function replay(videoNo, day = 10) {
    return {
        videoNo,
        videoType: "REPLAY",
        duration: 3600,
        liveOpenDate: `2026-07-${String(day).padStart(2, "0")} 01:00:00`,
        publishDate: `2026-07-${String(day).padStart(2, "0")} 02:00:00`,
    };
}

function pageRows(page) {
    return Array.from({ length: 30 }, (_, index) => replay(page * 30 + index + 1, 10 - page));
}

function fixture({ options = {}, fetchJson } = {}) {
    const dom = new JSDOM("<!doctype html><body></body>", {
        url: `https://chzzk.naver.com/${CHANNEL}`,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const { window } = dom;
    window.Date.now = () => NOW;
    window.HTMLCanvasElement.prototype.getContext = () => null;
    for (const file of ["shared/settings.js", "shared/data.js", "shared/vodTimeline.js"]) {
        window.eval(fs.readFileSync(path.join(repoRoot, file), "utf8"));
    }
    const calls = [];
    Object.assign(window.BetterChzzk.utils, {
        normSpace: (value) => String(value || "").trim(),
        injectStyleOnce() {},
        bindFeatureOptions() {},
        onReady() {},
        createThrottledDomSync: (callback) => callback,
        createMutationObserverSync: () => ({ disconnect() {} }),
        startPageChangeDetection: () => () => {},
        startStorageChangeListener: () => () => {},
        isVisible: (element) => element.isConnected,
        fetchJson(url, init) {
            calls.push({ url, signal: init.signal });
            return fetchJson ? fetchJson(url, init) : Promise.resolve({ content: { data: [], last: true } });
        },
    });
    evalFeatureModules(dom, "monthlyBroadcastTime");
    const source = fs.readFileSync(path.join(repoRoot, "features/monthlyBroadcastTime.js"), "utf8");
    const end = source.lastIndexOf("})();");
    window.eval(
        `${source.slice(0, end)}window.hooks = {
            calculateStats, calculateCalendarMonth, loadStats, createWidget,
            renderCachedStats, navigateCalendarMonth, resetCalendarToCurrentMonth,
            getSelectedCalendarMonth, setSelectedCalendarMonth, getKstMonthInfo,
            cacheMonthInfo, getCachedMonthInfo,
            fetchVideoPageCached: repository.fetchVideoPageCached, fetchVideoDetail: repository.fetchVideoDetail,
            channelStatsCache, loadingTokens, calendarLoadingTokens, applyOptions,
            removeWidget, mountWidget,
            configure(options) { featureOptions = BetterChzzkSettings.normalizeOptions(options); },
            setChannel(channelId) { currentChannelId = channelId; }
        };${source.slice(end)}`
    );
    const hooks = window.hooks;
    hooks.configure({ ...options, monthlyBroadcastTimeWatchEnabled: false });
    hooks.setChannel(CHANNEL);
    return { dom, window, hooks, calls };
}

async function stats(f) {
    const token = Symbol();
    f.hooks.loadingTokens.set(CHANNEL, token);
    return f.hooks.calculateStats(CHANNEL, token);
}

async function calendar(f, year = 2026, month = 7) {
    const token = Symbol();
    f.hooks.calendarLoadingTokens.set(CHANNEL, token);
    return f.hooks.calculateCalendarMonth(CHANNEL, year, month, token);
}

function mount(f) {
    const widget = f.hooks.createWidget();
    f.window.document.body.append(widget);
    return widget;
}

function flush() {
    return new Promise((resolve) => setImmediate(resolve));
}

for (const [averageLimit, calendarLimit] of [
    [1, 3],
    [3, 1],
]) {
    test(`monthly average cap ${averageLimit} and calendar cap ${calendarLimit} stay independent`, async () => {
        const f = fixture({
            options: {
                monthlyBroadcastTimeMaxPages: averageLimit,
                monthlyBroadcastTimeMaxCalendarPages: calendarLimit,
            },
            fetchJson: async (url) => ({
                content: { data: pageRows(Number(new URL(url).searchParams.get("page"))), last: false },
            }),
        });
        try {
            const result = await stats(f);
            assert.equal(result.totalSeconds, averageLimit * 30 * 3600);
            assert.equal(
                Object.values(result.month.dailySeconds).reduce((a, b) => a + b, 0),
                calendarLimit * 30 * 3600
            );
            assert.equal(result.pagesLoaded, averageLimit);
            assert.equal(result.month.pagesLoaded, calendarLimit);
            assert.equal(result.month.partial, true);
            assert.equal(result.complete, false);
            assert.equal(f.calls.length, Math.max(averageLimit, calendarLimit));
        } finally {
            f.dom.window.close();
        }
    });
}

for (const calculate of [stats, calendar]) {
    test(`monthly ${calculate.name} continues after filtering an invalid row and recognizes the final capped page`, async () => {
        const f = fixture({
            options: { monthlyBroadcastTimeMaxPages: 2, monthlyBroadcastTimeMaxCalendarPages: 2 },
            fetchJson: async (url) => {
                const page = Number(new URL(url).searchParams.get("page"));
                const data = pageRows(page);
                if (page === 0) data[0].duration = 0;
                // Exercise the existing row-count contract when pagination metadata is absent.
                return { content: page === 0 ? { data } : { data, last: true } };
            },
        });
        try {
            const result = await calculate(f);
            const month = calculate === stats ? result.month : result;
            assert.equal(f.calls.length, 2);
            assert.equal(
                Object.values(month.dailySeconds).reduce((a, b) => a + b, 0),
                59 * 3600
            );
            assert.equal(month.partial, false);
            if (calculate === stats) assert.equal(result.complete, true);
        } finally {
            f.dom.window.close();
        }
    });
}

test("monthly channel with no recent replays preserves its selected past month on rerender", () => {
    const f = fixture();
    try {
        const widget = mount(f);
        f.hooks.channelStatsCache.set(CHANNEL, {
            month: f.hooks.getKstMonthInfo(),
            replayCount: 0,
            totalSeconds: 0,
            fetchedAt: NOW,
        });
        f.hooks.cacheMonthInfo(CHANNEL, f.hooks.getKstMonthInfo(NOW, 2026, 6));
        f.hooks.setSelectedCalendarMonth(widget, 2026, 6);
        f.hooks.renderCachedStats(widget, CHANNEL);
        assert.equal(f.hooks.getSelectedCalendarMonth(widget).month, 6);
        assert.equal(widget.querySelector(".bcmb-calendar-month").textContent, "2026.06");
    } finally {
        f.dom.window.close();
    }
});

test("monthly list timeout displays an error instead of leaving an idle loading state", async () => {
    const f = fixture({
        fetchJson: async () => {
            const error = new Error("timeout");
            error.name = "AbortError";
            throw error;
        },
    });
    try {
        const widget = mount(f);
        await f.hooks.loadStats(CHANNEL);
        assert.equal(widget.dataset.state, "error");
        assert.equal(f.hooks.loadingTokens.has(CHANNEL), false);
    } finally {
        f.dom.window.close();
    }
});

for (const resource of ["page", "detail"]) {
    test(`monthly shared ${resource} request survives one consumer cancelling`, async () => {
        let resolve;
        const f = fixture({
            fetchJson: (_url, { signal }) =>
                new Promise((done, reject) => {
                    resolve = done;
                    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
                        once: true,
                    });
                }),
        });
        const request = (signal) =>
            resource === "page"
                ? f.hooks.fetchVideoPageCached(CHANNEL, 0, { signal })
                : f.hooks.fetchVideoDetail("123", { signal });
        try {
            const first = new AbortController();
            const second = new AbortController();
            const firstPromise = request(first.signal);
            const secondPromise = request(second.signal);
            const rejection = assert.rejects(firstPromise, { name: "AbortError" });
            first.abort();
            await rejection;
            assert.equal(f.calls.length, 1);
            assert.equal(f.calls[0].signal.aborted, false);
            resolve({ content: { data: [], last: true } });
            await secondPromise;
            await request(second.signal);
            assert.equal(f.calls.length, 1);
        } finally {
            f.dom.window.close();
        }
    });
}

test("monthly month cache expires and older stats cannot replace a refreshed calendar", () => {
    const f = fixture();
    try {
        const widget = mount(f);
        const oldMonth = f.hooks.getKstMonthInfo();
        const refreshedMonth = f.hooks.getKstMonthInfo();
        refreshedMonth.dailySeconds["2026-07-10"] = 3600;
        f.hooks.channelStatsCache.set(CHANNEL, { month: oldMonth, replayCount: 0, totalSeconds: 0, fetchedAt: NOW });
        f.window.Date.now = () => NOW + 1000;
        f.hooks.cacheMonthInfo(CHANNEL, refreshedMonth);
        f.hooks.renderCachedStats(widget, CHANNEL);
        assert.strictEqual(f.hooks.getCachedMonthInfo(CHANNEL, 2026, 7), refreshedMonth);
        f.window.Date.now = () => NOW + 11 * 60 * 1000;
        assert.equal(f.hooks.getCachedMonthInfo(CHANNEL, 2026, 7), null);
    } finally {
        f.dom.window.close();
    }
});

test("monthly cached page traversal does not repeat requests or page pacing delays", async () => {
    const f = fixture({
        fetchJson: async (url) => {
            const page = Number(new URL(url).searchParams.get("page"));
            return { content: { data: pageRows(page), last: page === 1 } };
        },
    });
    let delays = 0;
    const setTimeout = f.window.setTimeout.bind(f.window);
    f.window.setTimeout = (callback, delay) => {
        if (delay === 80) delays++;
        return setTimeout(callback, delay);
    };
    try {
        await stats(f);
        const firstCalls = f.calls.length;
        const firstDelays = delays;
        const month = await calendar(f);
        assert.equal(month.partial, false);
        assert.equal(firstCalls, 2);
        assert.equal(firstDelays, 1);
        assert.equal(f.calls.length, firstCalls);
        assert.equal(delays, firstDelays);
    } finally {
        f.dom.window.close();
    }
});

for (const resource of ["page", "detail"]) {
    test(`monthly cancelled ${resource} request cannot evict its replacement`, async () => {
        const pending = [];
        const f = fixture({
            fetchJson: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
        });
        const request = (signal) =>
            resource === "page"
                ? f.hooks.fetchVideoPageCached(CHANNEL, 0, { signal })
                : f.hooks.fetchVideoDetail("123", { signal });
        try {
            const controller = new AbortController();
            const first = request(controller.signal);
            const rejected = assert.rejects(first, { name: "AbortError" });
            await flush();
            controller.abort();
            await rejected;
            assert.equal(f.calls[0].signal.aborted, true);
            const replacement = request();
            await flush();
            assert.equal(f.calls.length, 2);
            pending[0].reject(new DOMException("Aborted", "AbortError"));
            await flush();
            pending[1].resolve({ content: { data: [], last: true } });
            await replacement;
            await request();
            assert.equal(f.calls.length, 2);
        } finally {
            f.dom.window.close();
        }
    });
}

test("monthly closing a pending past month restores the cached current month and cancels unused work", async () => {
    const f = fixture({
        fetchJson: (_url, { signal }) =>
            new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
                    once: true,
                });
            }),
    });
    try {
        const widget = mount(f);
        f.hooks.setSelectedCalendarMonth(widget, 2026, 7);
        f.hooks.cacheMonthInfo(CHANNEL, f.hooks.getKstMonthInfo());
        const pending = f.hooks.navigateCalendarMonth(widget, -1);
        await flush();
        assert.equal(widget.querySelector(".bcmb-calendar").dataset.loading, "1");
        f.hooks.resetCalendarToCurrentMonth(widget);
        await pending;
        assert.equal(f.calls[0].signal.aborted, true);
        assert.equal(f.hooks.calendarLoadingTokens.has(CHANNEL), false);
        assert.equal(widget.querySelector(".bcmb-calendar-month").textContent, "2026.07");
        assert.equal(widget.querySelector(".bcmb-calendar").dataset.loading, "0");
    } finally {
        f.dom.window.close();
    }
});

test("monthly displays partial coverage even when no replay in the requested month was reached", async () => {
    const f = fixture({
        options: { monthlyBroadcastTimeMaxCalendarPages: 1 },
        fetchJson: async () => ({ content: { data: pageRows(0), last: false } }),
    });
    try {
        const widget = mount(f);
        f.hooks.setSelectedCalendarMonth(widget, 2026, 7);
        await f.hooks.navigateCalendarMonth(widget, -1);
        assert.equal(widget.querySelector(".bcmb-calendar-month").textContent, "2026.06");
        assert.equal(widget.querySelector(".bcmb-calendar-limit").hidden, false);
        assert.match(widget.querySelector(".bcmb-calendar-limit").textContent, /일부만 표시/);
        assert.equal(widget.querySelectorAll(".bcmb-day[data-video-no]").length, 0);
        f.hooks.cacheMonthInfo(CHANNEL, f.hooks.getKstMonthInfo());
        f.hooks.resetCalendarToCurrentMonth(widget);
        assert.equal(widget.querySelector(".bcmb-calendar-limit").hidden, true);
    } finally {
        f.dom.window.close();
    }
});

test("monthly disabling the calendar avoids scanning beyond the average cap", async () => {
    const f = fixture({
        options: {
            monthlyBroadcastTimeCalendarEnabled: false,
            monthlyBroadcastTimeMaxPages: 1,
            monthlyBroadcastTimeMaxCalendarPages: 3,
        },
        fetchJson: async () => ({ content: { data: pageRows(0), last: false } }),
    });
    try {
        const result = await stats(f);
        assert.equal(f.calls.length, 1);
        assert.equal(result.totalSeconds, 30 * 3600);
    } finally {
        f.dom.window.close();
    }
});

test("monthly average stops at its date boundary while the calendar continues without duplicate requests", async () => {
    const f = fixture({
        options: {
            monthlyBroadcastTimeWindowDays: 1,
            monthlyBroadcastTimeMaxPages: 5,
            monthlyBroadcastTimeMaxCalendarPages: 3,
        },
        fetchJson: async (url) => {
            const page = Number(new URL(url).searchParams.get("page"));
            const data = pageRows(page).map((video) => replay(video.videoNo, page === 0 ? 20 : 18 - page));
            return { content: { data, last: false } };
        },
    });
    try {
        const result = await stats(f);
        assert.equal(result.complete, true);
        assert.equal(result.pagesLoaded, 2);
        assert.equal(result.totalSeconds, 30 * 3600);
        assert.equal(result.month.pagesLoaded, 3);
        assert.equal(result.month.partial, true);
        assert.equal(
            Object.values(result.month.dailySeconds).reduce((a, b) => a + b, 0),
            90 * 3600
        );
        assert.equal(f.calls.length, 3);
    } finally {
        f.dom.window.close();
    }
});

test("monthly applying a new page limit remounts and reloads without duplicating the widget", async () => {
    const f = fixture({
        options: { monthlyBroadcastTimeMaxPages: 1, monthlyBroadcastTimeMaxCalendarPages: 1 },
        fetchJson: async (url) => {
            const page = Number(new URL(url).searchParams.get("page"));
            return { content: { data: pageRows(page), last: page === 1 } };
        },
    });
    try {
        f.window.document.body.innerHTML =
            '<main><section><div><button type="button">팔로우</button></div></section></main>';
        for (const element of f.window.document.querySelectorAll("main, section, div, button")) {
            element.getBoundingClientRect = () => ({
                width: 280,
                height: 42,
                top: 24,
                left: 300,
                right: 580,
                bottom: 66,
            });
        }
        f.hooks.setChannel(null);
        f.hooks.mountWidget();
        await flush();
        const oldWidget = f.window.document.getElementById("betterchzzk-monthly-broadcast-time");
        assert.ok(oldWidget);
        const options = f.window.BetterChzzkSettings.normalizeOptions({
            monthlyBroadcastTimeMaxPages: 1,
            monthlyBroadcastTimeMaxCalendarPages: 2,
        });
        f.hooks.applyOptions(options);
        assert.equal(oldWidget.isConnected, false);
        await waitForCondition(
            () => f.window.document.getElementById("betterchzzk-monthly-broadcast-time")?.dataset.state === "ready"
        );
        const widgets = f.window.document.querySelectorAll("#betterchzzk-monthly-broadcast-time");
        assert.equal(widgets.length, 1);
        assert.equal(widgets[0].dataset.state, "ready");
        assert.equal(widgets[0].querySelector(".bcmb-calendar-limit").hidden, true);
        assert.equal(f.calls.length, 3);
        f.hooks.applyOptions({ ...options, monthlyBroadcastTimeEnabled: false });
        assert.equal(f.window.document.getElementById("betterchzzk-monthly-broadcast-time"), null);
    } finally {
        f.hooks.removeWidget();
        f.dom.window.close();
    }
});
