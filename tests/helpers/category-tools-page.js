const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

// 방송 목록 도구를 /lives(또는 카테고리 목록) 페이지에 실제 적용 흐름 그대로 올리는 JSDOM fixture.
// 위치(rect)는 고정 격자로 흉내 내고, 목록·팔로워 API는 즉시 응답한다.
const CATEGORIES = [
    ["GAME", "League_of_Legends", "리그 오브 레전드"],
    ["GAME", "VALORANT", "발로란트"],
    ["ETC", "talk", "talk"],
];
const LIST_FILTER_SESSION_KEY = "betterChzzkListFilterSession";
const channelId = (index) => (index + 1).toString(16).padStart(32, "0");

function cardHtml(index) {
    const id = channelId(index);
    const [type, category, name] = CATEGORIES[index % CATEGORIES.length];
    return (
        `<div class="card" id="card-${index}"><a class="thumb" href="/live/${id}"><img class="thumb-img" width="320" height="180" alt=""></a>` +
        `<a class="pf" href="/${id}"><img class="profile" width="40" height="40" alt=""></a>` +
        `<a class="title" href="/live/${id}"><strong>Title ${index}</strong></a><a class="channel" href="/${id}">Channel ${index}</a>` +
        `<a class="category" href="/category/${type}/${category}/lives">${name}</a>` +
        `<a class="tag" href="/lives?tags=tag${index % 4}">tag${index % 4}</a><span>${100 + index}명</span></div>`
    );
}

function apiItem(index, now) {
    const [type, category, name] = CATEGORIES[index % CATEGORIES.length];
    return {
        liveId: 900000 - index,
        liveTitle: `Title ${index}`,
        concurrentUserCount: 5000 - index,
        openDate: new Date(now - (index + 1) * 600_000).toISOString(),
        adult: false,
        categoryType: type,
        liveCategory: category,
        liveCategoryValue: name,
        tags: [`tag${index % 4}`],
        channel: { channelId: channelId(index), channelName: `Channel ${index}` },
    };
}

