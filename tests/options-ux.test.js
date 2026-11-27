const assert = require("node:assert/strict");
const test = require("node:test");
const {
    createDom,
    createFakeChrome,
    evalRepoScript,
    dispatch,
    queryOption,
    waitForAsyncCallbacks,
} = require("./helpers/extension-page-fixture.js");

async function openOptions(t, sync = { autoQualityEnabled: true, skipSeconds: 15 }) {
    const chrome = createFakeChrome({ sync });
    const dom = createDom("options.html", "options.html", chrome);
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();
    return { dom, chrome, document: dom.window.document };
}

test("options count unsaved changes across categories and discard without writing or clearing search", async (t) => {
    const { dom, chrome, document } = await openOptions(t);
    let writes = 0;
    chrome.storage.sync.set = () => writes++;
    const quality = queryOption(document, "autoQualityEnabled");
    const skip = queryOption(document, "skipSeconds");
    quality.checked = false;
    dispatch(dom, quality, "change");
    document.querySelector('[data-tab="history"]').click();
    skip.value = "30";
    dispatch(dom, skip, "input");
    assert.equal(document.getElementById("notice").textContent, "변경 2개");
    quality.checked = true;
    dispatch(dom, quality, "change");
    assert.equal(document.getElementById("notice").textContent, "변경 1개");
    const search = document.getElementById("settingsSearch");
    search.value = "스킵";
    dispatch(dom, search, "input");
    document.getElementById("discardChanges").click();
    assert.equal(skip.value, "15", "discard restores the saved custom value, not the default");
    assert.equal(search.value, "스킵");
    assert.equal(document.querySelector('[data-tab="history"]').getAttribute("aria-selected"), "true");
    assert.equal(document.getElementById("notice").dataset.state, "saved");
    assert.equal(document.getElementById("save").disabled, true);
    assert.equal(document.getElementById("discardChanges").disabled, true);
    assert.equal(writes, 0);
});

test("new sound and filter categories preserve drafts through search, disclosure, discard and explicit save", async (t) => {
    const { dom, chrome, document } = await openOptions(t);
    const sound = queryOption(document, "volumeWheelStep");
    const filter = queryOption(document, "categoryToolsFollowerFilterPreset1");
    const originals = [sound.value, filter.value];
    const writes = [];
    const save = chrome.storage.sync.set.bind(chrome.storage.sync);
    chrome.storage.sync.set = (values, callback) => {
        writes.push(values);
        save(values, callback);
    };
    function editBoth() {
        document.querySelector('[data-tab="sound"]').click();
        sound.value = "7";
        dispatch(dom, sound, "input");
        document.querySelector('[data-tab="search-filter"]').click();
        const presets = filter.closest(".option-group");
        if (!presets.open) presets.firstElementChild.click();
        filter.value = "345";
        dispatch(dom, filter, "input");
    }
    editBoth();
    const search = document.getElementById("settingsSearch");
    search.value = "팔로워 필터";
    dispatch(dom, search, "input");
    document.querySelector('[data-tab="sound"]').click();
    assert.equal(search.value, "");
    assert.equal(sound.value, "7");
    assert.equal(filter.value, "345");
    assert.equal(document.getElementById("notice").textContent, "변경 2개");
    assert.equal(writes.length, 0);
    document.getElementById("discardChanges").click();
    assert.deepEqual([sound.value, filter.value], originals);
    assert.equal(writes.length, 0);
    editBoth();
    document.getElementById("save").click();
    await waitForAsyncCallbacks();
    assert.equal(writes.length, 1);
    assert.equal(chrome.testState.sync.volumeWheelStep, 7);
    assert.equal(chrome.testState.sync.categoryToolsFollowerFilterPreset1, 345);
    assert.equal(document.getElementById("notice").dataset.state, "saved");
});

