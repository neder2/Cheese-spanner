const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const liveRoute = { scope: "category", categoryType: "game", categoryId: "test", tab: "lives" };
const nextCursor = { concurrentUserCount: 10, liveId: 42 };

function page(rows, next = null) {
    return { content: { data: rows, page: { next } } };
}

function live(id, title = id) {
    return { channel: { channelId: id, channelName: id }, liveTitle: title, concurrentUserCount: 10 };
}

function category(categoryId, categoryType = "GAME", categoryValue = categoryId) {
    return { categoryType, categoryId, categoryValue, concurrentUserCount: 1 };
}

function categories(rows) {
    return { code: 200, content: { results: rows } };
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

function fixture(fetchJson, callbacks = {}) {
    let now = 10000;
    let timerId = 0;
    const timers = new Map();
    const context = vm.createContext({
        AbortController,
        URLSearchParams,
        Date: class extends Date {
            static now() {
                return now;
            }
        },
        performance: { now: () => now },
        setTimeout(callback, delay) {
            const id = ++timerId;
            timers.set(id, { callback, delay, at: now + delay });
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
    });
    for (const file of [
        "shared/data.js",
        "shared/categoryExclusions.js",
        "features/categoryTools/repository.js",
        "features/categoryTools/searchController.js",
    ]) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
    }
    const repository = context.BetterChzzk.categoryToolsRepository.createRepository({
        fetchJson: (url, options) => {
            const match = url.match(/\/categories\/([^/]+)\/([^/]+)\/info$/);
            if (match) {
                if (callbacks.categoryInfo) return callbacks.categoryInfo(url, options);
                return Promise.resolve({
                    code: 200,
                    content: {
                        categoryType: decodeURIComponent(match[1]),
                        categoryId: decodeURIComponent(match[2]),
                        concurrentUserCount: 1,
                    },
                });
            }
            return fetchJson(url, options);
        },
        touchMapEntry: context.BetterChzzk.utils.touchMapEntry,
        ...callbacks,
    });
    return {
        repository,
        timers,
        advance(ms) {
            now += ms;
        },
        async nextTimer() {
            const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] || [];
            assert.ok(timer, "a pending lifecycle timer should exist");
            now = Math.max(now, timer.at);
            timers.delete(id);
            timer.callback();
            await flush();
            return timer.delay;
        },
        searchController(callbacks) {
            return context.BetterChzzk.categoryToolsSearchController.createSearchController({
                repository,
                ...callbacks,
            });
        },
    };
}

const hydration = { maxPerPass: 3, concurrency: 2, delayMs: 700, clearWhenDone: true, shouldContinue: () => true };

test("category search uses the measured autocomplete endpoint and includes categories with no broadcasts", async () => {
    const requests = [];
    const source = Object.freeze({
        ...category("Marimo_League", "GAME", "마리모 리그"),
        openLiveCount: 0,
        liveCategory: "unrelated",
        url: "https://example.invalid/ignored",
    });
    const { repository } = fixture(async (url, options) => {
        requests.push({ url: new URL(url), ...options });
        return categories([source]);
    });
    assert.deepEqual(plain(await repository.searchCategories("  마리모 & GAME?size=100  ")), [
        category("Marimo_League", "GAME", "마리모 리그"),
    ]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.origin, "https://api.chzzk.naver.com");
    assert.equal(requests[0].url.pathname, "/manage/v1/auto-complete/categories");
    assert.equal(requests[0].url.searchParams.get("keyword"), "마리모 & GAME?size=100");
    assert.equal(requests[0].url.searchParams.get("size"), "50");
    assert.deepEqual([...requests[0].url.searchParams.keys()], ["keyword", "size"]);
    assert.equal(requests[0].headers.Accept, "application/json");
    assert.equal(requests[0].signal.aborted, false);
    assert.equal(repository.metadataState().size, 0, "autocomplete must not download or populate live metadata");
});

test("category search preserves server order for equal viewers and deduplicates exact identity without folding ID case", async () => {
    const invalid = [
        null,
        "text",
        {},
        [],
        category("missing", "game"),
        category("missing", "A".repeat(33)),
        category("."),
        category(".."),
        category(" "),
        category("id\u007f"),
        category("a".repeat(201)),
        category("bad-name", "GAME", " "),
        category("bad-name", "GAME", "name\n"),
        category("bad-name", "GAME", "a".repeat(201)),
    ];
    const first = category("Case_ID", "GAME", "첫 결과");
    const sameIdOtherType = category("Case_ID", "ETC", "같은 이름");
    const caseVariant = category("case_id", "GAME", "첫 결과");
    const literal = category("literal", "GAME", "<img src=x onerror=alert(1)>");
    const { repository } = fixture(async () =>
        categories([
            first,
            ...invalid,
            { ...category("Case_ID", "GAME", "중복 이름"), categoryKey: "server-added-field" },
            sameIdOtherType,
            caseVariant,
            literal,
        ])
    );
    assert.deepEqual(plain(await repository.searchCategories("검색")), [first, sameIdOtherType, caseVariant, literal]);
});

