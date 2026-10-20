const assert = require("node:assert/strict");
const test = require("node:test");
const { createFixture } = require("./helpers/category-tools-page");

// 방송 목록 필터 1단계: 적용 조건 줄, 검색 단어, 이상·이하·범위 메뉴, 탭 동안의 조건 유지.
const QUIET = { categoryToolsFollowerBadgesEnabled: false, categoryToolsLiveElapsedEnabled: false };
const GLOBAL_KEY = "global-lives/lives";

function appliedRow(fixture) {
    return fixture.document.getElementById("betterchzzk-category-filter-chips");
}

function chips(fixture) {
    const row = appliedRow(fixture);
    if (!row || row.hidden) return [];
    return Array.from(row.querySelectorAll(".bcgt-chip-body"), (chip) => chip.textContent);
}

function appliedLabel(fixture) {
    return appliedRow(fixture)?.querySelector(".bcgt-applied-label")?.textContent;
}

function searchInput(fixture) {
    return fixture.document.querySelector('#betterchzzk-category-tools input[type="search"]');
}

function search(fixture, query) {
    const input = searchInput(fixture);
    input.value = query;
    input.dispatchEvent(new fixture.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new fixture.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

function menu(fixture) {
    const bar = fixture.document.getElementById("betterchzzk-category-tools");
    if (bar.getAttribute("data-menu-open") !== "1") bar.querySelector(".bcgt-filter").click();
    return fixture.document.getElementById("betterchzzk-category-filter-menu");
}

function viewersAtLeast(fixture, value) {
    const panel = menu(fixture);
    panel.querySelector('.bcgt-mode[data-filter-kind="views"][data-filter-mode="min"]').click();
    panel.querySelector(`.bcgt-quick[data-filter-kind="views"][data-filter-value="${value}"]`).click();
}

test("search words and the applied-condition row filter together and return after leaving the list", async (t) => {
    const fixture = createFixture(t, { options: QUIET });
    await fixture.apply();
    assert.deepEqual(chips(fixture), [], "no row before any condition");

    search(fixture, "리그 -Channel3");
    await fixture.apply();
    assert.deepEqual(fixture.visibleCardIds().sort(), ["card-0", "card-6", "card-9"]);
    assert.deepEqual(chips(fixture), ["“리그” 포함", "“Channel3” 빼기"]);
    assert.equal(appliedLabel(fixture), "적용 중");
    assert.match(appliedRow(fixture).querySelector(".bcgt-status").textContent, /^확인한 \d+개 중 3개$/);

    viewersAtLeast(fixture, 5000);
    await fixture.apply();
    assert.deepEqual(fixture.visibleCardIds(), ["card-0"]);
    assert.deepEqual(chips(fixture), ["시청자 5천명 이상", "“리그” 포함", "“Channel3” 빼기"]);
    assert.deepEqual(fixture.storedSession().routes[GLOBAL_KEY], {
        savedAt: fixture.storedSession().routes[GLOBAL_KEY].savedAt,
        query: "리그 -Channel3",
        filters: { views: { mode: "min", min: 5000, max: 0 } },
    });

    await fixture.navigate("https://chzzk.naver.com/live/00000000000000000000000000000001");
    assert.equal(appliedRow(fixture), null, "leaving the list removes the row");
    assert.ok(fixture.storedSession().routes[GLOBAL_KEY], "leaving does not erase the tab record");

    await fixture.navigate("https://chzzk.naver.com/lives");
    await fixture.apply();
    assert.equal(searchInput(fixture).value, "리그 -Channel3");
    assert.deepEqual(fixture.visibleCardIds(), ["card-0"]);
    assert.equal(appliedLabel(fixture), "이어서 적용 중");
    assert.equal(
        fixture.document.querySelector("#betterchzzk-category-tools .bcgt-filter-label").textContent,
        "필터 1"
    );

    const viewersChip = appliedRow(fixture).querySelector('[data-remove-kind="views"]');
    assert.equal(viewersChip.getAttribute("aria-label"), "시청자 5천명 이상 해제");
    viewersChip.click();
    await fixture.apply();
    assert.equal(appliedLabel(fixture), "적용 중", "the first change ends the restored state");
    assert.deepEqual(fixture.visibleCardIds().sort(), ["card-0", "card-6", "card-9"]);
    assert.deepEqual(fixture.storedSession().routes[GLOBAL_KEY].filters, {});

    // 단어 칩 해제는 Enter 없이 바로 적용한다.
    appliedRow(fixture).querySelector('[data-remove-term="1"]').click();
    assert.equal(searchInput(fixture).value, "리그");
    await fixture.apply();
    assert.deepEqual(fixture.visibleCardIds().sort(), ["card-0", "card-3", "card-6", "card-9"]);
});

test("a reloaded tab restores its list conditions while other list addresses keep their own", async (t) => {
    const first = createFixture(t, { options: QUIET });
    await first.apply();
    search(first, "리그");
    viewersAtLeast(first, 5000);
    await first.apply();
    const stored = JSON.stringify(first.storedSession());

    const reloaded = createFixture(t, { options: QUIET, session: stored });
    await reloaded.apply();
    assert.equal(searchInput(reloaded).value, "리그");
    assert.deepEqual(reloaded.visibleCardIds(), ["card-0"]);
    assert.equal(appliedLabel(reloaded), "이어서 적용 중");

    await reloaded.navigate("https://chzzk.naver.com/category/GAME/League_of_Legends/lives");
    await reloaded.apply();
    assert.equal(searchInput(reloaded).value, "", "another list does not inherit the conditions");
    assert.deepEqual(chips(reloaded), []);
    search(reloaded, "Title");
    // 카테고리 목록은 Enter 없이 입력 0.12초 뒤에 적용한다.
    await new Promise((resolve) => reloaded.window.setTimeout(resolve, 200));
    await reloaded.apply();
    assert.deepEqual(Object.keys(reloaded.storedSession().routes).sort(), ["GAME/League_of_Legends/lives", GLOBAL_KEY]);

    await reloaded.navigate("https://chzzk.naver.com/lives");
    await reloaded.apply();
    assert.equal(searchInput(reloaded).value, "리그");
    assert.deepEqual(chips(reloaded), ["시청자 5천명 이상", "“리그” 포함"]);
});

test("automatic resets keep the tab record and clear-all removes it without touching exclusions", async (t) => {
    const fixture = createFixture(t, { options: QUIET });
    await fixture.apply();
    fixture.hooks.exclude([fixture.categoryKey("GAME", "League_of_Legends")]);
    search(fixture, "Title");
    viewersAtLeast(fixture, 5000);
    await fixture.apply();
    assert.deepEqual(fixture.visibleCardIds(), [], "card-0 is excluded by category and the rest by viewers");

    fixture.hooks.ready({ ...QUIET, categoryToolsEnabled: false, categoryToolsExclusionsEnabled: true });
    assert.equal(appliedRow(fixture), null);
    assert.ok(fixture.storedSession().routes[GLOBAL_KEY], "turning the feature off does not erase the record");
    fixture.hooks.ready({ ...QUIET, categoryToolsEnabled: true, categoryToolsExclusionsEnabled: true });
    await fixture.apply();
    assert.deepEqual(chips(fixture), ["시청자 5천명 이상", "“Title” 포함"], "turning it back on restores the record");

    appliedRow(fixture).querySelector(".bcgt-applied-clear").click();
    await fixture.apply();
    assert.equal(searchInput(fixture).value, "");
    assert.equal(appliedRow(fixture).hidden, true);
    assert.equal(fixture.storedSession().routes[GLOBAL_KEY], undefined);
    assert.deepEqual(
        fixture.visibleCardIds().sort(),
        ["card-1", "card-10", "card-11", "card-2", "card-4", "card-5", "card-7", "card-8"],
        "category exclusions stay after clearing every condition"
    );
});

test("damaged tab records are ignored and blocked tab storage keeps filters working from memory", async (t) => {
    const damaged = createFixture(t, { options: QUIET, session: "{not json" });
    await damaged.apply();
    assert.deepEqual(chips(damaged), []);
    search(damaged, "Title1");
    await damaged.apply();
    assert.equal(damaged.storedSession().version, 1);
    assert.equal(damaged.storedSession().routes[GLOBAL_KEY].query, "Title1");

    const blocked = createFixture(t, { options: QUIET, blockSessionStorage: true });
    await blocked.apply();
    search(blocked, "Title1");
    viewersAtLeast(blocked, 5000);
    await blocked.apply();
    assert.deepEqual(blocked.visibleCardIds(), [], "Title1x cards have fewer than 5,000 viewers");
    assert.deepEqual(chips(blocked), ["시청자 5천명 이상", "“Title1” 포함"]);
});

test("filter menu modes show matching inputs and reset keeps keyboard focus inside the menu", async (t) => {
    const fixture = createFixture(t, { options: QUIET });
    await fixture.apply();
    const panel = menu(fixture);
    const views = panel.querySelector('[data-filter-group="views"]');
    const pressedMode = () => views.querySelector('.bcgt-mode[aria-pressed="true"]').getAttribute("data-filter-mode");
    const single = views.querySelector('[data-filter-body="single"]');
    const range = views.querySelector('[data-filter-body="range"]');
    assert.equal(views.querySelector(".bcgt-filter-title").textContent, "시청자 수");
    assert.equal(pressedMode(), "none");
    assert.equal(single.hidden, true);
    assert.equal(range.hidden, true);

    views.querySelector('.bcgt-mode[data-filter-mode="max"]').click();
    assert.equal(pressedMode(), "max");
    assert.equal(single.hidden, false);
    assert.equal(views.querySelector('[data-filter-suffix="views"]').textContent, "명 이하");
    assert.deepEqual(
        Array.from(views.querySelectorAll(".bcgt-quick"), (button) => button.textContent),
        ["100명", "500명", "1천명", "3천명", "5천명", "1만명"]
    );
    assert.equal(
        fixture.document.querySelector(".bcgt-filter-label").textContent,
        "필터",
        "a mode alone is no condition"
    );

    const value = views.querySelector('[data-filter-value-input="views"]');
    value.value = "2천";
    value.dispatchEvent(new fixture.window.Event("input", { bubbles: true }));
    assert.equal(fixture.document.querySelector(".bcgt-filter-label").textContent, "필터 1");
    assert.deepEqual(chips(fixture), ["시청자 2천명 이하"]);

    views.querySelector('.bcgt-mode[data-filter-mode="range"]').click();
    assert.equal(range.hidden, false);
    assert.equal(single.hidden, true);
    assert.equal(views.querySelector('[data-filter-min-input="views"]').value, "");
    assert.equal(views.querySelector('[data-filter-max-input="views"]').value, "2,000");

    views.querySelector('.bcgt-mode[data-filter-mode="min"]').click();
    assert.equal(value.value, "2천", "the typed text stays while the value is the same");

    const reset = panel.querySelector("[data-filter-reset]");
    reset.focus();
    reset.click();
    assert.equal(reset.disabled, true);
    assert.ok(fixture.document.activeElement.classList.contains("bcgt-mode"), "focus moves to the first mode button");
    fixture.document.activeElement.dispatchEvent(
        new fixture.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    assert.equal(panel.getAttribute("data-open"), "0");
    assert.equal(
        fixture.document.activeElement,
        fixture.document.querySelector("#betterchzzk-category-tools .bcgt-filter")
    );
});

test("the applied-condition row and the exclusion row keep their places without moving each other", async (t) => {
    for (const tabLine of [true, false]) {
        const fixture = createFixture(t, { options: QUIET, tabLine });
        await fixture.apply();
        fixture.hooks.exclude([fixture.categoryKey("GAME", "VALORANT")]);
        search(fixture, "Title");
        await fixture.apply();
        await fixture.apply();
        const row = appliedRow(fixture);
        const summary = fixture.document.getElementById("betterchzzk-category-exclusions");
        assert.ok(row && !row.hidden && summary, `both rows are mounted (tab line: ${tabLine})`);

        const records = [];
        const observer = new fixture.window.MutationObserver((list) => records.push(...list));
        observer.observe(fixture.document.body, { childList: true, subtree: true });
        await fixture.apply();
        records.push(...observer.takeRecords());
        observer.disconnect();
        const moved = records.filter((record) =>
            [...record.removedNodes].some((node) => node === row || node === summary)
        );
        assert.equal(moved.length, 0, `a steady apply moves neither row (tab line: ${tabLine})`);
    }
});

test("the search hint floats outside the clipped tool row and only while the search box has focus", async (t) => {
    const fixture = createFixture(t, { options: QUIET });
    await fixture.apply();
    const input = searchInput(fixture);
    const hint = fixture.document.getElementById("betterchzzk-category-search-hint");
    assert.ok(hint, "the hint exists so aria-describedby resolves");
    assert.equal(input.getAttribute("aria-describedby"), hint.id);
    assert.equal(hint.parentElement, fixture.document.body, "it is not inside a site row that can clip it");
    assert.equal(hint.getAttribute("data-open"), "0");
    input.focus();
    assert.equal(hint.getAttribute("data-open"), "1");
    assert.equal(hint.textContent, "띄어쓰기로 여러 단어를 모두 찾고, -단어는 빼요. Enter로 적용해요.");
    input.blur();
    assert.equal(hint.getAttribute("data-open"), "0");

    await fixture.navigate("https://chzzk.naver.com/category/GAME/League_of_Legends/lives");
    await fixture.apply();
    const categoryHint = fixture.document.getElementById("betterchzzk-category-search-hint");
    assert.equal(
        categoryHint.textContent,
        "띄어쓰기로 여러 단어를 모두 찾고, -단어는 빼요.",
        "category lists apply as you type"
    );
});

test("returning through the back-forward cache marks the remaining conditions as carried over", async (t) => {
    const fixture = createFixture(t, { options: QUIET });
    await fixture.apply();
    search(fixture, "Title");
    await fixture.apply();
    assert.equal(appliedLabel(fixture), "적용 중");
    const pageshow = new fixture.window.Event("pageshow");
    Object.defineProperty(pageshow, "persisted", { value: true });
    fixture.window.dispatchEvent(pageshow);
    assert.equal(appliedLabel(fixture), "이어서 적용 중");

    const fresh = new fixture.window.Event("pageshow");
    Object.defineProperty(fresh, "persisted", { value: false });
    searchInput(fixture).value = "Title2";
    search(fixture, "Title2");
    fixture.window.dispatchEvent(fresh);
    assert.equal(appliedLabel(fixture), "적용 중", "a normal page show does not relabel");
});