test("discard is unavailable during a write and later restores the newly saved snapshot", async (t) => {
    const { dom, chrome, document } = await openOptions(t);
    const writes = [];
    chrome.storage.sync.set = (values, complete) => writes.push({ values, complete });
    const quality = queryOption(document, "autoQualityEnabled");
    const skip = queryOption(document, "skipSeconds");
    quality.checked = false;
    dispatch(dom, quality, "change");
    document.getElementById("save").click();
    const discard = document.getElementById("discardChanges");
    assert.equal(discard.disabled, true);
    skip.value = "25";
    dispatch(dom, skip, "input");
    dispatch(dom, discard, "click");
    assert.equal(skip.value, "25");
    // The save re-reads the latest stored options inside the settings lock before it writes.
    await waitForAsyncCallbacks();
    assert.equal(writes.length, 1);
    writes[0].complete();
    assert.equal(document.getElementById("notice").textContent, "변경 1개");
    assert.equal(discard.disabled, false);
    discard.focus();
    discard.click();
    assert.equal(quality.checked, false);
    assert.equal(skip.value, "15");
    assert.equal(writes.length, 1);
    assert.equal(document.activeElement.getAttribute("role"), "tab");
});

for (const granted of [true, false]) {
    test(`permission ${granted ? "approval" : "denial"} blocks discard and preserves later edits`, async (t) => {
        const { dom, chrome, document } = await openOptions(t);
        const requests = [];
        const writes = [];
        chrome.permissions.request = (_spec, complete) => requests.push(complete);
        chrome.storage.sync.set = (values, complete) => writes.push({ values, complete });
        const preview = queryOption(document, "followingPreviewTooltipEnabled");
        const skip = queryOption(document, "skipSeconds");
        preview.checked = true;
        dispatch(dom, preview, "change");
        const save = document.getElementById("save");
        const discard = document.getElementById("discardChanges");
        const reset = document.getElementById("reset");
        save.click();
        assert.equal(discard.disabled, true);
        assert.equal(save.disabled, true);
        assert.equal(reset.disabled, true);
        assert.equal(document.getElementById("notice").dataset.state, "saving");
        dispatch(dom, discard, "click");
        dispatch(dom, save, "click");
        dispatch(dom, reset, "click");
        assert.equal(preview.checked, true);
        assert.equal(requests.length, 1);
        assert.equal(writes.length, 0);
        skip.value = "30";
        dispatch(dom, skip, "input");
        requests[0](granted);
        await waitForAsyncCallbacks();
        if (granted) {
            assert.equal(writes.length, 1);
            assert.equal(writes[0].values.followingPreviewTooltipEnabled, true);
            assert.equal(
                Object.hasOwn(writes[0].values, "skipSeconds"),
                false,
                "permission approval saves only the clicked snapshot, not the later edit"
            );
            assert.equal(discard.disabled, true);
            writes[0].complete();
        } else {
            assert.equal(writes.length, 0);
            assert.equal(preview.checked, false);
            assert.equal(document.getElementById("message").dataset.type, "error");
        }
        assert.equal(skip.value, "30", "later edits remain in the form");
        assert.equal(document.getElementById("notice").textContent, "변경 1개");
        assert.equal(discard.disabled, false);
        discard.click();
        assert.equal(skip.value, "15");
        assert.equal(preview.checked, granted);
        assert.equal(writes.length, granted ? 1 : 0);
    });
}

