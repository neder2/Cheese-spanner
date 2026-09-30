const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "../..");
const NOW = Date.parse("2026-09-28T03:00:00Z");
const DAY = "2026-09-28";
const ENTERED = NOW - 120000;

function load(extra = {}) {
    const context = vm.createContext({ URL, console, ...extra });
    for (const file of [
        "data.js",
        "donationHistory.js",
        "watchHistoryStore.js",
        "watchHistoryBackup.js",
        "watchHistoryBackupMerge.js",
    ]) {
        vm.runInContext(fs.readFileSync(path.join(root, "shared", file), "utf8"), context, { filename: file });
    }
    return {
        context,
        store: context.BetterChzzkWatchHistoryStore,
        backup: context.BetterChzzkWatchHistoryBackup,
        merger: context.BetterChzzkWatchHistoryBackupMerge,
    };
}

function snapshot({
    id = "live:100",
    sessionId = "session-a",
    enteredAt = ENTERED,
    seconds = 60,
    activities = [],
} = {}) {
    return {
        kind: "upsertSessionSnapshot",
        recordId: id,
        entry: {
            channelId: "channel-a",
            liveId: id.startsWith("live:") ? id.slice(5) : "",
            title: "방송",
            channelName: "채널",
            firstWatchedAt: enteredAt,
            lastWatchedAt: enteredAt + seconds * 1000,
        },
        session: {
            id: sessionId,
            title: "방송",
            enteredAt,
            leftAt: enteredAt + seconds * 1000,
            watchedSeconds: seconds,
            dailySeconds: { [DAY]: seconds },
            watchedRanges: [{ startAt: enteredAt, endAt: enteredAt + seconds * 1000 }],
            closed: true,
        },
        activities,
    };
}

function chat(n, kind = "chat") {
    const at = ENTERED + 1000 + n;
    return {
        id: `author:${at}:${kind === "chat" ? 1 : 10}`,
        at,
        kind,
        text: "같은 내용",
        amount: kind === "chat" ? 0 : 1000,
    };
}

function createFile(backup, history) {
    return backup.createBackup(history, { extensionVersion: "1.4.0", now: NOW, createdAt: NOW });
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

module.exports = { root, NOW, DAY, ENTERED, load, snapshot, chat, createFile, plain };
