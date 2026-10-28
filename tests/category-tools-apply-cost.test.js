const assert = require("node:assert/strict");
const test = require("node:test");

// 방송 목록 적용 한 번의 비용을 호출 횟수로 지킨다. 결과(보이는 카드)는 그대로여야 한다.
const { CATEGORIES, channelId, createFixture } = require("./helpers/category-tools-page");

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
    const toolbar = fixture.document.getElementById("cheese-spanner-category-tools");
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
    const toolbar = fixture.document.getElementById("cheese-spanner-category-tools");
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
