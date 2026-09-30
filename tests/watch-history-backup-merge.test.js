const assert = require("node:assert/strict");
const test = require("node:test");
const {
    NOW,
    DAY,
    ENTERED,
    load,
    snapshot,
    chat,
    createFile,
    plain,
} = require("./helpers/watch-history-backup-fixture.js");

test("restore round trips raw watch and chat, and importing the same file twice is unchanged", () => {
    const { store, backup, merger } = load();
    const original = store.applyMutation(
        {},
        snapshot({ activities: [chat(1), chat(2), chat(3, "donation")] }),
        NOW
    ).history;
    const file = createFile(backup, original);
    const restored = merger.mergeBackup(undefined, file, { now: NOW });
    assert.equal(restored.summary.added, 1);
    assert.equal(restored.changed, true);
    assert.deepEqual(plain(createFile(backup, restored.history)), plain(file));
    assert.equal(restored.history.entries["live:100"].activities.filter((row) => row.kind === "donation").length, 0);
    const again = merger.mergeBackup(restored.history, file, { now: NOW + 1 });
    assert.equal(again.changed, false);
    assert.equal(again.summary.unchanged, 1);
});

test("newer absolute snapshots add only their delta and overlapping tabs remain one viewed interval", () => {
    const { store, backup, merger, context } = load();
    const current = store.applyMutation({}, snapshot({ seconds: 60 }), NOW).history;
    const newer = store.applyMutation({}, snapshot({ seconds: 90 }), NOW).history;
    const merged = merger.mergeBackup(current, createFile(backup, newer), { now: NOW });
    assert.equal(merged.history.entries["live:100"].watchedSeconds, 90);
    const other = store.applyMutation({}, snapshot({ sessionId: "other-tab", seconds: 60 }), NOW).history;
    const both = merger.mergeBackup(merged.history, createFile(backup, other), { now: NOW });
    const entry = both.history.entries["live:100"];
    assert.equal(entry.watchedSeconds, 150);
    assert.equal(context.BetterChzzk.utils.getUniqueWatchTotals(entry, entry.sessionDetails).watchedSeconds, 90);
});

test("ambiguous historical totals keep the entire current record and report why; identical historical totals are unchanged", () => {
    const { store, backup, merger } = load();
    const current = store.applyMutation({}, snapshot({ activities: [chat(1, "donation")] }), NOW).history;
    delete current.entries["live:100"].sessionDetails;
    const same = createFile(backup, current);
    assert.equal(merger.mergeBackup(current, same, { now: NOW }).summary.unchanged, 1);
    const incoming = store.applyMutation({}, snapshot({ seconds: 90, activities: [chat(2)] }), NOW).history;
    const merged = merger.mergeBackup(current, createFile(backup, incoming), { now: NOW });
    assert.equal(merged.summary.skipped, 1);
    assert.equal(merged.items[0].reason, "ambiguous-history");
    assert.deepEqual(plain(merged.history), plain(current));
});

test("imports preserve donation bodies, counts, owner and months while merging own chat", () => {
    const { store, backup, merger } = load();
    const current = store.applyMutation({}, snapshot({ activities: [chat(1, "donation")] }), NOW).history;
    current.donationImport = {
        ownerId: "other-owner",
        months: { "2026-09": { entries: [{ text: "keep" }] } },
        status: "complete",
    };
    current.donationImportClearedAt = ENTERED - 1;
    const incoming = store.applyMutation({}, snapshot({ activities: [chat(2), chat(3, "donation")] }), NOW).history;
    const before = plain(current);
    const merged = merger.mergeBackup(current, createFile(backup, incoming), { now: NOW });
    const entry = merged.history.entries["live:100"];
    assert.equal(entry.activityDaily[DAY].chatCount, 1);
    assert.equal(entry.activityDaily[DAY].donationCount, 1);
    assert.equal(entry.activityDaily[DAY].donationCheese, 1000);
    assert.deepEqual(
        plain(entry.activities.filter((row) => row.kind === "donation")),
        before.entries["live:100"].activities
    );
    assert.deepEqual(plain(merged.history.donationImport), before.donationImport);
    assert.equal(merged.history.donationImportClearedAt, before.donationImportClearedAt);
    assert.deepEqual(plain(current), before);
});

