const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const {
    createFakeChrome,
    createDom,
    evalRepoScript,
    dispatch,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

const store = globalThis.CheeseSpannerWatchHistoryStore;
const NOW = Date.parse("2026-09-18T12:00:00+09:00");
const DAY = "2026-09-18";

function activity(index, overrides = {}) {
    const at = NOW - 100000 + index;
    const kind = overrides.kind || "chat";
    return {
        id: `viewer:${at}:${kind === "chat" ? 1 : 10}`,
        at,
        kind,
        text: "같은 내용",
        amount: kind === "donation" ? 1000 : 0,
        ...overrides,
    };
}

function snapshot(activities = [], recordId = "live:100", sessionId = "session-a") {
    return {
        kind: "upsertSessionSnapshot",
        recordId,
        entry: { channelId: "channel-a", channelName: "채널 A", title: "방송 A" },
        session: {
            id: sessionId,
            enteredAt: NOW - 120000,
            leftAt: NOW,
            watchedSeconds: 120,
            dailySeconds: { [DAY]: 120 },
            watchedRanges: [{ startAt: NOW - 120000, endAt: NOW }],
        },
        activities,
    };
}

test("own activity is idempotent across retries, tabs, and identical text; donation count is separate", () => {
    const messages = [activity(1), activity(2), activity(3, { kind: "donation" })];
    let result = store.applyMutation({}, snapshot(messages), NOW);
    result = store.applyMutation(result.history, snapshot(messages, "live:100", "session-b"), NOW);
    const unchanged = store.applyMutation(result.history, snapshot(messages), NOW);
    assert.equal(unchanged.changed, false);
    const entry = result.history.entries["live:100"];
    assert.equal(entry.activities.length, 3);
    assert.deepEqual(entry.activityDaily[DAY], { chatCount: 2, donationCount: 1, donationCheese: 1000 });
});

test("activity-only mutations preserve watch aggregates, deduplicate, and obey deletion barriers", () => {
    const operation = { ...snapshot([activity(1)]), kind: "appendActivities" };
    let outcome = store.applyMutation({}, operation, NOW);
    assert.equal(outcome.history.entries["live:100"].watchedSeconds, 0);
    assert.equal(outcome.history.entries["live:100"].sessions, 0);
    outcome = store.applyMutation(outcome.history, operation, NOW);
    assert.equal(outcome.history.entries["live:100"].activityDaily[DAY].chatCount, 1);
    const legacy = {
        entries: {
            "live:100": {
                id: "live:100",
                channelId: "channel-a",
                watchedSeconds: 600,
                sessions: 2,
                firstWatchedAt: NOW - 600000,
                lastWatchedAt: NOW,
                dailySeconds: { [DAY]: 600 },
            },
        },
    };
    const preserved = store.applyMutation(legacy, operation, NOW).history.entries["live:100"];
    assert.equal(preserved.sessionDetails, undefined);
    assert.equal(preserved.watchedSeconds, 600);
    assert.equal(preserved.sessions, 2);
    assert.deepEqual(preserved.dailySeconds, { [DAY]: 600 });
    const cleared = store.applyMutation(outcome.history, { kind: "clearHistory", cutoffAt: NOW }, NOW);
    assert.equal(store.applyMutation(cleared.history, operation, NOW).result.reason, "deleted");
    assert.throws(() => store.normalizeMutation({ ...operation, activities: [] }), /activity is required/);
});

test("a delayed delete retains activity from a new session without keeping older watch time", () => {
    let history = store.applyMutation({}, snapshot([activity(1)]), NOW).history;
    const at = NOW + 2000;
    const fresh = {
        ...snapshot([{ id: `viewer:${at}:1`, at, kind: "chat", text: "새 세션", amount: 0 }]),
        kind: "appendActivities",
    };
    fresh.session.enteredAt = NOW + 1000;
    fresh.session.leftAt = at;
    history = store.applyMutation(history, fresh, at).history;
    history = store.applyMutation(
        history,
        { kind: "deleteEntries", entryIds: ["live:100"], cutoffAt: NOW },
        at
    ).history;
    const entry = history.entries["live:100"];
    assert.equal(entry.watchedSeconds, 0);
    assert.equal(entry.sessionDetails.length, 0);
    assert.deepEqual(
        entry.activities.map((row) => row.text),
        ["새 세션"]
    );
    assert.equal(entry.activityDaily[DAY].chatCount, 1);
});

test("activity requires valid server identity, time, type, amount, and a canonical live record", () => {
    const invalid = [
        activity(1, { id: "random" }),
        activity(2, { amount: -1, kind: "donation" }),
        activity(3, { kind: "mission" }),
        activity(4, { at: NOW + 3600000 }),
        activity(5, { text: {} }),
    ];
    const result = store.applyMutation({}, snapshot(invalid), NOW);
    assert.equal(result.history.entries["live:100"].activities, undefined);
    const provisional = store.applyMutation({}, snapshot([activity(1)], "channel:channel-a:provisional:x"), NOW);
    assert.equal(provisional.history.entries["channel:channel-a:provisional:x"].activities, undefined);
});

test("transcript eviction preserves counters and rejects replays of evicted messages", () => {
    let result = store.applyMutation({}, snapshot(Array.from({ length: 500 }, (_, i) => activity(i))), NOW);
    result = store.applyMutation(result.history, snapshot([activity(501)]), NOW);
    let entry = result.history.entries["live:100"];
    assert.equal(entry.activities.length, 500);
    assert.equal(entry.activityDaily[DAY].chatCount, 501);
    result = store.applyMutation(result.history, snapshot([activity(0)]), NOW);
    entry = result.history.entries["live:100"];
    assert.equal(entry.activityDaily[DAY].chatCount, 501);
    assert.equal(
        entry.activities.some((row) => row.id === activity(0).id),
        false
    );
});

test("global transcript limit preserves totals and deletion barriers prevent resurrection", () => {
    let history = {};
    for (let index = 0; index < 7; index++)
        history = store.applyMutation(
            history,
            snapshot(
                Array.from({ length: 500 }, (_, i) => activity(i + index * 500)),
                `live:${index}`
            ),
            NOW
        ).history;
    assert.equal(
        Object.values(history.entries).reduce((sum, row) => sum + row.activities.length, 0),
        3000
    );
    assert.equal(
        Object.values(history.entries).reduce((sum, row) => sum + row.activityDaily[DAY].chatCount, 0),
        3500
    );
    history = store.applyMutation(history, { kind: "deleteEntries", entryIds: ["live:6"], cutoffAt: NOW }, NOW).history;
    const late = store.applyMutation(history, snapshot([activity(3100)], "live:6"), NOW + 1);
    assert.equal(late.result.reason, "deleted");
    assert.equal(late.history.entries["live:6"], undefined);
    const cleared = store.applyMutation(late.history, { kind: "clearHistory", cutoffAt: NOW + 1 }, NOW + 1);
    assert.equal(Object.keys(cleared.history.entries).length, 0);
});

function message(overrides = {}) {
    return {
        user: "viewer",
        time: NOW + 100,
        type: 1,
        status: "NORMAL",
        originalContent: "내 채팅 <img src=x onerror=alert(1)>",
        ...overrides,
    };
}

async function collectorFixture(t, { deferred = false } = {}) {
    const dom = new JSDOM(
        '<aside id="aside-chatting"><div role="log"><div class="_wrapper_8lqsk_25"></div></div></aside>',
        { url: "https://chzzk.naver.com/live/channel-a", runScripts: "outside-only", pretendToBeVisual: true }
    );
    dom.window.chrome = createFakeChrome();
    dom.window.Date.now = () => NOW;
    let resolveIdentity;
    const requests = [];
    dom.window.fetch = async (url, options) => {
        requests.push({ url, options });
        if (deferred)
            await new Promise((resolve) => {
                resolveIdentity = resolve;
            });
        return { ok: true, json: async () => ({ code: 200, content: { loggedIn: true, userIdHash: "viewer" } }) };
    };
    for (const file of [
        "shared/settings.js",
        "shared/data.js",
        "content.js",
        "features/watchActivityPage.js",
        "features/watchActivity.js",
    ])
        evalRepoScript(dom, file);
    const captured = [];
    const collector = dom.window.CheeseSpanner.watchActivity.createCollector((value, channel) =>
        captured.push({ value, channel })
    );
    const config = { channelId: "channel-a", since: NOW, chat: true, donations: true };
    function append(data = message(), wrapper = dom.window.document.querySelector("[class*='_wrapper_']")) {
        const row = dom.window.document.createElement("div");
        row.className = "_item_8lqsk_7";
        row.__reactProps$fixture = { children: { props: { chatMessage: data } } };
        row.textContent = data.originalContent;
        wrapper.appendChild(row);
        return row;
    }
    t.after(() => {
        collector.stop();
        dom.window.close();
    });
    collector.configure(config);
    await waitForCondition(() => requests.length === 1);
    if (!deferred) await new Promise((resolve) => setImmediate(resolve));
    return { dom, captured, collector, config, append, requests, resolveIdentity: () => resolveIdentity?.() };
}

test("collector reads acknowledged own messages and only identified CHAT donations from React data", async (t) => {
    const f = await collectorFixture(t);
    f.append(message({ user: "someone-else" }));
    f.append(message({ time: NOW - 1 }));
    f.append(message({ status: "BLIND" }));
    f.append(message({ type: 10, extras: { donationType: "MISSION", payAmount: 1000 } }));
    f.append(message({ type: 10, extras: { donationType: "CHAT", isAnonymous: true, payAmount: 1000 } }));
    f.append(message());
    f.append(message({ type: 10, time: NOW + 200, extras: { donationType: "CHAT", payAmount: 1000 } }));
    await waitForCondition(() => f.captured.length === 2);
    assert.deepEqual(
        f.captured.map((row) => row.value.kind),
        ["chat", "donation"]
    );
    assert.equal(f.captured[0].value.text, message().originalContent);
    assert.equal(f.dom.window.document.querySelector("[data-bcwa-user], [data-bcwa-source]"), null);
    f.collector.configure(f.config);
    assert.equal(f.requests.length, 1, "unchanged configuration does not reauthenticate or rescan");
});

test("message-less CHAT donations retain amounts and count once without accepting malformed activity", async (t) => {
    const f = await collectorFixture(t);
    const donation = (offset, originalContent, overrides = {}) =>
        message({
            type: 10,
            time: NOW + offset,
            originalContent,
            extras: { donationType: "CHAT", payAmount: 1000 },
            ...overrides,
        });
    f.append(donation(1, ""));
    f.append(donation(2, null));
    const withoutContent = donation(3, undefined);
    delete withoutContent.originalContent;
    f.append(withoutContent);
    f.append(donation(4, {}));
    f.append(donation(5, 123));
    f.append(donation(6, null, { user: "another-viewer" }));
    f.append(donation(7, null, { status: "BLIND" }));
    f.append(donation(8, null, { extras: { donationType: "MISSION", payAmount: 1000 } }));
    f.append(donation(9, null, { extras: { donationType: "CHAT", payAmount: 0 } }));
    f.append(donation(10, null, { extras: { donationType: "CHAT", payAmount: "1000" } }));
    f.append(donation(11, null, { extras: { donationType: "CHAT", payAmount: 1000, isAnonymous: true } }));
    f.append(donation(12, null, { type: 1 }));
    f.append(donation(13, undefined, { type: 1 }));
    // A subsequent task drains the collector's mutation observer and queued microtask.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
        f.captured.map(({ value }) => ({ at: value.at, kind: value.kind, text: value.text, amount: value.amount })),
        [1, 2, 3].map((offset) => ({ at: NOW + offset, kind: "donation", text: "", amount: 1000 }))
    );
    const operation = { ...snapshot(f.captured.map(({ value }) => value)), kind: "appendActivities" };
    let result = store.applyMutation({}, operation, NOW + 100);
    result = store.applyMutation(result.history, operation, NOW + 100);
    const record = result.history.entries["live:100"];
    assert.equal(record.watchedSeconds, 0);
    assert.equal(record.activities.length, 3);
    assert.deepEqual(record.activityDaily[DAY], { chatCount: 0, donationCount: 3, donationCheese: 3000 });
});

