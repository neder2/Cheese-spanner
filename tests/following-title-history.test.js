const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { waitForCondition } = require("./helpers/wait-for-condition.js");

const repoRoot = path.join(__dirname, "..");
const STORAGE_KEY = "betterchzzkFollowingLiveTitleHistory";
const ALARM = "betterchzzk:following-title-history";
const LIST_URL = "https://api.chzzk.naver.com/service/v1/channels/following-lives?sortType=RECOMMEND";
const CHANNEL = "channel-123";
const OTHER_CHANNEL = "channel-456";
const openDoms = new Set();

test.afterEach(() => {
    for (const dom of openDoms) {
        const chrome = dom.window.chrome;
        if (chrome?.testState) {
            chrome.testState.sync.followingTitleHistoryEnabled = false;
            for (const listener of [...chrome.testState.storageChangeListeners]) {
                listener({ followingTitleHistoryEnabled: { oldValue: true, newValue: false } }, "sync");
            }
        }
        dom.window.close();
    }
    openDoms.clear();
});

function readRepoFile(...parts) {
    return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

async function flush() {
    // Mocked extension callbacks settle in microtasks and immediates; drain several event turns.
    for (let i = 0; i < 30; i++) await new Promise(setImmediate);
}

function loadModel() {
    const context = vm.createContext({});
    vm.runInContext(readRepoFile("shared", "followingTitleHistory.js"), context);
    return context.BetterChzzkFollowingTitleHistory;
}

function liveItem(channelId, liveId, liveTitle, channelName = "테스트 채널") {
    return { channel: { channelId, channelName }, liveInfo: { liveId, liveTitle } };
}

function listResponse(items) {
    return { code: 200, message: null, content: { followingList: items } };
}

function toPlain(value) {
    return JSON.parse(JSON.stringify(value));
}

test("following-lives rows keep raw titles and skip rows without live identity", () => {
    const model = loadModel();
    assert.equal(model.parseFollowingLives({ code: 401, message: "권한이 없습니다." }), null);
    assert.equal(model.parseFollowingLives({ code: 200, content: {} }), null);
    assert.deepEqual(
        toPlain(
            model.parseFollowingLives(
                listResponse([
                    liveItem(CHANNEL, 11, "  롤 내전 |  치지직 대회 예선 "),
                    liveItem(OTHER_CHANNEL, null, "라이브 ID 없음"),
                    liveItem("bad id!", 12, "잘못된 채널"),
                    liveItem("channel-789", 13, ""),
                ])
            )
        ),
        [{ channelId: CHANNEL, liveId: "11", title: "롤 내전 | 치지직 대회 예선", channelName: "테스트 채널" }]
    );
});

test("polls record every small title change per live and restart a new live id", () => {
    const model = loadModel();
    const poll = (store, title, at, liveId = "11") =>
        model.applyPoll(store, model.parseFollowingLives(listResponse([liveItem(CHANNEL, liveId, title)])), at);

    let result = poll(undefined, "테스트 채널 | 롤 내전 | 치지직 대회 예선", 1000);
    assert.equal(result.titlesChanged, true);
    result = poll(result.store, "테스트 채널 | 롤 내전 | 치지직 대회 예선", 61_000);
    assert.equal(result.titlesChanged, false);
    result = poll(result.store, "테스트 채널  |  롤 내전 | 치지직 대회 예선", 121_000);
    assert.equal(result.titlesChanged, false, "whitespace-only edits are the same title");
    result = poll(result.store, "테스트 채널 | 롤 내전 | 치지직 대회 본선", 181_000);
    result = poll(result.store, "테스트 채널 | 롤 내전 | 치지직 대회 본선 🔴", 241_000);
    result = poll(result.store, "테스트 채널 | 롤 내전 | 치지직 대회 예선", 301_000);

    const entry = result.store.entries[0];
    assert.equal(entry.liveId, "11");
    assert.deepEqual(toPlain(entry.titleHistory), [
        { title: "테스트 채널 | 롤 내전 | 치지직 대회 예선", firstSeenAt: 1000, lastSeenAt: 121_000 },
        { title: "테스트 채널 | 롤 내전 | 치지직 대회 본선", firstSeenAt: 181_000, lastSeenAt: 181_000 },
        { title: "테스트 채널 | 롤 내전 | 치지직 대회 본선 🔴", firstSeenAt: 241_000, lastSeenAt: 241_000 },
        { title: "테스트 채널 | 롤 내전 | 치지직 대회 예선", firstSeenAt: 301_000, lastSeenAt: 301_000 },
    ]);
    assert.deepEqual(
        toPlain(model.getPreviousRows(entry, "테스트 채널 | 롤 내전 | 치지직 대회 예선").map((row) => row.title)),
        ["테스트 채널 | 롤 내전 | 치지직 대회 본선", "테스트 채널 | 롤 내전 | 치지직 대회 본선 🔴"]
    );

    result = poll(result.store, "다음 방송", 400_000, "12");
    assert.deepEqual(toPlain(result.store.entries[0].titleHistory.map((row) => row.title)), ["다음 방송"]);
    assert.equal(result.store.entries[0].liveId, "12");
});

test("one poll stores every followed live and bounds titles and broadcasts", () => {
    const model = loadModel();
    const items = Array.from({ length: model.MAX_ENTRIES + 5 }, (_, index) =>
        liveItem(`channel-${index}`, index + 1, `제목 ${index}`)
    );
    let { store } = model.applyPoll(undefined, model.parseFollowingLives(listResponse(items)), 1000);
    assert.equal(store.entries.length, model.MAX_ENTRIES);
    assert.deepEqual(
        toPlain(store.entries.map((entry) => entry.channelId)),
        Array.from({ length: model.MAX_ENTRIES }, (_, index) => `channel-${index}`),
        "new broadcasts beyond the cap keep the top of the following list"
    );

    store = undefined;
    for (let index = 0; index < model.MAX_TITLES_PER_LIVE + 3; index++) {
        ({ store } = model.applyPoll(
            store,
            model.parseFollowingLives(listResponse([liveItem(CHANNEL, 1, `제목 ${index}`)])),
            1000 + index
        ));
    }
    const rows = store.entries[0].titleHistory;
    assert.equal(rows.length, model.MAX_TITLES_PER_LIVE);
    assert.equal(rows.at(-1).title, `제목 ${model.MAX_TITLES_PER_LIVE + 2}`);
});

test("with more than 100 lives at once stored broadcasts keep accumulating whatever the list order", () => {
    const model = loadModel();
    const count = model.MAX_ENTRIES + 30;
    const poll = (store, suffix, at, order = (position) => position) =>
        model.applyPoll(
            store,
            model.parseFollowingLives(
                listResponse(
                    Array.from({ length: count }, (_, position) => {
                        const index = order(position);
                        return liveItem(`channel-${index}`, index + 1, `제목 ${index}${suffix}`);
                    })
                )
            ),
            at
        ).store;
    const ended = {
        channelId: "ended-channel",
        liveId: "999",
        channelName: "끝난 채널",
        titleHistory: [{ title: "끝난 방송", firstSeenAt: 10, lastSeenAt: 20 }],
        updatedAt: 20,
    };
    const top = Array.from({ length: model.MAX_ENTRIES }, (_, index) => `channel-${index}`);

    let store = poll({ version: 1, entries: [ended] }, "", 1000);
    assert.deepEqual(
        toPlain(store.entries.map((entry) => entry.channelId)),
        top,
        "the ended broadcast leaves first and the top of the list is kept"
    );

    store = poll(store, " 변경", 61_000, (position) => count - 1 - position);
    store = poll(store, " 변경 2", 121_000, (position) => (position + 17) % count);
    assert.deepEqual(
        toPlain(store.entries.map((entry) => entry.channelId)).sort(),
        [...top].sort(),
        "a reordered list does not swap out broadcasts that are already collecting"
    );
    assert.ok(
        store.entries.every((entry) => entry.titleHistory.length === 3),
        "kept broadcasts record every title change"
    );
});

test("stored values from the earlier page-only cache stay readable", () => {
    const model = loadModel();
    const store = model.normalizeStore({
        version: 1,
        entries: [
            {
                channelId: CHANNEL,
                liveId: "old-live",
                channelName: "테스트 채널",
                titleHistory: [{ title: "이전 제목", firstSeenAt: 10, lastSeenAt: 20 }, { title: "" }],
                updatedAt: 20,
            },
            { channelId: "", liveId: "x", titleHistory: [{ title: "버림", firstSeenAt: 1 }] },
        ],
    });
    assert.deepEqual(toPlain(store.entries), [
        {
            channelId: CHANNEL,
            liveId: "old-live",
            channelName: "테스트 채널",
            titleHistory: [{ title: "이전 제목", firstSeenAt: 10, lastSeenAt: 20 }],
            updatedAt: 20,
        },
    ]);
});

function createEvent() {
    const listeners = [];
    return {
        listeners,
        addListener: (listener) => listeners.push(listener),
        removeListener(listener) {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
        },
        emit: (...args) => listeners.forEach((listener) => listener(...args)),
    };
}

function createCollector({ sync = {}, local = {}, tabs = [] } = {}) {
    const changed = createEvent();
    const stores = { sync: { ...sync }, local: clone(local) };
    const writes = [];
    const workerRequests = [];
    const tabRequests = [];
    const alarms = new Map();
    let clock = 10_000_000;
    let workerResponder = () => ({ status: 200, json: listResponse([]) });
    let tabResponder = () => ({ status: 200, json: listResponse([]) });
    let currentTabs = tabs;
    const runtime = { id: "test", lastError: null, onStartup: createEvent(), onInstalled: createEvent() };

    function area(name) {
        return {
            get(keys, callback) {
                const result = {};
                for (const key of Array.isArray(keys) ? keys : [keys]) {
                    if (Object.hasOwn(stores[name], key)) result[key] = clone(stores[name][key]);
                }
                queueMicrotask(() => callback(result));
            },
            set(values, callback) {
                queueMicrotask(() => {
                    const changes = {};
                    for (const [key, value] of Object.entries(values)) {
                        changes[key] = { oldValue: stores[name][key], newValue: clone(value) };
                        stores[name][key] = clone(value);
                    }
                    writes.push({ area: name, values: clone(values) });
                    callback?.();
                    changed.emit(changes, name);
                });
            },
        };
    }

    const chrome = {
        runtime,
        storage: { local: area("local"), sync: area("sync"), onChanged: changed },
        alarms: {
            onAlarm: createEvent(),
            get: async (name) => clone(alarms.get(name)),
            create: async (name, info) => alarms.set(name, clone(info)),
            clear: async (name) => alarms.delete(name),
        },
        tabs: { query: async () => clone(currentTabs) },
        scripting: {
            executeScript: async (injection) => {
                tabRequests.push({ target: clone(injection.target), world: injection.world, args: injection.args });
                return [{ result: await tabResponder(injection) }];
            },
        },
    };
    class Clock extends Date {
        static now() {
            return clock;
        }
    }
    const context = vm.createContext({
        chrome,
        console: { warn() {} },
        URL,
        AbortController,
        setTimeout,
        clearTimeout,
        Date: Clock,
        fetch: async (url, init) => {
            workerRequests.push({ url, credentials: init?.credentials, cache: init?.cache });
            const response = await workerResponder(url);
            return { ok: response.status === 200, status: response.status, json: async () => clone(response.json) };
        },
    });
    for (const file of [
        "shared/settings.js",
        "shared/data.js",
        "shared/followingTitleHistory.js",
        "shared/followingTitleCollector.js",
    ]) {
        vm.runInContext(readRepoFile(file), context, { filename: file });
    }
    return {
        chrome,
        stores,
        writes,
        alarms,
        workerRequests,
        tabRequests,
        get entries() {
            return toPlain(stores.local[STORAGE_KEY]?.entries || []);
        },
        setWorker: (next) => {
            workerResponder = next;
        },
        setTab: (next) => {
            tabResponder = next;
        },
        setTabs: (next) => {
            currentTabs = next;
        },
        advance: (ms) => {
            clock += ms;
        },
        async tick(ms = 60_000) {
            clock += ms;
            chrome.alarms.onAlarm.emit({ name: ALARM });
            await flush();
        },
        async setOption(value) {
            const oldValue = stores.sync.followingTitleHistoryEnabled;
            stores.sync.followingTitleHistoryEnabled = value;
            changed.emit({ followingTitleHistoryEnabled: { oldValue, newValue: value } }, "sync");
            await flush();
        },
    };
}

const chzzkTab = (overrides = {}) => ({
    id: 7,
    windowId: 1,
    url: "https://chzzk.naver.com/live/abc",
    status: "complete",
    active: true,
    incognito: false,
    discarded: false,
    ...overrides,
});

test("the worker keeps a one-minute alarm only while the option is on", async () => {
    const c = createCollector();
    await flush();
    assert.equal(c.alarms.get(ALARM).periodInMinutes, 1);
    assert.equal(c.workerRequests.length, 0, "loading the worker alone does not request the list");

    await c.setOption(false);
    assert.equal(c.alarms.has(ALARM), false);
    await c.tick();
    assert.equal(c.workerRequests.length, 0);

    await c.setOption(true);
    assert.equal(c.alarms.get(ALARM).periodInMinutes, 1);
    assert.equal(c.workerRequests.length, 1, "turning the option on checks the list right away");
});

test("each alarm reads all followed lives with one request and records title changes", async () => {
    const c = createCollector();
    await flush();
    let titles = { [CHANNEL]: "첫 제목", [OTHER_CHANNEL]: "다른 채널 제목" };
    c.setWorker(() => ({
        status: 200,
        json: listResponse(Object.entries(titles).map(([id, title], index) => liveItem(id, index + 1, title))),
    }));

    await c.tick();
    assert.deepEqual(c.workerRequests, [{ url: LIST_URL, credentials: "include", cache: "no-store" }]);
    assert.deepEqual(
        c.entries.map((entry) => [entry.channelId, entry.titleHistory.map((row) => row.title)]),
        [
            [CHANNEL, ["첫 제목"]],
            [OTHER_CHANNEL, ["다른 채널 제목"]],
        ]
    );

    titles = { [CHANNEL]: "첫 제목!", [OTHER_CHANNEL]: "다른 채널 제목" };
    await c.tick();
    assert.equal(c.workerRequests.length, 2);
    assert.deepEqual(
        c.entries.find((entry) => entry.channelId === CHANNEL).titleHistory.map((row) => row.title),
        ["첫 제목", "첫 제목!"]
    );
});

test("overlapping alarms coalesce into one request and failures keep stored history", async () => {
    const c = createCollector({
        local: {
            [STORAGE_KEY]: {
                version: 1,
                entries: [
                    {
                        channelId: CHANNEL,
                        liveId: "1",
                        channelName: "테스트 채널",
                        titleHistory: [{ title: "보관된 제목", firstSeenAt: 1, lastSeenAt: 2 }],
                        updatedAt: 2,
                    },
                ],
            },
        },
    });
    await flush();
    c.setWorker(() => ({ status: 503 }));
    c.advance(60_000);
    for (let i = 0; i < 5; i++) c.chrome.alarms.onAlarm.emit({ name: ALARM });
    await flush();
    assert.equal(c.workerRequests.length, 1);
    assert.equal(c.writes.length, 0);

    c.setWorker(() => ({ status: 200, json: { code: 200, content: { unexpected: [] } } }));
    await c.tick();
    assert.equal(c.writes.length, 0);
    assert.deepEqual(c.entries[0].titleHistory, [{ title: "보관된 제목", firstSeenAt: 1, lastSeenAt: 2 }]);
});

test("an open regular Chzzk tab reads the list with the page session instead of the worker", async () => {
    const c = createCollector({
        tabs: [
            chzzkTab({ id: 3, incognito: true }),
            chzzkTab({ id: 4, discarded: true }),
            chzzkTab({ id: 5, active: false }),
            chzzkTab({ id: 6, status: "loading" }),
        ],
    });
    await flush();
    c.setTab(() => ({ status: 200, json: listResponse([liveItem(CHANNEL, 1, "탭에서 읽은 제목")]) }));
    await c.tick();

    assert.equal(c.workerRequests.length, 0);
    assert.deepEqual(toPlain(c.tabRequests), [
        { target: { tabId: 5, frameIds: [0] }, world: "ISOLATED", args: [LIST_URL, 8000] },
    ]);
    assert.deepEqual(
        c.entries[0].titleHistory.map((row) => row.title),
        ["탭에서 읽은 제목"]
    );
});

test("the injected page reader is self-contained and only runs on Chzzk", async () => {
    const c = createCollector({ tabs: [chzzkTab()] });
    await flush();
    let injected = null;
    c.setTab((injection) => {
        injected = injection.func;
        return { status: 0 };
    });
    await c.tick();
    assert.equal(typeof injected, "function");

    const pageRequests = [];
    const page = (origin) =>
        vm.createContext({
            location: { origin },
            AbortController,
            setTimeout,
            clearTimeout,
            fetch: async (url, init) => {
                pageRequests.push({ url, credentials: init.credentials, cache: init.cache });
                return { ok: true, status: 200, json: async () => listResponse([]) };
            },
        });
    const run = (origin) => vm.runInContext(`(${injected.toString()})`, page(origin))(LIST_URL, 8000);
    assert.deepEqual(toPlain(await run("https://example.com")), { status: 0 });
    assert.equal(pageRequests.length, 0);
    assert.deepEqual(toPlain(await run("https://chzzk.naver.com")), { status: 200, json: listResponse([]) });
    assert.deepEqual(pageRequests, [{ url: LIST_URL, credentials: "include", cache: "no-store" }]);
});

test("logged-out responses pause only the failing path for ten minutes", async () => {
    const c = createCollector({ tabs: [chzzkTab()] });
    await flush();
    c.setTab(() => ({ status: 401 }));
    c.setWorker(() => ({ status: 401 }));

    await c.tick();
    assert.equal(c.tabRequests.length, 1);
    assert.ok(c.stores.local[STORAGE_KEY].tabRetryAt > 0);

    await c.tick();
    assert.equal(c.tabRequests.length, 1, "the tab path waits after a login failure");
    assert.equal(c.workerRequests.length, 1, "the worker path is still tried once");
    assert.ok(c.stores.local[STORAGE_KEY].retryAt > 0);

    for (let i = 0; i < 7; i++) await c.tick();
    assert.equal(c.tabRequests.length, 1);
    assert.equal(c.workerRequests.length, 1);

    c.setTab(() => ({ status: 200, json: listResponse([liveItem(CHANNEL, 1, "로그인 후 제목")]) }));
    await c.tick(2 * 60_000);
    assert.equal(c.tabRequests.length, 2);
    assert.equal(c.stores.local[STORAGE_KEY].tabRetryAt, 0);
    assert.equal(c.stores.local[STORAGE_KEY].retryAt, 0);
    assert.equal(c.entries[0].titleHistory[0].title, "로그인 후 제목");
});

test("a Chzzk tab that cannot read the list hands the same alarm to another tab or the worker", async () => {
    const workerList = () => ({ status: 200, json: listResponse([liveItem(CHANNEL, 1, "워커에서 읽은 제목")]) });
    const pageError = () => {
        throw new Error("Frame with ID 0 is showing error page");
    };

    const blocked = createCollector({ tabs: [chzzkTab()] });
    await flush();
    blocked.setTab(pageError);
    blocked.setWorker(workerList);
    for (let i = 0; i < 3; i++) await blocked.tick();
    assert.equal(blocked.tabRequests.length, 3);
    assert.equal(blocked.workerRequests.length, 3, "every alarm still reads the list through the worker");
    assert.deepEqual(
        blocked.entries.map((entry) => entry.titleHistory.map((row) => row.title)),
        [["워커에서 읽은 제목"]]
    );

    for (const status of [0, 503]) {
        const failing = createCollector({ tabs: [chzzkTab()] });
        await flush();
        failing.setTab(() => ({ status }));
        failing.setWorker(workerList);
        await failing.tick();
        assert.equal(failing.workerRequests.length, 1, `a tab result of ${status} falls back to the worker`);
        assert.equal(failing.entries[0].titleHistory[0].title, "워커에서 읽은 제목");
    }

    const twoTabs = createCollector({ tabs: [chzzkTab({ id: 7 }), chzzkTab({ id: 8, active: false })] });
    await flush();
    twoTabs.setTab((injection) =>
        injection.target.tabId === 7
            ? pageError()
            : { status: 200, json: listResponse([liveItem(CHANNEL, 1, "다른 탭에서 읽은 제목")]) }
    );
    await twoTabs.tick();
    assert.deepEqual(
        twoTabs.tabRequests.map((request) => request.target.tabId),
        [7, 8]
    );
    assert.equal(twoTabs.workerRequests.length, 0, "another regular tab keeps the page session path");
    assert.equal(twoTabs.entries[0].titleHistory[0].title, "다른 탭에서 읽은 제목");

    const paused = createCollector({
        tabs: [chzzkTab()],
        local: { [STORAGE_KEY]: { version: 1, retryAt: 10_000_000 + 5 * 60_000, entries: [] } },
    });
    await flush();
    paused.setTab(pageError);
    await paused.tick();
    assert.equal(paused.tabRequests.length, 1);
    assert.equal(paused.workerRequests.length, 0, "the worker keeps its login pause");
});

test("retry times saved while the clock ran ahead pause a path for at most ten minutes", async () => {
    const start = 10_000_000;
    const future = start + 30 * 24 * 60 * 60_000;
    const c = createCollector({
        tabs: [chzzkTab()],
        local: { [STORAGE_KEY]: { version: 1, retryAt: future, tabRetryAt: future, entries: [] } },
    });
    await flush();
    c.setTab(() => ({ status: 200, json: listResponse([liveItem(CHANNEL, 1, "시계 보정 뒤 제목")]) }));
    c.setWorker(() => ({ status: 200, json: listResponse([liveItem(CHANNEL, 1, "시계 보정 뒤 제목")]) }));

    await c.tick();
    assert.equal(c.tabRequests.length + c.workerRequests.length, 0);
    const bound = start + 60_000 + 10 * 60_000;
    assert.ok(c.stores.local[STORAGE_KEY].retryAt <= bound, "the worker pause is cut to ten minutes");
    assert.ok(c.stores.local[STORAGE_KEY].tabRetryAt <= bound, "the tab pause is cut to ten minutes");

    for (let i = 0; i < 10; i++) await c.tick();
    assert.equal(c.tabRequests.length, 1);
    assert.equal(c.workerRequests.length, 0);
    assert.equal(c.entries[0].titleHistory[0].title, "시계 보정 뒤 제목");
    assert.equal(c.stores.local[STORAGE_KEY].retryAt, 0);
    assert.equal(c.stores.local[STORAGE_KEY].tabRetryAt, 0);
});

test("the first poll after updating keeps a live's 1.4.3 cleaned title as its current title", async () => {
    const raw = "테스트 채널 | 내전 | 치지직 대회";
    const legacyEntry = (channelId, titleHistory) => ({
        channelId,
        liveId: "777",
        channelName: "테스트 채널",
        titleHistory,
        updatedAt: 9_500_000,
    });
    const c = createCollector({
        local: {
            [STORAGE_KEY]: {
                version: 1,
                entries: [
                    legacyEntry(CHANNEL, [{ title: "내전", firstSeenAt: 9_000_000, lastSeenAt: 9_500_000 }]),
                    // 1.4.3은 같은 제목으로 돌아오면(A→B→A) 첫 줄 하나로 합쳐 저장했어요.
                    legacyEntry(OTHER_CHANNEL, [
                        { title: "내전", firstSeenAt: 9_000_000, lastSeenAt: 9_500_000 },
                        { title: "스크림", firstSeenAt: 9_200_000, lastSeenAt: 9_300_000 },
                    ]),
                ],
            },
        },
    });
    await flush();
    c.setWorker(() => ({
        status: 200,
        json: listResponse([liveItem(CHANNEL, 777, raw), liveItem(OTHER_CHANNEL, 777, raw)]),
    }));
    await c.tick();

    const model = loadModel();
    const entryOf = (channelId) => c.entries.find((entry) => entry.channelId === channelId);
    assert.deepEqual(entryOf(CHANNEL).titleHistory, [{ title: raw, firstSeenAt: 9_000_000, lastSeenAt: 10_060_000 }]);
    assert.deepEqual(toPlain(model.getPreviousRows(entryOf(CHANNEL), raw)), []);
    assert.deepEqual(toPlain(model.getPreviousRows(entryOf(OTHER_CHANNEL), raw).map((row) => row.title)), ["스크림"]);

    // 수집기가 한 번 쓴 뒤에는 접두사·접미사만 다른 제목도 실제 변경이라 새 줄로 남겨요.
    c.setWorker(() => ({ status: 200, json: listResponse([liveItem(CHANNEL, 777, "내전")]) }));
    await c.tick();
    c.setWorker(() => ({ status: 200, json: listResponse([liveItem(CHANNEL, 777, raw)]) }));
    await c.tick();
    assert.deepEqual(
        entryOf(CHANNEL).titleHistory.map((row) => row.title),
        [raw, "내전", raw]
    );
});

function createStorageArea(initialData = {}) {
    const data = structuredClone(initialData);
    return {
        data,
        get(keys, callback) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                if (Object.hasOwn(data, key)) result[key] = structuredClone(data[key]);
            }
            setTimeout(() => callback(result), 0);
        },
        set(values, callback) {
            Object.assign(data, structuredClone(values || {}));
            setTimeout(() => callback?.(), 0);
        },
    };
}

