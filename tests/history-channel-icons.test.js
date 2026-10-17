const assert = require("node:assert/strict");
const test = require("node:test");
const {
    createDom,
    createFakeChrome,
    evalRepoScript,
    dispatch,
    readRepoFile,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

const STORAGE_KEY = "betterChzzkLiveWatchHistory";
const NOW = Date.parse("2026-09-14T12:00:00+09:00");
const API = "https://api.chzzk.naver.com/service/v1/channels/";
const imageUrl = (channelId) => `https://nng-phinf.pstatic.net/profile/${channelId}.png`;

function record(id, channelId, channelName, date, seconds = 600) {
    const start = Date.parse(`${date}T10:00:00+09:00`);
    return {
        id,
        channelId,
        channelName,
        title: `${channelName} 방송 ${id}`,
        firstWatchedAt: start,
        lastWatchedAt: start + seconds * 1000,
        watchedSeconds: seconds,
        dailySeconds: { [date]: seconds },
        sessions: 1,
    };
}

function addChat(entry, date) {
    const at = Date.parse(`${date}T10:00:00+09:00`);
    entry.activities = [{ id: `viewer:${at}:1`, at, kind: "chat", text: "안녕하세요", amount: 0 }];
    entry.activityDaily = { [date]: { chatCount: 1, donationCount: 0, donationCheese: 0 } };
}

function profile(channelId, overrides = {}) {
    return {
        code: 200,
        content: { channelId, channelName: channelId, channelImageUrl: imageUrl(channelId), ...overrides },
    };
}

async function openHistory(t, rows, expectedVisibleCount = rows.length) {
    const entries = Object.fromEntries(rows.map((row) => [row.id, row]));
    const chrome = createFakeChrome({ local: { [STORAGE_KEY]: { entries } } });
    const initialLocal = JSON.parse(JSON.stringify(chrome.testState.local));
    const writes = [];
    for (const area of ["local", "sync"]) {
        for (const method of ["set", "remove"]) {
            const original = chrome.storage[area][method];
            chrome.storage[area][method] = (...args) => {
                writes.push(`${area}.${method}`);
                return original(...args);
            };
        }
    }
    const dom = createDom("history.html", "history.html", chrome);
    const calls = [];
    dom.window.fetch = (url, init = {}) => {
        const call = { url: String(url), init, settled: false };
        calls.push(call);
        return new Promise((resolve, reject) => {
            const settle = (fn, value) => {
                if (call.settled) return;
                call.settled = true;
                fn(value);
            };
            call.respond = (body, { ok = true } = {}) =>
                settle(resolve, { ok, status: ok ? 200 : 500, json: async () => body });
            call.fail = () => settle(reject, new Error("network failure"));
            init.signal?.addEventListener("abort", () => settle(reject, new Error("aborted")), { once: true });
        });
    };
    const timerDelays = [];
    const nativeSetTimeout = dom.window.setTimeout.bind(dom.window);
    dom.window.setTimeout = (callback, delay, ...args) => {
        timerDelays.push(delay);
        return nativeSetTimeout(callback, delay, ...args);
    };
    t.after(async () => {
        dom.window.dispatchEvent(new dom.window.Event("pagehide"));
        await new Promise((resolve) => setTimeout(resolve, 0));
        dom.window.close();
    });
    dom.window.Date.now = () => NOW;
    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "history.js");
    const document = dom.window.document;
    await waitForCondition(() => document.querySelectorAll(".history-item").length === expectedVisibleCount);
    const row = (id) =>
        Array.from(document.querySelectorAll(".history-item")).find((item) => item.dataset.entryId === id);
    const callFor = (channelId) => calls.find((call) => call.url === `${API}${channelId}`);
    const icons = (root = document) => Array.from(root.querySelectorAll(".history-channel-icon"));
    const listIcons = () => icons(document.getElementById("historyList"));
    const loadIcon = (icon) => icon.dispatchEvent(new dom.window.Event("load"));
    return {
        dom,
        chrome,
        document,
        row,
        calls,
        callFor,
        icons,
        listIcons,
        loadIcon,
        writes,
        initialLocal,
        timerDelays,
    };
}

