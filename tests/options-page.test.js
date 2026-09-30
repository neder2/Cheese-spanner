const assert = require("node:assert/strict");
const test = require("node:test");
const {
    readRepoFile,
    createFakeChrome,
    createDom,
    evalRepoScript,
    dispatch,
    queryOption,
    waitForAsyncCallbacks,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

test("last category restores every legacy index by meaning without rewriting the legacy value", async (t) => {
    const legacyTabs = ["player", "history", "chat", "appearance", "broadcast-time", "vod", "explore", "live-start"];
    for (const [index, id] of legacyTabs.entries()) {
        await t.test(`${index} restores ${id}`, (t) => {
            const dom = createDom("options.html", "options.html");
            t.after(() => dom.window.close());
            dom.reconfigure({ url: "https://example.test/options.html" });
            dom.window.localStorage.setItem("betterChzzkOptionsLastTab", String(index));
            evalRepoScript(dom, "shared", "settings.js");
            evalRepoScript(dom, "options.js");
            const selected = dom.window.document.querySelector('.tab[aria-selected="true"]');
            assert.equal(selected.dataset.tab, id);
            assert.equal(dom.window.localStorage.getItem("betterChzzkOptionsLastTabId"), id);
            assert.equal(dom.window.localStorage.getItem("betterChzzkOptionsLastTab"), String(index));
        });
    }
});

test("last category prefers valid stable IDs and rejects malformed legacy indices", async (t) => {
    for (const [stable, legacy, expected] of [
        ["sound", "7", "sound"],
        ["search-filter", "1", "search-filter"],
        ["missing", "3", "appearance"],
        ["", "6", "explore"],
        [null, "8", "player"],
        [null, "-1", "player"],
        [null, "2abc", "player"],
        [null, "1.5", "player"],
        [null, "", "player"],
        ["missing", null, "player"],
    ]) {
        await t.test(`${stable}/${legacy} restores ${expected}`, (t) => {
            const dom = createDom("options.html", "options.html");
            t.after(() => dom.window.close());
            dom.reconfigure({ url: "https://example.test/options.html" });
            if (stable !== null) dom.window.localStorage.setItem("betterChzzkOptionsLastTabId", stable);
            if (legacy !== null) dom.window.localStorage.setItem("betterChzzkOptionsLastTab", legacy);
            evalRepoScript(dom, "shared", "settings.js");
            evalRepoScript(dom, "options.js");
            assert.equal(dom.window.document.querySelector('.tab[aria-selected="true"]').dataset.tab, expected);
            assert.equal(dom.window.localStorage.getItem("betterChzzkOptionsLastTabId"), expected);
            assert.equal(dom.window.localStorage.getItem("betterChzzkOptionsLastTab"), legacy);
        });
    }
});

test("category navigation stays usable when remembering the last category is denied", async (t) => {
    for (const failure of ["get", "set"]) {
        await t.test(failure, (t) => {
            const dom = createDom("options.html", "options.html");
            t.after(() => dom.window.close());
            Object.defineProperty(dom.window, "localStorage", {
                value: {
                    getItem() {
                        if (failure === "get") throw new Error("Storage unavailable");
                        return "sound";
                    },
                    setItem() {
                        throw new Error("Storage write denied");
                    },
                },
            });
            evalRepoScript(dom, "shared", "settings.js");
            evalRepoScript(dom, "options.js");
            const { document } = dom.window;
            assert.equal(
                document.querySelector('.tab[aria-selected="true"]').dataset.tab,
                failure === "get" ? "player" : "sound"
            );
            const tab = document.querySelector('[data-tab="search-filter"]');
            tab.click();
            assert.equal(tab.getAttribute("aria-selected"), "true");
            assert.equal(
                document.getElementById(tab.getAttribute("aria-controls")).classList.contains("is-active"),
                true
            );
        });
    }
});

test("new categories support keyboard navigation and search never overwrites the last chosen category", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());
    dom.reconfigure({ url: "https://example.test/options.html" });
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    const { document } = dom.window;
    document.querySelector('[data-tab="player"]').focus();
    for (const [key, id] of [
        ["ArrowRight", "sound"],
        ["End", "live-start"],
        ["ArrowLeft", "search-filter"],
        ["Home", "player"],
        ["ArrowLeft", "live-start"],
    ]) {
        document.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true }));
        assert.equal(document.activeElement.dataset.tab, id);
        assert.equal(document.activeElement.getAttribute("aria-selected"), "true");
        assert.equal(dom.window.localStorage.getItem("betterChzzkOptionsLastTabId"), id);
    }
    const search = document.getElementById("settingsSearch");
    search.value = "볼륨";
    dispatch(dom, search, "input");
    assert.equal(queryOption(document, "volumeWheelEnabled").closest(".search-miss"), null);
    assert.equal(dom.window.localStorage.getItem("betterChzzkOptionsLastTabId"), "live-start");
    document.querySelector('[data-tab="sound"]').click();
    assert.equal(search.value, "");
    assert.equal(dom.window.localStorage.getItem("betterChzzkOptionsLastTabId"), "sound");
    assert.equal(dom.window.localStorage.getItem("betterChzzkOptionsLastTab"), null);
});

test("options page renders defaults and dependency-disabled controls without extension storage", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document, BetterChzzkSettings } = dom.window;
    const optionInputs = Array.from(document.querySelectorAll("[data-option]"));
    const notice = document.getElementById("notice");

    assert.deepEqual(
        optionInputs.map((input) => input.dataset.option).sort(),
        [...BetterChzzkSettings.OPTION_KEYS].sort(),
        "each schema option must appear exactly once"
    );
    assert.equal(queryOption(document, "skipSeconds").value, String(BetterChzzkSettings.DEFAULT_OPTIONS.skipSeconds));
    assert.equal(queryOption(document, "vodBroadcastClockEnabled").checked, true);
    assert.equal(queryOption(document, "adVideoEnabled").checked, true);
    assert.equal(document.getElementById("save").disabled, true, "변경 전에는 저장 버튼이 비활성화된다");
    assert.equal(notice.dataset.state, "saved");
    assert.equal(notice.textContent, "저장됨");

    const skipControl = queryOption(document, "skipControlEnabled");
    const skipKeyboard = queryOption(document, "skipKeyboardEnabled");
    const skipSeconds = queryOption(document, "skipSeconds");

    skipControl.checked = false;
    dispatch(dom, skipControl, "change");

    assert.equal(skipKeyboard.disabled, true);
    assert.equal(skipSeconds.disabled, true);
    assert.equal(skipKeyboard.closest("[data-depends-on]").classList.contains("is-disabled"), true);
});

