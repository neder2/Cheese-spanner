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
        previous: coveredLedger(),
        now: () => NOW,
        identify: async () => "viewer",
        requestPage: async () => response([apiRow()]),
        ...changes,
    });

function coveredLedger() {
    return data.mergeSnapshot(
        null,
        snapshot({
            startMonth: data.FIRST_MONTH,
            months: Object.fromEntries(data.getMonths(data.FIRST_MONTH, MONTH, NOW).map((month) => [month, []])),
        }),
        NOW - 500
    );
}

test("first refresh covers every native month including gaps; repeat refresh only requests the open month", async () => {
    const requests = [];
    const requestPage = async (month) => {
        requests.push(month);
        return response(month === "2023-02" ? [apiRow(0, { purchaseDate: "2023-02-01T12:00:00+09:00" })] : [], 1);
    };
    const first = await collect({ previous: undefined, requestPage });
    assert.deepEqual(requests, data.getMonths("2023-01", MONTH, NOW));
    assert.equal(first.months["2023-02"].length, 1);
    let ledger = data.mergeSnapshot(null, first, NOW);
    requests.length = 0;
    const second = await collect({ previous: ledger, now: () => NOW + 1000, requestPage });
    assert.deepEqual(requests, [MONTH]);
    ledger = data.mergeSnapshot(ledger, second, NOW + 1000);
    assert.equal(ledger.months["2023-02"].length, 1);
    assert.equal(ledger.monthStartedAt["2023-02"], NOW);
});

test("refresh finishes the previous open month across a KST month boundary, then skips it", async () => {
    let ledger = coveredLedger();
    const october = Date.parse("2026-09-30T15:00:00Z");
    const calls = [];
    const run = (time) =>
        collect({
            previous: ledger,
            now: () => time,
            requestPage: async (month) => {
                calls.push(month);
                return response(month === MONTH ? [apiRow()] : [], 1);
            },
        });
    ledger = data.mergeSnapshot(ledger, await run(october), october);
    assert.deepEqual(calls, ["2026-09", "2026-10"]);
    assert.equal(ledger.months[MONTH].length, 1);
    calls.length = 0;
    ledger = data.mergeSnapshot(ledger, await run(october + 1000), october + 1000);
    assert.deepEqual(calls, ["2026-10"]);
    assert.equal(ledger.months[MONTH].length, 1);
});

test("legacy partial imports fill missing months without fetching completed months or losing them", async () => {
    const previous = coveredLedger();
    delete previous.months["2024-02"];
    delete previous.months["2025-08"];
    previous.months["2025-09"] = [{ ...snapshot().months[MONTH][0], at: Date.parse("2025-09-01T00:00:00+09:00") }];
    const calls = [];
    const next = await collect({
        previous,
        requestPage: async (month) => {
            calls.push(month);
            return response([], 0);
        },
    });
    assert.deepEqual(calls, ["2024-02", "2025-08", MONTH]);
    const ledger = data.mergeSnapshot(previous, next, NOW);
    assert.equal(ledger.months["2025-09"].length, 1);
    assert.deepEqual(data.getRefreshMonths(ledger, NOW + 1000), [MONTH]);
    assert.throws(() => data.normalizeSnapshot({ ...next, startMonth: "2025-08" }, NOW), /월 범위/);
});

test("failed incremental refresh does not advance coverage and a different account cannot reuse it", async () => {
    const previous = coveredLedger();
    const before = JSON.stringify(previous);
    let requests = 0;
    await assert.rejects(
        collect({
            previous,
            requestPage: async () => {
                requests++;
                throw new Error("HTTP 503");
            },
        }),
        /503/
    );
    assert.equal(JSON.stringify(previous), before);
    assert.deepEqual(data.getRefreshMonths(previous, NOW), [MONTH]);
    await assert.rejects(
        collect({
            previous,
            identify: async () => "other",
            requestPage: async () => {
                requests++;
            },
        }),
        /다른 계정/
    );
    assert.equal(requests, 1);
    previous.monthStartedAt["2025-01"] = NOW + 1;
    assert.deepEqual(data.getRefreshMonths(previous, NOW), ["2025-01", MONTH]);
});

test("refresh snapshots stop at request start so concurrent live donations can be shown without overlap", async () => {
    let time = NOW;
    const result = await collect({
        now: () => time,
        requestPage: async () => {
            time = NOW + 2000;
            return response([apiRow(), apiRow(1, { purchaseDate: new Date(NOW + 1000).toISOString() })]);
        },
    });
    assert.equal(result.startedAt, NOW);
    assert.equal(result.months[MONTH].length, 1);
});