test("category search ranks measured viewers, hides zero only, preserves distinct same-name IDs and retries unknown counts", async () => {
    const rows = [
        category("low", "GAME", "같은 이름"),
        category("zero"),
        category("high", "GAME", "같은 이름"),
        category("low"),
        category("unknown"),
        category("mismatch"),
        category("invalid"),
    ];
    const requested = [];
    let retry = false;
    const { repository } = fixture(async () => categories(rows), {
        categoryInfo: async (url) => {
            const id = url.match(/\/([^/]+)\/info$/)[1];
            requested.push(id);
            if (id === "unknown" && !retry) throw new Error("timeout");
            return {
                code: 200,
                content: {
                    categoryType: "GAME",
                    categoryId: id === "mismatch" ? "other" : id,
                    concurrentUserCount: { low: 5, zero: 0, high: 200, unknown: 10, mismatch: 999, invalid: -1 }[id],
                },
            };
        },
    });
    const first = plain(await repository.searchCategories("같은"));
    assert.deepEqual(
        first.map((row) => row.categoryId),
        ["high", "low", "unknown", "mismatch", "invalid"]
    );
    assert.equal(first[0].concurrentUserCount, 200);
    assert.equal(first[1].categoryValue, "같은 이름");
    assert.equal(Object.hasOwn(first[2], "concurrentUserCount"), false);
    assert.equal(requested.filter((id) => id === "low").length, 1);
    retry = true;
    const second = plain(await repository.searchCategories("같은"));
    assert.deepEqual(
        second.map((row) => row.categoryId),
        ["high", "unknown", "low", "mismatch", "invalid"]
    );
    assert.equal(
        requested.filter((id) => id === "high").length,
        1,
        "known viewer counts share bounded cache across retries"
    );
    assert.equal(requested.filter((id) => id === "unknown").length, 2, "failed counts are not cached as zero");
});

test("category viewer lookup limits concurrency to four and abort prevents further requests or stale cache", async () => {
    const gates = [];
    const { repository } = fixture(async () => categories(Array.from({ length: 12 }, (_, i) => category(String(i)))), {
        categoryInfo: (url, { signal }) => {
            const gate = deferred();
            gates.push({ ...gate, url, signal });
            return gate.promise;
        },
    });
    const controller = new AbortController();
    const pending = repository.searchCategories("취소", { signal: controller.signal });
    await flush();
    assert.equal(gates.length, 4);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    for (const [i, gate] of gates.entries()) {
        assert.equal(gate.signal.aborted, true);
        gate.resolve({ code: 200, content: { categoryType: "GAME", categoryId: String(i), concurrentUserCount: 999 } });
    }
    await flush();
    assert.equal(gates.length, 4, "cancelled lookup does not schedule later batches");
    const nextController = new AbortController();
    const next = repository.searchCategories("취소", { signal: nextController.signal });
    await flush();
    assert.equal(gates.length, 8, "late cancelled counts never populate cache");
    nextController.abort();
    await assert.rejects(next, { name: "AbortError" });
    for (const gate of gates.slice(4)) gate.resolve({ code: 500 });
    await flush();
});

test("category search rejects malformed responses and all-invalid rows but accepts a real empty array", async () => {
    for (const payload of [
        null,
        {},
        { content: { results: [] } },
        { code: "200", content: { results: [] } },
        { code: 500, content: { results: [] } },
        { code: 200, content: {} },
        categories(null),
        categories({}),
        categories("not an array"),
        categories([null, {}, category("one", "game")]),
    ]) {
        let calls = 0;
        const { repository, timers } = fixture(async () => {
            calls++;
            return payload;
        });
        await assert.rejects(repository.searchCategories("실패"), /unavailable/i);
        await assert.rejects(repository.searchCategories("실패"), /unavailable/i);
        assert.equal(calls, 2, "invalid responses must not be cached");
        assert.equal(timers.size, 0, "search failures must not create an automatic retry loop");
    }
    let calls = 0;
    const { repository } = fixture(async () => {
        calls++;
        return categories([]);
    });
    assert.deepEqual(plain(await repository.searchCategories("없음")), []);
    assert.deepEqual(plain(await repository.searchCategories("없음")), []);
    assert.equal(calls, 1, "a successful empty result is cacheable");
});

test("category search skips empty input and rejects oversized or non-string input before a request", async () => {
    let calls = 0;
    const { repository } = fixture(async () => {
        calls++;
        return categories([]);
    });
    for (const input of ["", "  ", "\t\n"]) assert.deepEqual(plain(await repository.searchCategories(input)), []);
    for (const input of [null, undefined, 1, {}, "키".repeat(101)]) {
        await assert.rejects(repository.searchCategories(input), /keyword/i);
    }
    assert.equal(calls, 0);
    await repository.searchCategories("키".repeat(100));
    assert.equal(calls, 1);
});

test("category search bounds each result list at fifty unique valid results", async () => {
    const rows = Array.from({ length: 60 }, (_, index) => category(String(index)));
    const { repository } = fixture(async () => categories([null, rows[0], rows[0], ...rows.slice(1)]));
    const result = await repository.searchCategories("많은 결과");
    assert.equal(result.length, 50);
    assert.deepEqual(plain(result), rows.slice(0, 50));
});

test("category search retries network and timeout failures without discarding a previous successful cache", async () => {
    for (const error of [new Error("offline"), Object.assign(new Error("timeout"), { name: "AbortError" })]) {
        let calls = 0;
        const { repository, timers } = fixture(async () => {
            if (++calls === 2) throw error;
            return categories([category(String(calls))]);
        });
        assert.deepEqual(plain(await repository.searchCategories("보존")), [category("1")]);
        await assert.rejects(repository.searchCategories("재시도"), (actual) => actual === error);
        assert.deepEqual(plain(await repository.searchCategories("재시도")), [category("3")]);
        assert.deepEqual(plain(await repository.searchCategories("보존")), [category("1")]);
        assert.equal(calls, 3);
        assert.equal(timers.size, 0);
    }
});