test("panel resize settings explain their boundaries and remain independently usable", async (t) => {
    const chrome = createFakeChrome({
        sync: { chatToolsEnabled: false, followingPinEnabled: false, vodCommentTabsEnabled: false },
    });
    const dom = createDom("options.html", "options.html", chrome);
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();
    const { document } = dom.window;
    const chat = queryOption(document, "chatResizeEnabled");
    const sidebar = queryOption(document, "sidebarResizeEnabled");
    for (const [input, group, expectedHelp] of [
        [
            chat,
            "chat-display",
            "채팅·댓글 왼쪽 가장자리를 마우스로 잡아 끌어 조절해요. 더블클릭하면 기본 너비로 돌아가요.",
        ],
        [
            sidebar,
            "appearance-page",
            "펼친 사이드바 오른쪽 가장자리를 마우스로 잡아 끌어 조절해요. 더블클릭하면 기본 너비로 돌아가요.",
        ],
    ]) {
        assert.ok(input);
        assert.equal(input.checked, true);
        assert.equal(input.disabled, false);
        assert.equal(input.closest("[data-depends-on]"), null);
        assert.equal(input.closest(".option-group").dataset.optionGroup, group);
        const help = document.getElementById(input.getAttribute("aria-describedby"));
        assert.ok(help);
        assert.equal(help.textContent.trim().replace(/\s+/g, " "), expectedHelp);
        input.focus();
        assert.equal(document.activeElement, input);
    }
    chat.checked = false;
    dispatch(dom, chat, "change");
    document.getElementById("save").click();
    await waitForAsyncCallbacks();
    assert.equal(chrome.testState.sync.chatResizeEnabled, false);
    assert.equal(chrome.testState.sync.sidebarResizeEnabled, true);
    assert.equal(sidebar.disabled, false);
    assert.equal(queryOption(document, "followingPinEnabled").checked, false);
    assert.equal(queryOption(document, "vodCommentTabsEnabled").checked, false);
    sidebar.checked = false;
    dispatch(dom, sidebar, "change");
    document.getElementById("save").click();
    await waitForAsyncCallbacks();
    assert.equal(chrome.testState.sync.chatResizeEnabled, false);
    assert.equal(chrome.testState.sync.sidebarResizeEnabled, false);
    dom.window.confirm = () => true;
    document.getElementById("reset").click();
    await waitForAsyncCallbacks();
    assert.equal(chat.checked, true);
    assert.equal(sidebar.checked, true);
    assert.equal(chrome.testState.sync.chatResizeEnabled, true);
    assert.equal(chrome.testState.sync.sidebarResizeEnabled, true);
});

test("panel resize saved opt-outs remain off when the options page loads", async (t) => {
    const chrome = createFakeChrome({ sync: { chatResizeEnabled: false, sidebarResizeEnabled: false } });
    const dom = createDom("options.html", "options.html", chrome);
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();
    for (const key of ["chatResizeEnabled", "sidebarResizeEnabled"]) {
        assert.equal(queryOption(dom.window.document, key).checked, false);
        assert.equal(queryOption(dom.window.document, key).disabled, false);
    }
});

test("global live count is an independent searchable setting with a disabled default", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    const { document } = dom.window;
    const aggregate = queryOption(document, "globalLiveCountEnabled");
    assert.ok(aggregate);
    assert.equal(aggregate.checked, false);
    assert.equal(aggregate.closest("[data-depends-on]"), null);
    const row = aggregate.closest(".toggle-row");
    assert.match(row.textContent, /전체 방송 집계 표시/);
    assert.match(row.textContent, /10명 이상/);
    assert.match(row.textContent, /방송 수/);
    assert.match(row.textContent, /합계/);
    assert.match(row.closest(".option-group").querySelector("summary").textContent, /검색·목록 표시/);
    const category = queryOption(document, "categoryToolsEnabled");
    category.checked = false;
    dispatch(dom, category, "change");
    assert.equal(aggregate.disabled, false);
    aggregate.checked = true;
    dispatch(dom, aggregate, "change");
    assert.equal(category.checked, false);
    const search = document.getElementById("settingsSearch");
    for (const query of ["동시접속자", "동시 시청자", "집계"]) {
        search.value = query;
        dispatch(dom, search, "input");
        assert.equal(aggregate.closest(".search-miss"), null);
    }
});

test("options captures readable playback speed keys and blocks duplicate or reserved shortcuts", async (t) => {
    const chrome = createFakeChrome();
    const dom = createDom("options.html", "options.html", chrome);
    t.after(() => dom.window.close());

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    const enabled = queryOption(document, "playbackSpeedShortcutsEnabled");
    const halfKey = queryOption(document, "playbackSpeedHalfKeyCode");
    const doubleKey = queryOption(document, "playbackSpeedDoubleKeyCode");
    const resetKey = queryOption(document, "playbackSpeedResetKeyCode");
    const message = document.getElementById("message");
    const saveButton = document.getElementById("save");
    const press = (input, code, init = {}) => {
        const event = new dom.window.KeyboardEvent("keydown", {
            code,
            key: init.key || code,
            bubbles: true,
            cancelable: true,
            ...init,
        });
        input.dispatchEvent(event);
        return event;
    };

    assert.equal(halfKey.value, "[");
    assert.equal(halfKey.dataset.shortcutCode, "BracketLeft");
    assert.equal(doubleKey.value, "]");
    assert.equal(doubleKey.dataset.shortcutCode, "BracketRight");
    assert.equal(resetKey.dataset.shortcutCode, "Backslash");

    enabled.checked = false;
    dispatch(dom, enabled, "change");
    assert.equal(halfKey.disabled, true);
    assert.equal(doubleKey.disabled, true);
    assert.equal(resetKey.disabled, true);

    enabled.checked = true;
    dispatch(dom, enabled, "change");
    assert.equal(halfKey.disabled, false);

    assert.equal(press(halfKey, "KeyQ", { key: "q" }).defaultPrevented, true);
    assert.equal(halfKey.value, "Q");
    assert.equal(halfKey.dataset.shortcutCode, "KeyQ");
    assert.equal(saveButton.disabled, false);

    const browserShortcut = press(doubleKey, "KeyL", { key: "l", ctrlKey: true });
    assert.equal(browserShortcut.defaultPrevented, false, "browser and assistive shortcuts must pass through");
    assert.equal(doubleKey.value, "]");

    const unsupportedKey = press(doubleKey, "F6", { key: "F6" });
    assert.equal(unsupportedKey.defaultPrevented, false, "unsupported navigation keys must pass through");
    assert.equal(doubleKey.value, "]");

    press(doubleKey, "KeyQ", { key: "q" });
    assert.equal(doubleKey.value, "]");
    assert.match(message.textContent, /서로 다른 키/);

    press(doubleKey, "KeyM", { key: "m" });
    press(doubleKey, "KeyC", { key: "c" });
    assert.equal(doubleKey.value, "]", "the native subtitle key must stay reserved");
    assert.match(message.textContent, /겹쳐 지정할 수 없습니다/);

    press(doubleKey, "KeyW", { key: "w" });
    assert.equal(doubleKey.value, "W");
    assert.equal(doubleKey.dataset.shortcutCode, "KeyW");
    for (const code of ["KeyQ", "KeyW"]) {
        press(resetKey, code);
        assert.equal(resetKey.dataset.shortcutCode, "Backslash");
        assert.match(message.textContent, /서로 다른 키/);
    }
    press(resetKey, "KeyR");
    assert.equal(resetKey.value, "R");
    press(halfKey, "KeyR");
    assert.equal(halfKey.dataset.shortcutCode, "KeyQ");
    press(doubleKey, "KeyR");
    assert.equal(doubleKey.dataset.shortcutCode, "KeyW");

    saveButton.click();
    await waitForAsyncCallbacks();
    assert.equal(saveButton.disabled, true);
    assert.equal(chrome.testState.sync.playbackSpeedHalfKeyCode, "KeyQ");
    assert.equal(chrome.testState.sync.playbackSpeedDoubleKeyCode, "KeyW");
    assert.equal(chrome.testState.sync.playbackSpeedResetKeyCode, "KeyR");
});

