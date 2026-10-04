const assert = require("node:assert/strict");
const test = require("node:test");
const { createCategoryUI, category, state, settle, CATEGORY_KEY } = require("./helpers/category-exclusions-ui.js");
const {
    createCategoryExclusionsStorage,
    createCategoryExclusionsWorker,
} = require("./helpers/category-exclusions-worker.js");

const result = (items) => ({ code: 200, content: { results: items } });
const hidden = (ui, id) => ui.window.document.getElementById(id).getAttribute("data-bcgt-hide") === "1";
async function search(ui, keyword, categories) {
    ui.input(keyword);
    ui.runDelay();
    ui.searches.at(-1).resolve(result(categories));
    await settle();
}

function withState(revision, categories) {
    return createCategoryExclusionsWorker(
        createCategoryExclusionsStorage({ [CATEGORY_KEY]: state(revision, categories) })
    );
}

test("viewer-ranked search hides zero candidates while preserving saved exclusions and stores identity only", async (t) => {
    const worker = withState(1, [category()]);
    const ui = await createCategoryUI(t, { worker, categoryCounts: { A: 0, low: 5, high: 200 } });
    const menu = ui.open();
    await search(ui, "게임", [category(), category("GAME", "low", "낮음"), category("GAME", "high", "높음")]);
    assert.deepEqual(
        [...menu.querySelectorAll("[data-category-add]")].map((button) => button.getAttribute("aria-label")),
        ["높음 제외", "낮음 제외"]
    );
    assert.ok(menu.querySelector('button[aria-label="게임 하나 제외 해제"]'));
    assert.equal(
        worker.storage.local[CATEGORY_KEY].categories.length,
        1,
        "zero viewers never delete a saved exclusion"
    );
    ui.trustedClick(menu.querySelector("[data-category-add]"));
    await settle();
    const saved = worker.storage.local[CATEGORY_KEY].categories.find((item) => item.categoryId === "high");
    assert.deepEqual(Object.keys(saved).sort(), ["categoryId", "categoryType", "categoryValue"]);
    assert.equal(menu.querySelector("[data-category-add]").disabled, true);
});

async function deleteCategoryKey(worker) {
    await new Promise((resolve) => worker.storage.chrome.storage.local.remove(CATEGORY_KEY, resolve));
    assert.equal(Object.hasOwn(worker.storage.local, CATEGORY_KEY), false);
}

async function writeCategoryState(worker, value) {
    await new Promise((resolve) => worker.storage.chrome.storage.local.set({ [CATEGORY_KEY]: value }, resolve));
}

async function addSelectedCategory(ui, selected) {
    ui.open();
    await search(ui, selected.categoryValue, [selected]);
    ui.trustedClick(ui.window.document.querySelector("[data-category-add]"));
    await settle();
}

test("category exclusions mount only in global lives, restore exact identities, and numeric reset preserves them", async (t) => {
    const storage = createCategoryExclusionsStorage({ [CATEGORY_KEY]: state(3, [category()]) });
    const ui = await createCategoryUI(t, { worker: createCategoryExclusionsWorker(storage) });
    const menu = ui.open();
    assert.ok(menu.querySelector("[data-category-exclusions]"));
    assert.equal(menu.firstElementChild, menu.querySelector("[data-category-exclusions]"));
    assert.equal(menu.querySelector("[data-filter-reset]").disabled, true);
    assert.equal(ui.window.document.querySelector(".bcgt-filter-label").textContent, "필터 1");
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), true);
    assert.equal(hidden(ui, "b"), false, "the same ID in a different type is not excluded");
    assert.equal(hidden(ui, "c"), false, "a matching title is not a category identity");
    ui.hooks.numeric("views", 100);
    await ui.hooks.apply();
    assert.equal(menu.querySelector("[data-filter-reset]").disabled, false);
    menu.querySelector("[data-filter-reset]").click();
    await ui.hooks.apply();
    assert.equal(menu.querySelector("[data-filter-reset]").disabled, true);
    assert.equal(ui.window.document.querySelector(".bcgt-filter-label").textContent, "필터 1");
    assert.equal(hidden(ui, "a"), true);
    assert.equal(storage.local[CATEGORY_KEY].revision, 3);
    ui.dom.reconfigure({ url: "https://chzzk.naver.com/category/GAME/A/lives" });
    ui.hooks.pageChange();
    assert.equal(ui.window.document.querySelector("[data-category-exclusions]"), null);
    assert.equal(hidden(ui, "a"), false);
});

test("category search requires trusted explicit selection and commits only after storage succeeds", async (t) => {
    const ui = await createCategoryUI(t);
    const menu = ui.open();
    ui.input("게임");
    assert.match(menu.querySelector("[data-category-search-status]").textContent, /입력/);
    ui.runDelay();
    assert.equal(ui.searches.length, 1);
    ui.searches[0].resolve(
        result([category(), category("SPORTS", "A", "게임 하나"), category("ETC", "Talk", "이야기")])
    );
    await settle();
    let button = menu.querySelector("[data-category-add]");
    assert.ok(button);
    assert.equal(menu.querySelectorAll(".bcgt-category-type")[0].textContent, "게임 · 시청자 1명");
    assert.equal(menu.querySelectorAll(".bcgt-category-type")[1].textContent, "SPORTS · 시청자 1명");
    assert.equal(menu.querySelectorAll(".bcgt-category-type")[2].textContent, "기타 · 시청자 1명");
    button.click();
    button.dispatchEvent(new ui.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    assert.equal(
        ui.messages.filter((message) => message.operation.kind === "add").length,
        0,
        "page-generated events cannot issue storage mutations"
    );
    const gate = ui.worker.storage.pauseNext("set");
    ui.trustedClick(button);
    await gate.started;
    assert.equal(button.disabled, true);
    assert.match(button.textContent, /저장/);
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), false, "pending storage does not commit a selection");
    gate.release();
    await settle();
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), true);
    assert.ok(menu.querySelector('button[aria-label="게임 하나 제외 해제"]'));
    assert.equal(ui.worker.storage.local[CATEGORY_KEY].categories.length, 1);
    button = menu.querySelector("[data-category-add]");
    assert.equal(button.disabled, true);
    assert.match(button.textContent, /제외 중/);
});

test("two open menus share sequential additions and individual removal through the packaged worker", async (t) => {
    const worker = withState(0, []);
    const first = await createCategoryUI(t, { worker });
    const second = await createCategoryUI(t, { worker });
    first.open();
    second.open();
    await search(first, "하나", [category()]);
    await search(second, "다른 유형", [category("SPORTS", "A", "게임 하나")]);
    const gate = worker.storage.pauseNext("set");
    first.trustedClick(first.window.document.querySelector("[data-category-add]"));
    await gate.started;
    t.after(() => {
        if (worker.storage.local[CATEGORY_KEY].revision === 0) gate.release();
    });
    second.trustedClick(second.window.document.querySelector("[data-category-add]"));
    await settle();
    assert.equal(worker.storage.local[CATEGORY_KEY].categories.length, 0);
    gate.release();
    await settle();
    assert.equal(worker.storage.local[CATEGORY_KEY].categories.length, 2);
    for (const ui of [first, second]) {
        assert.equal(ui.window.document.querySelectorAll("[data-category-remove]").length, 2);
        await ui.hooks.apply();
        assert.equal(hidden(ui, "a"), true);
        assert.equal(hidden(ui, "b"), true);
    }
    second.trustedClick(second.window.document.querySelector("[data-category-remove]"));
    await settle();
    assert.equal(worker.storage.local[CATEGORY_KEY].categories.length, 1);
    for (const ui of [first, second]) {
        assert.equal(ui.window.document.querySelectorAll("[data-category-remove]").length, 1);
        await ui.hooks.apply();
        assert.equal(hidden(ui, "a"), false);
        assert.equal(hidden(ui, "b"), true);
    }
});

