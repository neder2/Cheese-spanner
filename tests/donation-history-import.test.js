const assert = require("node:assert/strict");
const test = require("node:test");
const {
    createFakeChrome,
    createDom,
    evalRepoScript,
    dispatch,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");
require("../shared/donationHistory.js");
require("../shared/donationHistoryImport.js");

const data = globalThis.BetterChzzkDonationHistory;
const store = globalThis.BetterChzzkWatchHistoryStore;
const NOW = Date.parse("2026-09-19T12:00:00+09:00");
const MONTH = "2026-09";
const apiRow = (index = 0, changes = {}) => ({
    purchaseDate: `2026-09-18T12:00:${String(index).padStart(2, "0")}+09:00`,
    channelId: "channel-a",
    channelName: "검증 채널",
    donationType: "CHAT",
    payAmount: 1000,
    donationText: "후원 메시지",
    ...changes,
});
const response = (rows, totalPages = 1) => ({ code: 200, content: { data: rows, totalPages } });
const snapshot = (changes = {}) => ({
    owner: "viewer",
    startedAt: NOW - 1000,
    startMonth: MONTH,
    endMonth: MONTH,
    months: {
        [MONTH]: [
            {
                at: Date.parse(apiRow().purchaseDate),
                channelId: "channel-a",
                channelName: "검증 채널",
                amount: 1000,
                text: "",
            },
        ],
    },
    ...changes,
});
const collect = (changes = {}) =>
    data.collect({
        startMonth: MONTH,
        endMonth: MONTH,
        now: () => NOW,
        identify: async () => "viewer",
        requestPage: async () => response([apiRow()]),
        ...changes,
    });

test("donation import reads complete monthly pages, retains empty text, and preserves genuine identical purchases", async () => {
    const calls = [],
        progress = [];
    const first = Array.from({ length: 10 }, (_, index) => apiRow(index, { donationText: null }));
    const result = await collect({
        requestPage: async (month, page, size) => {
            calls.push({ month, page, size });
            return response(page ? [first[0]] : first, 2);
        },
        onProgress: (event) => progress.push(event),
    });
    assert.deepEqual(
        calls.map((row) => row.page),
        [0, 1, 0]
    );
    assert.ok(calls.every((row) => row.month === MONTH && row.size === 10));
    assert.equal(result.months[MONTH].length, 11);
    assert.ok(result.months[MONTH].every((row) => row.text === ""));
    assert.deepEqual(
        progress.map((row) => row.count),
        [10, 11]
    );
    const mixed = await collect({
        requestPage: async () =>
            response([apiRow(), apiRow(1, { donationType: "VIDEO" }), apiRow(2, { donationType: "TTS" })]),
    });
    assert.equal(mixed.months[MONTH].length, 1);
});

test("donation import rejects incomplete pages, changing accounts, changed pagination, and invalid records", async () => {
    await assert.rejects(collect({ requestPage: async () => ({ code: 401 }) }), /로그인/);
    await assert.rejects(collect({ requestPage: async () => response([apiRow()], 2) }), /바뀌었어요/);
    await assert.rejects(
        collect({ requestPage: async () => response([apiRow(0, { purchaseDate: "not-a-date" })]) }),
        /시각/
    );
    await assert.rejects(collect({ requestPage: async () => response([apiRow(0, { payAmount: "1000" })]) }), /수량/);
    await assert.rejects(collect({ requestPage: async () => response([apiRow(0, { donationText: {} })]) }), /수량/);
    let identities = 0;
    await assert.rejects(
        collect({ identify: async () => (++identities === 1 ? "viewer" : "other") }),
        /계정이 바뀌었어요/
    );
    let requests = 0;
    await assert.rejects(
        collect({
            requestPage: async (_month, page) => {
                requests++;
                return response(
                    page
                        ? [apiRow(11)]
                        : Array.from({ length: 10 }, (_, i) => apiRow(i, { payAmount: requests === 3 ? 2000 : 1000 })),
                    2
                );
            },
        }),
        /바뀌었어요/
    );
    const controller = new AbortController();
    requests = 0;
    await assert.rejects(
        collect({
            signal: controller.signal,
            onProgress: () => controller.abort(),
            requestPage: async () => {
                requests++;
                return response(
                    Array.from({ length: 10 }, (_, i) => apiRow(i)),
                    2
                );
            },
        }),
        /취소/
    );
    assert.equal(requests, 1);
});

test("import ranges and response sizes are bounded and an empty month remains a complete snapshot", async () => {
    assert.deepEqual(data.getMonths("2025-12", "2026-02", NOW), ["2025-12", "2026-01", "2026-02"]);
    assert.throws(() => data.getMonths("2025-01", MONTH, NOW), /12개월/);
    assert.throws(() => data.getMonths("2026-10", "2026-11", NOW), /기간/);
    assert.throws(() => data.getMonths("2026-13", MONTH, NOW), /연월/);
    await assert.rejects(collect({ requestPage: async () => response([], 301) }), /응답/);
    await assert.rejects(
        collect({ requestPage: async () => response(Array.from({ length: 11 }, () => apiRow())) }),
        /응답/
    );
    const result = await collect({ requestPage: async () => response([], 0) });
    assert.deepEqual(result.months[MONTH], []);
});

test("reimport replaces months without changing live activity or watch time and deletion blocks late imports", () => {
    const base = {
        entries: {
            "live:100": {
                id: "live:100",
                channelId: "channel-a",
                watchedSeconds: 600,
                sessions: 1,
                firstWatchedAt: NOW - 600000,
                lastWatchedAt: NOW,
                dailySeconds: { "2026-09-19": 600 },
                activityDaily: { "2026-09-19": { chatCount: 1, donationCount: 1, donationCheese: 1000 } },
            },
        },
    };
    let outcome = store.applyMutation(base, { kind: "replaceDonationMonths", snapshot: snapshot() }, NOW);
    outcome = store.applyMutation(
        outcome.history,
        { kind: "replaceDonationMonths", snapshot: snapshot({ startedAt: NOW + 1 }) },
        NOW + 2
    );
    assert.equal(outcome.history.donationImport.months[MONTH].length, 1);
    assert.equal(outcome.history.entries["live:100"].watchedSeconds, 600);
    assert.equal(outcome.history.entries["live:100"].activityDaily["2026-09-19"].donationCount, 1);
    assert.throws(
        () =>
            store.applyMutation(
                outcome.history,
                { kind: "replaceDonationMonths", snapshot: snapshot({ owner: "other", startedAt: NOW + 3 }) },
                NOW + 4
            ),
        /다른 계정/
    );
    const cleared = store.applyMutation(
        outcome.history,
        { kind: "clearDonationImport", cutoffAt: NOW + 4 },
        NOW + 4
    ).history;
    assert.equal(cleared.donationImport, undefined);
    assert.ok(cleared.entries["live:100"]);
    assert.equal(
        store.applyMutation(
            cleared,
            { kind: "replaceDonationMonths", snapshot: snapshot({ startedAt: NOW + 3 }) },
            NOW + 5
        ).result.reason,
        "deleted"
    );
    const imported = store.applyMutation(
        cleared,
        { kind: "replaceDonationMonths", snapshot: snapshot({ owner: "other", startedAt: NOW + 5 }) },
        NOW + 6
    ).history;
    const allCleared = store.applyMutation(imported, { kind: "clearHistory", cutoffAt: NOW + 7 }, NOW + 7).history;
    assert.equal(allCleared.donationImport, undefined);
    assert.equal(
        store.applyMutation(
            allCleared,
            { kind: "replaceDonationMonths", snapshot: snapshot({ startedAt: NOW + 6 }) },
            NOW + 8
        ).result.reason,
        "deleted"
    );
});

function events() {
    const listeners = [];
    return {
        addListener: (listener) => listeners.push(listener),
        emit: (...args) => listeners.forEach((listener) => listener(...args)),
    };
}

function importController(t, { requestPage, owner = "viewer" } = {}) {
    const onConnect = events();
    let stored = {},
        writes = 0,
        requests = 0;
    const original = globalThis.BetterChzzk.utils.fetchJson;
    globalThis.BetterChzzk.utils.fetchJson = async (_url, options) => {
        requests++;
        return requestPage ? requestPage(options) : response([apiRow()]);
    };
    t.after(() => {
        globalThis.BetterChzzk.utils.fetchJson = original;
    });
    const chrome = {
        runtime: { id: "test", getURL: () => "chrome-extension://test/history.html", onConnect },
        tabs: { query: async () => [{ id: 1, active: true }] },
        scripting: { executeScript: async () => [{ result: owner }] },
    };
    globalThis.BetterChzzkDonationHistoryImport.install({
        chrome,
        readHistory: async () => stored,
        writeHistory: async (operation) => {
            writes++;
            stored = store.applyMutation(stored, operation).history;
            return { status: "applied" };
        },
    });
    function connect(url = "chrome-extension://test/history.html") {
        const messages = [];
        const port = {
            name: data.PORT_NAME,
            sender: { id: "test", url },
            onMessage: events(),
            onDisconnect: events(),
            postMessage: (message) => messages.push(message),
            disconnect() {
                this.disconnected = true;
                this.onDisconnect.emit();
            },
        };
        onConnect.emit(port);
        return {
            port,
            messages,
            start: () => port.onMessage.emit({ type: "start", startMonth: MONTH, endMonth: MONTH }),
        };
    }
    return { connect, stats: () => ({ writes, requests, stored }) };
}

test("background import commits only after success and rejects untrusted ports and duplicate jobs", async (t) => {
    let resolve;
    const h = importController(t, {
        requestPage: () =>
            new Promise((r) => {
                resolve = r;
            }),
    });
    const bad = h.connect("https://chzzk.naver.com/live/a");
    assert.equal(bad.port.disconnected, true);
    const first = h.connect();
    first.start();
    await waitForCondition(() => h.stats().requests === 1);
    first.start();
    const second = h.connect();
    second.start();
    assert.match(second.messages[0].message, /다른 시청 기록/);
    assert.equal(h.stats().writes, 0);
    resolve(response([apiRow()]));
    await waitForCondition(() => first.messages.some((m) => m.type === "done"));
    assert.equal(h.stats().writes, 1);
    assert.equal(h.stats().stored.donationImport.months[MONTH].length, 1);
});

test("disconnect aborts an import and a failed fetch never changes stored history", async (t) => {
    const h = importController(t, {
        requestPage: ({ signal }) =>
            new Promise((_resolve, reject) =>
                signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
            ),
    });
    const first = h.connect();
    first.start();
    await waitForCondition(() => h.stats().requests === 1);
    first.port.disconnect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.stats().writes, 0);
    const next = h.connect();
    next.start();
    await waitForCondition(() => h.stats().requests === 2);
    next.port.onMessage.emit({ type: "cancel" });
    await waitForCondition(() => next.messages.some((m) => m.type === "error"));
    assert.match(next.messages.at(-1).message, /취소/);
    assert.equal(h.stats().writes, 0);
});