test("playback shortcut reset restores only the three keys and keeps changes pending until save", async (t) => {
    const customKeys = {
        playbackSpeedHalfKeyCode: "KeyQ",
        playbackSpeedDoubleKeyCode: "KeyW",
        playbackSpeedResetKeyCode: "KeyR",
    };
    const chrome = createFakeChrome({ sync: { ...customKeys, skipSeconds: 17, holdSpeedEnabled: false } });
    const dom = createDom("options.html", "options.html", chrome);
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    const { document, BetterChzzkSettings } = dom.window;
    await waitForCondition(() => document.getElementById("notice").dataset.state === "saved");

    const reset = document.getElementById("resetPlaybackSpeedShortcuts");
    assert.ok(reset, "the playback shortcuts expose a local reset action");
    assert.equal(reset.type, "button");
    assert.equal(reset.textContent.trim(), "단축키 기본값 복원");
    const storedBeforeReset = { ...chrome.testState.sync };
    let writes = 0;
    const write = chrome.storage.sync.set.bind(chrome.storage.sync);
    chrome.storage.sync.set = (values, callback) => {
        writes += 1;
        write(values, callback);
    };
    const skip = queryOption(document, "skipSeconds");
    skip.value = "29";
    dispatch(dom, skip, "input");

    reset.focus();
    reset.click();
    for (const key of Object.keys(customKeys)) {
        const input = queryOption(document, key);
        const defaultCode = BetterChzzkSettings.DEFAULT_OPTIONS[key];
        assert.equal(input.dataset.shortcutCode, defaultCode);
        assert.equal(input.value, BetterChzzkSettings.getPlaybackSpeedShortcutLabel(defaultCode));
    }
    assert.equal(skip.value, "29", "unrelated unsaved edits survive the local reset");
    assert.equal(queryOption(document, "holdSpeedEnabled").checked, false);
    assert.equal(queryOption(document, "playbackSpeedShortcutsEnabled").checked, true);
    assert.equal(document.activeElement, reset, "the action keeps keyboard focus");
    assert.equal(document.getElementById("notice").textContent, "변경 4개");
    assert.equal(writes, 0);
    assert.deepEqual(chrome.testState.sync, storedBeforeReset);

    document.getElementById("discardChanges").click();
    for (const [key, code] of Object.entries(customKeys)) {
        assert.equal(queryOption(document, key).dataset.shortcutCode, code);
    }
    assert.equal(skip.value, "17");
    assert.equal(writes, 0, "discard can undo the shortcut reset without writing");

    reset.click();
    document.getElementById("save").click();
    await waitForCondition(() => document.getElementById("notice").dataset.state === "saved");
    for (const key of Object.keys(customKeys)) {
        assert.equal(chrome.testState.sync[key], BetterChzzkSettings.DEFAULT_OPTIONS[key]);
    }
    assert.equal(chrome.testState.sync.skipSeconds, 17);
    assert.equal(chrome.testState.sync.holdSpeedEnabled, false);
    assert.equal(writes, 1);
    reset.click();
    assert.equal(document.getElementById("save").disabled, true, "resetting defaults again leaves no pending edit");
    assert.equal(writes, 1);
});

test("playback shortcut reset follows its toggle and stays with the keys in search results", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    const { document } = dom.window;
    const reset = document.getElementById("resetPlaybackSpeedShortcuts");
    assert.ok(reset);
    const halfKey = queryOption(document, "playbackSpeedHalfKeyCode");
    const enabled = queryOption(document, "playbackSpeedShortcutsEnabled");
    halfKey.dispatchEvent(new dom.window.KeyboardEvent("keydown", { code: "KeyQ", bubbles: true }));
    assert.equal(halfKey.value, "Q");
    enabled.checked = false;
    dispatch(dom, enabled, "change");
    assert.equal(reset.disabled, true);
    dispatch(dom, reset, "click");
    assert.equal(halfKey.value, "Q", "a disabled reset keeps the customized keys");

    const search = document.getElementById("settingsSearch");
    for (const query of ["배속 감소 키", "단축키 기본값 복원"]) {
        search.value = query;
        dispatch(dom, search, "input");
        for (const control of [reset, halfKey, enabled]) {
            assert.equal(control.closest(".search-miss"), null, "reset, keys, and the master toggle remain reachable");
        }
    }
    enabled.checked = true;
    dispatch(dom, enabled, "change");
    assert.equal(reset.disabled, false);
    reset.click();
    assert.equal(halfKey.value, "[");
    assert.equal(document.getElementById("notice").dataset.state, "saved");

    halfKey.dispatchEvent(new dom.window.KeyboardEvent("keydown", { code: "KeyQ", bubbles: true }));
    assert.equal(halfKey.value, "Q", "key capture remains usable after reset");
});

