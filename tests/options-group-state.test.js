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
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    return dom;
}
function search(dom, value) {
    const input = dom.window.document.getElementById("settingsSearch");
    input.value = value;
    dispatch(dom, input, "input");
}

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
    assert.equal(group(dom, "player-volume").open, false);
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
