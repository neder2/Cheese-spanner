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
    return { context, store: context.CheeseSpannerWatchHistoryStore };
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

for (const initialCount of [1999, 2000]) {
    test(`history capacity with ${initialCount} entries only materializes pruning rows on overflow`, () => {
        const { context, store } = loadStore();
        vm.runInContext(
            `
            globalThis.entryEnumerations = 0;
            const originalValues = Object.values;
            Object.values = function (value) {
                const keys = Object.keys(value);
                if (keys.length && keys.every((key) => key.startsWith("live:"))) entryEnumerations++;
                return originalValues(value);
            };
        `,
            context
        );
        const base = Date.parse("2026-07-10T00:00:00Z");
        const entries = Array.from({ length: initialCount }, (_, index) => ({
            id: `live:old-${index}`,
            channelId: "channel-a",
            lastWatchedAt: base + index,
        }));
        const result = store.applyMutation(
            { entries },
            createSnapshot(base + 300000, { recordId: "live:new" }),
            base + 300000
        );
        assert.equal(result.changed, true);
        assert.equal(Object.keys(result.history.entries).length, 2000);
        assert.ok(result.history.entries["live:new"]);
        assert.ok(result.history.entries[`live:old-${initialCount - 1}`]);
        assert.equal(Object.hasOwn(result.history.entries, "live:old-0"), initialCount === 1999);
        assert.equal(context.entryEnumerations, initialCount === 1999 ? 0 : 1);
    });
}

