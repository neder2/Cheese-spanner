const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const repoRoot = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadDataModules(folder, globals = {}) {
    const context = vm.createContext({
        AbortController,
        DOMException,
        URLSearchParams,
        setTimeout,
        clearTimeout,
        ...globals,
    });
    vm.runInContext(read("shared/data.js"), context);
    context.BetterChzzk.utils.normSpace = context.BetterChzzk.utils.compactSpaces;
    // The existing timeline module uses window only for namespace registration.
    context.window = context;
    vm.runInContext(read("shared/vodTimeline.js"), context);
    delete context.window;
    for (const file of [`features/${folder}/model.js`, `features/${folder}/repository.js`]) {
        vm.runInContext(read(file), context);
    }
    return context.BetterChzzk;
}

test("refactored feature modules precede their consumers in the isolated world", () => {
    const manifest = JSON.parse(read("manifest.json"));
    const scripts = manifest.content_scripts.find((entry) => entry.world !== "MAIN").js;
    for (const [folder, consumer, modules] of [
        ["chatTools", "features/chatTools.js", ["parser", "messageStore", "panel"]],
        ["categoryTools", "features/categoryTools.js", ["filterModel", "repository", "searchController"]],
        [
            "liveMultiview",
            "features/liveMultiview/runtime.js",
            ["model", "view", "playback", "layoutControls", "settingsPanel"],
        ],
        ["monthlyBroadcastTime", "features/monthlyBroadcastTime.js", ["model", "repository"]],
        ["videoSearch", "features/videoSearch.js", ["model", "repository"]],
    ]) {
        let previous = -1;
        for (const module of modules) {
            const file = `features/${folder}/${module}.js`;
            const index = scripts.indexOf(file);
            assert.ok(index > previous && index < scripts.indexOf(consumer), file);
            assert.ok(fs.existsSync(path.join(repoRoot, file)));
            previous = index;
        }
    }
});

test("broadcast model computes KST month and watch matches without DOM or runtime state", () => {
    const model = loadDataModules("monthlyBroadcastTime").monthlyBroadcastModel;
    const now = Date.parse("2026-07-20T12:00:00+09:00");
    const month = model.getKstMonthInfo(now, 2026, 7);
    assert.equal(month.daysInMonth, 31);
    assert.equal(month.startMs, Date.parse("2026-07-01T00:00:00+09:00"));
    const videos = model.extractVideos({
        content: {
            data: [
                {
                    videoNo: 12,
                    videoType: "REPLAY",
                    duration: 3600,
                    liveOpenDate: "2026-07-10 23:30:00",
                    videoTitle: "  Test   broadcast ",
                },
            ],
        },
    });
    assert.equal(videos[0].title, "Test broadcast");
    model.addMonthStart(videos[0], month, now);
    model.finalizeMonthInfo(month);
    assert.equal(month.broadcastDayCount, 1);
    assert.equal(month.dailySeconds["2026-07-10"], 3600);
    const entries = model.normalizeWatchHistory({
        entries: [{ id: "live:A", channelId: "a", liveId: "A", replayVideoNo: "12", watchedSeconds: 180 }],
    });
    assert.deepEqual(plain(model.getStartWatchInfo(entries, "a", { duration: 600, videoNos: ["12"] })), {
        seconds: 180,
        percent: 30,
    });
    assert.deepEqual(plain(model.getStartWatchInfo(entries, "b", { duration: 600, videoNos: ["12"] })), {
        seconds: 0,
        percent: 0,
    });
});

