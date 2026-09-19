const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { createFakeChrome, waitForCondition } = require("./helpers/extension-page-fixture.js");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const CHANNEL = "a".repeat(32),
    SECOND = "b".repeat(32);
const KEY = "betterchzzk:live-start-channels",
    ID = "betterchzzk-live-start-registration";
const clone = (value) => JSON.parse(JSON.stringify(value));
const channel = (id = CHANNEL) => ({
    channelId: id,
    channelName: "채널 " + id.slice(0, 1),
    followerCount: 100,
    channelImageUrl: "https://nng-phinf.pstatic.net/" + id + "/profile.png",
});
const searchResponse = (...items) => ({ code: 200, content: { data: items.map((channel) => ({ channel })) } });
const header = () =>
    '<header id="header"><div class="_menu_logo_qz74s_1"></div><div class="_container_mzph5_1"><div class="_section_mzph5_8"><div class="_box_mzph5_15"><button>네이티브 버튼</button></div></div></div></header>';
function fixture(t, { channels = [], enabled = true, visible = true, withHeader = true } = {}) {
    const chrome = createFakeChrome({
        sync: { liveStartNotificationsEnabled: enabled, liveStartButtonEnabled: visible },
        local: { [KEY]: channels },
    });
    const dom = new JSDOM(
        (withHeader ? header() : "") +
            '<main id="layout-body"><div class="_control_native"><button id="spi_button">공유</button></div></main>',
        {
            url: "https://chzzk.naver.com/",
            runScripts: "outside-only",
            pretendToBeVisual: true,
        }
    );
    const w = dom.window;
    chrome.runtime.getURL = (file) => "chrome-extension://better-chzzk/" + file;
    w.chrome = chrome;
    const requests = [],
        sent = [];
    let fetcher = async () => searchResponse(channel(), channel(SECOND));
    w.fetch = async (url, init) => {
        requests.push({ url, signal: init.signal });
        const json = await fetcher(url, init);
        return { ok: true, json: async () => json };
    };
    function change(values, area = "local") {
        const changes = {};
        for (const [key, newValue] of Object.entries(values)) {
            const oldValue = chrome.testState[area][key];
            chrome.testState[area][key] = clone(newValue);
            changes[key] = { oldValue, newValue: clone(newValue) };
        }
        for (const listener of [...chrome.testState.storageChangeListeners]) listener(changes, area);
    }
    let send = (message, callback) => {
        let rules = clone(chrome.testState.local[KEY] || []);
        if (message.kind === "remove") {
            rules = rules.filter((item) => item.channelId !== message.channel.channelId);
            change({ [KEY]: rules });
            callback({ ok: true, channels: rules });
            return;
        }
        let rule = rules.find((item) => item.channelId === message.channel.channelId);
        if (!rule) {
            rule = {
                channelId: message.channel.channelId,
                channelName: channel(message.channel.channelId).channelName,
                channelImageUrl: channel(message.channel.channelId).channelImageUrl,
                notify: false,
                autoOpen: false,
            };
            rules.push(rule);
        }
        const key = message.kind === "set-auto-open" ? "autoOpen" : "notify";
        rule[key] = message.channel[key];
        change({ [KEY]: rules });
        callback({ ok: true, channels: rules });
    };
    chrome.runtime.sendMessage = (message, callback) => {
        sent.push(clone(message));
        send(message, callback);
    };
    const wanted = [
        "shared/settings.js",
        "shared/data.js",
        "content.js",
        "shared/liveStart.js",
        "features/liveStartRegistration.js",
    ];
    for (const entry of JSON.parse(read("manifest.json")).content_scripts.filter((item) => item.world !== "MAIN"))
        for (const file of entry.js.filter((item) => wanted.includes(item))) w.eval(read(file));
    t.after(() => {
        w.dispatchEvent(new w.Event("pagehide"));
        w.close();
    });
    const panel = () => w.document.getElementById(ID + "-panel");
    const trigger = () => w.document.querySelector("#" + ID + ">button");
    const input = () => panel().querySelector("input");
    return {
        w,
        chrome,
        requests,
        sent,
        change,
        panel,
        trigger,
        input,
        setFetch: (fn) => {
            fetcher = fn;
        },
        setSend: (fn) => {
            send = fn;
        },
        action: (id = CHANNEL, key = "notify") =>
            panel()?.querySelector('button[data-channel-id="' + id + '"][data-action="' + key + '"]'),
        message: () => panel()?.querySelector(".bcls-message"),
        async open() {
            await waitForCondition(() => trigger());
            trigger().click();
            await waitForCondition(() => panel() && !panel().textContent.includes("불러오는 중"));
        },
        type(value) {
            input().value = value;
            input().dispatchEvent(new w.Event("input", { bubbles: true }));
        },
        submit() {
            panel()
                .querySelector("form")
                .dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
        },
        async search(value = "채널") {
            this.type(value);
            this.submit();
            await waitForCondition(() => this.action());
        },
        navigate(url) {
            w.history.pushState({}, "", url);
            w.dispatchEvent(new w.Event("betterchzzk:routechange"));
        },
    };
}
test("one header button opens search on any page and never adds a channel-area button", async (t) => {
    const f = fixture(t);
    await f.open();
    assert.equal(f.trigger().textContent, "방송 알림");
    assert.equal(f.trigger().getAttribute("aria-expanded"), "true");
    assert.equal(f.panel().getAttribute("role"), "dialog");
    assert.equal(f.w.document.activeElement, f.input());
    assert.equal(f.w.document.querySelector("#layout-body #" + ID), null);
    assert.equal(f.requests.length, 0);
    f.type("채널");
    assert.equal(f.requests.length, 0, "typing alone does not query");
    await f.search();
    assert.equal(f.requests.length, 1);
    const url = new URL(f.requests[0].url);
    assert.equal(url.pathname, "/service/v1/search/channels");
    assert.equal(url.searchParams.get("keyword"), "채널");
    assert.equal(url.searchParams.get("size"), "5");
    assert.equal(url.searchParams.get("withFirstChannelContent"), "false");
    assert.match(f.panel().textContent, /팔로워 100명/);
    assert.equal(f.action(SECOND).closest("li").querySelector("img").src, channel(SECOND).channelImageUrl);
    f.action(SECOND).click();
    assert.deepEqual(f.sent[0], {
        type: "betterchzzk:live-start:channels",
        kind: "set-notify",
        channel: { channelId: SECOND, notify: true },
    });
    assert.equal(f.action(SECOND).getAttribute("aria-pressed"), "true");
    f.action(SECOND).click();
    assert.equal(f.action(SECOND).getAttribute("aria-pressed"), "false");
    assert.equal(f.requests.length, 1);
    f.navigate("/live/" + CHANNEL);
    assert.equal(f.panel(), null);
    await f.open();
    assert.equal(f.w.document.querySelectorAll("#" + ID).length, 1);
    assert.equal(f.action(SECOND).closest("li").querySelector("img")?.src, channel(SECOND).channelImageUrl);
});
test("registration removal deletes both channel actions and stays synchronized with search and settings", async (t) => {
    const saved = { ...channel(), notify: true, autoOpen: true };
    const other = { ...channel(SECOND), notify: true, autoOpen: false };
    const f = fixture(t, { channels: [saved, other] });
    await f.open();
    f.action(CHANNEL, "remove").click();
    assert.deepEqual(f.sent[0], {
        type: "betterchzzk:live-start:channels",
        kind: "remove",
        channel: { channelId: CHANNEL },
    });
    assert.equal(f.action(), null);
    assert.deepEqual(f.chrome.testState.local[KEY], [other]);
    assert.match(f.message().textContent, /등록을 해제/);
    await f.search();
    assert.equal(f.action(CHANNEL, "remove").hidden, true);
    assert.equal(f.action().getAttribute("aria-pressed"), "false");
    f.action().click();
    assert.equal(f.action(CHANNEL, "remove").hidden, false);
    f.action(CHANNEL, "remove").focus();
    f.action(CHANNEL, "remove").click();
    assert.equal(f.action(CHANNEL, "remove").hidden, true);
    assert.equal(f.w.document.activeElement, f.action());
    assert.equal(f.action(CHANNEL, "autoOpen").getAttribute("aria-pressed"), "false");
    assert.equal(f.chrome.testState.sync.liveStartNotificationsEnabled, true);
});