test("shared URL helpers allow only trusted CHZZK media, images, and live links", () => {
    const { context } = loadStore();
    const utils = context.CheeseSpanner.utils;

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
    const liveThumbnail =
        "https://livecloud-thumb.akamaized.net/chzzk/livecloud/KR/stream/26428721/live/21061396/record/58999967/thumbnail/image_720.jpg";
    assert.equal(utils.normalizeChzzkImageUrl(liveThumbnail), liveThumbnail);
    assert.equal(utils.normalizeChzzkMediaUrl(liveThumbnail), "", "the thumbnail host is image-only");

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
        "https://livecloud-thumb.akamaized.net.evil.example/image.jpg",
        "https://other.akamaized.net/image.jpg",
        "https://preview.livecloud-thumb.akamaized.net/image.jpg",
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

test("API titles that mention 치지직 or CHZZK mid-title keep every title change in history", () => {
    const now = Date.parse("2026-07-10T12:00:00+09:00");
    const { context, store } = loadStore();
    const utils = context.CheeseSpanner.utils;
    const final = "롤 내전 - 치지직 스트리머 대회 결승";
    const semi = "롤 내전 - 치지직 스트리머 대회 4강";
    const suffixLike = "토크 | CHZZK";
    // live-detail API titles carry no site suffix, so text that looks like one is part of the broadcast title.
    for (const title of [final, semi, suffixLike, "테스트 채널 | 롤 내전 | 치지직 대회"]) {
        assert.equal(utils.cleanEntryTitle(title, "다른 채널"), title);
    }
    assert.equal(
        utils.cleanEntryTitle(`테스트 채널 - ${final}`, "테스트 채널"),
        final,
        "channel prefix is still removed"
    );
    // Page titles (document.title, og:title) drop only the trailing site name, once.
    assert.equal(utils.cleanEntryTitle(`${final} - CHZZK`, "", { suffix: "page" }), final);
    assert.equal(utils.cleanEntryTitle(`${final} - 치지직`, "", { suffix: "page" }), final);
    assert.equal(utils.cleanEntryTitle(final, "", { suffix: "page" }), "롤 내전 - 치지직 스트리머 대회 결승");
    assert.equal(utils.cleanTitle(`${final} - CHZZK`), final);
    // The site name is removed once: the rest of a document.title and the channel name keep their own '- CHZZK'.
    assert.equal(utils.cleanEntryTitle("채널 - 토크 - CHZZK - CHZZK", "채널", { suffix: "page" }), "토크 - CHZZK");
    assert.equal(utils.cleanEntryTitle("채널 - 토크 - CHZZK", "채널", { suffix: "page" }), "토크");
    assert.equal(
        utils.cleanEntryTitle("라디오 - CHZZK - 토크 - CHZZK", "라디오 - CHZZK", { suffix: "page" }),
        "토크",
        "a channel name ending in - CHZZK is matched as is"
    );
    assert.equal(utils.cleanEntryTitle("라디오 - CHZZK - 토크 - CHZZK", "라디오 - CHZZK"), "토크 - CHZZK");
    // Only 1.4.3 following data keeps its lossy form, so old rows can still be recognised.
    assert.equal(utils.cleanEntryTitle("채널 | 롤 내전 | 치지직 대회", "채널", { suffix: "legacy" }), "롤 내전");
    assert.equal(utils.cleanEntryTitle("라디오 - CHZZK - 토크", "라디오 - CHZZK", { suffix: "legacy" }), "라디오");
    assert.equal(utils.cleanEntryTitle(`${final} - CHZZK`, "", { suffix: "legacy" }), "롤 내전");
    assert.equal(utils.cleanEntryTitle("방송 제목 | 치지직", "", { suffix: "legacy" }), "방송 제목");

    const target = { channelName: "테스트 채널" };
    utils.addTitleHistory(target, final, now - 60000);
    utils.addTitleHistory(target, semi, now);
    utils.addTitleHistory(target, suffixLike, now + 1);
    assert.deepEqual([...target.titleHistory.map((row) => row.title)], [final, semi, suffixLike]);

    let outcome = store.applyMutation(undefined, createSnapshot(now), now);
    const snapshot = createSnapshot(now + 1, { watchedSeconds: 70 });
    snapshot.entry.title = semi;
    snapshot.entry.titleHistory = target.titleHistory;
    outcome = store.applyMutation(outcome.history, snapshot, now + 1);
    const entry = outcome.history.entries["live:100"];
    assert.equal(entry.title, semi);
    assert.deepEqual([...entry.titleHistory.map((row) => row.title)], ["테스트 방송", final, semi, suffixLike]);
    // A stored row is read back as stored; nothing is rewritten or dropped on later normalizations.
    const stored = store.normalizeStoredHistory(outcome.history);
    assert.deepEqual(
        [...stored.entries["live:100"].titleHistory.map((row) => row.title)],
        ["테스트 방송", final, semi, suffixLike]
    );
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

    const totals = context.CheeseSpanner.utils.getUniqueWatchTotals(
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
    // The deletion stays scoped to the provisional session: the source keeps its barrier, and the live ID gets no
    // record-wide barrier that would also refuse other viewers' sessions of the same broadcast.
    assert.equal(outcome.history.tombstones[sourceRecordId], now);
    assert.equal(outcome.history.tombstones[targetRecordId], undefined);

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

test("a repeated migration of a deleted provisional record never deletes the live record's sessions", () => {
    const now = Date.parse("2026-07-10T12:00:00+09:00");
    const sourceRecordId = "channel:channel-a:provisional:tab-b";
    const targetRecordId = "live:shared-live";
    const migration = { kind: "migrateRecordId", sourceRecordId, targetRecordId };
    const { store } = loadStore();
    let history = store.applyMutation(
        undefined,
        createSnapshot(now, { recordId: targetRecordId, sessionId: "tab-a", enteredAt: now - 300000 }),
        now
    ).history;
    history = store.applyMutation(
        history,
        createSnapshot(now, { recordId: sourceRecordId, sessionId: "tab-b", enteredAt: now - 200000 }),
        now
    ).history;
    history = store.applyMutation(
        history,
        { kind: "deleteEntries", entryIds: [sourceRecordId], cutoffAt: now },
        now
    ).history;
    const ids = () => Array.from(history.entries[targetRecordId]?.sessionDetails || [], (row) => row.id).sort();
    // The page's response is lost, so it sends the same migration again, after the history was stored and read back.
    for (const at of [now + 10, now + 20, now + 30]) {
        history = JSON.parse(JSON.stringify(store.applyMutation(history, migration, at).history));
        assert.deepEqual(ids(), ["tab-a"], `migration at +${at - now} ms`);
    }
    for (const recordId of [targetRecordId, sourceRecordId]) {
        const late = store.applyMutation(
            history,
            createSnapshot(now + 40, { recordId, sessionId: "tab-b", enteredAt: now - 200000, watchedSeconds: 90 }),
            now + 40
        );
        assert.deepEqual([late.result.status, late.result.reason], ["ignored", "deleted"], recordId);
    }
    // A later deletion of the merged record still applies once to the whole record.
    history = store.applyMutation(
        history,
        { kind: "deleteEntries", entryIds: [sourceRecordId], cutoffAt: now + 50 },
        now + 50
    ).history;
    assert.deepEqual(ids(), []);
});

test("deleting a provisional record never refuses another session of the same broadcast", () => {
    const now = Date.parse("2026-07-10T12:00:00+09:00");
    const sourceRecordId = "channel:channel-a:provisional:tab-b";
    const targetRecordId = "live:shared-live";
    const { store } = loadStore();
    const chatAt = now - 50000;
    const chat = { id: `viewer:${chatAt}:1`, at: chatAt, kind: "chat", text: "채팅", amount: 0 };
    for (const withTarget of [true, false]) {
        let history = withTarget
            ? store.applyMutation(
                  undefined,
                  createSnapshot(now, { recordId: targetRecordId, sessionId: "tab-a", enteredAt: now - 300000 }),
                  now
              ).history
            : undefined;
        history = store.applyMutation(
            history,
            createSnapshot(now, { recordId: sourceRecordId, sessionId: "tab-b", enteredAt: now - 200000 }),
            now
        ).history;
        history = store.applyMutation(
            history,
            { kind: "deleteEntries", entryIds: [sourceRecordId], cutoffAt: now },
            now
        ).history;
        history = store.applyMutation(
            history,
            { kind: "migrateRecordId", sourceRecordId, targetRecordId },
            now + 10
        ).history;
        // Tab C started before the deletion and saves for the first time only now; tab D has chat only.
        const first = store.applyMutation(
            history,
            createSnapshot(now + 20, { recordId: targetRecordId, sessionId: "tab-c", enteredAt: now - 100000 }),
            now + 20
        );
        assert.equal(first.result.status, "applied", `first save, target present: ${withTarget}`);
        const chatOnly = store.applyMutation(
            first.history,
            {
                ...createSnapshot(now + 30, {
                    recordId: targetRecordId,
                    sessionId: "tab-d",
                    enteredAt: now - 80000,
                    watchedSeconds: 0,
                }),
                kind: "appendActivities",
                activities: [chat],
            },
            now + 30
        );
        assert.equal(chatOnly.result.status, "applied", `chat only, target present: ${withTarget}`);
        assert.deepEqual(
            Array.from(chatOnly.history.entries[targetRecordId].activities, (row) => row.id),
            [chat.id]
        );
    }
});

test("migrating a deleted provisional record keeps the live record's own sessions and still blocks the deleted one", () => {
    const now = Date.parse("2026-07-10T12:00:00+09:00");
    const sourceRecordId = "channel:channel-a:provisional:tab-b";
    const targetRecordId = "live:shared-live";
    const { store } = loadStore();
    // Tab A has already recorded the same broadcast under its live ID.
    let outcome = store.applyMutation(
        undefined,
        createSnapshot(now, { recordId: targetRecordId, sessionId: "tab-a", enteredAt: now - 300000 }),
        now
    );
    outcome = store.applyMutation(
        outcome.history,
        createSnapshot(now, { recordId: sourceRecordId, sessionId: "tab-b", enteredAt: now - 200000 }),
        now
    );
    outcome = store.applyMutation(
        outcome.history,
        { kind: "deleteEntries", entryIds: [sourceRecordId], cutoffAt: now },
        now
    );
    for (const [step, history] of [
        ["without later source sessions", outcome.history],
        [
            "with a source session after the deletion",
            store.applyMutation(
                outcome.history,
                createSnapshot(now + 5, { recordId: sourceRecordId, sessionId: "tab-b-new", enteredAt: now + 1 }),
                now + 5
            ).history,
        ],
    ]) {
        let migrated = store.applyMutation(
            history,
            { kind: "migrateRecordId", sourceRecordId, targetRecordId },
            now + 10
        );
        const ids = () => migrated.history.entries[targetRecordId].sessionDetails.map((session) => session.id).sort();
        assert.ok(ids().includes("tab-a"), `${step}: the undeleted live session stays`);
        assert.equal(migrated.history.entries[targetRecordId].watchedSeconds >= 60, true);
        // The deleted session cannot come back through the live ID or the old provisional ID.
        for (const recordId of [targetRecordId, sourceRecordId]) {
            const late = store.applyMutation(
                migrated.history,
                createSnapshot(now + 20, { recordId, sessionId: "tab-b", enteredAt: now - 200000, watchedSeconds: 90 }),
                now + 20
            );
            assert.equal(late.result.status, "ignored", `${step}: ${recordId}`);
        }
        // Tab A keeps updating its session.
        migrated = store.applyMutation(
            migrated.history,
            createSnapshot(now + 30, {
                recordId: targetRecordId,
                sessionId: "tab-a",
                enteredAt: now - 300000,
                watchedSeconds: 120,
            }),
            now + 30
        );
        assert.equal(migrated.result.status, "applied");
        assert.ok(ids().includes("tab-a"));
        assert.equal(ids().includes("tab-b"), false);
    }
});

test("a device clock that goes back keeps stored chats and ranges and still accepts the running session", () => {
    const enteredAt = Date.parse("2026-07-10T12:00:00+09:00");
    const rewound = enteredAt - 60 * 60 * 1000;
    // The writer's own clock is an hour behind every stored timestamp.
    class RewoundDate extends Date {
        static now() {
            return rewound;
        }
    }
    const { store } = loadStore({ Date: RewoundDate });
    const chats = [0, 1, 2].map((index) => {
        const at = enteredAt + 10000 + index * 1000;
        return { id: `author-a:${at}:1`, at, kind: "chat", text: `채팅 ${index}`, amount: 0 };
    });
    let outcome = store.applyMutation(
        undefined,
        { ...createSnapshot(enteredAt + 60000, { enteredAt, sessionId: "running" }), activities: chats },
        enteredAt + 60000
    );
    assert.equal(outcome.history.entries["live:100"].activities.length, 3);
    // The running session continues after the clock went back: its first timestamps are now "in the future", and
    // the page's own clock went back too, so its latest leftAt and range are an hour earlier.
    const running = createSnapshot(rewound + 60000, { enteredAt, sessionId: "running", watchedSeconds: 120 });
    running.session.leftAt = rewound + 60000;
    running.session.watchedRanges = [
        { startAt: enteredAt, endAt: enteredAt + 60000 },
        { startAt: rewound, endAt: rewound + 60000 },
    ];
    outcome = store.applyMutation(outcome.history, running, rewound + 60000);
    assert.equal(outcome.result.status, "applied");
    const entry = outcome.history.entries["live:100"];
    assert.equal(entry.sessionDetails[0].watchedSeconds, 120);
    // Measured times and day totals stay as observed; nothing is moved forward or trimmed to fit the clock.
    assert.equal(entry.sessionDetails[0].leftAt, enteredAt + 60000, "the stored leftAt, unchanged");
    assert.equal(entry.sessionDetails[0].dailySeconds["2026-07-10"], 120);
    assert.deepEqual(
        [...entry.activities.map((row) => row.id)],
        chats.map((row) => row.id),
        "stored chats are not cut by the earlier clock"
    );
    assert.ok(entry.sessionDetails[0].watchedRanges.length > 0, "stored ranges are not cut by the earlier clock");
    assert.ok(entry.sessionDetails[0].watchedRanges[0].endAt > rewound + 5 * 60 * 1000);
    // A session the writer never accepted is still judged by the current clock.
    assert.throws(() =>
        store.applyMutation(
            outcome.history,
            createSnapshot(rewound + 60000, { enteredAt, sessionId: "unknown" }),
            rewound + 60000
        )
    );
});

test("the pre-queue envelope check leaves session timestamps to the writer queue and checks the rest", () => {
    const now = Date.parse("2026-07-10T12:00:00+09:00");
    const { store } = loadStore();
    const ahead = createSnapshot(now + 60 * 60 * 1000, { sessionId: "ahead" });
    // Shape, ids, and kind are still checked before the queue; the clock is judged against stored history later.
    assert.equal(store.normalizeMutationEnvelope(ahead, now).session.id, "ahead");
    assert.throws(() => store.applyMutation(undefined, ahead, now), /in the future/);
    assert.throws(() => store.normalizeMutationEnvelope({ ...ahead, recordId: "bad" }, now), /record id/);
    assert.throws(
        () =>
            store.normalizeMutationEnvelope(
                { kind: "deleteEntries", entryIds: ["live:100"], cutoffAt: now + 3600000 },
                now
            ),
        /in the future/
    );
});

test("an accepted session cannot walk its allowed future forward with repeated snapshots", () => {
    const now = Date.parse("2026-07-10T12:00:00+09:00");
    const { store } = loadStore();
    const snapshot = (leftAt) => {
        const operation = createSnapshot(now, { enteredAt: now - 60000, sessionId: "running" });
        operation.session.leftAt = leftAt;
        return operation;
    };
    // Within the skew of the writer's own clock is accepted.
    let outcome = store.applyMutation(undefined, snapshot(now + 5 * 60 * 1000 - 1000), now);
    assert.equal(outcome.history.entries["live:100"].sessionDetails[0].leftAt, now + 5 * 60 * 1000 - 1000);
    // With the clock unchanged, the stored end does not grant another skew on top of itself, step after step.
    for (const steps of [2, 3]) {
        assert.throws(
            () => store.applyMutation(outcome.history, snapshot(now + steps * (5 * 60 * 1000 - 1000)), now),
            /in the future/
        );
    }
    // The stored end itself, and a later one once the clock really moved, are still accepted.
    outcome = store.applyMutation(outcome.history, snapshot(now + 5 * 60 * 1000 - 1000), now);
    assert.equal(outcome.history.entries["live:100"].sessionDetails[0].leftAt, now + 5 * 60 * 1000 - 1000);
    outcome = store.applyMutation(outcome.history, snapshot(now + 9 * 60 * 1000), now + 5 * 60 * 1000);
    assert.equal(outcome.history.entries["live:100"].sessionDetails[0].leftAt, now + 9 * 60 * 1000);
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

function createBackgroundHarness({ Date: ClockDate } = {}) {
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
    const context = createContext({ chrome, ...(ClockDate ? { Date: ClockDate } : {}) });
    context.importScripts = (...files) => {
        for (const file of files) {
            const source =
                file === "shared/settings.js"
                    ? sources.settings
                    : file === "shared/data.js"
                      ? sources.data
                      : file === "shared/watchHistoryStore.js"
                        ? sources.store
                        : fs.readFileSync(path.join(repoRoot, file), "utf8");
            vm.runInContext(source, context, { filename: file });
        }
    };
    vm.runInContext(sources.background, context, { filename: "background.js" });

    function send(message, sender) {
        return new Promise((resolve) => {
            const keepAlive = onMessageListener(message, sender, resolve);
            if (keepAlive !== true && message?.type !== context.CheeseSpannerWatchHistoryStore.MESSAGE_TYPE) {
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
        store: context.CheeseSpannerWatchHistoryStore,
    };
}

function mutationMessage(store, operation) {
    return { type: store.MESSAGE_TYPE, version: store.MESSAGE_VERSION, operation };
}

test("the background receiver queues a running session after the clock goes back and stores nothing it refuses", async () => {
    const enteredAt = Date.parse("2026-07-10T12:00:00+09:00");
    const rewound = enteredAt - 60 * 60 * 1000;
    const clock = { now: enteredAt + 60000 };
    class ClockDate extends Date {
        static now() {
            return clock.now;
        }
    }
    const harness = createBackgroundHarness({ Date: ClockDate });
    const sender = { id: "extension-id", tab: { id: 1 }, frameId: 0, url: "https://chzzk.naver.com/live/channel-a" };
    const send = (operation, from = sender) => harness.send(mutationMessage(harness.store, operation), from);
    const stored = () => harness.local[harness.store.STORAGE_KEY].entries["live:100"].sessionDetails[0];
    const first = await send(createSnapshot(enteredAt + 60000, { enteredAt, sessionId: "running" }));
    assert.equal(first.ok, true);
    // The device clock goes back an hour; the page's clock too, so its newest leftAt and range are an hour earlier.
    clock.now = rewound + 60000;
    const running = (watchedSeconds, { leftAt = rewound + 60000, closed = false } = {}) => {
        const operation = createSnapshot(rewound + 60000, { enteredAt, sessionId: "running", watchedSeconds, closed });
        operation.session.leftAt = leftAt;
        operation.session.watchedRanges = [
            { startAt: enteredAt, endAt: enteredAt + 60000 },
            { startAt: rewound, endAt: rewound + (watchedSeconds - 60) * 1000 },
        ];
        return operation;
    };
    const grown = await send(running(120));
    assert.deepEqual([grown.ok, grown.result?.status], [true, "applied"]);
    assert.deepEqual([stored().watchedSeconds, stored().leftAt], [120, enteredAt + 60000]);
    const ended = await send(running(130, { closed: true }));
    assert.deepEqual([ended.ok, ended.result?.status], [true, "applied"]);
    assert.deepEqual([stored().watchedSeconds, stored().closed], [130, true]);
    // Refused writes leave the stored history as it was.
    const before = JSON.stringify(harness.local);
    const refused = [
        // A session this writer never accepted is still judged by the current clock.
        createSnapshot(rewound + 60000, { enteredAt, sessionId: "unknown" }),
        // The accepted session cannot go beyond both its stored end and the current clock's skew.
        running(140, { leftAt: enteredAt + 60000 + 10 * 60 * 1000 }),
    ];
    for (const operation of refused) {
        const response = await send(operation);
        assert.equal(response.ok, false);
        assert.match(response.error, /in the future/);
        assert.equal(JSON.stringify(harness.local), before);
    }
    // Sender and incognito checks still come before the queue.
    const untrusted = await send(running(150), { ...sender, id: "other-extension" });
    assert.equal(untrusted.ok, false);
    const incognito = await send(running(150), { ...sender, tab: { id: 2, incognito: true } });
    assert.deepEqual([incognito.ok, incognito.result?.reason], [true, "incognito"]);
    // A failed storage write reports the failure and keeps the earlier value.
    harness.failNextSet();
    const failed = await send(running(150));
    assert.equal(failed.ok, false);
    assert.equal(JSON.stringify(harness.local), before);
});

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
        { id: "extension-id", tab: { id: 1 }, frameId: 0, url: "https://chzzk.naver.com/live/channel-a" }
    );
    assert.equal(wrongVersion.ok, false);
    assert.deepEqual(harness.local, {});

    const liveSender = {
        id: "extension-id",
        tab: { id: 1 },
        frameId: 0,
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
    const forgedImport = await harness.send(
        mutationMessage(harness.store, {
            kind: "replaceDonationMonths",
            snapshot: {
                owner: "viewer",
                startedAt: Date.now() - 1000,
                startMonth: "2026-01",
                endMonth: "2026-01",
                months: { "2026-01": [] },
            },
        }),
        { id: "extension-id", url: "chrome-extension://extension-id/history.html" }
    );
    assert.equal(forgedImport.ok, false, "only the background API importer may create purchase snapshots");
    assert.equal(harness.local[harness.store.STORAGE_KEY].donationImport, undefined);
});

test("background accepts immediate activity only from trusted CHZZK tabs", async () => {
    const harness = createBackgroundHarness();
    const now = Date.now();
    const operation = {
        ...createSnapshot(now),
        kind: "appendActivities",
        activities: [{ id: `viewer:${now}:1`, at: now, kind: "chat", text: "즉시 저장", amount: 0 }],
    };
    const liveSender = {
        id: "extension-id",
        tab: { id: 1 },
        frameId: 0,
        url: "https://chzzk.naver.com/live/channel-a",
    };
    const denied = await harness.send(mutationMessage(harness.store, operation), {
        ...liveSender,
        url: "https://example.com/",
    });
    assert.equal(denied.ok, false);
    // Content scripts run only in the top frame; same-origin chat frames must not write history.
    for (const untrusted of [
        { ...liveSender, frameId: 3 },
        { ...liveSender, frameId: undefined },
        { ...liveSender, origin: "https://example.com" },
        { ...liveSender, url: "https://chzzk.naver.com:8443/live/channel-a" },
    ]) {
        assert.equal((await harness.send(mutationMessage(harness.store, operation), untrusted)).ok, false);
        assert.deepEqual(harness.local, {});
    }
    const accepted = await harness.send(mutationMessage(harness.store, operation), {
        ...liveSender,
        origin: "https://chzzk.naver.com",
    });
    assert.equal(accepted.ok, true);
    const entry = harness.local[harness.store.STORAGE_KEY].entries["live:100"];
    assert.equal(entry.activities.length, 1);
    assert.equal(entry.watchedSeconds, 0);
});

test("background keeps incognito viewing and chats out of the shared profile history", async () => {
    // Without a manifest incognito key Chrome runs one worker and one storage.local for both window types.
    const harness = createBackgroundHarness();
    const now = Date.now();
    const chat = (at, text) => ({ id: `viewer:${at}:1`, at, kind: "chat", text, amount: 0 });
    const normalTab = {
        id: "extension-id",
        tab: { id: 1, incognito: false },
        frameId: 0,
        url: "https://chzzk.naver.com/live/channel-a",
        origin: "https://chzzk.naver.com",
    };
    const privateTab = { ...normalTab, tab: { id: 2, incognito: true } };
    const privateOperations = [
        { ...createSnapshot(now, { sessionId: "private" }), activities: [chat(now - 3000, "시크릿 창 채팅")] },
        {
            ...createSnapshot(now, { sessionId: "private" }),
            kind: "appendActivities",
            activities: [chat(now - 2000, "시크릿 창 즉시 채팅")],
        },
        {
            kind: "migrateRecordId",
            sourceRecordId: "channel:channel-a:provisional:private",
            targetRecordId: "live:100",
        },
    ];
    const sendPrivateOperations = async () => {
        for (const operation of privateOperations) {
            const response = await harness.send(mutationMessage(harness.store, operation), privateTab);
            // A non-error result stops the page from retrying a write that is never going to be stored.
            assert.deepEqual(JSON.parse(JSON.stringify(response)), {
                ok: true,
                result: { status: "ignored", reason: "incognito" },
            });
        }
    };

    await sendPrivateOperations();
    assert.deepEqual(harness.local, {});

    const saved = await harness.send(
        mutationMessage(harness.store, { ...createSnapshot(now), activities: [chat(now - 4000, "일반 창 채팅")] }),
        normalTab
    );
    assert.equal(saved.ok, true);
    assert.equal(saved.result.status, "applied");
    const stored = JSON.stringify(harness.local);
    await sendPrivateOperations();
    assert.equal(JSON.stringify(harness.local), stored);
    const entry = harness.local[harness.store.STORAGE_KEY].entries["live:100"];
    assert.deepEqual(
        Array.from(entry.activities, (row) => row.text),
        ["일반 창 채팅"]
    );
    assert.deepEqual(
        Array.from(entry.sessionDetails, (session) => session.id),
        ["session-a"]
    );

    const historyPage = { id: "extension-id", url: "chrome-extension://extension-id/history.html" };
    const replay = await harness.send(
        mutationMessage(harness.store, { kind: "setReplayVideoNo", recordId: "live:100", videoNo: "555" }),
        historyPage
    );
    assert.equal(replay.ok, true);
    assert.equal(harness.local[harness.store.STORAGE_KEY].entries["live:100"].replayVideoNo, "555");
});

test("background queue reports runtime.lastError and continues with the next mutation", async () => {
    const harness = createBackgroundHarness();
    const sender = { id: "extension-id", tab: { id: 1 }, frameId: 0, url: "https://chzzk.naver.com/live/channel-a" };
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
