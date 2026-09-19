const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const {
    createDom,
    createFakeChrome,
    evalRepoScript,
    dispatch,
    queryOption,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

const CHANNEL = "a".repeat(32);
const SECOND = "b".repeat(32);
const CHANNELS = "betterchzzk:live-start-channels";
const STATE = "betterchzzk:live-start-state";
const STATUS = "betterchzzk:live-start-status";
const TYPE = "betterchzzk:live-start:channels";
const ALARM = "betterchzzk:live-start";
const clone = (value) => JSON.parse(JSON.stringify(value));
const rule = (id = CHANNEL) => ({ channelId: id, channelName: "테스트 방송", notify: true, autoOpen: true });
const snapshot = (id = 10, open = false, channelId = CHANNEL) => ({
    code: 200,
    content: {
        liveId: id,
        status: open ? "OPEN" : "CLOSE",
        liveTitle: "방송 제목",
        channel: { channelId, channelName: "테스트 방송" },
    },
});
function createEvent() {
    const listeners = [];
    return {
        addListener: (listener) => listeners.push(listener),
        emit: (...args) => listeners.forEach((fn) => fn(...args)),
        listeners,
    };
}
async function flush() {
    // All mocked extension callbacks use microtasks; setImmediate drains each event turn.
    for (let i = 0; i < 20; i++) await new Promise(setImmediate);
}

function monitor(options = {}) {
    const local = clone(options.local || { [CHANNELS]: [rule()] });
    const sync = { liveStartNotificationsEnabled: true, liveStartAutoOpenEnabled: true, ...options.sync };
    const changed = createEvent();
    const notifications = [];
    const opened = [];
    const focused = [];
    const requests = [];
    const alarms = new Map();
    let clock = 1000000;
    let response = snapshot();
    let fetcher = null;
    let granted = options.granted !== false;
    let failSet = false;
    let failNotification = false;
    let tabs = options.tabs || [];
    const runtime = {
        id: "test",
        lastError: null,
        getURL: (file) => `chrome-extension://test/${file}`,
        onStartup: createEvent(),
        onInstalled: createEvent(),
        onMessage: createEvent(),
    };
    function area(data, name) {
        return {
            get(keys, callback) {
                const result = {};
                for (const key of Array.isArray(keys) ? keys : [keys])
                    if (Object.hasOwn(data, key)) result[key] = clone(data[key]);
                queueMicrotask(() => callback(result));
            },
            set(values, callback) {
                queueMicrotask(() => {
                    if (failSet && Object.hasOwn(values, STATE)) {
                        runtime.lastError = { message: "storage failed" };
                        callback();
                        runtime.lastError = null;
                        return;
                    }
                    const changes = {};
                    for (const [key, value] of Object.entries(values)) {
                        if (JSON.stringify(data[key]) !== JSON.stringify(value))
                            changes[key] = { oldValue: data[key], newValue: clone(value) };
                        data[key] = clone(value);
                    }
                    callback?.();
                    if (Object.keys(changes).length) changed.emit(changes, name);
                });
            },
        };
    }
    const chrome = {
        runtime,
        storage: { local: area(local, "local"), sync: area(sync, "sync"), onChanged: changed },
        permissions: { contains: async () => granted, onAdded: createEvent(), onRemoved: createEvent() },
        alarms: {
            onAlarm: createEvent(),
            get: async (name) => alarms.get(name),
            create: async (name, info) => alarms.set(name, clone(info)),
            clear: async (name) => alarms.delete(name),
        },
        notifications: {
            onClicked: createEvent(),
            clear: async () => true,
            create: async (id, info) => {
                if (failNotification) throw new Error("notification failed");
                notifications.push({ id, ...clone(info) });
            },
        },
        tabs: {
            query: async () => clone(tabs),
            create: async (info) => {
                opened.push(clone(info));
                tabs.push({ id: opened.length, windowId: 1, ...info });
            },
            update: async (id, info) => focused.push({ id, ...info }),
        },
        windows: { update: async () => {} },
    };
    const notificationApi = chrome.notifications;
    if (options.notificationsUnavailable) delete chrome.notifications;
    class Clock extends Date {
        static now() {
            return clock;
        }
    }
    const context = vm.createContext({
        chrome,
        console: { warn() {} },
        URL,
        AbortController,
        setTimeout,
        clearTimeout,
        Date: Clock,
        fetch: async (url, init) => {
            requests.push({ url, signal: init.signal });
            const json = fetcher ? await fetcher(url, init) : response;
            return { ok: true, json: async () => clone(json) };
        },
    });
    for (const file of ["shared/settings.js", "shared/data.js", "shared/liveStart.js", "shared/liveStartMonitor.js"]) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context, { filename: file });
    }
    return {
        chrome,
        local,
        sync,
        alarms,
        notifications,
        opened,
        focused,
        requests,
        model: context.BetterChzzkLiveStart,
        enableNotificationsApi: () => {
            chrome.notifications = notificationApi;
        },
        setResponse: (next) => {
            response = next;
        },
        setFetch: (next) => {
            fetcher = next;
        },
        setTabs: (next) => {
            tabs = next;
        },
        failStorage: (next) => {
            failSet = next;
        },
        failNotification: (next) => {
            failNotification = next;
        },
        async tick() {
            clock += 60000;
            chrome.alarms.onAlarm.emit({ name: ALARM });
            await flush();
        },
        async options(values) {
            await new Promise((resolve) => chrome.storage.sync.set(values, resolve));
            await flush();
        },
        async rules(values) {
            await new Promise((resolve) => chrome.storage.local.set({ [CHANNELS]: values }, resolve));
            await flush();
        },
        async permission(value) {
            granted = value;
            chrome.permissions[value ? "onAdded" : "onRemoved"].emit({ permissions: ["notifications"] });
            await flush();
        },
        send(kind, channel, sender = { id: "test", url: "chrome-extension://test/options.html" }) {
            return new Promise((resolve) =>
                chrome.runtime.onMessage.emit({ type: TYPE, kind, channel }, sender, resolve)
            );
        },
    };
}