test("confirmed restore preserves deletion barriers and survives late snapshots and migrations until a new explicit deletion", () => {
    const { store, backup, merger } = load();
    const sourceId = "channel:channel-a:provisional:s";
    const original = store.applyMutation({}, snapshot({ activities: [chat(1)] }), NOW).history;
    original.recordAliases[sourceId] = { targetRecordId: "live:100", migratedAt: NOW };
    const file = createFile(backup, original);
    const cleared = store.applyMutation(original, { kind: "clearHistory", cutoffAt: NOW }, NOW).history;
    cleared.tombstones[sourceId] = NOW;
    const restored = merger.mergeBackup(cleared, file, { now: NOW + 1000 });
    assert.equal(restored.summary.restored, 1);
    assert.equal(restored.history.clearedAt, NOW);
    assert.equal(restored.history.tombstones[sourceId], NOW);
    const late = store.applyMutation(restored.history, snapshot({ seconds: 120, activities: [chat(2)] }), NOW + 2000);
    assert.equal(late.result.reason, "deleted");
    const migrated = store.applyMutation(
        late.history,
        { kind: "migrateRecordId", sourceRecordId: sourceId, targetRecordId: "live:100" },
        NOW + 3000
    );
    assert.equal(migrated.history.entries["live:100"].watchedSeconds, 60);
    const deleted = store.applyMutation(
        migrated.history,
        { kind: "deleteEntries", entryIds: ["live:100"], cutoffAt: NOW + 4000 },
        NOW + 4000
    );
    assert.equal(deleted.history.entries["live:100"], undefined);
});

test("a restored chat cutoff does not suppress a late donation and a later ordinary snapshot cannot recount the restored chat", () => {
    const { store, backup, merger } = load();
    const current = store.applyMutation({}, snapshot(), NOW).history;
    const incoming = store.applyMutation({}, snapshot({ activities: [chat(2)] }), NOW).history;
    incoming.entries["live:100"].activityCutoffAt = ENTERED + 5000;
    const merged = merger.mergeBackup(current, createFile(backup, incoming), { now: NOW });
    const late = store.applyMutation(
        merged.history,
        snapshot({ activities: [chat(2), chat(4), chat(1, "donation")] }),
        NOW
    );
    assert.equal(late.history.entries["live:100"].activityDaily[DAY].chatCount, 1);
    assert.equal(late.history.entries["live:100"].activityDaily[DAY].donationCount, 1);
});

test("conflicting author message identity or aliases skip a broadcast without affecting its current record", () => {
    const { store, backup, merger } = load();
    const current = store.applyMutation({}, snapshot({ activities: [chat(1)] }), NOW).history;
    const file = createFile(backup, current);
    file.records[0].chat.messages[0].text = "다른 본문";
    const conflict = merger.mergeBackup(current, file, { now: NOW });
    assert.equal(conflict.items[0].reason, "identity-conflict");
    assert.equal(conflict.changed, false);
    const aliasFile = createFile(backup, current);
    aliasFile.recordAliases = [
        { sourceRecordId: "channel:channel-a:provisional:s", targetRecordId: "live:100", migratedAt: NOW },
    ];
    current.recordAliases[aliasFile.recordAliases[0].sourceRecordId] = {
        targetRecordId: "live:other",
        migratedAt: NOW,
    };
    assert.equal(merger.mergeBackup(current, aliasFile, { now: NOW }).items[0].reason, "identity-conflict");
});