test("search composition, empty input and close cancel only search work without erasing selections", async (t) => {
    const ui = await createCategoryUI(t, { worker: withState(1, [category()]) });
    const menu = ui.open();
    ui.input("가", "compositionstart");
    ui.input("게임");
    assert.equal(ui.timers.size, 0);
    assert.equal(ui.searches.length, 0);
    assert.equal(menu.querySelector("[data-category-remove]").disabled, true);
    ui.input("게임", "compositionend");
    ui.runDelay();
    const pending = ui.searches[0];
    assert.match(menu.querySelector("[data-category-search-status]").textContent, /검색하고/);
    ui.input("");
    assert.equal(pending.signal.aborted, true);
    assert.equal(ui.searches.length, 1);
    pending.resolve(result([category("GAME", "Late", "이전 검색 결과")]));
    await settle();
    assert.equal(menu.querySelectorAll("[data-category-add]").length, 0);
    assert.equal(menu.querySelectorAll("[data-category-remove]").length, 1);
    ui.input("게임");
    ui.window.document.querySelector(".bcgt-filter").click();
    assert.equal(ui.timers.size, 0);
    assert.equal(menu.getAttribute("data-open"), "0");
    assert.equal(ui.worker.storage.local[CATEGORY_KEY].categories.length, 1);
    ui.open();
    assert.equal(menu.querySelector("[data-category-search]").value, "");
    assert.equal(ui.searches.length, 1);
});

test("category search distinguishes empty results, malformed response and timeout; the same input can retry", async (t) => {
    const ui = await createCategoryUI(t, { worker: withState(1, [category()]) });
    const menu = ui.open();
    await search(ui, "없는 게임", []);
    assert.match(menu.querySelector("[data-category-search-status]").textContent, /검색 결과가 없/);
    ui.input("다른 게임");
    ui.runDelay();
    ui.searches.at(-1).resolve({ code: 200, content: { results: "private upstream body" } });
    await settle();
    assert.match(menu.querySelector("[data-category-search-status]").textContent, /실패/);
    assert.equal(menu.textContent.includes("private upstream body"), false);
    menu.querySelector("[data-category-search-retry]").click();
    ui.runDelay();
    const timeout = new Error("private network details");
    timeout.name = "AbortError";
    assert.equal(ui.searches.at(-1).signal.aborted, false);
    ui.searches.at(-1).reject(timeout);
    await settle();
    assert.match(menu.querySelector("[data-category-search-status]").textContent, /실패/);
    assert.equal(menu.querySelectorAll("[data-category-remove]").length, 1);
    menu.querySelector("[data-category-search-retry]").click();
    ui.runDelay();
    ui.searches.at(-1).resolve(result([category("GAME", "NoLive", "방송하지 않는 게임")]));
    await settle();
    assert.match(menu.querySelector("[data-category-results]").textContent, /방송하지 않는 게임/);
    assert.equal(ui.worker.storage.local[CATEGORY_KEY].categories.length, 1);
});

test("out-of-order category searches and detached menus cannot publish an old result", async (t) => {
    const ui = await createCategoryUI(t);
    const menu = ui.open();
    ui.input("이전");
    ui.runDelay();
    const old = ui.searches[0];
    ui.input("현재");
    ui.runDelay();
    ui.searches[1].resolve(result([category("GAME", "Current", "현재 게임")]));
    old.resolve(result([category("GAME", "Old", "이전 게임")]));
    await settle();
    assert.match(menu.querySelector("[data-category-results]").textContent, /현재 게임/);
    assert.equal(menu.querySelector("[data-category-results]").textContent.includes("이전 게임"), false);
    ui.input("닫힘");
    ui.runDelay();
    const late = ui.searches.at(-1);
    menu.remove();
    ui.mutation({ type: "childList", target: ui.window.document.body, removedNodes: [menu], addedNodes: [] });
    assert.equal(late.signal.aborted, true);
    late.resolve(result([category("GAME", "Closed", "닫힌 메뉴")]));
    await settle();
    assert.equal(ui.window.document.getElementById(menu.id), null);
    await ui.hooks.apply();
    assert.equal(ui.window.document.querySelectorAll("[data-category-add]").length, 0);
});

test("the initial read completes before exclusion, and newer revisions beat late read and mutation responses", async (t) => {
    const worker = withState(2, [category()]);
    const gate = worker.storage.pauseNext("get");
    const ui = await createCategoryUI(t, { worker });
    await gate.started;
    let released = false;
    t.after(() => {
        if (!released) gate.release();
    });
    const menu = ui.open();
    assert.match(menu.querySelector("[data-category-store-status]").textContent, /불러오고/);
    assert.equal(hidden(ui, "a"), false);
    ui.emit(state(5, [category("SPORTS", "A", "같은 이름")]));
    gate.release();
    released = true;
    await settle();
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), false);
    assert.equal(hidden(ui, "b"), true);
    assert.equal(menu.querySelector("[data-category-selected]").textContent.includes("같은 이름"), true);
    ui.emit(state(4, [category()]));
    ui.emit(state(99, [category()]), "sync");
    await ui.hooks.apply();
    assert.equal(hidden(ui, "b"), true);
});

test("actual key deletion invalidates a paused get and OFF/ON restores a deleted default", async (t) => {
    const ui = await createCategoryUI(t, { worker: withState(3, [category()]) });
    const menu = ui.open();
    ui.emit({ version: 1, revision: 3, categories: "corrupt" });
    const delayed = ui.pauseResponse();
    menu.querySelector("[data-category-store-retry]").click();
    await settle();
    assert.equal(typeof delayed.release, "function");
    delete ui.worker.storage.local[CATEGORY_KEY];
    ui.emit(undefined);
    delayed.release();
    await settle();
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), false);
    assert.equal(menu.querySelectorAll("[data-category-remove]").length, 0);
    ui.emit(state(5, [category()]));
    ui.options({ categoryToolsEnabled: false });
    assert.equal(ui.listeners.size, 0);
    ui.options({ categoryToolsEnabled: true });
    await settle();
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), false);
    assert.equal(ui.worker.storage.categoryWrites.length, 0);
});

test("read, write and corrupt-state failures preserve known selections and reveal no external body", async (t) => {
    const worker = withState(3, [category()]);
    worker.storage.failNext("get");
    const ui = await createCategoryUI(t, { worker });
    const menu = ui.open();
    assert.match(menu.querySelector("[data-category-store-status]").textContent, /불러오지 못/);
    assert.equal(worker.storage.categoryWrites.length, 0);
    menu.querySelector("[data-category-store-retry]").click();
    await settle();
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), true);
    const remove = menu.querySelector("[data-category-remove]");
    worker.storage.failNext("set");
    ui.trustedClick(remove);
    await settle();
    assert.equal(worker.storage.local[CATEGORY_KEY].categories.length, 1);
    assert.equal(remove.disabled, false);
    assert.match(menu.querySelector("[data-category-store-status]").textContent, /못했/);
    assert.equal(menu.textContent.includes("private response body"), false);
    worker.storage.local[CATEGORY_KEY] = { version: 99, revision: 5, categories: [] };
    ui.emit(worker.storage.local[CATEGORY_KEY]);
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), true);
    assert.equal(menu.querySelectorAll("[data-category-remove]").length, 1);
    assert.equal(worker.storage.categoryWrites.length, 0);
});