test("channel input and API status require verified channel identity and live IDs", async () => {
    const m = monitor({ sync: { liveStartNotificationsEnabled: false, liveStartAutoOpenEnabled: false } });
    await flush();
    assert.equal(m.model.parseChannelId(`https://chzzk.naver.com/live/${CHANNEL}?x=1`), CHANNEL);
    assert.equal(m.model.parseChannelId(`https://chzzk.naver.com.evil.example/${CHANNEL}`), "");
    assert.equal(m.model.parseChannelId(`https://name@chzzk.naver.com/${CHANNEL}`), "");
    assert.equal(m.model.parseChannelId(`https://chzzk.naver.com/video/${CHANNEL}`), "");
    assert.equal(m.model.parseSnapshot(snapshot(10, true, SECOND), CHANNEL), null);
    assert.equal(m.model.parseSnapshot(snapshot(null, true), CHANNEL), null);
    assert.deepEqual(clone(m.model.normalizeChannels([{ channelId: [CHANNEL] }])), []);
    assert.equal(m.alarms.size, 0);
    assert.equal(m.requests.length, 0);
});

test("first observation is silent; each new broadcast notifies and opens a background tab once", async () => {
    const m = monitor();
    m.setResponse(snapshot(10, true));
    await flush();
    assert.equal(m.notifications.length, 0);
    assert.equal(m.alarms.get(ALARM).periodInMinutes, 1);
    m.setResponse(snapshot(11, true));
    await m.tick();
    assert.equal(m.notifications.length, 1);
    assert.deepEqual(m.opened, [{ url: `https://chzzk.naver.com/live/${CHANNEL}`, active: false }]);
    m.setTabs([]);
    await m.tick();
    m.setResponse(snapshot(11, false));
    await m.tick();
    m.setResponse(snapshot(11, true));
    await m.tick();
    assert.equal(m.notifications.length, 1);
    assert.equal(m.opened.length, 1, "closing a tab does not reopen the same broadcast");
    const restart = monitor({ local: m.local });
    restart.setResponse(snapshot(11, true));
    await flush();
    await restart.tick();
    assert.equal(restart.notifications.length, 0, "worker restart preserves deduplication");
});