test("collector handles row reuse, chat remount, option changes, and SPA exit without collecting other users", async (t) => {
    const f = await collectorFixture(t);
    const row = f.append();
    await waitForCondition(() => f.captured.length === 1);
    row.__reactProps$fixture.children.props.chatMessage = message({ user: "other", time: NOW + 300 });
    row.textContent = "재사용된 다른 사람의 채팅";
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.captured.length, 1);
    const oldLog = f.dom.window.document.querySelector("[role='log']");
    const newLog = oldLog.cloneNode(false);
    newLog.innerHTML = '<div class="_wrapper_8lqsk_25"></div>';
    oldLog.replaceWith(newLog);
    f.append(message({ time: NOW + 400 }));
    await waitForCondition(() => f.captured.length === 2, { timeoutMs: 1500 });
    f.collector.configure({ ...f.config, chat: false });
    f.append(message({ time: NOW + 500 }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.captured.length, 2);
    f.dom.window.history.pushState({}, "", "/live/channel-b");
    f.append(message({ type: 10, time: NOW + 600, extras: { donationType: "CHAT", payAmount: 1000 } }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.captured.length, 2);
    f.collector.stop();
    f.append(message({ time: NOW + 700 }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.captured.length, 2);
});

test("a late identity response cannot restart a disabled collector", async (t) => {
    const f = await collectorFixture(t, { deferred: true });
    f.append();
    f.collector.stop();
    f.resolveIdentity();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.requests[0].options.signal.aborted, true);
    assert.equal(f.captured.length, 0);
});

test("live history immediately persists activity before minimum watch time, including while paused", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
            liveWatchHistoryChatEnabled: true,
            liveWatchHistoryDonationEnabled: true,
        },
    });
    const dom = new JSDOM(
        '<video></video><aside id="aside-chatting"><div role="log"><div class="_wrapper_8lqsk_25"></div></div></aside>',
        { url: "https://chzzk.naver.com/live/channel-a", runScripts: "outside-only", pretendToBeVisual: true }
    );
    dom.window.chrome = chrome;
    let elapsed = 0;
    let paused = true;
    let identityRequests = 0;
    let metadataRequests = 0;
    dom.window.Date.now = () => NOW + elapsed;
    Object.defineProperty(dom.window.performance, "now", { value: () => elapsed });
    const intervals = new Map();
    dom.window.setInterval = (fn, ms) => {
        intervals.set(ms, fn);
        return ms;
    };
    dom.window.clearInterval = (id) => intervals.delete(id);
    dom.window.fetch = async (url) => {
        const identity = String(url).includes("getUserStatus");
        if (identity) identityRequests++;
        else metadataRequests++;
        return {
            ok: true,
            json: async () =>
                identity
                    ? { code: 200, content: { loggedIn: true, userIdHash: "viewer" } }
                    : {
                          content: {
                              status: "OPEN",
                              liveId: "100",
                              liveTitle: "방송 A",
                              channel: { channelId: "channel-a", channelName: "채널 A" },
                          },
                      },
        };
    };
    const video = dom.window.document.querySelector("video");
    video.getBoundingClientRect = () => ({ width: 640, height: 360, top: 0, left: 0, bottom: 360, right: 640 });
    for (const [key, get] of Object.entries({
        paused: () => paused,
        ended: () => false,
        playbackRate: () => 1,
        currentTime: () => elapsed / 1000,
        readyState: () => 4,
    }))
        Object.defineProperty(video, key, { configurable: true, get });
    t.after(async () => {
        for (const listener of chrome.testState.storageChangeListeners)
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        await new Promise((resolve) => setImmediate(resolve));
        dom.window.close();
    });
    for (const file of [
        "shared/settings.js",
        "shared/data.js",
        "content.js",
        "features/watchActivityPage.js",
        "features/watchActivity.js",
        "features/liveWatchHistory.js",
    ])
        evalRepoScript(dom, file);
    await waitForCondition(() => identityRequests === 1 && metadataRequests === 1 && intervals.has(15000));
    const append = (type, offset, originalContent = "내 채팅") => {
        const row = dom.window.document.createElement("div");
        row.className = "_item_8lqsk_7";
        row.__reactProps$fixture = {
            children: {
                props: {
                    chatMessage: message({
                        time: NOW + elapsed + offset,
                        type,
                        originalContent,
                        extras: { donationType: "CHAT", payAmount: 1000 },
                    }),
                },
            },
        };
        row.textContent = originalContent ?? "1,000치즈 후원";
        dom.window.document.querySelector("[class*='_wrapper_']").appendChild(row);
    };
    append(1, 1);
    await waitForCondition(
        () => chrome.testState.local[store.STORAGE_KEY]?.entries["live:100"]?.activities?.length === 1
    );
    const firstEntry = chrome.testState.local[store.STORAGE_KEY].entries["live:100"];
    assert.equal(firstEntry.watchedSeconds, 0, "sending chat must not invent or bypass minimum watch time");
    assert.equal(firstEntry.sessionDetails.length, 0);
    assert.equal(chrome.testState.runtimeMessages[0].operation.kind, "appendActivities");
    // A fresh history page can read the persisted message without a tracking tick or flush timer.
    const historyDom = createDom("history.html", "history.html", chrome);
    t.after(() => historyDom.window.close());
    evalRepoScript(historyDom, "shared/data.js");
    evalRepoScript(historyDom, "history.js");
    await waitForCondition(
        () => historyDom.window.document.querySelectorAll("#activityList li:not(.history-empty)").length === 1
    );
    assert.equal(historyDom.window.document.getElementById("totalLiveCount").textContent, "0개");
    paused = false;
    for (let i = 0; i < 6; i++) {
        elapsed += 10000;
        intervals.get(5000)();
    }
    intervals.get(15000)();
    await waitForCondition(
        () => chrome.testState.local[store.STORAGE_KEY]?.entries["live:100"]?.activities?.length === 1
    );
    paused = true;
    append(10, 2, null);
    await waitForCondition(() => chrome.testState.local[store.STORAGE_KEY].entries["live:100"].activities.length === 2);
    const entry = chrome.testState.local[store.STORAGE_KEY].entries["live:100"];
    assert.equal(entry.watchedSeconds, 60);
    assert.deepEqual(entry.activityDaily[DAY], { chatCount: 1, donationCount: 1, donationCheese: 1000 });
    assert.equal(entry.activities.find((activity) => activity.kind === "donation").text, "");
    // The fake writer stores synchronously but does not emit Chrome's storage change event.
    for (const listener of chrome.testState.storageChangeListeners)
        listener({ [store.STORAGE_KEY]: { newValue: chrome.testState.local[store.STORAGE_KEY] } }, "local");
    historyDom.window.document.getElementById("activityType").value = "donation";
    dispatch(historyDom, historyDom.window.document.getElementById("activityType"), "change");
    await waitForCondition(() =>
        historyDom.window.document.getElementById("activityList").textContent.includes("메시지 없는 후원")
    );
    assert.match(historyDom.window.document.getElementById("activitySummary").textContent, /1,000치즈 \(1회\)/);
    assert.ok(chrome.testState.runtimeMessages.every((message) => message.type === store.MESSAGE_TYPE));
    for (const listener of chrome.testState.storageChangeListeners)
        listener(
            { liveWatchHistoryChatEnabled: { newValue: false }, liveWatchHistoryDonationEnabled: { newValue: false } },
            "sync"
        );
    append(1, 3);
    await new Promise((resolve) => setImmediate(resolve));
    intervals.get(15000)();
    assert.equal(chrome.testState.local[store.STORAGE_KEY].entries["live:100"].activities.length, 2);
});

