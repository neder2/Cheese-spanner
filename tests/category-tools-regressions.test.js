const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { createCategoryUI, settle, category, state } = require("./helpers/category-exclusions-ui.js");

// 2026-10-29 방송 목록 버그 보고(R1-26~R1-30, R2-101~R2-103)의 회귀예요.
const BAR_ID = "cheese-spanner-category-tools";
const FALLBACK_ID = "cheese-spanner-category-tools-fallback";

const liveMeta = (id, extra = {}) => ({
    liveId: id.charCodeAt(0),
    liveTitle: `게임 하나 ${id}`,
    concurrentUserCount: 100,
    liveImageUrl: `https://example.com/${id}.jpg`,
    categoryType: "GAME",
    liveCategory: "A",
    liveCategoryValue: "게임 하나",
    channel: { channelId: `channel-${id}`, channelName: id },
    ...extra,
});

function popularListRequests(ui) {
    return ui.fetches.filter(({ url }) => new URL(url).pathname === "/service/v1/lives").length;
}

function runFrames(ui) {
    const frames = [...ui.frames];
    ui.frames.clear();
    for (const [, callback] of frames) callback();
}

function runTimers(ui, predicate) {
    for (const [id, timer] of [...ui.timers]) {
        if (!predicate(timer)) continue;
        ui.timers.delete(id);
        timer.callback();
    }
}

function nativeCard(window, id, title) {
    const card = window.document.createElement("article");
    card.id = `native-${id}`;
    card.innerHTML =
        `<a class="thumbnail" href="/live/channel-${id}"><img width="320" height="180" src="https://example.com/${id}.jpg" /></a>` +
        `<a class="title" href="/live/channel-${id}">${title}</a><a class="category" href="/category/GAME/A/lives">게임 하나</a><span>100명 시청</span>`;
    // 사이트 격자에서 뒤에 붙은 카드는 다른 칸에 있어요(같은 칸의 같은 링크는 한 번만 세요).
    const rect = () => ({ width: 320, height: 180, left: 360, top: 100, right: 680, bottom: 280, x: 360, y: 100 });
    for (const element of [card, ...card.querySelectorAll("a, img")]) element.getBoundingClientRect = rect;
    window.document.getElementById("grid").appendChild(card);
    return card;
}

function visibleCardsFor(window, channel) {
    return [...window.document.querySelectorAll(`#grid > *`)].filter(
        (card) => card.querySelector(`a[href="/live/${channel}"]`) && card.getAttribute("data-bcgt-hide") !== "1"
    );
}

function withTimeZone(t, zone) {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    t.after(() => {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
    });
}

test("R1-26 latest sort scrolling never pages the popular metadata API it cannot use", async (t) => {
    const ui = await createCategoryUI(t);
    const buttons = ui.window.document.querySelectorAll("#sort button");
    buttons[0].removeAttribute("aria-selected");
    buttons[1].setAttribute("aria-selected", "true");
    ui.hooks.listSearch("게임");
    await ui.hooks.apply();
    await settle();
    const requests = popularListRequests(ui);
    assert.equal(ui.hooks.metadataState().pagesLoaded, 0, "the latest sort does not load popular metadata");

    for (let i = 0; i < 3; i++) {
        ui.window.dispatchEvent(new ui.window.Event("scroll"));
        runTimers(ui, (timer) => timer.delay <= 200);
        await settle();
    }
    assert.equal(popularListRequests(ui), requests, "scrolling near the bottom requests no unused popular pages");
    assert.equal(ui.hooks.metadataState().pagesLoaded, 0);
    assert.equal(ui.window.document.getElementById(BAR_ID).getAttribute("data-loading"), "0");
});

test("R1-27 a rescued invisible global toolbar stays in the fallback host instead of bouncing", async (t) => {
    const ui = await createCategoryUI(t);
    const { document } = ui.window;
    const sortLine = document.getElementById("sort");
    const bar = document.getElementById(BAR_ID);
    assert.equal(bar.parentElement, sortLine, "the toolbar is first mounted in the sort line");
    // JSDOM에는 레이아웃이 없어 툴바 크기가 0이에요. 정렬 줄 안에서 보이지 않는 조건이에요.
    runFrames(ui);
    assert.equal(bar.parentElement.id, FALLBACK_ID, "the invisible toolbar is rescued");
    ui.mutation({ type: "childList", target: sortLine, addedNodes: [], removedNodes: [bar] });

    const parents = [];
    for (let i = 0; i < 3; i++) {
        await ui.hooks.apply();
        parents.push(bar.parentElement.id);
        assert.equal(ui.frames.size, 0, "a rescued toolbar does not schedule another rescue frame");
        runFrames(ui);
    }
    assert.deepEqual(parents, [FALLBACK_ID, FALLBACK_ID, FALLBACK_ID]);

    // 사이트가 정렬 줄을 새로 그리면 그 줄에 다시 붙여 봐요.
    const replacement = sortLine.cloneNode(true);
    replacement.id = "sort-new";
    replacement.querySelector(`#${BAR_ID}`)?.remove();
    replacement.querySelector("#cheese-spanner-category-exclusions")?.remove();
    replacement.getBoundingClientRect = sortLine.getBoundingClientRect;
    const originalButtons = sortLine.querySelectorAll("button");
    replacement.querySelectorAll("button").forEach((button, i) => {
        button.getBoundingClientRect = originalButtons[i].getBoundingClientRect;
    });
    sortLine.replaceWith(replacement);
    await ui.hooks.apply();
    assert.equal(bar.parentElement, replacement, "a new sort line is tried again");
});