test("offline to online detection, title changes and existing waiting tabs", async () => {
    const m = monitor({
        tabs: [{ id: 7, windowId: 1, url: `https://chzzk.naver.com/live/${CHANNEL}?from=following` }],
    });
    await flush();
    m.setResponse(snapshot(11, true));
    await m.tick();
    assert.equal(m.notifications.length, 1);
    assert.equal(m.opened.length, 0);
    assert.equal(m.focused.length, 0);
    const changedTitle = snapshot(11, true);
    changedTitle.content.liveTitle = "변경한 제목";
    m.setResponse(changedTitle);
    await m.tick();
    assert.equal(m.notifications.length, 1);
    m.chrome.notifications.onClicked.emit(m.notifications[0].id);
    await flush();
    assert.deepEqual(m.focused, [{ id: 7, active: true }]);
    m.chrome.notifications.onClicked.emit("unrelated");
    await flush();
    assert.equal(m.focused.length, 1);
});

test("failed or mismatched API replies never establish offline or a new broadcast", async () => {
    const m = monitor();
    await flush();
    m.setResponse({ code: 200, content: null });
    await m.tick();
    m.setResponse(snapshot(11, true, SECOND));
    await m.tick();
    assert.equal(m.notifications.length, 0);
    assert.ok(m.local[STATUS].error);
    m.setResponse(snapshot(11, true));
    await m.tick();
    assert.equal(m.notifications.length, 1);
    assert.equal(m.local[STATUS].error, "");
});

test("notification permission and auto-open remain independent, revocation and re-enable rebaseline", async () => {
    const m = monitor({ granted: false });
    await flush();
    m.setResponse(snapshot(11, true));
    await m.tick();
    assert.equal(m.notifications.length, 0);
    assert.equal(m.opened.length, 1);
    await m.permission(true);
    assert.equal(m.notifications.length, 0);
    m.setResponse(snapshot(12, true));
    await m.tick();
    assert.equal(m.notifications.length, 1);
    await m.permission(false);
    m.setResponse(snapshot(13, true));
    await m.tick();
    assert.equal(m.notifications.length, 1);
    await m.options({ liveStartAutoOpenEnabled: false });
    assert.equal(m.alarms.size, 0);
});

test("turning off a feature aborts requests and suppresses late response side effects", async () => {
    const m = monitor();
    await flush();
    let finish;
    m.setFetch(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            })
    );
    await m.tick();
    assert.equal(typeof finish, "function");
    const disable = m.options({ liveStartAutoOpenEnabled: false, liveStartNotificationsEnabled: false });
    await flush();
    assert.equal(m.requests.at(-1).signal.aborted, true);
    finish(snapshot(11, true));
    await disable;
    await flush();
    assert.equal(m.notifications.length, 0);
    assert.equal(m.opened.length, 0);
    assert.equal(m.alarms.size, 0);
    assert.deepEqual(m.local[STATE].channels, {});
});

test("overlapping alarms coalesce and channel queries are bounded to two", async () => {
    const m = monitor({ local: { [CHANNELS]: [rule(), rule(SECOND), rule("c".repeat(32))] } });
    const pending = [];
    m.setFetch(
        (url) => new Promise((resolve) => pending.push(() => resolve(snapshot(10, false, url.split("/").at(-2)))))
    );
    await flush();
    assert.equal(m.requests.length, 2);
    for (let i = 0; i < 10; i++) m.chrome.alarms.onAlarm.emit({ name: ALARM });
    pending.shift()();
    await flush();
    assert.equal(m.requests.length, 3);
    for (const resolve of pending) resolve();
    await flush();
    assert.equal(m.requests.length, 3);
});

test("browser startup rebaselines even when a baseline request initially fails", async () => {
    const m = monitor();
    await flush();
    m.setResponse({ code: 503 });
    m.chrome.runtime.onStartup.emit();
    await flush();
    m.setResponse(snapshot(11, true));
    await m.tick();
    assert.equal(m.notifications.length, 0);
    m.setResponse(snapshot(12, true));
    await m.tick();
    assert.equal(m.notifications.length, 1);
});

