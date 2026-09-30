const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const NOW = Date.parse("2026-09-28T03:00:00Z");
const DAY = "2026-09-28";
const ENTERED = NOW - 120000;
const repoRoot = path.join(__dirname, "..");

function load() {
    const context = vm.createContext({ URL, console });
    for (const filename of ["data.js", "watchHistoryStore.js", "watchHistoryBackup.js"]) {
        vm.runInContext(fs.readFileSync(path.join(repoRoot, "shared", filename), "utf8"), context, { filename });
    }
    return { api: context.BetterChzzkWatchHistoryBackup, store: context.BetterChzzkWatchHistoryStore };
}

function storedHistory(store) {
    return store.applyMutation(
        {},
        {
            kind: "upsertSessionSnapshot",
            recordId: "live:100",
            entry: {
                channelId: "channel-a",
                liveId: "100",
                channelName: "테스트 채널",
                title: "테스트 방송",
                titleHistory: [{ title: "테스트 방송", firstSeenAt: ENTERED, lastSeenAt: NOW }],
                liveOpenDate: "2026-09-28 11:00:00",
                thumbnailUrl: "https://livecloud-thumb.akamaized.net/image.jpg",
            },
            session: {
                id: "original-session",
                title: "테스트 방송",
                enteredAt: ENTERED,
                leftAt: NOW,
                watchedSeconds: 60,
                dailySeconds: { [DAY]: 60 },
                watchedRanges: [{ startAt: ENTERED, endAt: ENTERED + 60000 }],
                closed: true,
            },
            activities: [
                { id: `author-a:${NOW - 30000}:1`, at: NOW - 30000, kind: "chat", text: "내 채팅", amount: 0 },
                {
                    id: `author-a:${NOW - 20000}:10`,
                    at: NOW - 20000,
                    kind: "donation",
                    text: "후원 비밀",
                    amount: 1000,
                },
            ],
        },
        NOW
    ).history;
}