test("options keeps following controls together and separates list filters from page appearance", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document } = dom.window;
    const previewSection = queryOption(document, "followingPreviewTooltipEnabled").closest(".settings-card");
    const explorationSection = document.getElementById("tab-panel-explore");
    const filterSection = queryOption(document, "categoryToolsEnabled").closest(".settings-card");
    const followingRefreshSection = queryOption(document, "followingRefreshEnabled").closest(".settings-card");
    const sidebarSection = queryOption(document, "sidebarCheeseFarmHidden").closest(".settings-card");

    assert.equal(previewSection, explorationSection);
    assert.equal(followingRefreshSection, explorationSection);
    assert.equal(sidebarSection.id, "tab-panel-appearance");
    assert.equal(filterSection.id, "tab-panel-search-filter");
    assert.equal(queryOption(document, "followingPreviewSoundEnabled").closest(".settings-card"), explorationSection);
    assert.equal(queryOption(document, "videoSearchEnabled").closest(".settings-card").id, "tab-panel-vod");
    assert.equal(queryOption(document, "channelChatLinkEnabled").closest(".settings-card"), explorationSection);
    assert.equal(queryOption(document, "channelChatLinkEnabled").checked, true);
    assert.equal(queryOption(document, "sidebarCheeseFarmHidden").checked, false);
    assert.equal(queryOption(document, "followingPinEnabled").checked, true);
    const listState = queryOption(document, "followingListStateEnabled");
    assert.equal(listState.checked, false);
    assert.equal(listState.disabled, false);
    assert.equal(listState.closest("label").textContent.trim(), "팔로잉 목록 상태 기억");
    assert.equal(listState.closest(".settings-card"), explorationSection);
    const offlineHidden = queryOption(document, "followingOfflineHidden");
    assert.equal(offlineHidden.checked, false);
    assert.equal(offlineHidden.disabled, false);
    const offlineToTop = queryOption(document, "followingPinOfflineToTopEnabled");
    assert.equal(offlineToTop.checked, false);
    assert.equal(offlineToTop.disabled, false);
    assert.equal(offlineToTop.closest("label").textContent.trim(), "오프라인이어도 최상단 고정");
    queryOption(document, "followingPinEnabled").checked = false;
    dispatch(dom, queryOption(document, "followingPinEnabled"), "change");
    assert.equal(offlineToTop.disabled, true);
    assert.equal(offlineHidden.disabled, false);
    queryOption(document, "followingPinEnabled").checked = true;
    dispatch(dom, queryOption(document, "followingPinEnabled"), "change");
    assert.equal(offlineToTop.disabled, false);
});

test("options groups stay accessible and never disable their own master toggle", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document } = dom.window;
    const groups = Array.from(document.querySelectorAll(".option-group"));
    const playerAuto = document.querySelector('[data-option-group="player-auto"]');

    assert.ok(groups.length > 0, "settings must expose navigable groups");

    for (const group of groups) {
        const summary = group.firstElementChild;
        const icon = summary.querySelector(".option-group-title > svg");
        assert.equal(summary?.tagName, "SUMMARY");
        assert.ok(summary.textContent.trim().length > 0);
        assert.equal(summary.querySelector("input, button, a[href]"), null);
        assert.equal(summary.querySelectorAll(".option-group-title").length, 1);
        if (group === playerAuto) assert.equal(icon, null);
        else assert.equal(icon?.getAttribute("aria-hidden"), "true");
        assert.equal(
            Array.from(group.children).filter((child) => child.classList.contains("option-group-body")).length,
            1
        );
    }

    const tabs = Array.from(document.querySelectorAll(".tab"));
    const panels = Array.from(document.querySelectorAll(".settings-form > .settings-card"));
    assert.equal(document.body.classList.contains("options-body"), true);
    assert.ok(tabs.length > 0);
    assert.equal(panels.length, tabs.length);
    assert.ok(panels.every((panel) => panel.querySelector(".section-heading-icon[aria-hidden='true']")));
    assert.ok(tabs.every((tab) => tab.getAttribute("aria-label") && tab.getAttribute("title")));
    for (const tab of tabs) {
        assert.equal(tab.tagName, "BUTTON");
        assert.equal(tab.type, "button");
        const panel = document.getElementById(tab.getAttribute("aria-controls"));
        assert.ok(panels.includes(panel), "each tab controls an existing panel");
        assert.equal(panel.getAttribute("aria-labelledby"), tab.id);
        tab.click();
        assert.equal(tab.getAttribute("aria-selected"), "true");
        assert.equal(tab.tabIndex, 0);
        assert.equal(tabs.filter((item) => item.getAttribute("aria-selected") === "true").length, 1);
        tab.focus();
        assert.equal(document.activeElement, tab);
    }
    assert.equal(document.querySelector("#reset svg")?.getAttribute("aria-hidden"), "true");

    for (const dependencyGroup of document.querySelectorAll("[data-depends-on]")) {
        for (const optionKey of dependencyGroup.dataset.dependsOn.split(/\s+/).filter(Boolean)) {
            const masterInput = queryOption(document, optionKey);
            assert.ok(masterInput, `${optionKey} dependency must reference an existing option`);
            assert.equal(
                dependencyGroup.contains(masterInput),
                false,
                `${optionKey} must stay outside its own dependency group`
            );
        }
    }
});

test("options retain responsive popup controls and visible keyboard focus", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());
    const { document } = dom.window;
    const style = document.createElement("style");
    style.textContent = readRepoFile("styles.css");
    document.head.append(style);

    // Inspect CSSOM declarations, not formatting or decorative pixel values.
    // JSDOM does not lay out pages; browser geometry remains a separate smoke check.
    function declarations(selector, width) {
        const result = new Map();
        function visit(rules) {
            for (const rule of rules) {
                if (rule.media) {
                    const limits = [...rule.conditionText.matchAll(/(min|max)-width:\s*([\d.]+)px/g)];
                    if (!limits.length) continue;
                    if (
                        limits.every(([, bound, value]) =>
                            bound === "max" ? width <= Number(value) : width >= Number(value)
                        )
                    ) {
                        visit(rule.cssRules);
                    }
                } else if (rule.selectorText?.split(",").some((item) => item.trim() === selector)) {
                    for (let index = 0; index < rule.style.length; index++) {
                        const property = rule.style[index];
                        result.set(property, rule.style.getPropertyValue(property));
                    }
                }
            }
        }
        visit(style.sheet.cssRules);
        return result;
    }

    for (const width of [320, 360, 420]) {
        const tabs = declarations(".options-body .options-page .tab-bar", width);
        assert.equal(tabs.get("display"), "flex");
        assert.equal(tabs.get("flex-wrap"), "nowrap", "categories remain in a single row");
        assert.equal(tabs.get("overflow-x"), "auto", "narrow popups can reach every category by scrolling");
        assert.equal(declarations(".options-body .options-page .tab", width).get("flex"), "0 0 auto");
        assert.equal(declarations(".options-body .tab span", width).get("white-space"), "nowrap");
        assert.equal(
            declarations(".options-body .options-page .option-group-body > .number-grid", width).get(
                "grid-template-columns"
            ),
            "1fr",
            "number inputs stack in a narrow popup"
        );
        assert.equal(declarations(".options-body .options-page .save-row .save-button", width).get("width"), "100%");
        assert.ok(
            Number.parseFloat(declarations(".options-body .options-page .tab", width).get("min-height")) >= 32,
            "tabs retain a clickable target"
        );
    }
    // JSDOM's CSSOM drops mixed-unit min() widths, so retain this container contract in raw CSS.
    assert.match(style.textContent, /\.options-body \.options-page\s*\{[^}]*width:\s*min\([^;]*100%\)/);
    for (const selector of [
        ".option-group > summary:focus-visible",
        ".tab:focus-visible",
        ".primary-button:focus-visible",
        ".secondary-button:focus-visible",
    ]) {
        const focus = declarations(selector, 420);
        assert.ok(
            [...focus.values()].some((value) => value.includes("--focus-ring")),
            selector
        );
    }
});

