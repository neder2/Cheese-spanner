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

test("shared URL helpers allow only trusted CHZZK media, images, and live links", () => {
    const { context } = loadStore();
    const utils = context.BetterChzzk.utils;

    assert.equal(
        utils.normalizeChzzkMediaUrl("https://nvelop-livecloud.pstatic.net/live/playlist.m3u8#fragment"),
        "https://nvelop-livecloud.pstatic.net/live/playlist.m3u8"
    );
    assert.equal(
        utils.normalizeChzzkMediaUrl(
            "https://ex-nlive-streaming.navercdn.com/chzzk/live/playlist.m3u8?token=test#fragment"
        ),
        "https://ex-nlive-streaming.navercdn.com/chzzk/live/playlist.m3u8?token=test"
    );
    assert.equal(
        utils.normalizeChzzkImageUrl("https://nng-phinf.pstatic.net/MjAy/image.jpg"),
        "https://nng-phinf.pstatic.net/MjAy/image.jpg"
    );
    assert.equal(utils.normalizeChzzkImageUrl("/assets/image.jpg"), "https://chzzk.naver.com/assets/image.jpg");

    const rejectedUrls = [
        "javascript:alert(1)",
        "data:text/plain,unsafe",
        "blob:https://chzzk.naver.com/id",
        "ftp://nng-phinf.pstatic.net/image.jpg",
        "file:///tmp/image.jpg",
        "http://nng-phinf.pstatic.net/image.jpg",
        "//evil.example/image.jpg",
        "https://evil.example/image.jpg",
        "https://pstatic.net.evil.example/image.jpg",
        "https://preview.ex-nlive-streaming.navercdn.com/live/playlist.m3u8",
        "https://ex-nlive-streaming.navercdn.com.evil.example/live/playlist.m3u8",
        "https://pstatic.net@evil.example/image.jpg",
        "https://nng-phinf.pstatic.net:444/image.jpg",
    ];
    for (const url of rejectedUrls) {
        assert.equal(utils.normalizeChzzkMediaUrl(url), "", `media URL should be rejected: ${url}`);
        assert.equal(utils.normalizeChzzkImageUrl(url), "", `image URL should be rejected: ${url}`);
    }

    assert.equal(utils.buildChzzkLiveUrl("channel_A-1"), "https://chzzk.naver.com/live/channel_A-1");
    assert.equal(
        utils.normalizeChzzkLiveUrl("https://chzzk.naver.com/live/channel_A-1?from=history#title"),
        "https://chzzk.naver.com/live/channel_A-1"
    );
    for (const url of [
        "http://chzzk.naver.com/live/channel-a",
        "https://evil.example/live/channel-a",
        "https://chzzk.naver.com.evil.example/live/channel-a",
        "https://chzzk.naver.com/video/123",
        "https://chzzk.naver.com/live/channel-a/extra",
        "https://user@chzzk.naver.com/live/channel-a",
    ]) {
        assert.equal(utils.normalizeChzzkLiveUrl(url), "", `live URL should be rejected: ${url}`);
    }
});

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

test("unique watch totals deduplicate overlapping tabs while preserving range and retired residuals", () => {
    const { context } = loadStore();
    const startAt = Date.parse("2026-07-10T12:00:00+09:00");
    const dateKey = "2026-07-10";
    const sessions = [
        {
            id: "tab-a",
            watchedSeconds: 600,
            dailySeconds: { [dateKey]: 600 },
            watchedRanges: [{ startAt, endAt: startAt + 600000 }],
        },
        {
            id: "tab-b",
            watchedSeconds: 620,
            dailySeconds: { [dateKey]: 620 },
            watchedRanges: [{ startAt, endAt: startAt + 600000 }],
        },
    ];

    const totals = context.BetterChzzk.utils.getUniqueWatchTotals(
        { watchedSeconds: 1250, dailySeconds: { [dateKey]: 1250 } },
        sessions
    );

    assert.equal(totals.watchedSeconds, 650);
    assert.equal(totals.dailySeconds[dateKey], 650);
});