test("out-of-order category searches keep results and caches bound to their own keyword", async () => {
    const requests = [];
    const { repository } = fixture((url, options) => {
        const request = { url, ...options, ...deferred() };
        requests.push(request);
        return request.promise;
    });
    const first = repository.searchCategories("먼저");
    const second = repository.searchCategories("나중");
    requests[1].resolve(categories([category("second")]));
    assert.deepEqual(plain(await second), [category("second")]);
    requests[0].resolve(categories([category("first")]));
    assert.deepEqual(plain(await first), [category("first")]);
    assert.deepEqual(plain(await repository.searchCategories("먼저")), [category("first")]);
    assert.deepEqual(plain(await repository.searchCategories("나중")), [category("second")]);
    assert.equal(requests.length, 2);
});

test("category search shares one request but an aborted consumer leaves another consumer and its cache intact", async () => {
    const requests = [];
    const { repository } = fixture((url, options) => {
        const request = { ...options, ...deferred() };
        requests.push(request);
        return request.promise;
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = repository.searchCategories("공유", { signal: firstController.signal });
    const second = repository.searchCategories("공유", { signal: secondController.signal });
    const rejected = assert.rejects(first, { name: "AbortError" });
    assert.notEqual(first, second, "each consumer needs an independent cancellation promise");
    assert.equal(requests.length, 1);
    firstController.abort();
    await rejected;
    assert.equal(requests[0].signal.aborted, false);
    requests[0].resolve(categories([category("kept")]));
    assert.deepEqual(plain(await second), [category("kept")]);
    secondController.abort();
    assert.deepEqual(plain(await repository.searchCategories("공유")), [category("kept")]);
    assert.equal(requests.length, 1);
});

test("category search aborts its request only after its last consumer cancels and a fresh search can share again", async () => {
    const requests = [];
    const { repository } = fixture((url, options) => {
        const request = { ...options, ...deferred() };
        requests.push(request);
        return request.promise;
    });
    const controllers = [new AbortController(), new AbortController()];
    const pending = controllers.map((controller) => repository.searchCategories("공유", { signal: controller.signal }));
    const rejected = pending.map((promise) => assert.rejects(promise, { name: "AbortError" }));
    controllers[0].abort();
    assert.equal(requests[0].signal.aborted, false);
    controllers[1].abort();
    assert.equal(requests[0].signal.aborted, true);
    await Promise.all(rejected);
    const current = repository.searchCategories("공유");
    requests[0].resolve(categories([category("old")]));
    await flush();
    const sharedCurrent = repository.searchCategories("공유");
    assert.equal(requests.length, 2, "the old completion must neither fill cache nor clear the current request");
    requests[1].resolve(categories([category("current")]));
    assert.deepEqual(plain(await current), [category("current")]);
    assert.deepEqual(plain(await sharedCurrent), [category("current")]);
});

test("category search cancellation isolates lifecycle generations and old success or failure cannot erase a newer cache", async () => {
    for (const lateFailure of [false, true]) {
        const requests = [];
        const { repository } = fixture((url, options) => {
            const request = { ...options, ...deferred() };
            requests.push(request);
            return request.promise;
        });
        const old = repository.searchCategories("세대");
        const rejected = assert.rejects(old, { name: "AbortError" });
        repository.cancelCategorySearch();
        assert.equal(requests[0].signal.aborted, true);
        await rejected;
        const current = repository.searchCategories("세대");
        requests[1].resolve(categories([category("current")]));
        assert.deepEqual(plain(await current), [category("current")]);
        if (lateFailure) requests[0].reject(new Error("old failure"));
        else requests[0].resolve(categories([category("old")]));
        await flush();
        assert.deepEqual(plain(await repository.searchCategories("세대")), [category("current")]);
        assert.equal(requests.length, 2);
    }
});

test("category lifecycle cancellation stops every pending keyword while preserving completed cache entries", async () => {
    const requests = [];
    const { repository } = fixture((url, options) => {
        const request = { ...options, ...deferred() };
        requests.push(request);
        return request.promise;
    });
    const cached = repository.searchCategories("보관");
    requests[0].resolve(categories([category("cached")]));
    await cached;
    const pending = [repository.searchCategories("첫 입력"), repository.searchCategories("다른 입력")];
    const rejected = pending.map((promise) => assert.rejects(promise, { name: "AbortError" }));
    repository.cancelCategorySearch();
    assert.equal(requests[1].signal.aborted, true);
    assert.equal(requests[2].signal.aborted, true);
    await Promise.all(rejected);
    requests[1].resolve(categories([category("ignored")]));
    requests[2].reject(new Error("late failure"));
    await flush();
    assert.deepEqual(plain(await repository.searchCategories("보관")), [category("cached")]);
    assert.equal(requests.length, 3);
});

test("already-aborted category search consumers do not join or start a network request", async () => {
    let calls = 0;
    const { repository } = fixture(async () => {
        calls++;
        return categories([category("cached")]);
    });
    await repository.searchCategories("보관");
    const controller = new AbortController();
    controller.abort();
    for (const keyword of ["새 입력", "보관"]) {
        await assert.rejects(repository.searchCategories(keyword, { signal: controller.signal }), {
            name: "AbortError",
        });
    }
    assert.equal(calls, 1);
});

test("category search keeps at most twenty keywords, refreshes LRU access and expires after five minutes", async () => {
    let calls = 0;
    const { repository, advance } = fixture(async () => categories([category(String(++calls))]));
    for (let index = 0; index < 20; index++) await repository.searchCategories(String(index));
    assert.deepEqual(plain(await repository.searchCategories("0")), [category("1")]);
    await repository.searchCategories("20");
    assert.deepEqual(plain(await repository.searchCategories("0")), [category("1")]);
    await repository.searchCategories("1");
    assert.equal(calls, 22, "entry 1 should be evicted while recently used entry 0 stays cached");
    advance(5 * 60 * 1000 - 1);
    assert.deepEqual(plain(await repository.searchCategories("0")), [category("1")]);
    advance(1);
    assert.deepEqual(plain(await repository.searchCategories("0")), [category("23")]);
    assert.equal(calls, 23, "reading cached results must not renew the measurement time");
});

test("category search results cannot be mutated to corrupt another consumer or a later cache read", async () => {
    const pending = deferred();
    let calls = 0;
    const { repository } = fixture(() => {
        calls++;
        return pending.promise;
    });
    const first = repository.searchCategories("자료");
    const second = repository.searchCategories("자료");
    pending.resolve(categories([category("original")]));
    const firstResult = await first;
    firstResult[0].categoryId = "changed";
    firstResult.push(category("inserted"));
    assert.deepEqual(plain(await second), [category("original")]);
    assert.deepEqual(plain(await repository.searchCategories("자료")), [category("original")]);
    assert.equal(calls, 1);
});

test("category search cancellation leaves live metadata, aggregate and follower requests independent", async () => {
    const requests = [];
    const { repository } = fixture((url, options) => {
        const request = { url: new URL(url), ...options, ...deferred() };
        requests.push(request);
        return request.promise;
    });
    const metadata = repository.ensureMetadata({ scope: "global-lives", tab: "lives" });
    const count = repository.countGlobalLives();
    const followers = repository.getFollowerCount("channel");
    const categorySearch = repository.searchCategories("이름");
    const rejected = assert.rejects(categorySearch, { name: "AbortError" });
    repository.cancelCategorySearch();
    assert.equal(requests.length, 3);
    assert.equal(requests[0].signal.aborted, false);
    assert.equal(requests[1].signal.aborted, false);
    assert.equal(requests[2].signal.aborted, true);
    requests[0].resolve(page([{ ...live("channel"), liveId: 1, concurrentUserCount: 20 }]));
    requests[1].resolve({ content: { followerCount: 5 } });
    requests[2].resolve(categories([category("late")]));
    await rejected;
    assert.equal((await metadata).size, 1);
    assert.equal((await count).totalViewers, 20);
    assert.equal(await followers, 5);
    const current = repository.searchCategories("다음 이름");
    repository.cancelMetadataSearch();
    repository.cancelGlobalLiveCount();
    repository.cancelFollowers();
    assert.equal(requests[3].signal.aborted, false, "other lifecycle cancellations must not abort autocomplete");
    requests[3].resolve(categories([category("current")]));
    assert.deepEqual(plain(await current), [category("current")]);
});

test("live metadata preserves category identity and all existing consumer fields when API names change", async () => {
    const original = {
        channel: { channelId: "channel", channelName: "방송인", channelImageUrl: "channel-image" },
        liveId: 42,
        liveTitle: "방송 제목",
        liveImageUrl: "live-image",
        defaultThumbnailImageUrl: "fallback-image",
        openDate: "2026-09-30 12:00:00",
        concurrentUserCount: "123",
        categoryType: "GAME",
        liveCategory: "Case_ID",
        liveCategoryValue: "예전 이름",
        categoryId: "must-not-overwrite",
        categoryValue: "must-not-overwrite",
        tags: ["태그"],
        adult: true,
    };
    let calls = 0;
    const { repository } = fixture(async () =>
        ++calls === 1
            ? page([original], { concurrentUserCount: 0, liveId: 0 })
            : page([{ ...original, liveCategoryValue: "새 이름" }, live("unknown")])
    );
    const metadata = await repository.ensureMetadata({ scope: "global-lives", tab: "lives" });
    assert.deepEqual(plain(metadata.get("channel")), {
        id: "channel",
        channelId: "channel",
        title: "방송 제목",
        channelName: "방송인",
        channelImageUrl: "channel-image",
        thumb: "live-image",
        duration: null,
        publishDate: "2026-09-30 12:00:00",
        views: 123,
        categoryType: "GAME",
        categoryId: "Case_ID",
        categoryName: "예전 이름",
        tags: ["태그"],
        liveId: 42,
        adult: true,
        order: 0,
    });
    assert.deepEqual(plain(repository.metadataState().next), { concurrentUserCount: 0, liveId: 0 });
    await repository.loadNextMetadata({ scope: "global-lives", tab: "lives" });
    assert.equal(metadata.get("channel").categoryName, "새 이름");
    assert.equal(metadata.get("channel").categoryType, "GAME");
    assert.equal(metadata.get("channel").categoryId, "Case_ID");
    assert.equal(metadata.get("channel").order, 0);
    assert.equal(metadata.get("unknown").categoryType, "");
    assert.equal(metadata.get("unknown").categoryId, "");
    assert.equal(metadata.get("unknown").categoryName, "");
});

test("global count cancellation preserves a search consumer and stops count-only pagination", async () => {
    const requests = [];
    const { repository, timers } = fixture((url, options) => {
        const pending = deferred();
        requests.push({ url, ...options, ...pending });
        return pending.promise;
    });
    const route = { scope: "global-lives", tab: "lives" };
    const search = repository.ensureMetadata(route);
    const count = repository.countGlobalLives();
    const rejected = assert.rejects(count, /cancelled/);
    repository.cancelGlobalLiveCount();
    assert.equal(requests[0].signal.aborted, false);
    requests[0].resolve(page([{ ...live("a"), liveId: 1 }], nextCursor));
    assert.equal((await search).size, 1);
    await rejected;
    assert.equal(requests.length, 1);
    const next = repository.countGlobalLives();
    const nextRejected = assert.rejects(next, /cancelled/);
    await flush();
    assert.equal(requests.length, 2);
    repository.cancelGlobalLiveCount();
    assert.equal(requests[1].signal.aborted, true);
    requests[1].reject(new Error("late abort"));
    await nextRejected;
    assert.equal(timers.size, 0);
});

test("search cancellation preserves count work and cancelled pages cannot contaminate a new count", async () => {
    const requests = [];
    const { repository } = fixture((url, options) => {
        const pending = deferred();
        requests.push({ url, ...options, ...pending });
        return pending.promise;
    });
    const search = repository.ensureMetadata({ scope: "global-lives", tab: "lives" });
    const count = repository.countGlobalLives();
    repository.cancelMetadataSearch();
    assert.equal(requests[0].signal.aborted, false);
    requests[0].resolve(page([{ ...live("a"), liveId: 1 }]));
    await search;
    assert.equal((await count).count, 1);
    repository.resetMetadata();
    const first = repository.countGlobalLives();
    assert.equal((await first).count, 1, "completed count remains cached across routes");
});

test("expired global count re-fetches completed metadata instead of re-dating stale rows", async () => {
    let calls = 0;
    const { repository, advance } = fixture(async () =>
        page([{ ...live("a"), liveId: 1, concurrentUserCount: ++calls * 10 }])
    );
    assert.equal((await repository.countGlobalLives()).totalViewers, 10);
    advance(5 * 60 * 1000);
    assert.equal((await repository.countGlobalLives()).totalViewers, 20);
    assert.equal(calls, 2);
});

test("expired count joins a fresh search page without cancelling the search", async () => {
    const requests = [];
    const { repository, advance } = fixture((url, options) => {
        const pending = deferred();
        requests.push({ ...options, ...pending });
        return pending.promise;
    });
    const first = repository.countGlobalLives();
    requests[0].resolve(page([{ ...live("a"), liveId: 1 }]));
    await first;
    advance(5 * 60 * 1000);
    repository.resetSearchMetadata();
    const search = repository.ensureMetadata({ scope: "global-lives", tab: "lives" });
    const count = repository.countGlobalLives();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].signal.aborted, false);
    requests[1].resolve(page([{ ...live("b"), liveId: 2, concurrentUserCount: 50 }]));
    assert.equal((await count).totalViewers, 50);
    assert.equal((await search).get("b").views, 50);
});

