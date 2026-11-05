const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const {
    createFakeChrome,
    evalRepoScript,
    evalFeatureModules,
    waitForAsyncCallbacks,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

const repoRoot = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");
const CHANNEL = "0123456789abcdef0123456789abcdef";
const flush = () => new Promise((resolve) => setImmediate(resolve));

function loadModules(globals = {}) {
    const context = vm.createContext({
        AbortController,
        DOMException,
        URLSearchParams,
        setTimeout,
        clearTimeout,
        ...globals,
    });
    vm.runInContext(read("shared/data.js"), context);
    for (const file of ["features/videoSearch/model.js", "features/videoSearch/repository.js"]) {
        vm.runInContext(read(file), context);
    }
    return context.CheeseSpanner;
}

function createFakeTimers() {
    const timers = [];
    return {
        timers,
        globals: {
            setTimeout: (callback) => {
                timers.push(callback);
                return timers.length;
            },
            clearTimeout: (id) => {
                if (id) timers[id - 1] = null;
            },
        },
        fireLatest() {
            for (let index = timers.length - 1; index >= 0; index--) {
                const callback = timers[index];
                if (!callback) continue;
                timers[index] = null;
                callback();
                return true;
            }
            return false;
        },
        pending: () => timers.filter(Boolean).length,
    };
}

const repoOptions = Object.freeze({
    videoSearchEnabled: true,
    videoSearchCommentEnabled: true,
    videoSearchMaxPages: 2,
    videoSearchCommentDelayMs: 1000,
    videoSearchCommentMaxVideos: 2,
    videoSearchCommentMaxPagesPerVideo: 1,
});

function createRepo(root, overrides = {}) {
    return root.videoSearchRepository.createRepository({
        fetchJson: async () => ({ content: { data: [], last: true } }),
        fetchChzzkCommentPage: async () => ({}),
        onLoading() {},
        onIndexStart() {},
        onIndexProgress() {},
        onIndexSettled() {},
        onCommentProgress() {},
        ...overrides,
    });
}

const makeVideos = (count, offset = 0, title = "video") =>
    Array.from({ length: count }, (_, index) => ({
        videoNo: String(1000 + offset + index),
        videoTitle: `${title} ${offset + index}`,
    }));

test("R1-23: a bare numeric watchTimeline is treated as a seconds position, never a ratio or percentage", () => {
    // The seconds unit is the current assumption (detail API meaning); the list API's unit is not measured yet.
    const model = loadModules().videoSearchModel;
    assert.equal(model.getWatchProgressRatio(30, 18000), 30 / 18000);
    assert.equal(model.getWatchProgressRatio(1, 18000), 1 / 18000);
    assert.equal(model.getWatchProgressRatio(100, 18000), 100 / 18000);
    assert.equal(model.getWatchProgressRatio(101, 18000), 101 / 18000);
    assert.equal(model.getWatchProgressRatio("30", 18000), 30 / 18000);
    // Without an observed duration there is no progress to show.
    assert.equal(model.getWatchProgressRatio(30, null), null);
    assert.equal(model.getWatchProgressRatio(30, 0), null);
    const [video] = model.extractVideos({
        content: { data: [{ videoNo: 7, videoTitle: "제목", duration: 18000, watchTimeline: 30 }] },
    });
    assert.equal(video.progressRatio, 30 / 18000);
    // Contrast: explicitly named object fields keep their meaning.
    assert.equal(model.getWatchProgressRatio({ lastPlaybackTime: 25 }, 100), 0.25);
    assert.equal(model.getWatchProgressRatio({ progressRate: 30 }, 18000), 0.3);
});

test("R2-121: a query spanning the end of one comment and the start of another is not a match", async () => {
    const fake = createFakeTimers();
    const timerRoot = loadModules(fake.globals);
    const model = timerRoot.videoSearchModel;
    let done;
    const finished = new Promise((resolve) => {
        done = resolve;
    });
    const repository = createRepo(timerRoot, {
        fetchJson: async () => ({ content: { data: [{ videoNo: 1, videoTitle: "저녁 방송" }], last: true } }),
        fetchChzzkCommentPage: async () => ({
            comments: {
                data: [{ comment: { content: "오늘 재밌었다" } }, { comment: { content: "다음 방송도\n기대" } }],
            },
        }),
        onCommentProgress: (options) => options?.force && done(),
    });
    repository.setContext("a", "기대", repoOptions);
    await repository.buildIndex("a");
    repository.scheduleCommentSearch();
    fake.fireLatest();
    await finished;
    const video = repository.getIndex("a").videos[0];
    assert.equal(video.commentFetched, true);
    // The match test and the icon text pick agree on one comment as the unit.
    for (const [query, expected] of [
        ["었다다음", 0],
        ["재밌었다", 1],
        ["다음방송", 1],
        ["방송도기대", 1],
    ]) {
        assert.equal(model.filterVideosByNormalizedQuery([video], query).length, expected, query);
        assert.equal(Boolean(model.getCommentMatchText(video, query)), Boolean(expected), query);
    }
    assert.equal(model.buildCommentNorm(["감사합니다", "음악 좋네요"]).includes("다음"), false);
});

test("R1-21: changing the query while comments load waits for the delay and stays within the per-query cap", async () => {
    const fake = createFakeTimers();
    const root = loadModules(fake.globals);
    const requests = [];
    const repository = createRepo(root, {
        fetchJson: async () => ({ content: { data: makeVideos(8), last: true } }),
        fetchChzzkCommentPage: ({ objectId, signal }) => {
            const request = { objectId, query: null, resolve: null };
            requests.push(request);
            return new Promise((resolve, reject) => {
                request.resolve = () => resolve({ comments: { data: [] } });
                signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
                    once: true,
                });
            });
        },
    });
    repository.setContext("a", "ab", repoOptions);
    await repository.buildIndex("a");
    repository.scheduleCommentSearch();
    assert.ok(fake.fireLatest());
    await flush();
    assert.equal(requests.length, 2);

    repository.setContext("a", "abc", repoOptions);
    repository.scheduleCommentSearch();
    await flush();
    await flush();
    // The aborted run must not start the new generation before its delay timer.
    assert.equal(requests.length, 2);
    assert.equal(fake.pending(), 1);

    assert.ok(fake.fireLatest());
    for (let round = 0; round < 6; round++) {
        await flush();
        for (const request of requests.slice(2)) request.resolve();
        while (fake.fireLatest());
    }
    // One generation fetches at most videoSearchCommentMaxVideos videos.
    assert.equal(requests.length - 2, repoOptions.videoSearchCommentMaxVideos);
});

