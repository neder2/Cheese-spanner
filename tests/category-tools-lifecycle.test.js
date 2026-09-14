const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

function createFixture(t) {
    const dom = new JSDOM(
        '<body><nav id="tabs"><button>라이브</button><button>동영상</button><button>클립</button></nav><main id="grid"><article id="card" data-bcgt-card="1" data-bcgt-card-id="channel-a"><a href="/live/channel-a">Alpha</a></article><article id="card-b"><a href="/live/channel-b">Beta</a></article></main></body>',
        { url: "https://chzzk.naver.com/category/game/test/lives", runScripts: "outside-only", pretendToBeVisual: true }
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
    let scheduledApplies = 0;
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
        createThrottledDomSync: () => () => scheduledApplies++,
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
            mountCount: () => {
                if (!document.getElementById(BAR_ID)) document.body.appendChild(buildToolbar());
                syncGlobalLiveCount({ scope: "global-lives", tab: "lives" });
            },
            setFollowerMinimum: (min) => setFilterValue("followers", min),
            remember: (card) => rememberFollowerRefreshRows(getRoute(), [{
                entry: { card, id: "channel-a", domText: "Alpha" },
                meta: { channelId: "channel-a", views: 10 }
            }]),
            refresh: refreshFollowerHydrationRows,
            search: (query) => { mountToolbar(getRoute()); currentQuery = query; },
            scroll: handleAutoLoadScroll,
            apply: applyTools,
            disable: () => applyOptions(BetterChzzkSettings.normalizeOptions({ categoryToolsEnabled: false })),
            pageChange: handlePageChange
        };
        ${source.slice(end)}`);
    const card = window.document.getElementById("card");
    window.categoryLifecycle.setFollowerMinimum(1000);
    window.categoryLifecycle.remember(card);
    return { dom, card, requests, timers, hooks: window.categoryLifecycle, scheduledApplies: () => scheduledApplies };
}

test("filter keyboard dismissal preserves values and returns focus to its trigger", (t) => {
    const { dom, hooks } = createFixture(t);
    hooks.search("");
    const { document, KeyboardEvent, Event } = dom.window;
    const trigger = document.querySelector(".bcgt-filter");
    trigger.click();
    const panel = document.getElementById(trigger.getAttribute("aria-controls"));
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.ok(panel.contains(document.activeElement));
    assert.equal(panel.getAttribute("role"), "group");
    const input = panel.querySelector('[data-filter-min-input="followers"]');
    assert.equal(input.getAttribute("aria-label"), "최소 팔로워 수");
    input.value = "2500";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(panel.getAttribute("data-open"), "0");
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, trigger);
    trigger.click();
    assert.equal(input.value, "2500", "closing filters must not erase the entered range");
    hooks.disable();
});

test("category search displays matching cards while follower badges are still loading", async (t) => {
    const { dom, card, requests, hooks } = createFixture(t);
    hooks.search("Alpha");
    const applying = hooks.apply();
    requests[0].resolve({
        content: {
            data: [
                { liveTitle: "Alpha", channel: { channelId: "channel-a", channelName: "Alpha" } },
                { liveTitle: "Beta", channel: { channelId: "channel-b", channelName: "Beta" } },
            ],
            page: { next: null },
        },
    });
    let applied = false;
    void applying.then(() => {
        applied = true;
    });
    for (let i = 0; i < 40; i++) await Promise.resolve();
    assert.equal(applied, true, "display must not wait for a badge response");
    assert.equal(card.hasAttribute("data-bcgt-hide"), false);
    assert.equal(dom.window.document.getElementById("card-b").getAttribute("data-bcgt-hide"), "1");
    assert.equal(requests.length, 2, "only the matching visible channel needs a follower badge");
    hooks.disable();
    requests[1].resolve({ content: { followerCount: 100 } });
    await applying;
});

test("category scrolling with elapsed badges enabled does not schedule a full list apply", async (t) => {
    const env = createFixture(t);
    env.hooks.setFollowerMinimum(0);
    Object.defineProperty(env.dom.window.performance, "now", { value: () => 10000 });
    const before = env.scheduledApplies();
    env.hooks.scroll();
    assert.equal(env.scheduledApplies(), before, "scroll should only refresh remembered rows");
    env.hooks.disable();
    for (const request of env.requests) request.resolve({ content: { followerCount: 100 } });
});

test("category follower lookup failures are distinguished from an empty search result", async (t) => {
    const { dom, requests, hooks } = createFixture(t);
    hooks.search("");
    hooks.setFollowerMinimum(1);
    const applying = hooks.apply();
    requests[0].resolve({
        content: {
            data: [
                { liveTitle: "Alpha", channel: { channelId: "channel-a" } },
                { liveTitle: "Beta", channel: { channelId: "channel-b" } },
            ],
            page: { next: null },
        },
    });
    await applying;
    assert.match(dom.window.document.querySelector('[data-bcgt-empty="1"]').textContent, /확인하고/);
    requests[1].resolve({ content: {} });
    requests[2].resolve({ content: {} });
    for (let i = 0; i < 40; i++) await Promise.resolve();
    await hooks.apply();
    assert.equal(
        dom.window.document.querySelector('[data-bcgt-empty="1"]').textContent,
        "팔로워 정보를 확인하지 못했어요."
    );
    assert.equal(requests.length, 3, "failed lookups retain the existing retry cooldown");
    hooks.disable();
});

test("category keeps one trailing scroll check and cancels it when disabled", async (t) => {
    const env = createFixture(t);
    env.hooks.setFollowerMinimum(0);
    let now = 10000;
    Object.defineProperty(env.dom.window.performance, "now", { value: () => now });
    env.hooks.scroll();
    now += 100;
    env.hooks.scroll();
    env.hooks.scroll();
    assert.equal(env.timers.size, 1, "the end of a scroll burst must not be dropped");
    env.hooks.disable();
    assert.equal(env.timers.size, 0);
    for (const request of env.requests) request.resolve({ content: { followerCount: 100 } });
});

test("global count label survives toolbar remount without duplicate requests and cleans up on disable", async (t) => {
    const { dom, requests, hooks } = createFixture(t);
    hooks.mountCount();
    hooks.mountCount();
    assert.equal(requests.length, 1);
    assert.match(dom.window.document.querySelector(".bcgt-live-count").textContent, /집계 중/);
    requests[0].resolve({ content: { data: [], page: { next: null } } });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.match(dom.window.document.querySelector(".bcgt-live-count").textContent, /방송 0개/);
    assert.match(dom.window.document.querySelector(".bcgt-live-count").textContent, /시청자 합계 0명/);
    dom.window.document.getElementById("betterchzzk-category-tools").remove();
    hooks.mountCount();
    assert.match(dom.window.document.querySelector(".bcgt-live-count").textContent, /방송 0개/);
    assert.match(dom.window.document.querySelector(".bcgt-live-count").textContent, /시청자 합계 0명/);
    assert.equal(requests.length, 1);
    hooks.disable();
    assert.equal(dom.window.document.querySelector(".bcgt-live-count"), null);
});

test("global count label displays the viewer total with its threshold and counting scope", async (t) => {
    const { dom, requests, hooks } = createFixture(t);
    hooks.mountCount();
    requests[0].resolve({
        content: {
            data: [
                { liveId: 1, concurrentUserCount: 12345, channel: { channelId: "a" } },
                { liveId: 2, concurrentUserCount: 10, channel: { channelId: "b" } },
                { liveId: 3, concurrentUserCount: 9, channel: { channelId: "c" } },
            ],
            page: { next: null },
        },
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const label = dom.window.document.querySelector(".bcgt-live-count");
    assert.equal(label.textContent, "시청자 10명 이상 · 방송 2개 · 시청자 합계 12,355명");
    assert.match(label.title, /중복 시청자를 제거한 인원 수는 아니에요/);
    assert.equal(requests.length, 1);
    hooks.disable();
});

test("global count cancellation cannot restore its label after disable", async (t) => {
    const { dom, requests, hooks } = createFixture(t);
    hooks.mountCount();
    hooks.disable();
    assert.equal(requests[0].signal.aborted, true);
    requests[0].resolve({ content: { data: [], page: { next: null } } });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(dom.window.document.querySelector(".bcgt-live-count"), null);
});

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