test("restored and keyboard-selected tabs scroll into view without moving the page", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());
    dom.reconfigure({ url: "https://example.test/options.html" });
    const { document } = dom.window;
    const bar = document.querySelector(".tab-bar");
    const tabs = Array.from(bar.querySelectorAll(".tab"));
    Object.defineProperties(bar, { clientWidth: { value: 160 }, scrollWidth: { value: tabs.length * 80 } });
    bar.getBoundingClientRect = () => ({ left: 0, right: 160 });
    tabs.forEach((tab, index) => {
        tab.getBoundingClientRect = () => ({
            left: index * 80 - bar.scrollLeft,
            right: (index + 1) * 80 - bar.scrollLeft,
        });
    });
    dom.window.localStorage.setItem("betterChzzkOptionsLastTabId", tabs.at(-1).dataset.tab);
    const pageScrolls = [];
    dom.window.scrollTo = (options) => pageScrolls.push(options);
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    function assertSelectedVisible(tab) {
        assert.equal(tab.getAttribute("aria-selected"), "true");
        const rect = tab.getBoundingClientRect();
        assert.ok(rect.left >= 0 && rect.right <= bar.clientWidth);
    }
    assertSelectedVisible(tabs.at(-1));
    tabs.at(-1).focus();
    for (const [key, tab] of [
        ["Home", tabs[0]],
        ["End", tabs.at(-1)],
        ["ArrowRight", tabs[0]],
    ]) {
        document.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true }));
        assertSelectedVisible(tab);
        assert.equal(document.activeElement, tab);
    }
    assert.deepEqual(pageScrolls, []);
});

test("category scroll animates accumulated wheel input, reversals, and respects reduced motion", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());
    const bar = dom.window.document.querySelector(".tab-bar");
    Object.defineProperties(bar, { clientWidth: { value: 200 }, scrollWidth: { value: 700 } });
    const calls = [];
    bar.scrollTo = (options) => {
        calls.push({ ...options });
        if (options.behavior === "instant") bar.scrollLeft = options.left;
    };
    const media = {
        matches: false,
        addEventListener(_type, listener) {
            this.changed = listener;
        },
    };
    dom.window.matchMedia = () => media;
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    const wheel = (deltaY) => {
        const event = new dom.window.WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
        bar.dispatchEvent(event);
        return event;
    };
    wheel(100);
    wheel(100);
    assert.equal(bar.scrollLeft, 0, "a smooth request does not jump straight to its destination");
    assert.deepEqual(calls.at(-1), { left: 200, behavior: "smooth" });
    assert.equal(wheel(-200).defaultPrevented, true, "a full reversal cancels the pending destination");
    assert.deepEqual(calls.at(-1), { left: 0, behavior: "smooth" });
    wheel(100);
    media.matches = true;
    media.changed();
    assert.equal(bar.scrollLeft, 100);
    assert.equal(calls.at(-1).behavior, "instant");
    wheel(1000);
    assert.equal(bar.scrollLeft, 500);
    assert.equal(wheel(100).defaultPrevented, false, "page scrolling remains available at the settled edge");
    media.matches = false;
    wheel(-100);
    bar.dispatchEvent(new dom.window.Event("pointerdown"));
    assert.equal(calls.at(-1).behavior, "instant", "direct manipulation stops the animation");
    bar.scrollLeft = 250;
    bar.dispatchEvent(new dom.window.Event("scrollend"));
    wheel(-50);
    assert.deepEqual(calls.at(-1), { left: 200, behavior: "smooth" });
});

test("options theme previews, discards, persists after save, and can follow the system again", async (t) => {
    const chrome = createFakeChrome({ sync: { optionsTheme: "dark" } });
    const dom = createDom("options.html", "options.html", chrome);
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    const { document } = dom.window;
    const theme = queryOption(document, "optionsTheme");
    const selectTheme = (value) => {
        for (let i = 0; i < 3 && theme.value !== value; i++) theme.click();
        assert.equal(theme.value, value);
    };
    await waitForCondition(() => !theme.disabled);
    assert.equal(document.documentElement.dataset.theme, "dark");
    assert.equal(theme.tagName, "BUTTON");
    assert.equal(theme.nextElementSibling.id, "headerMenu");
    assert.match(theme.getAttribute("aria-label"), /다크.*시스템 설정/);
    selectTheme("light");
    assert.equal(document.documentElement.dataset.theme, "light");
    assert.equal(chrome.testState.sync.optionsTheme, "dark");
    document.getElementById("discardChanges").click();
    assert.equal(document.documentElement.dataset.theme, "dark");
    selectTheme("light");
    document.getElementById("save").click();
    await waitForCondition(() => document.getElementById("notice").dataset.state === "saved");
    assert.equal(chrome.testState.sync.optionsTheme, "light");
    const reopened = createDom("options.html", "options.html", chrome);
    t.after(() => reopened.window.close());
    evalRepoScript(reopened, "shared", "settings.js");
    evalRepoScript(reopened, "options.js");
    await waitForCondition(() => reopened.window.document.documentElement.dataset.theme === "light");
    selectTheme("system");
    assert.equal(document.documentElement.hasAttribute("data-theme"), false);
    document.getElementById("save").click();
    await waitForCondition(() => document.getElementById("notice").dataset.state === "saved");
    assert.equal(chrome.testState.sync.optionsTheme, "system");
    assert.equal(dom.window.BetterChzzkSettings.normalizeOptions({ optionsTheme: "invalid" }).optionsTheme, "system");
});

