const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const repoRoot = path.join(__dirname, "..");
const sources = {
    background: fs.readFileSync(path.join(repoRoot, "background.js"), "utf8"),
    data: fs.readFileSync(path.join(repoRoot, "shared", "data.js"), "utf8"),
    settings: fs.readFileSync(path.join(repoRoot, "shared", "settings.js"), "utf8"),
    store: fs.readFileSync(path.join(repoRoot, "shared", "watchHistoryStore.js"), "utf8"),
};

function createContext(extra = {}) {
    return vm.createContext({
        AbortController,
        URL,
        clearTimeout,
        console,
        fetch,
        setTimeout,
        ...extra,
    });
}

function loadStore(extra = {}) {
    const context = createContext(extra);
    vm.runInContext(sources.data, context, { filename: "shared/data.js" });
    vm.runInContext(sources.store, context, { filename: "shared/watchHistoryStore.js" });
    return { context, store: context.BetterChzzkWatchHistoryStore };
}

function createSnapshot(now, overrides = {}) {
    const recordId = overrides.recordId || "live:100";
    const sessionId = overrides.sessionId || "session-a";
    const enteredAt = overrides.enteredAt || now - 120000;
    const watchedSeconds = overrides.watchedSeconds ?? 60;
    return {
        kind: "upsertSessionSnapshot",
        recordId,
        entry: {
            channelId: "channel-a",
            liveId: recordId.slice("live:".length),
            title: "테스트 방송",
            channelName: "테스트 채널",
            liveUrl: "https://chzzk.naver.com/live/channel-a",
            firstWatchedAt: enteredAt,
            lastWatchedAt: enteredAt + watchedSeconds * 1000,
            titleHistory: [{ title: "테스트 방송", firstSeenAt: enteredAt, lastSeenAt: now }],
        },
        session: {
            id: sessionId,
            title: "테스트 방송",
            enteredAt,
            leftAt: enteredAt + watchedSeconds * 1000,
            watchedSeconds,
            dailySeconds: { "2026-07-10": watchedSeconds },
            watchedRanges: [{ startAt: enteredAt, endAt: enteredAt + watchedSeconds * 1000 }],
            closed: overrides.closed === true,
        },
    };
}

test("absolute session snapshots survive worker restarts without duplicate totals or field loss", () => {
    const now = Date.parse("2026-07-10T12:00:00+09:00");
    const firstStore = loadStore().store;
    let outcome = firstStore.applyMutation(undefined, createSnapshot(now), now);
    const history = outcome.history;
    history.entries["live:100"].futureField = { keep: true };
    outcome = firstStore.applyMutation(
        history,
        { kind: "setReplayVideoNo", recordId: "live:100", videoNo: "777" },
        now + 1
    );

    const restartedStore = loadStore().store;
    const largerSnapshot = createSnapshot(now + 2, { watchedSeconds: 70 });
    outcome = restartedStore.applyMutation(outcome.history, largerSnapshot, now + 2);
    outcome = restartedStore.applyMutation(outcome.history, largerSnapshot, now + 3);

    const entry = outcome.history.entries["live:100"];
    assert.equal(entry.watchedSeconds, 70);
    assert.equal(entry.dailySeconds["2026-07-10"], 70);
    assert.equal(entry.sessionDetails.length, 1);
    assert.equal(entry.replayVideoNo, "777");
    assert.deepEqual(entry.futureField, { keep: true });
});

