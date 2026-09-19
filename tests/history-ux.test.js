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

async function openHistory(t, amendHistory = () => {}, expectedVisibleCount = 2) {
    const history = {
        entries: {
            "live:alpha": entry("live:alpha", "같은 방송 제목", "2026-09-10", 600),
            "live:beta": entry("live:beta", "같은 방송 제목", "2026-09-11", 300),
            "live:august": entry("live:august", "지난달 기록", "2026-08-10", 900),
        },
    };
    amendHistory(history);
    const chrome = createFakeChrome({ local: { [STORAGE_KEY]: history } });
    const dom = createDom("history.html", "history.html", chrome);
    t.after(async () => {
        // Fake Chrome delivers callbacks on the next task, including after a failed assertion.
        await new Promise((resolve) => setTimeout(resolve, 0));
        dom.window.close();
    });
    dom.window.Date.now = () => NOW;
    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "history.js");
    await waitForCondition(() => dom.window.document.querySelectorAll(".history-item").length === expectedVisibleCount);
    const document = dom.window.document;
    const row = (id) =>
        Array.from(document.querySelectorAll(".history-item")).find((item) => item.dataset.entryId === id);
    return { dom, chrome, document, row, history };
}

function addChats(record, date, count, text = "내 채팅") {
    record.activities ||= [];
    record.activityDaily ||= {};
    const start = Date.parse(`${date}T10:00:00+09:00`);
    for (let index = 0; index < count; index++) {
        const at = start + index * 1000;
        record.activities.push({ id: `viewer:${at}:1`, at, kind: "chat", text: `${text} ${index + 1}`, amount: 0 });
    }
    record.activityDaily[date] = { chatCount: count, donationCount: 0, donationCheese: 0 };
}

test("history keeps the calendar available across views and reveals selection and row actions on demand", async (t) => {
    const { dom, document, row, chrome } = await openHistory(t);
    assert.equal(document.getElementById("historyPanel").hidden, false);
    for (const view of ["ranking", "activity"]) assert.equal(document.getElementById(`${view}Panel`).hidden, true);
    assert.equal(document.getElementById("historySelectionControls").hidden, true);
    assert.equal(row("live:alpha").querySelector(".history-entry-chats").hidden, true);
    assert.equal(row("live:alpha").querySelector(".history-entry-delete").disabled, true);
    assert.equal(row("live:alpha").querySelector("input").disabled, true);
    const calendar = document.querySelector('[aria-label="날짜 선택"]');
    assert.equal(calendar.closest("[hidden], details:not([open])"), null);
    const tab = document.getElementById("historyViewTab");
    tab.focus();
    tab.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    assert.equal(document.activeElement, document.getElementById("rankingViewTab"));
    assert.equal(document.getElementById("rankingPanel").hidden, false);
    assert.equal(document.getElementById("historyPanel").hidden, true);
    assert.equal(document.getElementById("historySortControls").hidden, true);
    document.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    assert.equal(document.getElementById("activityPanel").hidden, false);
    assert.equal(document.getElementById("activityViewTab").tabIndex, 0);
    assert.equal(tab.tabIndex, -1);
    document.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    assert.equal(document.getElementById("historyPanel").hidden, false);
    const date = calendar.querySelector('[data-date="2026-09-10"]');
    date.click();
    assert.equal(document.activeElement.dataset.date, "2026-09-10");
    document.getElementById("rankingViewTab").click();
    assert.equal(calendar.querySelector('[aria-pressed="true"]').dataset.date, "2026-09-10");
    const search = document.getElementById("historySearch");
    search.focus();
    search.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(document.activeElement, search);
    assert.equal(calendar.closest("[hidden], details:not([open])"), null);
    tab.click();
    row("live:alpha").querySelector(".history-entry-detail").click();
    assert.equal(row("live:alpha").querySelector(".history-entry-delete").disabled, false);
    assert.equal(row("live:alpha").querySelector(".history-entry-chats").hidden, false);
    assert.equal(chrome.testState.runtimeMessages.length, 0);
});