test("record migration merges distinct and legacy session totals and redirects late provisional snapshots", () => {
    const now = Date.parse("2026-07-10T12:00:00+09:00");
    const sourceRecordId = "channel:channel-a:provisional:session-a";
    const targetRecordId = "live:100";
    const { store } = loadStore();
    let outcome = store.applyMutation(
        undefined,
        createSnapshot(now, { recordId: sourceRecordId, sessionId: "source-session", watchedSeconds: 60 }),
        now
    );
    const sourceEntry = outcome.history.entries[sourceRecordId];
    sourceEntry.watchedSeconds = 180;
    sourceEntry.dailySeconds["2026-07-10"] = 180;
    sourceEntry.sessions = 3;
    sourceEntry.retiredSessionStartedAtBarrier = now - 500000;
    outcome = store.applyMutation(
        outcome.history,
        createSnapshot(now + 1, {
            recordId: targetRecordId,
            sessionId: "target-session",
            enteredAt: now - 60000,
            watchedSeconds: 80,
        }),
        now + 1
    );
    outcome.history.entries[targetRecordId].retiredSessionStartedAtBarrier = now - 400000;

    outcome = store.applyMutation(
        outcome.history,
        { kind: "migrateRecordId", sourceRecordId, targetRecordId },
        now + 2
    );
    let entry = outcome.history.entries[targetRecordId];
    assert.equal(outcome.history.entries[sourceRecordId], undefined);
    assert.equal(entry.watchedSeconds, 260);
    assert.equal(entry.dailySeconds["2026-07-10"], 260);
    assert.equal(entry.sessions, 4);
    assert.equal(entry.retiredSessionStartedAtBarrier, now - 400000);
    assert.deepEqual(Array.from(entry.sessionDetails, (session) => session.id).sort(), [
        "source-session",
        "target-session",
    ]);

    outcome = store.applyMutation(
        outcome.history,
        { kind: "migrateRecordId", sourceRecordId, targetRecordId },
        now + 3
    );
    assert.equal(outcome.changed, false);
    entry = outcome.history.entries[targetRecordId];
    assert.equal(entry.watchedSeconds, 260);
    assert.equal(entry.dailySeconds["2026-07-10"], 260);
    assert.equal(entry.sessions, 4);
    assert.equal(entry.retiredSessionStartedAtBarrier, now - 400000);

    outcome = store.applyMutation(
        outcome.history,
        createSnapshot(now + 4, {
            recordId: sourceRecordId,
            sessionId: "source-session",
            watchedSeconds: 120,
        }),
        now + 4
    );
    entry = outcome.history.entries[targetRecordId];
    assert.equal(outcome.result.recordId, targetRecordId);
    assert.equal(outcome.history.entries[sourceRecordId], undefined);
    assert.equal(entry.watchedSeconds, 320);
    assert.equal(entry.sessions, 4);
});