function createFakeChrome({ local = {}, sync = {} } = {}) {
    const syncArea = createStorageArea({ followingTitleHistoryEnabled: true, ...sync });
    const localArea = createStorageArea(local);
    const storageChangeListeners = [];
    const localWrites = [];
    const originalSet = localArea.set.bind(localArea);
    localArea.set = (values, callback) => {
        localWrites.push(structuredClone(values));
        originalSet(values, callback);
    };
    return {
        runtime: {},
        storage: {
            local: localArea,
            sync: syncArea,
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
            local: localArea.data,
            localWrites,
            storageChangeListeners,
            sync: syncArea.data,
        },
    };
}

function storedEntry(titles, { channelId = CHANNEL, liveId = "live-1" } = {}) {
    return {
        channelId,
        liveId,
        channelName: "테스트 채널",
        titleHistory: titles.map((title, index) => ({
            title,
            firstSeenAt: Date.UTC(2026, 9, 12, 3, index * 10),
            lastSeenAt: Date.UTC(2026, 9, 12, 3, index * 10 + 5),
        })),
        updatedAt: Date.UTC(2026, 9, 12, 4),
    };
}

function createFollowingDom({
    chrome = createFakeChrome(),
    title = "첫 번째 제목",
    liveIds = { [CHANNEL]: "live-1" },
    url = "https://chzzk.naver.com/following?tab=ALL",
} = {}) {
    const dom = new JSDOM(
        [
            "<!doctype html><body>",
            '<aside><a href="/live/sidebar-channel">사이드바 채널</a></aside>',
            "<main><section><ul>",
            '<li id="liveCard">',
            `<a class="_thumbnail_card" href="/live/${CHANNEL}"><span>LIVE</span></a>`,
            '<div class="_wrapper_card"><div class="_area_card">',
            `<a id="liveTitle" class="_title_card" href="/live/${CHANNEL}">${title}<span class="blind">라이브 엔드로 이동</span></a>`,
            `<div class="_name_card"><a href="/${CHANNEL}">테스트 채널</a></div>`,
            '<div class="_information_card">카테고리</div>',
            "</div></div>",
            "</li>",
            "</ul></section></main>",
            "</body>",
        ].join(""),
        { url, runScripts: "outside-only", pretendToBeVisual: true }
    );
    const state = { requests: [], liveIds };
    dom.window.chrome = chrome;
    dom.window.fetch = async (requestUrl) => {
        const channelId = String(requestUrl).match(/\/service\/v3\/channels\/([^/]+)\/live-detail$/)?.[1];
        assert.ok(channelId, `unexpected request ${requestUrl}`);
        state.requests.push(channelId);
        return { ok: true, json: async () => ({ code: 200, content: { liveId: state.liveIds[channelId] } }) };
    };
    openDoms.add(dom);
    return { chrome, document: dom.window.document, dom, state };
}