// A repository whose index stays loading until released, so a comment run waits on its 250ms index poll.
// Timers keep their delay so the comment delay (1000ms) and the index poll can be fired separately.
function createIndexWaitHarness() {
    const timers = [];
    const root = loadModules({
        setTimeout: (callback, ms) => {
            timers.push({ callback, ms });
            return timers.length;
        },
        clearTimeout: (id) => {
            if (id) timers[id - 1] = null;
        },
    });
    // content.js provides utils.sleep at runtime; same shape, on the fake timers.
    root.utils.sleep = (ms) =>
        new Promise((resolve) => {
            timers.push({ callback: resolve, ms });
        });
    let releaseIndex = null;
    const requests = [];
    const repository = createRepo(root, {
        fetchJson: () =>
            new Promise((resolve) => {
                releaseIndex = () => resolve({ content: { data: makeVideos(8), last: true } });
            }),
        fetchChzzkCommentPage: async ({ objectId }) => {
            requests.push(objectId);
            return { comments: { data: [] } };
        },
    });
    const harness = {
        repository,
        requests,
        fire(ms) {
            let fired = 0;
            for (let index = 0; index < timers.length; index++) {
                const timer = timers[index];
                if (!timer || timer.ms !== ms) continue;
                timers[index] = null;
                timer.callback();
                fired++;
            }
            return fired;
        },
        waiting: (ms) => timers.filter((timer) => timer && timer.ms === ms).length,
        async settle() {
            for (let round = 0; round < 6; round++) await flush();
        },
        async releaseIndex() {
            releaseIndex();
            await harness.building;
            await harness.settle();
        },
        // Search "query" and let its delay end while the index is still loading.
        async startWhileIndexLoads(query) {
            repository.setContext("a", query, repoOptions);
            harness.building = repository.buildIndex("a");
            repository.scheduleCommentSearch();
            assert.equal(harness.fire(1000), 1);
            await harness.settle();
            assert.equal(harness.waiting(250), 1);
        },
        // Change the query and let its delay end while the older run is still busy.
        async searchAndFireDelay(query) {
            repository.setContext("a", query, repoOptions);
            repository.scheduleCommentSearch();
            assert.equal(harness.fire(1000), 1);
            await harness.settle();
        },
        async drain() {
            for (let round = 0; round < 6; round++) {
                await harness.settle();
                harness.fire(250);
                harness.fire(1000);
            }
            await harness.settle();
        },
    };
    return harness;
}