test("failed removals preserve the registration and pending removal blocks duplicate actions", async (t) => {
    const saved = { ...channel(), notify: true, autoOpen: true };
    const f = fixture(t, { channels: [saved] });
    await f.open();
    let reply;
    f.setSend((_message, callback) => {
        reply = callback;
    });
    f.action(CHANNEL, "remove").click();
    for (const key of ["notify", "autoOpen", "remove"]) assert.equal(f.action(CHANNEL, key).disabled, true);
    f.action(CHANNEL, "remove").click();
    assert.equal(f.sent.length, 1);
    reply({ ok: false, error: "저장 실패" });
    assert.deepEqual(f.chrome.testState.local[KEY], [saved]);
    assert.equal(f.action(CHANNEL, "remove").hidden, false);
    assert.equal(f.action(CHANNEL, "remove").disabled, false);
    assert.match(f.message().textContent, /저장 실패/);
});

test("saved profile images update on reused rows without reloading them for toggle changes", async (t) => {
    const saved = { ...channel(), notify: true, autoOpen: false };
    const f = fixture(t, { channels: [saved] });
    await f.open();
    const avatar = () => f.action().closest("li").querySelector("img");
    const first = avatar();
    assert.equal(first.src, saved.channelImageUrl);
    f.change({ [KEY]: [{ ...saved, autoOpen: true }] });
    assert.equal(avatar(), first);
    const image = "https://nng-phinf.pstatic.net/updated/profile.png";
    f.change({ [KEY]: [{ ...saved, channelImageUrl: image }] });
    assert.equal(avatar().src, image);
    assert.notEqual(avatar(), first);
    avatar().dispatchEvent(new f.w.Event("error"));
    assert.equal(avatar(), null);
    f.change({ [KEY]: [{ ...saved, channelImageUrl: image, autoOpen: true }] });
    assert.equal(avatar(), null, "failed image URLs do not reload on every render");
    assert.equal(f.requests.length, 0);
});