test("save errors persist until dismissed or successfully retried while successes remain temporary", async (t) => {
    const { dom, chrome, document } = await openOptions(t);
    const timers = new Map();
    let timerId = 0;
    dom.window.setTimeout = (callback, delay) => {
        timers.set(++timerId, { callback, delay });
        return timerId;
    };
    dom.window.clearTimeout = (id) => timers.delete(id);
    chrome.storage.sync.set = (_values, complete) => {
        chrome.runtime.lastError = { message: "write failed" };
        complete();
        chrome.runtime.lastError = null;
    };
    const quality = queryOption(document, "autoQualityEnabled");
    quality.checked = false;
    dispatch(dom, quality, "change");
    const save = document.getElementById("save");
    const message = document.getElementById("message");
    save.click();
    await waitForAsyncCallbacks();
    assert.equal(message.dataset.type, "error");
    assert.equal(message.classList.contains("hidden"), false);
    assert.equal(
        [...timers.values()].some(({ delay }) => delay === 1800),
        false
    );
    let dismiss = message.querySelector('button[aria-label="오류 안내 닫기"]');
    assert.ok(dismiss);
    const failWrite = chrome.storage.sync.set;
    let retry;
    chrome.storage.sync.set = (_values, complete) => {
        retry = complete;
    };
    save.click();
    await waitForAsyncCallbacks();
    dismiss.focus();
    chrome.runtime.lastError = { message: "retry failed" };
    retry();
    chrome.runtime.lastError = null;
    assert.equal(dismiss.isConnected, false);
    dismiss = message.querySelector(".message-close");
    assert.equal(document.activeElement, dismiss, "another failure keeps focus on the new dismiss button");
    chrome.storage.sync.set = failWrite;
    dismiss.focus();
    dismiss.click();
    assert.equal(message.classList.contains("hidden"), true);
    assert.equal(document.activeElement, save);
    save.click();
    await waitForAsyncCallbacks();
    assert.equal(message.classList.contains("hidden"), false);
    chrome.storage.sync.set = (_values, complete) => complete();
    save.click();
    await waitForAsyncCallbacks();
    assert.equal(message.dataset.type, "success");
    assert.equal(message.querySelector("button"), null);
    assert.equal(document.getElementById("notice").dataset.state, "saved");
    const successTimer = [...timers.values()].find(({ delay }) => delay === 1800);
    assert.ok(successTimer);
    successTimer.callback();
    assert.equal(message.classList.contains("hidden"), true);
});

test("compact header retains release notes and reset with Escape and outside dismissal", async (t) => {
    const { dom, document } = await openOptions(t);
    const menu = document.getElementById("headerMenu");
    const trigger = menu.querySelector("summary");
    trigger.click();
    assert.equal(menu.open, true);
    assert.equal(trigger.getAttribute("aria-label"), "설정 더보기");
    assert.ok(menu.querySelector('a[href="https://github.com/neder2/Chzzk/releases"]'));
    const reset = document.getElementById("reset");
    reset.focus();
    reset.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(menu.open, false);
    assert.equal(document.activeElement, trigger);
    trigger.click();
    document.getElementById("settingsSearch").click();
    assert.equal(menu.open, false);
    trigger.click();
    trigger.focus();
    document.getElementById("settingsSearch").focus();
    assert.equal(menu.open, false, "tabbing away must not leave the header menu covering the form");
});

test("related VOD settings reveal and focus controls across tabs while preserving the unsaved draft", async (t) => {
    const { dom, chrome, document } = await openOptions(t);
    const clock = queryOption(document, "vodBroadcastClockEnabled");
    const multiview = queryOption(document, "vodMultiviewEnabled");
    const previous = clock.checked;
    let writes = 0;
    chrome.storage.sync.set = () => writes++;
    document.querySelector('[data-tab="vod"]').click();
    clock.checked = !previous;
    dispatch(dom, clock, "change");
    const search = document.getElementById("settingsSearch");
    search.value = "다시보기";
    dispatch(dom, search, "input");
    for (const target of [multiview, clock]) {
        const button = document.querySelector(`[data-related-option="${target.id}"]`);
        button.click();
        assert.equal(search.value, "");
        assert.equal(target.closest(".option-group").open, true);
        assert.equal(target.closest(".settings-card").classList.contains("is-active"), true);
        assert.equal(document.activeElement, target);
    }
    assert.equal(clock.checked, !previous);
    assert.equal(document.getElementById("notice").textContent, "변경 1개");
    assert.equal(writes, 0);
});