test("pending writes survive close, SPA and OFF without recreating their old menu", async (t) => {
    for (const boundary of ["close", "route", "off", "end"]) {
        await t.test(boundary, async (subtest) => {
            const ui = await createCategoryUI(subtest);
            const menu = ui.open();
            await search(ui, "게임", [category()]);
            const gate = ui.worker.storage.pauseNext("set");
            ui.trustedClick(menu.querySelector("[data-category-add]"));
            await gate.started;
            let released = false;
            subtest.after(() => {
                if (!released) gate.release();
            });
            if (boundary === "close") ui.window.document.querySelector(".bcgt-filter").click();
            if (boundary === "route") {
                ui.dom.reconfigure({ url: "https://chzzk.naver.com/" });
                ui.hooks.pageChange();
            }
            if (boundary === "off") ui.options({ categoryToolsEnabled: false });
            if (boundary === "end") ui.window.dispatchEvent(new ui.window.Event("pagehide"));
            gate.release();
            released = true;
            await settle();
            assert.equal(ui.worker.storage.local[CATEGORY_KEY].categories.length, 1);
            if (boundary === "close") assert.equal(menu.getAttribute("data-open"), "0");
            else assert.equal(ui.window.document.getElementById(menu.id), null);
            if (boundary === "off") {
                ui.options({ categoryToolsEnabled: true });
                await settle();
                await ui.hooks.apply();
                assert.equal(hidden(ui, "a"), true);
                assert.equal(ui.listeners.size, 1);
            }
            if (boundary === "end") assert.equal(ui.listeners.size, 0);
        });
    }
});

test("original card links outrank stale API and mutations re-evaluate category or channel reuse", async (t) => {
    const ui = await createCategoryUI(t, { worker: withState(1, [category()]) });
    await ui.hooks.apply();
    const card = ui.window.document.getElementById("a");
    const link = card.querySelector(".category");
    assert.equal(hidden(ui, "a"), true);
    const before = ui.schedules();
    link.setAttribute("href", "/category/GAME/Current/lives");
    ui.mutation({ type: "attributes", target: link, attributeName: "href" });
    assert.equal(ui.schedules(), before + 1);
    assert.ok(ui.observer().options.attributeFilter.includes("href"));
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), false, "stale GAME/A metadata must not override the current category link");
    link.setAttribute("href", "/category/GAME/A/lives");
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), true);
    card.querySelectorAll('a[href^="/live/"]').forEach((anchor) => anchor.setAttribute("href", "/live/channel-reused"));
    link.setAttribute("href", "/category/GAME/Other/lives");
    await ui.hooks.apply();
    assert.equal(card.getAttribute("data-bcgt-card-id"), "channel-reused");
    assert.equal(hidden(ui, "a"), false);
    link.setAttribute("href", "/category/game/A/lives");
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), false, "unverified lowercase route variants are not silently case-folded");
});

test("category exclusion is an AND condition even for sticky viewer rows and the native latest or recommended order", async (t) => {
    const ui = await createCategoryUI(t);
    ui.hooks.numeric("views", 100, 150);
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), false);
    ui.emit(state(1, [category()]));
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), true, "a previously visible sticky row cannot bypass category exclusion");
    ui.emit(state(2));
    ui.hooks.listSearch("Beta");
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), true, "list search still participates in the combined predicate");
    ui.hooks.listSearch("");
    ui.hooks.numeric("views", 0);
    ui.emit(state(3, [category()]));
    for (const label of ["최신", "추천"]) {
        ui.window.document
            .querySelectorAll("#sort button")
            .forEach((button) => button.setAttribute("aria-selected", button.textContent === label ? "true" : "false"));
        const before = ui.fetches.length;
        await ui.hooks.apply();
        assert.equal(ui.fetches.length, before, "a non-popular list never borrows the popular metadata endpoint");
        assert.equal(ui.hooks.metadataState().size, 0);
        assert.equal(hidden(ui, "a"), true);
        assert.equal(hidden(ui, "b"), false);
        ui.open();
        assert.equal(ui.window.document.querySelector('[data-filter-group="duration"]').hidden, true);
        ui.window.document.querySelector(".bcgt-filter").click();
    }
});

test("injected cards use bound live metadata and rewrite the template's category link", async (t) => {
    const metadata = [
        {
            liveId: 1,
            liveTitle: "Alpha",
            concurrentUserCount: 100,
            categoryType: "GAME",
            liveCategory: "A",
            liveCategoryValue: "게임 하나",
            channel: { channelId: "channel-a" },
        },
        {
            liveId: 4,
            liveTitle: "새 방송",
            concurrentUserCount: 100,
            liveImageUrl: "https://example.com/new.jpg",
            categoryType: "GAME",
            liveCategory: "New",
            liveCategoryValue: "새 게임",
            channel: { channelId: "channel-new" },
        },
        {
            liveId: 5,
            liveTitle: "차단할 방송",
            concurrentUserCount: 100,
            liveImageUrl: "https://example.com/no.jpg",
            categoryType: "SPORTS",
            liveCategory: "A",
            liveCategoryValue: "게임 하나",
            channel: { channelId: "channel-block" },
        },
    ];
    const ui = await createCategoryUI(t, { worker: withState(1, [category()]), metadata });
    await ui.hooks.apply();
    let injected = ui.window.document.querySelector('[data-bcgt-injected="1"]');
    assert.ok(injected);
    assert.equal(
        injected.getAttribute("data-bcgt-hide"),
        null,
        "cloned GAME/A link cannot hide the GAME/New broadcast"
    );
    assert.equal(injected.querySelector(".category").getAttribute("href"), "/category/GAME/New/lives");
    assert.equal(injected.querySelector(".category").textContent, "새 게임");
    const before = ui.schedules();
    ui.mutation({ type: "attributes", target: injected.querySelector(".category"), attributeName: "href" });
    assert.equal(ui.schedules(), before, "extension-owned link writes do not feed another apply");
    ui.emit(state(2, [category("GAME", "New", "이름이 바뀐 게임")]));
    await ui.hooks.apply();
    assert.equal(ui.window.document.querySelector('[data-bcgt-card-id="channel-new"]'), null);
    ui.emit(state(3, [category("SPORTS", "A", "게임 하나")]));
    await ui.hooks.apply();
    assert.equal(ui.window.document.querySelector('[data-bcgt-card-id="channel-block"]'), null);
    injected = ui.window.document.querySelector('[data-bcgt-card-id="channel-new"]');
    assert.ok(injected);
    injected.querySelectorAll('a[href^="/live/"]').forEach((anchor) => anchor.setAttribute("href", "/live/tampered"));
    ui.emit(state(4, [category("GAME", "New", "새 게임")]));
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), false);
});

