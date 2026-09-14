const assert = require("node:assert/strict");
const test = require("node:test");
const {
    createDom,
    createFakeChrome,
    evalRepoScript,
    dispatch,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

const STORAGE_KEY = "betterChzzkLiveWatchHistory";
const NOW = Date.parse("2026-09-14T12:00:00+09:00");

function entry(id, title, date, seconds) {
    const start = Date.parse(`${date}T10:00:00+09:00`);
    return {
        id,
        channelId: id.slice(5),
        channelName: title,
        title,
        firstWatchedAt: start,
        lastWatchedAt: start + seconds * 1000,
        watchedSeconds: seconds,
        dailySeconds: { [date]: seconds },
        sessions: 1,
    };
}

async function openHistory(t) {
    const history = {
        entries: {
            "live:alpha": entry("live:alpha", "같은 방송 제목", "2026-09-10", 600),
            "live:beta": entry("live:beta", "같은 방송 제목", "2026-09-11", 300),
            "live:august": entry("live:august", "지난달 기록", "2026-08-10", 900),
        },
    };
    const chrome = createFakeChrome({ local: { [STORAGE_KEY]: history } });
    const dom = createDom("history.html", "history.html", chrome);
    t.after(() => dom.window.close());
    dom.window.Date.now = () => NOW;
    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "history.js");
    await waitForCondition(() => dom.window.document.querySelectorAll(".history-item").length === 2);
    const document = dom.window.document;
    const row = (id) =>
        Array.from(document.querySelectorAll(".history-item")).find((item) => item.dataset.entryId === id);
    return { dom, chrome, document, row, history };
}

test("history selection, details, and date filtering preserve keyboard focus on the same identity", async (t) => {
    const { document, row } = await openHistory(t);
    const selected = row("live:beta").querySelector("input");
    selected.focus();
    selected.click();
    assert.equal(document.activeElement, row("live:beta").querySelector("input"));
    assert.equal(document.activeElement.checked, true);
    for (const expanded of [true, false]) {
        const detail = row("live:beta").querySelector(".history-entry-detail");
        detail.focus();
        detail.click();
        assert.equal(document.activeElement, row("live:beta").querySelector(".history-entry-detail"));
        assert.equal(document.activeElement.getAttribute("aria-expanded"), String(expanded));
    }
    const date = document.querySelector('[data-date="2026-09-11"]');
    date.focus();
    date.click();
    assert.equal(document.activeElement, document.querySelector('[data-date="2026-09-11"]'));
    assert.equal(document.querySelectorAll(".history-item").length, 1);
});

test("a reordered async history refresh restores by record ID without stealing newer outside focus", async (t) => {
    const { dom, chrome, document, row, history } = await openHistory(t);
    const scheduled = new Map();
    let timerId = 0;
    dom.window.setTimeout = (callback) => {
        scheduled.set(++timerId, callback);
        return timerId;
    };
    dom.window.clearTimeout = (id) => scheduled.delete(id);
    let complete;
    chrome.storage.local.get = (_keys, callback) => {
        complete = callback;
    };
    const reload = async () => {
        complete = null;
        for (const listener of chrome.testState.storageChangeListeners)
            listener({ [STORAGE_KEY]: { newValue: history } }, "local");
        for (const [id, callback] of scheduled) {
            scheduled.delete(id);
            callback();
        }
        await waitForCondition(() => Boolean(complete));
    };
    row("live:alpha").querySelector(".history-entry-detail").focus();
    await reload();
    history.entries["live:beta"] = entry("live:beta", "같은 방송 제목", "2026-09-11", 1200);
    const original = document.activeElement;
    complete({ [STORAGE_KEY]: history });
    await waitForCondition(() => !original.isConnected);
    assert.equal(document.querySelector(".history-item").dataset.entryId, "live:beta");
    assert.equal(document.activeElement, row("live:alpha").querySelector(".history-entry-detail"));
    await reload();
    const search = document.getElementById("historySearch");
    search.focus();
    const oldRow = row("live:alpha");
    complete({ [STORAGE_KEY]: history });
    await waitForCondition(() => !oldRow.isConnected);
    assert.equal(document.activeElement, search);
});

test("hidden selections are explained in the page and delete confirmation, and can all be cleared", async (t) => {
    const { dom, chrome, document, row } = await openHistory(t);
    row("live:alpha").querySelector("input").click();
    row("live:beta").querySelector("input").click();
    const search = document.getElementById("historySearch");
    search.value = "없는 결과";
    dispatch(dom, search, "input");
    assert.equal(document.querySelectorAll(".history-item").length, 0);
    assert.equal(document.getElementById("selectionStatus").textContent, "선택 2개 · 현재 목록 밖 2개");
    const confirmations = [];
    dom.window.confirm = (text) => {
        confirmations.push(text);
        return false;
    };
    document.getElementById("deleteSelectedHistory").click();
    assert.match(confirmations[0], /현재 목록 밖의 기록 2개도 함께 삭제/);
    assert.equal(chrome.testState.runtimeMessages.length, 0);
    const clear = document.getElementById("clearSelection");
    clear.focus();
    clear.click();
    assert.equal(document.getElementById("selectionStatus").textContent, "선택 0개");
    assert.equal(document.getElementById("deleteSelectedHistory").disabled, true);
    assert.equal(clear.disabled, true);
    assert.equal(document.activeElement, search);
    assert.equal(search.value, "없는 결과");
    assert.equal(chrome.testState.runtimeMessages.length, 0);
});