test("search aliases offer the matching controls and jumping preserves the unsaved draft and permissions", async (t) => {
    const { dom, chrome, document } = await openOptions(t);
    document.querySelector('[data-tab="sound"]').click();
    const sound = queryOption(document, "volumeWheelStep");
    sound.value = "7";
    dispatch(dom, sound, "input");
    const search = document.getElementById("settingsSearch");
    const jump = document.getElementById("settingsSearchJump");
    const trigger = jump.querySelector("summary");
    assert.equal(jump.hidden, true);
    assert.equal(trigger.textContent.trim(), "설정으로 이동");
    const multiview = ["liveMultiviewEnabled", "vodMultiviewEnabled", "chatMultiviewEnabled"];
    for (const [query, keys] of [
        ["도네", ["liveWatchHistoryDonationEnabled", "chatWeeklyRankingHidden", "chatDonationMessagesHidden"]],
        ["동시시청", multiview],
        ["합방", multiview],
    ]) {
        search.focus();
        search.value = query;
        dispatch(dom, search, "input");
        assert.equal(jump.hidden, false);
        assert.equal(document.activeElement, search);
        assert.equal(document.querySelector('.tab[aria-selected="true"]').dataset.tab, "sound");
        if (!jump.open) trigger.click();
        for (const key of keys) {
            assert.equal(queryOption(document, key).closest(".search-miss"), null, key);
            assert.equal(jump.querySelectorAll(`button[type="button"][data-jump-option="${key}"]`).length, 1, key);
        }
        assert.equal(jump.querySelector('[data-jump-option="autoQualityEnabled"]'), null);
        assert.equal(document.getElementById("searchEmpty").classList.contains("hidden"), true, query);
    }
    const live = queryOption(document, "liveMultiviewEnabled");
    const original = live.checked;
    jump.querySelector('[data-jump-option="liveMultiviewEnabled"]').click();
    assert.equal(document.activeElement, live);
    assert.equal(live.closest(".settings-card").classList.contains("is-active"), true);
    assert.equal(live.closest(".option-group").open, true);
    assert.equal(live.closest("label").classList.contains("search-target-highlight"), true);
    assert.equal(live.checked, original);
    assert.equal(search.value, "");
    assert.equal(jump.hidden, true);
    assert.equal(sound.value, "7");
    assert.equal(document.getElementById("notice").textContent, "변경 1개");
    assert.deepEqual(chrome.testState.sync, { autoQualityEnabled: true, skipSeconds: 15 });
    assert.equal(chrome.testState.permissionRequests.length, 0);
});

test("search jump keyboard navigation leaves IME keys alone and returns focus on Escape", async (t) => {
    const { dom, document } = await openOptions(t);
    const search = document.getElementById("settingsSearch");
    const jump = document.getElementById("settingsSearchJump");
    function keydown(key, options = {}) {
        const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
        document.activeElement.dispatchEvent(event);
        return event.defaultPrevented;
    }
    search.focus();
    search.value = "합방";
    dispatch(dom, search, "input");
    for (const marker of [{ isComposing: true }, { keyCode: 229 }]) {
        for (const key of ["Escape", "ArrowDown"]) {
            assert.equal(keydown(key, marker), false);
            assert.equal(search.value, "합방");
            assert.equal(document.activeElement, search);
            assert.equal(jump.open, false);
        }
    }
    assert.equal(keydown("ArrowDown"), true);
    assert.equal(jump.open, true);
    assert.equal(document.activeElement, jump.querySelector("button[data-jump-option]"));
    assert.equal(keydown("Escape"), true);
    assert.equal(jump.open, false);
    assert.equal(document.activeElement, search);
    assert.equal(search.value, "합방");
    assert.equal(keydown("Escape"), true);
    assert.equal(search.value, "");
    assert.equal(jump.hidden, true);
    search.value = "없는설정xyz";
    dispatch(dom, search, "input");
    assert.equal(jump.hidden, true);
    assert.equal(document.getElementById("searchEmpty").classList.contains("hidden"), false);
    assert.equal(keydown("ArrowDown"), false);
});

test("a disabled search target reveals and focuses its label without enabling its dependency", async (t) => {
    const { dom, chrome, document } = await openOptions(t);
    const search = document.getElementById("settingsSearch");
    const jump = document.getElementById("settingsSearchJump");
    const gain = queryOption(document, "audioCompressorMakeupGain");
    const enable = queryOption(document, "audioCompressorEnabled");
    const row = gain.closest("label");
    search.value = "audioCompressorMakeupGain";
    dispatch(dom, search, "input");
    jump.querySelector("summary").click();
    jump.querySelector('[data-jump-option="audioCompressorMakeupGain"]').click();
    assert.equal(gain.closest(".option-group").open, true);
    assert.equal(document.activeElement, row);
    assert.equal(row.classList.contains("search-target-highlight"), true);
    assert.equal(gain.disabled, true);
    assert.equal(enable.checked, false);
    assert.equal(document.getElementById("save").disabled, true);
    assert.equal(chrome.testState.permissionRequests.length, 0);
});