function evalFeatureScripts(dom) {
    for (const file of [
        "shared/settings.js",
        "shared/data.js",
        "shared/followingTitleHistory.js",
        "content.js",
        "shared/uiTheme.js",
        "features/followingTitleHistory.js",
    ]) {
        dom.window.eval(readRepoFile(file));
    }
}

function waitFor(predicate, message, timeoutMs = 3000) {
    return waitForCondition(predicate, { timeoutMs, intervalMs: 20, message });
}

function emitLocalChange(chrome, entries) {
    const newValue = { version: 1, entries };
    chrome.testState.local[STORAGE_KEY] = newValue;
    for (const listener of [...chrome.testState.storageChangeListeners]) {
        listener({ [STORAGE_KEY]: { newValue: structuredClone(newValue) } }, "local");
    }
}

test("manifest loads the shared model before the following page feature and the worker imports the collector", () => {
    const manifest = JSON.parse(readRepoFile("manifest.json"));
    const scripts = manifest.content_scripts.find((entry) =>
        entry.js?.includes("features/followingTitleHistory.js")
    ).js;
    assert.ok(scripts.indexOf("shared/followingTitleHistory.js") >= 0);
    assert.ok(
        scripts.indexOf("shared/followingTitleHistory.js") < scripts.indexOf("features/followingTitleHistory.js")
    );
    assert.ok(scripts.indexOf("features/followingTitleHistory.js") > scripts.indexOf("features/followingRefresh.js"));
    assert.ok(
        scripts.indexOf("features/followingTitleHistory.js") < scripts.indexOf("features/followingPreviewTooltip.js")
    );
    assert.equal(scripts.includes("shared/followingTitleCollector.js"), false);
    assert.match(
        readRepoFile("background.js"),
        /importScripts\("shared\/followingTitleHistory\.js", "shared\/followingTitleCollector\.js"\)/
    );
});

