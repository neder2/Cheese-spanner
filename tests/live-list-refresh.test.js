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
    let activeKey = queryKey;
    let onQueryChange;
    const cache = {
        findAll: () => [{ queryKey: activeKey }, { queryKey: ["following-live"] }],
        subscribe(handler) {
            onQueryChange = handler;
            return () => {
                onQueryChange = null;
            };
        },
    };
    window.document.getElementById("RECOMMEND").__reactFiber$test = {
        return: {
            memoizedProps: {
                client: {
                    getQueryCache: () => cache,
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
        changeQuery(next) {
            activeKey = next;
            onQueryChange?.({ type: "observerOptionsUpdated" });
        },
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

test("a slow refresh stays locked after the spin finishes and unlocks only after its response", async (t) => {
    let resolve;
    const { button, calls, timers } = await fixture(
        t,
        () =>
            new Promise((done) => {
                resolve = done;
            })
    );
    button.click();
    [...timers.values()][0].fn();
    assert.equal(button.disabled, true);
    button.click();
    assert.equal(calls.length, 1);
    resolve();
    await new Promise((done) => setImmediate(done));
    assert.equal(button.disabled, false);
    assert.equal(button.hasAttribute("data-refreshing"), false);
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

test("sort and filter changes suppress completion, including returning to the starting query", async (t) => {
    for (const returnToStart of [false, true]) {
        await t.test(`return ${returnToStart}`, async (t) => {
            let resolve;
            const { window, button, timers, queryKey, changeQuery } = await fixture(
                t,
                () =>
                    new Promise((done) => {
                        resolve = done;
                    })
            );
            let refreshed = 0;
            window.addEventListener("cheese-spanner:live-list-refreshed", () => refreshed++);
            button.click();
            changeQuery(["all-lives", "/lives", { sortType: "LATEST", tags: ["tag"] }]);
            if (returnToStart) changeQuery(queryKey);
            resolve();
            await new Promise((done) => setImmediate(done));
            [...timers.values()][0].fn();
            assert.equal(refreshed, 0);
            assert.doesNotMatch(button.title, /완료/);
            assert.equal(button.disabled, false);
        });
    }
});

test("a new refresh or a filter change clears the previous result for the same sort", async (t) => {
    let finish;
    let requests = 0;
    const f = await fixture(t, () =>
        ++requests === 3
            ? new Promise((resolve) => {
                  finish = resolve;
              })
            : Promise.resolve()
    );
    const { window, button, timers, queryKey, changeQuery } = f;
    const label = button.title;
    let completed = 0;
    window.addEventListener("cheese-spanner:live-list-refreshed", () => completed++);
    const settle = async () => {
        await new Promise((resolve) => setImmediate(resolve));
        [...timers.values()].at(-1).fn();
    };
    const filtered = ["all-lives", "/lives", { sortType: "RECOMMEND", tags: ["tag"] }];
    button.click();
    await settle();
    assert.match(button.title, /완료/);
    changeQuery(filtered);
    assert.equal(button.title, label, "a settled result belongs only to its filter");
    button.click();
    await settle();
    assert.match(button.title, /완료/);
    button.click();
    assert.equal(button.title, label, "the next request clears the old result immediately");
    changeQuery(queryKey);
    changeQuery(filtered);
    finish();
    await settle();
    assert.equal(button.title, label);
    assert.equal(completed, 2);
    assert.equal(button.disabled, false);
});
