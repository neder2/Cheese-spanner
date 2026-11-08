const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

async function fixture(t, refetch = async () => {}) {
    const dom = new JSDOM(
        '<div role="tablist"><button id="POPULAR" role="tab">시청자순</button><button id="LATEST" role="tab">최신순</button><button id="RECOMMEND" role="tab" class="native-sort">추천순</button></div>',
        {
            url: "https://chzzk.naver.com/lives",
            runScripts: "outside-only",
            pretendToBeVisual: true,
        }
    );
    t.after(() => dom.window.close());
    const { window } = dom;
    await new Promise((resolve) => window.addEventListener("load", resolve, { once: true }));
    await new Promise((resolve) => setImmediate(resolve));
    const frames = new Map();
    const timers = new Map();
    let id = 0;
    window.requestAnimationFrame = (fn) => {
        frames.set(++id, fn);
        return id;
    };
    window.cancelAnimationFrame = (key) => frames.delete(key);
    window.setTimeout = (fn, delay) => {
        timers.set(++id, { fn, delay });
        return id;
    };
    window.clearTimeout = (key) => timers.delete(key);
    const calls = [];
    const queryKey = ["all-lives", "/lives", { sortType: "RECOMMEND" }];
    window.document.getElementById("RECOMMEND").__reactFiber$test = {
        return: {
            memoizedProps: {
                client: {
                    getQueryCache: () => ({ findAll: () => [{ queryKey }, { queryKey: ["following-live"] }] }),
                    refetchQueries: (...args) => {
                        calls.push(args);
                        return refetch();
                    },
                },
            },
        },
    };
    window.eval(fs.readFileSync(path.join(__dirname, "../features/liveListRefreshPage.js"), "utf8"));
    for (const fn of frames.values()) fn();
    frames.clear();
    return {
        window,
        calls,
        timers,
        queryKey,
        button: window.document.getElementById("cheese-spanner-live-list-refresh"),
    };
}

test("refresh follows recommend, preserves sort and suppresses clicks during one-second spin", async (t) => {
    const { window, button, calls, timers, queryKey } = await fixture(t);
    let refreshed = 0;
    window.addEventListener("cheese-spanner:live-list-refreshed", () => refreshed++);
    assert.equal(button.previousElementSibling.id, "RECOMMEND");
    button.click();
    button.click();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].queryKey, queryKey);
    assert.equal(calls[0][0].exact, true);
    assert.equal(button.getAttribute("data-refreshing"), "1");
    assert.equal(window.location.pathname, "/lives");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refreshed, 1);
    const timer = [...timers.values()][0];
    assert.equal(timer.delay, 1000);
    timer.fn();
    assert.equal(button.disabled, false);
    assert.equal(button.hasAttribute("data-refreshing"), false);
    assert.equal(button.textContent, "새로고침");
});

test("failed refresh keeps the button reusable without announcing success", async (t) => {
    const { window, button, timers } = await fixture(t, async () => {
        throw new Error("offline");
    });
    let refreshed = 0;
    window.addEventListener("cheese-spanner:live-list-refreshed", () => refreshed++);
    button.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refreshed, 0);
    assert.match(button.title, /다시 시도/);
    [...timers.values()][0].fn();
    assert.equal(button.disabled, false);
});

test("leaving the list removes the button and ignores a late response", async (t) => {
    let resolve;
    const { window, button, timers } = await fixture(
        t,
        () =>
            new Promise((done) => {
                resolve = done;
            })
    );
    let refreshed = 0;
    window.addEventListener("cheese-spanner:live-list-refreshed", () => refreshed++);
    button.click();
    window.history.pushState({}, "", "/videos");
    window.dispatchEvent(new window.Event("cheese-spanner:routechange"));
    resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(button.isConnected, false);
    assert.equal(timers.size, 0);
    assert.equal(refreshed, 0);
});