test("paging selects only current rows, keeps other selections visible in status, and clamps after deletion", async (t) => {
    const { dom, document, chrome } = await openHistory(
        t,
        (history) => {
            history.entries = {};
            for (let i = 0; i < 22; i++)
                history.entries[`live:page-${i}`] = entry(`live:page-${i}`, `방송 ${i}`, "2026-09-10", 120 + i);
        },
        10
    );
    const ids = () => Array.from(document.querySelectorAll(".history-item"), (node) => node.dataset.entryId);
    const firstPage = ids();
    assert.equal(document.getElementById("historyPrevPage").disabled, true);
    assert.match(document.getElementById("historyPageStatus").textContent, /1 \/ 3페이지.*22개/);
    document.getElementById("historySelectionToggle").click();
    document.getElementById("selectVisibleHistory").click();
    document.getElementById("historyNextPage").click();
    assert.ok(ids().every((id) => !firstPage.includes(id)));
    assert.equal(document.getElementById("selectionStatus").textContent, "선택 10개 · 현재 목록 밖 10개");
    assert.equal(document.getElementById("selectVisibleHistory").checked, false);
    document.getElementById("rankingViewTab").click();
    document.getElementById("rankingNextPage").click();
    assert.equal(document.querySelector(".history-ranking-position").textContent, "11");
    document.getElementById("historyViewTab").click();
    assert.match(document.getElementById("historyPageStatus").textContent, /2 \/ 3페이지/);
    const search = document.getElementById("historySearch");
    search.value = "방송 21";
    dispatch(dom, search, "input");
    assert.deepEqual(ids(), ["live:page-21"]);
    assert.equal(document.getElementById("historyNextPage").closest("nav").hidden, true);
    assert.equal(document.querySelector("#channelRanking li").dataset.channelId, "page-21");
    assert.equal(document.getElementById("selectionStatus").textContent, "선택 10개 · 현재 목록 밖 9개");
    search.value = "";
    dispatch(dom, search, "input");
    document.getElementById("historySelectionToggle").click();
    assert.equal(document.getElementById("selectionStatus").textContent, "선택 0개");
    document.getElementById("historyNextPage").click();
    document.getElementById("historyNextPage").click();
    assert.equal(ids().length, 2);
    const lastPage = ids();
    document.getElementById("historySelectionToggle").click();
    document.getElementById("selectVisibleHistory").click();
    document.getElementById("deleteSelectedHistory").click();
    await waitForCondition(
        () => ids().length === 10 && document.getElementById("historyPageStatus").textContent.includes("20개")
    );
    assert.equal(Object.keys(chrome.testState.local[STORAGE_KEY].entries).length, 20);
    assert.equal(ids().length, 10);
    assert.match(document.getElementById("historyPageStatus").textContent, /2 \/ 2페이지.*20개/);
    assert.equal(document.getElementById("historyNextPage").disabled, true);
    assert.deepEqual(Array.from(chrome.testState.runtimeMessages.at(-1).operation.entryIds).sort(), lastPage.sort());
    assert.ok(firstPage.every((id) => chrome.testState.local[STORAGE_KEY].entries[id]));
});

test("period and search apply to every view and activity pages do not grow into a long feed", async (t) => {
    const { dom, document, chrome } = await openHistory(t, (history) => {
        addChats(history.entries["live:alpha"], "2026-09-10", 22);
        addChats(history.entries["live:august"], "2026-08-10", 1, "지난달 채팅");
    });
    document.getElementById("activityViewTab").click();
    assert.equal(document.querySelectorAll("#activityList li").length, 10);
    document.getElementById("activityNextPage").click();
    document.getElementById("activityNextPage").click();
    assert.equal(document.querySelectorAll("#activityList li").length, 2);
    const scope = document.getElementById("historyScope");
    scope.value = "all";
    dispatch(dom, scope, "change");
    assert.match(document.getElementById("activityPageStatus").textContent, /1 \/ 3페이지.*23개/);
    document.getElementById("rankingViewTab").click();
    assert.equal(document.querySelector("#channelRanking li").dataset.channelId, "august");
    const search = document.getElementById("historySearch");
    search.value = "지난달";
    dispatch(dom, search, "input");
    assert.equal(document.querySelectorAll("#channelRanking li").length, 1);
    document.getElementById("activityViewTab").click();
    assert.match(document.getElementById("activityList").textContent, /지난달 채팅/);
    assert.equal(document.querySelectorAll("#activityList li").length, 1);
    document.getElementById("prevMonth").click();
    document.querySelector('[data-date="2026-08-10"]').click();
    assert.equal(document.activeElement.dataset.date, "2026-08-10");
    assert.equal(scope.value, "month");
    assert.equal(scope.selectedOptions[0].textContent, "2026.08.10");
    assert.equal(document.getElementById("historySearch").value, "지난달");
    assert.equal(chrome.testState.runtimeMessages.length, 0);
});