test("history import UI starts only on submit, displays saved totals separately, and can delete imports", async (t) => {
    const chrome = createFakeChrome();
    const incoming = events(),
        disconnect = events(),
        sent = [];
    chrome.runtime.connect = () => ({
        onMessage: incoming,
        onDisconnect: disconnect,
        postMessage: (message) => sent.push(message),
        disconnect: () => disconnect.emit(),
    });
    const dom = createDom("history.html", "history.html", chrome);
    t.after(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        dom.window.close();
    });
    dom.window.Date.now = () => NOW;
    for (const file of ["shared/data.js", "shared/donationHistory.js", "history.js"]) evalRepoScript(dom, file);
    const document = dom.window.document;
    await waitForCondition(() => document.getElementById("notice").dataset.state === "saved");
    document.getElementById("activityViewTab").click();
    document.getElementById("donationImportToggle").click();
    assert.equal(document.getElementById("donationImportForm").hidden, false);
    assert.equal(sent.length, 0);
    assert.equal(document.activeElement.id, "donationImportStart");
    dispatch(dom, document.getElementById("donationImportForm"), "submit");
    dispatch(dom, document.getElementById("donationImportForm"), "submit");
    assert.equal(sent.length, 1);
    assert.equal(document.getElementById("donationImportSubmit").disabled, true);
    incoming.emit({ type: "progress", month: MONTH, monthIndex: 1, monthCount: 1, page: 1, pages: 2, count: 10 });
    assert.match(document.getElementById("donationImportStatus").textContent, /1\/2페이지/);
    const rows = [
        { ...snapshot().months[MONTH][0], text: "<img src=x onerror=alert(1)>" },
        { ...snapshot().months[MONTH][0], amount: 2000 },
    ];
    chrome.testState.local[store.STORAGE_KEY] = store.applyMutation(
        {},
        { kind: "replaceDonationMonths", snapshot: snapshot({ months: { [MONTH]: rows } }) },
        NOW
    ).history;
    incoming.emit({ type: "done", count: 2, startMonth: MONTH, endMonth: MONTH });
    await waitForCondition(() => document.getElementById("activitySummary").textContent.includes("3,000치즈 (2회)"));
    assert.equal(document.getElementById("activityType").value, "imported");
    assert.equal(document.querySelector("#activityList img"), null);
    assert.match(document.getElementById("activityList").textContent, /메시지 없는 후원/);
    assert.equal(document.getElementById("totalWatchTime").textContent, "0초");
    assert.equal(document.getElementById("totalLiveCount").textContent, "0개");
    assert.equal(document.getElementById("clearHistory").disabled, false);
    const activityType = document.getElementById("activityType");
    activityType.value = "donation";
    dispatch(dom, activityType, "change");
    assert.match(document.getElementById("activitySummary").textContent, /0치즈 \(0회\)/);
    document.getElementById("clearDonationImport").click();
    await waitForCondition(() => document.getElementById("clearDonationImport").disabled);
    assert.equal(chrome.testState.local[store.STORAGE_KEY].donationImport, undefined);
});