test("R1-21: a start left pending by an older query does not run a newer query before its own delay", async () => {
    const harness = createIndexWaitHarness();
    const { repository, requests } = harness;
    await harness.startWhileIndexLoads("ab"); // A
    await harness.searchAndFireDelay("abc"); // B leaves a pending start behind busy A.

    // C: scheduled after that pending start; it must wait for its own delay.
    repository.setContext("a", "abcd", repoOptions);
    repository.scheduleCommentSearch();
    assert.equal(harness.waiting(1000), 1);
    harness.fire(250);
    await harness.settle();
    await harness.releaseIndex();
    while (harness.fire(250)) await harness.settle();
    assert.equal(requests.length, 0, "no comment request before C's delay timer");

    assert.equal(harness.fire(1000), 1);
    await harness.drain();
    assert.ok(
        requests.length <= repoOptions.videoSearchCommentMaxVideos,
        `C fetched ${requests.length} videos, cap ${repoOptions.videoSearchCommentMaxVideos}`
    );
    assert.equal(requests.length, repoOptions.videoSearchCommentMaxVideos);
});

test("R1-21: a query whose own delay ended while an older run was busy starts once that run exits", async () => {
    const harness = createIndexWaitHarness();
    const { requests } = harness;
    await harness.startWhileIndexLoads("ab"); // A
    await harness.searchAndFireDelay("abc"); // B's delay is already over, so B must not wait again.
    assert.equal(harness.waiting(1000), 0);

    harness.fire(250);
    await harness.settle();
    await harness.releaseIndex();
    while (harness.fire(250)) await harness.settle();
    assert.equal(requests.length, repoOptions.videoSearchCommentMaxVideos, "B starts without another delay");

    await harness.drain();
    assert.equal(requests.length, repoOptions.videoSearchCommentMaxVideos, "B stays within the per-query cap");
});

test("R2-153: an internal fetch timeout is recorded as an index failure, unlike a caller cancellation", async () => {
    const root = loadModules();
    const repository = createRepo(root, {
        fetchJson: async () => {
            throw new DOMException("This operation was aborted", "AbortError");
        },
    });
    repository.setContext("a", "needle", repoOptions);
    const entry = await repository.buildIndex("a");
    assert.equal(entry.error, "조회 시간이 초과됐어요");
    assert.ok(entry.failedAt > 0);
    assert.equal(entry.complete, false);
    assert.equal(entry.loading, false);

    // Contrast: a cancellation through the caller's signal stays silent.
    let release;
    const cancelled = createRepo(root, {
        fetchJson: (_url, { signal }) =>
            new Promise((_resolve, reject) => {
                release = () => reject(new DOMException("aborted", "AbortError"));
                signal.addEventListener("abort", release, { once: true });
            }),
    });
    cancelled.setContext("b", "needle", repoOptions);
    const pending = cancelled.buildIndex("b");
    cancelled.setContext(null, "", repoOptions);
    cancelled.stopActiveFetch();
    const cancelledEntry = await pending;
    assert.equal(cancelledEntry.error, null);
});

test("R1-24/R2-153: comment timeouts are reported per video and retried by the next search generation", async () => {
    const fake = createFakeTimers();
    const root = loadModules(fake.globals);
    let commentCalls = 0;
    let fail = true;
    let settle;
    let settled = new Promise((resolve) => {
        settle = resolve;
    });
    const repository = createRepo(root, {
        fetchJson: async () => ({ content: { data: makeVideos(1), last: true } }),
        fetchChzzkCommentPage: async () => {
            commentCalls++;
            if (fail) throw new DOMException("This operation was aborted", "AbortError");
            return { comments: { data: [{ comment: { content: "needle here" } }] } };
        },
        onCommentProgress: (options) => options?.force && settle(),
    });
    repository.setContext("a", "needle", repoOptions);
    await repository.buildIndex("a");
    repository.scheduleCommentSearch();
    fake.fireLatest();
    await settled;
    const video = repository.getIndex("a").videos[0];
    assert.equal(commentCalls, 1);
    assert.equal(video.commentError, "조회 시간이 초과됐어요");
    assert.equal(video.commentFetched, true);

    fail = false;
    settled = new Promise((resolve) => {
        settle = resolve;
    });
    repository.setContext("a", "needl", repoOptions);
    repository.scheduleCommentSearch();
    fake.fireLatest();
    await settled;
    assert.equal(commentCalls, 2);
    assert.equal(video.commentError, null);
    assert.equal(video.commentNorm, "needlehere");
});