test("search jumps track visible match conditions without substituting a sibling for a hidden option key", async (t) => {
    const { dom, document } = await openOptions(t);
    const search = document.getElementById("settingsSearch");
    const jump = document.getElementById("settingsSearchJump");
    const applyMode = queryOption(document, "chatKeywordFilterApplyMode");
    const matchMode = queryOption(document, "chatKeywordFilterMatchMode");
    const matchJump = '[data-jump-option="chatKeywordFilterMatchMode"]';
    search.value = "문구";
    dispatch(dom, search, "input");
    jump.querySelector("summary").click();
    assert.ok(jump.querySelector(matchJump));
    for (const mode of ["individual", "all", "individual"]) {
        applyMode.value = mode;
        dispatch(dom, applyMode, "change");
        await waitForAsyncCallbacks();
        assert.equal(search.value, "문구");
        assert.equal(matchMode.closest("label").hidden, mode === "individual");
        assert.equal(Boolean(jump.querySelector(matchJump)), mode === "all", mode);
    }
    search.value = matchMode.dataset.option;
    dispatch(dom, search, "input");
    assert.equal(jump.hidden, true);
    assert.equal(jump.querySelector('[data-jump-option="chatKeywordFilterApplyMode"]'), null);
});

test("the nondefault filter uses the current draft and restores the selected category and group without writing", async (t) => {
    const { dom, chrome, document } = await openOptions(t);
    const filter = document.getElementById("nonDefaultOnly");
    const list = document.getElementById("nonDefaultList");
    const keys = () => [...list.querySelectorAll("button")].map((button) => button.dataset.jumpOption);
    const sound = queryOption(document, "volumeWheelStep");
    const skip = queryOption(document, "skipSeconds");
    const group = sound.closest(".option-group");
    document.getElementById("tab-sound").click();
    if (group.open) group.querySelector("summary").click();
    await waitForAsyncCallbacks();
    const localBefore = { ...chrome.testState.local };
    filter.click();
    assert.deepEqual(keys(), ["skipSeconds"]);
    assert.match(list.textContent, /15/);
    assert.equal(document.getElementById("notice").dataset.state, "saved");
    assert.equal(document.getElementById("save").disabled, true);
    filter.click();
    assert.ok(list.hidden);
    assert.equal(group.open, false);
    assert.equal(document.getElementById("tab-sound").getAttribute("aria-selected"), "true");
    assert.deepEqual(chrome.testState.local, localBefore);

    sound.value = "7";
    dispatch(dom, sound, "input");
    skip.value = String(dom.window.CheeseSpannerSettings.DEFAULT_OPTIONS.skipSeconds);
    dispatch(dom, skip, "input");
    filter.click();
    assert.deepEqual(keys(), ["volumeWheelStep"]);
    assert.match(list.textContent, /7/);
    assert.equal(document.getElementById("notice").textContent, "변경 2개");
    document.getElementById("discardChanges").click();
    assert.deepEqual(keys(), ["skipSeconds"]);
    assert.equal(filter.checked, true);
    assert.equal(document.getElementById("notice").dataset.state, "saved");

    list.querySelector("button").click();
    assert.equal(document.activeElement, skip);
    assert.equal(filter.checked, false);
    skip.value = String(dom.window.CheeseSpannerSettings.DEFAULT_OPTIONS.skipSeconds);
    dispatch(dom, skip, "change");
    filter.click();
    assert.deepEqual(keys(), []);
    assert.match(document.getElementById("searchEmpty").textContent, /기본값과 다른 설정 없음/);
    assert.deepEqual(chrome.testState.sync, { autoQualityEnabled: true, skipSeconds: 15 });
    assert.equal(chrome.testState.permissionRequests.length, 0);
    document.getElementById("save").click();
    await waitForAsyncCallbacks();
    assert.equal(chrome.testState.sync.skipSeconds, dom.window.CheeseSpannerSettings.DEFAULT_OPTIONS.skipSeconds);
    assert.equal(Object.hasOwn(chrome.testState.sync, "nonDefaultOnly"), false);
    assert.equal(filter.checked, true);
    assert.deepEqual(keys(), []);
});