test("R2-101 an original card that arrives after an injected card replaces it and is judged", async (t) => {
    const ui = await createCategoryUI(t, {
        metadata: [liveMeta("a"), liveMeta("b"), liveMeta("c"), liveMeta("d"), liveMeta("e")],
    });
    ui.hooks.listSearch("게임");
    await ui.hooks.apply();
    await settle();
    const { document } = ui.window;
    assert.equal(document.querySelectorAll('[data-bcgt-injected="1"]').length, 2, "d and e are injected");
    assert.equal(visibleCardsFor(ui.window, "channel-d").length, 1);

    const native = nativeCard(ui.window, "d", "게임 하나 Delta");
    await ui.hooks.apply();
    await settle();
    assert.deepEqual(visibleCardsFor(ui.window, "channel-d"), [native], "the same broadcast is shown once");
    assert.equal(native.getAttribute("data-bcgt-card"), "1", "the original card is tracked");
    assert.equal(document.querySelectorAll('[data-bcgt-injected="1"]').length, 1);

    // 이후 판정 변화도 원본 카드에 적용돼요.
    ui.hooks.listSearch("Alpha");
    await ui.hooks.apply();
    await settle();
    assert.equal(native.getAttribute("data-bcgt-hide"), "1", "the original card follows the current conditions");
    assert.deepEqual(visibleCardsFor(ui.window, "channel-d"), []);
});

test("R2-101 a duplicated original card follows the hide decision of the first card", async (t) => {
    const ui = await createCategoryUI(t);
    const duplicate = nativeCard(ui.window, "a", "게임 하나 Alpha");
    ui.hooks.listSearch("Beta");
    await ui.hooks.apply();
    await settle();
    assert.equal(ui.window.document.getElementById("a").getAttribute("data-bcgt-hide"), "1");
    assert.equal(duplicate.getAttribute("data-bcgt-hide"), "1", "the duplicate cannot bypass the search");
    assert.deepEqual(
        visibleCardsFor(ui.window, "channel-b").map((card) => card.id),
        ["b"]
    );
    ui.hooks.listSearch("");
    await ui.hooks.apply();
    await settle();
    assert.equal(duplicate.hasAttribute("data-bcgt-hide"), false, "clearing conditions shows both site cards again");
});

test("R2-103 removing the follower filter between hydration passes clears the follower spinner", async (t) => {
    const ui = await createCategoryUI(t, { options: { categoryToolsFollowerFetchMaxPerPass: 1 } });
    const bar = ui.window.document.getElementById(BAR_ID);
    ui.hooks.listSearch("게임");
    ui.hooks.numeric("followers", 1000);
    await ui.hooks.apply();
    await settle();
    assert.equal(bar.getAttribute("data-loading"), "1", "the first follower pass is still continuing");
    assert.ok(
        [...ui.timers.values()].some((timer) => timer.delay === 700),
        "the next pass is queued"
    );

    ui.hooks.numeric("followers", 0);
    await ui.hooks.apply();
    await settle();
    runTimers(ui, (timer) => timer.delay === 700);
    await settle();
    assert.equal(bar.getAttribute("data-loading"), "0", "no lookup is left to clear the follower loading");
    assert.equal(ui.hooks.appliedQuery(), "게임", "the search term stays applied");
});

