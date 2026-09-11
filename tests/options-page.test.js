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
} = require("./helpers/extension-page-fixture.js");

test("options page renders defaults and dependency-disabled controls without extension storage", () => {
    const dom = createDom("options.html", "options.html");

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document, BetterChzzkSettings } = dom.window;
    const optionInputs = Array.from(document.querySelectorAll("[data-option]"));
    const notice = document.getElementById("notice");

    assert.equal(optionInputs.length, BetterChzzkSettings.OPTION_KEYS.length);
    assert.equal(queryOption(document, "skipSeconds").value, String(BetterChzzkSettings.DEFAULT_OPTIONS.skipSeconds));
    assert.equal(queryOption(document, "vodBroadcastClockEnabled").checked, true);
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

test("options captures readable playback speed keys and blocks duplicate or reserved shortcuts", async () => {
    const chrome = createFakeChrome();
    const dom = createDom("options.html", "options.html", chrome);

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    const enabled = queryOption(document, "playbackSpeedShortcutsEnabled");
    const halfKey = queryOption(document, "playbackSpeedHalfKeyCode");
    const doubleKey = queryOption(document, "playbackSpeedDoubleKeyCode");
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

    enabled.checked = false;
    dispatch(dom, enabled, "change");
    assert.equal(halfKey.disabled, true);
    assert.equal(doubleKey.disabled, true);

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
    assert.equal(doubleKey.value, "]");
    assert.match(message.textContent, /겹쳐 지정할 수 없습니다/);

    press(doubleKey, "KeyW", { key: "w" });
    assert.equal(doubleKey.value, "W");
    assert.equal(doubleKey.dataset.shortcutCode, "KeyW");

    saveButton.click();
    await waitForAsyncCallbacks();
    assert.equal(saveButton.disabled, true);
    assert.equal(chrome.testState.sync.playbackSpeedHalfKeyCode, "KeyQ");
    assert.equal(chrome.testState.sync.playbackSpeedDoubleKeyCode, "KeyW");
});

test("options places following controls with exploration controls", () => {
    const dom = createDom("options.html", "options.html");

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document } = dom.window;
    const previewSection = queryOption(document, "followingPreviewTooltipEnabled").closest(".settings-card");
    const explorationSection = queryOption(document, "categoryToolsEnabled").closest(".settings-card");
    const followingRefreshSection = queryOption(document, "followingRefreshEnabled").closest(".settings-card");
    const sidebarSection = queryOption(document, "sidebarCheeseFarmHidden").closest(".settings-card");
    const optionOrder = Array.from(explorationSection.querySelectorAll("[data-option]")).map(
        (input) => input.dataset.option
    );

    assert.equal(previewSection, explorationSection);
    assert.equal(followingRefreshSection, explorationSection);
    assert.equal(sidebarSection, explorationSection);
    assert.equal(queryOption(document, "channelChatLinkEnabled").closest(".settings-card"), explorationSection);
    assert.equal(queryOption(document, "channelChatLinkEnabled").checked, true);
    assert.equal(queryOption(document, "sidebarCheeseFarmHidden").checked, false);
    assert.equal(queryOption(document, "followingPinEnabled").checked, true);
    const offlineHidden = queryOption(document, "followingOfflineHidden");
    assert.equal(offlineHidden.checked, false);
    assert.equal(offlineHidden.disabled, false);
    const offlineToTop = queryOption(document, "followingPinOfflineToTopEnabled");
    assert.equal(offlineToTop.checked, false);
    assert.equal(offlineToTop.disabled, false);
    assert.equal(offlineToTop.closest("label").textContent.trim(), "오프라인이어도 최상단 고정");
    assert.ok(optionOrder.indexOf("sidebarCheeseFarmHidden") < optionOrder.indexOf("followingPinEnabled"));
    assert.ok(optionOrder.indexOf("followingPinEnabled") < optionOrder.indexOf("followingRefreshEnabled"));
    assert.ok(optionOrder.indexOf("followingPinEnabled") < optionOrder.indexOf("followingPinOfflineToTopEnabled"));
    assert.ok(optionOrder.indexOf("followingPinOfflineToTopEnabled") < optionOrder.indexOf("followingRefreshEnabled"));
    assert.ok(optionOrder.indexOf("followingRefreshEnabled") < optionOrder.indexOf("followingRefreshSeconds"));
    assert.ok(optionOrder.indexOf("followingRefreshSeconds") < optionOrder.indexOf("categoryToolsEnabled"));
    assert.ok(optionOrder.indexOf("categoryToolsLiveElapsedEnabled") < optionOrder.indexOf("titleTooltipEnabled"));
    assert.ok(optionOrder.indexOf("titleTooltipEnabled") < optionOrder.indexOf("followingPreviewTooltipEnabled"));
    assert.ok(
        optionOrder.indexOf("followingPreviewTooltipEnabled") < optionOrder.indexOf("followingPreviewSoundEnabled")
    );
    assert.ok(
        optionOrder.indexOf("followingPreviewSoundEnabled") < optionOrder.indexOf("followingPreviewVolumePercent")
    );
    assert.ok(
        optionOrder.indexOf("followingPreviewVolumePercent") < optionOrder.indexOf("livePreviewRightClickSoundEnabled")
    );
    assert.deepEqual(
        Array.from(explorationSection.querySelectorAll(".option-group > summary"), (summary) =>
            summary.textContent.trim()
        ),
        [
            "채널",
            "사이드바",
            "목록 새로고침",
            "검색·목록 표시",
            "호버 미리보기",
            "팔로워 필터 기준값",
            "시청자·조회수 필터 기준값",
            "진행 시간 필터 기준값",
            "데이터 조회",
        ]
    );

    queryOption(document, "followingPinEnabled").checked = false;
    dispatch(dom, queryOption(document, "followingPinEnabled"), "change");
    assert.equal(offlineToTop.disabled, true);
    assert.equal(offlineHidden.disabled, false);
    queryOption(document, "followingPinEnabled").checked = true;
    dispatch(dom, queryOption(document, "followingPinEnabled"), "change");
    assert.equal(offlineToTop.disabled, false);
});