const LIVE_CHANNEL = "a".repeat(32);
const OTHER_CHANNEL = "b".repeat(32);
const METADATA_REFRESH_MS = 60000;
const METADATA_REFRESH_TIMER_ID = -METADATA_REFRESH_MS;

function liveDetail(content = {}) {
    return {
        code: 200,
        content: {
            status: "OPEN",
            liveId: "100",
            liveTitle: "방송 A",
            openDate: "2026-09-18 11:00:00",
            channel: { channelId: LIVE_CHANNEL, channelName: "A채널" },
            ...content,
        },
    };
}

async function liveHistoryFixture(t, { detail, pausedVideo = false }) {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
            liveWatchHistoryChatEnabled: true,
            liveWatchHistoryDonationEnabled: true,
        },
    });
    const dom = new JSDOM(
        `${pausedVideo ? "<video></video>" : ""}` +
            '<aside id="aside-chatting"><div role="log"><div class="_wrapper_8lqsk_25"></div></div></aside>',
        { url: `https://chzzk.naver.com/live/${LIVE_CHANNEL}`, runScripts: "outside-only", pretendToBeVisual: true }
    );
    dom.window.chrome = chrome;
    const f = { chrome, dom, detail, elapsed: 0, identityRequests: 0, paused: true };
    dom.window.Date.now = () => NOW + f.elapsed;
    Object.defineProperty(dom.window.performance, "now", { value: () => f.elapsed });
    const intervals = new Map();
    dom.window.setInterval = (fn, ms) => {
        intervals.set(ms, fn);
        return ms;
    };
    dom.window.clearInterval = (id) => intervals.delete(id);
    // The periodic metadata refresh runs only when a test calls f.refresh().
    const realSetTimeout = dom.window.setTimeout.bind(dom.window);
    const realClearTimeout = dom.window.clearTimeout.bind(dom.window);
    let refreshCallback = null;
    dom.window.setTimeout = (fn, ms, ...args) => {
        if (ms !== METADATA_REFRESH_MS) return realSetTimeout(fn, ms, ...args);
        refreshCallback = fn;
        return METADATA_REFRESH_TIMER_ID;
    };
    dom.window.clearTimeout = (id) => {
        if (id === METADATA_REFRESH_TIMER_ID) refreshCallback = null;
        else realClearTimeout(id);
    };
    dom.window.fetch = async (url) => {
        const identity = String(url).includes("getUserStatus");
        if (identity) f.identityRequests++;
        if (!identity && f.failDetail) throw new TypeError("Failed to fetch");
        const body = identity ? { code: 200, content: { loggedIn: true, userIdHash: "viewer" } } : f.detail;
        return { ok: true, json: async () => body };
    };
    if (pausedVideo) {
        const video = dom.window.document.querySelector("video");
        video.getBoundingClientRect = () => ({ width: 640, height: 360, top: 0, left: 0, bottom: 360, right: 640 });
        for (const [key, get] of Object.entries({
            paused: () => f.paused,
            ended: () => false,
            playbackRate: () => 1,
            currentTime: () => f.elapsed / 1000,
            readyState: () => 4,
        }))
            Object.defineProperty(video, key, { configurable: true, get });
    }
    t.after(async () => {
        for (const listener of chrome.testState.storageChangeListeners)
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        await new Promise((resolve) => setImmediate(resolve));
        dom.window.close();
    });
    for (const file of [
        "shared/settings.js",
        "shared/data.js",
        "content.js",
        "features/watchActivityPage.js",
        "features/watchActivity.js",
        "features/liveWatchHistory.js",
    ])
        evalRepoScript(dom, file);
    // The next refresh is scheduled only after the first live-detail response has been applied.
    await waitForCondition(() => f.identityRequests === 1 && refreshCallback !== null);
    f.appendChat = (text) => {
        const row = dom.window.document.createElement("div");
        row.className = "_item_8lqsk_7";
        row.__reactProps$fixture = {
            children: { props: { chatMessage: message({ time: NOW + f.elapsed + 1, originalContent: text }) } },
        };
        row.textContent = text;
        dom.window.document.querySelector("[class*='_wrapper_']").appendChild(row);
    };
    f.refresh = async () => {
        const callback = refreshCallback;
        refreshCallback = null;
        callback();
        await waitForCondition(() => refreshCallback !== null);
    };
    f.settle = async () => {
        // A later task drains the collector's observer and microtask; the flush timer then gets a chance to send.
        await new Promise((resolve) => setImmediate(resolve));
        intervals.get(15000)();
        await new Promise((resolve) => setImmediate(resolve));
    };
    f.watch = (seconds) => {
        for (let watched = 0; watched < seconds; watched += 10) {
            f.elapsed += 10000;
            intervals.get(5000)();
        }
        intervals.get(15000)();
    };
    f.entries = () => chrome.testState.local[store.STORAGE_KEY]?.entries || {};
    f.activityTexts = (recordId) => (f.entries()[recordId]?.activities || []).map((row) => row.text);
    f.mutations = () => chrome.testState.runtimeMessages.filter((row) => row?.type === store.MESSAGE_TYPE);
    return f;
}