test("result order, duplicate selection, fifty-result notice, long names and text safety are preserved", async (t) => {
    const ui = await createCategoryUI(t);
    const menu = ui.open();
    const longName = "긴 한글 이름 ".repeat(20) + '<img src=x onerror="malicious">';
    const items = Array.from({ length: 50 }, (_, i) =>
        category("GAME", `ID-${i}`, i === 0 ? longName : `카테고리 ${i}`)
    );
    await search(ui, "많은 게임", items);
    assert.match(menu.querySelector("[data-category-search-status]").textContent, /최대 50개.*구체화/);
    assert.equal(menu.querySelectorAll("[data-category-add]").length, 50);
    const rows = menu.querySelectorAll(".bcgt-category-row");
    assert.equal(rows[0].querySelector(".bcgt-category-name").textContent, longName);
    assert.equal(rows[1].querySelector(".bcgt-category-name").textContent, "카테고리 1");
    assert.equal(menu.querySelector("[onerror], img"), null);
    for (const button of menu.querySelectorAll("button")) assert.equal(button.type, "button");
    ui.trustedClick(menu.querySelector("[data-category-add]"));
    await settle();
    assert.equal(menu.querySelector("[data-category-add]").disabled, true);
    assert.equal(menu.querySelector("[data-category-remove]").getAttribute("aria-label"), `${longName} 제외 해제`);
    const input = menu.querySelector("[data-category-search]");
    input.focus();
    input.dispatchEvent(new ui.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(menu.getAttribute("data-open"), "0");
    assert.equal(ui.window.document.activeElement, ui.window.document.querySelector(".bcgt-filter"));
    assert.match(
        ui.window.document.getElementById("betterchzzk-category-tools-style").textContent,
        /overflow-wrap:anywhere/
    );
    assert.match(
        ui.window.document.getElementById("betterchzzk-category-tools-style").textContent,
        /var\(--bcgt-menu-field-bg\)/
    );
});

test("count-only and other routes never request exclusions, category search or modify cards", async (t) => {
    const ui = await createCategoryUI(t, {
        worker: withState(5, [category()]),
        options: { categoryToolsEnabled: false, globalLiveCountEnabled: true },
    });
    assert.equal(ui.messages.length, 0);
    assert.equal(ui.listeners.size, 0);
    assert.equal(ui.window.document.querySelector("[data-category-exclusions]"), null);
    assert.equal(ui.window.document.querySelector("[data-bcgt-card], [data-bcgt-hide]"), null);
    assert.equal(ui.searches.length, 0);
    assert.match(ui.window.document.querySelector(".bcgt-live-count").textContent, /방송 3개 · 시청자 합계 600명/);
    for (const pathname of [
        "/",
        "/following",
        "/category/GAME/A/lives",
        "/category/GAME/A/videos",
        "/category/GAME/A/clips",
        "/live/channel-a",
    ]) {
        const other = await createCategoryUI(t, { pathname });
        assert.equal(other.messages.length, 0);
        assert.equal(other.listeners.size, 0);
        assert.equal(other.window.document.querySelector("[data-category-exclusions]"), null);
        assert.equal(other.searches.length, 0);
    }
});

test("category-only filtering avoids follower requests for excluded candidates", async (t) => {
    const ui = await createCategoryUI(t, {
        worker: withState(1, [category()]),
        options: { categoryToolsFollowerBadgesEnabled: true },
    });
    await ui.hooks.apply();
    await settle();
    assert.equal(
        ui.fetches.some((request) => /\/channels\/channel-a\//.test(request.url)),
        false
    );
    assert.equal(
        ui.fetches.some((request) => /\/channels\/channel-b\//.test(request.url)),
        true
    );
    assert.equal(hidden(ui, "a"), true);
});

test("a late mutation response cannot overwrite a newer storage notification or another successful action", async (t) => {
    const ui = await createCategoryUI(t, { worker: withState(1, [category()]) });
    const menu = ui.open();
    const oldResponse = ui.pauseResponse();
    ui.trustedClick(menu.querySelector("[data-category-remove]"));
    await settle();
    assert.equal(typeof oldResponse.release, "function");
    assert.equal(menu.querySelectorAll("[data-category-remove]").length, 0);
    await search(ui, "다른 유형", [category("SPORTS", "A", "스포츠")]);
    ui.trustedClick(menu.querySelector("[data-category-add]"));
    await settle();
    assert.equal(ui.worker.storage.local[CATEGORY_KEY].revision, 3);
    oldResponse.release();
    await settle();
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), false);
    assert.equal(hidden(ui, "b"), true);
    assert.equal(menu.querySelector("[data-category-selected]").textContent.includes("스포츠"), true);
    assert.equal(menu.querySelectorAll("[data-category-remove]").length, 1);
});

test("active category requests and input timers are cancelled on SPA, OFF and document termination", async (t) => {
    for (const boundary of ["route", "off", "end"]) {
        await t.test(boundary, async (subtest) => {
            const ui = await createCategoryUI(subtest);
            ui.open();
            ui.input("게임");
            ui.runDelay();
            const request = ui.searches[0];
            if (boundary === "route") {
                ui.dom.reconfigure({ url: "https://chzzk.naver.com/" });
                ui.hooks.pageChange();
            }
            if (boundary === "off") ui.options({ categoryToolsEnabled: false });
            if (boundary === "end") ui.window.dispatchEvent(new ui.window.Event("pagehide"));
            assert.equal(request.signal.aborted, true);
            assert.equal(ui.timers.size, 0);
            assert.equal(ui.frames.size, 0);
            assert.equal(ui.listeners.size, 0);
            request.resolve(result([category()]));
            await settle();
            assert.equal(ui.window.document.querySelector("[data-category-exclusions]"), null);
            assert.equal(ui.window.document.querySelector("[data-category-add]"), null);
        });
    }
});

test("owned button closures reject cloned buttons and ignore DOM category attributes during trusted selection", async (t) => {
    const ui = await createCategoryUI(t);
    const menu = ui.open();
    await search(ui, "게임", [category()]);
    const button = menu.querySelector("[data-category-add]");
    const clone = button.cloneNode(true);
    clone.dataset.categoryType = "SPORTS";
    clone.dataset.categoryId = "Injected";
    menu.querySelector("[data-category-results]").appendChild(clone);
    clone.click();
    await settle();
    assert.equal(ui.messages.filter((message) => message.operation.kind === "add").length, 0);
    button.dataset.categoryType = "SPORTS";
    button.dataset.categoryId = "Injected";
    button.dataset.categoryValue = "페이지가 바꾼 이름";
    ui.trustedClick(button);
    await settle();
    assert.deepEqual(ui.worker.storage.local[CATEGORY_KEY].categories, [category()]);
    const remove = menu.querySelector("[data-category-remove]");
    remove.click();
    await settle();
    assert.equal(ui.messages.filter((message) => message.operation.kind === "remove").length, 0);
    ui.trustedClick(remove);
    await settle();
    assert.equal(ui.worker.storage.local[CATEGORY_KEY].categories.length, 0);
});

test("the category limit preserves all selections and a new document restores the worker's durable state", async (t) => {
    const existing = Array.from({ length: 100 }, (_, i) => category("GAME", `Saved-${i}`, `저장한 게임 ${i}`));
    const worker = withState(100, existing);
    const ui = await createCategoryUI(t, { worker });
    const menu = ui.open();
    await search(ui, "한도 넘는 게임", [category()]);
    ui.trustedClick(menu.querySelector("[data-category-add]"));
    await settle();
    assert.match(menu.querySelector("[data-category-store-status]").textContent, /최대 100개/);
    assert.equal(worker.storage.local[CATEGORY_KEY].categories.length, 100);
    assert.equal(worker.storage.categoryWrites.length, 0);
    assert.equal(menu.querySelectorAll("[data-category-remove]").length, 100);
    ui.cleanup();
    const reloadedWorker = createCategoryExclusionsWorker(worker.storage);
    const reloaded = await createCategoryUI(t, { worker: reloadedWorker });
    reloaded.open();
    assert.equal(reloaded.window.document.querySelectorAll("[data-category-remove]").length, 100);
    assert.equal(reloaded.worker.storage.local[CATEGORY_KEY].revision, 100);
    assert.equal(reloaded.searches.length, 0, "restoration does not persist or replay a search keyword");
});

test("a category changed during row yielding is rechecked before final visibility", async (t) => {
    const ui = await createCategoryUI(t, { worker: withState(1, [category()]) });
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), true);
    const grid = ui.window.document.getElementById("grid");
    const template = ui.window.document.getElementById("b");
    for (let i = 0; i < 25; i++) {
        const card = template.cloneNode(true);
        card.id = `many-${i}`;
        for (const anchor of card.querySelectorAll('a[href^="/live/"]')) anchor.setAttribute("href", `/live/new-${i}`);
        grid.appendChild(card);
    }
    let yields = 0;
    ui.onYield(() => {
        if (++yields === 2)
            ui.window.document
                .getElementById("a")
                .querySelector(".category")
                .setAttribute("href", "/category/GAME/Allowed/lives");
    });
    await ui.hooks.apply();
    assert.ok(yields >= 2, "the category changes after the first row was scanned, during the bounded row loop");
    assert.equal(
        hidden(ui, "a"),
        false,
        "the current category link must override the earlier excluded candidate decision"
    );
    assert.equal(ui.window.document.getElementById("a").parentElement, grid);
    const original = ui.window.document.getElementById("a");
    original.querySelector(".category").setAttribute("href", "/category/GAME/A/lives");
    ui.onYield(null);
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), true);
    yields = 0;
    ui.onYield(() => {
        if (++yields !== 2) return;
        for (const anchor of original.querySelectorAll('a[href^="/live/"]'))
            anchor.setAttribute("href", "/live/new-broadcast");
        original.querySelector(".category").setAttribute("href", "/category/GAME/Allowed/lives");
    });
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), false, "a reused card cannot retain the previous broadcast's exclusion");
});