function createFixture(
    t,
    {
        cards = 12,
        tabLine = true,
        tagSearch = false,
        options = {},
        url = "https://chzzk.naver.com/lives",
        session = null,
        blockSessionStorage = false,
    } = {}
) {
    const nav = tabLine
        ? '<nav id="tabs"><a href="/lives" aria-current="page">라이브</a><a href="/videos">동영상</a><a href="/clips">클립</a></nav>'
        : "";
    const tag = tagSearch ? '<div id="tag-box"><input id="tag-input" placeholder="태그 검색"></div>' : "";
    const dom = new JSDOM(
        `<body><section id="section">${nav}<div id="sort-row"><button aria-selected="true">인기</button><button>최신</button><button>추천</button>${tag}</div>` +
            `<main id="grid">${Array.from({ length: cards }, (_, index) => cardHtml(index)).join("")}</main></section></body>`,
        { url, runScripts: "outside-only", pretendToBeVisual: true }
    );
    t.after(() => dom.window.close());
    const { window } = dom;
    const { document } = window;
    if (session !== null) window.sessionStorage.setItem(LIST_FILTER_SESSION_KEY, session);
    if (blockSessionStorage) {
        Object.defineProperty(window, "sessionStorage", {
            configurable: true,
            get() {
                throw new window.DOMException("blocked", "SecurityError");
            },
        });
    }
    let now = Date.parse("2026-10-17T12:00:00Z");
    window.Date.now = () => now;

    const rects = new WeakMap();
    const setRect = (el, left, top, width, height) =>
        rects.set(el, { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height });
    const zero = { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    const counts = { rect: 0, url: 0, pageScan: 0, cardLinkQueries: 0 };
    const trace = [];
    window.Element.prototype.getBoundingClientRect = function () {
        counts.rect++;
        // 배지 위치를 정하려고 읽는 이미지 크기만 순서를 남긴다.
        if (this.tagName === "IMG") trace.push("R");
        return rects.get(this) || zero;
    };
    const queryAll = window.Document.prototype.querySelectorAll;
    window.Document.prototype.querySelectorAll = function (selector) {
        if (selector === "button, a" || selector === "button, a, [role='button'], [role='tab']") counts.pageScan++;
        return queryAll.call(this, selector);
    };
    const elementQueryAll = window.Element.prototype.querySelectorAll;
    window.Element.prototype.querySelectorAll = function (selector) {
        if (selector === "a[href]" && this.classList.contains("card")) counts.cardLinkQueries++;
        return elementQueryAll.call(this, selector);
    };
    for (const method of ["appendChild", "insertBefore", "setAttribute", "removeAttribute"]) {
        const original = window.Element.prototype[method];
        window.Element.prototype[method] = function (...args) {
            trace.push("W");
            return original.apply(this, args);
        };
    }
    const NativeURL = window.URL;
    window.URL = class extends NativeURL {
        constructor(...args) {
            counts.url++;
            super(...args);
        }
    };

    function layout() {
        setRect(document.getElementById("section"), 240, 80, 1400, 3000);
        if (tabLine) {
            setRect(document.getElementById("tabs"), 260, 70, 300, 36);
            document.querySelectorAll("#tabs a").forEach((a, index) => setRect(a, 260 + index * 80, 74, 70, 28));
        }
        setRect(document.getElementById("sort-row"), 260, 120, 1300, 32);
        document.querySelectorAll("#sort-row button").forEach((b, index) => setRect(b, 260 + index * 70, 120, 60, 32));
        if (tagSearch) {
            setRect(document.getElementById("tag-box"), 1300, 120, 240, 32);
            setRect(document.getElementById("tag-input"), 1310, 124, 220, 24);
        }
        setRect(document.getElementById("grid"), 260, 180, 1360, 300 * Math.ceil(cards / 4));
        document.querySelectorAll("#grid > .card").forEach((card, index) => {
            const left = 260 + (index % 4) * 340;
            const top = 180 + Math.floor(index / 4) * 300;
            setRect(card, left, top, 320, 280);
            card.querySelectorAll("a").forEach((a) =>
                setRect(a, left, top, 320, a.classList.contains("thumb") ? 180 : 20)
            );
            setRect(card.querySelector(".thumb-img"), left, top, 320, 180);
            setRect(card.querySelector(".profile"), left, top + 190, 40, 40);
        });
    }
    layout();
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });

    const load = (file) => window.eval(fs.readFileSync(path.join(__dirname, "..", "..", file), "utf8"));
    load("shared/settings.js");
    load("shared/data.js");
    load("shared/categoryExclusions.js");
    Object.assign(window.BetterChzzk.utils, {
        bindFeatureOptions() {},
        createMutationObserverSync: () => ({ disconnect() {} }),
        createThrottledDomSync: () => {
            const schedule = () => {};
            schedule.cancel = () => {};
            return schedule;
        },
        async fetchJson(url) {
            const href = String(url);
            if (href.includes("/v1/lives") || /\/categories\/[^/]+\/[^/]+\/lives/.test(href)) {
                return {
                    content: {
                        data: Array.from({ length: cards }, (_, index) => apiItem(index, now)),
                        page: { next: null },
                    },
                };
            }
            if (href.includes("/followers/count")) return { content: { followerCount: 12345 } };
            return { content: {} };
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
    const source = fs.readFileSync(path.join(__dirname, "../../features/categoryTools.js"), "utf8");
    const end = source.lastIndexOf("})();");
    assert.ok(end >= 0);
    window.eval(`${source.slice(0, end)}
        globalThis.categoryApplyCost = {
            ready: (options) => applyInitialOptions(BetterChzzkSettings.normalizeOptions(options)),
            apply: applyTools,
            exclude: (keys) => {
                categoryState = { categories: [] };
                categoryKeys = new Set(keys);
                categoryStateEpoch++;
            },
            tick: () => updateLiveElapsedBadgesNow(),
            followerCount: (id) => dataRepository.getFollowerCount(id),
            pageChange: handlePageChange,
            state: () => ({ query: currentQuery, filters: filterStates, restored: restoredConditionsPending }),
        };
        ${source.slice(end)}`);
    const hooks = window.categoryApplyCost;
    hooks.ready({
        categoryToolsEnabled: true,
        categoryToolsExclusionsEnabled: true,
        categoryToolsFollowerBadgesEnabled: true,
        categoryToolsLiveElapsedEnabled: true,
        ...options,
    });
    const settle = async () => {
        for (let i = 0; i < 40; i++) await Promise.resolve();
    };
    return {
        dom,
        window,
        document,
        counts,
        trace,
        hooks,
        layout,
        advance: (ms) => {
            now += ms;
        },
        async apply() {
            await hooks.apply();
            await settle();
        },
        reset() {
            for (const key of Object.keys(counts)) counts[key] = 0;
            trace.length = 0;
        },
        categoryKey: (type, id) => window.BetterChzzk.categoryExclusions.categoryKey(type, id),
        async navigate(nextUrl) {
            dom.reconfigure({ url: nextUrl });
            hooks.pageChange();
            await settle();
        },
        storedSession: () => JSON.parse(window.sessionStorage.getItem(LIST_FILTER_SESSION_KEY) || "null"),
        visibleCardIds: () =>
            Array.from(document.querySelectorAll('#grid > [data-bcgt-card="1"]'))
                .filter((card) => card.getAttribute("data-bcgt-hide") !== "1")
                .map((card) => card.id),
    };
}

module.exports = { CATEGORIES, LIST_FILTER_SESSION_KEY, channelId, apiItem, createFixture };