test("live history does not attach offline-channel chat to the closed broadcast or to the next one", async (t) => {
    const f = await liveHistoryFixture(t, {
        detail: liveDetail({ status: "CLOSE", liveTitle: "3일 전 방송", openDate: "2026-09-15 12:00:00" }),
    });
    f.appendChat("방송 종료 후 채팅");
    await f.settle();
    assert.deepEqual(f.entries(), {});
    assert.equal(f.mutations().length, 0);

    f.elapsed += METADATA_REFRESH_MS;
    f.detail = liveDetail({ liveId: "101", liveTitle: "새 방송", openDate: "2026-09-18 12:00:30" });
    await f.refresh();
    f.appendChat("새 방송 채팅");
    await waitForCondition(() => f.activityTexts("live:101").length === 1);
    assert.deepEqual(Object.keys(f.entries()), ["live:101"]);
    assert.deepEqual(f.activityTexts("live:101"), ["새 방송 채팅"]);
    assert.equal(f.entries()["live:101"].watchedSeconds, 0);
});

test("live history keeps chat unattached when live-detail omits the status and the video is paused", async (t) => {
    const f = await liveHistoryFixture(t, { detail: liveDetail({ status: undefined }), pausedVideo: true });
    f.appendChat("상태 미확인 채팅");
    await f.settle();
    assert.deepEqual(f.entries(), {});
    assert.equal(f.mutations().length, 0);

    f.elapsed += METADATA_REFRESH_MS;
    f.detail = liveDetail();
    await f.refresh();
    f.appendChat("방송 확인 후 채팅");
    await waitForCondition(() => f.activityTexts("live:100").length === 1);
    assert.deepEqual(f.activityTexts("live:100"), ["방송 확인 후 채팅"]);
});