test("fresh subscription restores a recreated lower revision after deletion while OFF or outside lives", async (t) => {
    for (const boundary of ["off", "route"]) {
        await t.test(boundary, async (subtest) => {
            const worker = withState(5, [category()]);
            const ui = await createCategoryUI(subtest, { worker });
            await ui.hooks.apply();
            assert.equal(hidden(ui, "a"), true);
            if (boundary === "off") ui.options({ categoryToolsEnabled: false });
            else {
                ui.dom.reconfigure({ url: "https://chzzk.naver.com/" });
                ui.hooks.pageChange();
            }
            assert.equal(ui.listeners.size, 0);
            await deleteCategoryKey(worker);
            const other = await createCategoryUI(subtest, { worker });
            await addSelectedCategory(other, category("SPORTS", "A", "다른 탭의 새 선택"));
            assert.equal(worker.storage.local[CATEGORY_KEY].revision, 1);
            if (boundary === "off") ui.options({ categoryToolsEnabled: true });
            else {
                ui.dom.reconfigure({ url: "https://chzzk.naver.com/lives" });
                ui.hooks.pageChange();
            }
            await settle();
            await ui.hooks.apply();
            const menu = ui.open();
            assert.equal(
                hidden(ui, "a"),
                false,
                "the old revision-five category must not survive authoritative restoration"
            );
            assert.equal(hidden(ui, "b"), true);
            assert.equal(menu.querySelectorAll("[data-category-remove]").length, 1);
            assert.match(menu.querySelector("[data-category-selected]").textContent, /다른 탭의 새 선택/);
            assert.equal(worker.storage.categoryWrites.length, 1, "restoration performs no repair writes");
        });
    }
});

test("a mutation response from a stopped subscription cannot restore categories deleted while OFF", async (t) => {
    const worker = withState(5, [category()]);
    const ui = await createCategoryUI(t, { worker });
    ui.open();
    await search(ui, "새 스포츠", [category("SPORTS", "A", "새 스포츠")]);
    const delayed = ui.pauseResponse();
    let released = false;
    t.after(() => {
        if (!released && typeof delayed.release === "function") delayed.release();
    });
    ui.trustedClick(ui.window.document.querySelector("[data-category-add]"));
    await settle();
    assert.equal(typeof delayed.release, "function");
    assert.equal(worker.storage.local[CATEGORY_KEY].revision, 6);
    assert.equal(worker.storage.local[CATEGORY_KEY].categories.length, 2);
    ui.options({ categoryToolsEnabled: false });
    await deleteCategoryKey(worker);
    ui.options({ categoryToolsEnabled: true });
    await settle();
    await ui.hooks.apply();
    const menu = ui.open();
    assert.equal(menu.querySelectorAll("[data-category-remove]").length, 0);
    delayed.release();
    released = true;
    await settle();
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), false);
    assert.equal(hidden(ui, "b"), false);
    assert.equal(menu.querySelectorAll("[data-category-remove]").length, 0);
    assert.equal(Object.hasOwn(worker.storage.local, CATEGORY_KEY), false);
    assert.equal(worker.storage.categoryWrites.length, 1);
});

test("fresh low-revision notifications beat a delayed restore get while current-generation older revisions are ignored", async (t) => {
    const worker = withState(5, [category()]);
    const ui = await createCategoryUI(t, { worker });
    ui.options({ categoryToolsEnabled: false });
    await deleteCategoryKey(worker);
    const other = await createCategoryUI(t, { worker });
    await addSelectedCategory(other, category("SPORTS", "A", "새 스포츠"));
    const captured = structuredClone(worker.storage.local[CATEGORY_KEY]);
    const delayed = ui.pauseResponse();
    let released = false;
    t.after(() => {
        if (!released && typeof delayed.release === "function") delayed.release();
    });
    ui.options({ categoryToolsEnabled: true });
    await settle();
    assert.equal(typeof delayed.release, "function");
    other.input("새 게임");
    other.runDelay();
    other.searches.at(-1).resolve(result([category("GAME", "C", "새 게임")]));
    await settle();
    other.trustedClick(other.window.document.querySelector("[data-category-add]"));
    await settle();
    assert.equal(worker.storage.local[CATEGORY_KEY].revision, 2);
    await ui.hooks.apply();
    const menu = ui.open();
    assert.equal(hidden(ui, "a"), false);
    assert.equal(hidden(ui, "b"), true);
    assert.equal(
        menu.querySelectorAll("[data-category-remove]").length,
        2,
        "the new subscription must accept its revision-two event before the old get arrives"
    );
    ui.emit(captured);
    delayed.release();
    released = true;
    await settle();
    await ui.hooks.apply();
    assert.equal(menu.querySelectorAll("[data-category-remove]").length, 2);
    assert.equal(menu.querySelector("[data-category-selected]").textContent.includes("새 게임"), true);
    assert.equal(worker.storage.local[CATEGORY_KEY].revision, 2);
});

test("a removed listener cannot become current again after resubscription", async (t) => {
    const worker = withState(5, [category()]);
    const ui = await createCategoryUI(t, { worker });
    const oldListener = [...ui.listeners][0];
    ui.options({ categoryToolsEnabled: false });
    assert.equal(ui.listeners.size, 0);
    ui.options({ categoryToolsEnabled: true });
    await settle();
    oldListener({ [CATEGORY_KEY]: { newValue: state(6, [category("SPORTS", "A", "옛 구독 통지")]) } }, "local");
    await ui.hooks.apply();
    const menu = ui.open();
    assert.equal(hidden(ui, "a"), true);
    assert.equal(hidden(ui, "b"), false);
    assert.equal(menu.querySelector("[data-category-selected]").textContent.includes("옛 구독 통지"), false);
    assert.deepEqual(worker.storage.local[CATEGORY_KEY], state(5, [category()]));
});