test("legacy registrations load missing profiles once with bounded concurrency and reuse the cache", async (t) => {
    const ids = [CHANNEL, SECOND, "c".repeat(32)];
    const f = fixture(t, {
        channels: ids.map((id) => ({ channelId: id, channelName: "이전 채널", notify: true, autoOpen: false })),
    });
    const replies = new Map();
    f.setFetch((url) => new Promise((resolve) => replies.set(url.split("/").pop(), resolve)));
    await f.open();
    assert.equal(f.requests.length, 2);
    replies.get(CHANNEL)({ code: 200, content: channel() });
    await waitForCondition(() => f.action().closest("li").querySelector("img"));
    await waitForCondition(() => replies.has(ids[2]));
    assert.equal(f.requests.length, 3);
    replies.get(SECOND)({ code: 200, content: channel(SECOND) });
    replies.get(ids[2])({ code: 200, content: channel(ids[2]) });
    await waitForCondition(() => f.panel().querySelectorAll("img").length === 3);
    f.trigger().click();
    await f.open();
    assert.equal(f.panel().querySelectorAll("img").length, 3);
    assert.equal(f.requests.length, 3);
    assert.equal(f.sent.length, 0, "profile loading does not change channel actions");
});

test("closing cancels legacy profile lookups and mismatched replies never supply a photo", async (t) => {
    const f = fixture(t, {
        channels: [{ channelId: CHANNEL, channelName: "이전 채널", notify: true, autoOpen: false }],
    });
    let reply;
    f.setFetch(
        () =>
            new Promise((resolve) => {
                reply = resolve;
            })
    );
    await f.open();
    const oldReply = reply;
    f.trigger().click();
    assert.equal(f.requests[0].signal.aborted, true);
    oldReply({ code: 200, content: channel() });
    await new Promise(setImmediate);
    await f.open();
    assert.equal(f.requests.length, 2);
    reply({ code: 200, content: channel(SECOND) });
    await new Promise(setImmediate);
    assert.equal(f.panel().querySelector("img"), null);
    assert.equal(f.action().disabled, false);
    assert.equal(f.requests.length, 2, "a failed profile does not trigger an automatic retry loop");
});