test("R1-24: an index cut off by the page limit is marked separately from a channel read to its end", async () => {
    const root = loadModules();
    const limited = createRepo(root, {
        fetchJson: async (url) => {
            const page = Number(new URL(url).searchParams.get("page"));
            return { content: { data: makeVideos(30, page * 30), last: false } };
        },
    });
    limited.setContext("a", "needle", repoOptions);
    const cut = await limited.buildIndex("a");
    assert.equal(cut.complete, true);
    assert.equal(cut.limitReached, true);
    assert.equal(cut.videos.length, 60);

    const whole = createRepo(root, {
        fetchJson: async (url) => {
            const page = Number(new URL(url).searchParams.get("page"));
            return { content: { data: makeVideos(30, page * 30), last: page === 1 } };
        },
    });
    whole.setContext("a", "needle", repoOptions);
    const full = await whole.buildIndex("a");
    assert.equal(full.complete, true);
    assert.equal(full.limitReached, false);
});

// ---- page-level regressions -------------------------------------------------------------------------------

const openDoms = new Set();
test.afterEach(() => {
    for (const dom of openDoms) dom.window.close();
    openDoms.clear();
});

function createVideoSearchPage(chrome, { cards, extra = "" } = {}) {
    const html = [
        "<!doctype html><body><main id='app'><div id='wrap'>",
        "<section id='grid'>",
        cards ||
            [
                "<article><a href='/video/100'><strong>Existing 100</strong><span>1:00</span></a></article>",
                "<article><a href='/video/101'><strong>Existing 101</strong><span>1:00</span></a></article>",
            ].join(""),
        "</section>",
        extra,
        "</div></main></body>",
    ].join("");
    const dom = new JSDOM(html, {
        url: `https://chzzk.naver.com/${CHANNEL}/videos`,
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
        close();
    };
    dom.window.fetch = async () => {
        throw new Error("Unexpected network request in page test");
    };
    return dom;
}

async function loadPage(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "shared", "vodTimeline.js");
    evalFeatureModules(dom, "videoSearch");
    evalRepoScript(dom, "features", "videoSearch.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();
    await waitForCondition(() => getInput(dom));
}

const getInput = (dom) => dom.window.document.querySelector("#cheese-spanner-video-search-bar input");
const getStatus = (dom) => dom.window.document.querySelector("#cheese-spanner-video-search-bar .bcvs-status");

function typeQuery(dom, value) {
    const input = getInput(dom);
    input.value = value;
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

function changeOptions(chrome, values) {
    const changes = {};
    for (const [key, newValue] of Object.entries(values)) {
        changes[key] = { oldValue: chrome.testState.sync[key], newValue };
        chrome.testState.sync[key] = newValue;
    }
    for (const listener of [...chrome.testState.storageChangeListeners]) listener(changes, "sync");
}

function jsonResponse(body) {
    return { ok: true, status: 200, json: async () => body };
}

function pageOf(url) {
    return new URL(String(url)).searchParams.get("page");
}

test("R1-24: a later index page failure is shown as a partial lookup, not a complete result", async () => {
    const chrome = createFakeChrome({ sync: { videoSearchCommentEnabled: false, videoSearchMaxPages: 3 } });
    const dom = createVideoSearchPage(chrome);
    const pages = [];
    dom.window.fetch = async (url) => {
        pages.push(pageOf(url));
        if (pageOf(url) === "1") return { ok: false, status: 429, json: async () => ({}) };
        return jsonResponse({ content: { data: makeVideos(30), last: false } });
    };
    await loadPage(dom);
    typeQuery(dom, "old title");
    await waitForCondition(() => pages.includes("1"));
    await waitForCondition(() => getStatus(dom).textContent.includes("일부 조회 실패"));
    assert.equal(getStatus(dom).textContent, "0 / 30 (일부 조회 실패)");
});

test("R1-24: an index stopped by the page limit says so instead of reading as the whole channel", async () => {
    const chrome = createFakeChrome({ sync: { videoSearchCommentEnabled: false, videoSearchMaxPages: 1 } });
    const dom = createVideoSearchPage(chrome);
    dom.window.fetch = async () => jsonResponse({ content: { data: makeVideos(30), last: false } });
    await loadPage(dom);
    typeQuery(dom, "old title");
    await waitForCondition(() => getStatus(dom).textContent.startsWith("0 / 30"));
    assert.equal(getStatus(dom).textContent, "0 / 30 (조회 상한까지)");
});

test("R1-24: failed comment lookups are counted in the status", async () => {
    const chrome = createFakeChrome({ sync: { videoSearchCommentDelayMs: 0, videoSearchMaxPages: 1 } });
    const dom = createVideoSearchPage(chrome);
    let commentCalls = 0;
    dom.window.fetch = async (url) => {
        if (String(url).includes("/videos?")) {
            return jsonResponse({ content: { data: makeVideos(2), last: true } });
        }
        commentCalls++;
        return { ok: false, status: 500, json: async () => ({}) };
    };
    await loadPage(dom);
    typeQuery(dom, "needle");
    await waitForCondition(() => commentCalls === 2);
    await waitForCondition(() => getStatus(dom).textContent.includes("댓글"));
    assert.equal(getStatus(dom).textContent, "0 / 2 (댓글 2개 조회 실패)");
});

test("R1-C5: turning comment search off stops cached comments from matching", async () => {
    const chrome = createFakeChrome({ sync: { videoSearchCommentDelayMs: 0, videoSearchMaxPages: 1 } });
    const dom = createVideoSearchPage(chrome);
    const { document } = dom.window;
    dom.window.fetch = async (url) => {
        if (String(url).includes("/videos?")) {
            return jsonResponse({
                content: {
                    data: [
                        { videoNo: "100", videoTitle: "Existing 100" },
                        { videoNo: "200", videoTitle: "plain title" },
                    ],
                    last: true,
                },
            });
        }
        return jsonResponse({ content: { comments: { data: [{ comment: { content: "needle comment" } }] } } });
    };
    await loadPage(dom);
    typeQuery(dom, "needle");
    await waitForCondition(() => getStatus(dom).textContent === "2 / 2");
    await waitForCondition(() => document.querySelectorAll('[data-bcvs-injected="1"]').length === 2);

    changeOptions(chrome, { videoSearchCommentEnabled: false });
    await waitForCondition(() => getStatus(dom).textContent === "0 / 2");
    await waitForCondition(() => document.querySelectorAll('[data-bcvs-injected="1"]').length === 0);

    // Re-enabling uses the still valid cache again.
    changeOptions(chrome, { videoSearchCommentEnabled: true });
    await waitForCondition(() => getStatus(dom).textContent === "2 / 2");
});

test("R2-122: a whitespace-only query keeps the original list and page buttons", async () => {
    const chrome = createFakeChrome({ sync: { videoSearchCommentEnabled: false, videoSearchMaxPages: 3 } });
    const pagination = "<div id='pages'><ol><li><button>1</button></li><li><button>2</button></li></ol></div>";
    const dom = createVideoSearchPage(chrome, { extra: pagination });
    const { document } = dom.window;
    const pages = [];
    dom.window.fetch = async (url, init = {}) => {
        pages.push(pageOf(url));
        if (pageOf(url) === "0") {
            return jsonResponse({
                content: { data: [{ videoNo: "100", videoTitle: "Existing 100" }, ...makeVideos(29)], last: false },
            });
        }
        return new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
                once: true,
            });
        });
    };
    await loadPage(dom);
    typeQuery(dom, "zzz");
    await waitForCondition(() => pages.includes("1"));
    await waitForAsyncCallbacks();
    typeQuery(dom, "");
    typeQuery(dom, " ");
    await waitForAsyncCallbacks();

    assert.equal(document.querySelectorAll('[data-bcvs-injected="1"]').length, 0);
    assert.equal(document.querySelectorAll('#grid > [data-bcvs-hide="1"]').length, 0);
    assert.equal(document.getElementById("pages").hasAttribute("data-bcvs-hide"), false);
    assert.equal(getStatus(dom).textContent, "30개");
});