test("count keeps every cached page in search metadata when it starts before the search waiter", async () => {
    const route = { scope: "global-lives", tab: "lives" };
    const firstCursor = { liveId: 1, concurrentUserCount: 10 };
    const secondCursor = { liveId: 2, concurrentUserCount: 10 };
    let calls = 0;
    const { repository } = fixture(async () => {
        const id = ++calls;
        return page([{ ...live(String(id)), liveId: id }], id === 1 ? firstCursor : id === 2 ? secondCursor : null);
    });
    await repository.ensureMetadata(route);
    await repository.loadNextMetadata(route);
    assert.equal(calls, 2);
    repository.resetSearchMetadata();
    const count = repository.countGlobalLives();
    const search = repository.ensureMetadata(route);
    assert.equal((await count).count, 3);
    const metadata = await search;
    assert.deepEqual([...metadata.keys()], ["1", "2", "3"]);
    assert.equal(repository.metadataState().size, 3);
    assert.equal(repository.metadataState().pagesLoaded, 3, "each shared page is merged exactly once");
    assert.equal(repository.metadataState().complete, true);
    assert.equal(repository.metadataState().next, null);
    assert.equal(calls, 3, "only the third page needs another network request");
});

test("cancelling count after cached pages preserves the search prefix and excludes a late next page", async () => {
    const route = { scope: "global-lives", tab: "lives" };
    const requests = [];
    const { repository } = fixture((url, options) => {
        const pending = deferred();
        requests.push({ ...options, ...pending });
        return pending.promise;
    });
    const first = repository.ensureMetadata(route);
    requests[0].resolve(page([{ ...live("1"), liveId: 1 }], { liveId: 1, concurrentUserCount: 10 }));
    await first;
    const second = repository.loadNextMetadata(route);
    requests[1].resolve(page([{ ...live("2"), liveId: 2 }], { liveId: 2, concurrentUserCount: 10 }));
    await second;
    repository.resetSearchMetadata();
    const count = repository.countGlobalLives();
    const rejected = assert.rejects(count, /cancelled/);
    const search = repository.ensureMetadata(route);
    await flush();
    const metadata = await search;
    assert.deepEqual([...metadata.keys()], ["1", "2"]);
    assert.equal(repository.metadataState().pagesLoaded, 2);
    assert.equal(requests.length, 3);
    repository.cancelGlobalLiveCount();
    assert.equal(requests[2].signal.aborted, true);
    requests[2].resolve(page([{ ...live("old"), liveId: 3 }]));
    await rejected;
    assert.deepEqual([...metadata.keys()], ["1", "2"]);
    const nextSearch = repository.loadNextMetadata(route);
    assert.equal(requests.length, 4);
    requests[3].resolve(page([{ ...live("current"), liveId: 4 }]));
    await nextSearch;
    assert.deepEqual([...metadata.keys()], ["1", "2", "current"]);
    assert.equal(repository.metadataState().pagesLoaded, 3);
});