test("state persistence failure prevents effects; notification failure does not stop auto-open", async () => {
    const m = monitor();
    await flush();
    m.failStorage(true);
    m.setResponse(snapshot(11, true));
    await m.tick();
    assert.equal(m.notifications.length, 0);
    assert.equal(m.opened.length, 0);
    m.failStorage(false);
    m.failNotification(true);
    await m.tick();
    assert.equal(m.opened.length, 1);
    assert.ok(m.local[STATUS].error);
    m.failNotification(false);
    await m.tick();
    assert.equal(m.notifications.length, 0, "failed effects are not repeated for a consumed live ID");
});

test("channel mutations serialize, reject untrusted senders, and remove stale polling state", async () => {
    const m = monitor();
    await flush();
    assert.equal((await m.send("add", rule(SECOND), { id: "other", url: "https://chzzk.naver.com" })).ok, false);
    const results = await Promise.all([
        m.send("add", rule(SECOND)),
        m.send("update", { channelId: CHANNEL, autoOpen: false }),
    ]);
    assert.ok(results.every((result) => result.ok));
    assert.equal(m.local[CHANNELS].length, 2);
    assert.equal(m.local[CHANNELS][0].autoOpen, false);
    await m.send("remove", { channelId: CHANNEL });
    await flush();
    assert.equal(m.local[STATE].channels[CHANNEL], undefined);
    assert.equal((await m.send("add", rule(SECOND))).ok, false);
});

test("a channel page can register notifications with a verified name without enabling global options", async () => {
    const m = monitor({ local: {}, sync: { liveStartNotificationsEnabled: false, liveStartAutoOpenEnabled: false } });
    await flush();
    m.setFetch(async (url) => {
        assert.equal(url, `https://api.chzzk.naver.com/service/v1/channels/${CHANNEL}`);
        return { code: 200, content: { channelId: CHANNEL, channelName: "확인된 채널" } };
    });
    const sender = { id: "test", tab: { id: 1 }, frameId: 0, url: `https://chzzk.naver.com/live/${CHANNEL}` };
    const replies = await Promise.all([
        m.send(
            "set-notify",
            { channelId: CHANNEL, notify: true, channelName: "믿지 않는 이름", autoOpen: true },
            sender
        ),
        m.send("set-notify", { channelId: CHANNEL, notify: true }, sender),
    ]);
    assert.ok(replies.every((reply) => reply.ok));
    assert.deepEqual(m.local[CHANNELS], [
        { channelId: CHANNEL, channelName: "확인된 채널", notify: true, autoOpen: false },
    ]);
    assert.equal(m.requests.length, 1, "concurrent registrations reuse the saved channel instead of fetching twice");
    assert.equal(m.sync.liveStartNotificationsEnabled, false);
    assert.equal(m.sync.liveStartAutoOpenEnabled, false);
    await m.send("update", { channelId: CHANNEL, autoOpen: true });
    const result = await m.send(
        "set-notify",
        { channelId: CHANNEL, notify: false },
        {
            ...sender,
            url: `https://chzzk.naver.com/${CHANNEL}/videos`,
        }
    );
    assert.equal(result.ok, true);
    assert.equal(m.local[CHANNELS][0].notify, false);
    assert.equal(m.local[CHANNELS][0].autoOpen, true);
});

test("registration preserves verified profile images through normalization and later edits", async () => {
    const m = monitor({ local: {}, sync: { liveStartNotificationsEnabled: false, liveStartAutoOpenEnabled: false } });
    await flush();
    const image = "https://nng-phinf.pstatic.net/channel/profile.png";
    m.setFetch(async () => ({
        code: 200,
        content: { channelId: CHANNEL, channelName: "사진 채널", channelImageUrl: image },
    }));
    const sender = { id: "test", tab: { id: 1 }, frameId: 0, url: "https://chzzk.naver.com/" };
    assert.equal(
        (
            await m.send(
                "set-notify",
                { channelId: CHANNEL, notify: true, channelImageUrl: "https://evil.example/fake.png" },
                sender
            )
        ).ok,
        true
    );
    assert.equal(m.local[CHANNELS][0].channelImageUrl, image);
    await m.send("update", { channelId: CHANNEL, autoOpen: true });
    assert.equal(m.local[CHANNELS][0].channelImageUrl, image);
    assert.equal((await m.send("add", { ...rule(SECOND), channelImageUrl: image })).ok, true);
    assert.equal(m.local[CHANNELS][1].channelImageUrl, image);
    assert.equal(
        m.model.normalizeChannels([{ ...rule(), channelImageUrl: "https://evil.example/fake.png" }])[0].channelImageUrl,
        undefined
    );
    assert.deepEqual(clone(m.model.normalizeChannels([rule()])), [rule()], "legacy entries remain valid");
});

