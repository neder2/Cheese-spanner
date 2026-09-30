const assert = require("node:assert/strict");
const test = require("node:test");
const {
    createFakeChrome,
    createDom,
    evalRepoScript,
    dispatch,
    waitForAsyncCallbacks,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

const key = (id) => `betterChzzkOptionsGroupOpen:${id}`;
const group = (dom, id) => dom.window.document.querySelector(`[data-option-group="${id}"]`);
function openOptions(t, chrome) {
    const dom = createDom("options.html", "options.html", chrome);
    t.after(async () => {
        await waitForAsyncCallbacks();
        dom.window.close();
    });
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    return dom;
}
function search(dom, value) {
    const input = dom.window.document.getElementById("settingsSearch");
    input.value = value;
    dispatch(dom, input, "input");
}

const migratedGroups = [
    ["player-view", ["player-live-display", "player-multiview", "player-zoom"], false, false],
    ["appearance-page", ["header-buttons", "explore-sidebar"], true, true],
    ["appearance-player", ["player-live-display"], false, false],
    ["appearance-blocking", ["player-ads", "popup-adblock"], true, true],
    ["search-video", ["search-basic", "search-comments"], true, false],
    ["explore-following", ["explore-channel", "explore-sidebar", "explore-refresh"], true, true],
    [
        "explore-presets",
        ["explore-presets-followers", "explore-presets-views", "explore-presets-duration"],
        false,
        false,
    ],
];

test("merged groups restore current choices and legacy source combinations without writing them back", async (t) => {
    for (const scenario of [
        "new-closed",
        "new-open",
        "legacy-closed",
        "legacy-mixed",
        "missing",
        "invalid",
        "partial",
    ]) {
        await t.test(scenario, async (t) => {
            const local = { [key("player-volume")]: false, unrelatedHistory: { untouched: true } };
            for (const [id, sources] of migratedGroups) {
                if (scenario === "new-closed" || scenario === "new-open") {
                    local[key(id)] = scenario === "new-open";
                } else if (scenario !== "missing") {
                    local[key(id)] = "invalid";
                }
                for (const [index, source] of sources.entries()) {
                    if (scenario === "missing" || (scenario === "partial" && index !== 0)) continue;
                    local[key(source)] =
                        scenario === "invalid"
                            ? "false"
                            : scenario === "new-closed" || (scenario === "legacy-mixed" && index === 0);
                }
            }
            // Shared legacy sources have the same value for both split destinations.
            if (scenario === "partial") {
                for (const [, sources] of migratedGroups) local[key(sources[0])] = false;
            }
            const chrome = createFakeChrome({ local });
            const writes = [];
            chrome.storage.local.set = (values) => writes.push(values);
            const dom = openOptions(t, chrome);
            await waitForAsyncCallbacks();
            for (const [id, , freshDefault, partialExpected] of migratedGroups) {
                const expected =
                    scenario === "new-open" || scenario === "legacy-mixed"
                        ? true
                        : scenario === "new-closed" || scenario === "legacy-closed"
                          ? false
                          : scenario === "partial"
                            ? partialExpected
                            : freshDefault;
                assert.equal(group(dom, id).open, expected, id);
            }
            assert.equal(group(dom, "player-volume").open, false, "moved groups retain saved opt-outs");
            assert.deepEqual(writes, [], "restoration and migration must not persist inferred state");
            assert.deepEqual(chrome.testState.local, local);
            assert.deepEqual(chrome.testState.sync, {});
        });
    }
});

test("split groups inherit the same old choice then remember independent new choices", async (t) => {
    const chrome = createFakeChrome({ local: { [key("player-live-display")]: true } });
    const dom = openOptions(t, chrome);
    await waitForAsyncCallbacks();
    assert.equal(group(dom, "player-view").open, true);
    assert.equal(group(dom, "appearance-player").open, true);
    group(dom, "player-view").firstElementChild.click();
    dispatch(dom, dom.window, "pagehide");
    assert.equal(chrome.testState.local[key("player-view")], false);
    assert.equal(chrome.testState.local[key("appearance-player")], undefined);
    assert.equal(chrome.testState.local[key("player-live-display")], true);
    const reopened = openOptions(t, chrome);
    await waitForAsyncCallbacks();
    assert.equal(group(reopened, "player-view").open, false);
    assert.equal(group(reopened, "appearance-player").open, true);
    assert.deepEqual(chrome.testState.sync, {});
});

test("late legacy restoration updates the search snapshot without saving its temporary expansion", async (t) => {
    const chrome = createFakeChrome();
    let restore;
    chrome.storage.local.get = (_keys, callback) => {
        restore = callback;
    };
    const writes = [];
    chrome.storage.local.set = (values) => writes.push(values);
    const dom = openOptions(t, chrome);
    search(dom, "보정 게인");
    restore({ [key("player-live-display")]: true, [key("player-volume")]: false });
    assert.equal(group(dom, "player-view").open, false, "hidden groups wait for search clearing to restore");
    dom.window.document.querySelector('[data-tab="sound"]').click();
    assert.equal(group(dom, "player-view").open, true);
    assert.equal(group(dom, "appearance-player").open, true);
    assert.equal(group(dom, "player-volume").open, false);
    assert.equal(group(dom, "player-compressor").open, false);
    await waitForAsyncCallbacks();
    assert.deepEqual(writes, []);
});

test("pending direct choices beat late legacy restoration before search and pagehide", async (t) => {
    const chrome = createFakeChrome();
    let restore;
    chrome.storage.local.get = (_keys, callback) => {
        restore = callback;
    };
    const dom = openOptions(t, chrome);
    group(dom, "appearance-page").firstElementChild.click();
    search(dom, "사이드바");
    assert.equal(group(dom, "appearance-page").open, true);
    restore({ [key("header-buttons")]: true, [key("explore-sidebar")]: true });
    search(dom, "");
    assert.equal(group(dom, "appearance-page").open, false);
    search(dom, "팔로워");
    group(dom, "explore-presets").firstElementChild.click();
    dispatch(dom, dom.window, "pagehide");
    assert.equal(chrome.testState.local[key("explore-presets")], false);
    search(dom, "");
    await waitForAsyncCallbacks();
    assert.equal(group(dom, "explore-presets").open, false);
    assert.deepEqual(chrome.testState.local, { [key("appearance-page")]: false, [key("explore-presets")]: false });
    assert.deepEqual(chrome.testState.sync, {});
});

test("options remember each group without saving feature options, including all collapsed", async (t) => {
    const chrome = createFakeChrome();
    const dom = openOptions(t, chrome);
    group(dom, "player-auto").firstElementChild.click();
    group(dom, "player-compressor").firstElementChild.click();
    await waitForCondition(() => chrome.testState.local[key("player-compressor")] === true);
    assert.equal(chrome.testState.local[key("player-auto")], false);
    assert.deepEqual(chrome.testState.sync, {});

    const reopened = openOptions(t, chrome);
    await waitForCondition(() => group(reopened, "player-compressor").open);
    assert.equal(group(reopened, "player-auto").open, false);
    for (const item of reopened.window.document.querySelectorAll(".option-group[open]")) {
        item.firstElementChild.click();
    }
    await waitForCondition(() => chrome.testState.local[key("player-compressor")] === false);
    const collapsed = openOptions(t, chrome);
    await waitForCondition(() => !collapsed.window.document.querySelector(".option-group[open]"));
});

test("search expansion and clearing never replace the user's saved group choices", async (t) => {
    const chrome = createFakeChrome({ local: { [key("player-auto")]: false } });
    const dom = openOptions(t, chrome);
    await waitForCondition(() => !group(dom, "player-auto").open);
    const before = { ...chrome.testState.local };
    search(dom, "보정 게인");
    assert.equal(group(dom, "player-compressor").open, true);
    // Drain the native details toggle events: programmatic expansion must not write storage.
    await waitForAsyncCallbacks();
    assert.deepEqual(chrome.testState.local, before);
    const reopened = openOptions(t, chrome);
    await waitForAsyncCallbacks();
    assert.equal(group(reopened, "player-compressor").open, false);
    search(dom, "");
    await waitForAsyncCallbacks();
    assert.equal(group(dom, "player-compressor").open, false);
    assert.deepEqual(chrome.testState.local, before);
});

test("history cards restore independent choices and search without changing settings or history", async (t) => {
    const historyKey = globalThis.BetterChzzkWatchHistoryStore.STORAGE_KEY;
    const savedHistory = { records: [], updatedAt: 123 };
    const chrome = createFakeChrome({
        sync: { liveWatchHistoryEnabled: false, liveWatchHistoryMinMinutes: 17 },
        local: { [historyKey]: savedHistory },
    });
    const dom = openOptions(t, chrome);
    const { document } = dom.window;
    const settings = document.querySelector('[data-option="liveWatchHistoryEnabled"]').closest(".option-group");
    const management = document.getElementById("historyBackupGuide").closest(".option-group");
    assert.ok(settings && management, "both history sections participate in shared disclosure state");
    await waitForCondition(() => document.getElementById("notice").dataset.state === "saved");
    assert.equal(settings.open, true);
    assert.equal(management.open, true);
    settings.firstElementChild.click();
    await waitForCondition(() => chrome.testState.local[key(settings.dataset.optionGroup)] === false);
    const reopened = openOptions(t, chrome);
    await waitForCondition(() => !group(reopened, settings.dataset.optionGroup).open);
    assert.equal(group(reopened, management.dataset.optionGroup).open, true, "each card has its own stored choice");
    management.firstElementChild.click();
    await waitForCondition(() => chrome.testState.local[key(management.dataset.optionGroup)] === false);
    const beforeSearch = { ...chrome.testState.local };
    for (const [card, queries] of [
        [settings, ["최소 저장 시간", "내 채팅 기록 저장", "내 일반 후원 기록 저장"]],
        [management, ["백업·불러오기", "시청 기록 보기", "삭제 주의", "Local Extension Settings"]],
    ]) {
        for (const query of queries) {
            search(dom, query);
            assert.equal(card.open, true);
            search(dom, "");
            assert.equal(settings.open, false);
            assert.equal(management.open, false);
        }
    }
    // Drain native toggle events to detect accidental persistence of search expansion.
    await waitForAsyncCallbacks();
    assert.deepEqual(chrome.testState.local, beforeSearch);
    assert.deepEqual(chrome.testState.sync, { liveWatchHistoryEnabled: false, liveWatchHistoryMinMinutes: 17 });
    assert.deepEqual(chrome.testState.runtimeMessages, []);
    assert.equal(chrome.testState.local[historyKey], savedHistory);
    assert.equal(document.getElementById("save").disabled, true);
    assert.equal(document.getElementById("notice").dataset.state, "saved");
    const collapsed = openOptions(t, chrome);
    await waitForCondition(() => !group(collapsed, settings.dataset.optionGroup).open);
    assert.equal(group(collapsed, management.dataset.optionGroup).open, false);
});

test("pending user toggles survive immediate search and late storage restoration", async (t) => {
    const chrome = createFakeChrome();
    let restore;
    chrome.storage.local.get = (_keys, callback) => {
        restore = callback;
    };
    const dom = openOptions(t, chrome);
    group(dom, "player-auto").firstElementChild.click();
    search(dom, "자동 화질");
    restore({ [key("player-auto")]: true, [key("player-volume")]: true });
    search(dom, "");
    assert.equal(group(dom, "player-auto").open, false);
    assert.equal(group(dom, "player-volume").open, true);
    await waitForAsyncCallbacks();
    assert.equal(chrome.testState.local[key("player-auto")], false);
    assert.equal(chrome.testState.local[key("player-volume")], undefined);
});

test("manual toggles during search survive clearing and reopening", async (t) => {
    const chrome = createFakeChrome();
    const dom = openOptions(t, chrome);
    search(dom, "보정 게인");
    group(dom, "player-compressor").firstElementChild.click();
    await waitForCondition(() => chrome.testState.local[key("player-compressor")] === false);
    group(dom, "player-compressor").firstElementChild.click();
    search(dom, "");
    assert.equal(group(dom, "player-compressor").open, true);
    const reopened = openOptions(t, chrome);
    await waitForCondition(() => group(reopened, "player-compressor").open);
});

test("invalid group state is ignored and storage errors leave the options usable", async (t) => {
    const chrome = createFakeChrome({ local: { [key("player-auto")]: "false", [key("player-volume")]: {} } });
    const dom = openOptions(t, chrome);
    await waitForAsyncCallbacks();
    assert.equal(group(dom, "player-auto").open, true);
    assert.equal(group(dom, "player-volume").open, true);
    chrome.storage.local.get = (_keys, callback) => {
        chrome.runtime.lastError = { message: "read failed" };
        callback({ [key("player-auto")]: false });
        delete chrome.runtime.lastError;
    };
    chrome.storage.local.set = (_values, callback) => {
        chrome.runtime.lastError = { message: "write failed" };
        callback();
        delete chrome.runtime.lastError;
    };
    const failed = openOptions(t, chrome);
    assert.equal(group(failed, "player-auto").open, true);
    group(failed, "player-auto").firstElementChild.click();
    await waitForAsyncCallbacks();
    assert.equal(group(failed, "player-auto").open, false);
    assert.equal(failed.window.document.getElementById("notice").dataset.state, "saved");
});