test("unrelated mutations preserve legacy aggregate entries without synthesizing empty session details", () => {
    const now = Date.parse("2026-07-10T12:00:00+09:00");
    const history = {
        version: 1,
        updatedAt: now - 1,
        entries: {
            "live:legacy": {
                id: "live:legacy",
                channelId: "legacy-channel",
                title: "이전 합계 기록",
                channelName: "이전 채널",
                firstWatchedAt: now - 120000,
                lastWatchedAt: now - 60000,
                watchedSeconds: 60,
                dailySeconds: { "2026-07-10": 60 },
                sessions: 1,
            },
            "live:other": {
                id: "live:other",
                liveId: "other",
                watchedSeconds: 60,
                dailySeconds: { "2026-07-10": 60 },
                sessionDetails: [createSnapshot(now, { recordId: "live:other" }).session],
            },
        },
    };
    const { store } = loadStore();

    const outcome = store.applyMutation(
        history,
        { kind: "setReplayVideoNo", recordId: "live:other", videoNo: "777" },
        now
    );

    assert.equal(Object.hasOwn(outcome.history.entries["live:legacy"], "sessionDetails"), false);
    assert.equal(outcome.history.entries["live:legacy"].watchedSeconds, 60);
    assert.equal(outcome.history.entries["live:other"].replayVideoNo, "777");
});

test("different tab sessions merge without overwriting each other", () => {
    const now = Date.parse("2026-07-10T12:00:00+09:00");
    const { store } = loadStore();
    let outcome = store.applyMutation(undefined, createSnapshot(now, { sessionId: "tab-a", watchedSeconds: 60 }), now);
    outcome = store.applyMutation(
        outcome.history,
        createSnapshot(now + 1, { sessionId: "tab-b", enteredAt: now - 60000, watchedSeconds: 80 }),
        now + 1
    );

    const entry = outcome.history.entries["live:100"];
    assert.equal(entry.sessionDetails.length, 2);
    assert.equal(entry.watchedSeconds, 140);
});

test("session aggregates keep growing after retained details reach their cap", () => {
    const now = Date.parse("2026-07-10T18:00:00+09:00");
    const dayKey = "2026-07-10";
    const firstEnteredAt = now - 301 * 2 * 60 * 1000;
    const retainedSessions = Array.from({ length: 300 }, (_, index) => {
        const enteredAt = firstEnteredAt + index * 2 * 60 * 1000;
        return {
            id: `old-${index}`,
            enteredAt,
            leftAt: enteredAt + 60 * 1000,
            watchedSeconds: 60,
            dailySeconds: { [dayKey]: 60 },
            watchedRanges: [{ startAt: enteredAt, endAt: enteredAt + 60 * 1000 }],
            closed: true,
        };
    });
    const storedSeconds = 301 * 60;
    const retiredEnteredAt = firstEnteredAt - 2 * 60 * 1000;
    const history = {
        version: 1,
        updatedAt: now - 1,
        entries: {
            "live:100": {
                id: "live:100",
                sessions: 301,
                watchedSeconds: storedSeconds,
                dailySeconds: { [dayKey]: storedSeconds },
                sessionDetails: retainedSessions,
                retiredSessionCheckpoints: [
                    {
                        id: "retired-before-cap",
                        enteredAt: retiredEnteredAt,
                        leftAt: retiredEnteredAt + 60 * 1000,
                        watchedSeconds: 60,
                        dailySeconds: { [dayKey]: 60 },
                        closed: true,
                    },
                ],
            },
        },
    };
    const { store } = loadStore();
    const snapshot = createSnapshot(now, {
        sessionId: "new-after-cap",
        enteredAt: now - 60 * 1000,
        watchedSeconds: 60,
    });

    let outcome = store.applyMutation(history, snapshot, now);
    outcome = store.applyMutation(outcome.history, snapshot, now + 1);

    const entry = outcome.history.entries["live:100"];
    assert.equal(entry.watchedSeconds, storedSeconds + 60);
    assert.equal(entry.dailySeconds[dayKey], storedSeconds + 60);
    assert.equal(entry.sessions, 302);
    assert.equal(entry.sessionDetails.length, 300);
    assert.ok(entry.sessionDetails.some((session) => session.id === "new-after-cap"));

    const retiredSnapshot = createSnapshot(now + 2, {
        sessionId: "retired-before-cap",
        enteredAt: retiredEnteredAt,
        watchedSeconds: 120,
    });
    outcome = store.applyMutation(outcome.history, retiredSnapshot, now + 2);
    outcome = store.applyMutation(outcome.history, retiredSnapshot, now + 3);
    assert.equal(outcome.history.entries["live:100"].watchedSeconds, storedSeconds + 120);
    assert.equal(outcome.history.entries["live:100"].sessions, 302);

    const delayedFirstSnapshot = createSnapshot(now + 4, {
        sessionId: "delayed-first-arrival",
        enteredAt: retiredEnteredAt - 2 * 60 * 1000,
        watchedSeconds: 60,
    });
    outcome = store.applyMutation(outcome.history, delayedFirstSnapshot, now + 4);
    outcome = store.applyMutation(outcome.history, delayedFirstSnapshot, now + 5);
    assert.equal(outcome.history.entries["live:100"].watchedSeconds, storedSeconds + 180);
    assert.equal(outcome.history.entries["live:100"].sessions, 303);
    assert.ok(
        outcome.history.entries["live:100"].retiredSessionCheckpoints.some(
            (checkpoint) => checkpoint.id === "delayed-first-arrival"
        )
    );
});