test("page registration independently saves auto-open and notification selections in the same queue", async () => {
    const m = monitor({ local: {}, sync: { liveStartNotificationsEnabled: false, liveStartAutoOpenEnabled: false } });
    await flush();
    m.setFetch(async () => ({ code: 200, content: { channelId: CHANNEL, channelName: "확인된 채널" } }));
    const sender = { id: "test", tab: { id: 1 }, frameId: 0, url: "https://chzzk.naver.com/" };
    assert.equal((await m.send("set-auto-open", { channelId: CHANNEL, autoOpen: false }, sender)).ok, true);
    assert.deepEqual(m.local[CHANNELS], []);
    const added = await m.send("set-auto-open", { channelId: CHANNEL, autoOpen: true, notify: true }, sender);
    assert.equal(added.ok, true);
    assert.deepEqual(m.local[CHANNELS], [
        { channelId: CHANNEL, channelName: "확인된 채널", notify: false, autoOpen: true },
    ]);
    const replies = await Promise.all([
        m.send("set-notify", { channelId: CHANNEL, notify: true }, sender),
        m.send("set-auto-open", { channelId: CHANNEL, autoOpen: false }, sender),
    ]);
    assert.ok(replies.every((reply) => reply.ok));
    assert.equal(m.local[CHANNELS][0].notify, true);
    assert.equal(m.local[CHANNELS][0].autoOpen, false);
    assert.equal(m.requests.length, 1);
    assert.equal(m.sync.liveStartNotificationsEnabled, false);
    assert.equal(m.sync.liveStartAutoOpenEnabled, false);
});

test("page registration follows the clicked channel even when the sender retains an earlier SPA URL", async () => {
    for (const url of ["https://chzzk.naver.com/", `https://chzzk.naver.com/live/${SECOND}`]) {
        const m = monitor({
            local: { [CHANNELS]: [{ ...rule(SECOND), notify: false }] },
            sync: { liveStartNotificationsEnabled: false, liveStartAutoOpenEnabled: false },
        });
        await flush();
        m.setFetch(async () => ({ code: 200, content: { channelId: CHANNEL, channelName: "선택한 채널" } }));
        const sender = { id: "test", tab: { id: 1 }, frameId: 0, url };
        const registered = await m.send("set-notify", { channelId: CHANNEL, notify: true }, sender);
        assert.equal(registered.ok, true);
        assert.deepEqual(m.local[CHANNELS], [
            { ...rule(SECOND), notify: false },
            { channelId: CHANNEL, channelName: "선택한 채널", notify: true, autoOpen: false },
        ]);
        assert.equal(m.requests.length, 1);
        const removed = await m.send("set-notify", { channelId: CHANNEL, notify: false }, sender);
        assert.equal(removed.ok, true);
        assert.equal(m.local[CHANNELS][1].notify, false);
        assert.equal(m.requests.length, 1);
    }
});