test("live history neither attaches nor discards chat on another channel's live-detail", async (t) => {
    const f = await liveHistoryFixture(t, {
        detail: liveDetail({ liveId: "200", channel: { channelId: OTHER_CHANNEL, channelName: "B채널" } }),
    });
    f.appendChat("다른 채널 응답 중 채팅");
    await f.settle();
    assert.deepEqual(f.entries(), {});
    assert.equal(f.mutations().length, 0);

    f.detail = liveDetail();
    await f.refresh();
    await waitForCondition(() => f.activityTexts("live:100").length === 1);
    assert.deepEqual(Object.keys(f.entries()), ["live:100"]);
    assert.deepEqual(f.activityTexts("live:100"), ["다른 채널 응답 중 채팅"]);
});

test("live history records paused chat for the open broadcast but not after a split to a closed one", async (t) => {
    const f = await liveHistoryFixture(t, { detail: liveDetail(), pausedVideo: true });
    f.appendChat("일시정지 중 채팅");
    await waitForCondition(() => f.activityTexts("live:100").length === 1);
    assert.equal(f.entries()["live:100"].watchedSeconds, 0);
    assert.equal(f.mutations()[0].operation.kind, "appendActivities");

    f.elapsed += METADATA_REFRESH_MS;
    f.detail = liveDetail({ status: "CLOSE", liveId: "101", liveTitle: "짧은 방송" });
    await f.refresh();
    f.appendChat("종료 확인 후 채팅");
    await f.settle();
    assert.deepEqual(Object.keys(f.entries()), ["live:100"]);
    assert.deepEqual(f.activityTexts("live:100"), ["일시정지 중 채팅"]);
});