test("a deleted provisional record propagates its barrier through migration", () => {
    const now = Date.parse("2026-07-10T12:00:00+09:00");
    const enteredAt = now - 120000;
    const sourceRecordId = "channel:channel-a:provisional:deleted-session";
    const targetRecordId = "live:deleted-live";
    const { store } = loadStore();
    let outcome = store.applyMutation(
        undefined,
        createSnapshot(now, { recordId: sourceRecordId, sessionId: "deleted-session", enteredAt }),
        now
    );
    outcome = store.applyMutation(
        outcome.history,
        { kind: "deleteEntries", entryIds: [sourceRecordId], cutoffAt: now },
        now
    );
    outcome = store.applyMutation(
        outcome.history,
        { kind: "migrateRecordId", sourceRecordId, targetRecordId },
        now + 1
    );

    assert.equal(outcome.history.entries[sourceRecordId], undefined);
    assert.equal(outcome.history.entries[targetRecordId], undefined);
    assert.equal(outcome.history.tombstones[targetRecordId], now);

    outcome = store.applyMutation(
        outcome.history,
        createSnapshot(now + 2, { recordId: targetRecordId, sessionId: "deleted-session", enteredAt }),
        now + 2
    );
    assert.equal(outcome.result.reason, "deleted");
    assert.equal(outcome.history.entries[targetRecordId], undefined);

    outcome = store.applyMutation(
        outcome.history,
        createSnapshot(now + 3, {
            recordId: targetRecordId,
            sessionId: "after-delete",
            enteredAt: now + 1,
        }),
        now + 3
    );
    assert.equal(outcome.result.status, "applied");
    assert.equal(outcome.history.entries[targetRecordId].sessionDetails[0].id, "after-delete");
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

test("tombstone compaction stays bounded and its global barrier blocks an evicted stale snapshot", () => {
    const base = Date.parse("2026-07-10T12:00:00+09:00");
    const { store } = loadStore();
    const tombstones = Object.fromEntries(
        Array.from({ length: store.HISTORY_MAX_TOMBSTONES + 1 }, (_, index) => [`live:deleted-${index}`, base + index])
    );
    const history = store.normalizeStoredHistory({ tombstones });

    assert.equal(Object.keys(history.tombstones).length, store.HISTORY_MAX_TOMBSTONES);
    assert.equal(history.tombstones["live:deleted-0"], undefined);
    assert.equal(history.compactedSessionBarrierAt, base);

    const outcome = store.applyMutation(
        history,
        createSnapshot(base + store.HISTORY_MAX_TOMBSTONES + 2, {
            recordId: "live:deleted-0",
            sessionId: "stale-after-compaction",
            enteredAt: base - 60000,
        }),
        base + store.HISTORY_MAX_TOMBSTONES + 2
    );
    assert.equal(outcome.result.reason, "deleted");
    assert.equal(outcome.history.entries["live:deleted-0"], undefined);
});

test("mutation schema rejects unsupported operations and malformed record ids", () => {
    const { store } = loadStore();
    assert.throws(() => store.normalizeMutation({ kind: "replaceEverything" }), /unsupported/);
    assert.throws(
        () => store.normalizeMutation({ kind: "setReplayVideoNo", recordId: "bad", videoNo: "1" }),
        /record id/
    );
    assert.throws(
        () =>
            store.normalizeMutation({
                kind: "setReplayVideoNo",
                recordId: `live:${"a".repeat(236)}`,
                videoNo: "1",
            }),
        /record id/
    );
    assert.throws(
        () =>
            store.normalizeMutation({
                kind: "migrateRecordId",
                sourceRecordId: "live:same",
                targetRecordId: "live:same",
            }),
        /different/
    );
});

test("stored history drops malformed record ids and keeps record maps prototype-free", () => {
    const now = Date.parse("2026-07-10T12:00:00+09:00");
    const { store } = loadStore();
    const forgedPrototypeEntry = {
        id: "__proto__",
        "live:target": {
            id: "live:forged",
            firstWatchedAt: now - 60000,
            lastWatchedAt: now,
            watchedSeconds: 60,
        },
    };
    const history = store.normalizeStoredHistory({
        updatedAt: now,
        entries: [
            forgedPrototypeEntry,
            { id: "prototype" },
            { id: "constructor" },
            { id: "toString" },
            { id: "live:normal-id" },
            { id: "channel:normal-id" },
        ],
        tombstones: { "live:normal-id": now },
        recordAliases: {
            "channel:normal-id": { targetRecordId: "live:normal-id", migratedAt: now },
        },
    });

    assert.equal(Object.getPrototypeOf(history.entries), null);
    assert.equal(Object.getPrototypeOf(history.tombstones), null);
    assert.equal(Object.getPrototypeOf(history.recordAliases), null);
    assert.deepEqual(Object.keys(history.entries).sort(), ["channel:normal-id", "live:normal-id"]);
    assert.equal(history.entries["live:target"], undefined);

    const outcome = store.applyMutation(
        { entries: [forgedPrototypeEntry] },
        { kind: "setReplayVideoNo", recordId: "live:target", videoNo: "777" },
        now
    );
    assert.equal(outcome.result.status, "missing");
    assert.equal(Object.hasOwn(outcome.history.entries, "live:target"), false);
    assert.equal(Object.getPrototypeOf(outcome.history.entries), null);
});

test("stored and incoming live URLs are canonicalized from trusted channel data", () => {
    const now = Date.parse("2026-07-10T12:00:00+09:00");
    const { store } = loadStore();
    const history = store.normalizeStoredHistory({
        entries: [
            {
                id: "live:canonical",
                channelId: "channel-a",
                liveUrl: "https://evil.example/phish",
            },
            {
                id: "live:legacy",
                liveUrl: "https://chzzk.naver.com/live/legacy-channel?from=old#title",
            },
            {
                id: "live:unsafe",
                liveUrl: "javascript:alert(1)",
            },
        ],
    });

    assert.equal(history.entries["live:canonical"].liveUrl, "https://chzzk.naver.com/live/channel-a");
    assert.equal(history.entries["live:legacy"].liveUrl, "https://chzzk.naver.com/live/legacy-channel");
    assert.equal(history.entries["live:unsafe"].liveUrl, "");

    const snapshot = createSnapshot(now);
    snapshot.entry.liveUrl = "https://evil.example/phish";
    const outcome = store.applyMutation(undefined, snapshot, now);
    assert.equal(outcome.history.entries["live:100"].liveUrl, "https://chzzk.naver.com/live/channel-a");
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

test("history replay lookup bounds detail requests across 80 full candidate pages", async (t) => {
    let pageRequests = 0;
    let detailRequests = 0;
    const fixture = createHistoryResolver((url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname.endsWith("/videos")) {
            const page = Number(parsed.searchParams.get("page"));
            pageRequests += 1;
            return jsonResponse({
                data: Array.from({ length: 30 }, (_, index) => ({
                    videoNo: `${page}-${index}`,
                    videoType: "REPLAY",
                    videoTitle: "같은 제목",
                })),
            });
        }

        detailRequests += 1;
        return jsonResponse({ videoTitle: "같은 제목" });
    });
    t.after(() => fixture.dom.window.close());

    const videoNo = await fixture.resolveReplayVideoNo({
        id: "channel:channel-a:2026-07-10",
        channelId: "channel-a",
        liveId: "",
        title: "같은 제목",
        titleHistory: [],
        firstWatchedAt: 0,
        lastWatchedAt: 0,
    });

    assert.equal(videoNo, "");
    assert.equal(pageRequests, 80);
    assert.equal(detailRequests, 20);
});

test("history replay lookup stops scheduling requests after its total time budget", async (t) => {
    let now = 1000000;
    let pageRequests = 0;
    let detailRequests = 0;
    const fixture = createHistoryResolver((url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname.endsWith("/videos")) {
            pageRequests += 1;
            now += 11000;
            return jsonResponse({
                data: Array.from({ length: 30 }, (_, index) => ({
                    videoNo: `${pageRequests}-${index}`,
                    videoType: "REPLAY",
                    videoTitle: "같은 제목",
                })),
            });
        }

        detailRequests += 1;
        return jsonResponse({ videoTitle: "같은 제목" });
    });
    t.after(() => fixture.dom.window.close());
    fixture.dom.window.Date.now = () => now;

    await fixture.resolveReplayVideoNo({
        id: "channel:channel-a:2026-07-10",
        channelId: "channel-a",
        liveId: "",
        title: "같은 제목",
        titleHistory: [],
        firstWatchedAt: 0,
        lastWatchedAt: 0,
    });

    assert.equal(pageRequests, 2);
    assert.equal(detailRequests, 5);
});