test("global count rejects repeated cursors and retries without caching a failed walk", async () => {
    let calls = 0;
    const { repository, timers } = fixture(async () => {
        calls++;
        return calls <= 2 ? page([{ ...live("a"), liveId: 1 }], nextCursor) : page([]);
    });
    await assert.rejects(repository.countGlobalLives(), /cursor/);
    assert.equal(calls, 2);
    assert.equal((await repository.countGlobalLives()).count, 0);
    assert.equal(calls, 3);
    assert.equal(timers.size, 0);
});

test("global count rejects invalid rows and a page walk beyond the bounded limit", async () => {
    for (const data of [null, {}, [null], [{ liveId: 1 }]]) {
        const { repository } = fixture(async () => page(data));
        await assert.rejects(repository.countGlobalLives(), /unavailable/);
    }
    let calls = 0;
    const { repository } = fixture(async () =>
        page([{ ...live(String(++calls)), liveId: calls }], { liveId: calls, concurrentUserCount: 10 })
    );
    await assert.rejects(repository.countGlobalLives(), /page limit/);
    assert.equal(calls, 200);
});

test("global live count shares metadata, deduplicates broadcasts and stops below ten viewers", async () => {
    const requests = [];
    const row = (id, viewers) => ({ ...live(String(id)), liveId: id, concurrentUserCount: viewers });
    const { repository, advance } = fixture((url) => {
        const pending = deferred();
        requests.push({ url, ...pending });
        return pending.promise;
    });
    const route = { scope: "global-lives", tab: "lives" };
    const metadata = repository.ensureMetadata(route);
    const count = repository.countGlobalLives();
    const sharedCount = repository.countGlobalLives();
    assert.equal(requests.length, 1);
    requests[0].resolve(page([row(1, 20), row(2, 10)], nextCursor));
    await metadata;
    await flush();
    assert.equal(requests.length, 2);
    requests[1].resolve(page([row(2, 10), row(3, 10), row(4, 9)], { liveId: 4, concurrentUserCount: 9 }));
    assert.equal((await count).count, 3);
    assert.equal((await count).totalViewers, 40);
    assert.equal((await sharedCount).count, 3);
    assert.equal((await sharedCount).totalViewers, 40);
    repository.resetMetadata();
    assert.equal((await repository.countGlobalLives()).count, 3);
    assert.equal((await repository.countGlobalLives()).totalViewers, 40);
    assert.equal(requests.length, 2);
    advance(5 * 60 * 1000);
    const refreshed = repository.countGlobalLives();
    assert.equal(requests.length, 3);
    requests[2].resolve(page([]));
    assert.equal((await refreshed).count, 0);
    assert.equal((await refreshed).totalViewers, 0);
});