test("live history stops attaching new chat once the same broadcast is confirmed closed", async (t) => {
    const f = await liveHistoryFixture(t, { detail: liveDetail(), pausedVideo: true });
    f.appendChat("방송 중 본인 채팅");
    await waitForCondition(() => f.activityTexts("live:100").length === 1);

    f.elapsed += METADATA_REFRESH_MS;
    f.detail = liveDetail({ status: "CLOSE" });
    await f.refresh();
    f.appendChat("종료 확인 후 본인 채팅");
    await f.settle();
    assert.deepEqual(Object.keys(f.entries()), ["live:100"]);
    assert.deepEqual(f.activityTexts("live:100"), ["방송 중 본인 채팅"]);
});

test("live history resumes new chat when the same broadcast reopens, dropping the closed-gap chat for good", async (t) => {
    const f = await liveHistoryFixture(t, { detail: liveDetail(), pausedVideo: true });
    f.appendChat("방송 중 본인 채팅");
    await waitForCondition(() => f.activityTexts("live:100").length === 1);
    f.elapsed += METADATA_REFRESH_MS;
    f.detail = liveDetail({ status: "CLOSE" });
    await f.refresh();
    f.appendChat("종료 확인 중 본인 채팅");
    await f.settle();

    f.elapsed += METADATA_REFRESH_MS;
    f.detail = liveDetail();
    await f.refresh();
    f.appendChat("재개 후 본인 채팅");
    await waitForCondition(() => f.activityTexts("live:100").length === 2);
    // A visible-tab identity check rescans every chat row, including the one typed while closed.
    f.dom.window.document.dispatchEvent(new f.dom.window.Event("visibilitychange"));
    await waitForCondition(() => f.identityRequests === 2);
    await f.settle();
    assert.deepEqual(f.activityTexts("live:100"), ["방송 중 본인 채팅", "재개 후 본인 채팅"]);
    assert.equal(f.entries()["live:100"].activityDaily[DAY].chatCount, 2);
});

