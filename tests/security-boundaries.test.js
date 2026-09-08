const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const repo = path.join(__dirname, "..");
const NOW = Date.parse("2026-07-10T12:00:00+09:00");

function load() {
    const context = vm.createContext({ URL, AbortController, setTimeout, clearTimeout });
    for (const file of ["shared/data.js", "shared/watchHistoryStore.js"]) {
        vm.runInContext(fs.readFileSync(path.join(repo, file), "utf8"), context);
    }
    vm.runInContext(`Date.now = () => ${NOW}`, context);
    return { context, utils: context.BetterChzzk.utils, store: context.BetterChzzkWatchHistoryStore };
}

function session(endAt = 1e15) {
    return {
        id: "session-a",
        enteredAt: NOW - 60000,
        leftAt: NOW,
        watchedSeconds: 60,
        watchedRanges: [{ startAt: NOW - 120000, endAt }],
        closed: true,
    };
}

test("session snapshots clip inconsistent ranges at both session boundaries", () => {
    const { store, utils } = load();
    const operation = { kind: "upsertSessionSnapshot", recordId: "live:100", entry: {}, session: session() };
    const normalized = store.normalizeMutation(operation, NOW);
    assert.equal(normalized.session.watchedRanges.length, 1);
    assert.equal(normalized.session.watchedRanges[0].startAt, NOW - 60000);
    assert.equal(normalized.session.watchedRanges[0].endAt, NOW);
    const totals = utils.getUniqueWatchTotals({}, [normalized.session]);
    assert.equal(totals.watchedSeconds, 60);
    assert.equal(Object.keys(totals.dailySeconds).length, 1);
});

test("stored snapshots are sanitized before reused or displayed", () => {
    const { store, utils } = load();
    const stored = store.normalizeStoredHistory({ entries: [{ id: "live:100", sessionDetails: [session()] }] });
    assert.equal(stored.entries["live:100"].sessionDetails[0].watchedRanges[0].endAt, NOW);
    const totals = utils.getUniqueWatchTotals({}, [session()]);
    assert.equal(totals.watchedSeconds, 60);
    assert.equal(Object.keys(totals.dailySeconds).length, 1);
});

test("range splitting rejects non-finite and excessive spans without producing partial date maps", () => {
    const { context } = load();
    vm.runInContext(
        `
        globalThis.maps = [];
        for (const endAt of [Infinity, NaN, 1e15, 8.64e15 + 1]) {
            const byDate = {};
            BetterChzzk.utils.addWatchRangeToRangesByDate(byDate, { startAt: ${NOW}, endAt });
            maps.push(byDate);
        }
    `,
        context,
        { timeout: 1000 }
    );
    assert.ok(context.maps.every((map) => Object.keys(map).length === 0));
    assert.equal(context.BetterChzzk.utils.mergeWatchRanges([{ startAt: NOW, endAt: Infinity }]).length, 0);
});

test("valid midnight ranges preserve KST day allocation and scope intersections", () => {
    const { utils } = load();
    const startAt = Date.parse("2026-07-09T23:59:30+09:00");
    const endAt = startAt + 60000;
    const ranges = utils.normalizeSessionWatchRanges({
        enteredAt: startAt,
        leftAt: endAt,
        watchedRanges: [{ startAt, endAt }],
    });
    const byDate = {};
    utils.addWatchRangeToRangesByDate(byDate, ranges[0]);
    const totals = utils.sumWatchRangesByDate(byDate);
    assert.equal(totals["2026-07-09"], 30);
    assert.equal(totals["2026-07-10"], 30);
    const scoped = {};
    utils.addWatchRangeToRangesByDate(
        scoped,
        { startAt: 1, endAt: 1e15 },
        { scopeStartMs: startAt, scopeEndMs: endAt }
    );
    assert.equal(Object.keys(scoped).length, 2);
});

test("title history caps individual strings and input work on write and read paths", () => {
    const { store, utils } = load();
    const longTitle = "x".repeat(100000);
    const history = [{ title: longTitle, firstSeenAt: NOW, lastSeenAt: NOW }];
    const operation = store.normalizeMutation(
        {
            kind: "upsertSessionSnapshot",
            recordId: "live:100",
            entry: { title: longTitle, titleHistory: history },
            session: session(NOW),
        },
        NOW
    );
    assert.equal(operation.entry.title.length, 500);
    assert.equal(operation.entry.titleHistory[0].title.length, 500);
    const stored = store.normalizeStoredHistory({ entries: [{ id: "live:100", titleHistory: history }] });
    assert.equal(stored.entries["live:100"].titleHistory[0].title.length, 500);
    const target = {};
    utils.addTitleHistory(target, longTitle);
    assert.equal(target.titleHistory[0].title.length, 500);
    const bounded = Array.from({ length: 201 }, (_, index) => ({ title: `title ${index}` }));
    Object.defineProperty(bounded, 0, {
        get() {
            throw new Error("out-of-budget input was visited");
        },
    });
    assert.equal(utils.normalizeTitleHistory(bounded).length, 20);
});

test("history page sanitizes old ranges without relying on a background write", async () => {
    const dom = new JSDOM(fs.readFileSync(path.join(repo, "history.html"), "utf8"), {
        url: "https://extension.test/history.html",
        runScripts: "outside-only",
    });
    try {
        const w = dom.window;
        w.Date.now = () => NOW;
        w.eval(fs.readFileSync(path.join(repo, "shared/data.js"), "utf8"));
        w.eval(fs.readFileSync(path.join(repo, "history.js"), "utf8"));
        const normalized = w.normalizeHistory({
            entries: [
                {
                    id: "live:100",
                    channelId: "channel-a",
                    firstWatchedAt: NOW - 60000,
                    lastWatchedAt: NOW,
                    watchedSeconds: 60,
                    sessionDetails: [session()],
                },
            ],
        });
        assert.equal(normalized.length, 1);
        assert.equal(normalized[0].sessionDetails[0].watchedRanges[0].endAt, NOW);
        assert.equal(Object.keys(normalized[0].dailySeconds).length, 1);
        await Promise.resolve();
    } finally {
        dom.window.close();
    }
});