test("the bounded retired-session ledger keeps a newly delayed session idempotent", () => {
    const now = Date.parse("2026-07-10T18:00:00+09:00");
    const dayKey = "2026-07-10";
    const retainedSessions = Array.from({ length: 300 }, (_, index) => ({
        id: `detail-${index}`,
        enteredAt: now - index * 1000,
        leftAt: now - index * 1000 + 60000,
        watchedSeconds: 60,
        dailySeconds: { [dayKey]: 60 },
        closed: true,
    }));
    const retiredSessionCheckpoints = Array.from({ length: 1000 }, (_, index) => ({
        id: `checkpoint-${index}`,
        enteredAt: now - (index + 1000) * 1000,
        leftAt: now - (index + 1000) * 1000 + 60000,
        watchedSeconds: 60,
        dailySeconds: { [dayKey]: 60 },
        closed: true,
        checkpointedAt: now - index - 1,
    }));
    const storedSeconds = 1300 * 60;
    const history = {
        version: 2,
        updatedAt: now - 1,
        entries: {
            "live:100": {
                id: "live:100",
                sessions: 1300,
                watchedSeconds: storedSeconds,
                dailySeconds: { [dayKey]: storedSeconds },
                sessionDetails: retainedSessions,
                retiredSessionCheckpoints,
            },
        },
    };
    const { store } = loadStore();
    const delayedSnapshot = createSnapshot(now, {
        sessionId: "newly-delayed",
        enteredAt: now - 24 * 60 * 60 * 1000,
        watchedSeconds: 60,
    });

    let outcome = store.applyMutation(history, delayedSnapshot, now);
    outcome = store.applyMutation(outcome.history, delayedSnapshot, now + 1);

    const entry = outcome.history.entries["live:100"];
    assert.equal(entry.watchedSeconds, storedSeconds + 60);
    assert.equal(entry.sessions, 1301);
    assert.equal(entry.sessionDetails.length, 300);
    assert.equal(entry.retiredSessionCheckpoints.length, 1000);
    assert.ok(entry.retiredSessionCheckpoints.some((checkpoint) => checkpoint.id === "newly-delayed"));
});

test("delete and clear barriers reject stale snapshots but allow later sessions", () => {
    const now = Date.parse("2026-07-10T12:00:00+09:00");
    const { store } = loadStore();
    let outcome = store.applyMutation(undefined, createSnapshot(now), now);
    outcome = store.applyMutation(
        outcome.history,
        { kind: "deleteEntries", entryIds: ["live:100"], cutoffAt: now },
        now
    );
    assert.equal(outcome.history.entries["live:100"], undefined);

    outcome = store.applyMutation(outcome.history, createSnapshot(now + 1, { watchedSeconds: 120 }), now + 1);
    assert.equal(outcome.result.reason, "deleted");
    assert.equal(outcome.history.entries["live:100"], undefined);

    outcome = store.applyMutation(
        outcome.history,
        createSnapshot(now + 2, { sessionId: "after-delete", enteredAt: now + 1, watchedSeconds: 60 }),
        now + 2
    );
    assert.ok(outcome.history.entries["live:100"]);

    const clearAt = now + 3;
    outcome = store.applyMutation(outcome.history, { kind: "clearHistory", cutoffAt: clearAt }, clearAt);
    assert.deepEqual(Object.keys(outcome.history.entries), []);
    assert.deepEqual(Object.keys(outcome.history.tombstones), []);
    outcome = store.applyMutation(
        outcome.history,
        createSnapshot(clearAt + 1, { sessionId: "stale-clear", enteredAt: now - 5000 }),
        clearAt + 1
    );
    assert.equal(outcome.result.reason, "deleted");
    assert.deepEqual(Object.keys(outcome.history.entries), []);
});