test("live history keeps one watch session across a transient same-broadcast CLOSE", async (t) => {
    const f = await liveHistoryFixture(t, { detail: liveDetail(), pausedVideo: true });
    f.paused = false;
    f.watch(60);
    await waitForCondition(() => f.entries()["live:100"]?.watchedSeconds === 60);
    f.detail = liveDetail({ status: "CLOSE" });
    await f.refresh();
    f.watch(60);
    await waitForCondition(() => f.entries()["live:100"]?.watchedSeconds === 120);
    f.detail = liveDetail();
    await f.refresh();
    f.watch(60);
    await waitForCondition(() => f.entries()["live:100"]?.watchedSeconds === 180);
    assert.deepEqual(Object.keys(f.entries()), ["live:100"]);
    assert.equal(f.entries()["live:100"].sessionDetails.length, 1);
    assert.equal(new Set(f.mutations().map((row) => row.operation.session.id)).size, 1);
});

test("live history stops attaching chat once live-detail keeps failing after the last confirmation", async (t) => {
    const f = await liveHistoryFixture(t, { detail: liveDetail(), pausedVideo: true });
    f.appendChat("확인된 방송 채팅");
    await waitForCondition(() => f.activityTexts("live:100").length === 1);

    // 한 번의 조회 실패는 넘겨요.
    f.failDetail = true;
    f.elapsed += METADATA_REFRESH_MS;
    await f.refresh();
    f.appendChat("한 번 실패 뒤 채팅");
    await waitForCondition(() => f.activityTexts("live:100").length === 2);

    // 연달아 실패하면 같은 채널의 새 방송일 수 있어 지난 방송에 붙이지 않아요.
    f.elapsed += METADATA_REFRESH_MS;
    await f.refresh();
    f.appendChat("연속 실패 뒤 채팅");
    await f.settle();
    f.elapsed += METADATA_REFRESH_MS * 10;
    await f.refresh();
    f.appendChat("10분 뒤 채팅");
    await f.settle();
    assert.deepEqual(f.activityTexts("live:100"), ["확인된 방송 채팅", "한 번 실패 뒤 채팅"]);

    // 새 방송이 확인되면 그 방송에만 새 채팅을 붙여요.
    f.failDetail = false;
    f.detail = liveDetail({ liveId: "101", liveTitle: "새 방송", openDate: "2026-09-18 12:30:00" });
    f.elapsed += METADATA_REFRESH_MS;
    await f.refresh();
    f.appendChat("새 방송 채팅");
    await waitForCondition(() => f.activityTexts("live:101").length === 1);
    assert.deepEqual(f.activityTexts("live:100"), ["확인된 방송 채팅", "한 번 실패 뒤 채팅"]);
    assert.deepEqual(f.activityTexts("live:101"), ["새 방송 채팅"]);
});

test("live history resumes chat when the same broadcast is confirmed again after repeated failures", async (t) => {
    const f = await liveHistoryFixture(t, { detail: liveDetail(), pausedVideo: true });
    f.failDetail = true;
    for (let failures = 0; failures < 2; failures += 1) {
        f.elapsed += METADATA_REFRESH_MS;
        await f.refresh();
    }
    f.appendChat("확인 실패 중 채팅");
    await f.settle();
    assert.deepEqual(f.entries(), {});

    f.failDetail = false;
    f.elapsed += METADATA_REFRESH_MS;
    await f.refresh();
    f.appendChat("재확인 뒤 채팅");
    await waitForCondition(() => f.activityTexts("live:100").length === 1);
    assert.deepEqual(Object.keys(f.entries()), ["live:100"]);
    assert.deepEqual(f.activityTexts("live:100"), ["재확인 뒤 채팅"]);
});