test("a broadcast's own chat disclosure is independent, safe, and follows the date filter", async (t) => {
    const { document, row } = await openHistory(t, (history) => {
        const alpha = history.entries["live:alpha"];
        addChats(alpha, "2026-09-10", 1, "<img src=x onerror=alert(1)>");
        addChats(alpha, "2026-09-11", 1, "다음 날 채팅");
        alpha.activities.push({
            id: "donation",
            kind: "donation",
            at: alpha.activities[0].at,
            text: "후원 메시지",
            amount: 1000,
        });
        addChats(history.entries["live:beta"], "2026-09-11", 1, "다른 방송 채팅");
    });
    const button = row("live:alpha").querySelector(".history-entry-chats");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(document.getElementById(button.getAttribute("aria-controls")).hidden, true);
    button.focus();
    button.click();
    let panel = row("live:alpha").querySelector(".history-entry-chat-panel");
    assert.equal(panel.hidden, false);
    assert.equal(document.activeElement, row("live:alpha").querySelector(".history-entry-chats"));
    assert.deepEqual(
        Array.from(panel.querySelectorAll(".history-activity-text"), (node) => node.textContent),
        ["다음 날 채팅 1", "<img src=x onerror=alert(1)> 1"]
    );
    assert.equal(panel.querySelector("img"), null);
    assert.equal(panel.querySelector("time").dateTime, "2026-09-11T01:00:00.000Z");
    assert.equal(row("live:beta").querySelector(".history-entry-chat-panel").hidden, true);
    row("live:alpha").querySelector(".history-entry-detail").click();
    assert.equal(row("live:alpha").querySelector(".history-entry-chats").getAttribute("aria-expanded"), "true");
    document.querySelector('[data-date="2026-09-10"]').click();
    panel = row("live:alpha").querySelector(".history-entry-chat-panel");
    assert.equal(panel.querySelectorAll("li").length, 1);
    assert.match(panel.textContent, /내 채팅 1개/);
    const close = row("live:alpha").querySelector(".history-entry-chats");
    close.focus();
    close.click();
    assert.equal(row("live:alpha").querySelector(".history-entry-chat-panel").hidden, true);
    assert.equal(row("live:alpha").querySelector(".history-entry-detail").getAttribute("aria-expanded"), "true");
    assert.equal(document.activeElement, row("live:alpha").querySelector(".history-entry-chats"));
});

test("expanded broadcast chats paginate and retain focus, scroll, and expansion during new activity", async (t) => {
    const { document, row, chrome, history } = await openHistory(t, (history) =>
        addChats(history.entries["live:alpha"], "2026-09-10", 55)
    );
    row("live:alpha").querySelector(".history-entry-chats").click();
    assert.equal(row("live:alpha").querySelectorAll(".history-entry-chat-list li").length, 50);
    row("live:alpha").querySelector(".history-entry-chat-more").click();
    assert.equal(row("live:alpha").querySelectorAll(".history-entry-chat-list li").length, 55);
    assert.equal(row("live:alpha").querySelector(".history-entry-chat-more"), null);
    const focusedId = document.activeElement.dataset.chatId;
    assert.equal(focusedId, row("live:alpha").querySelectorAll(".history-entry-chat-list li")[50].dataset.chatId);
    row("live:alpha").querySelector(".history-entry-chat-list").scrollTop = 120;
    addChats(history.entries["live:alpha"], "2026-09-12", 1, "새 채팅");
    for (const listener of chrome.testState.storageChangeListeners)
        listener({ [STORAGE_KEY]: { newValue: history } }, "local");
    await waitForCondition(() => row("live:alpha").querySelectorAll(".history-entry-chat-list li").length === 56);
    assert.equal(row("live:alpha").querySelector(".history-entry-chats").getAttribute("aria-expanded"), "true");
    assert.equal(document.activeElement.dataset.chatId, focusedId);
    assert.equal(row("live:alpha").querySelector(".history-entry-chat-list").scrollTop, 120);
    row("live:alpha").querySelector(".history-entry-detail").click();
    row("live:alpha").querySelector(".history-entry-delete").click();
    await waitForCondition(() => !row("live:alpha"));
    assert.equal(document.querySelectorAll(".history-entry-chat-list").length, 0);
});

test("broadcast chat empty states distinguish retained counts from no collected chat", async (t) => {
    const { row } = await openHistory(t, (history) => {
        history.entries["live:alpha"].activityDaily = {
            "2026-09-10": { chatCount: 7, donationCount: 0, donationCheese: 0 },
        };
    });
    row("live:alpha").querySelector(".history-entry-chats").click();
    const archived = row("live:alpha").querySelector(".history-entry-chat-panel");
    assert.match(archived.textContent, /내 채팅 7개.*내용 보관 0개/);
    assert.match(archived.textContent, /누적 개수는 유지/);
    assert.equal(archived.querySelector("ol"), null);
    row("live:beta").querySelector(".history-entry-detail").click();
    row("live:beta").querySelector(".history-entry-chats").click();
    assert.match(row("live:beta").querySelector(".history-entry-chat-panel").textContent, /저장된 내 채팅이 없어요/);
});

test("history selection, details, and date filtering preserve keyboard focus on the same identity", async (t) => {
    const { document, row } = await openHistory(t);
    document.getElementById("historySelectionToggle").click();
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
    document.getElementById("historySelectionToggle").click();
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
    document.getElementById("historySelectionToggle").click();
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

test("month overview preserves filters and selection and returns focus to the previously selected date", async (t) => {
    const { dom, document, row, chrome } = await openHistory(t);
    document.getElementById("historySelectionToggle").click();
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
    assert.equal(document.querySelector('[data-date="2026-09-11"]').getAttribute("aria-pressed"), "false");
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
