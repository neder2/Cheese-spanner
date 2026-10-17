const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

// 방송 목록 적용 한 번의 비용을 호출 횟수로 지킨다. 결과(보이는 카드)는 그대로여야 한다.
const CATEGORIES = [
    ["GAME", "League_of_Legends", "리그 오브 레전드"],
    ["GAME", "VALORANT", "발로란트"],
    ["ETC", "talk", "talk"],
];
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

function createFixture(t, { cards = 12, tabLine = true, tagSearch = false, options = {} } = {}) {
    const nav = tabLine
        ? '<nav id="tabs"><a href="/lives" aria-current="page">라이브</a><a href="/videos">동영상</a></nav>'
        : "";
    const tag = tagSearch ? '<div id="tag-box"><input id="tag-input" placeholder="태그 검색"></div>' : "";
    const dom = new JSDOM(
        `<body><section id="section">${nav}<div id="sort-row"><button aria-selected="true">인기</button><button>최신</button><button>추천</button>${tag}</div>` +
            `<main id="grid">${Array.from({ length: cards }, (_, index) => cardHtml(index)).join("")}</main></section></body>`,
        { url: "https://chzzk.naver.com/lives", runScripts: "outside-only", pretendToBeVisual: true }
    );
    t.after(() => dom.window.close());
    const { window } = dom;
    const { document } = window;
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

    const load = (file) => window.eval(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
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
            if (href.includes("/v1/lives")) {
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
    const source = fs.readFileSync(path.join(__dirname, "../features/categoryTools.js"), "utf8");
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
        visibleCardIds: () =>
            Array.from(document.querySelectorAll('#grid > [data-bcgt-card="1"]'))
                .filter((card) => card.getAttribute("data-bcgt-hide") !== "1")
                .map((card) => card.id),
    };
}

function recordMutations(fixture, run) {
    const records = [];
    const observer = new fixture.window.MutationObserver((list) => records.push(...list));
    observer.observe(fixture.document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    return run().then(() => {
        records.push(...observer.takeRecords());
        observer.disconnect();
        return records;
    });
}

test("steady global list applies reuse the found sort row and tab line instead of walking every page link", async (t) => {
    const fixture = createFixture(t);
    await fixture.apply();
    await fixture.apply();
    const toolbar = fixture.document.getElementById("betterchzzk-category-tools");
    assert.equal(toolbar?.parentElement?.id, "tabs");

    fixture.reset();
    await fixture.apply();
    assert.equal(fixture.counts.pageScan, 0, "a steady apply validates the cached controls only");
    assert.equal(toolbar.parentElement.id, "tabs");

    // 사이트가 정렬 줄을 다시 그리면 떨어진 버튼을 버리고 새로 찾는다.
    const row = fixture.document.getElementById("sort-row");
    row.innerHTML = '<button aria-selected="true">인기</button><button>최신</button><button>추천</button>';
    fixture.layout();
    fixture.reset();
    await fixture.apply();
    assert.ok(fixture.counts.pageScan >= 1, "replaced sort buttons are searched again");
    fixture.reset();
    await fixture.apply();
    assert.equal(fixture.counts.pageScan, 0, "the new controls are reused on the next apply");
    assert.equal(fixture.visibleCardIds().length, 12);
});

test("category exclusion checks parse each card link once and read card links once per synchronous pass", async (t) => {
    const fixture = createFixture(t, { options: { categoryToolsFollowerBadgesEnabled: false } });
    await fixture.apply();
    fixture.hooks.exclude([fixture.categoryKey("GAME", "League_of_Legends")]);
    fixture.reset();
    await fixture.apply();
    const hrefs = new Set(
        Array.from(fixture.document.querySelectorAll("#grid a[href]"), (a) => a.getAttribute("href"))
    );
    assert.ok(fixture.counts.url <= hrefs.size * 2, `first exclusion pass parsed ${fixture.counts.url} URLs`);
    const hidden = Array.from({ length: 12 }, (_, index) => index)
        .filter((index) => index % CATEGORIES.length === 0)
        .map((index) => `card-${index}`);
    assert.deepEqual(
        fixture.visibleCardIds().sort(),
        Array.from({ length: 12 }, (_, index) => `card-${index}`)
            .filter((id) => !hidden.includes(id))
            .sort()
    );

    fixture.reset();
    await fixture.apply();
    assert.equal(fixture.counts.url, 0, "known card hrefs are not parsed again");
    assert.ok(
        fixture.counts.cardLinkQueries <= 12 * 3,
        `${fixture.counts.cardLinkQueries} card link reads for 12 cards in one apply`
    );
    assert.equal(fixture.visibleCardIds().length, 8);
});

test("hidden elapsed badges stay unchanged every second while a focused badge refreshes", async (t) => {
    const fixture = createFixture(t, { options: { categoryToolsFollowerBadgesEnabled: false } });
    await fixture.apply();
    await fixture.apply();
    const badges = Array.from(fixture.document.querySelectorAll('[data-bcgt-live-elapsed-badge="1"]'));
    assert.equal(badges.length, 12);
    const before = badges.map((badge) => badge.textContent);

    fixture.advance(5000);
    const records = await recordMutations(fixture, async () => fixture.hooks.tick());
    assert.equal(records.length, 0, "badges hidden by CSS are not rewritten every second");
    assert.deepEqual(
        badges.map((badge) => badge.textContent),
        before
    );

    const thumb = fixture.document.querySelector("#card-1 a.thumb");
    thumb.focus();
    const focusedBadge = thumb.querySelector('[data-bcgt-live-elapsed-badge="1"]');
    assert.equal(focusedBadge.textContent, "20:05", "a badge is refreshed when it becomes visible");
    fixture.advance(1000);
    fixture.hooks.tick();
    assert.equal(focusedBadge.textContent, "20:06");
    assert.equal(badges[0].textContent, before[0], "other hidden badges keep their text");
});

test("card badges read every card's image geometry before writing any badge", async (t) => {
    const fixture = createFixture(t, { cards: 8 });
    for (let index = 0; index < 8; index++) await fixture.hooks.followerCount(channelId(index));
    fixture.reset();
    await fixture.apply();
    const readsAfterWrite = fixture.trace.filter(
        (step, index) => step === "R" && fixture.trace[index - 1] === "W"
    ).length;
    assert.equal(fixture.document.querySelectorAll('[data-bcgt-follower-badge="1"]').length, 8);
    assert.equal(fixture.document.querySelectorAll('[data-bcgt-live-elapsed-badge="1"]').length, 8);
    // 카드 링크를 찾는 두 번과 배지 준비의 첫 읽기는 앞선 툴바·카드 표식 쓰기 뒤라 피할 수 없다.
    // 카드마다 읽기와 쓰기를 번갈아 하면 카드 수의 두 배 가까이(8장에 18번) 늘어난다.
    assert.ok(readsAfterWrite <= 3, `${readsAfterWrite} image reads came right after a DOM write`);
});

test("a placed toolbar beside the visible native tag search is not re-inserted on steady applies", async (t) => {
    const fixture = createFixture(t, {
        tabLine: false,
        tagSearch: true,
        options: { categoryToolsHideGlobalTagSearch: false },
    });
    await fixture.apply();
    await fixture.apply();
    const toolbar = fixture.document.getElementById("betterchzzk-category-tools");
    assert.equal(toolbar.nextSibling?.id, "tag-box");
    assert.equal(fixture.document.getElementById("tag-box").getAttribute("data-bcgt-tag-search-anchor"), "1");

    const records = await recordMutations(fixture, () => fixture.apply());
    assert.equal(
        records.filter((record) => [...record.removedNodes].includes(toolbar)).length,
        0,
        "moving the toolbar to the same place would look like a site removal and schedule another apply"
    );
    assert.equal(records.filter((record) => record.attributeName === "data-bcgt-tag-search-anchor").length, 0);
});

test("a hidden native tag search keeps its mark without being restored and hidden again", async (t) => {
    const fixture = createFixture(t, { tabLine: false, tagSearch: true });
    await fixture.apply();
    await fixture.apply();
    assert.equal(fixture.document.getElementById("tag-box").getAttribute("data-bcgt-hidden-tag-search"), "1");

    const records = await recordMutations(fixture, () => fixture.apply());
    assert.equal(records.filter((record) => record.attributeName === "data-bcgt-hidden-tag-search").length, 0);
    assert.equal(fixture.document.getElementById("tag-box").getAttribute("data-bcgt-hidden-tag-search"), "1");
});