test("category wheel scrolls horizontally only when it can consume a vertical step", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    const { document } = dom.window;
    const bar = document.querySelector(".tab-bar");
    Object.defineProperties(bar, {
        clientWidth: { value: 200 },
        scrollWidth: { value: 700, configurable: true },
    });
    bar.style.lineHeight = "20px";
    const selected = bar.querySelector('[aria-selected="true"]');
    const wheel = (init, target = selected) => {
        const event = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
        target.dispatchEvent(event);
        return event;
    };
    assert.equal(wheel({ deltaY: 100 }).defaultPrevented, true);
    assert.equal(bar.scrollLeft, 100);
    assert.equal(wheel({ deltaY: -2, deltaMode: 1 }).defaultPrevented, true);
    assert.equal(bar.scrollLeft, 60);
    assert.equal(wheel({ deltaY: 1, deltaMode: 2 }).defaultPrevented, true);
    assert.equal(bar.scrollLeft, 260);
    for (const init of [
        { deltaX: 100 },
        { deltaX: 120, deltaY: 10 },
        { deltaY: 100, shiftKey: true },
        { deltaY: 100, ctrlKey: true },
        { deltaY: 100, metaKey: true },
        { deltaY: 0 },
    ]) {
        assert.equal(wheel(init).defaultPrevented, false);
        assert.equal(bar.scrollLeft, 260);
    }
    assert.equal(wheel({ deltaY: 100 }, document.querySelector(".settings-card")).defaultPrevented, false);
    assert.equal(bar.scrollLeft, 260);
    assert.equal(wheel({ deltaY: 1000 }).defaultPrevented, true);
    assert.equal(bar.scrollLeft, 500);
    assert.equal(wheel({ deltaY: 100 }).defaultPrevented, false);
    assert.equal(wheel({ deltaY: -1000 }).defaultPrevented, true);
    assert.equal(bar.scrollLeft, 0);
    assert.equal(wheel({ deltaY: -100 }).defaultPrevented, false);
    Object.defineProperty(bar, "scrollWidth", { value: 200 });
    assert.equal(wheel({ deltaY: 100 }).defaultPrevented, false);
    assert.equal(bar.querySelector('[aria-selected="true"]'), selected);
});

test("merged filter headings and former titles keep their inputs, context and parent toggle searchable", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    const { document } = dom.window;
    const parent = queryOption(document, "categoryToolsEnabled");
    parent.checked = false;
    dispatch(dom, parent, "change");
    const search = document.getElementById("settingsSearch");
    const presets = document.querySelector('[data-option-group="explore-presets"]');
    for (const [query, prefix, heading] of [
        ["팔로워 필터", "categoryToolsFollowerFilterPreset", "팔로워"],
        ["시청자·조회수", "categoryToolsViewFilterPreset", "시청자·조회수"],
        ["진행 시간 필터", "categoryToolsDurationFilterPreset", "진행 시간"],
        ["categoryToolsFollowerFilterPreset3", "categoryToolsFollowerFilterPreset", "팔로워"],
    ]) {
        search.value = query;
        dispatch(dom, search, "input");
        assert.equal(presets.open, true);
        const title = [...presets.querySelectorAll(".option-subheading")].find(
            (node) => node.textContent.trim() === heading
        );
        assert.equal(title.closest(".search-miss"), null, `${query} retains its subsection heading`);
        assert.equal(title.nextElementSibling.closest(".search-miss"), null, `${query} retains range guidance`);
        for (let index = 1; index <= 6; index += 1) {
            const input = queryOption(document, prefix + index);
            assert.equal(input.closest(".search-miss"), null, `${query}: input ${index}`);
            assert.equal(input.disabled, true);
        }
        assert.equal(parent.closest(".search-miss"), null);
        assert.equal(parent.disabled, false);
    }
    parent.checked = true;
    dispatch(dom, parent, "change");
    assert.equal(queryOption(document, "categoryToolsFollowerFilterPreset3").disabled, false);
    search.value = "";
    dispatch(dom, search, "input");
    assert.equal(presets.open, false);
});

test("merged video and following searches retain former headings and dependency chains", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    const { document } = dom.window;
    const search = document.getElementById("settingsSearch");
    const video = queryOption(document, "videoSearchEnabled");
    video.checked = false;
    dispatch(dom, video, "change");
    for (const query of ["댓글 검색", "videoSearchCommentDelayMs"]) {
        search.value = query;
        dispatch(dom, search, "input");
        for (const key of [
            "videoSearchEnabled",
            "videoSearchCommentEnabled",
            "videoSearchCommentDelayMs",
            "videoSearchCommentMaxVideos",
            "videoSearchCommentMaxPagesPerVideo",
        ]) {
            assert.equal(queryOption(document, key).closest(".search-miss"), null, `${query}: ${key}`);
        }
        const title = [...document.querySelectorAll('[data-option-group="search-video"] .option-subheading')].find(
            (node) => node.textContent.trim() === "댓글 검색"
        );
        assert.equal(title.closest(".search-miss"), null);
        assert.equal(video.disabled, false);
    }
    search.value = "목록 새로고침";
    dispatch(dom, search, "input");
    for (const key of ["followingTitleHistoryEnabled", "followingRefreshEnabled", "followingRefreshSeconds"]) {
        assert.equal(queryOption(document, key).closest(".search-miss"), null, key);
    }
});

test("broadcast alert searches retain registration actions, results and immediate-save guidance together", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    const { document } = dom.window;
    const search = document.getElementById("settingsSearch");
    for (const query of ["32개", "즉시 저장", "대상 채널 추가", "liveStartAutoOpenEnabled"]) {
        search.value = query;
        dispatch(dom, search, "input");
        for (const id of [
            "liveStartHelp",
            "liveStartChannelInput",
            "liveStartChannelAdd",
            "liveStartChannelHelp",
            "liveStartChannelMessage",
            "liveStartChannelList",
        ]) {
            assert.equal(document.getElementById(id).closest(".search-miss"), null, `${query}: ${id}`);
        }
        for (const key of ["liveStartNotificationsEnabled", "liveStartAutoOpenEnabled", "liveStartButtonEnabled"]) {
            assert.equal(queryOption(document, key).closest(".search-miss"), null, `${query}: ${key}`);
        }
    }
});

test("options search keeps dependency controls visible and restores previous group state", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document } = dom.window;
    const search = document.getElementById("settingsSearch");
    const playerAuto = document.querySelector('[data-option-group="player-auto"]');
    const playerCompressor = document.querySelector('[data-option-group="player-compressor"]');
    const playerSeek = document.querySelector('[data-option-group="player-seek"]');
    const compressorToggle = queryOption(document, "audioCompressorEnabled");
    const makeupGain = queryOption(document, "audioCompressorMakeupGain");

    assert.equal(playerAuto.open, true);
    assert.equal(playerCompressor.open, false);

    search.value = "보정 게인";
    dispatch(dom, search, "input");

    assert.equal(playerCompressor.open, true);
    assert.equal(playerCompressor.classList.contains("search-miss"), false);
    assert.equal(playerAuto.classList.contains("search-miss"), true);
    assert.equal(compressorToggle.closest(".toggle-row").classList.contains("search-miss"), false);
    assert.equal(makeupGain.disabled, true);

    compressorToggle.checked = true;
    dispatch(dom, compressorToggle, "change");

    assert.equal(makeupGain.disabled, false);

    search.value = "왼쪽·오른쪽 방향키";
    dispatch(dom, search, "input");

    assert.equal(
        Array.from(playerSeek.querySelectorAll(".option-group-body > *")).every(
            (element) => !element.classList.contains("search-miss")
        ),
        true
    );

    search.value = "댓글 검색 지연";
    dispatch(dom, search, "input");

    const videoSearchToggle = queryOption(document, "videoSearchEnabled");
    const commentSearchToggle = queryOption(document, "videoSearchCommentEnabled");
    assert.equal(videoSearchToggle.closest(".toggle-row").classList.contains("search-miss"), false);
    assert.equal(commentSearchToggle.closest(".toggle-row").classList.contains("search-miss"), false);
    assert.equal(videoSearchToggle.closest(".option-group").open, true);
    assert.equal(commentSearchToggle.closest(".option-group").open, true);

    search.value = "라이브에도 스킵 시간 조절 버튼 표시";
    dispatch(dom, search, "input");

    for (const optionKey of ["skipControlEnabled", "skipPillEnabled", "skipLivePillEnabled"]) {
        assert.equal(queryOption(document, optionKey).closest(".toggle-row").classList.contains("search-miss"), false);
    }

    search.value = "";
    dispatch(dom, search, "input");

    assert.equal(playerAuto.open, true);
    assert.equal(playerCompressor.open, false);
    assert.equal(document.querySelector(".option-group.search-miss"), null);
});