test("a fresh empty restore reply cannot erase the recreated revision-one notification that arrived first", async (t) => {
    const worker = withState(5, [category()]);
    const ui = await createCategoryUI(t, { worker });
    ui.options({ categoryToolsEnabled: false });
    await deleteCategoryKey(worker);
    const delayed = ui.pauseResponse();
    let released = false;
    t.after(() => {
        if (!released && typeof delayed.release === "function") delayed.release();
    });
    ui.options({ categoryToolsEnabled: true });
    await settle();
    assert.equal(typeof delayed.release, "function", "the fresh get captured the absent key's empty revision zero");
    assert.equal(Object.hasOwn(worker.storage.local, CATEGORY_KEY), false);
    const other = await createCategoryUI(t, { worker });
    await addSelectedCategory(other, category("SPORTS", "A", "새 스포츠"));
    assert.equal(worker.storage.local[CATEGORY_KEY].revision, 1);
    await ui.hooks.apply();
    const menu = ui.open();
    assert.equal(hidden(ui, "a"), false);
    assert.equal(hidden(ui, "b"), true, "the current subscription accepts revision one before its empty get returns");
    delayed.release();
    released = true;
    await settle();
    await ui.hooks.apply();
    assert.equal(hidden(ui, "b"), true);
    assert.equal(menu.querySelectorAll("[data-category-remove]").length, 1);
    assert.match(menu.querySelector("[data-category-selected]").textContent, /새 스포츠/);
    assert.equal(worker.storage.categoryWrites.length, 1);
});

test("an old mutation failure cannot display an error in a newly restored subscription", async (t) => {
    const worker = withState(5, [category()]);
    const ui = await createCategoryUI(t, { worker });
    ui.open();
    await search(ui, "새 스포츠", [category("SPORTS", "A", "새 스포츠")]);
    worker.storage.failNext("set");
    const delayed = ui.pauseResponse();
    let released = false;
    t.after(() => {
        if (!released && typeof delayed.release === "function") delayed.release();
    });
    ui.trustedClick(ui.window.document.querySelector("[data-category-add]"));
    await settle();
    assert.equal(typeof delayed.release, "function");
    ui.options({ categoryToolsEnabled: false });
    ui.options({ categoryToolsEnabled: true });
    await settle();
    await ui.hooks.apply();
    const menu = ui.open();
    assert.equal(menu.querySelector("[data-category-store-status]").textContent, "");
    delayed.release();
    released = true;
    await settle();
    assert.equal(menu.querySelector("[data-category-store-status]").textContent, "");
    assert.equal(hidden(ui, "a"), true);
    assert.equal(menu.querySelectorAll("[data-category-remove]").length, 1);
    assert.equal(worker.storage.categoryWrites.length, 0);
});

test("a fresh restore read failure preserves the last good state and a retry can adopt a recreated lower revision", async (t) => {
    const worker = withState(5, [category()]);
    const ui = await createCategoryUI(t, { worker });
    ui.options({ categoryToolsEnabled: false });
    await deleteCategoryKey(worker);
    const other = await createCategoryUI(t, { worker });
    await addSelectedCategory(other, category("SPORTS", "A", "새 스포츠"));
    worker.storage.failNext("get");
    ui.options({ categoryToolsEnabled: true });
    await settle();
    await ui.hooks.apply();
    const menu = ui.open();
    assert.equal(hidden(ui, "a"), true, "a real read failure preserves the last known good category");
    assert.equal(hidden(ui, "b"), false);
    assert.match(menu.querySelector("[data-category-store-status]").textContent, /못했/);
    assert.equal(worker.storage.categoryWrites.length, 1);
    menu.querySelector("[data-category-store-retry]").click();
    await settle();
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), false);
    assert.equal(hidden(ui, "b"), true);
    assert.match(menu.querySelector("[data-category-selected]").textContent, /새 스포츠/);
    assert.equal(worker.storage.categoryWrites.length, 1);
});

test("a background write begun before OFF still persists and reaches the new subscription through current notifications", async (t) => {
    const worker = withState(5, [category()]);
    const ui = await createCategoryUI(t, { worker });
    ui.open();
    await search(ui, "새 스포츠", [category("SPORTS", "A", "새 스포츠")]);
    const gate = worker.storage.pauseNext("set");
    let released = false;
    t.after(() => {
        if (!released) gate.release();
    });
    ui.trustedClick(ui.window.document.querySelector("[data-category-add]"));
    await gate.started;
    ui.options({ categoryToolsEnabled: false });
    ui.options({ categoryToolsEnabled: true });
    gate.release();
    released = true;
    await settle();
    await ui.hooks.apply();
    const menu = ui.open();
    assert.equal(worker.storage.local[CATEGORY_KEY].revision, 6);
    assert.equal(worker.storage.local[CATEGORY_KEY].categories.length, 2);
    assert.equal(menu.querySelectorAll("[data-category-remove]").length, 2);
    assert.equal(hidden(ui, "a"), true);
    assert.equal(hidden(ui, "b"), true);
    assert.equal(ui.listeners.size, 1);
});

test("metadata category exclusion requires a valid live binding while original category links remain authoritative", async (t) => {
    const cases = [
        { name: "positive", liveId: 44, excluded: true },
        { name: "zero", liveId: 0, excluded: false },
        { name: "missing", excluded: false },
        { name: "negative", liveId: -1, excluded: false },
        { name: "unsafe", liveId: Number.MAX_SAFE_INTEGER + 1, excluded: false },
        { name: "fractional", liveId: 1.5, excluded: false },
    ];
    for (const example of cases) {
        await t.test(example.name, async (subtest) => {
            const metadata = [
                {
                    liveId: 0,
                    liveTitle: "원본 방송",
                    concurrentUserCount: 100,
                    categoryType: "GAME",
                    liveCategory: "A",
                    liveCategoryValue: "게임 하나",
                    channel: { channelId: "channel-a" },
                },
                {
                    ...("liveId" in example ? { liveId: example.liveId } : {}),
                    liveTitle: "추가 후보",
                    concurrentUserCount: 100,
                    liveImageUrl: "https://example.com/candidate.jpg",
                    categoryType: "GAME",
                    liveCategory: "A",
                    liveCategoryValue: "게임 하나",
                    channel: { channelId: "channel-candidate" },
                },
            ];
            const ui = await createCategoryUI(subtest, { worker: withState(5, [category()]), metadata });
            await ui.hooks.apply();
            assert.equal(
                hidden(ui, "a"),
                true,
                "a native category link does not require API liveId to exclude its original card"
            );
            const candidate = ui.window.document.querySelector('[data-bcgt-card-id="channel-candidate"]');
            if (example.excluded)
                assert.equal(candidate, null, "a verified live/category candidate is excluded before injection");
            else {
                assert.ok(
                    candidate,
                    "missing or invalid live association must not suppress an otherwise eligible metadata candidate"
                );
                assert.equal(candidate.getAttribute("data-bcgt-hide"), null);
            }
        });
    }
});