test("changed results intersect search aliases, preserve IME navigation and focus the exact setting", async (t) => {
    const { dom, chrome, document } = await openOptions(t, { liveMultiviewEnabled: true, optionsTheme: "dark" });
    const search = document.getElementById("settingsSearch");
    const filter = document.getElementById("nonDefaultOnly");
    const list = document.getElementById("nonDefaultList");
    const result = (key) => list.querySelector(`[data-jump-option="${key}"]`);
    const hit = (key, flags) => {
        const e = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...flags });
        document.activeElement.dispatchEvent(e);
        return e.defaultPrevented;
    };
    filter.click();
    assert.match(result("optionsTheme").textContent, /다크/);
    assert.ok(result("liveMultiviewEnabled"));
    search.value = "합방";
    dispatch(dom, search, "input");
    assert.equal(result("optionsTheme"), null);
    assert.equal(list.childElementCount, 1);
    assert.match(list.textContent, /켬/);
    search.focus();
    assert.equal(hit("ArrowDown", { isComposing: true }), false);
    assert.equal(hit("Escape", { keyCode: 229 }), false);
    assert.equal(search.value, "합방");
    assert.equal(hit("ArrowDown"), true);
    assert.equal(document.activeElement, result("liveMultiviewEnabled"));
    assert.equal(hit("Escape"), true);
    assert.equal(document.activeElement, search);
    assert.equal(hit("Escape"), true);
    assert.equal(search.value, "");
    assert.equal(filter.checked, true);
    result("liveMultiviewEnabled").click();
    assert.equal(document.activeElement, queryOption(document, "liveMultiviewEnabled"));
    assert.equal(filter.checked, false);
    assert.equal(document.getElementById("save").disabled, true);
    assert.equal(chrome.testState.permissionRequests.length, 0);
    filter.click();
    result("optionsTheme").click();
    assert.equal(document.activeElement.id, "optionsTheme");
    assert.equal(document.activeElement.value, "dark");
    assert.equal(filter.checked, false);
});

test("the nondefault list respects conditional rows and updates after an external setting change", async (t) => {
    const { chrome, document } = await openOptions(t, {
        audioCompressorMakeupGain: 2,
        chatKeywordFilterApplyMode: "individual",
        chatKeywordFilterMatchMode: "exact",
    });
    const filter = document.getElementById("nonDefaultOnly");
    const list = document.getElementById("nonDefaultList");
    const result = (key) => list.querySelector(`[data-jump-option="${key}"]`);
    filter.click();
    assert.equal(result("chatKeywordFilterMatchMode"), null);
    assert.ok(result("chatKeywordFilterApplyMode"));
    assert.ok(result("audioCompressorMakeupGain"));
    result("audioCompressorMakeupGain").click();
    assert.equal(document.activeElement, queryOption(document, "audioCompressorMakeupGain").labels[0]);
    assert.equal(queryOption(document, "audioCompressorEnabled").checked, false);
    filter.click();
    chrome.testState.sync.chatKeywordFilterApplyMode = "all";
    for (const fn of chrome.testState.storageChangeListeners)
        fn({ chatKeywordFilterApplyMode: { oldValue: "individual", newValue: "all" } }, "sync");
    assert.ok(result("chatKeywordFilterMatchMode"));
    assert.equal(result("chatKeywordFilterApplyMode"), null);
    assert.equal(document.getElementById("save").disabled, true);
    assert.equal(chrome.testState.permissionRequests.length, 0);
    document.getElementById("tab-history").click();
    assert.equal(filter.checked, false);
    assert.equal(document.getElementById("tab-history").getAttribute("aria-selected"), "true");
});
