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

test("options page renders defaults and dependency-disabled controls without extension storage", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document, BetterChzzkSettings } = dom.window;
    const optionInputs = Array.from(document.querySelectorAll("[data-option]"));
    const notice = document.getElementById("notice");

    assert.equal(optionInputs.length, BetterChzzkSettings.OPTION_KEYS.length);
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

test("options places following controls with exploration controls", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document } = dom.window;
    const previewSection = queryOption(document, "followingPreviewTooltipEnabled").closest(".settings-card");
    const explorationSection = queryOption(document, "categoryToolsEnabled").closest(".settings-card");
    const followingRefreshSection = queryOption(document, "followingRefreshEnabled").closest(".settings-card");
    const sidebarSection = queryOption(document, "sidebarCheeseFarmHidden").closest(".settings-card");

    assert.equal(previewSection, explorationSection);
    assert.equal(followingRefreshSection, explorationSection);
    assert.equal(sidebarSection, explorationSection);
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
    dom.window.localStorage.setItem("betterChzzkOptionsLastTab", String(tabs.length - 1));
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