test("page registration rejects other origins, frames, invalid channels and mutation kinds", async () => {
    const m = monitor({ local: {}, sync: { liveStartNotificationsEnabled: false, liveStartAutoOpenEnabled: false } });
    await flush();
    const sender = { id: "test", tab: { id: 1 }, frameId: 0, url: `https://chzzk.naver.com/${CHANNEL}` };
    for (const invalid of [
        { ...sender, id: "other" },
        { ...sender, url: `https://evil.example/${CHANNEL}` },
        { ...sender, url: `https://chzzk.naver.com.evil.example/${CHANNEL}` },
        { ...sender, url: `http://chzzk.naver.com/${CHANNEL}` },
        { ...sender, url: CHANNEL },
        { ...sender, frameId: 2 },
        { ...sender, tab: undefined },
    ]) {
        assert.equal((await m.send("set-notify", { channelId: CHANNEL, notify: true }, invalid)).ok, false);
        assert.equal((await m.send("set-auto-open", { channelId: CHANNEL, autoOpen: true }, invalid)).ok, false);
        assert.equal((await m.send("remove", { channelId: CHANNEL }, invalid)).ok, false);
    }
    assert.equal((await m.send("add", rule(), sender)).ok, false);
    assert.equal((await m.send("update", { channelId: CHANNEL, autoOpen: true }, sender)).ok, false);
    assert.equal((await m.send("set-notify", { channelId: CHANNEL, notify: "true" }, sender)).ok, false);
    assert.equal((await m.send("set-auto-open", { channelId: CHANNEL, autoOpen: "true" }, sender)).ok, false);
    for (const channelId of ["", "../channels", "z".repeat(32), [CHANNEL]]) {
        assert.equal((await m.send("set-notify", { channelId, notify: true }, sender)).ok, false);
        assert.equal((await m.send("set-auto-open", { channelId, autoOpen: true }, sender)).ok, false);
        assert.equal((await m.send("remove", { channelId }, sender)).ok, false);
    }
    assert.equal(m.local[CHANNELS], undefined);
    assert.equal(m.requests.length, 0);
});

test("the trusted page can unregister a channel and stop both live-start actions", async () => {
    const m = monitor();
    await flush();
    const sender = { id: "test", tab: { id: 1 }, frameId: 0, url: "https://chzzk.naver.com/" };
    const reply = await m.send("remove", { channelId: CHANNEL }, sender);
    assert.equal(reply.ok, true);
    await flush();
    assert.deepEqual(m.local[CHANNELS], []);
    assert.equal(m.local[STATE].channels[CHANNEL], undefined);
    assert.equal(m.alarms.size, 0);
    m.setResponse(snapshot(11, true));
    await m.tick();
    assert.equal(m.notifications.length, 0);
    assert.equal(m.opened.length, 0);
    assert.equal(m.sync.liveStartNotificationsEnabled, true);
    assert.equal(m.sync.liveStartAutoOpenEnabled, true);
});

test("page registration preserves the list on failed lookups and skips the already running broadcast", async () => {
    const m = monitor({ local: {}, sync: { liveStartAutoOpenEnabled: false } });
    await flush();
    const sender = { id: "test", tab: { id: 1 }, frameId: 0, url: `https://chzzk.naver.com/${CHANNEL}` };
    m.setFetch(async () => ({ code: 200, content: { channelId: SECOND, channelName: "다른 채널" } }));
    assert.equal((await m.send("set-notify", { channelId: CHANNEL, notify: true }, sender)).ok, false);
    assert.equal(m.local[CHANNELS], undefined);
    let liveId = 11;
    m.setFetch(async (url) =>
        url.endsWith("/live-detail")
            ? snapshot(liveId, true)
            : { code: 200, content: { channelId: CHANNEL, channelName: "확인된 채널" } }
    );
    assert.equal((await m.send("set-notify", { channelId: CHANNEL, notify: true }, sender)).ok, true);
    await flush();
    assert.equal(m.notifications.length, 0);
    liveId = 12;
    await m.tick();
    assert.equal(m.notifications.length, 1);
});

test("page registration enforces the channel limit and does not acknowledge failed storage", async () => {
    const sender = { id: "test", tab: { id: 1 }, frameId: 0, url: `https://chzzk.naver.com/live/${CHANNEL}` };
    const full = Array.from({ length: 32 }, (_, index) => rule(index.toString(16).padStart(32, "0")));
    const limited = monitor({
        local: { [CHANNELS]: full },
        sync: { liveStartNotificationsEnabled: false, liveStartAutoOpenEnabled: false },
    });
    await flush();
    const rejected = await limited.send("set-notify", { channelId: CHANNEL, notify: true }, sender);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /32개/);
    assert.equal(limited.requests.length, 0);
    assert.deepEqual(limited.local[CHANNELS], full);
    const m = monitor({ local: {}, sync: { liveStartNotificationsEnabled: false, liveStartAutoOpenEnabled: false } });
    await flush();
    m.setFetch(async () => ({ code: 200, content: { channelId: CHANNEL, channelName: "확인된 채널" } }));
    const save = m.chrome.storage.local.set;
    m.chrome.storage.local.set = (values, callback) => {
        if (!Object.hasOwn(values, CHANNELS)) return save(values, callback);
        queueMicrotask(() => {
            m.chrome.runtime.lastError = { message: "storage failed" };
            callback();
            m.chrome.runtime.lastError = null;
        });
    };
    assert.equal((await m.send("set-notify", { channelId: CHANNEL, notify: true }, sender)).ok, false);
    assert.equal(m.local[CHANNELS], undefined);
});