test("options groups stay accessible and never disable their own master toggle", () => {
    const dom = createDom("options.html", "options.html");

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document } = dom.window;
    const groups = Array.from(document.querySelectorAll(".option-group"));
    const playerAuto = document.querySelector('[data-option-group="player-auto"]');
    const playerCompressor = document.querySelector('[data-option-group="player-compressor"]');

    assert.ok(groups.length >= 10);
    assert.equal(document.querySelector(".advanced-settings"), null);
    assert.equal(document.querySelector(".section-heading p"), null);
    assert.equal(document.querySelector(".toggle-row small"), null);
    assert.equal(document.querySelectorAll(".option-group[open]").length, 9);
    assert.equal(playerAuto.open, true);
    assert.equal(playerCompressor.open, false);

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
    assert.equal(tabs.length, 7);
    assert.equal(panels.length, tabs.length);
    assert.equal(document.querySelectorAll(".section-heading-icon[aria-hidden='true']").length, 7);
    assert.ok(tabs.every((tab) => tab.getAttribute("aria-label") && tab.getAttribute("title")));
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

test("options match the wide reference layout and keep a compact popup layout", () => {
    const styles = readRepoFile("styles.css");
    const readRule = (selector) => {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return styles.match(new RegExp(`(?:^|\\r?\\n)[ \\t]*${escaped}[ \\t]*\\{([^}]*)\\}`))?.[1] || "";
    };

    const pageRule = readRule(".options-body .options-page");
    const toggleRule = readRule(".options-body .options-page .toggle-row");
    const groupRule = readRule(".options-body .options-page .option-group");
    const summaryRule = readRule(".options-body .options-page .option-group > summary");
    const summaryFocusRule = readRule(".option-group > summary:focus-visible");
    const activeTabRule = readRule(".options-body .options-page .tab.is-active");
    const activeTabLineRule = readRule(".options-body .options-page .tab.is-active::after");
    const compactTabLabelRule = readRule(".options-body .options-page .tab span");
    const noteRule = readRule(".options-body .options-page .setting-note");
    const unitRule = readRule(".options-body .options-page .number-grid em");
    const responsiveStart = styles.lastIndexOf("@media (max-width: 860px)");
    const responsiveEnd = styles.indexOf("@media (max-width: 640px)", responsiveStart);
    const responsiveRules = styles.slice(responsiveStart, responsiveEnd);
    const compactStart = styles.lastIndexOf("@media (max-width: 640px)");
    const compactEnd = styles.indexOf("@media (max-width: 480px)", compactStart);
    const compactRules = styles.slice(compactStart, compactEnd);
    const popupStart = styles.lastIndexOf("@media (max-width: 480px)");
    const popupEnd = styles.indexOf("@media (max-width: 360px)", popupStart);
    const popupRules = styles.slice(popupStart, popupEnd);
    const referenceStart = styles.indexOf("/* Options page — reference layout");
    const referenceRules = styles.slice(referenceStart);

    assert.match(pageRule, /width:\s*min\(1344px, 100%\)/);
    assert.match(toggleRule, /min-height:\s*58px/);
    assert.match(groupRule, /border:\s*1px solid var\(--border\)/);
    assert.match(groupRule, /border-radius:\s*9px/);
    assert.match(summaryRule, /min-height:\s*54px/);
    assert.match(summaryRule, /padding:\s*0 22px/);
    assert.match(summaryFocusRule, /var\(--focus-ring\)/);
    assert.match(activeTabRule, /color:\s*var\(--accent-text\)/);
    assert.match(activeTabRule, /background:\s*transparent/);
    assert.match(activeTabLineRule, /height:\s*3px/);
    assert.match(activeTabLineRule, /background:\s*var\(--accent\)/);
    assert.match(compactTabLabelRule, /clip:\s*rect\(0, 0, 0, 0\)/);
    assert.match(popupRules, /grid-template-columns:\s*repeat\(7, minmax\(0, 1fr\)\)/);
    assert.match(
        compactRules,
        /\.options-body \.options-page \.option-group-body > \.number-grid\s*\{\s*grid-template-columns:\s*1fr/
    );
    assert.match(popupRules, /\.options-body \.options-page \.reset-row \.secondary-button\s*\{\s*width:\s*100%/);
    assert.match(popupRules, /grid-template-columns:\s*48px minmax\(0, 1fr\)/);
    assert.match(
        popupRules,
        /\.options-body \.options-page \.brand-mark\s*\{[^}]*grid-row:\s*1 \/ 3[^}]*width:\s*48px/s
    );
    assert.match(popupRules, /\.options-body \.options-page \.hero-actions\s*\{[^}]*grid-column:\s*2/s);
    assert.doesNotMatch(referenceRules, /(?:^|\n)\s*\.options-page(?:[\s,.#:[>+]|$)/);
    assert.match(noteRule, /color:\s*var\(--text-muted\)/);
    assert.match(noteRule, /font-size:\s*13px/);
    assert.match(responsiveRules, /\.options-body \.options-page \.setting-note\s*\{[^}]*font-size:\s*11px/s);
    assert.match(
        responsiveRules,
        /\.options-body \.options-page \.toggle-row input\[type="checkbox"\]::before\s*\{[^}]*left:\s*2px[^}]*top:\s*2px/s
    );
    assert.match(unitRule, /color:\s*var\(--text-muted\)/);
    assert.doesNotMatch(referenceRules, /padding-bottom:\s*(?:68|74)px|\.action-bar/);
});

test("options search keeps dependency controls visible and restores previous group state", () => {
    const dom = createDom("options.html", "options.html");

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

    search.value = "라이브에도 스킵 버튼 표시";
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

test("options search finds the offline pin option together with its parent feature", () => {
    const dom = createDom("options.html", "options.html");
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

test("options page saves changed toggles and numbers when the save button is clicked", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipSeconds: 15,
            videoSearchEnabled: false,
        },
    });
    const dom = createDom("options.html", "options.html", chrome);

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
    assert.equal(chrome.testState.sync.adVideoEnabled, false);
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

test("options reverts the preview toggle when the permission request is denied", async () => {
    const chrome = createFakeChrome({
        sync: { followingPreviewTooltipEnabled: false },
        permissionGranted: false,
    });
    const dom = createDom("options.html", "options.html", chrome);

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

test("options page shows initial storage read failures without overwriting existing sync options", async () => {
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

test("options page shows storage write failures without updating saved options", async () => {
    const chrome = createFakeChrome({
        sync: {
            autoQualityEnabled: true,
        },
    });
    const dom = createDom("options.html", "options.html", chrome);

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

test("options reset asks for confirmation before restoring defaults", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipSeconds: 15,
            betterchzzkPinnedFollowingChannelIds: ["channel-a"],
            followingPinOfflineToTopEnabled: true,
        },
    });
    const dom = createDom("options.html", "options.html", chrome);

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