test("R2-123: a result card without its own thumbnail, duration or date keeps none of the template's", async () => {
    const chrome = createFakeChrome({ sync: { videoSearchCommentEnabled: false, videoSearchMaxPages: 1 } });
    const cards = [
        "<article><a href='/video/100'><img src='https://example.com/template-thumb.jpg' srcset='https://example.com/template-thumb.jpg 2x' alt=''>",
        "<strong>Existing 100</strong><span class='dur'>1:23:45</span><span class='date'>24.05.01</span></a></article>",
        "<article><a href='/video/101'><strong>Existing 101</strong><span>1:00</span></a></article>",
    ].join("");
    const dom = createVideoSearchPage(chrome, { cards });
    const { document } = dom.window;
    dom.window.fetch = async () =>
        jsonResponse({
            content: {
                data: [
                    {
                        videoNo: "100",
                        videoTitle: "Existing 100",
                        duration: 5025,
                        publishDate: "2024-05-01 10:00:00",
                        thumbnailImageUrl: "https://example.com/template-thumb.jpg",
                    },
                    {
                        videoNo: "200",
                        videoTitle: "needle video",
                        thumbnailImageUrl: null,
                        duration: null,
                        publishDate: "",
                    },
                    {
                        videoNo: "300",
                        videoTitle: "needle known",
                        duration: 65,
                        publishDate: "2025-01-02 10:00:00",
                        thumbnailImageUrl: "https://example.com/300.jpg",
                    },
                ],
                last: true,
            },
        });
    await loadPage(dom);
    typeQuery(dom, "needle");
    await waitForCondition(() => document.querySelectorAll('[data-bcvs-injected="1"]').length === 2);

    const missing = document.querySelector('[data-bcvs-injected="1"] a[href="/video/200"]').closest("article");
    const img = missing.querySelector("img");
    assert.equal(img.hasAttribute("src"), false);
    assert.equal(img.hasAttribute("srcset"), false);
    assert.equal(img.style.visibility, "hidden");
    assert.equal(missing.querySelector(".dur").textContent, "");
    assert.equal(missing.querySelector(".date").textContent, "");
    assert.equal(missing.textContent.includes("1:23:45"), false);
    assert.equal(missing.textContent.includes("24.05.01"), false);

    // Contrast: observed values still replace the template's.
    const known = document.querySelector('[data-bcvs-injected="1"] a[href="/video/300"]').closest("article");
    assert.equal(known.querySelector("img").getAttribute("src"), "https://example.com/300.jpg");
    assert.equal(known.querySelector(".dur").textContent, "1:05");
    assert.equal(known.querySelector(".dur").style.visibility, "");
    assert.equal(known.querySelector(".date").textContent, "25.01.02");
});