test("deleting a hidden selection writes only the selected record IDs", async (t) => {
    const { dom, chrome, document, row } = await openHistory(t);
    row("live:alpha").querySelector("input").click();
    document.getElementById("prevMonth").click();
    assert.equal(document.getElementById("selectionStatus").textContent, "선택 1개 · 현재 목록 밖 1개");
    dom.window.confirm = () => true;
    document.getElementById("deleteSelectedHistory").click();
    await waitForCondition(() => document.getElementById("selectionStatus").textContent === "선택 0개");
    const mutations = chrome.testState.runtimeMessages.filter((message) => message.operation?.kind === "deleteEntries");
    assert.equal(mutations.length, 1);
    assert.deepEqual(Array.from(mutations[0].operation.entryIds), ["live:alpha"]);
    assert.ok(chrome.testState.local[STORAGE_KEY].entries["live:beta"]);
    assert.ok(chrome.testState.local[STORAGE_KEY].entries["live:august"]);
});

test("summary and calendar footer name the selected month including months with no records", async (t) => {
    const { document } = await openHistory(t);
    for (const [month, duration] of [
        [9, "15분"],
        [8, "15분"],
        [7, "0초"],
    ]) {
        if (month !== 9) document.getElementById("prevMonth").click();
        assert.equal(document.getElementById("monthWatchLabel").textContent, `2026년 ${month}월`);
        assert.equal(document.getElementById("monthWatchTime").textContent, duration);
        assert.ok(document.getElementById("calendarFoot").textContent.includes(`2026년 ${month}월 총`));
    }
});

test("month overview clears only the date filter and returns focus to that calendar day", async (t) => {
    const { dom, document, row, chrome } = await openHistory(t);
    const overview = document.getElementById("clearDateFilter");
    assert.equal(overview.disabled, true);
    row("live:beta").querySelector("input").click();
    const search = document.getElementById("historySearch");
    search.value = "같은 방송";
    dispatch(dom, search, "input");
    const direction = document.getElementById("historySortDirection");
    direction.value = "asc";
    dispatch(dom, direction, "change");
    document.querySelector('[data-date="2026-09-11"]').click();
    assert.equal(document.querySelectorAll(".history-item").length, 1);
    assert.equal(overview.disabled, false);
    assert.equal(document.querySelector('[data-date="2026-09-11"]').getAttribute("aria-pressed"), "true");
    overview.focus();
    overview.click();
    assert.equal(document.querySelectorAll(".history-item").length, 2);
    assert.equal(document.querySelector(".history-item").dataset.entryId, "live:beta");
    assert.equal(row("live:beta").querySelector("input").checked, true);
    assert.equal(search.value, "같은 방송");
    assert.equal(direction.value, "asc");
    assert.equal(overview.disabled, true);
    assert.equal(document.activeElement, document.querySelector('[data-date="2026-09-11"]'));
    assert.equal(document.activeElement.getAttribute("aria-pressed"), "false");
    assert.equal(chrome.testState.runtimeMessages.length, 0);
    document.querySelector('[data-date="2026-09-11"]').click();
    document.getElementById("prevMonth").click();
    assert.equal(overview.disabled, true);
});

test("history load errors persist until dismissal or successful reload", async (t) => {
    const { dom, chrome, document, history } = await openHistory(t);
    const scheduled = new Map();
    let timerId = 0;
    dom.window.setTimeout = (callback, delay) => {
        scheduled.set(++timerId, { callback, delay });
        return timerId;
    };
    dom.window.clearTimeout = (id) => scheduled.delete(id);
    chrome.storage.local.get = (_keys, callback) => {
        chrome.runtime.lastError = { message: "read failed" };
        callback({});
        chrome.runtime.lastError = null;
    };
    const refresh = document.getElementById("refresh");
    const message = document.getElementById("message");
    refresh.click();
    await waitForCondition(() => message.dataset.type === "error");
    assert.match(message.textContent, /새로고침 버튼/);
    assert.equal(
        [...scheduled.values()].some(({ delay }) => delay === 1800),
        false
    );
    let dismiss = message.querySelector(".message-close");
    refresh.click();
    dismiss.focus();
    await waitForCondition(() => !dismiss.isConnected);
    dismiss = message.querySelector(".message-close");
    assert.equal(document.activeElement, dismiss, "repeated load failures retain dismiss-button focus");
    dismiss.focus();
    dismiss.click();
    assert.equal(message.classList.contains("hidden"), true);
    assert.equal(document.activeElement, refresh);
    refresh.click();
    await waitForCondition(() => !message.classList.contains("hidden"));
    chrome.storage.local.get = (_keys, callback) => callback({ [STORAGE_KEY]: history });
    for (const listener of chrome.testState.storageChangeListeners) listener({ [STORAGE_KEY]: {} }, "local");
    for (const [id, { callback }] of scheduled) {
        scheduled.delete(id);
        callback();
    }
    await waitForCondition(() => message.classList.contains("hidden"));
    assert.equal(document.getElementById("notice").dataset.state, "saved");
});