test("delayed delete and clear retain sessions that started after their cutoff", () => {
    const cutoffAt = Date.parse("2026-07-10T12:00:00+09:00");

    for (const kind of ["deleteEntries", "clearHistory"]) {
        const { store } = loadStore();
        let outcome = store.applyMutation(
            undefined,
            createSnapshot(cutoffAt, { sessionId: `${kind}-old`, enteredAt: cutoffAt - 120000 }),
            cutoffAt
        );
        const newSnapshot = createSnapshot(cutoffAt + 70000, {
            sessionId: `${kind}-new`,
            enteredAt: cutoffAt + 1,
            watchedSeconds: 60,
        });
        outcome = store.applyMutation(outcome.history, newSnapshot, cutoffAt + 70000);
        const mutation = kind === "deleteEntries" ? { kind, entryIds: ["live:100"], cutoffAt } : { kind, cutoffAt };
        outcome = store.applyMutation(outcome.history, mutation, cutoffAt + 70001);

        const entry = outcome.history.entries["live:100"];
        assert.ok(entry, `${kind} should retain the newer session`);
        assert.deepEqual(
            Array.from(entry.sessionDetails, (session) => session.id),
            [`${kind}-new`]
        );
        assert.equal(entry.watchedSeconds, 60);
        assert.equal(entry.dailySeconds["2026-07-10"], 60);
        assert.equal(entry.sessions, 1);

        outcome = store.applyMutation(
            outcome.history,
            createSnapshot(cutoffAt + 70002, {
                sessionId: `${kind}-old`,
                enteredAt: cutoffAt - 120000,
            }),
            cutoffAt + 70002
        );
        assert.equal(outcome.result.reason, "deleted");
        assert.deepEqual(
            Array.from(outcome.history.entries["live:100"].sessionDetails, (session) => session.id),
            [`${kind}-new`]
        );
    }
});

test("mutation schema rejects unsupported operations and malformed record ids", () => {
    const { store } = loadStore();
    assert.throws(() => store.normalizeMutation({ kind: "replaceEverything" }), /unsupported/);
    assert.throws(
        () => store.normalizeMutation({ kind: "setReplayVideoNo", recordId: "bad", videoNo: "1" }),
        /record id/
    );
});

function createBackgroundHarness() {
    const local = {};
    let failNextSet = false;
    let onMessageListener = null;
    const runtime = {
        id: "extension-id",
        lastError: null,
        getURL: (pathname) => `chrome-extension://extension-id/${pathname}`,
        onInstalled: { addListener() {} },
        onMessage: {
            addListener(listener) {
                onMessageListener = listener;
            },
        },
    };
    const chrome = {
        runtime,
        storage: {
            local: {
                get(key, callback) {
                    setTimeout(() => callback(Object.hasOwn(local, key) ? { [key]: local[key] } : {}), 0);
                },
                set(values, callback) {
                    setTimeout(() => {
                        if (failNextSet) {
                            failNextSet = false;
                            runtime.lastError = { message: "local write failed" };
                            callback();
                            runtime.lastError = null;
                            return;
                        }
                        Object.assign(local, values);
                        callback();
                    }, 0);
                },
            },
            sync: {
                get(_keys, callback) {
                    setTimeout(() => callback({}), 0);
                },
                set(_values, callback) {
                    setTimeout(callback, 0);
                },
            },
            onChanged: { addListener() {} },
        },
    };
    const context = createContext({ chrome });
    context.importScripts = (...files) => {
        for (const file of files) {
            const source =
                file === "shared/settings.js"
                    ? sources.settings
                    : file === "shared/data.js"
                      ? sources.data
                      : sources.store;
            vm.runInContext(source, context, { filename: file });
        }
    };
    vm.runInContext(sources.background, context, { filename: "background.js" });

    function send(message, sender) {
        return new Promise((resolve) => {
            const keepAlive = onMessageListener(message, sender, resolve);
            if (keepAlive !== true && message?.type !== context.BetterChzzkWatchHistoryStore.MESSAGE_TYPE) {
                resolve(undefined);
            }
        });
    }

    return {
        chrome,
        failNextSet() {
            failNextSet = true;
        },
        local,
        send,
        store: context.BetterChzzkWatchHistoryStore,
    };
}