function limitedIndexFetch(dom, pages) {
    dom.window.fetch = async (url) => {
        const page = pageOf(url);
        pages.push(page);
        return jsonResponse({
            content: { data: makeVideos(30, Number(page) * 30, "needle"), last: page === "4" },
        });
    };
}

test("R2-124: a page limit changed while the feature is off still invalidates the cached index", async () => {
    const chrome = createFakeChrome({ sync: { videoSearchCommentEnabled: false, videoSearchMaxPages: 1 } });
    const dom = createVideoSearchPage(chrome);
    const pages = [];
    limitedIndexFetch(dom, pages);
    await loadPage(dom);
    typeQuery(dom, "needle");
    await waitForCondition(() => getStatus(dom).textContent.startsWith("30 / 30"));

    changeOptions(chrome, { videoSearchEnabled: false });
    await waitForCondition(() => !getInput(dom));
    changeOptions(chrome, { videoSearchMaxPages: 2 });
    changeOptions(chrome, { videoSearchEnabled: true });
    await waitForCondition(() => getInput(dom));
    typeQuery(dom, "needle");
    await waitForCondition(() => getStatus(dom).textContent.startsWith("60 / 60"));
    assert.deepEqual(pages, ["0", "0", "1"]);
});

test("R2-124: a page limit changed on another channel tab still invalidates the cached index", async () => {
    const chrome = createFakeChrome({ sync: { videoSearchCommentEnabled: false, videoSearchMaxPages: 1 } });
    const dom = createVideoSearchPage(chrome);
    const pages = [];
    limitedIndexFetch(dom, pages);
    await loadPage(dom);
    typeQuery(dom, "needle");
    await waitForCondition(() => getStatus(dom).textContent.startsWith("30 / 30"));

    dom.window.history.pushState({}, "", `/${CHANNEL}`);
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await waitForCondition(() => !getInput(dom));
    changeOptions(chrome, { videoSearchMaxPages: 2 });
    dom.window.history.pushState({}, "", `/${CHANNEL}/videos`);
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await waitForCondition(() => getInput(dom));
    typeQuery(dom, "needle");
    await waitForCondition(() => getStatus(dom).textContent.startsWith("60 / 60"));
    assert.deepEqual(pages, ["0", "0", "1"]);
});