test("broadcast calculations share a page while each caller retains cancellation and query limits", async () => {
    const root = loadDataModules("monthlyBroadcastTime");
    let resolvePage;
    let calls = 0;
    let requestSignal;
    const repository = root.monthlyBroadcastRepository.createRepository({
        fetchJson: (_url, { signal }) => {
            calls++;
            requestSignal = signal;
            return new Promise((resolve) => {
                resolvePage = resolve;
            });
        },
    });
    const first = new AbortController();
    const stats = repository.calculateStats(
        "a",
        { windowDays: 30, maxPages: 1, maxCalendarPages: 1, calendarEnabled: true },
        { signal: first.signal }
    );
    const cancelled = assert.rejects(stats, { name: "AbortError" });
    const calendar = repository.calculateCalendarMonth("a", 2026, 7, { maxCalendarPages: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    first.abort();
    await cancelled;
    assert.equal(requestSignal.aborted, false);
    resolvePage({ content: { data: [], last: true } });
    const result = await calendar;
    assert.equal(result.pagesLoaded, 1);
    assert.equal(result.partial, false);
    assert.equal(
        await repository.calculateStats(
            "a",
            { windowDays: 30, maxPages: 2, maxCalendarPages: 1 },
            { isCurrent: () => false }
        ),
        null
    );
    assert.equal(calls, 1);
});

test("video model preserves multiline comment matching and only observed playback progress", () => {
    const model = loadDataModules("videoSearch").videoSearchModel;
    const comments = model.extractCommentTexts({
        bestComments: [{ comment: { content: " 첫 줄\r\n둘째 줄 " } }],
        comments: { data: [{ comment: { content: "첫 줄\n둘째 줄" } }] },
    });
    assert.deepEqual(plain(comments), ["첫 줄\n둘째 줄"]);
    const video = model.extractVideos({
        content: { data: [{ videoNo: 7, videoTitle: "제목", duration: 100, watchTimeline: { lastPlaybackTime: 25 } }] },
    })[0];
    assert.equal(video.progressRatio, 0.25);
    assert.equal(model.getWatchProgressRatio(null, 100), null);
    video.commentTexts = comments;
    video.commentNorm = "첫줄둘째줄";
    assert.equal(model.getCommentMatchText(video, "둘째"), "첫 줄\n둘째 줄");
    assert.equal(model.filterVideosByNormalizedQuery([video], "둘째").length, 1);
    assert.equal(model.filterVideosByNormalizedQuery([video], "없음").length, 0);
});

function searchRepository(root, fetchJson, extra = {}) {
    return root.videoSearchRepository.createRepository({
        fetchJson,
        fetchChzzkCommentPage: async () => ({}),
        onLoading() {},
        onIndexStart() {},
        onIndexProgress() {},
        onIndexSettled() {},
        onCommentProgress() {},
        ...extra,
    });
}

const searchOptions = Object.freeze({
    videoSearchEnabled: true,
    videoSearchCommentEnabled: true,
    videoSearchMaxPages: 2,
    videoSearchCommentDelayMs: 0,
    videoSearchCommentMaxVideos: 10,
    videoSearchCommentMaxPagesPerVideo: 1,
});

test("video index cancellation rejects stale results and another repository owns an independent cache", async () => {
    const root = loadDataModules("videoSearch");
    let resolveOld;
    let oldSignal;
    let settled = 0;
    const repository = searchRepository(
        root,
        (_url, { signal }) => {
            oldSignal = signal;
            return new Promise((resolve) => {
                resolveOld = resolve;
            });
        },
        { onIndexSettled: () => settled++ }
    );
    repository.setContext("a", "old", searchOptions);
    const pending = repository.buildIndex("a");
    repository.setContext(null, "", searchOptions);
    repository.stopActiveFetch();
    assert.equal(oldSignal.aborted, true);
    resolveOld({ content: { data: [{ videoNo: 1, videoTitle: "old" }], last: true } });
    await pending;
    assert.equal(repository.getIndex("a").videos.length, 0);
    assert.equal(repository.getIndex("a").complete, false);
    assert.equal(settled, 0);
    const other = searchRepository(root, async () => ({
        content: { data: [{ videoNo: 2, videoTitle: "fresh" }], last: true },
    }));
    other.setContext("a", "fresh", searchOptions);
    assert.equal((await other.buildIndex("a")).videos[0].videoNo, "2");
    assert.equal(repository.getIndex("a").videos.length, 0);
});

test("video comment search reports completed data through callbacks and resets its own cached fields", async () => {
    const timers = [];
    const root = loadDataModules("videoSearch", {
        setTimeout: (callback) => {
            timers.push(callback);
            return timers.length;
        },
        clearTimeout: (id) => {
            timers[id - 1] = null;
        },
    });
    let complete;
    const finished = new Promise((resolve) => {
        complete = resolve;
    });
    const loading = [];
    const repository = searchRepository(
        root,
        async () => ({ content: { data: [{ videoNo: 1, videoTitle: "ordinary title" }], last: true } }),
        {
            fetchChzzkCommentPage: async () => ({
                comments: { data: [{ comment: { content: "needle in comment" } }] },
            }),
            onLoading: (active, reason) => loading.push({ active, reason }),
            onCommentProgress: (options) => {
                if (options?.force) complete();
            },
        }
    );
    repository.setContext("a", "needle", searchOptions);
    await repository.buildIndex("a");
    repository.scheduleCommentSearch();
    timers.find(Boolean)();
    await finished;
    const video = repository.getIndex("a").videos[0];
    assert.equal(video.commentFetched, true);
    assert.equal(video.commentLoading, false);
    assert.equal(video.commentNorm, "needleincomment");
    assert.ok(loading.some((row) => row.reason === "comments" && row.active));
    assert.ok(loading.some((row) => row.reason === "comments" && !row.active));
    repository.resetComments();
    assert.equal(video.commentFetched, false);
    assert.equal(video.commentNorm, "");
    repository.setContext(null, "", searchOptions);
    repository.stopActiveFetch();
});

test("cancelled comment responses cannot repopulate reset data or publish stale progress", async () => {
    const timers = [];
    const root = loadDataModules("videoSearch", {
        setTimeout: (callback) => {
            timers.push(callback);
            return timers.length;
        },
        clearTimeout: (id) => {
            timers[id - 1] = null;
        },
    });
    let resolveComment;
    let signal;
    const progress = [];
    const repository = searchRepository(
        root,
        async () => ({ content: { data: [{ videoNo: 1, videoTitle: "title" }], last: true } }),
        {
            fetchChzzkCommentPage: (request) => {
                signal = request.signal;
                return new Promise((resolve) => {
                    resolveComment = resolve;
                });
            },
            onCommentProgress: (options) => progress.push(options),
        }
    );
    repository.setContext("a", "needle", searchOptions);
    await repository.buildIndex("a");
    repository.scheduleCommentSearch();
    timers.find(Boolean)();
    assert.equal(repository.getIndex("a").videos[0].commentLoading, true);
    repository.setContext("a", "needle", { ...searchOptions, videoSearchCommentEnabled: false });
    repository.cancelCommentSearch();
    repository.resetComments();
    assert.equal(signal.aborted, true);
    resolveComment({ comments: { data: [{ comment: { content: "stale needle" } }] } });
    await new Promise((resolve) => setImmediate(resolve));
    const video = repository.getIndex("a").videos[0];
    assert.equal(video.commentFetched, false);
    assert.equal(video.commentLoading, false);
    assert.equal(video.commentNorm, "");
    assert.deepEqual(plain(video.commentTexts), []);
    assert.equal(progress.length, 0);
});