test("live-start controls have their own accessible options tab", async (t) => {
    const chrome = createFakeChrome();
    const dom = createDom("options.html", "options.html", chrome);
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    const doc = dom.window.document;
    const tab = doc.querySelector('[role="tab"][aria-label="방송 알림"]');
    assert.ok(tab);
    const panel = doc.getElementById(tab.getAttribute("aria-controls"));
    assert.equal(panel.getAttribute("aria-labelledby"), tab.id);
    for (const key of ["liveStartNotificationsEnabled", "liveStartAutoOpenEnabled", "liveStartButtonEnabled"]) {
        assert.equal(doc.querySelectorAll(`[data-option="${key}"]`).length, 1);
        assert.ok(panel.contains(queryOption(doc, key)));
    }
    assert.ok(panel.contains(doc.getElementById("liveStartChannels")));
    await waitForCondition(() => queryOption(doc, "liveStartButtonEnabled").checked);
    assert.equal(queryOption(doc, "liveStartButtonEnabled").checked, true);
    assert.equal(queryOption(doc, "liveStartButtonEnabled").disabled, false);
    tab.click();
    assert.equal(tab.getAttribute("aria-selected"), "true");
    assert.equal(panel.classList.contains("is-active"), true);
    tab.focus();
    tab.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    assert.notEqual(doc.activeElement, tab);
    assert.equal(doc.activeElement.getAttribute("role"), "tab");
});

test("hiding the registration button leaves monitoring and channel rules active", async () => {
    const m = monitor({ sync: { liveStartButtonEnabled: false } });
    await flush();
    m.setResponse(snapshot(11, true));
    await m.tick();
    assert.equal(m.notifications.length, 1);
    assert.equal(m.opened.length, 1);
    assert.deepEqual(m.local[CHANNELS], [rule()]);
});

test("rapid disable and re-enable keeps the next observation silent", async () => {
    const m = monitor();
    await flush();
    m.setResponse(snapshot(11, true));
    m.chrome.storage.sync.set({ liveStartNotificationsEnabled: false, liveStartAutoOpenEnabled: false });
    m.chrome.storage.sync.set({ liveStartNotificationsEnabled: true, liveStartAutoOpenEnabled: true });
    await flush();
    assert.equal(m.notifications.length, 0);
    assert.equal(m.opened.length, 0);
    m.setResponse(snapshot(12, true));
    await m.tick();
    assert.equal(m.notifications.length, 1);
    assert.equal(m.opened.length, 1);
});

test("a concurrent settings event cannot lose the browser-start baseline", async () => {
    const m = monitor();
    await flush();
    m.setResponse(snapshot(11, true));
    m.chrome.runtime.onStartup.emit();
    m.chrome.storage.local.set({ [CHANNELS]: [{ ...rule(), channelName: "새 이름" }] });
    await flush();
    assert.equal(m.notifications.length, 0);
    assert.equal(m.opened.length, 0);
});

test("notification click listener is installed once after optional API becomes available", async () => {
    const m = monitor({ granted: false, notificationsUnavailable: true });
    await flush();
    m.enableNotificationsApi();
    await m.permission(true);
    await m.permission(false);
    await m.permission(true);
    m.setResponse(snapshot(11, true));
    await m.tick();
    m.chrome.notifications.onClicked.emit(m.notifications[0].id);
    await flush();
    assert.equal(m.focused.length, 1);
});