test("one donation view uses refreshed coverage and later live rows without duplicating genuine purchases", async (t) => {
    const at = NOW - 1000;
    const newAt = NOW + 1000;
    const oldAt = Date.parse("2026-08-03T10:00:00+09:00");
    const liveRow = (time, amount) => ({ id: `viewer:${time}:10`, kind: "donation", at: time, amount, text: "" });
    const record = {
        id: "live:100",
        channelId: "channel-a",
        channelName: "검증 채널",
        title: "검증 방송",
        firstWatchedAt: oldAt,
        lastWatchedAt: newAt,
        watchedSeconds: 60,
        dailySeconds: { "2026-09-19": 60 },
        activityDaily: {
            "2026-08-03": { donationCount: 4, donationCheese: 8000, chatCount: 0 },
            "2026-09-19": { donationCount: 2, donationCheese: 1500, chatCount: 0 },
        },
        activities: [liveRow(oldAt, 2000), liveRow(at, 1000), liveRow(newAt, 500)],
    };
    const api = { ...snapshot().months[MONTH][0], at, text: "" };
    const imported = snapshot({ startedAt: NOW, months: { [MONTH]: [api, api] } });
    const history = store.applyMutation(
        { entries: { "live:100": record } },
        { kind: "replaceDonationMonths", snapshot: imported },
        NOW
    ).history;
    const chrome = createFakeChrome({ local: { [store.STORAGE_KEY]: history } });
    const dom = createDom("history.html", "history.html", chrome);
    t.after(() => dom.window.close());
    dom.window.Date.now = () => NOW + 2000;
    for (const file of ["shared/data.js", "shared/donationHistory.js", "history.js"]) evalRepoScript(dom, file);
    const document = dom.window.document;
    await waitForCondition(() => document.getElementById("notice").dataset.state === "saved");
    document.getElementById("activityType").value = "donation";
    dispatch(dom, document.getElementById("activityType"), "change");
    assert.match(document.getElementById("activitySummary").textContent, /내 후원 2,500치즈 \(3회\)/);
    assert.equal(document.querySelectorAll("#activityList li").length, 3);
    document.getElementById("historyScope").value = "all";
    dispatch(dom, document.getElementById("historyScope"), "change");
    assert.match(document.getElementById("activitySummary").textContent, /10,500치즈 \(7회\)/);
    assert.equal(document.querySelectorAll("#activityList li").length, 4);
    assert.match(document.getElementById("channelRanking").textContent, /10,500치즈 \(7회\)/);
    chrome.testState.local[store.STORAGE_KEY] = store.applyMutation(
        history,
        {
            kind: "replaceDonationMonths",
            snapshot: {
                ...imported,
                startedAt: NOW + 3000,
                months: { [MONTH]: [api, api, { ...api, at: newAt, amount: 500 }] },
            },
        },
        NOW + 3000
    ).history;
    document.getElementById("refresh").click();
    await waitForCondition(() => document.getElementById("message").textContent.includes("새로고침했습니다"));
    assert.match(document.getElementById("activitySummary").textContent, /10,500치즈 \(7회\)/);
    assert.equal(document.querySelectorAll("#activityList li").length, 4);
    document.getElementById("historySearch").value = "없는 채널";
    dispatch(dom, document.getElementById("historySearch"), "input");
    assert.match(document.getElementById("activitySummary").textContent, /0치즈 \(0회\)/);
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
    assert.equal(data.getMonths("2025-01", MONTH, NOW).length, 21);
    assert.throws(() => data.getMonths("2000-01", MONTH, NOW), /조회 범위/);
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

function importController(t, { requestPage, owner = "viewer", history = { donationImport: coveredLedger() } } = {}) {
    const onConnect = events();
    let stored = history,
        writes = 0,
        requests = 0;
    const original = globalThis.BetterChzzk.utils.fetchJson;
    globalThis.BetterChzzk.utils.fetchJson = async (url, options) => {
        requests++;
        return requestPage ? requestPage(options, new URL(url)) : response([apiRow()]);
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
            start: () => port.onMessage.emit({ type: "start" }),
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

test("history refresh starts with one click, ignores display filters, shows one donation view, and resets imports", async (t) => {
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
    assert.equal(sent.length, 0);
    assert.equal(document.querySelector('input[type="month"]'), null);
    document.getElementById("historySearch").value = "필터와 무관한 전체 갱신";
    document.getElementById("donationImportRefresh").click();
    document.getElementById("donationImportRefresh").click();
    assert.equal(sent.length, 1);
    assert.equal(JSON.stringify(sent[0]), JSON.stringify({ type: "start" }));
    assert.equal(document.getElementById("donationImportRefresh").disabled, true);
    document.getElementById("historySearch").value = "";
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
    incoming.emit({ type: "done", count: 2, monthCount: 1 });
    await waitForCondition(() => document.getElementById("activitySummary").textContent.includes("3,000치즈 (2회)"));
    assert.equal(document.getElementById("activityType").value, "donation");
    assert.equal(document.querySelector('#activityType option[value="imported"]'), null);
    await waitForCondition(() => document.activeElement.id === "donationImportRefresh");
    assert.match(document.getElementById("donationImportUpdated").textContent, /마지막 갱신/);
    assert.equal(document.querySelector("#activityList img"), null);
    assert.match(document.getElementById("activityList").textContent, /메시지 없는 후원/);
    assert.equal(document.getElementById("totalWatchTime").textContent, "0초");
    assert.equal(document.getElementById("totalLiveCount").textContent, "0개");
    assert.equal(document.getElementById("clearHistory").disabled, false);
    const activityType = document.getElementById("activityType");
    activityType.value = "donation";
    dispatch(dom, activityType, "change");
    assert.match(document.getElementById("activitySummary").textContent, /3,000치즈 \(2회\)/);
    document.getElementById("clearDonationImport").click();
    await waitForCondition(() => document.getElementById("clearDonationImport").disabled);
    assert.equal(chrome.testState.local[store.STORAGE_KEY].donationImport, undefined);
});
