const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { evalRepoScript, evalFeatureModules } = require("./helpers/extension-page-fixture.js");

function fixture(t, feature, pathname, overrides = {}) {
    const dom = new JSDOM("<body></body>", {
        url: `https://chzzk.naver.com${pathname}`,
        runScripts: "outside-only",
    });
    t.after(() => dom.window.close());
    const { window } = dom;
    let now = 10000;
    let nextId = 0;
    const timers = new Map();
    const frames = new Map();
    window.performance.now = () => now;
    window.setTimeout = (callback, delay) => {
        const id = ++nextId;
        timers.set(id, { callback, at: now + delay });
        return id;
    };
    window.clearTimeout = (id) => timers.delete(id);
    window.requestAnimationFrame = (callback) => {
        const id = ++nextId;
        frames.set(id, callback);
        return id;
    };
    window.cancelAnimationFrame = (id) => frames.delete(id);
    for (const file of ["shared/settings.js", "shared/data.js", "content.js", "shared/vodTimeline.js"]) {
        evalRepoScript(dom, file);
    }
    let applyOptions;
    let observer;
    let disconnected = false;
    Object.assign(window.BetterChzzk.utils, {
        bindFeatureOptions(callback) {
            applyOptions = callback;
        },
        onReady() {},
        startPageChangeDetection: () => () => {},
        startStorageChangeListener: () => () => {},
        createMutationObserverSync(config) {
            observer = config;
            return { disconnect: () => (disconnected = true) };
        },
        fetchJson() {
            assert.fail("an unmounted feature must not fetch data");
        },
    });
    evalFeatureModules(dom, feature);
    evalRepoScript(dom, `features/${feature}.js`);
    const options = window.BetterChzzkSettings.normalizeOptions({
        monthlyBroadcastTimeWatchEnabled: false,
        ...overrides,
    });
    applyOptions(options);
    assert.ok(observer, "the enabled feature installs its observer");
    let scans = 0;
    for (const method of ["querySelector", "querySelectorAll", "getElementById"]) {
        const original = window.document[method].bind(window.document);
        window.document[method] = (...args) => {
            scans++;
            return original(...args);
        };
    }
    return {
        dom,
        frames,
        timers,
        scans: () => scans,
        schedule: () => observer.schedule(),
        disable() {
            applyOptions({ ...options, [`${feature}Enabled`]: false, globalLiveCountEnabled: false });
            assert.equal(disconnected, true);
        },
        async frame() {
            const pending = [...frames.values()];
            frames.clear();
            for (const callback of pending) callback(now);
            await new Promise((resolve) => setImmediate(resolve));
        },
        nextTimer() {
            const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
            timers.delete(id);
            now = timer.at;
            timer.callback();
        },
    };
}

test("throttled DOM scheduling cancels timers and frames, ignores stale callbacks and permits restarting", (t) => {
    const dom = new JSDOM("<body></body>", { url: "https://chzzk.naver.com/lives", runScripts: "outside-only" });
    t.after(() => dom.window.close());
    const { window } = dom;
    let now = 0;
    let id = 0;
    let calls = 0;
    const timers = new Map();
    const frames = new Map();
    window.performance.now = () => now;
    window.setTimeout = (callback) => {
        const key = ++id;
        timers.set(key, callback);
        return key;
    };
    window.clearTimeout = (key) => timers.delete(key);
    window.requestAnimationFrame = (callback) => {
        const key = ++id;
        frames.set(key, callback);
        return key;
    };
    window.cancelAnimationFrame = (key) => frames.delete(key);
    for (const file of ["shared/settings.js", "shared/data.js", "content.js"]) evalRepoScript(dom, file);
    const schedule = window.BetterChzzk.utils.createThrottledDomSync(() => calls++, 160);
    schedule();
    const staleTimer = [...timers.values()][0];
    assert.equal(timers.size, 1);
    schedule.cancel();
    assert.equal(timers.size, 0);
    now = 1000;
    schedule();
    const staleFrame = [...frames.values()][0];
    staleTimer();
    assert.equal(frames.size, 1, "an old timer cannot append to the new scheduled work");
    schedule.cancel();
    assert.equal(frames.size, 0);
    schedule();
    staleFrame();
    assert.equal(calls, 0);
    assert.equal(frames.size, 1, "a stale frame cannot clear a new reservation");
    const current = [...frames.values()][0];
    frames.clear();
    current();
    assert.equal(calls, 1);
    schedule();
    assert.equal(timers.size, 1);
    schedule.cancel();
    assert.equal(timers.size, 0);
});

test("count-only teardown immediately clears its pending timer and frame", async (t) => {
    const f = fixture(t, "categoryTools", "/lives", { categoryToolsEnabled: false, globalLiveCountEnabled: true });
    assert.equal(f.frames.size, 1);
    await f.frame();
    f.schedule();
    assert.equal(f.timers.size, 1);
    f.disable();
    assert.equal(f.timers.size, 0);
    assert.equal(f.frames.size, 0);
});

for (const [feature, pathname, overrides = {}] of [
    ["categoryTools", "/category/game/test/lives"],
    ["categoryTools", "/lives", { categoryToolsEnabled: false, globalLiveCountEnabled: true }],
    ["monthlyBroadcastTime", `/${"a".repeat(32)}`],
    ["videoSearch", `/${"a".repeat(32)}/videos`],
]) {
    test(`${feature} on ${pathname} coalesces observer bursts and pending work cannot restart it after disabling`, async (t) => {
        const f = fixture(t, feature, pathname, overrides);
        for (let index = 0; index < 100; index++) f.schedule();
        assert.equal(f.scans(), 0, "observer callbacks do not repeatedly scan synchronously");
        assert.equal(f.frames.size, 1, "one frame services the entire initial burst");
        await f.frame();
        assert.ok(f.scans() > 0, "the scheduled frame actually tries to mount the feature");
        const scanned = f.scans();
        f.schedule();
        const pendingTimers = f.timers.size;
        assert.ok(pendingTimers > 0, "the next burst is deferred");
        for (let index = 0; index < 100; index++) f.schedule();
        assert.equal(f.scans(), scanned);
        assert.equal(f.timers.size, pendingTimers, "the burst shares its pending timer");
        f.nextTimer();
        assert.equal(f.frames.size, 1);
        f.disable();
        await f.frame();
        assert.equal(f.dom.window.document.querySelector("[id^='betterchzzk-']:not(style)"), null);
        assert.equal(f.frames.size, 0);
        assert.equal(f.timers.size, 0, "pending work must not schedule another retry after teardown");
    });
}