test("history searches keep the master toggle reachable while only its child settings are disabled", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    const { document } = dom.window;
    const search = document.getElementById("settingsSearch");
    const enabled = queryOption(document, "liveWatchHistoryEnabled");
    const children = [
        ["최소 저장 시간", "liveWatchHistoryMinMinutes"],
        ["내 채팅 기록 저장", "liveWatchHistoryChatEnabled"],
        ["내 일반 후원 기록 저장", "liveWatchHistoryDonationEnabled"],
    ];
    enabled.checked = false;
    dispatch(dom, enabled, "change");
    for (const [query, optionKey] of children) {
        const input = queryOption(document, optionKey);
        search.value = query;
        dispatch(dom, search, "input");
        assert.equal(input.disabled, true);
        assert.equal(input.closest(".search-miss"), null);
        assert.equal(enabled.disabled, false);
        assert.equal(enabled.closest(".search-miss"), null, "the matching child retains its enable action");
        const settingsGroup = enabled.closest(".option-group");
        assert.ok(settingsGroup, "history settings support the shared searchable disclosure");
        assert.equal(settingsGroup.open, true);
        assert.equal(settingsGroup.firstElementChild.closest(".is-disabled"), null);
    }
    search.value = "";
    dispatch(dom, search, "input");
    const link = document.querySelector('#tab-panel-history a[href="history.html"]');
    assert.equal(link.closest(".is-disabled, .search-miss"), null);
    link.focus();
    assert.equal(document.activeElement, link, "existing history stays reachable with collection off");
    enabled.checked = true;
    dispatch(dom, enabled, "change");
    for (const [, optionKey] of children) assert.equal(queryOption(document, optionKey).disabled, false);
    assert.equal(document.getElementById("notice").dataset.state, "saved");
});

test("history management searches keep backup, deletion, storage guidance and the history link together", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    const { document } = dom.window;
    const search = document.getElementById("settingsSearch");
    const guide = document.getElementById("historyBackupGuide");
    const link = document.querySelector('#tab-panel-history a[href="history.html"]');
    const warning = document.querySelector("#tab-panel-history .history-storage-warning");
    const storage = document.querySelector("#tab-panel-history .history-storage-guide");
    for (const query of ["백업·불러오기", "시청 기록 보기", "삭제 주의", "Local Extension Settings"]) {
        search.value = query;
        dispatch(dom, search, "input");
        for (const element of [guide, link, warning, storage]) {
            assert.equal(element.closest(".search-miss"), null, `${query} keeps guidance and its action visible`);
        }
        assert.equal(storage.open, false, "search leaves the optional storage instructions collapsed");
        storage.firstElementChild.click();
        assert.equal(storage.open, true, "the storage details remain independently usable");
        storage.firstElementChild.click();
    }
    assert.equal(link.getAttribute("aria-describedby"), guide.id);
    assert.equal(document.getElementById("notice").dataset.state, "saved");
});

test("options search finds the offline pin option together with its parent feature", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    const { document } = dom.window;
    const search = document.getElementById("settingsSearch");
    search.value = "오프라인이어도 최상단";
    dispatch(dom, search, "input");
    for (const key of ["followingPinEnabled", "followingPinOfflineToTopEnabled"]) {
        const input = queryOption(document, key);
        assert.equal(input.closest(".toggle-row").classList.contains("search-miss"), false);
        assert.equal(input.closest(".option-group").open, true);
    }
});

test("options page saves changed toggles and numbers when the save button is clicked", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            skipSeconds: 15,
            videoSearchEnabled: false,
        },
    });
    const dom = createDom("options.html", "options.html", chrome);
    t.after(() => dom.window.close());

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    const skipSeconds = queryOption(document, "skipSeconds");
    const videoComment = queryOption(document, "videoSearchCommentEnabled");
    const autoQuality = queryOption(document, "autoQualityEnabled");
    const saveButton = document.getElementById("save");
    const offlineToTop = queryOption(document, "followingPinOfflineToTopEnabled");

    assert.equal(skipSeconds.value, "15");
    assert.equal(videoComment.disabled, true);
    assert.equal(offlineToTop.checked, false);
    offlineToTop.checked = true;
    dispatch(dom, offlineToTop, "change");
    assert.equal(chrome.testState.sync.followingPinOfflineToTopEnabled, undefined);

    autoQuality.checked = false;
    dispatch(dom, autoQuality, "change");
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.sync.autoQualityEnabled, undefined, "버튼을 누르기 전에는 토글을 저장하지 않는다");
    assert.equal(document.getElementById("notice").dataset.state, "dirty");
    assert.equal(saveButton.disabled, false);

    skipSeconds.value = "17";
    dispatch(dom, skipSeconds, "input");
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.sync.skipSeconds, 15, "버튼을 누르기 전에는 숫자 입력을 저장하지 않는다");

    saveButton.click();
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.sync.autoQualityEnabled, false);
    assert.equal(chrome.testState.sync.skipSeconds, 17);
    assert.equal(chrome.testState.sync.followingPinOfflineToTopEnabled, true);
    assert.equal(document.getElementById("notice").dataset.state, "saved");
    assert.equal(saveButton.disabled, true);

    skipSeconds.value = "9999";
    dispatch(dom, skipSeconds, "input");
    saveButton.click();
    await waitForAsyncCallbacks();

    assert.equal(skipSeconds.value, "600", "저장 후에는 보정된 숫자를 표시한다");
    assert.equal(chrome.testState.sync.skipSeconds, 600);
});