function mutationMessage(store, operation) {
    return { type: store.MESSAGE_TYPE, version: store.MESSAGE_VERSION, operation };
}

test("background validates sender and schema before mutating history", async () => {
    const harness = createBackgroundHarness();
    const operation = createSnapshot(Date.now());
    const untrusted = await harness.send(mutationMessage(harness.store, operation), {
        id: "other-extension",
        tab: { id: 1 },
        url: "https://chzzk.naver.com/live/channel-a",
    });
    assert.equal(untrusted.ok, false);
    assert.deepEqual(harness.local, {});

    const wrongVersion = await harness.send(
        { ...mutationMessage(harness.store, operation), version: 999 },
        { id: "extension-id", tab: { id: 1 }, url: "https://chzzk.naver.com/live/channel-a" }
    );
    assert.equal(wrongVersion.ok, false);
    assert.deepEqual(harness.local, {});

    const liveSender = {
        id: "extension-id",
        tab: { id: 1 },
        url: "https://chzzk.naver.com/live/channel-a",
    };
    assert.equal((await harness.send(mutationMessage(harness.store, operation), liveSender)).ok, true);
    const replayMessage = mutationMessage(harness.store, {
        kind: "setReplayVideoNo",
        recordId: "live:100",
        videoNo: "555",
    });
    assert.equal((await harness.send(replayMessage, liveSender)).ok, false);
    assert.equal(
        (
            await harness.send(replayMessage, {
                id: "extension-id",
                url: "chrome-extension://extension-id/history.html",
            })
        ).ok,
        true
    );
    assert.equal(harness.local[harness.store.STORAGE_KEY].entries["live:100"].replayVideoNo, "555");
});

test("background queue reports runtime.lastError and continues with the next mutation", async () => {
    const harness = createBackgroundHarness();
    const sender = { id: "extension-id", tab: { id: 1 }, url: "https://chzzk.naver.com/live/channel-a" };
    const message = mutationMessage(harness.store, createSnapshot(Date.now()));
    harness.failNextSet();

    const failed = await harness.send(message, sender);
    assert.equal(failed.ok, false);
    assert.match(failed.error, /local write failed/);

    const succeeded = await harness.send(message, sender);
    assert.equal(succeeded.ok, true);
    assert.equal(harness.local[harness.store.STORAGE_KEY].entries["live:100"].watchedSeconds, 60);
});

test("shared runtime messaging rejects chrome.runtime.lastError", async () => {
    const runtime = {
        lastError: null,
        sendMessage(_message, callback) {
            runtime.lastError = { message: "message failed" };
            callback();
            runtime.lastError = null;
        },
    };
    const { context } = loadStore({ chrome: { runtime } });
    await assert.rejects(
        context.BetterChzzk.utils.runtimeSendMessage({ test: true }),
        (error) => error?.message === "message failed"
    );
});