test("retention overflow rejects the complete import without mutating the original history", () => {
    const { store, backup, merger } = load();
    const original = store.applyMutation({}, snapshot(), NOW).history;
    const file = createFile(backup, original);
    const current = {
        entries: Object.fromEntries(
            Array.from({ length: 2000 }, (_, n) => [`live:existing-${n}`, { id: `live:existing-${n}` }])
        ),
    };
    const before = JSON.stringify(current);
    assert.throws(
        () => merger.mergeBackup(current, file, { now: NOW }),
        (error) => error.code === "LIMIT_EXCEEDED"
    );
    assert.equal(JSON.stringify(current), before);
});

test("incompatible ranges for the same absolute session snapshot skip the entire broadcast", () => {
    const { store, backup, merger } = load();
    const current = store.applyMutation({}, snapshot(), NOW).history;
    const incoming = store.applyMutation({}, snapshot(), NOW).history;
    const entry = incoming.entries["live:100"];
    entry.lastWatchedAt = ENTERED + 120000;
    entry.sessionDetails[0].leftAt = ENTERED + 120000;
    entry.sessionDetails[0].watchedRanges = [{ startAt: ENTERED + 60000, endAt: ENTERED + 120000 }];
    const result = merger.mergeBackup(current, createFile(backup, incoming), { now: NOW });
    assert.equal(result.items[0].reason, "identity-conflict");
    assert.deepEqual(plain(result.history), plain(current));
});

test("only file-scoped restored sessions and chats survive old alias deletion; unrelated watch and donations do not", () => {
    const { store, backup, merger } = load();
    const sourceId = "channel:channel-a:provisional:deleted";
    let current = store.applyMutation(
        {},
        snapshot({ sessionId: "old-not-in-file", activities: [chat(1, "donation")] }),
        NOW
    ).history;
    current = store.applyMutation(
        current,
        snapshot({ sessionId: "new", enteredAt: NOW - 20000, seconds: 10 }),
        NOW
    ).history;
    current.tombstones[sourceId] = NOW - 30000;
    const incoming = store.applyMutation(
        {},
        snapshot({ sessionId: "restored", seconds: 30, activities: [chat(2)] }),
        NOW
    ).history;
    incoming.recordAliases[sourceId] = { targetRecordId: "live:100", migratedAt: NOW };
    const restored = merger.mergeBackup(current, createFile(backup, incoming), { now: NOW });
    assert.equal(restored.summary.restored, 1);
    const migrated = store.applyMutation(
        restored.history,
        { kind: "migrateRecordId", sourceRecordId: sourceId, targetRecordId: "live:100" },
        NOW
    );
    const entry = migrated.history.entries["live:100"];
    assert.equal(entry.watchedSeconds, 40);
    assert.deepEqual(plain(entry.sessionDetails.map((row) => row.id).sort()), ["new", "restored"]);
    assert.equal(
        entry.activities.some((row) => row.kind === "donation"),
        false
    );
    assert.equal(
        entry.activities.some((row) => row.id === chat(2).id),
        true
    );
});

test("a later same-day session is not reported as restored because its KST date began before deletion", () => {
    const { store, backup, merger } = load();
    const current = { clearedAt: ENTERED - 60000, entries: {} };
    const incoming = store.applyMutation({}, snapshot(), NOW).history;
    const result = merger.mergeBackup(current, createFile(backup, incoming), { now: NOW });
    assert.equal(result.summary.restored, 0);
    assert.equal(result.items[0].restoresDeleted, false);
    assert.equal(Object.hasOwn(result.history.entries["live:100"], "backupRestore"), false);
});