test("unreleased ad auto skip is absent from settings and search while old stored opt-ins stay inert", async (t) => {
    const chrome = createFakeChrome({ sync: { adAutoSkipEnabled: true } });
    const dom = createDom("options.html", "options.html", chrome);
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();
    const { document, BetterChzzkSettings } = dom.window;
    assert.equal(queryOption(document, "adAutoSkipEnabled"), null);
    assert.equal(
        Object.hasOwn(BetterChzzkSettings.normalizeOptions(chrome.testState.sync), "adAutoSkipEnabled"),
        false
    );
    assert.equal(document.getElementById("save").disabled, true, "hidden stored values do not make the form dirty");
    const search = document.getElementById("settingsSearch");
    search.value = "광고 자동 건너뛰기";
    dispatch(dom, search, "input");
    assert.equal(document.getElementById("searchEmpty").classList.contains("hidden"), false);
    search.value = "";
    dispatch(dom, search, "input");
    const banner = queryOption(document, "adBannerEnabled");
    banner.checked = true;
    dispatch(dom, banner, "change");
    document.getElementById("save").click();
    await waitForAsyncCallbacks();
    assert.equal(chrome.testState.sync.adBannerEnabled, true);
    assert.equal(chrome.testState.sync.adVideoEnabled, true);
    assert.equal(chrome.testState.sync.adAutoSkipEnabled, true, "hiding does not delete the old stored value");
    assert.equal(
        Object.hasOwn(BetterChzzkSettings.normalizeOptions(chrome.testState.sync), "adAutoSkipEnabled"),
        false
    );
    assert.equal(document.getElementById("notice").dataset.state, "saved");
});

test("ad options save independently and wait for registration before reporting readiness", async (t) => {
    const chrome = createFakeChrome({ sync: { adVideoEnabled: false, adblockPopupEnabled: false } });
    let reply;
    chrome.runtime.sendMessage = (message, callback) => {
        assert.equal(message.type, "betterchzzk:ad-video:sync");
        reply = callback;
    };
    const dom = createDom("options.html", "options.html", chrome);
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();
    const { document } = dom.window;
    const input = queryOption(document, "adVideoEnabled");
    assert.equal(input.checked, false, "a saved opt-out takes precedence over the enabled default");
    input.checked = true;
    dispatch(dom, input, "change");
    document.getElementById("save").click();
    await waitForAsyncCallbacks();
    assert.equal(chrome.testState.sync.adVideoEnabled, true);
    assert.equal(Object.hasOwn(chrome.testState.sync, "adAutoSkipEnabled"), false);
    assert.equal(chrome.testState.sync.adBannerEnabled, false);
    assert.equal(chrome.testState.sync.adblockPopupEnabled, false);
    assert.equal(document.getElementById("notice").dataset.state, "saving");
    reply({ ok: true, enabled: true });
    assert.equal(document.getElementById("notice").dataset.state, "saved");
    assert.match(document.getElementById("adVideoStatus").textContent, /준비가 끝났습니다/);
    input.checked = false;
    dispatch(dom, input, "change");
    document.getElementById("save").click();
    await waitForAsyncCallbacks();
    reply({ ok: false });
    assert.equal(chrome.testState.sync.adVideoEnabled, false);
    assert.match(document.getElementById("adVideoStatus").textContent, /저장됐지만 적용 준비에 실패/);
});

test("options reverts the preview toggle when the permission request is denied", async (t) => {
    const chrome = createFakeChrome({
        sync: { followingPreviewTooltipEnabled: false },
        permissionGranted: false,
    });
    const dom = createDom("options.html", "options.html", chrome);
    t.after(() => dom.window.close());

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    const previewToggle = queryOption(document, "followingPreviewTooltipEnabled");
    const saveButton = document.getElementById("save");

    previewToggle.checked = true;
    dispatch(dom, previewToggle, "change");
    saveButton.click();
    await waitForAsyncCallbacks();

    assert.equal(previewToggle.checked, false, "거부되면 토글이 꺼진 상태로 돌아간다");
    assert.equal(chrome.testState.sync.followingPreviewTooltipEnabled, false);
    assert.equal(document.getElementById("message").dataset.type, "error");
});

test("options page shows initial storage read failures without overwriting existing sync options", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            autoQualityEnabled: true,
        },
    });
    chrome.storage.sync.get = (_keys, callback) => {
        setTimeout(() => {
            chrome.runtime.lastError = { message: "load failed" };
            callback({});
            chrome.runtime.lastError = null;
        }, 0);
    };
    const dom = createDom("options.html", "options.html", chrome);
    t.after(() => dom.window.close());

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    const autoQuality = queryOption(document, "autoQualityEnabled");
    const message = document.getElementById("message");

    assert.equal(document.getElementById("notice").dataset.state, "error");
    assert.equal(autoQuality.disabled, true);
    assert.equal(message.textContent, "설정을 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.");

    autoQuality.checked = false;
    dispatch(dom, autoQuality, "change");
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.sync.autoQualityEnabled, true);
    assert.equal(document.getElementById("notice").dataset.state, "error");
    assert.equal(message.textContent, "설정을 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.");
});

test("options page shows storage write failures without updating saved options", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            autoQualityEnabled: true,
        },
    });
    const dom = createDom("options.html", "options.html", chrome);
    t.after(() => dom.window.close());

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    chrome.storage.sync.set = (_values, callback) => {
        setTimeout(() => {
            chrome.runtime.lastError = { message: "write failed" };
            callback();
            chrome.runtime.lastError = null;
        }, 0);
    };

    const { document } = dom.window;
    const autoQuality = queryOption(document, "autoQualityEnabled");
    const saveButton = document.getElementById("save");

    autoQuality.checked = false;
    dispatch(dom, autoQuality, "change");
    saveButton.click();
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.sync.autoQualityEnabled, true);
    assert.equal(document.getElementById("notice").dataset.state, "error");
    assert.equal(
        document.getElementById("message").textContent,
        "설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요."
    );
});

test("options reset asks for confirmation before restoring defaults", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            skipSeconds: 15,
            betterchzzkPinnedFollowingChannelIds: ["channel-a"],
            followingPinOfflineToTopEnabled: true,
        },
    });
    const dom = createDom("options.html", "options.html", chrome);
    t.after(() => dom.window.close());

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    const skipSeconds = queryOption(document, "skipSeconds");
    const resetButton = document.getElementById("reset");

    dom.window.confirm = () => false;
    resetButton.click();
    await waitForAsyncCallbacks();

    assert.equal(skipSeconds.value, "15", "확인을 거부하면 아무것도 바뀌지 않는다");
    assert.equal(chrome.testState.sync.skipSeconds, 15);

    assert.equal(queryOption(document, "followingPinOfflineToTopEnabled").checked, true);

    dom.window.confirm = () => true;
    resetButton.click();
    await waitForAsyncCallbacks();

    assert.equal(skipSeconds.value, "5");
    assert.equal(chrome.testState.sync.skipSeconds, 5);
    assert.equal(queryOption(document, "followingPinOfflineToTopEnabled").checked, false);
    assert.equal(chrome.testState.sync.followingPinOfflineToTopEnabled, false);
    assert.deepEqual(chrome.testState.sync.betterchzzkPinnedFollowingChannelIds, ["channel-a"]);
});
