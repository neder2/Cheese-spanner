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

async function openOptions(t) {
    const chrome = createFakeChrome({ sync: { autoQualityEnabled: true, skipSeconds: 15 } });
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
    document.getElementById("tab-1").click();
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
    assert.equal(document.getElementById("tab-1").getAttribute("aria-selected"), "true");
    assert.equal(document.getElementById("notice").dataset.state, "saved");
    assert.equal(document.getElementById("save").disabled, true);
    assert.equal(document.getElementById("discardChanges").disabled, true);
    assert.equal(writes, 0);
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
        if (granted) {
            assert.equal(writes.length, 1);
            assert.equal(writes[0].values.followingPreviewTooltipEnabled, true);
            assert.equal(writes[0].values.skipSeconds, 15, "permission approval saves only the clicked snapshot");
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
    assert.equal(message.classList.contains("hidden"), false);
    chrome.storage.sync.set = (_values, complete) => complete();
    save.click();
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