test("late alias deletion preserves restored display metadata and the target's stronger retirement barrier", () => {
    const { store, backup, merger } = load();
    const sourceId = "channel:channel-a:provisional:metadata";
    const incoming = store.applyMutation({}, snapshot({ activities: [chat(1)] }), NOW).history;
    Object.assign(incoming.entries["live:100"], {
        replayVideoNo: "777",
        thumbnailUrl: "https://pstatic.net/image.jpg",
        titleHistory: [{ title: "보존할 제목", firstSeenAt: ENTERED, lastSeenAt: NOW }],
    });
    incoming.recordAliases[sourceId] = { targetRecordId: "live:100", migratedAt: NOW };
    const current = { clearedAt: NOW, tombstones: { [sourceId]: NOW }, entries: {} };
    const restored = merger.mergeBackup(current, createFile(backup, incoming), { now: NOW + 1000 });
    const before = restored.history.entries["live:100"];
    before.retiredSessionStartedAtBarrier = NOW + 500;
    before.activityCutoffAt = NOW + 500;
    const result = store.applyMutation(
        restored.history,
        { kind: "migrateRecordId", sourceRecordId: sourceId, targetRecordId: "live:100" },
        NOW + 2000
    );
    const after = result.history.entries["live:100"];
    assert.equal(after.replayVideoNo, "777");
    assert.equal(after.thumbnailUrl, before.thumbnailUrl);
    assert.deepEqual(plain(after.titleHistory), plain(before.titleHistory));
    assert.equal(after.retiredSessionStartedAtBarrier, NOW + 500);
    assert.equal(after.activityCutoffAt, NOW + 500);
    assert.equal(
        after.activities.some((row) => row.kind === "donation"),
        false
    );
});

function restoreSeparateProvisionalAndLive({ differentRestoreTimes = false } = {}) {
    const helpers = load();
    const { store, backup, merger } = helpers;
    const sourceId = "channel:channel-a:provisional:scope-a";
    let original = store.applyMutation({}, snapshot({ id: sourceId, sessionId: "scope-a", seconds: 60 }), NOW).history;
    original = store.applyMutation(
        original,
        snapshot({ sessionId: "scope-b", seconds: 20, activities: [chat(2), chat(3, "donation")] }),
        NOW
    ).history;
    const file = createFile(backup, original);
    const deleted = store.applyMutation(
        original,
        { kind: "deleteEntries", entryIds: [sourceId, "live:100"], cutoffAt: NOW },
        NOW
    ).history;
    let history;
    if (differentRestoreTimes) {
        const a = { ...file, records: file.records.filter((row) => row.id === sourceId) };
        const b = { ...file, records: file.records.filter((row) => row.id === "live:100") };
        history = merger.mergeBackup(deleted, a, { now: NOW + 1000 }).history;
        history = merger.mergeBackup(history, b, { now: NOW + 3000 }).history;
    } else history = merger.mergeBackup(deleted, file, { now: NOW + 1000 }).history;
    return { ...helpers, sourceId, history, file };
}

test("two restored rows retain both scopes after repeated ordinary ID migration", () => {
    const { store, sourceId, history } = restoreSeparateProvisionalAndLive();
    const operation = { kind: "migrateRecordId", sourceRecordId: sourceId, targetRecordId: "live:100" };
    const first = store.applyMutation(history, operation, NOW + 4000);
    const again = store.applyMutation(first.history, operation, NOW + 5000);
    assert.equal(first.history.entries["live:100"].watchedSeconds, 80);
    assert.equal(again.history.entries["live:100"].watchedSeconds, 80);
    assert.deepEqual(plain(again.history.entries["live:100"].sessionDetails.map((row) => row.id).sort()), [
        "scope-a",
        "scope-b",
    ]);
    assert.equal(again.history.entries["live:100"].activityDaily[DAY].chatCount, 1);
    assert.equal(
        again.history.entries["live:100"].activities.some((row) => row.kind === "donation"),
        false
    );
});