function createHistoryResolver(fetchImpl) {
    const dom = new JSDOM(fs.readFileSync(path.join(repoRoot, "history.html"), "utf8"), {
        url: "chrome-extension://extension-id/history.html",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    dom.window.chrome = {
        runtime: {
            getURL: (pathname) => `chrome-extension://extension-id/${pathname}`,
            sendMessage(_message, callback) {
                callback({ ok: true, result: { status: "applied" } });
            },
        },
        storage: {
            local: {
                get(_key, callback) {
                    callback({});
                },
            },
            onChanged: { addListener() {} },
        },
    };
    dom.window.confirm = () => true;
    dom.window.fetch = fetchImpl;
    dom.window.eval(sources.data);
    const historySource = fs.readFileSync(path.join(repoRoot, "history.js"), "utf8");
    dom.window.eval(`${historySource}\n;globalThis.__historyResolver = { resolveReplayVideoNo };`);
    return { dom, resolveReplayVideoNo: dom.window.__historyResolver.resolveReplayVideoNo };
}

function jsonResponse(content) {
    return Promise.resolve({ ok: true, json: async () => ({ content }) });
}

test("history replay lookup retries after an empty result instead of caching it forever", async (t) => {
    let available = false;
    let pageRequests = 0;
    const fixture = createHistoryResolver((url) => {
        if (String(url).includes("/videos?")) {
            pageRequests += 1;
            return jsonResponse({
                data: available
                    ? [{ videoNo: "42", videoType: "REPLAY", liveId: "expected-live", videoTitle: "테스트 방송" }]
                    : [],
            });
        }
        return jsonResponse({ liveId: "expected-live", videoNo: "42", videoTitle: "테스트 방송" });
    });
    t.after(() => fixture.dom.window.close());
    const entry = {
        id: "live:expected-live",
        channelId: "channel-a",
        liveId: "expected-live",
        title: "테스트 방송",
        titleHistory: [],
        liveOpenDate: "2026-07-10 10:00:00",
        firstWatchedAt: Date.parse("2026-07-10T10:00:00+09:00"),
    };

    assert.equal(await fixture.resolveReplayVideoNo(entry), "");
    available = true;
    assert.equal(await fixture.resolveReplayVideoNo(entry), "42");
    assert.equal(pageRequests, 2);
});

test("history replay lookup rejects a detail whose known liveId belongs to another broadcast", async (t) => {
    const fixture = createHistoryResolver((url) => {
        if (String(url).includes("/videos?")) {
            return jsonResponse({
                data: [
                    {
                        videoNo: "99",
                        videoType: "REPLAY",
                        videoTitle: "같은 제목",
                        liveOpenDate: "2026-07-10 10:00:00",
                    },
                ],
            });
        }
        return jsonResponse({
            videoNo: "99",
            liveId: "different-live",
            videoTitle: "같은 제목",
            liveOpenDate: "2026-07-10 10:00:00",
        });
    });
    t.after(() => fixture.dom.window.close());

    const videoNo = await fixture.resolveReplayVideoNo({
        id: "live:expected-live",
        channelId: "channel-a",
        liveId: "expected-live",
        title: "같은 제목",
        titleHistory: [],
        liveOpenDate: "2026-07-10 10:00:00",
        firstWatchedAt: Date.parse("2026-07-10T10:00:00+09:00"),
    });
    assert.equal(videoNo, "");
});

test("history replay lookup rejects a detail liveId that conflicts with a matching list liveId", async (t) => {
    const fixture = createHistoryResolver((url) => {
        if (String(url).includes("/videos?")) {
            return jsonResponse({
                data: [
                    {
                        videoNo: "100",
                        videoType: "REPLAY",
                        liveId: "expected-live",
                        videoTitle: "같은 제목",
                        liveOpenDate: "2026-07-10 10:00:00",
                    },
                ],
            });
        }
        return jsonResponse({
            videoNo: "100",
            liveId: "different-live",
            videoTitle: "같은 제목",
            liveOpenDate: "2026-07-10 10:00:00",
        });
    });
    t.after(() => fixture.dom.window.close());

    const videoNo = await fixture.resolveReplayVideoNo({
        id: "live:expected-live",
        channelId: "channel-a",
        liveId: "expected-live",
        title: "같은 제목",
        titleHistory: [],
        liveOpenDate: "2026-07-10 10:00:00",
        firstWatchedAt: Date.parse("2026-07-10T10:00:00+09:00"),
    });
    assert.equal(videoNo, "");
});