test("the newest corrupt storage notice survives older get success or failure and can recover by a current read or notification", async (t) => {
    for (const outcome of ["success", "failure"]) {
        await t.test(outcome, async (subtest) => {
            const worker = withState(5, [category()]);
            const ui = await createCategoryUI(subtest, { worker });
            ui.options({ categoryToolsEnabled: false });
            const delayed = ui.pauseResponse();
            let released = false;
            subtest.after(() => {
                if (!released && typeof delayed.release === "function") delayed.release();
            });
            if (outcome === "failure") worker.storage.failNext("get");
            ui.options({ categoryToolsEnabled: true });
            await settle();
            assert.equal(typeof delayed.release, "function");
            assert.equal(delayed.operation.kind, "get");
            assert.equal(delayed.response.ok, outcome === "success");
            if (outcome === "success") assert.deepEqual(delayed.response.state, state(5, [category()]));
            await ui.hooks.apply();
            const menu = ui.open();
            const unsupported = { version: 99, revision: 6, categories: [] };
            await writeCategoryState(worker, unsupported);
            const latestError = menu.querySelector("[data-category-store-status]").textContent;
            const retryEnabledDuringOldRead = !menu.querySelector("[data-category-store-retry]").disabled;
            assert.match(latestError, /저장한 제외 목록을 확인하지 못/);
            assert.equal(menu.querySelector("[data-category-store-retry]").hidden, false);
            const writesAfterNotice = worker.storage.categoryWrites.length;
            delayed.release();
            released = true;
            await settle();
            assert.equal(
                menu.querySelector("[data-category-store-status]").textContent,
                latestError,
                "an earlier read cannot clear or replace the newest corrupt-state error"
            );
            assert.equal(retryEnabledDuringOldRead, true, "a superseded read must not keep the error's retry disabled");
            assert.equal(menu.querySelector("[data-category-store-retry]").hidden, false);
            await ui.hooks.apply();
            assert.equal(hidden(ui, "a"), true);
            assert.equal(menu.querySelectorAll("[data-category-remove]").length, 1);
            assert.deepEqual(worker.storage.local[CATEGORY_KEY], unsupported);
            menu.querySelector("[data-category-store-retry]").click();
            await settle();
            assert.equal(menu.querySelector("[data-category-store-status]").textContent, latestError);
            assert.equal(
                worker.storage.categoryWrites.length,
                writesAfterNotice,
                "a failed retry cannot repair or overwrite corrupt storage"
            );
            const repaired = state(6, [category("GAME", "A", "복구한 선택")]);
            if (outcome === "success") {
                // Withhold this fixture notification to exercise the real worker's get recovery independently.
                const listener = [...ui.listeners][0];
                ui.window.chrome.storage.onChanged.removeListener(listener);
                await writeCategoryState(worker, repaired);
                ui.window.chrome.storage.onChanged.addListener(listener);
                assert.equal(menu.querySelector("[data-category-store-status]").textContent, latestError);
                menu.querySelector("[data-category-store-retry]").click();
                await settle();
            } else await writeCategoryState(worker, repaired);
            assert.equal(menu.querySelector("[data-category-store-status]").textContent, "");
            assert.equal(menu.querySelector("[data-category-store-retry]").hidden, true);
            assert.match(menu.querySelector("[data-category-selected]").textContent, /복구한 선택/);
            assert.equal(worker.storage.categoryWrites.length, writesAfterNotice + 1);
        });
    }
});

test("the newest corrupt storage notice survives older mutation success or failure and releases same-item pending controls", async (t) => {
    for (const outcome of ["success", "failure"]) {
        await t.test(outcome, async (subtest) => {
            const worker = withState(5, [category()]);
            const ui = await createCategoryUI(subtest, { worker });
            const menu = ui.open();
            await search(ui, "새 스포츠", [category("SPORTS", "A", "새 스포츠")]);
            const delayed = ui.pauseResponse();
            let released = false;
            subtest.after(() => {
                if (!released && typeof delayed.release === "function") delayed.release();
            });
            if (outcome === "failure") worker.storage.failNext("set");
            ui.trustedClick(menu.querySelector("[data-category-add]"));
            await settle();
            assert.equal(typeof delayed.release, "function");
            const lastGood = structuredClone(worker.storage.local[CATEGORY_KEY]);
            assert.equal(delayed.operation.kind, "add");
            assert.equal(delayed.response.ok, outcome === "success");
            if (outcome === "success") assert.deepEqual(delayed.response.state, lastGood);
            assert.equal(lastGood.categories.length, outcome === "success" ? 2 : 1);
            const sameItemButton =
                outcome === "success"
                    ? menu.querySelector('button[aria-label="새 스포츠 제외 해제"]')
                    : menu.querySelector("[data-category-add]");
            assert.equal(sameItemButton.disabled, true);
            const malformed = { version: 1, revision: 7, categories: "private storage must not be exposed" };
            await writeCategoryState(worker, malformed);
            const latestError = menu.querySelector("[data-category-store-status]").textContent;
            const pendingReleasedAtNotice = !sameItemButton.disabled;
            assert.match(latestError, /저장한 제외 목록을 확인하지 못/);
            const writesAfterNotice = worker.storage.categoryWrites.length;
            delayed.release();
            released = true;
            await settle();
            assert.equal(
                menu.querySelector("[data-category-store-status]").textContent,
                latestError,
                "an earlier mutation's success, failure and finally cannot replace the latest corrupt-state error"
            );
            assert.equal(
                pendingReleasedAtNotice,
                true,
                "the corrupt-state notice releases pending ownership even if the old mutation response never returns"
            );
            assert.equal(sameItemButton.disabled, false);
            assert.equal(menu.querySelector("[data-category-store-retry]").hidden, false);
            assert.equal(menu.querySelectorAll("[data-category-remove]").length, lastGood.categories.length);
            assert.equal(menu.textContent.includes("private storage"), false);
            assert.deepEqual(worker.storage.local[CATEGORY_KEY], malformed);
            assert.equal(worker.storage.categoryWrites.length, writesAfterNotice);
            menu.querySelector("[data-category-store-retry]").click();
            await settle();
            assert.equal(menu.querySelector("[data-category-store-status]").textContent, latestError);
            assert.deepEqual(worker.storage.local[CATEGORY_KEY], malformed);
            await writeCategoryState(worker, lastGood);
            assert.equal(menu.querySelector("[data-category-store-status]").textContent, "");
            assert.equal(menu.querySelector("[data-category-store-retry]").hidden, true);
            const retryButton =
                outcome === "success"
                    ? menu.querySelector('button[aria-label="새 스포츠 제외 해제"]')
                    : menu.querySelector("[data-category-add]");
            ui.trustedClick(retryButton);
            await settle();
            assert.equal(worker.storage.local[CATEGORY_KEY].categories.length, outcome === "success" ? 1 : 2);
            assert.equal(menu.querySelectorAll("[data-category-remove]").length, outcome === "success" ? 1 : 2);
        });
    }
});

test("real option binding waits for saved count-only settings after DOM ready before excluding any category", async (t) => {
    const ui = await createCategoryUI(t, {
        bootstrapOptions: true,
        options: { categoryToolsEnabled: false, globalLiveCountEnabled: true },
    });
    ui.fireDOMReady();
    await settle();
    assert.equal(ui.optionsReads.length, 1);
    assert.equal(ui.optionsReadPending(), 1);
    assert.equal(ui.categorySubscriptions(), 0, "DOM ready does not confirm the saved feature options");
    assert.equal(ui.messages.length, 0, "no category get may precede the initial saved options callback");
    await new Promise((resolve) => ui.window.chrome.storage.sync.set({ volumeWheelEnabled: false }, resolve));
    await settle();
    assert.equal(ui.optionsReadPending(), 1);
    assert.equal(ui.optionsReads.length, 1);
    assert.equal(
        ui.categorySubscriptions(),
        0,
        "an unrelated option change is not the initial saved-options confirmation"
    );
    assert.equal(
        ui.messages.length,
        0,
        "shared defaults in a change callback cannot activate category tools while its get is pending"
    );
    await ui.hooks.apply();
    assert.equal(ui.fetches.length, 0);
    assert.equal(
        ui.window.document.querySelector(
            "[data-category-exclusions], .bcgt-filter, [data-bcgt-card], [data-bcgt-hide], [data-bcgt-follower-badge]"
        ),
        null
    );
    ui.releaseOptionsRead();
    await settle();
    await ui.hooks.apply();
    await settle();
    assert.equal(ui.categorySubscriptions(), 0);
    assert.equal(ui.messages.length, 0);
    assert.equal(ui.searches.length, 0);
    assert.equal(
        ui.window.document.querySelector(
            "[data-category-exclusions], .bcgt-filter, [data-bcgt-card], [data-bcgt-hide]"
        ),
        null
    );
    assert.match(ui.window.document.querySelector(".bcgt-live-count").textContent, /방송 3개 · 시청자 합계 600명/);
    await new Promise((resolve) => ui.window.chrome.storage.sync.set({ categoryToolsEnabled: true }, resolve));
    await settle();
    await ui.hooks.apply();
    assert.equal(ui.categorySubscriptions(), 1);
    assert.equal(ui.messages.length, 1);
    assert.equal(ui.messages[0].operation.kind, "get");
    assert.ok(ui.window.document.querySelector("[data-category-exclusions]"));
    assert.ok(ui.window.document.querySelector(".bcgt-filter"));
    assert.equal(ui.searches.length, 0);
    await new Promise((resolve) => ui.window.chrome.storage.sync.set({ categoryToolsEnabled: false }, resolve));
    await settle();
    await ui.hooks.apply();
    assert.equal(ui.categorySubscriptions(), 0);
    assert.equal(ui.messages.length, 1);
    assert.equal(
        ui.window.document.querySelector("[data-category-exclusions], [data-bcgt-card], [data-bcgt-hide]"),
        null
    );
    assert.ok(ui.window.document.querySelector(".bcgt-live-count"));
});