test("previous titles of the same live open beside the current title like the replay title history", async () => {
    const chrome = createFakeChrome({
        local: {
            [STORAGE_KEY]: {
                version: 1,
                entries: [storedEntry(["첫 번째 제목", "테스트 채널 | 두 번째 제목 | 치지직 대회", "첫 번째 제목"])],
            },
        },
    });
    const { document, dom, state } = createFollowingDom({ chrome });
    evalFeatureScripts(dom);

    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "previous title toggle was not rendered");
    const titleLink = document.getElementById("liveTitle");
    const button = document.querySelector("button[data-bcfth-toggle]");
    assert.equal(titleLink.nextElementSibling, button);
    assert.equal(button.getAttribute("aria-label"), "이전 방제 1개 보기");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.deepEqual(state.requests, [CHANNEL]);

    button.click();
    const panel = document.getElementById("betterchzzk-following-title-history-panel");
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.equal(button.getAttribute("aria-label"), "이전 방제 접기");
    assert.equal(panel.hidden, false);
    assert.deepEqual(
        Array.from(panel.querySelectorAll(".bcfth-title"), (node) => node.textContent),
        ["테스트 채널 | 두 번째 제목 | 치지직 대회"]
    );

    button.click();
    assert.equal(panel.hidden, true);
    assert.equal(button.getAttribute("aria-label"), "이전 방제 1개 보기");
    assert.deepEqual(chrome.testState.localWrites, [], "the page only reads the worker's history");
});