test("registered channels synchronize with settings and keep global options and auto-open", async (t) => {
    const saved = { ...channel(), notify: true, autoOpen: true };
    const f = fixture(t, { enabled: false, channels: [saved] });
    await f.open();
    assert.match(f.panel().textContent, /전체 데스크톱 알림·자동 입장 기능이 꺼져/);
    f.action().click();
    assert.equal(f.action().getAttribute("aria-pressed"), "false");
    assert.equal(f.action(CHANNEL, "autoOpen").getAttribute("aria-pressed"), "true");
    assert.equal(f.chrome.testState.local[KEY][0].autoOpen, true);
    assert.equal(f.chrome.testState.sync.liveStartNotificationsEnabled, false);
    f.change({ [KEY]: [saved] });
    assert.ok(f.action());
    await f.search();
    f.change({ [KEY]: [{ ...saved, notify: false }] });
    assert.equal(f.action().getAttribute("aria-pressed"), "false");
    f.type("");
    assert.equal(f.action().getAttribute("aria-pressed"), "false");
    assert.equal(f.action(CHANNEL, "autoOpen").getAttribute("aria-pressed"), "true");
});
test("desktop notifications and automatic entry can each register a channel and preserve the other selection", async (t) => {
    const f = fixture(t, { enabled: false });
    await f.open();
    await f.search();
    for (const key of ["notify", "autoOpen"])
        assert.equal(f.action(CHANNEL, key).getAttribute("aria-pressed"), "false");
    f.action(CHANNEL, "autoOpen").click();
    assert.deepEqual(f.sent[0], {
        type: "betterchzzk:live-start:channels",
        kind: "set-auto-open",
        channel: { channelId: CHANNEL, autoOpen: true },
    });
    assert.equal(f.action().getAttribute("aria-pressed"), "false");
    assert.equal(f.action(CHANNEL, "autoOpen").getAttribute("aria-pressed"), "true");
    f.type("");
    assert.ok(f.action(), "auto-entry-only channels stay in the registered list");
    f.action().click();
    assert.equal(f.action(CHANNEL, "autoOpen").getAttribute("aria-pressed"), "true");
    f.action(CHANNEL, "autoOpen").click();
    assert.equal(f.action().getAttribute("aria-pressed"), "true");
    f.action().click();
    assert.ok(f.action(), "turning off both retains the channel for later re-enabling");
    assert.equal(f.chrome.testState.sync.liveStartNotificationsEnabled, false);
    assert.equal(f.chrome.testState.sync.liveStartAutoOpenEnabled, undefined);
    assert.equal(f.chrome.testState.local[KEY][0].notify, false);
    assert.equal(f.chrome.testState.local[KEY][0].autoOpen, false);
});
test("search discards old responses on input edits, close, route change and hiding", async (t) => {
    const f = fixture(t);
    await f.open();
    const responses = [];
    f.setFetch(() => new Promise((resolve) => responses.push(resolve)));
    f.type("이전");
    f.submit();
    f.submit();
    assert.equal(f.requests.length, 1, "duplicate submit while pending is ignored");
    f.type("다음");
    assert.equal(f.requests[0].signal.aborted, true);
    f.submit();
    responses[1](searchResponse(channel(SECOND)));
    await waitForCondition(() => f.action(SECOND));
    responses[0](searchResponse(channel()));
    await new Promise(setImmediate);
    assert.equal(f.action(), null);
    for (const dismiss of [
        () => f.w.document.dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "Escape" })),
        () => f.navigate("/" + SECOND),
        () => f.change({ liveStartButtonEnabled: false }, "sync"),
    ]) {
        if (!f.panel()) await f.open();
        f.type("새 검색");
        f.submit();
        const index = f.requests.length - 1;
        dismiss();
        assert.equal(f.requests[index].signal.aborted, true);
        assert.equal(f.panel(), null);
        responses[index](searchResponse(channel()));
        await new Promise(setImmediate);
        assert.equal(f.panel(), null);
    }
    assert.equal(f.trigger(), null);
});
test("search handles empty, invalid and failed responses without inventing results", async (t) => {
    const f = fixture(t);
    await f.open();
    f.setFetch(async () => searchResponse());
    f.type("없음");
    f.submit();
    await waitForCondition(() => f.panel().textContent.includes("검색 결과가 없어요"));
    f.setFetch(async () => {
        throw new Error("network");
    });
    f.type("실패");
    f.submit();
    await waitForCondition(() => f.panel().textContent.includes("검색하지 못했어요"));
    f.setFetch(async () => ({ code: 200, content: {} }));
    f.type("형식");
    f.submit();
    await waitForCondition(() => f.panel().textContent.includes("검색하지 못했어요"));
    f.setFetch(async () =>
        searchResponse(
            channel(),
            channel(),
            { channelId: "../bad", channelName: "오류" },
            { ...channel(SECOND), channelName: "" },
            channel(SECOND),
            channel("c".repeat(32))
        )
    );
    await f.search();
    assert.equal(f.panel().querySelectorAll(".bcls-row").length, 2);
    assert.equal(f.action("c".repeat(32)), null, "results are bounded to the requested five entries");
});
test("display option removes UI and listeners without deleting registration and restores one button", async (t) => {
    const saved = { ...channel(), notify: true, autoOpen: true };
    const f = fixture(t, { channels: [saved] });
    await f.open();
    f.change({ liveStartButtonEnabled: false }, "sync");
    assert.equal(f.trigger(), null);
    assert.equal(f.panel(), null);
    assert.deepEqual(f.chrome.testState.local[KEY], [saved]);
    f.change({ liveStartButtonEnabled: true }, "sync");
    await f.open();
    assert.ok(f.action());
    f.w.document.getElementById(ID).remove();
    await waitForCondition(() => f.trigger());
    assert.equal(f.panel(), null);
    f.w.document.getElementById("header").outerHTML = header();
    await waitForCondition(() => f.trigger());
    assert.equal(f.w.document.querySelectorAll("#" + ID).length, 1);
    f.w.dispatchEvent(new f.w.Event("pagehide"));
    assert.equal(f.trigger(), null);
    f.w.dispatchEvent(new f.w.Event("pageshow"));
    await f.open();
    f.action().click();
    assert.equal(f.sent.length, 1);
});
test("disabled initial option and late header mounting do not create stray UI", async (t) => {
    const f = fixture(t, { visible: false, withHeader: false });
    await new Promise((resolve) => f.w.requestAnimationFrame(resolve));
    assert.equal(f.trigger(), null);
    f.w.document.body.insertAdjacentHTML("afterbegin", header());
    f.change({ liveStartButtonEnabled: true }, "sync");
    await f.open();
    assert.equal(f.requests.length, 0);
    f.w.document.body.dispatchEvent(new f.w.Event("pointerdown", { bubbles: true }));
    assert.equal(f.panel(), null);
    await f.open();
    f.w.document.dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "Escape" }));
    assert.equal(f.w.document.activeElement, f.trigger());
});
test("late save acknowledgements preserve newer storage and do not reopen panels", async (t) => {
    const f = fixture(t);
    await f.open();
    await f.search();
    let reply;
    f.setSend((_message, callback) => {
        reply = callback;
    });
    f.action().click();
    assert.equal(f.action().disabled, true);
    assert.equal(f.action(CHANNEL, "autoOpen").disabled, true);
    f.action().click();
    assert.equal(f.sent.length, 1);
    const saved = { ...channel(), notify: true, autoOpen: false };
    f.change({ [KEY]: [saved] });
    f.change({ [KEY]: [{ ...saved, notify: false }] });
    reply({ ok: true, channels: [saved] });
    assert.equal(f.action().getAttribute("aria-pressed"), "false");
    assert.match(f.message().textContent, /현재 저장된/);
    f.action().click();
    f.navigate("/lives");
    reply({ ok: true, channels: [saved] });
    assert.equal(f.panel(), null);
});
test("failed saves and runtime errors remain unregistered and unrelated DOM changes do not scan", async (t) => {
    const f = fixture(t);
    await f.open();
    await f.search();
    f.setSend((_message, callback) => callback({ ok: false, error: "채널은 최대 32개까지 등록할 수 있어요." }));
    f.action().click();
    assert.equal(f.action().getAttribute("aria-pressed"), "false");
    assert.match(f.message().textContent, /32개/);
    f.setSend((_message, callback) => {
        f.chrome.runtime.lastError = { message: "Worker unavailable" };
        callback();
        f.chrome.runtime.lastError = undefined;
    });
    f.action().click();
    assert.equal(f.action().disabled, false);
    assert.match(f.message().textContent, /저장하지 못했어요/);
    const doc = f.w.document,
        get = doc.getElementById.bind(doc);
    let scans = 0;
    doc.getElementById = (id) => {
        if (id === "header") scans++;
        return get(id);
    };
    const unrelated = doc.createElement("div");
    doc.getElementById("layout-body").append(unrelated);
    for (let i = 0; i < 30; i++) unrelated.append(doc.createElement("span"));
    await new Promise((resolve) => f.w.requestAnimationFrame(resolve));
    assert.equal(scans, 0);
});