test("global viewer total replaces duplicate values and excludes broadcasts below ten", async () => {
    const row = (id, viewers) => ({ ...live(String(id)), liveId: id, concurrentUserCount: viewers });
    let requests = 0;
    const { repository } = fixture(async () =>
        ++requests === 1
            ? page([row(1, 50), row(2, 20)], nextCursor)
            : page([row(1, 40), row(2, 9), row(3, 10), row(4, 0)], nextCursor)
    );
    const result = await repository.countGlobalLives();
    assert.equal(result.count, 2);
    assert.equal(result.totalViewers, 50);
    assert.equal(requests, 2, "the existing page walk supplies both aggregates");
});

test("global live count rejects failures and late responses after route cancellation", async () => {
    const requests = [];
    const { repository } = fixture((url, options) => {
        const pending = deferred();
        requests.push({ ...options, ...pending });
        return pending.promise;
    });
    const cancelled = repository.countGlobalLives();
    repository.resetMetadata();
    assert.equal(requests[0].signal.aborted, true);
    requests[0].resolve(page([]));
    await assert.rejects(cancelled, /cancelled/);
    const failed = repository.countGlobalLives();
    requests[1].reject(new Error("offline"));
    await assert.rejects(failed, /unavailable/);
    repository.resetMetadata();
    const invalid = repository.countGlobalLives();
    requests[2].resolve({ code: 500, content: { data: [], page: { next: null } } });
    await assert.rejects(invalid, /unavailable/);
});

test("category metadata shares a page request and ignores a late result after a reset to the same route", async () => {
    const requests = [];
    const { repository } = fixture((url, options) => {
        const pending = deferred();
        requests.push({ url, ...options, ...pending });
        return pending.promise;
    });
    const first = repository.ensureMetadata(liveRoute);
    const duplicate = repository.ensureMetadata(liveRoute);
    assert.equal(requests.length, 1);
    repository.resetMetadata("game/test/lives");
    assert.equal(requests[0].signal.aborted, true);
    const current = repository.ensureMetadata(liveRoute);
    requests[0].resolve(page([live("old")]));
    await Promise.all([first, duplicate]);
    assert.equal(repository.metadataState().size, 0);
    assert.equal(repository.metadataState().loading, true, "old completion must not clear the current request");
    requests[1].resolve(page([live("current")]));
    const metadata = await current;
    assert.deepEqual([...metadata.keys()], ["current"]);
    assert.equal(repository.metadataState().pagesLoaded, 1);
});

test("category pagination keeps cursor values, first-seen order and refreshed search metadata", async () => {
    const urls = [];
    const { repository } = fixture(async (url) => {
        urls.push(new URL(url));
        return urls.length === 1
            ? page([live("a"), live("b")], { concurrentUserCount: 0, liveId: 0 })
            : page([live("a", "updated"), live("c")]);
    });
    const route = { scope: "global-lives", tab: "lives" };
    const first = await repository.ensureMetadata(route);
    first.get("a")._bcgtSearchText = "stale";
    await Promise.all([repository.loadNextMetadata(route), repository.loadNextMetadata(route)]);
    assert.equal(urls.length, 2);
    assert.equal(urls[0].pathname, "/service/v1/lives");
    assert.equal(urls[1].searchParams.get("concurrentUserCount"), "0");
    assert.equal(urls[1].searchParams.get("liveId"), "0");
    assert.deepEqual(
        [...first.values()].map(({ id, order }) => [id, order]),
        [
            ["a", 0],
            ["b", 1],
            ["c", 2],
        ]
    );
    assert.equal(first.get("a").title, "updated");
    assert.equal(Object.hasOwn(first.get("a"), "_bcgtSearchText"), false);
    assert.equal(repository.metadataState().complete, true);
});