test("real option binding starts an initially enabled category feature exactly once when its saved callback arrives", async (t) => {
    const ui = await createCategoryUI(t, {
        bootstrapOptions: true,
        options: { categoryToolsEnabled: true, globalLiveCountEnabled: false },
    });
    ui.fireDOMReady();
    await settle();
    assert.equal(ui.optionsReadPending(), 1);
    assert.equal(ui.messages.length, 0);
    assert.equal(ui.categorySubscriptions(), 0);
    ui.releaseOptionsRead();
    await settle();
    await ui.hooks.apply();
    ui.fireDOMReady();
    await settle();
    await ui.hooks.apply();
    assert.equal(ui.messages.length, 1);
    assert.equal(ui.messages[0].operation.kind, "get");
    assert.equal(ui.categorySubscriptions(), 1);
    assert.equal(ui.optionsReads.length, 1);
    assert.ok(ui.window.document.querySelector("[data-category-exclusions]"));
    assert.equal(ui.window.document.querySelector(".bcgt-live-count"), null);
});

test("global list search keeps a draft until apply or Enter and rejects IME and repeated submissions", async (t) => {
    const ui = await createCategoryUI(t);
    const bar = ui.window.document.getElementById("betterchzzk-category-tools");
    const input = bar.querySelector("input");
    const apply = bar.querySelector(".bcgt-search-apply");
    const event = (type, options = {}) =>
        input.dispatchEvent(
            type.startsWith("key")
                ? new ui.window.KeyboardEvent(type, { key: "Enter", bubbles: true, cancelable: true, ...options })
                : new ui.window.Event(type, { bubbles: true })
        );
    const scheduled = ui.schedules();
    input.value = "Alpha";
    event("input");
    assert.equal(ui.hooks.appliedQuery(), "");
    assert.equal(ui.schedules(), scheduled);
    assert.equal(
        [...ui.timers.values()].some((timer) => timer.delay === 120),
        false
    );
    await ui.hooks.apply();
    assert.equal(hidden(ui, "b"), false, "unrelated refresh cannot apply draft");
    event("compositionstart");
    event("keydown", { isComposing: true });
    event("compositionend");
    event("keydown");
    assert.equal(ui.hooks.appliedQuery(), "");
    event("keyup");
    event("keydown", { keyCode: 229 });
    event("keyup");
    event("keydown", { repeat: true });
    assert.equal(ui.hooks.appliedQuery(), "");
    event("keydown");
    assert.equal(ui.hooks.appliedQuery(), "Alpha");
    const afterSubmit = ui.schedules();
    event("keydown");
    apply.click();
    assert.equal(ui.schedules(), afterSubmit, "same query does not restart work");
    await ui.hooks.apply();
    assert.equal(hidden(ui, "b"), true);
    input.value = "Beta";
    event("input");
    await ui.hooks.apply();
    assert.equal(ui.hooks.appliedQuery(), "Alpha");
    assert.equal(hidden(ui, "b"), true);
    apply.click();
    await ui.hooks.apply();
    assert.equal(hidden(ui, "a"), true);
    assert.equal(hidden(ui, "b"), false);
    bar.querySelector(".bcgt-clear").click();
    assert.equal(ui.hooks.appliedQuery(), "Beta", "clear edits draft only");
    apply.click();
    await ui.hooks.apply();
    assert.equal(ui.hooks.appliedQuery(), "");
    assert.equal(hidden(ui, "a"), false);
});

test("global list draft survives menu close but route changes and new documents reset it", async (t) => {
    const ui = await createCategoryUI(t);
    const bar = ui.window.document.getElementById("betterchzzk-category-tools");
    const input = bar.querySelector("input");
    input.value = "Alpha";
    input.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
    ui.open();
    ui.window.document.querySelector(".bcgt-filter").click();
    assert.equal(input.value, "Alpha");
    assert.equal(ui.hooks.appliedQuery(), "");
    input.dispatchEvent(new ui.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(input.value, "");
    input.value = "Beta";
    ui.dom.reconfigure({ url: "https://chzzk.naver.com/category/GAME/A/lives" });
    ui.hooks.pageChange();
    bar.querySelector(".bcgt-search-apply").click();
    assert.equal(ui.hooks.appliedQuery(), "", "detached old toolbar cannot submit");
    const next = await createCategoryUI(t, { worker: ui.worker });
    assert.equal(next.hooks.appliedQuery(), "");
    assert.equal(next.window.document.querySelector('[aria-label="현재 목록 검색"]').value, "");
});

test("toolbar category boxes show stored exclusions without opening filters and remove only through trusted worker requests", async (t) => {
    const ui = await createCategoryUI(t, { worker: withState(1, [category(), category("SPORTS", "A", "게임 하나")]) });
    const bar = ui.window.document.getElementById("betterchzzk-category-tools");
    const summary = bar.nextElementSibling;
    assert.equal(summary.hidden, false);
    assert.equal(summary.className, "bcgt-category-summary");
    assert.equal(bar.contains(summary), false, "summary cannot wrap the existing search toolbar");
    assert.equal(summary.querySelectorAll(".bcgt-category-row").length, 2);
    assert.notEqual(
        ui.window.document.querySelector("[data-category-exclusions]").parentElement.getAttribute("data-open"),
        "1"
    );
    const button = summary.querySelector("[data-category-summary-remove]");
    button.click();
    await settle();
    assert.equal(ui.worker.storage.local[CATEGORY_KEY].categories.length, 2);
    const gate = ui.worker.storage.pauseNext("set");
    ui.trustedClick(button);
    await gate.started;
    assert.equal(button.disabled, true);
    assert.equal(summary.querySelectorAll(".bcgt-category-row").length, 2);
    gate.release();
    await settle();
    assert.equal(summary.querySelectorAll(".bcgt-category-row").length, 1);
    assert.equal(ui.worker.storage.local[CATEGORY_KEY].categories[0].categoryType, "SPORTS");
    ui.open();
    ui.window.document.querySelector(".bcgt-filter").click();
    assert.equal(summary.hidden, false);
    ui.trustedClick(summary.querySelector("[data-category-summary-remove]"));
    await settle();
    assert.equal(summary.hidden, true);
    assert.equal(ui.worker.storage.local[CATEGORY_KEY].categories.length, 0);
    ui.emit(state(8, [category()]));
    assert.equal(summary.hidden, false);
    ui.dom.reconfigure({ url: "https://chzzk.naver.com/category/GAME/A/lives" });
    ui.hooks.pageChange();
    assert.equal(ui.window.document.querySelector(".bcgt-category-summary"), null);
});