test("the previous title toggle and panel use the shared CHZZK theme and Pretendard", async () => {
    const chrome = createFakeChrome({
        local: {
            [STORAGE_KEY]: { version: 1, entries: [storedEntry(["첫 번째 제목", "두 번째 제목", "첫 번째 제목"])] },
        },
    });
    const { document, dom } = createFollowingDom({ chrome });
    evalFeatureScripts(dom);
    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "previous title toggle was not rendered");

    const themeStyle = document.getElementById("betterchzzk-ui-theme");
    const featureStyle = document.getElementById("betterchzzk-following-title-history-style");
    assert.ok(themeStyle, "the feature requests the shared CHZZK theme");
    assert.ok(
        themeStyle.compareDocumentPosition(featureStyle) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
        "the shared theme is requested before the feature style"
    );
    const css = featureStyle.textContent;
    assert.match(
        css,
        /#betterchzzk-following-title-history-panel\{[^}]*border:1px solid var\(--bct-border\);[^}]*border-radius:var\(--bct-radius-lg\);[^}]*color:var\(--bct-text\);[^}]*background:var\(--bct-surface\);[^}]*box-shadow:var\(--bct-shadow\);[^}]*font-family:var\(--bct-font\)/s
    );
    assert.match(css, /\[data-bcfth-toggle="1"\]\[aria-expanded="true"\]\{[^}]*color:var\(--bct-brand-text\)/s);
    assert.match(css, /\.bcfth-time\{[^}]*color:var\(--bct-text-muted\)/s);
    assert.doesNotMatch(css, /theme_dark|data-theme|prefers-color-scheme/, "no local theme selectors");
    assert.doesNotMatch(css, /var\(--bct-[\w-]+,/, "shared theme variables carry no local fallback");
    assert.doesNotMatch(css, /var\(--(?:sem|Content|Surface|Background|Border)-/, "CHZZK tokens only through --bct-*");
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i, "no static color fallback");
});

test("titles stored for an earlier live of the same channel are never shown", async () => {
    const chrome = createFakeChrome({
        local: {
            [STORAGE_KEY]: {
                version: 1,
                entries: [storedEntry(["어제 방송 제목", "어제 방송 끝 제목"], { liveId: "old-live" })],
            },
        },
    });
    const { document, dom, state } = createFollowingDom({ chrome });
    evalFeatureScripts(dom);
    await waitFor(() => state.requests.length === 1, "the card live was not checked");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(document.querySelector("[data-bcfth-toggle]"), null);

    emitLocalChange(chrome, [storedEntry(["첫 번째 제목"]), storedEntry(["다른 채널"], { channelId: OTHER_CHANNEL })]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(document.querySelector("[data-bcfth-toggle]"), null, "a single title has nothing previous");

    emitLocalChange(chrome, [storedEntry(["첫 번째 제목", "바뀐 제목"])]);
    await waitFor(
        () => document.querySelector("button[data-bcfth-toggle]")?.getAttribute("aria-label") === "이전 방제 1개 보기",
        "worker updates did not refresh the toggle"
    );
    assert.equal(state.requests.length, 1, "a changed history of the verified live needs no second check");
});

test("a new live id from the worker rechecks the card once before showing its titles", async () => {
    const chrome = createFakeChrome({
        local: {
            [STORAGE_KEY]: { version: 1, entries: [storedEntry(["옛 제목", "옛 제목 2"], { liveId: "old-live" })] },
        },
    });
    const { document, dom, state } = createFollowingDom({ chrome, liveIds: { [CHANNEL]: "live-2" } });
    evalFeatureScripts(dom);
    await waitFor(() => state.requests.length === 1, "the card live was not checked");

    emitLocalChange(chrome, [storedEntry(["시작 제목", "첫 번째 제목"], { liveId: "live-2" })]);
    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "the matching live was not shown");
    assert.equal(state.requests.length, 1, "the verified live already matches the new history");

    emitLocalChange(chrome, [storedEntry(["재시작 제목", "첫 번째 제목"], { liveId: "live-3" })]);
    await waitFor(() => state.requests.length === 2, "a different stored live was not rechecked");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(document.querySelector("[data-bcfth-toggle]"), null);
    assert.equal(state.requests.length, 2, "the same stored live is not rechecked again");
});

test("a restart that changes the card title is checked again before any stored title is shown", async () => {
    const chrome = createFakeChrome({
        local: { [STORAGE_KEY]: { version: 1, entries: [storedEntry(["어제 제목 A", "어제 제목 B"])] } },
    });
    const { document, dom, state } = createFollowingDom({ chrome, title: "어제 제목 B" });
    let releaseSecondCheck = () => {};
    const secondCheck = new Promise((resolve) => {
        releaseSecondCheck = resolve;
    });
    const pageFetch = dom.window.fetch;
    dom.window.fetch = async (...args) => {
        const response = await pageFetch(...args);
        if (state.requests.length > 1) await secondCheck;
        return response;
    };
    evalFeatureScripts(dom);
    await waitFor(
        () => document.querySelector("button[data-bcfth-toggle]")?.getAttribute("aria-label") === "이전 방제 1개 보기",
        "the first live's toggle was not rendered"
    );

    // 방송을 끄고 새 방송을 켜면 카드 제목이 먼저 바뀌고, 수집기는 아직 새 라이브 ID를 쓰지 않았어요.
    state.liveIds[CHANNEL] = "live-2";
    document.getElementById("liveTitle").firstChild.nodeValue = "새 방송 제목 C";
    await waitFor(() => state.requests.length === 2, "the changed card title was not checked again");
    assert.equal(document.querySelector("[data-bcfth-toggle]"), null, "stored titles wait for the new check");

    releaseSecondCheck();
    // 두 번째 확인 응답과 이어지는 화면 동기화(requestAnimationFrame)가 끝날 시간이에요.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
        document.querySelector("[data-bcfth-toggle]"),
        null,
        "the previous live's titles never reach the new one"
    );
});

test("a checked live expires after two minutes so a same-title restart drops stored titles", async () => {
    const chrome = createFakeChrome({
        local: { [STORAGE_KEY]: { version: 1, entries: [storedEntry(["이전 제목", "첫 번째 제목"])] } },
    });
    const { document, dom, state } = createFollowingDom({ chrome });
    const realNow = dom.window.Date.now.bind(dom.window.Date);
    let offset = 0;
    dom.window.Date.now = () => realNow() + offset;
    evalFeatureScripts(dom);
    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "toggle was not rendered");

    // 같은 제목으로 다시 켠 방송이라 카드 제목은 그대로이고, 수집기도 아직 새 라이브 ID를 쓰지 않았어요.
    state.liveIds[CHANNEL] = "live-2";
    const info = document.querySelector("._information_card");
    info.textContent = "카테고리 · 1,234명";
    // 화면 동기화 한 번이 끝날 시간 동안 새 확인 요청이 없어야 해요.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(state.requests.length, 1, "a recent check is reused");

    offset = 2 * 60_000 + 1000;
    info.textContent = "카테고리 · 1,240명";
    await waitFor(() => state.requests.length === 2, "the expired check was not repeated");
    await waitFor(() => !document.querySelector("[data-bcfth-toggle]"), "stored titles stayed on the restarted live");
});

test("cards without a stored previous title send no live check", async () => {
    const chrome = createFakeChrome();
    const { document, dom, state } = createFollowingDom({ chrome });
    evalFeatureScripts(dom);
    // 저장값 읽기와 화면 동기화가 끝날 시간 동안 요청이 없어야 해요.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(state.requests, []);

    emitLocalChange(chrome, [storedEntry(["첫 번째 제목"])]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(state.requests, [], "only the current title is stored, so there is nothing to show");

    emitLocalChange(chrome, [storedEntry(["이전 제목", "첫 번째 제목"])]);
    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "a stored previous title was not shown");
    assert.deepEqual(state.requests, [CHANNEL]);
});