test("backup alias consolidation keeps protection from every current row, not only the canonical row", () => {
    const { store, merger, sourceId, history, file } = restoreSeparateProvisionalAndLive();
    const next = {
        ...file,
        records: file.records.filter((row) => row.id === "live:100"),
        recordAliases: [{ sourceRecordId: sourceId, targetRecordId: "live:100", migratedAt: NOW + 2000 }],
    };
    const combined = merger.mergeBackup(history, next, { now: NOW + 3000 });
    const migrated = store.applyMutation(
        combined.history,
        { kind: "migrateRecordId", sourceRecordId: sourceId, targetRecordId: "live:100" },
        NOW + 4000
    );
    assert.equal(combined.history.entries["live:100"].watchedSeconds, 80);
    assert.equal(migrated.history.entries["live:100"].watchedSeconds, 80);
    assert.equal(merger.mergeBackup(migrated.history, next, { now: NOW + 5000 }).summary.unchanged, 1);
});

test("scope union preserves each actual restore time across an intervening deletion barrier", () => {
    for (const viaBackup of [false, true]) {
        const { store, merger, sourceId, history, file } = restoreSeparateProvisionalAndLive({
            differentRestoreTimes: true,
        });
        const operation = { kind: "migrateRecordId", sourceRecordId: sourceId, targetRecordId: "live:100" };
        const combined = viaBackup
            ? merger.mergeBackup(
                  history,
                  {
                      ...file,
                      records: file.records.filter((row) => row.id === "live:100"),
                      recordAliases: [{ sourceRecordId: sourceId, targetRecordId: "live:100", migratedAt: NOW + 4000 }],
                  },
                  { now: NOW + 4000 }
              ).history
            : store.applyMutation(history, operation, NOW + 4000).history;
        combined.tombstones[sourceId] = NOW + 2000;
        const filtered = store.applyMutation(combined, operation, NOW + 5000).history;
        assert.equal(filtered.entries["live:100"].watchedSeconds, 20);
        assert.deepEqual(plain(filtered.entries["live:100"].sessionDetails.map((row) => row.id)), ["scope-b"]);
        const deleted = store.applyMutation(
            filtered,
            { kind: "deleteEntries", entryIds: ["live:100"], cutoffAt: NOW + 6000 },
            NOW + 6000
        );
        assert.equal(deleted.history.entries["live:100"], undefined);
    }
});

test("alias consolidation skips numerically equal legacy residuals from different current records", () => {
    const { store, backup, merger } = load();
    const sourceId = "channel:channel-a:provisional:legacy-a";
    let original = store.applyMutation({}, snapshot({ id: sourceId, sessionId: "legacy-a", seconds: 60 }), NOW).history;
    original = store.applyMutation(
        original,
        snapshot({ sessionId: "legacy-b", seconds: 60, activities: [chat(1)] }),
        NOW
    ).history;
    for (const entry of Object.values(original.entries)) delete entry.sessionDetails;
    const file = createFile(backup, original);
    const cleared = store.applyMutation(
        original,
        { kind: "deleteEntries", entryIds: [sourceId, "live:100"], cutoffAt: NOW },
        NOW
    ).history;
    const restored = merger.mergeBackup(cleared, file, { now: NOW + 1000 }).history;
    const next = plain(file);
    next.records = next.records.filter((row) => row.id === "live:100");
    next.records[0].chat.messages = [{ id: chat(2).id, at: chat(2).at, text: chat(2).text, sessionStartedAt: ENTERED }];
    next.recordAliases = [{ sourceRecordId: sourceId, targetRecordId: "live:100", migratedAt: NOW + 2000 }];
    const outcome = merger.mergeBackup(restored, next, { now: NOW + 3000 });
    assert.equal(outcome.changed, false);
    assert.equal(outcome.items[0].reason, "ambiguous-history");
    assert.equal(outcome.summary.skipped, 1);
    assert.deepEqual(plain(outcome.history), plain(restored));
    const migration = { kind: "migrateRecordId", sourceRecordId: sourceId, targetRecordId: "live:100" };
    const first = store.applyMutation(outcome.history, migration, NOW + 4000).history;
    const again = store.applyMutation(first, migration, NOW + 5000).history;
    assert.equal(first.entries["live:100"].watchedSeconds, 120);
    assert.equal(again.entries["live:100"].watchedSeconds, 120);
    assert.equal(again.entries["live:100"].activityDaily[DAY].chatCount, 1);
});