test("category videos and clips preserve their endpoint and identity mapping", async () => {
    for (const [tab, item, expectedPath, expectedId, expectedChannel] of [
        [
            "videos",
            { videoNo: 12, videoTitle: "video", channel: { channelId: "a" }, duration: 30, readCount: "10" },
            "/service/v2/categories/game/test/videos",
            "12",
            "a",
        ],
        [
            "clips",
            {
                clipUID: "clip-a",
                clipTitle: "clip",
                ownerChannelId: "b",
                ownerChannel: { channelId: "fallback" },
                readCount: "20",
            },
            "/service/v1/categories/game/test/clips",
            "clip-a",
            "b",
        ],
    ]) {
        let requested;
        const { repository } = fixture(async (url) => {
            requested = new URL(url);
            return page([item]);
        });
        const metadata = await repository.ensureMetadata({ ...liveRoute, tab });
        assert.equal(requested.pathname, expectedPath);
        assert.equal(metadata.get(expectedId).channelId, expectedChannel);
        if (tab === "clips") {
            assert.equal(requested.searchParams.get("filterType"), "WITHIN_THIRTY_DAYS");
            assert.equal(requested.searchParams.get("orderType"), "POPULAR");
        }
    }
});

test("category rendered metadata stops at the page limit and stops after a page failure", async () => {
    let count = 0;
    const { repository } = fixture(async () => page([live(String(++count))], nextCursor));
    await repository.ensureRenderedMetadata(liveRoute, ["missing"], { maxPages: 2 });
    assert.equal(count, 2);
    assert.equal(repository.metadataState().complete, false);

    let failures = 0;
    const failing = fixture(async () => {
        if (++failures > 1) throw new Error("unavailable");
        return page([live("a")], nextCursor);
    });
    await failing.repository.ensureRenderedMetadata(liveRoute, ["missing"], { maxPages: 12 });
    assert.equal(failures, 2);
    assert.equal(failing.repository.metadataState().pagesLoaded, 1);
    assert.equal(failing.repository.metadataState().retryAt, 11000);
});

test("category metadata retries timeout failures with bounded backoff and cancels lifecycle retries", async () => {
    let fail = true;
    let requests = 0;
    const retried = [];
    const env = fixture(
        async () => {
            requests++;
            if (fail) throw Object.assign(new Error("timeout"), { name: "AbortError" });
            return page([live("a")]);
        },
        { onRetryReady: (key) => retried.push(key) }
    );
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
        await env.repository.ensureMetadata(liveRoute);
        const before = requests;
        await env.repository.ensureMetadata(liveRoute);
        assert.equal(requests, before);
        assert.equal(await env.nextTimer(), delay);
    }
    assert.equal(retried.length, 7);
    fail = false;
    await env.repository.ensureMetadata(liveRoute);
    assert.equal(env.repository.metadataState().retryAt, 0);
    assert.equal(env.repository.metadataState().retryDelayMs, 1000);
    assert.equal(env.timers.size, 0);
    fail = true;
    env.repository.resetMetadata();
    await env.repository.ensureMetadata(liveRoute);
    assert.equal(env.timers.size, 1);
    env.repository.resetMetadata();
    assert.equal(env.timers.size, 0);
});

test("category follower cache distinguishes missing counts from zero and expires misses after five minutes", async () => {
    let count = 0;
    const env = fixture(async () => ({ content: { followerCount: ++count === 1 ? null : 0 } }));
    assert.equal(await env.repository.getFollowerCount("a"), null);
    assert.equal(await env.repository.getFollowerCount("a"), null);
    assert.equal(count, 1);
    assert.equal(env.repository.readFollowerCache("a").hit, true);
    env.advance(300000);
    assert.equal(env.repository.readFollowerCache("a").hit, false);
    assert.equal(await env.repository.getFollowerCount("a"), 0);
    env.repository.cancelFollowers();
    assert.equal(
        env.repository.readFollowerCache("a").count,
        0,
        "resolved channel counts remain usable on the next route"
    );
    assert.equal(count, 2);
});

test("category follower cache stays bounded and refreshes recently accessed entries", async () => {
    const { repository } = fixture(async () => ({ content: { followerCount: 5 } }));
    for (let index = 0; index < 1000; index++) await repository.getFollowerCount(String(index));
    assert.equal(repository.readFollowerCache("0").count, 5);
    await repository.getFollowerCount("1000");
    assert.equal(repository.readFollowerCache("0").hit, true);
    assert.equal(repository.readFollowerCache("1").hit, false);
    assert.equal(repository.readFollowerCache("1000").hit, true);
});

test("category follower requests share work and aborted results neither populate nor clear the next request", async () => {
    const requests = [];
    const { repository } = fixture((url, options) => {
        const request = { ...deferred(), ...options };
        requests.push(request);
        return request.promise;
    });
    const first = repository.getFollowerCount("a");
    const duplicate = repository.getFollowerCount("a");
    assert.equal(requests.length, 1);
    repository.cancelFollowers();
    assert.equal(requests[0].signal.aborted, true);
    const next = repository.getFollowerCount("a");
    requests[0].resolve({ content: { followerCount: 100 } });
    await Promise.all([first, duplicate]);
    assert.equal(repository.readFollowerCache("a").hit, false);
    const nextDuplicate = repository.getFollowerCount("a");
    assert.equal(requests.length, 2);
    requests[1].resolve({ content: { followerCount: 200 } });
    assert.equal(await next, 200);
    assert.equal(await nextDuplicate, 200);
});