test("returning to the following page within two minutes reuses the checked live", async () => {
    const chrome = createFakeChrome({
        local: { [STORAGE_KEY]: { version: 1, entries: [storedEntry(["이전 제목", "첫 번째 제목"])] } },
    });
    const { document, dom, state } = createFollowingDom({ chrome });
    evalFeatureScripts(dom);
    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "toggle was not rendered");

    const navigate = (url) => {
        dom.window.history.pushState({}, "", url);
        dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    };
    navigate("/lives");
    await waitFor(() => !document.querySelector("[data-bcfth-toggle]"), "the toggle stayed outside the following page");
    navigate("/following?tab=ALL");
    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "the toggle did not come back");
    assert.deepEqual(state.requests, [CHANNEL]);
});

test("a toggle never stays on a title link that now belongs to another channel", async () => {
    const chrome = createFakeChrome({
        local: { [STORAGE_KEY]: { version: 1, entries: [storedEntry(["이전 제목", "첫 번째 제목"])] } },
    });
    const { document, dom } = createFollowingDom({ chrome, liveIds: { [CHANNEL]: "live-1", [OTHER_CHANNEL]: "x" } });
    evalFeatureScripts(dom);
    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "toggle was not rendered");

    const link = document.getElementById("liveTitle");
    link.setAttribute("href", `/live/${OTHER_CHANNEL}`);
    link.firstChild.nodeValue = "다른 채널 제목";
    await waitFor(() => !document.querySelector("[data-bcfth-toggle]"), "the reused link kept the old channel toggle");
});

test("the page feature ignores other routes, sidebar links, and the disabled option", async () => {
    const entries = [storedEntry(["이전 제목", "첫 번째 제목"])];
    const outside = createFollowingDom({
        chrome: createFakeChrome({ local: { [STORAGE_KEY]: { version: 1, entries } } }),
        url: "https://chzzk.naver.com/lives",
    });
    evalFeatureScripts(outside.dom);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(outside.state.requests, []);
    assert.equal(outside.document.querySelector("[data-bcfth-toggle]"), null);

    const disabled = createFollowingDom({
        chrome: createFakeChrome({
            local: { [STORAGE_KEY]: { version: 1, entries } },
            sync: { followingTitleHistoryEnabled: false },
        }),
    });
    evalFeatureScripts(disabled.dom);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(disabled.state.requests, []);
    assert.equal(disabled.document.querySelector("[data-bcfth-toggle]"), null);
    assert.equal(disabled.document.getElementById("betterchzzk-following-title-history-style"), null);
});

test("an open previous title panel stays put while nothing changes", async () => {
    const chrome = createFakeChrome({
        local: { [STORAGE_KEY]: { version: 1, entries: [storedEntry(["이전 제목", "첫 번째 제목"])] } },
    });
    const { document, dom } = createFollowingDom({ chrome });
    evalFeatureScripts(dom);
    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "toggle was not rendered");

    document.querySelector("button[data-bcfth-toggle]").click();
    const panel = document.getElementById("betterchzzk-following-title-history-panel");
    assert.equal(panel.hidden, false);
    const row = panel.firstElementChild;
    let redraws = 0;
    const watcher = new dom.window.MutationObserver((records) => {
        redraws += records.length;
    });
    watcher.observe(panel, { childList: true });
    // 화면 동기화(requestAnimationFrame) 여러 번이 지나갈 시간이에요. 바뀐 것이 없으면 다시 그리지 않아야 해요.
    await new Promise((resolve) => setTimeout(resolve, 250));
    watcher.disconnect();
    assert.equal(redraws, 0, "the panel's own redraw must not wake the page observer into a redraw loop");
    assert.equal(panel.firstElementChild, row, "rows stay the same nodes so their text can be selected");
    assert.equal(panel.hidden, false);
});

test("an href-only change to another channel drops the old toggle and open panel before the new check", async (t) => {
    const chrome = createFakeChrome({
        local: {
            [STORAGE_KEY]: {
                version: 1,
                entries: [
                    storedEntry(["이전 제목", "첫 번째 제목"]),
                    storedEntry(["다른 채널 이전 제목", "첫 번째 제목"], {
                        channelId: OTHER_CHANNEL,
                        liveId: "live-9",
                    }),
                ],
            },
        },
    });
    const { document, dom, state } = createFollowingDom({
        chrome,
        liveIds: { [CHANNEL]: "live-1", [OTHER_CHANNEL]: "live-9" },
    });
    let releaseOtherCheck = () => {};
    const otherCheck = new Promise((resolve) => {
        releaseOtherCheck = resolve;
    });
    t.after(() => releaseOtherCheck());
    const pageFetch = dom.window.fetch;
    dom.window.fetch = async (...args) => {
        const response = await pageFetch(...args);
        if (state.requests.at(-1) === OTHER_CHANNEL) await otherCheck;
        return response;
    };
    evalFeatureScripts(dom);
    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "toggle was not rendered");
    const panelTitles = () =>
        Array.from(
            document.querySelectorAll("#betterchzzk-following-title-history-panel .bcfth-title"),
            (node) => node.textContent
        );
    const oldButton = document.querySelector("button[data-bcfth-toggle]");
    oldButton.click();
    const panel = document.getElementById("betterchzzk-following-title-history-panel");
    assert.equal(panel.hidden, false);
    // 처음 화면 동기화가 끝날 시간이에요.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(panelTitles(), ["이전 제목"]);

    // 같은 제목 링크 노드에서 주소만 다른 채널로 바뀌었어요. 제목 텍스트·화면 크기는 그대로예요.
    document.getElementById("liveTitle").setAttribute("href", `/live/${OTHER_CHANNEL}`);
    await waitFor(() => !oldButton.isConnected, "the previous channel's toggle stayed on the reused link");
    assert.equal(panel.hidden, true, "the previous channel's open panel stayed");
    await waitFor(() => state.requests.includes(OTHER_CHANNEL), "the new channel was not checked");
    assert.equal(document.querySelector("[data-bcfth-toggle]"), null, "nothing is shown before the new check");

    releaseOtherCheck();
    await waitFor(
        () =>
            document.querySelector("button[data-bcfth-toggle]")?.getAttribute("data-bcfth-channel-id") ===
            OTHER_CHANNEL,
        "the new channel's toggle was not shown after its check"
    );
    document.querySelector("button[data-bcfth-toggle]").click();
    assert.deepEqual(panelTitles(), ["다른 채널 이전 제목"]);
});

test("a toggle reads its link again before opening, even before the page observer runs", async () => {
    const chrome = createFakeChrome({
        local: { [STORAGE_KEY]: { version: 1, entries: [storedEntry(["이전 제목", "첫 번째 제목"])] } },
    });
    const { document, dom } = createFollowingDom({ chrome, liveIds: { [CHANNEL]: "live-1", [OTHER_CHANNEL]: "x" } });
    evalFeatureScripts(dom);
    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "toggle was not rendered");
    const button = document.querySelector("button[data-bcfth-toggle]");

    // 주소가 바뀐 직후, 관찰 콜백과 화면 동기화가 돌기 전에 누른 경우예요.
    document.getElementById("liveTitle").setAttribute("href", `/live/${OTHER_CHANNEL}`);
    button.click();
    const panel = document.getElementById("betterchzzk-following-title-history-panel");
    assert.ok(!panel || panel.hidden, "the old channel's titles opened under another channel's link");
    assert.equal(button.getAttribute("aria-expanded"), "false");
});

