const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const A = "6c837d7222ccc4431ca7835a4340be8e";
const B = "b".repeat(32);
// 2026-09-06, /live/6c837d7222ccc4431ca7835a4340be8e: measured end-screen structure.
const END = '<div class="_player_1tswz_23"><div><p>다음 라이브를 기대해주세요!</p></div></div>';
const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
};
function setup(t, { markup = END, route = `/live/${A}`, enabled = true } = {}) {
    const dom = new JSDOM(`<main id="layout-body">${markup}</main>`);
    t.after(() => dom.window.close());
    const timers = new Map();
    const requests = [];
    let timerId = 0;
    let apply;
    let routeListener;
    let syncDom;
    let disconnected = false;
    let reloads = 0;
    dom.window.setTimeout = (fn, delay) => {
        timers.set(++timerId, { fn, delay });
        return timerId;
    };
    dom.window.clearTimeout = (id) => timers.delete(id);
    const location = { pathname: route, reload: () => reloads++ };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../features/offlineLiveReload.js"), "utf8"), {
        window: dom.window,
        document: dom.window.document,
        Element: dom.window.Element,
        location,
        AbortController,
        BetterChzzk: {
            utils: {
                bindFeatureOptions(fn) {
                    apply = fn;
                    fn({ offlineLiveReloadEnabled: enabled });
                },
                createMutationObserverSync(config) {
                    disconnected = false;
                    syncDom = config.schedule;
                    const observer = new dom.window.MutationObserver((mutations) => {
                        if (config.shouldSchedule(mutations)) config.schedule();
                    });
                    observer.observe(config.target(), config.options);
                    config.onObserved();
                    return {
                        disconnectAll() {
                            disconnected = true;
                            observer.disconnect();
                        },
                    };
                },
                startPageChangeDetection(fn) {
                    routeListener = fn;
                    return () => {
                        routeListener = null;
                    };
                },
                fetchJson(url, options) {
                    return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
                },
            },
        },
    });
    return {
        dom,
        timers,
        requests,
        get reloads() {
            return reloads;
        },
        setEnabled(value) {
            apply({ offlineLiveReloadEnabled: value });
        },
        navigate(route) {
            location.pathname = route;
            routeListener?.();
        },
        markup(html) {
            dom.window.document.getElementById("layout-body").innerHTML = html;
            if (!disconnected) syncDom?.();
        },
        async reply(status, id = A, index = requests.length - 1) {
            requests[index].resolve({ code: 200, content: { status, channel: { channelId: id } } });
            await flush();
        },
        tick() {
            assert.equal(timers.size, 1);
            const [id, timer] = timers.entries().next().value;
            assert.equal(timer.delay, 30000);
            timers.delete(id);
            timer.fn();
        },
    };
}

test("offline page reloads once only after a verified CLOSE to OPEN transition", async (t) => {
    const h = setup(t);
    assert.equal(h.requests.length, 1);
    await h.reply("CLOSE");
    h.markup(END);
    h.markup(END);
    assert.equal(h.requests.length, 1, "DOM mutations must not accelerate polling");
    h.tick();
    assert.equal(h.requests.length, 2);
    assert.equal(h.timers.size, 0, "requests never overlap");
    await h.reply("OPEN");
    assert.equal(h.reloads, 1);
    assert.equal(h.timers.size, 0);
    h.markup(END);
    assert.equal(h.requests.length, 2);
});

test("initial OPEN, errors, unknown status and another channel cannot cause reload loops", async (t) => {
    const h = setup(t);
    await h.reply("OPEN");
    assert.equal(h.reloads, 0);
    h.tick();
    await h.reply("CLOSE");
    h.tick();
    h.requests.at(-1).reject(new Error("timeout"));
    await flush();
    assert.equal(h.reloads, 0);
    h.tick();
    await h.reply("OPEN", B);
    h.tick();
    await h.reply("UNKNOWN");
    assert.equal(h.reloads, 0);
    h.tick();
    await h.reply("OPEN");
    assert.equal(h.reloads, 1);
});

test("routes, disabled options and non-player copies never start polling", async (t) => {
    for (const route of ["/lives", `/video/123`, `/live/${A}/chat`]) {
        const h = setup(t, { route });
        assert.equal(h.requests.length, 0);
    }
    const h = setup(t, { enabled: false });
    assert.equal(h.requests.length, 0);
    h.setEnabled(true);
    await h.reply("CLOSE");
    h.setEnabled(false);
    assert.equal(h.timers.size, 0);
    h.markup(END);
    assert.equal(h.requests.length, 1);
    const outside = setup(t, {
        markup: '<p>다음 라이브를 기대해주세요!</p><div class="_player_test"><video></video></div>',
    });
    assert.equal(outside.requests.length, 0);
    outside.markup(END);
    assert.equal(outside.requests.length, 1);
});

test("leaving or disabling aborts in-flight requests and ignores late OPEN", async (t) => {
    for (const action of [
        (h) => h.setEnabled(false),
        (h) => h.navigate(`/live/${B}`),
        (h) => h.markup('<div class="_player_test"><video></video></div>'),
    ]) {
        const h = setup(t);
        await h.reply("CLOSE");
        h.tick();
        const pending = h.requests[1];
        action(h);
        assert.equal(pending.options.signal.aborted, true);
        await h.reply("OPEN", A, 1);
        assert.equal(h.reloads, 0);
        assert.equal(h.timers.size, 0);
    }
});

test("pagehide cancels polling and pageshow resumes with fresh offline evidence", async (t) => {
    const h = setup(t);
    await h.reply("CLOSE");
    h.dom.window.dispatchEvent(new h.dom.window.Event("pagehide"));
    assert.equal(h.timers.size, 0);
    h.dom.window.dispatchEvent(new h.dom.window.Event("pageshow"));
    assert.equal(h.requests.length, 2);
    await h.reply("OPEN");
    assert.equal(h.reloads, 0);
});

test("removing the entire player aborts its request through the DOM observer", async (t) => {
    const h = setup(t);
    h.dom.window.document.querySelector("[class*='_player_']").remove();
    await flush();
    assert.equal(h.requests[0].options.signal.aborted, true);
    await h.reply("OPEN");
    assert.equal(h.reloads, 0);
    assert.equal(h.timers.size, 0);
});