test("history ranks channels by unique time and shows safe transcripts, counts, period filters, and deletion", async (t) => {
    let history = store.applyMutation(
        {},
        snapshot([activity(1), activity(2, { kind: "donation", text: "<img src=x onerror=alert(1)>" })]),
        NOW
    ).history;
    history = store.applyMutation(history, snapshot([], "live:101"), NOW).history;
    const second = snapshot([], "live:200");
    second.entry.channelId = "channel-b";
    second.entry.channelName = "채널 B";
    second.session.watchedSeconds = 180;
    second.session.enteredAt -= 60000;
    second.session.dailySeconds[DAY] = 180;
    second.session.watchedRanges[0].startAt -= 60000;
    history = store.applyMutation(history, second, NOW).history;
    const chrome = createFakeChrome({ local: { [store.STORAGE_KEY]: history } });
    const dom = createDom("history.html", "history.html", chrome);
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared/data.js");
    evalRepoScript(dom, "history.js");
    const document = dom.window.document;
    await waitForCondition(() => document.querySelectorAll("#channelRanking li").length === 2);
    assert.equal(document.querySelector("#channelRanking li").dataset.channelId, "channel-b");
    assert.match(document.getElementById("activitySummary").textContent, /내 채팅 1개.*1,000치즈 \(1회\)/);
    document.getElementById("activityType").value = "donation";
    dispatch(dom, document.getElementById("activityType"), "change");
    assert.match(document.getElementById("activityList").textContent, /<img src=x onerror=alert\(1\)>/);
    assert.equal(document.querySelector("#activityList img"), null);
    document.getElementById("prevMonth").click();
    assert.equal(document.querySelectorAll(".history-item").length, 0);
    document.getElementById("historyScope").value = "all";
    dispatch(dom, document.getElementById("historyScope"), "change");
    assert.equal(document.querySelectorAll(".history-item").length, 3);
    document.querySelector('[data-entry-id="live:100"] .history-entry-detail').click();
    document.querySelector('[data-entry-id="live:100"] .history-entry-delete').click();
    await waitForCondition(() => document.querySelectorAll(".history-item").length === 2);
    assert.match(document.getElementById("activitySummary").textContent, /내 후원 0치즈/);
    document.getElementById("activityType").value = "chat";
    dispatch(dom, document.getElementById("activityType"), "change");
    assert.match(document.getElementById("activitySummary").textContent, /내 채팅 0개.*0치즈/);
});

test("an open history page reflects activity immediately and ignores an older pending read", async (t) => {
    const chrome = createFakeChrome({ local: { [store.STORAGE_KEY]: {} } });
    const dom = createDom("history.html", "history.html", chrome);
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared/data.js");
    evalRepoScript(dom, "history.js");
    const document = dom.window.document;
    await waitForCondition(() => document.getElementById("notice").dataset.state === "saved");
    const pending = [];
    chrome.storage.local.get = (_keys, callback) => pending.push(callback);
    const notify = () => {
        for (const listener of chrome.testState.storageChangeListeners) listener({ [store.STORAGE_KEY]: {} }, "local");
    };
    notify();
    await waitForCondition(() => pending.length === 1, { timeoutMs: 500 });
    notify();
    await waitForCondition(() => pending.length === 2, { timeoutMs: 500 });
    const at = Date.now();
    const op = {
        ...snapshot([{ id: `viewer:${at}:1`, at, kind: "chat", text: "바로 반영", amount: 0 }]),
        kind: "appendActivities",
        session: { id: "fresh", enteredAt: at - 100, leftAt: at },
    };
    const history = store.applyMutation({}, op, at).history;
    pending[1]({ [store.STORAGE_KEY]: history });
    await waitForCondition(() => document.getElementById("activitySummary").textContent.includes("내 채팅 1개"));
    pending[0]({ [store.STORAGE_KEY]: {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(document.getElementById("activitySummary").textContent, /내 채팅 1개/);
    assert.equal(document.getElementById("totalLiveCount").textContent, "0개");
    assert.equal(document.getElementById("totalWatchTime").textContent, "0분");
    assert.match(document.querySelector(".history-item-time").textContent, /활동만 기록/);
    document.querySelector(".history-entry-detail").click();
    document.querySelector(".history-entry-delete").click();
    await waitForCondition(() => document.querySelector(".history-item") === null);
    assert.match(document.getElementById("activitySummary").textContent, /내 채팅 0개/);
});