test("an expired check is never used while its re-check is pending or after it fails", async () => {
    const chrome = createFakeChrome({
        local: { [STORAGE_KEY]: { version: 1, entries: [storedEntry(["이전 제목", "첫 번째 제목"])] } },
    });
    const { document, dom, state } = createFollowingDom({ chrome });
    const realNow = dom.window.Date.now.bind(dom.window.Date);
    let offset = 0;
    dom.window.Date.now = () => realNow() + offset;
    const pageFetch = dom.window.fetch;
    let mode = "ok";
    let releaseCheck = () => {};
    dom.window.fetch = async (...args) => {
        const response = await pageFetch(...args);
        if (mode === "fail") throw new TypeError("Failed to fetch");
        if (mode === "hold") await new Promise((resolve) => (releaseCheck = resolve));
        return response;
    };
    evalFeatureScripts(dom);
    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "toggle was not rendered");
    const panel = () => document.getElementById("betterchzzk-following-title-history-panel");
    const info = document.querySelector("._information_card");
    // 같은 제목으로 다시 켠 방송이지만 수집기는 아직 이전 방송 이력을 들고 있어요.
    state.liveIds[CHANNEL] = "live-2";

    offset = 2 * 60_000 + 1000;
    const staleButton = document.querySelector("button[data-bcfth-toggle]");
    staleButton.click();
    assert.ok(!panel() || panel().hidden, "an expired check opened the previous live's titles");

    mode = "fail";
    info.textContent = "카테고리 · 1,240명";
    await waitFor(() => state.requests.length === 2, "the expired check was not repeated");
    await waitFor(() => !document.querySelector("[data-bcfth-toggle]"), "the failed re-check kept the toggle");
    assert.equal(staleButton.isConnected, false);

    // 실패 뒤 다시 시도할 때까지 기다리는 동안에도, 다시 확인하는 중에도 이전 확인값을 쓰지 않아요.
    offset += 16_000;
    mode = "hold";
    info.textContent = "카테고리 · 1,250명";
    await waitFor(() => state.requests.length === 3, "the failed check was not retried after the cooldown");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(document.querySelector("[data-bcfth-toggle]"), null, "a pending re-check reused the expired one");

    // 같은 방송으로 다시 확인되면 이력을 다시 써요.
    state.liveIds[CHANNEL] = "live-1";
    mode = "ok";
    releaseCheck();
    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "the confirmed live was not shown again");
});

test("a valid check is refreshed before it expires so an open panel stays open", async () => {
    const chrome = createFakeChrome({
        local: { [STORAGE_KEY]: { version: 1, entries: [storedEntry(["이전 제목", "첫 번째 제목"])] } },
    });
    const { document, dom, state } = createFollowingDom({ chrome });
    const realNow = dom.window.Date.now.bind(dom.window.Date);
    let offset = 0;
    dom.window.Date.now = () => realNow() + offset;
    const pageFetch = dom.window.fetch;
    let hold = false;
    let releaseCheck = () => {};
    dom.window.fetch = async (...args) => {
        const response = await pageFetch(...args);
        if (hold) await new Promise((resolve) => (releaseCheck = resolve));
        return response;
    };
    evalFeatureScripts(dom);
    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "toggle was not rendered");
    const button = document.querySelector("button[data-bcfth-toggle]");
    button.click();
    const panel = document.getElementById("betterchzzk-following-title-history-panel");
    const row = panel.firstElementChild;
    const info = document.querySelector("._information_card");

    offset = 100_000;
    hold = true;
    info.textContent = "카테고리 · 1,240명";
    await waitFor(() => state.requests.length === 2, "a check close to expiry was not refreshed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(panel.hidden, false, "the still-valid check keeps the panel open while refreshing");
    assert.equal(button.isConnected, true);

    hold = false;
    releaseCheck();
    offset = 2 * 60_000 + 30_000;
    info.textContent = "카테고리 · 1,250명";
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(state.requests.length, 2, "the refreshed check is reused within its own two minutes");
    assert.equal(panel.hidden, false);
    assert.equal(panel.firstElementChild, row, "the refresh does not redraw the same titles");
});

function createLiveDom({
    chrome = createFakeChrome(),
    title = "첫 번째 제목",
    liveIds = { [CHANNEL]: "live-1" },
    url = `https://chzzk.naver.com/live/${CHANNEL}`,
    sidebarTitle = "",
} = {}) {
    const dom = new JSDOM(
        [
            "<!doctype html><body>",
            `<aside><a href="/live/${OTHER_CHANNEL}"><h3>${sidebarTitle || "사이드바 방송"}</h3></a></aside>`,
            "<main>",
            '<div class="pzp-pc"><video></video><div class="pzp-pc__title">',
            `<h2>${title}</h2>`,
            "</div></div>",
            '<div class="video_information_container">',
            `<div id="titleRow" class="video_information_row"><h2 id="liveTitle" class="video_information_title">${title}</h2></div>`,
            '<div class="video_information_count">1,234명 시청 중</div>',
            "</div>",
            '<section id="chat"><div id="chatList"></div></section>',
            "</main>",
            "</body>",
        ].join(""),
        { url, runScripts: "outside-only", pretendToBeVisual: true }
    );
    const state = { requests: [], liveIds, longTimers: [] };
    dom.window.chrome = chrome;
    dom.window.fetch = async (requestUrl) => {
        const channelId = String(requestUrl).match(/\/service\/v3\/channels\/([^/]+)\/live-detail$/)?.[1];
        assert.ok(channelId, `unexpected request ${requestUrl}`);
        state.requests.push(channelId);
        return { ok: true, json: async () => ({ code: 200, content: { liveId: state.liveIds[channelId] } }) };
    };
    // 라이브 화면의 재확인 예약(90초·2분·15초)은 테스트가 시각을 옮긴 뒤 직접 실행해요.
    const pageSetTimeout = dom.window.setTimeout.bind(dom.window);
    dom.window.setTimeout = (callback, delay = 0, ...args) => {
        if (delay < 15_000) return pageSetTimeout(callback, delay, ...args);
        const timer = { callback, delay, cleared: false };
        state.longTimers.push(timer);
        return -state.longTimers.length;
    };
    const pageClearTimeout = dom.window.clearTimeout.bind(dom.window);
    dom.window.clearTimeout = (id) => {
        if (id < 0) state.longTimers[-id - 1].cleared = true;
        else pageClearTimeout(id);
    };
    openDoms.add(dom);
    return { chrome, document: dom.window.document, dom, state };
}

function runLongTimers(state) {
    const timers = state.longTimers.filter((timer) => !timer.cleared);
    for (const timer of timers) timer.cleared = true;
    for (const timer of timers) timer.callback();
}

const livePanelTitles = (document) =>
    Array.from(
        document.querySelectorAll("#betterchzzk-following-title-history-panel .bcfth-title"),
        (node) => node.textContent
    );

test("the live page shows previous titles of the same live right after the broadcast title", async () => {
    const chrome = createFakeChrome({
        local: {
            [STORAGE_KEY]: {
                version: 1,
                entries: [storedEntry(["아침 제목", "점심 제목", "첫 번째 제목"])],
            },
        },
    });
    const { document, dom, state } = createLiveDom({ chrome, sidebarTitle: "첫 번째 제목" });
    evalFeatureScripts(dom);

    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "live title toggle was not rendered");
    const wrap = document.getElementById("betterchzzk-live-title-history");
    const button = document.querySelector("button[data-bcfth-toggle]");
    assert.equal(document.querySelectorAll("button[data-bcfth-toggle]").length, 1);
    assert.equal(wrap.previousElementSibling, document.getElementById("liveTitle"), "not the sidebar or player title");
    assert.equal(button.parentElement, wrap);
    assert.equal(button.getAttribute("aria-label"), "이전 방제 2개 보기");
    assert.deepEqual(state.requests, [CHANNEL]);

    button.click();
    assert.equal(button.getAttribute("aria-label"), "이전 방제 접기");
    assert.equal(document.getElementById("betterchzzk-following-title-history-panel").hidden, false);
    assert.deepEqual(livePanelTitles(document), ["아침 제목", "점심 제목"]);

    button.click();
    assert.equal(document.getElementById("betterchzzk-following-title-history-panel").hidden, true);
    assert.deepEqual(chrome.testState.localWrites, [], "the live page only reads the worker's history");
});