test("a verified channel profile becomes a round decorative icon wherever its channel heads a row", async (t) => {
    const alphaFirst = record("live:alpha-1", "alpha", "알파", "2026-09-10");
    addChat(alphaFirst, "2026-09-10");
    const h = await openHistory(t, [
        alphaFirst,
        record("live:alpha-2", "alpha", "알파", "2026-09-11"),
        record("live:beta", "beta", "베타", "2026-09-12"),
        record("live:legacy", "", "예전 기록", "2026-09-13"),
    ]);
    const { document } = h;

    assert.deepEqual(h.calls.map((call) => call.url).sort(), [`${API}alpha`, `${API}beta`]);
    for (const call of h.calls) {
        assert.equal(call.init.credentials, "omit", "profile lookups never carry the CHZZK login");
        assert.ok(call.init.signal, "profile lookups are cancellable");
    }
    assert.equal(h.icons().length, 0, "nothing is shown before a verified response");

    h.callFor("alpha").respond(profile("alpha"));
    await waitForCondition(() => h.listIcons().length === 2);
    assert.ok(
        h.icons().every((icon) => icon.hidden),
        "the icon takes no space until the image has loaded"
    );
    h.loadIcon(h.listIcons()[0]);
    for (const id of ["live:alpha-1", "live:alpha-2"]) {
        const [icon, ...extra] = h.icons(h.row(id));
        assert.equal(extra.length, 0);
        assert.equal(icon.hidden, false);
        assert.equal(icon.tagName, "IMG");
        assert.equal(icon.getAttribute("alt"), "");
        assert.equal(icon.src, imageUrl("alpha"));
        assert.equal(icon.getAttribute("referrerpolicy"), "no-referrer");
        assert.equal(icon.nextElementSibling, h.row(id).querySelector(".history-item-main"));
    }
    assert.equal(h.icons(h.row("live:beta")).length, 0);
    assert.equal(h.icons(h.row("live:legacy")).length, 0);

    h.callFor("beta").respond(profile("beta"));
    await waitForCondition(() => h.icons(h.row("live:beta")).length === 1);
    h.loadIcon(h.icons(h.row("live:beta"))[0]);
    assert.equal(h.icons(h.row("live:beta"))[0].src, imageUrl("beta"));

    document.getElementById("rankingViewTab").click();
    const rankingRow = (channelId) =>
        Array.from(document.querySelectorAll("#channelRanking li")).find((li) => li.dataset.channelId === channelId);
    for (const channelId of ["alpha", "beta"]) {
        const [icon] = h.icons(rankingRow(channelId));
        assert.equal(icon.hidden, false);
        assert.equal(icon.src, imageUrl(channelId));
        assert.equal(icon.previousElementSibling.className, "history-ranking-position");
    }
    document.getElementById("activityViewTab").click();
    const head = document.querySelector("#activityList .history-activity-group");
    assert.equal(head.firstElementChild, h.icons(head)[0]);
    assert.equal(h.icons(head)[0].src, imageUrl("alpha"));

    document.getElementById("historyViewTab").click();
    const search = document.getElementById("historySearch");
    search.value = "알파";
    dispatch(h.dom, search, "input");
    search.value = "";
    dispatch(h.dom, search, "input");
    document.getElementById("refresh").click();
    await waitForCondition(() => document.getElementById("notice").dataset.state === "saved");
    assert.equal(h.icons(h.row("live:alpha-2")).length, 1);
    assert.equal(h.calls.length, 2, "one lookup per channel for the page lifetime");

    assert.deepEqual(h.writes, [], "profile results are never written to extension storage");
    assert.deepEqual(h.chrome.testState.local, h.initialLocal);
    assert.equal(h.chrome.testState.runtimeMessages.length, 0);
    assert.doesNotMatch(readRepoFile("history.js"), /\b(?:localStorage|sessionStorage|indexedDB|caches)\b/);
});