function backupFixture() {
    const { api, store } = load();
    const history = storedHistory(store);
    const backup = api.createBackup(history, { extensionVersion: "1.4.0", now: NOW, createdAt: NOW });
    return { api, store, history, backup };
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function rejects(api, value, code = "INVALID_FILE") {
    assert.throws(
        () => api.validateBackup(value, { now: NOW }),
        (error) => error.code === code
    );
}

test("export projects raw sessions and own chat while excluding every donation and private store field", () => {
    const { api, store } = load();
    const history = storedHistory(store);
    const entry = history.entries["live:100"];
    entry.activityDaily[DAY].chatCount = 7;
    history.donationImport = { ownerId: "secret-owner", months: ["2026-09"] };
    history.donationImportClearedAt = NOW;
    history.tombstones["live:deleted"] = NOW;
    history.token = "secret-token";
    history.entries["live:donation-only"] = {
        ...plain(entry),
        id: "live:donation-only",
        liveId: "donation-only",
        watchedSeconds: 0,
        sessions: 0,
        dailySeconds: {},
        sessionDetails: [],
        activities: entry.activities.filter((row) => row.kind === "donation"),
        activityDaily: { [DAY]: { chatCount: 0, donationCount: 1, donationCheese: 1000 } },
    };
    const before = JSON.stringify(history);
    const backup = api.createBackup(history, { extensionVersion: "1.4.0", now: NOW });
    assert.equal(backup.records.length, 1);
    assert.deepEqual(plain(backup.records[0].watch.sessionDetails), plain(entry.sessionDetails));
    assert.equal(backup.records[0].chat.messages.length, 1);
    assert.equal(backup.records[0].chat.dailyCounts[DAY], 7);
    assert.doesNotMatch(JSON.stringify(backup), /donation|secret-|후원 비밀|tombstones|clearedAt/);
    assert.equal(JSON.stringify(history), before);
    assert.deepEqual(plain(api.parseBackup(JSON.stringify(backup), { now: NOW })), plain(backup));
});

test("legacy aggregates, string title history, alias strings and missing ranges convert without changing stored totals", () => {
    const { api } = load();
    const history = {
        updatedAt: NOW,
        entries: [
            {
                id: "live:100",
                channelId: "channel-a",
                watchedSeconds: 72,
                sessions: 2,
                titleHistory: ["구형 제목"],
                dailySeconds: { [DAY]: 72 },
            },
        ],
        recordAliases: { "channel:channel-a:2026-09-28": "live:100" },
    };
    const backup = api.createBackup(history, { extensionVersion: "1.4.0", now: NOW });
    assert.equal(backup.records[0].watch.sessionDetails, null);
    assert.equal(backup.records[0].watch.watchedSeconds, 72);
    assert.equal(backup.records[0].liveId, "100");
    assert.equal(backup.records[0].titleHistory[0].title, "구형 제목");
    assert.equal(backup.recordAliases[0].targetRecordId, "live:100");
    assert.deepEqual(plain(api.validateBackup(backup, { now: NOW })), plain(backup));
});

test("empty storage and activity-only records preserve their meaning", () => {
    const { api, history } = backupFixture();
    const empty = api.createBackup(undefined, { extensionVersion: "1.4.0", now: NOW });
    assert.equal(empty.records.length, 0);
    assert.equal(api.summarizeBackup(empty).periodStartAt, null);
    const entry = history.entries["live:100"];
    Object.assign(entry, { watchedSeconds: 0, sessions: 0, dailySeconds: {}, sessionDetails: [] });
    const backup = api.createBackup(history, { extensionVersion: "1.4.0", now: NOW });
    assert.deepEqual(plain(backup.records[0].watch.sessionDetails), []);
    assert.equal(backup.records[0].chat.messages.length, 1);
    assert.equal(api.summarizeBackup(backup).totalChats, 1);
});

test("aliases canonicalize a provisional record and reject two records that resolve to the same broadcast", () => {
    const { api, history } = backupFixture();
    const sourceId = "channel:channel-a:provisional:original-session";
    const entry = history.entries["live:100"];
    delete history.entries[entry.id];
    history.entries[sourceId] = { ...entry, id: sourceId, liveId: "" };
    history.recordAliases[sourceId] = { targetRecordId: "live:100", migratedAt: NOW };
    const backup = api.createBackup(history, { extensionVersion: "1.4.0", now: NOW });
    assert.equal(backup.records[0].id, "live:100");
    history.entries["live:100"] = entry;
    assert.throws(
        () => api.createBackup(history, { extensionVersion: "1.4.0", now: NOW }),
        (error) => error.code === "INVALID_FILE"
    );
});

test("unknown fields, donated message IDs and credential or executable URLs are rejected", () => {
    for (const mutate of [
        (b) => {
            b.donationImport = {};
        },
        (b) => {
            b.records[0].chat.messages[0].amount = 0;
        },
        (b) => {
            b.records[0].chat.messages[0].id = `author-a:${NOW - 30000}:10`;
        },
        (b) => {
            b.records[0].thumbnailUrl = "javascript:alert(1)";
        },
        (b) => {
            b.records[0].thumbnailUrl = "https://name:password@pstatic.net/a.jpg";
        },
        (b) => {
            b.records[0].thumbnailUrl = "https://evil.test/a.jpg";
        },
        (b) => {
            b.records[0].liveUrl = "https://chzzk.naver.com/live/other-channel";
        },
        (b) => {
            b.records[0].chat.messages[0].nested = { a: { b: {} } };
        },
    ]) {
        const { api, backup } = backupFixture();
        mutate(backup);
        rejects(api, backup);
    }
});

test("timestamp, date, numeric, identifier and aggregate contradictions fail before import", () => {
    for (const mutate of [
        (b) => {
            b.createdAt = NOW + 300001;
        },
        (b) => {
            b.records[0].watch.watchedSeconds = Number.MAX_SAFE_INTEGER + 1;
        },
        (b) => {
            b.records[0].watch.sessions = -1;
        },
        (b) => {
            b.records[0].watch.dailySeconds = { "2026-02-30": 60 };
        },
        (b) => {
            b.records[0].watch.watchedSeconds = 59;
        },
        (b) => {
            b.records[0].watch.dailySeconds[DAY] = 59;
        },
        (b) => {
            b.records[0].chat.dailyCounts[DAY] = 0;
        },
        (b) => {
            b.records[0].liveId = "different";
        },
        (b) => {
            b.records[0].watch.sessionDetails[0].watchedRanges[0].endAt = NOW + 1;
        },
        (b) => {
            b.records[0].watch.sessionDetails[0].enteredAt = 0;
        },
        (b) => {
            b.records[0].chat.messages[0].sessionStartedAt = NOW;
        },
        (b) => {
            b.records[0].liveOpenDate = "2026-02-30 12:00:00";
        },
        (b) => {
            b.records[0].firstWatchedAt = ENTERED + 1;
        },
    ]) {
        const { api, backup } = backupFixture();
        mutate(backup);
        rejects(api, backup);
    }
});

test("duplicate broadcasts, sessions, messages and conflicting or cross-channel aliases are rejected", () => {
    for (const mutate of [
        (b) => {
            b.records.push(plain(b.records[0]));
        },
        (b) => {
            b.records[0].watch.sessionDetails.push(plain(b.records[0].watch.sessionDetails[0]));
        },
        (b) => {
            const s = plain(b.records[0].watch.sessionDetails[0]);
            delete s.watchedRanges;
            b.records[0].watch.retiredSessionCheckpoints.push({ ...s, checkpointedAt: NOW });
        },
        (b) => {
            b.records[0].chat.messages.push(plain(b.records[0].chat.messages[0]));
        },
        (b) => {
            b.recordAliases = [
                { sourceRecordId: "channel:wrong:provisional:s", targetRecordId: "live:100", migratedAt: NOW },
            ];
        },
        (b) => {
            b.recordAliases = [
                { sourceRecordId: "channel:channel-a:provisional:s", targetRecordId: "live:missing", migratedAt: NOW },
            ];
        },
    ]) {
        const { api, backup } = backupFixture();
        mutate(backup);
        rejects(api, backup);
    }
});

test("unsupported versions, malformed text, missing fields and byte limits use stable error codes", () => {
    const { api, backup } = backupFixture();
    rejects(api, { ...backup, formatVersion: 2 }, "UNSUPPORTED_VERSION");
    rejects(api, { ...backup, kind: "other-export" });
    const missing = plain(backup);
    delete missing.records[0].chat.cutoffAt;
    rejects(api, missing);
    assert.throws(
        () => api.parseBackup("{", { now: NOW }),
        (error) => error.code === "INVALID_FILE"
    );
    assert.throws(
        () => api.parseBackup(" ".repeat(101), { now: NOW, maxBytes: 100 }),
        (error) => error.code === "LIMIT_EXCEEDED"
    );
    assert.throws(
        () => api.validateBackup(backup, { now: NOW, maxBytes: 100 }),
        (error) => error.code === "LIMIT_EXCEEDED"
    );
    assert.equal(api.byteLength("한글😀"), Buffer.byteLength("한글😀", "utf8"));
});

test("oversized retained arrays and strings are rejected without trimming source data", () => {
    const { api, backup, history } = backupFixture();
    backup.records[0].chat.messages[0].text = "가".repeat(401);
    rejects(api, backup, "LIMIT_EXCEEDED");
    history.entries["live:100"].titleHistory = Array.from({ length: 21 }, (_, n) => ({
        title: `제목 ${n}`,
        firstSeenAt: ENTERED,
        lastSeenAt: NOW,
    }));
    const before = JSON.stringify(history);
    assert.throws(
        () => api.createBackup(history, { extensionVersion: "1.4.0", now: NOW }),
        (error) => error.code === "LIMIT_EXCEEDED"
    );
    assert.equal(JSON.stringify(history), before);
});

test("rounding differences and compacted range residuals remain exportable", () => {
    const { api, history } = backupFixture();
    const entry = history.entries["live:100"];
    entry.dailySeconds[DAY] = 61;
    entry.sessionDetails[0].dailySeconds[DAY] = 61;
    entry.sessionDetails[0].watchedRanges = [];
    const backup = api.createBackup(history, { extensionVersion: "1.4.0", now: NOW });
    assert.equal(backup.records[0].watch.dailySeconds[DAY], 61);
    assert.equal(backup.records[0].watch.watchedSeconds, 60);
    assert.equal(api.summarizeBackup(backup).storedChats, 1);
});

test("legacy date-only aggregates have a finite KST summary period", () => {
    const { api } = load();
    const backup = api.createBackup(
        { entries: [{ id: "live:100", watchedSeconds: 60, sessions: 1, dailySeconds: { "2026-09-27": 60 } }] },
        { extensionVersion: "1.4.0", now: NOW }
    );
    const summary = api.summarizeBackup(backup);
    assert.equal(summary.periodStartAt, Date.parse("2026-09-27T00:00:00+09:00"));
    assert.equal(summary.periodEndAt, Date.parse("2026-09-27T23:59:59.999+09:00"));
});

test("retired checkpoints and legacy sessions without ranges keep their exact counters", () => {
    const { api, history } = backupFixture();
    const entry = history.entries["live:100"];
    const retired = plain(entry.sessionDetails[0]);
    delete retired.watchedRanges;
    entry.retiredSessionCheckpoints = [{ ...retired, id: "retired", checkpointedAt: NOW }];
    entry.retiredSessionStartedAtBarrier = ENTERED - 1;
    entry.watchedSeconds = 120;
    entry.dailySeconds[DAY] = 120;
    entry.sessions = 2;
    delete entry.sessionDetails[0].watchedRanges;
    const backup = api.createBackup(history, { extensionVersion: "1.4.0", now: NOW });
    assert.equal(backup.records[0].watch.retiredSessionCheckpoints[0].watchedSeconds, 60);
    assert.deepEqual(plain(backup.records[0].watch.sessionDetails[0].watchedRanges), []);
    assert.equal(backup.records[0].watch.retiredSessionStartedAtBarrier, ENTERED - 1);
});

test("the byte ceiling is inclusive and counts escaped and multibyte text exactly", () => {
    const { api, backup } = backupFixture();
    backup.records[0].chat.messages[0].text = '😀\n"한글';
    const encoded = JSON.stringify(backup);
    const size = Buffer.byteLength(encoded);
    assert.deepEqual(plain(api.parseBackup(encoded, { now: NOW, maxBytes: size })), plain(backup));
    assert.throws(
        () => api.parseBackup(encoded, { now: NOW, maxBytes: size - 1 }),
        (error) => error.code === "LIMIT_EXCEEDED"
    );
    assert.throws(
        () => api.validateBackup(backup, { now: NOW, maxBytes: size - 1 }),
        (error) => error.code === "LIMIT_EXCEEDED"
    );
});

test("arrays respect each storage ceiling and malformed raw records never turn into a successful empty export", () => {
    for (const [key, count] of [
        ["sessionDetails", 301],
        ["retiredSessionCheckpoints", 1001],
    ]) {
        const { api, backup } = backupFixture();
        backup.records[0].watch[key] = Array(count).fill({});
        rejects(api, backup, "LIMIT_EXCEEDED");
    }
    const { api, backup, history } = backupFixture();
    backup.records = Array(2001).fill({});
    rejects(api, backup, "LIMIT_EXCEEDED");
    history.entries["live:100"].watchedSeconds = "broken";
    assert.throws(
        () => api.createBackup(history, { extensionVersion: "1.4.0", now: NOW }),
        (error) => error.code === "INVALID_FILE"
    );
    assert.throws(
        () => api.createBackup(null, { extensionVersion: "1.4.0", now: NOW }),
        (error) => error.code === "INVALID_FILE"
    );
});

test("a representative near-quota snapshot with 2000 broadcasts and 3000 Korean messages fits the 16 MiB file ceiling", (t) => {
    const { api, history } = backupFixture();
    const sample = history.entries["live:100"];
    const entries = [];
    for (let index = 0; index < 2000; index++) {
        const entry = plain(sample);
        entry.id = `live:${1000 + index}`;
        entry.liveId = String(1000 + index);
        entry.title = "가".repeat(150);
        entry.titleHistory = Array.from({ length: 4 }, (_, n) => ({
            title: `${n}${"가".repeat(150)}`,
            firstSeenAt: ENTERED,
            lastSeenAt: NOW,
        }));
        entry.activities =
            index < 6
                ? Array.from({ length: 500 }, (_, n) => ({
                      id: `author-${index}:${ENTERED + n}:1`,
                      at: ENTERED + n,
                      text: "가".repeat(400),
                      kind: "chat",
                      amount: 0,
                  }))
                : [];
        entry.activityDaily = entry.activities.length
            ? { [DAY]: { chatCount: entry.activities.length, donationCount: 0, donationCheese: 0 } }
            : {};
        entries.push(entry);
    }
    const sourceBytes = Buffer.byteLength(JSON.stringify({ entries }));
    const backup = api.createBackup({ entries }, { extensionVersion: "1.4.0", now: NOW });
    const output = JSON.stringify(backup);
    const backupBytes = Buffer.byteLength(output);
    assert.equal(backup.records.length, 2000);
    assert.equal(api.summarizeBackup(backup).storedChats, 3000);
    assert.ok(backupBytes > 8 * 1024 * 1024 && backupBytes < api.LIMITS.maxBytes);
    assert.equal(api.parseBackup(output, { now: NOW }).records.length, 2000);
    t.diagnostic(
        `Synthetic source: ${sourceBytes} bytes; compact backup: ${backupBytes} bytes; ceiling: ${api.LIMITS.maxBytes} bytes.`
    );
});

test("export preserves legacy replayVideoNo, videoNo and videoId precedence", () => {
    for (const [fields, expected] of [
        [{ videoNo: "123" }, "123"],
        [{ videoId: 456 }, "456"],
        [{ replayVideoNo: " ", videoNo: " 789 ", videoId: "456" }, "789"],
        [{ replayVideoNo: "321", videoNo: "123", videoId: "456" }, "321"],
    ]) {
        const { api, history } = backupFixture();
        Object.assign(history.entries["live:100"], fields);
        const backup = api.createBackup(history, { extensionVersion: "1.4.0", now: NOW });
        assert.equal(backup.records[0].replayVideoNo, expected);
        assert.equal(Object.hasOwn(backup.records[0], "videoNo"), false);
        assert.equal(Object.hasOwn(backup.records[0], "videoId"), false);
    }
});

test("export canonicalizes supported legacy live links while file input and malformed source URLs remain strict", () => {
    for (const fields of [
        { liveUrl: "https://chzzk.naver.com/live/channel-a/?from=history#player" },
        { channelId: "", liveUrl: "https://chzzk.naver.com/live/%63hannel-a?from=history#player" },
        { channelId: " channel-a ", liveUrl: "" },
    ]) {
        const { api, history } = backupFixture();
        Object.assign(history.entries["live:100"], fields);
        const before = JSON.stringify(history);
        const backup = api.createBackup(history, { extensionVersion: "1.4.0", now: NOW });
        assert.equal(backup.records[0].liveUrl, "https://chzzk.naver.com/live/channel-a");
        assert.equal(JSON.stringify(history), before);
        backup.records[0].liveUrl += "?from=history#player";
        rejects(api, backup);
    }
    for (const liveUrl of [
        "javascript:alert(1)",
        "https://user:password@chzzk.naver.com/live/channel-a",
        "https://chzzk.naver.com/live/other-channel",
        "https://evil.test/live/channel-a",
    ]) {
        const { api, history } = backupFixture();
        history.entries["live:100"].liveUrl = liveUrl;
        assert.throws(
            () => api.createBackup(history, { extensionVersion: "1.4.0", now: NOW }),
            (error) => error.code === "INVALID_FILE"
        );
    }
});

test("legacy session startedAt, endedAt and lastWatchedAt are projected to canonical timestamps", () => {
    for (const endField of ["endedAt", "lastWatchedAt"]) {
        const { api, history } = backupFixture();
        const row = history.entries["live:100"].sessionDetails[0];
        row.startedAt = row.enteredAt;
        row[endField] = row.leftAt;
        delete row.enteredAt;
        delete row.leftAt;
        const backup = api.createBackup(history, { extensionVersion: "1.4.0", now: NOW });
        const exported = backup.records[0].watch.sessionDetails[0];
        assert.equal(exported.enteredAt, ENTERED);
        assert.equal(exported.leftAt, NOW);
        assert.deepEqual(plain(exported.watchedRanges), plain(row.watchedRanges));
        assert.equal(Object.hasOwn(exported, "startedAt"), false);
        assert.equal(Object.hasOwn(exported, endField), false);
    }
});

test("session daily totals reject large contradictions while respecting the collector floor and per-day round bound", () => {
    const { api, backup } = backupFixture();
    backup.records[0].watch.dailySeconds[DAY] = 120;
    rejects(api, backup);
    backup.records[0].watch.sessionDetails[0].dailySeconds[DAY] = 120;
    rejects(api, backup);
    for (const parts of [[60.9], [30.5, 30.5], [20.5, 20.5, 20.5], [15.5, 15.5, 15.5, 15.5]]) {
        const { api, store } = load();
        const dailySeconds = Object.fromEntries(
            parts.map((seconds, index) => [`2026-09-${24 + index}`, Math.round(seconds)])
        );
        const watchedSeconds = Math.floor(parts.reduce((sum, seconds) => sum + seconds, 0));
        const history = store.applyMutation(
            {},
            {
                kind: "upsertSessionSnapshot",
                recordId: "live:rounded",
                entry: { channelId: "channel-a", liveId: "rounded" },
                session: {
                    id: "rounding",
                    title: "",
                    enteredAt: Date.parse("2026-09-24T00:00:00+09:00"),
                    leftAt: NOW,
                    watchedSeconds,
                    dailySeconds,
                    watchedRanges: [],
                    closed: true,
                },
            },
            NOW
        ).history;
        const valid = api.createBackup(history, { extensionVersion: "1.4.0", now: NOW });
        const firstDay = Object.keys(dailySeconds)[0];
        valid.records[0].watch.dailySeconds[firstDay] += 1;
        valid.records[0].watch.sessionDetails[0].dailySeconds[firstDay] += 1;
        rejects(api, valid);
    }
});