test("the live page shows nothing for another live, a channel without history, or a single title", async () => {
    const restarted = createLiveDom({
        chrome: createFakeChrome({
            local: { [STORAGE_KEY]: { version: 1, entries: [storedEntry(["이전 제목", "첫 번째 제목"])] } },
        }),
        liveIds: { [CHANNEL]: "live-2" },
    });
    evalFeatureScripts(restarted.dom);
    await waitFor(() => restarted.state.requests.length === 1, "the live was not checked");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(restarted.document.querySelector("[data-bcfth-toggle]"), null, "an earlier live's titles were shown");

    const single = createLiveDom({
        chrome: createFakeChrome({
            local: {
                [STORAGE_KEY]: {
                    version: 1,
                    entries: [
                        storedEntry(["첫 번째 제목"]),
                        storedEntry(["다른 채널 이전", "첫 번째 제목"], { channelId: OTHER_CHANNEL }),
                    ],
                },
            },
        }),
    });
    evalFeatureScripts(single.dom);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(single.state.requests, [], "nothing previous to show needs no live check");
    assert.equal(single.document.querySelector("[data-bcfth-toggle]"), null);
});

test("a title change on the live page is checked again and the new title leaves the list", async (t) => {
    const chrome = createFakeChrome({
        local: { [STORAGE_KEY]: { version: 1, entries: [storedEntry(["이전 제목", "첫 번째 제목"])] } },
    });
    const { document, dom, state } = createLiveDom({ chrome });
    let releaseCheck = () => {};
    let hold = false;
    t.after(() => releaseCheck());
    const pageFetch = dom.window.fetch;
    dom.window.fetch = async (...args) => {
        const response = await pageFetch(...args);
        if (hold) await new Promise((resolve) => (releaseCheck = resolve));
        return response;
    };
    evalFeatureScripts(dom);
    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "live title toggle was not rendered");

    hold = true;
    document.getElementById("liveTitle").textContent = "새 제목";
    await waitFor(() => state.requests.length === 2, "the changed title was not checked again");
    assert.equal(document.querySelector("[data-bcfth-toggle]"), null, "nothing is shown before the new check");

    hold = false;
    releaseCheck();
    await waitFor(
        () => document.querySelector("button[data-bcfth-toggle]")?.getAttribute("aria-label") === "이전 방제 2개 보기",
        "the changed title did not count both earlier titles"
    );
    document.querySelector("button[data-bcfth-toggle]").click();
    assert.deepEqual(livePanelTitles(document), ["이전 제목", "첫 번째 제목"]);
});

test("chat updates on the live page neither redraw the panel nor send live checks", async () => {
    const chrome = createFakeChrome({
        local: { [STORAGE_KEY]: { version: 1, entries: [storedEntry(["이전 제목", "첫 번째 제목"])] } },
    });
    const { document, dom, state } = createLiveDom({ chrome });
    evalFeatureScripts(dom);
    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "live title toggle was not rendered");
    document.querySelector("button[data-bcfth-toggle]").click();
    const panel = document.getElementById("betterchzzk-following-title-history-panel");
    const row = panel.firstElementChild;
    let changes = 0;
    const watcher = new dom.window.MutationObserver((records) => {
        changes += records.length;
    });
    watcher.observe(panel, { childList: true, subtree: true });
    watcher.observe(document.getElementById("titleRow"), { childList: true });

    const chatList = document.getElementById("chatList");
    for (let index = 0; index < 40; index++) {
        const message = document.createElement("div");
        message.textContent = `채팅 ${index}`;
        chatList.appendChild(message);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    watcher.disconnect();
    assert.equal(changes, 0);
    assert.equal(panel.firstElementChild, row);
    assert.equal(panel.hidden, false);
    assert.deepEqual(state.requests, [CHANNEL]);
});

test("the live page refreshes its check before it expires and drops titles once a check expires", async () => {
    const chrome = createFakeChrome({
        local: { [STORAGE_KEY]: { version: 1, entries: [storedEntry(["이전 제목", "첫 번째 제목"])] } },
    });
    const { document, dom, state } = createLiveDom({ chrome });
    const realNow = dom.window.Date.now.bind(dom.window.Date);
    let offset = 0;
    dom.window.Date.now = () => realNow() + offset;
    const pageFetch = dom.window.fetch;
    let fail = false;
    dom.window.fetch = async (...args) => {
        const response = await pageFetch(...args);
        if (fail) throw new TypeError("Failed to fetch");
        return response;
    };
    evalFeatureScripts(dom);
    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "live title toggle was not rendered");
    const button = document.querySelector("button[data-bcfth-toggle]");
    button.click();
    const panel = document.getElementById("betterchzzk-following-title-history-panel");

    // 화면이 그대로여도 90초가 지나면 스스로 다시 확인하고, 같은 방송이면 패널이 그대로 열려 있어요.
    offset = 91_000;
    runLongTimers(state);
    await waitFor(() => state.requests.length === 2, "the live page did not refresh its check on its own");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(panel.hidden, false);
    assert.equal(button.isConnected, true);

    // 다음 재확인이 실패하고 2분이 지나면 화면 변경이 없어도 버튼·패널을 거둬요.
    fail = true;
    offset = 91_000 + 91_000;
    runLongTimers(state);
    await waitFor(() => state.requests.length === 3, "the second refresh was not sent");
    await new Promise((resolve) => setTimeout(resolve, 50));
    offset = 91_000 + 121_000;
    runLongTimers(state);
    await waitFor(() => !document.querySelector("[data-bcfth-toggle]"), "an expired check kept the live toggle");
    assert.equal(panel.hidden, true);
});

test("moving to another live drops the previous channel's toggle and panel", async () => {
    const chrome = createFakeChrome({
        local: {
            [STORAGE_KEY]: {
                version: 1,
                entries: [
                    storedEntry(["이전 제목", "첫 번째 제목"]),
                    storedEntry(["다른 채널 이전", "다른 채널 제목"], { channelId: OTHER_CHANNEL, liveId: "live-9" }),
                ],
            },
        },
    });
    const { document, dom, state } = createLiveDom({
        chrome,
        liveIds: { [CHANNEL]: "live-1", [OTHER_CHANNEL]: "live-9" },
    });
    evalFeatureScripts(dom);
    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "live title toggle was not rendered");
    document.querySelector("button[data-bcfth-toggle]").click();

    dom.window.history.pushState({}, "", `/live/${OTHER_CHANNEL}`);
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await waitFor(() => !document.querySelector("[data-bcfth-toggle]"), "the previous channel's toggle stayed");
    const panel = document.getElementById("betterchzzk-following-title-history-panel");
    assert.ok(!panel || panel.hidden);

    const title = document.getElementById("liveTitle");
    title.textContent = "다른 채널 제목";
    await waitFor(
        () =>
            document.querySelector("button[data-bcfth-toggle]")?.getAttribute("data-bcfth-channel-id") ===
            OTHER_CHANNEL,
        "the new channel's toggle was not shown"
    );
    assert.ok(state.requests.includes(OTHER_CHANNEL));
    document.querySelector("button[data-bcfth-toggle]").click();
    assert.deepEqual(livePanelTitles(document), ["다른 채널 이전"]);
});

test("Space and Enter on the live title toggle open and close it without reaching the page's play shortcut", async () => {
    const chrome = createFakeChrome({
        local: { [STORAGE_KEY]: { version: 1, entries: [storedEntry(["이전 제목", "첫 번째 제목"])] } },
    });
    const { document, dom } = createLiveDom({ chrome });
    const pageKeys = [];
    // 치지직처럼 문서에서 Space를 재생 단축키로 받는 처리예요.
    document.addEventListener("keydown", (event) => pageKeys.push(event.key));
    evalFeatureScripts(dom);
    await waitFor(() => document.querySelector("button[data-bcfth-toggle]"), "live title toggle was not rendered");
    const button = document.querySelector("button[data-bcfth-toggle]");
    const press = (key) => {
        const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        button.dispatchEvent(event);
        return event;
    };

    const space = press(" ");
    assert.equal(space.defaultPrevented, true);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.equal(document.getElementById("betterchzzk-following-title-history-panel").hidden, false);
    press("Enter");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.deepEqual(pageKeys, [], "the page's Space shortcut must not see the toggle's key");
});