for (const granted of [true, false]) {
    test(`options requests notification permission in save gesture (${granted})`, async (t) => {
        const chrome = createFakeChrome({ permissionGranted: granted });
        const dom = createDom("options.html", "options.html", chrome);
        t.after(() => dom.window.close());
        evalRepoScript(dom, "shared", "settings.js");
        evalRepoScript(dom, "options.js");
        await waitForCondition(() => !queryOption(dom.window.document, "liveStartNotificationsEnabled").disabled);
        const toggle = queryOption(dom.window.document, "liveStartNotificationsEnabled");
        toggle.checked = true;
        dispatch(dom, toggle, "change");
        queryOption(dom.window.document, "liveStartAutoOpenEnabled").checked = true;
        dom.window.document.getElementById("save").click();
        assert.deepEqual(clone(chrome.testState.permissionRequests), [{ permissions: ["notifications"] }]);
        await waitForCondition(() => dom.window.document.getElementById("notice").dataset.state !== "saving");
        assert.equal(Boolean(chrome.testState.sync.liveStartNotificationsEnabled), granted);
        assert.equal(toggle.checked, granted);
    });
}

test("channel editor validates, adds, toggles, deletes and reports failed saves without corrupting UI", async (t) => {
    const m = monitor({ local: {}, sync: { liveStartNotificationsEnabled: false, liveStartAutoOpenEnabled: false } });
    await flush();
    m.chrome.runtime.sendMessage = (message, callback) => {
        void m.send(message.kind, message.channel).then(callback);
    };
    const dom = createDom("options.html", "options.html", m.chrome);
    t.after(() => dom.window.close());
    for (const file of [
        ["shared", "settings.js"],
        ["options.js"],
        ["shared", "data.js"],
        ["shared", "liveStart.js"],
        ["optionsLiveStart.js"],
    ])
        evalRepoScript(dom, ...file);
    const doc = dom.window.document;
    const input = doc.getElementById("liveStartChannelInput");
    await waitForCondition(() => !input.disabled);
    input.value = "https://evil.example/channel";
    doc.getElementById("liveStartChannelAdd").click();
    assert.match(doc.getElementById("liveStartChannelMessage").textContent, /주소 또는/);
    dom.window.fetch = async () => ({
        ok: true,
        json: async () => ({
            code: 200,
            content: { channelId: CHANNEL, channelName: "아주 긴 한글 채널 이름 테스트" },
        }),
    });
    input.value = `https://chzzk.naver.com/live/${CHANNEL}`;
    doc.getElementById("liveStartChannelAdd").click();
    await waitForCondition(() => doc.querySelector('[data-action="autoOpen"]') && !input.disabled);
    assert.equal(m.local[CHANNELS][0].autoOpen, false);
    const toggle = doc.querySelector('[data-action="autoOpen"]');
    toggle.checked = true;
    dispatch(dom, toggle, "change");
    await waitForCondition(() => m.local[CHANNELS][0].autoOpen && !input.disabled);
    const sendMessage = m.chrome.runtime.sendMessage;
    m.chrome.runtime.sendMessage = (_message, callback) =>
        callback({ ok: false, error: "채널 설정을 저장하지 못했어요." });
    const savedToggle = doc.querySelector('[data-action="autoOpen"]');
    savedToggle.checked = false;
    dispatch(dom, savedToggle, "change");
    await waitForCondition(() => !input.disabled);
    assert.equal(doc.querySelector('[data-action="autoOpen"]').checked, true);
    assert.match(doc.getElementById("liveStartChannelMessage").textContent, /저장하지 못했어요/);
    m.chrome.runtime.sendMessage = sendMessage;
    const search = doc.getElementById("settingsSearch");
    search.value = "데스크톱";
    dispatch(dom, search, "input");
    assert.equal(doc.getElementById("liveStartChannels").classList.contains("search-miss"), false);
    assert.equal(
        queryOption(doc, "liveStartAutoOpenEnabled").closest(".toggle-row").classList.contains("search-miss"),
        false
    );
    doc.querySelector('[data-action="remove"]').click();
    await waitForCondition(() => !m.local[CHANNELS].length && !input.disabled);
    assert.match(doc.getElementById("liveStartChannelList").textContent, /등록한 채널이 없어요/);
});