test("an already canonical legacy snapshot updates watch protection independently from a partial chat file", () => {
    const { store, backup, merger } = load();
    const sourceId = "channel:channel-a:provisional:legacy-old";
    let original = store.applyMutation({}, snapshot({ id: sourceId, sessionId: "legacy-a", seconds: 60 }), NOW).history;
    original = store.applyMutation(
        original,
        snapshot({ sessionId: "legacy-b", seconds: 60, activities: [chat(1)] }),
        NOW
    ).history;
    for (const entry of Object.values(original.entries)) delete entry.sessionDetails;
    const file = createFile(backup, original);
    const cleared = store.applyMutation(
        original,
        { kind: "deleteEntries", entryIds: [sourceId, "live:100"], cutoffAt: NOW },
        NOW
    ).history;
    const restored = merger.mergeBackup(cleared, file, { now: NOW + 1000 }).history;
    const operation = { kind: "migrateRecordId", sourceRecordId: sourceId, targetRecordId: "live:100" };
    const canonical = store.applyMutation(restored, operation, NOW + 2000).history;
    const next = createFile(backup, canonical);
    next.records[0].chat.messages = [{ id: chat(2).id, at: chat(2).at, text: chat(2).text, sessionStartedAt: ENTERED }];
    const imported = merger.mergeBackup(canonical, next, { now: NOW + 3000 });
    assert.equal(imported.summary.updated, 1);
    assert.equal(imported.history.entries["live:100"].watchedSeconds, 120);
    const late = store.applyMutation(imported.history, operation, NOW + 4000).history;
    assert.equal(late.entries["live:100"].watchedSeconds, 120);
    assert.equal(late.entries["live:100"].activityDaily[DAY].chatCount, 2);
    late.tombstones[sourceId] = NOW + 2500;
    const between = store.applyMutation(late, operation, NOW + 5000).history;
    assert.equal(between.entries["live:100"].watchedSeconds, 120);
    assert.equal(between.entries["live:100"].activityDaily[DAY].chatCount, 1);
    assert.equal(between.entries["live:100"].activities[0].id, chat(2).id);
});

test("a complete chat file refreshes chat protection without promoting watch sessions omitted from the file", () => {
    const { store, backup, merger, sourceId, history, file } = restoreSeparateProvisionalAndLive({
        differentRestoreTimes: true,
    });
    const operation = { kind: "migrateRecordId", sourceRecordId: sourceId, targetRecordId: "live:100" };
    const canonical = store.applyMutation(history, operation, NOW + 4000).history;
    const next = createFile(backup, canonical);
    next.records[0].watch = plain(file.records.find((row) => row.id === sourceId).watch);
    next.records[0].chat.messages.push({
        id: chat(3).id,
        at: chat(3).at,
        text: chat(3).text,
        sessionStartedAt: ENTERED,
    });
    next.records[0].chat.dailyCounts[DAY] = 2;
    const imported = merger.mergeBackup(canonical, next, { now: NOW + 5000 });
    assert.equal(imported.summary.updated, 1);
    assert.equal(imported.history.entries["live:100"].watchedSeconds, 80);
    imported.history.tombstones[sourceId] = NOW + 4500;
    const after = store.applyMutation(imported.history, operation, NOW + 6000).history.entries["live:100"];
    assert.equal(after.watchedSeconds, 60);
    assert.deepEqual(plain(after.sessionDetails.map((row) => row.id)), ["scope-a"]);
    assert.equal(after.activityDaily[DAY].chatCount, 2);
    assert.deepEqual(plain(after.activities.map((row) => row.id).sort()), [chat(2).id, chat(3).id].sort());
});