// 치지직 openDate처럼 시간대 표시 없는 KST 글자예요. 도구가 처음 적용될 때 실제 시각으로 배지를 쓰므로
// 시작 시각도 실제 시각 기준 2시간 전으로 만들어요.
function kstText(ms) {
    return new Date(ms + 9 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
}

for (const [zone, label] of [
    ["UTC", "a zone west of KST"],
    ["Australia/Sydney", "a zone east of KST"],
]) {
    test(`R1-28 live elapsed filter and badge read KST openDate in ${label} (${zone})`, async (t) => {
        withTimeZone(t, zone);
        const openDate = kstText(Date.now() - 2 * 3600_000);
        const ui = await createCategoryUI(t, {
            options: { categoryToolsLiveElapsedEnabled: true },
            metadata: ["a", "b", "c"].map((id) => liveMeta(id, { openDate })),
        });
        const card = ui.window.document.getElementById("a");
        const badge = card.querySelector('[data-bcgt-live-elapsed-badge="1"]');
        assert.match(badge?.textContent || "", /^02:00:\d\d$/, "the badge shows 2 hours of KST elapsed time");
        ui.hooks.numeric("duration", 3600);
        await ui.hooks.apply();
        await settle();
        assert.equal(card.getAttribute("data-bcgt-hide"), null, "a broadcast running for 2 hours passes 1 hour+");
        ui.hooks.numeric("duration", 0, 3 * 3600);
        await ui.hooks.apply();
        await settle();
        assert.equal(card.getAttribute("data-bcgt-hide"), null, "and also passes 3 hours or less");
    });
}

function createCategoryRoutePage(t) {
    const dom = new JSDOM(
        '<body><section id="section"><nav id="tabs"><button>라이브</button><button>동영상</button><button>클립</button></nav><main id="grid"></main></section></body>',
        {
            url: "https://chzzk.naver.com/category/GAME/League_of_Legends/lives",
            runScripts: "outside-only",
            pretendToBeVisual: true,
        }
    );
    t.after(() => dom.window.close());
    const { window } = dom;
    const { document } = window;
    const rects = new WeakMap();
    const zero = { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    const setRect = (el, left, top, width, height) =>
        rects.set(el, { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height });
    window.Element.prototype.getBoundingClientRect = function () {
        return rects.get(this) || zero;
    };
    const layout = () => {
        setRect(document.getElementById("section"), 240, 80, 1400, 3000);
        setRect(document.getElementById("tabs"), 260, 70, 300, 36);
        document.querySelectorAll("#tabs button").forEach((b, i) => setRect(b, 260 + i * 80, 74, 70, 28));
        setRect(document.getElementById("grid"), 260, 180, 1360, 600);
        document.querySelectorAll("#grid > .card").forEach((card, index) => {
            const left = 260 + (index % 4) * 340;
            setRect(card, left, 180, 320, 280);
            card.querySelectorAll("a, img").forEach((el) => setRect(el, left, 180, 320, 180));
        });
    };
    layout();
    const timers = new Map();
    let timerId = 0;
    window.setTimeout = (callback, delay) => {
        const id = ++timerId;
        timers.set(id, { callback, delay });
        return id;
    };
    window.clearTimeout = (id) => timers.delete(id);
    const load = (file) => window.eval(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
    load("shared/settings.js");
    window.CheeseSpannerSettings.getOptions = () => {};
    load("shared/data.js");
    load("shared/categoryExclusions.js");
    Object.assign(window.CheeseSpanner.utils, {
        bindFeatureOptions() {},
        createMutationObserverSync: () => ({ disconnect() {} }),
        createThrottledDomSync: () => {
            const schedule = () => {};
            schedule.cancel = () => {};
            return schedule;
        },
        async fetchJson() {
            return { content: { data: [], page: { next: null } } };
        },
        normSpace: window.CheeseSpanner.utils.compactSpaces,
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
    for (const module of ["filterModel", "repository", "searchController"]) load(`features/categoryTools/${module}.js`);
    const source = fs.readFileSync(path.join(__dirname, "../features/categoryTools.js"), "utf8");
    const end = source.lastIndexOf("})();");
    assert.ok(end >= 0);
    window.eval(`${source.slice(0, end)}
        globalThis.categoryRouteHooks = {
            ready: (options) => applyInitialOptions(CheeseSpannerSettings.normalizeOptions(options)),
            apply: applyTools,
            query: () => currentQuery,
        };
        ${source.slice(end)}`);
    const hooks = window.categoryRouteHooks;
    hooks.ready({
        categoryToolsEnabled: true,
        categoryToolsFollowerBadgesEnabled: false,
        categoryToolsLiveElapsedEnabled: false,
    });
    return {
        window,
        document,
        hooks,
        timers,
        layout,
        addCards(count) {
            document.getElementById("grid").innerHTML = Array.from(
                { length: count },
                (_, i) =>
                    `<div class="card" id="card-${i}"><a class="thumb" href="/live/channel-${i}"><img width="320" height="180" alt=""></a>` +
                    `<a class="title" href="/live/channel-${i}"><strong>Title ${i}</strong></a><span>${100 + i}명</span></div>`
            ).join("");
            layout();
        },
    };
}

test("R2-102 the first card render keeps the pending category search input apply", async (t) => {
    const page = createCategoryRoutePage(t);
    await page.hooks.apply();
    await settle();
    const bar = page.document.getElementById(BAR_ID);
    assert.ok(bar, "the toolbar mounts on the tab line before cards arrive");
    const input = bar.querySelector('input[type="search"]');
    input.value = "Title 3";
    input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    assert.ok(
        [...page.timers.values()].some((timer) => timer.delay === 120),
        "the input apply is pending"
    );

    page.addCards(4);
    await page.hooks.apply();
    await settle();
    for (const [id, timer] of [...page.timers]) {
        if (timer.delay !== 120) continue;
        page.timers.delete(id);
        timer.callback();
    }
    assert.equal(page.hooks.query(), "Title 3", "the last typed value is still applied");
    await page.hooks.apply();
    await settle();
    const visible = [...page.document.querySelectorAll("#grid > .card")]
        .filter((card) => card.getAttribute("data-bcgt-hide") !== "1")
        .map((card) => card.id);
    assert.deepEqual(visible, ["card-3"]);
    assert.equal(bar.getAttribute("data-search-draft"), "0");
});

// ---- 2차 검토(Codex 실측) 보완 ----
const APPLIED_ID = "cheese-spanner-category-filter-chips";

function setRect(element, left, top, width, height) {
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

function setCardRect(card, left, top) {
    setRect(card, left, top, 320, 280);
    card.querySelectorAll("a, img").forEach((element) => setRect(element, left, top, 320, 180));
}

// 실제 /lives 배치예요(02-sorts 실측: 툴바는 라이브·동영상 탭 줄의 category-inline, 카드는 y=261부터).
// 정렬 줄은 탭 줄 아래 220px 경계 바로 위에 있고, 검색을 적용하면 탭 줄 안의 적용 조건 줄만큼
// 정렬 줄과 카드가 아래로 밀려요. 조건 줄 높이(30px)와 밀림(40px)은 fixture 값이에요.
function useNativeTabLineLayout(ui, shift = 40) {
    const { window } = ui;
    const { document } = window;
    const tabs = document.createElement("nav");
    tabs.id = "tabs";
    tabs.innerHTML = '<a href="/lives" aria-current="page">라이브</a><a href="/videos">동영상</a>';
    document.body.insertBefore(tabs, document.getElementById("sort"));
    const appliedRow = () => {
        const row = document.getElementById(APPLIED_ID);
        return row?.isConnected && !row.hidden ? row : null;
    };
    const pushed = (element, left, top, width, height) => {
        element.getBoundingClientRect = () => {
            const y = top + (appliedRow() ? shift : 0);
            return { x: left, y, left, top: y, width, height, right: left + width, bottom: y + height };
        };
    };
    setRect(tabs, 20, 130, 1100, 36);
    tabs.querySelectorAll("a").forEach((a, i) => setRect(a, 20 + i * 80, 134, 70, 28));
    pushed(document.getElementById("sort"), 20, 195, 420, 40);
    document.querySelectorAll("#sort button").forEach((button, i) => pushed(button, 20 + i * 80, 200, 60, 30));
    pushed(document.getElementById("grid"), 20, 300, 800, 400);
    document
        .querySelectorAll("#grid > article, #grid > article a, #grid > article img")
        .forEach((element) => pushed(element, 20, 320, 320, 180));
    const base = window.Element.prototype.getBoundingClientRect;
    window.Element.prototype.getBoundingClientRect = function () {
        if (this.id === APPLIED_ID && appliedRow() === this)
            return { x: 20, y: 172, left: 20, top: 172, width: 1100, height: 30, right: 1120, bottom: 202 };
        return base.call(this);
    };
    return { appliedRow };
}

function selectSort(ui, index) {
    ui.window.document
        .querySelectorAll("#sort button")
        .forEach((button, i) => button.setAttribute("aria-selected", i === index ? "true" : "false"));
}

function clickSort(ui, index) {
    selectSort(ui, index);
    ui.outsideClick(ui.window.document.querySelectorAll("#sort button")[index]);
}

async function submitSearch(ui, query) {
    const input = ui.window.document.querySelector(`#${BAR_ID} input[type="search"]`);
    input.value = query;
    ui.trustedKey(input, "Enter");
    await ui.hooks.apply();
    await settle();
}

async function scrollToBottom(ui) {
    for (let i = 0; i < 3; i++) {
        ui.window.dispatchEvent(new ui.window.Event("scroll"));
        runTimers(ui, (timer) => timer.delay <= 200);
        await settle();
    }
}

test("R1-26 latest sort stays detected after Enter shows the applied conditions row and on scroll", async (t) => {
    const ui = await createCategoryUI(t);
    const layout = useNativeTabLineLayout(ui);
    const sortButtons = ui.window.document.querySelectorAll("#sort button");
    clickSort(ui, 1);
    await ui.hooks.apply();
    await settle();
    assert.equal(ui.window.document.getElementById(BAR_ID).getAttribute("data-mode"), "category-inline");
    const requests = popularListRequests(ui);
    // 처음 적용이 채운 공유 페이지 캐시(5분)를 만료시켜, 잘못 판정하면 실제 요청이 나가는 조건으로 봐요.
    const now = ui.window.Date.now;
    ui.window.Date.now = () => now() + 10 * 60_000;

    await submitSearch(ui, "게임");
    assert.equal(ui.hooks.appliedQuery(), "게임");
    assert.ok(layout.appliedRow(), "the applied conditions row is shown on the tab line");
    assert.ok(sortButtons[1].getBoundingClientRect().top >= 220, "the row pushed the sort buttons below 220px");
    assert.equal(popularListRequests(ui), requests, "Enter on the latest sort requests no popular metadata");
    assert.equal(ui.hooks.metadataState().pagesLoaded, 0);

    await scrollToBottom(ui);
    assert.equal(popularListRequests(ui), requests, "scrolling the latest list requests no popular metadata");
    assert.equal(ui.window.document.querySelectorAll('[data-bcgt-injected="1"]').length, 0);
});

test("R1-26 popular sort with the applied conditions row still pages metadata from an empty cache", async (t) => {
    const ui = await createCategoryUI(t, {
        metadata: [liveMeta("a"), liveMeta("b"), liveMeta("c"), liveMeta("d"), liveMeta("e")],
    });
    const layout = useNativeTabLineLayout(ui);
    clickSort(ui, 1);
    await ui.hooks.apply();
    await settle();
    await submitSearch(ui, "게임");
    assert.ok(layout.appliedRow());
    const requests = popularListRequests(ui);

    // 양성 대조: 같은 배치에서 인기순을 누르면 비운 캐시에서 다시 메타데이터를 받고 추가 카드를 붙여요.
    // 처음 적용이 채운 공유 페이지 캐시(5분)도 만료시켜 실제 요청이 다시 나가는지 봐요.
    const now = ui.window.Date.now;
    ui.window.Date.now = () => now() + 10 * 60_000;
    clickSort(ui, 0);
    assert.equal(ui.hooks.metadataState().pagesLoaded, 0, "the sort click empties the metadata cache");
    await ui.hooks.apply();
    await settle();
    assert.ok(popularListRequests(ui) > requests, "the popular sort requests metadata");
    assert.ok(ui.hooks.metadataState().pagesLoaded >= 1);
    assert.equal(ui.window.document.querySelectorAll('[data-bcgt-injected="1"]').length, 2, "d and e are injected");
});

test("R1-26 a sort selection changed while the applied conditions row is shown is read from the buttons", async (t) => {
    const ui = await createCategoryUI(t, {
        metadata: [liveMeta("a"), liveMeta("b"), liveMeta("c"), liveMeta("d"), liveMeta("e")],
    });
    const layout = useNativeTabLineLayout(ui);
    await ui.hooks.apply();
    await settle();
    await submitSearch(ui, "게임");
    assert.ok(layout.appliedRow());
    assert.equal(ui.window.document.querySelectorAll('[data-bcgt-injected="1"]').length, 2, "popular injects d and e");

    // 우리 클릭 기록 없이 사이트가 선택을 최신순으로 다시 그려도(조건 줄 때문에 버튼이 220px 아래) 버튼에서 읽어요.
    selectSort(ui, 1);
    await ui.hooks.apply();
    await settle();
    assert.equal(
        ui.window.document.querySelectorAll('[data-bcgt-injected="1"]').length,
        0,
        "popular-only cards are removed from the latest list"
    );
    const requests = popularListRequests(ui);
    await scrollToBottom(ui);
    assert.equal(popularListRequests(ui), requests);
});

test("R1-26 a sort row the site briefly stops rendering keeps the confirmed latest sort", async (t) => {
    const ui = await createCategoryUI(t, {
        metadata: [liveMeta("a"), liveMeta("b"), liveMeta("c"), liveMeta("d"), liveMeta("e")],
    });
    useNativeTabLineLayout(ui);
    clickSort(ui, 1);
    await ui.hooks.apply();
    await settle();
    await submitSearch(ui, "게임");
    const requests = popularListRequests(ui);
    const now = ui.window.Date.now;
    ui.window.Date.now = () => now() + 10 * 60_000;

    // 사이트가 정렬 줄을 잠시 그리지 않아 버튼을 못 읽어도 같은 목록에서 확인한 최신순을 유지해요.
    const sortRow = ui.window.document.getElementById("sort");
    const placeholder = ui.window.document.createComment("sort row re-rendering");
    sortRow.replaceWith(placeholder);
    await ui.hooks.apply();
    await settle();
    await scrollToBottom(ui);
    assert.equal(popularListRequests(ui), requests, "an unreadable sort row is not treated as the popular sort");
    assert.equal(ui.hooks.metadataState().pagesLoaded, 0);
    assert.equal(ui.window.document.querySelectorAll('[data-bcgt-injected="1"]').length, 0);

    // 다시 그린 버튼이 인기순이면 기억보다 버튼의 현재 선택이 우선해요.
    placeholder.replaceWith(sortRow);
    selectSort(ui, 0);
    await ui.hooks.apply();
    await settle();
    assert.ok(ui.hooks.metadataState().pagesLoaded >= 1, "the visible popular selection wins over the memory");
    assert.equal(ui.window.document.querySelectorAll('[data-bcgt-injected="1"]').length, 2);
});

test("R1-26 switching to latest while a popular apply is in flight cancels its metadata use", async (t) => {
    const ui = await createCategoryUI(t, {
        metadata: [liveMeta("a"), liveMeta("b"), liveMeta("c"), liveMeta("d"), liveMeta("e")],
    });
    useNativeTabLineLayout(ui);
    let requestsAtClick = -1;
    ui.onYield(() => {
        if (requestsAtClick >= 0) return;
        requestsAtClick = popularListRequests(ui);
        clickSort(ui, 1);
    });
    await submitSearch(ui, "게임");
    ui.onYield(null);
    assert.ok(requestsAtClick >= 0, "the sort click happened during the popular apply");
    await ui.hooks.apply();
    await settle();
    await scrollToBottom(ui);
    assert.equal(ui.window.document.querySelectorAll('[data-bcgt-injected="1"]').length, 0);
    assert.equal(popularListRequests(ui), requestsAtClick, "no popular page is requested after the switch");
    assert.equal(ui.hooks.metadataState().pagesLoaded, 0);
    assert.equal(ui.window.document.getElementById(BAR_ID).getAttribute("data-loading"), "0");
});

test("R2-101 an original card in the same column as its injected card replaces it", async (t) => {
    const ui = await createCategoryUI(t, {
        metadata: [liveMeta("a"), liveMeta("b"), liveMeta("c"), liveMeta("d"), liveMeta("e")],
    });
    const { document } = ui.window;
    ui.hooks.listSearch("게임");
    await ui.hooks.apply();
    await settle();
    const injected = [...document.querySelectorAll('[data-bcgt-injected="1"]')].find((card) =>
        card.querySelector('a[href="/live/channel-d"]')
    );
    assert.ok(injected, "d is injected");
    // 실제 화면처럼 추가 카드도 보이는 자리에 있고, 원본은 같은 열(x)·다른 행(y)에 붙어요.
    setCardRect(injected, 20, 300);
    const native = nativeCard(ui.window, "d", "게임 하나 Delta");
    setCardRect(native, 20, 600);
    await ui.hooks.apply();
    await settle();
    assert.equal(native.getAttribute("data-bcgt-card"), "1", "the original card in the same column is tracked");
    assert.equal(injected.isConnected, false, "the injected card is removed");
    assert.deepEqual(visibleCardsFor(ui.window, "channel-d"), [native]);
    assert.match(document.querySelector(`#${APPLIED_ID} .bcgt-status`).textContent, /확인한 5개 중 5개/);

    ui.hooks.listSearch("Alpha");
    await ui.hooks.apply();
    await settle();
    assert.equal(native.getAttribute("data-bcgt-hide"), "1", "a later search judges the original card");
    ui.hooks.listSearch("Delta");
    await ui.hooks.apply();
    await settle();
    assert.equal(native.getAttribute("data-bcgt-hide"), null);
    ui.hooks.numeric("views", 150);
    await ui.hooks.apply();
    await settle();
    assert.equal(native.getAttribute("data-bcgt-hide"), "1", "a viewer filter judges the original card");
    ui.hooks.numeric("views", 0);
    ui.emit(state(1, [category("GAME", "A", "게임 하나")]));
    await ui.hooks.apply();
    await settle();
    assert.equal(native.getAttribute("data-bcgt-hide"), "1", "a category exclusion judges the original card");
});

test("R2-101 a duplicated original card in the same column is tracked and judged", async (t) => {
    const ui = await createCategoryUI(t);
    const first = ui.window.document.getElementById("a");
    const duplicate = nativeCard(ui.window, "a", "게임 하나 Alpha");
    setCardRect(duplicate, 20, 600);
    ui.hooks.listSearch("Beta");
    await ui.hooks.apply();
    await settle();
    assert.equal(duplicate.getAttribute("data-bcgt-card"), "1", "the same-column duplicate reaches the entry");
    assert.equal(first.getAttribute("data-bcgt-hide"), "1");
    assert.equal(duplicate.getAttribute("data-bcgt-hide"), "1", "the duplicate cannot bypass the search");
    assert.match(
        ui.window.document.querySelector(`#${APPLIED_ID} .bcgt-status`).textContent,
        /확인한 3개 중 1개/,
        "the duplicate does not add a result"
    );
    ui.hooks.listSearch("");
    ui.emit(state(1, [category("GAME", "A", "게임 하나")]));
    await ui.hooks.apply();
    await settle();
    assert.equal(duplicate.getAttribute("data-bcgt-hide"), "1", "the duplicate follows the category exclusion");
});

for (const [label, change, exclusion] of [
    [
        "category",
        (card) => card.querySelector("a.category").setAttribute("href", "/category/GAME/X/lives"),
        category("GAME", "X", "다른 게임"),
    ],
    [
        "tag",
        (card) => card.insertAdjacentHTML("beforeend", '<a class="tag" href="/lives?tags=금지">금지</a>'),
        category("CHEESE_SPANNER_TAG", "금지", "금지"),
    ],
]) {
    test(`P2 a duplicated original card is judged by its own current ${label}`, async (t) => {
        const ui = await createCategoryUI(t);
        const first = ui.window.document.getElementById("a");
        const duplicate = nativeCard(ui.window, "a", "게임 하나 Alpha");
        change(duplicate);
        ui.emit(state(1, [exclusion]));
        await ui.hooks.apply();
        await settle();
        assert.equal(first.getAttribute("data-bcgt-hide"), null, "the first card keeps its own category and tags");
        assert.equal(duplicate.getAttribute("data-bcgt-hide"), "1", `the duplicate's excluded ${label} hides it`);
    });
}

test("P2 a duplicate reused for another broadcast during an apply keeps no stale decision", async (t) => {
    const ui = await createCategoryUI(t);
    const duplicate = nativeCard(ui.window, "a", "게임 하나 Alpha");
    await ui.hooks.apply();
    await settle();
    assert.equal(duplicate.getAttribute("data-bcgt-card-id"), "channel-a");
    let reused = false;
    ui.onYield(() => {
        if (reused) return;
        reused = true;
        // 사이트가 겹친 카드 노드를 다른 방송(b)으로 재사용해요.
        duplicate
            .querySelectorAll('a[href="/live/channel-a"]')
            .forEach((a) => a.setAttribute("href", "/live/channel-b"));
        duplicate.querySelector("a.title").textContent = "게임 하나 Beta";
    });
    ui.hooks.listSearch("Beta");
    await ui.hooks.apply();
    await settle();
    ui.onYield(null);
    assert.ok(reused, "the node changed broadcast while the apply was yielding");
    assert.equal(ui.window.document.getElementById("a").getAttribute("data-bcgt-hide"), "1");
    assert.equal(duplicate.getAttribute("data-bcgt-hide"), null, "a's stale decision is not written to b's card");

    await ui.hooks.apply();
    await settle();
    assert.equal(duplicate.getAttribute("data-bcgt-card-id"), "channel-b", "the next apply collects the new identity");
    assert.equal(duplicate.getAttribute("data-bcgt-hide"), null, "b matches the search");
});

// 실제 이벤트 순서예요. 확장의 클릭 처리기는 capture 단계라 누른 순간에는 버튼에 이전 선택이 보이고,
// 사이트가 그 뒤에 새 선택을 그려요.
function clickSortBeforeSiteUpdate(ui, index) {
    ui.outsideClick(ui.window.document.querySelectorAll("#sort button")[index]);
}

test("R1-26 a latest click captured before the site redraws survives the site hiding the sort row", async (t) => {
    const ui = await createCategoryUI(t, {
        metadata: [liveMeta("a"), liveMeta("b"), liveMeta("c"), liveMeta("d"), liveMeta("e")],
    });
    useNativeTabLineLayout(ui);
    await ui.hooks.apply();
    await settle();
    await submitSearch(ui, "게임");
    assert.equal(ui.window.document.querySelectorAll('[data-bcgt-injected="1"]').length, 2, "popular injects d and e");
    const now = ui.window.Date.now;
    ui.window.Date.now = () => now() + 10 * 60_000;

    clickSortBeforeSiteUpdate(ui, 1);
    const requestsAtClick = popularListRequests(ui);
    // 사이트가 최신순으로 바꾸면서 정렬 줄을 다시 그리느라 잠시 빼요.
    selectSort(ui, 1);
    const sortRow = ui.window.document.getElementById("sort");
    sortRow.replaceWith(ui.window.document.createComment("sort row re-rendering"));
    await ui.hooks.apply();
    await settle();
    await submitSearch(ui, "하나");
    await scrollToBottom(ui);
    assert.equal(ui.window.document.querySelectorAll('[data-bcgt-injected="1"]').length, 0);
    assert.equal(popularListRequests(ui), requestsAtClick, "no popular page is requested after the latest click");
    assert.equal(ui.hooks.metadataState().pagesLoaded, 0);
});

test("R1-26 a click the site does not apply keeps following the visible popular selection", async (t) => {
    const ui = await createCategoryUI(t, {
        metadata: [liveMeta("a"), liveMeta("b"), liveMeta("c"), liveMeta("d"), liveMeta("e")],
    });
    useNativeTabLineLayout(ui);
    await ui.hooks.apply();
    await settle();
    // 대조군: 사이트가 클릭을 반영하지 않아 인기순이 계속 보이면 보이는 선택을 따라요.
    clickSortBeforeSiteUpdate(ui, 1);
    await submitSearch(ui, "게임");
    assert.ok(ui.hooks.metadataState().pagesLoaded >= 1, "the visible popular selection still uses metadata");
    assert.equal(ui.window.document.querySelectorAll('[data-bcgt-injected="1"]').length, 2);
});

function appliedStatus(ui) {
    return ui.window.document.querySelector(`#${APPLIED_ID} .bcgt-status`)?.textContent || "";
}

function emptyMessages(ui) {
    return ui.window.document.querySelectorAll('[data-bcgt-empty="1"]').length;
}

test("P2 a broadcast whose duplicated card alone matches the search is counted once", async (t) => {
    const ui = await createCategoryUI(t);
    const first = ui.window.document.getElementById("a");
    const duplicate = nativeCard(ui.window, "a", "게임 하나 Zeta");
    ui.hooks.listSearch("Zeta");
    await ui.hooks.apply();
    await settle();
    assert.equal(first.getAttribute("data-bcgt-hide"), "1", "the first card does not match");
    assert.equal(duplicate.getAttribute("data-bcgt-hide"), null, "the duplicate matches the search");
    assert.match(appliedStatus(ui), /확인한 3개 중 1개/);
    assert.equal(emptyMessages(ui), 0, "a visible result shows no empty message");
});

for (const [label, prepare, exclusion] of [
    [
        "category",
        (first, duplicate) => duplicate.querySelector("a.category").setAttribute("href", "/category/GAME/X/lives"),
        category("GAME", "A", "게임 하나"),
    ],
    [
        "tag",
        (first) => first.insertAdjacentHTML("beforeend", '<a class="tag" href="/lives?tags=금지">금지</a>'),
        category("CHEESE_SPANNER_TAG", "금지", "금지"),
    ],
]) {
    test(`P2 a broadcast shown only by its duplicated card's own ${label} is counted once`, async (t) => {
        const ui = await createCategoryUI(t);
        const first = ui.window.document.getElementById("a");
        const duplicate = nativeCard(ui.window, "a", "게임 하나 Alpha");
        prepare(first, duplicate);
        ui.emit(state(1, [exclusion]));
        ui.hooks.listSearch("Alpha");
        await ui.hooks.apply();
        await settle();
        assert.equal(first.getAttribute("data-bcgt-hide"), "1", `the first card's ${label} is excluded`);
        assert.equal(duplicate.getAttribute("data-bcgt-hide"), null, "the duplicate passes the exclusion");
        assert.match(appliedStatus(ui), /확인한 3개 중 1개/);
        assert.equal(emptyMessages(ui), 0);
    });
}

test("P2 a broadcast whose duplicated card alone matches the search is a follower lookup candidate", async (t) => {
    const ui = await createCategoryUI(t);
    nativeCard(ui.window, "a", "게임 하나 Zeta");
    ui.hooks.listSearch("Zeta");
    ui.hooks.numeric("followers", 0, 10_000_000);
    await ui.hooks.apply();
    await settle();
    const lookups = ui.fetches.filter(({ url }) => /\/channels\/[^/]+\/followers\/count$/.test(new URL(url).pathname));
    assert.deepEqual(
        lookups.map(({ url }) => new URL(url).pathname.split("/")[4]),
        ["channel-a"],
        "the channel shown only by the duplicate is looked up once"
    );
});

test("P2 a broadcast shown only by its duplicated card keeps its place after its viewers drop", async (t) => {
    const metadata = (views) => [
        liveMeta("a", { concurrentUserCount: views }),
        liveMeta("b", { concurrentUserCount: 200 }),
        liveMeta("c", { concurrentUserCount: 300 }),
    ];
    const ui = await createCategoryUI(t, { metadata: metadata(100) });
    const duplicate = nativeCard(ui.window, "a", "게임 하나 Zeta");
    ui.hooks.listSearch("Zeta");
    ui.hooks.numeric("views", 50);
    await ui.hooks.apply();
    await settle();
    assert.equal(duplicate.getAttribute("data-bcgt-hide"), null);

    // 공유 페이지 캐시(5분)를 넘겨 줄어든 시청자 수를 실제로 다시 받아요.
    const now = ui.window.Date.now;
    ui.window.Date.now = () => now() + 10 * 60_000;
    ui.metadata(metadata(10));
    await ui.hooks.apply();
    await settle();
    assert.equal(ui.window.document.getElementById("a").getAttribute("data-bcgt-hide"), "1");
    assert.equal(duplicate.getAttribute("data-bcgt-hide"), null, "the shown broadcast stays while its viewers drop");
    assert.match(appliedStatus(ui), /확인한 \d+개 중 1개/);
});

// 행 순회는 24행마다 UI에 양보해요. 겹친 카드를 판정한 뒤의 첫 양보에서 사이트가 그 카드를 빼거나
// 다른 방송으로 재사용하는 순서예요. 서로 다른 방송 카드를 30개로 늘려 양보가 행 순회 가운데에 오게 해요.
function addDistinctCards(ui, count) {
    for (let i = 0; i < count; i++) nativeCard(ui.window, `x${i}`, `게임 하나 Other ${i}`);
}

function changeDuplicateAtRowYield(ui, duplicate, change) {
    let stored = duplicate.__bcgtDomFields;
    let reads = 0;
    Object.defineProperty(duplicate, "__bcgtDomFields", {
        configurable: true,
        get() {
            reads++;
            return stored;
        },
        set(value) {
            stored = value;
        },
    });
    const done = { changed: false, readsBefore: 0 };
    ui.onYield(() => {
        // 겹친 카드의 검색 글자는 행 순회에서만 읽어요. 읽힌 뒤의 첫 양보가 행 순회의 양보예요.
        if (done.changed || !reads) return;
        done.changed = true;
        done.readsBefore = reads;
        change(duplicate);
    });
    return done;
}

const duplicateChanges = [
    ["removed", (card) => card.remove()],
    [
        "reused for another broadcast",
        (card) => {
            card.querySelectorAll('a[href="/live/channel-a"]').forEach((a) =>
                a.setAttribute("href", "/live/channel-q")
            );
            card.querySelector("a.title").textContent = "게임 하나 Omega";
        },
    ],
];

for (const [label, change] of duplicateChanges) {
    test(`B1 r4 a duplicate ${label} at the row loop yield is not counted as a result`, async (t) => {
        const ui = await createCategoryUI(t);
        const duplicate = nativeCard(ui.window, "a", "게임 하나 Zeta");
        addDistinctCards(ui, 27);
        const done = changeDuplicateAtRowYield(ui, duplicate, change);
        ui.hooks.listSearch("Zeta");
        await ui.hooks.apply();
        await settle();
        ui.onYield(null);
        assert.ok(done.changed, "the duplicate changed at the row loop yield");
        assert.ok(done.readsBefore > 0, "the duplicate had already matched before the yield");
        assert.equal(ui.window.document.getElementById("a").getAttribute("data-bcgt-hide"), "1");
        assert.match(appliedStatus(ui), /확인한 \d+개 중 0개/, "a broadcast with no current card is not a result");
        assert.equal(emptyMessages(ui), 1, "nothing is shown, so the empty message appears");
    });

    test(`B1 r4 a duplicate ${label} at the row loop yield is not a follower lookup candidate`, async (t) => {
        const ui = await createCategoryUI(t);
        const duplicate = nativeCard(ui.window, "a", "게임 하나 Zeta");
        addDistinctCards(ui, 27);
        const done = changeDuplicateAtRowYield(ui, duplicate, change);
        ui.hooks.listSearch("Zeta");
        ui.hooks.numeric("followers", 0, 10_000_000);
        await ui.hooks.apply();
        await settle();
        ui.onYield(null);
        assert.ok(done.changed && done.readsBefore > 0);
        const lookups = ui.fetches.filter(({ url }) =>
            /\/channels\/[^/]+\/followers\/count$/.test(new URL(url).pathname)
        );
        assert.deepEqual(lookups, [], "no follower count is requested for a card that is gone");
    });
}

test("B1 r4 a duplicate removed at the row loop yield does not enter the viewer display history", async (t) => {
    const metadata = (views) => [
        liveMeta("a", { concurrentUserCount: views }),
        liveMeta("b", { concurrentUserCount: 200 }),
        liveMeta("c", { concurrentUserCount: 300 }),
    ];
    const ui = await createCategoryUI(t, { metadata: metadata(100) });
    const duplicate = nativeCard(ui.window, "a", "게임 하나 Zeta");
    addDistinctCards(ui, 27);
    const done = changeDuplicateAtRowYield(ui, duplicate, (card) => card.remove());
    ui.hooks.listSearch("Zeta");
    ui.hooks.numeric("views", 50);
    await ui.hooks.apply();
    await settle();
    ui.onYield(null);
    assert.ok(done.changed && done.readsBefore > 0);
    assert.match(appliedStatus(ui), /확인한 \d+개 중 0개/);

    // 같은 조건에서 겹친 카드가 다시 붙고 시청자 수가 조건 아래로 줄면, 한 번도 보이지 않은 방송은 숨어야 해요.
    // (대조: "keeps its place after its viewers drop"은 실제로 보였던 방송이 남는 것을 지켜요.)
    const returned = nativeCard(ui.window, "a", "게임 하나 Zeta");
    const now = ui.window.Date.now;
    ui.window.Date.now = () => now() + 10 * 60_000;
    ui.metadata(metadata(10));
    await ui.hooks.apply();
    await settle();
    assert.equal(returned.getAttribute("data-bcgt-card-id"), "channel-a");
    assert.equal(returned.getAttribute("data-bcgt-hide"), "1", "a broadcast never shown is not kept by the history");
    assert.match(appliedStatus(ui), /확인한 \d+개 중 0개/);
});

test("B1 r4 a matched first card reused at the row loop yield is not counted and keeps no stale decision", async (t) => {
    const ui = await createCategoryUI(t);
    const first = nativeCard(ui.window, "p", "게임 하나 Zeta");
    addDistinctCards(ui, 27);
    const done = changeDuplicateAtRowYield(ui, first, (card) => {
        // 사이트가 검색에 맞던 대표 카드 노드를 다른 방송(q)으로 재사용해요.
        card.querySelectorAll('a[href="/live/channel-p"]').forEach((a) => a.setAttribute("href", "/live/channel-q"));
        card.querySelector("a.title").textContent = "게임 하나 Omega";
    });
    ui.hooks.listSearch("Zeta");
    await ui.hooks.apply();
    await settle();
    ui.onYield(null);
    assert.ok(done.changed && done.readsBefore > 0, "the first card matched before the yield reused it");
    assert.match(appliedStatus(ui), /확인한 \d+개 중 0개/, "p is not counted from a node that now shows q");
    assert.equal(first.getAttribute("data-bcgt-hide"), null, "p's decision is not written to q's card");

    await ui.hooks.apply();
    await settle();
    assert.equal(first.getAttribute("data-bcgt-card-id"), "channel-q", "the next apply collects the new identity");
    assert.equal(first.getAttribute("data-bcgt-hide"), "1", "q is judged by its own text and misses the search");
    assert.match(appliedStatus(ui), /확인한 \d+개 중 0개/);
});
