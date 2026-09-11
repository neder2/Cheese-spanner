const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

function createFixture(t) {
    const dom = new JSDOM(
        '<body><nav id="tabs"><button>라이브</button><button>동영상</button><button>클립</button></nav><main id="grid"><article id="card" data-bcgt-card="1" data-bcgt-card-id="channel-a"><a href="/live/channel-a">Alpha</a></article><article id="card-b"><a href="/live/channel-b">Beta</a></article></main></body>',
        { url: "https://chzzk.naver.com/category/game/test/lives", runScripts: "outside-only" }
    );
    t.after(() => dom.window.close());
    const { window } = dom;
    function rect(element, left, top, width, height) {
        element.getBoundingClientRect = () => ({
            x: left,
            y: top,
            left,
            top,
            width,
            height,
            right: left + width,
            bottom: top + height,
        });
    }
    rect(window.document.getElementById("tabs"), 16, 20, 360, 40);
    window.document
        .querySelectorAll("#tabs button")
        .forEach((button, index) => rect(button, 24 + index * 80, 24, 70, 32));
    rect(window.document.getElementById("grid"), 16, 100, 760, 560);
    window.document.querySelectorAll("article").forEach((card, index) => {
        rect(card, 24 + index * 340, 120, 320, 180);
        rect(card.querySelector("a"), 24 + index * 340, 120, 320, 180);
    });
    const requests = [];
    const timers = new Map();
    let timerId = 0;
    const load = (file) => window.eval(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
    load("shared/settings.js");
    load("shared/data.js");
    window.setTimeout = (callback) => {
        const id = ++timerId;
        timers.set(id, callback);
        return id;
    };
    window.clearTimeout = (id) => timers.delete(id);
    Object.assign(window.BetterChzzk.utils, {
        bindFeatureOptions() {},
        createMutationObserverSync: () => ({ disconnect() {} }),
        createThrottledDomSync: () => () => {},
        fetchJson(url, options) {
            return new Promise((resolve) => requests.push({ url, ...options, resolve }));
        },
        normSpace: window.BetterChzzk.utils.compactSpaces,
        injectStyleOnce() {},
        sleep: async () => {},
        onReady() {},
        startPageChangeDetection: () => () => {},
        setLoadingReason(reasons, on, reason, apply) {
            if (on) reasons.add(reason);
            else reasons.delete(reason);
            apply();
        },
    });
    for (const module of ["filterModel", "repository", "searchController"]) {
        load(`features/categoryTools/${module}.js`);
    }
    const source = fs.readFileSync(path.join(__dirname, "../features/categoryTools.js"), "utf8");
    const end = source.lastIndexOf("})();");
    assert.ok(end >= 0);
    window.eval(`${source.slice(0, end)}
        globalThis.categoryLifecycle = {
            setFollowerMinimum: (min) => setFilterValue("followers", min),
            remember: (card) => rememberFollowerRefreshRows(getRoute(), [{
                entry: { card, id: "channel-a", domText: "Alpha" },
                meta: { channelId: "channel-a", views: 10 }
            }]),
            refresh: refreshFollowerHydrationRows,
            apply: applyTools,
            disable: () => applyOptions(BetterChzzkSettings.normalizeOptions({ categoryToolsEnabled: false })),
            pageChange: handlePageChange
        };
        ${source.slice(end)}`);
    const card = window.document.getElementById("card");
    window.categoryLifecycle.setFollowerMinimum(1000);
    window.categoryLifecycle.remember(card);
    return { dom, card, requests, timers, hooks: window.categoryLifecycle };
}

test("category follower refresh applies the count to the same card identity", async (t) => {
    const { card, requests, hooks } = createFixture(t);
    const pending = hooks.refresh();
    assert.equal(requests.length, 1);
    requests[0].resolve({ content: { followerCount: 500 } });
    await pending;
    assert.equal(card.getAttribute("data-bcgt-hide"), "1");
});

test("category follower refresh does not apply an old channel count after React reuses the card", async (t) => {
    const { card, requests, hooks } = createFixture(t);
    const pending = hooks.refresh();
    card.querySelector("a").setAttribute("href", "/live/channel-b");
    card.querySelector("a").textContent = "Beta";
    requests[0].resolve({ content: { followerCount: 500 } });
    await pending;
    assert.equal(card.hasAttribute("data-bcgt-hide"), false);
    assert.equal(requests.length, 1);
});

test("category follower refresh ignores a detached card after the list remounts", async (t) => {
    const { dom, card, requests, hooks } = createFixture(t);
    const pending = hooks.refresh();
    const replacement = card.cloneNode(true);
    card.replaceWith(replacement);
    requests[0].resolve({ content: { followerCount: 500 } });
    await pending;
    assert.equal(card.hasAttribute("data-bcgt-hide"), false);
    assert.equal(dom.window.document.getElementById("card"), replacement);
    assert.equal(replacement.hasAttribute("data-bcgt-hide"), false);
});

test("category option disable aborts follower work and prevents delayed DOM or timer updates", async (t) => {
    const { card, requests, timers, hooks } = createFixture(t);
    const pending = hooks.refresh();
    hooks.disable();
    assert.equal(requests[0].signal.aborted, true);
    requests[0].resolve({ content: { followerCount: 500 } });
    await pending;
    assert.equal(card.hasAttribute("data-bcgt-card"), false);
    assert.equal(card.hasAttribute("data-bcgt-hide"), false);
    assert.equal(timers.size, 0);
});

test("category SPA navigation aborts follower work before the next list starts", async (t) => {
    const { dom, card, requests, timers, hooks } = createFixture(t);
    const pending = hooks.refresh();
    dom.reconfigure({ url: "https://chzzk.naver.com/category/game/next/lives" });
    hooks.pageChange();
    assert.equal(requests[0].signal.aborted, true);
    requests[0].resolve({ content: { followerCount: 500 } });
    await pending;
    assert.equal(card.hasAttribute("data-bcgt-hide"), false);
    assert.equal(timers.size, 0);
});

test("category disable during initial metadata loading does not resume card or badge updates", async (t) => {
    const { dom, requests, timers, hooks } = createFixture(t);
    const pending = hooks.apply();
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/categories\/game\/test\/lives/);
    assert.ok(dom.window.document.getElementById("betterchzzk-category-tools"));
    hooks.disable();
    assert.equal(requests[0].signal.aborted, true);
    requests[0].resolve({
        content: { data: [{ channel: { channelId: "channel-a" }, liveTitle: "Late live" }], page: { next: null } },
    });
    await pending;
    assert.equal(requests.length, 1, "a late metadata response must not start follower requests");
    assert.equal(dom.window.document.getElementById("betterchzzk-category-tools"), null);
    assert.equal(dom.window.document.querySelector('[data-bcgt-card="1"], [data-bcgt-follower-badge="1"]'), null);
    assert.equal(timers.size, 0);
});