test("category follower hydration respects batch size, concurrency and delayed continuation", async () => {
    const requests = [];
    const loading = [];
    let nextPasses = 0;
    const env = fixture(
        (url) => {
            const match = new URL(url).pathname.match(/^\/service\/v1\/channels\/([^/]+)\/followers\/count$/);
            assert.ok(match, "follower hydration uses the measured count-only endpoint");
            const request = { ...deferred(), id: match[1] };
            requests.push(request);
            return request.promise;
        },
        { onFollowerLoading: (on) => loading.push(on), onHydrationNeeded: () => nextPasses++ }
    );
    const pending = env.repository.hydrateFollowers(["a", "a", "b", "c", "d"], hydration);
    assert.deepEqual(
        requests.map(({ id }) => id),
        ["a", "b"]
    );
    requests[0].resolve({ content: { followerCount: 1 } });
    await flush();
    assert.equal(requests.length, 2);
    requests[1].resolve({ content: { followerCount: 2 } });
    await flush();
    assert.equal(requests.length, 3);
    requests[2].resolve({ content: { followerCount: 3 } });
    assert.equal(await pending, true);
    assert.deepEqual(loading, [true]);
    assert.equal(await env.nextTimer(), 700);
    assert.equal(nextPasses, 1);
    const complete = env.repository.hydrateFollowers(["a", "b", "c", "d"], hydration);
    assert.equal(requests.length, 4);
    requests[3].resolve({ content: { followerCount: 4 } });
    assert.equal(await complete, false);
    assert.deepEqual(loading, [true, true, false]);
});

test("category follower cancellation stops later batches and queued viewport refreshes", async () => {
    const requests = [];
    const loading = [];
    const env = fixture(
        (url, options) => {
            const request = { ...deferred(), ...options };
            requests.push(request);
            return request.promise;
        },
        { onFollowerLoading: (on) => loading.push(on) }
    );
    const pending = env.repository.refreshFollowers(["a", "b", "c"], { ...hydration, concurrency: 1 });
    assert.equal(await env.repository.refreshFollowers(["d"], hydration), false);
    env.repository.cancelFollowers();
    assert.equal(requests[0].signal.aborted, true);
    requests[0].reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    assert.equal(await pending, false);
    assert.equal(requests.length, 1);
    assert.equal(env.timers.size, 0);
    assert.equal(env.repository.readFollowerCache("a").hit, false);
    assert.deepEqual(loading, [true], "a cancelled generation cannot alter loading for its successor");
});

test("category metadata search pauses after two extra pages when the viewport has scroll room", async () => {
    let requests = 0;
    let applies = 0;
    const loading = [];
    const env = fixture(async () => page([live(String(++requests))], requests < 6 ? nextCursor : null));
    await env.repository.ensureMetadata(liveRoute);
    const controller = env.searchController({
        onApply: () => applies++,
        onLoading: (on) => loading.push(on),
        isRouteCurrent: () => true,
        hasScrollRoom: () => true,
    });
    controller.request(liveRoute, { maxPages: 6, pageDelayMs: 80 });
    await flush();
    assert.equal(requests, 2);
    assert.equal(await env.nextTimer(), 80);
    assert.equal(requests, 3);
    assert.equal(await env.nextTimer(), 80);
    assert.equal(await env.nextTimer(), 250);
    assert.equal(requests, 3);
    assert.equal(controller.isRunning(), false);
    assert.ok(applies > 0);
    assert.deepEqual(loading, [true, false]);
    controller.request(liveRoute, { maxPages: 4, pageDelayMs: 600 });
    await flush();
    assert.equal(requests, 4);
    assert.equal(await env.nextTimer(), 600);
    assert.equal(controller.isRunning(), false);
    assert.equal(requests, 4);
});

test("category metadata search cancellation removes waits and cannot clear a newer search", async () => {
    let requests = 0;
    const env = fixture(async () => page([live(String(++requests))], nextCursor));
    await env.repository.ensureMetadata(liveRoute);
    const controller = env.searchController({
        onApply() {},
        onLoading() {},
        isRouteCurrent: () => true,
        hasScrollRoom: () => false,
    });
    controller.request(liveRoute, { maxPages: 5, pageDelayMs: 80 });
    await flush();
    assert.equal(env.timers.size, 1);
    controller.cancel();
    assert.equal(env.timers.size, 0);
    controller.request(liveRoute, { maxPages: 4, pageDelayMs: 600 });
    await flush();
    assert.equal(requests, 3);
    assert.equal(controller.isRunning(), true);
    assert.equal(await env.nextTimer(), 600);
    assert.equal(requests, 4);
    assert.equal(await env.nextTimer(), 600);
    assert.equal(controller.isRunning(), false);
});

test("repeated metadata requests do not restart an identical running search", async () => {
    const env = fixture(async () => page([live("a")], nextCursor));
    await env.repository.ensureMetadata(liveRoute);
    const loading = [];
    const controller = env.searchController({
        onApply() {},
        onLoading: (value) => loading.push(value),
        isRouteCurrent: () => true,
        hasScrollRoom: () => true,
    });
    const options = { maxPages: 10, pageDelayMs: 80 };
    controller.request(liveRoute, options);
    await flush();
    controller.request(liveRoute, options);
    controller.request(liveRoute, options);
    await env.nextTimer();
    await env.nextTimer();
    await env.nextTimer();
    assert.equal(env.repository.metadataState().pagesLoaded, 3);
    assert.equal(controller.isRunning(), false);
    assert.deepEqual(loading, [true, false]);
    controller.reset();
});