test("failed, invalid, mismatched, missing and broken profiles leave no icon, slot or error and are not retried", async (t) => {
    const cases = {
        offline: (call) => call.fail(),
        "http-error": (call) => call.respond(profile("http-error"), { ok: false }),
        "bad-code": (call) => call.respond({ ...profile("bad-code"), code: 500 }),
        mismatch: (call) => call.respond(profile("other-channel")),
        "no-image": (call) => call.respond(profile("no-image", { channelImageUrl: "" })),
        untrusted: (call) =>
            call.respond(profile("untrusted", { channelImageUrl: "https://evil.example/profile.png" })),
        insecure: (call) =>
            call.respond(profile("insecure", { channelImageUrl: "http://nng-phinf.pstatic.net/profile.png" })),
        broken: (call) => call.respond(profile("broken")),
    };
    const ids = Object.keys(cases);
    const h = await openHistory(
        t,
        ids.map((id, index) => record(`live:${id}`, id, `채널 ${id}`, `2026-09-${String(index + 1).padStart(2, "0")}`))
    );
    const { document } = h;
    const answered = new Set();
    await waitForCondition(() => {
        for (const call of h.calls) {
            if (answered.has(call)) continue;
            answered.add(call);
            cases[call.url.slice(API.length)](call);
        }
        return answered.size === ids.length;
    });
    await waitForCondition(() => h.listIcons().length === 1);
    const broken = h.listIcons()[0];
    assert.equal(broken.closest(".history-item").dataset.entryId, "live:broken");
    assert.equal(broken.hidden, true, "an unloaded image keeps no space");
    broken.dispatchEvent(new h.dom.window.Event("error"));
    assert.equal(broken.isConnected, false);

    const plainRow = Array.from(h.row("live:offline").children, (child) => child.className);
    for (const id of ids) {
        assert.equal(h.icons(h.row(`live:${id}`)).length, 0, `${id} shows text only`);
        assert.deepEqual(
            Array.from(h.row(`live:${id}`).children, (child) => child.className),
            plainRow,
            `${id} keeps no icon slot`
        );
    }
    assert.equal(document.getElementById("message").classList.contains("hidden"), true, "no error message");
    assert.equal(document.getElementById("notice").dataset.state, "saved");

    const search = document.getElementById("historySearch");
    search.value = "채널";
    dispatch(h.dom, search, "input");
    document.getElementById("rankingViewTab").click();
    document.getElementById("historyViewTab").click();
    document.getElementById("refresh").click();
    await waitForCondition(() => document.getElementById("notice").dataset.state === "saved");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.calls.length, ids.length, "failed channels are not requested again");
    assert.equal(h.icons().length, 0);
    assert.deepEqual(h.writes, []);
});

test("profile lookups run at most four at a time with an eight second limit", async (t) => {
    const ids = ["c1", "c2", "c3", "c4", "c5", "c6"];
    const h = await openHistory(
        t,
        ids.map((id, index) => record(`live:${id}`, id, `채널 ${id}`, `2026-09-0${index + 1}`))
    );
    assert.equal(h.calls.length, 4);
    assert.equal(h.timerDelays.filter((delay) => delay === 8000).length, 4);
    h.calls[0].respond(profile(h.calls[0].url.slice(API.length)));
    await waitForCondition(() => h.calls.length === 5);
    h.calls[1].fail();
    await waitForCondition(() => h.calls.length === 6);
    assert.deepEqual(h.calls.map((call) => call.url).sort(), ids.map((id) => `${API}${id}`).sort());
    assert.ok(h.calls.every((call) => call.init.credentials === "omit"));
});

test("a late profile response only decorates rows that still show its channel", async (t) => {
    const h = await openHistory(t, [
        record("live:alpha", "alpha", "알파", "2026-09-11"),
        record("live:beta", "beta", "베타", "2026-09-10"),
    ]);
    const { document } = h;
    const firstRow = () => document.querySelector(".history-item");
    assert.equal(firstRow().dataset.entryId, "live:alpha");
    const search = document.getElementById("historySearch");
    search.value = "베타";
    dispatch(h.dom, search, "input");
    assert.equal(firstRow().dataset.entryId, "live:beta", "the first row now shows another channel");

    h.callFor("alpha").respond(profile("alpha"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.icons().length, 0, "the late alpha profile is not placed on the beta row");

    h.callFor("beta").respond(profile("beta"));
    await waitForCondition(() => h.listIcons().length === 1);
    assert.equal(h.listIcons()[0].src, imageUrl("beta"));

    search.value = "";
    dispatch(h.dom, search, "input");
    assert.equal(h.icons(h.row("live:alpha"))[0].src, imageUrl("alpha"));
    assert.equal(h.icons(h.row("live:beta"))[0].src, imageUrl("beta"));
    assert.equal(h.calls.length, 2);
});

test("leaving the page cancels profile lookups in flight and starts no more", async (t) => {
    const ids = ["c1", "c2", "c3", "c4", "c5", "c6"];
    const h = await openHistory(
        t,
        ids.map((id, index) => record(`live:${id}`, id, `채널 ${id}`, `2026-09-0${index + 1}`))
    );
    assert.equal(h.calls.length, 4);
    assert.ok(h.calls.every((call) => !call.init.signal.aborted));
    h.dom.window.dispatchEvent(new h.dom.window.Event("pagehide"));
    assert.ok(h.calls.every((call) => call.init.signal.aborted));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const search = h.document.getElementById("historySearch");
    search.value = "채널";
    dispatch(h.dom, search, "input");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.calls.length, 4, "queued channels are not requested after pagehide");
    assert.equal(h.icons().length, 0);
});
