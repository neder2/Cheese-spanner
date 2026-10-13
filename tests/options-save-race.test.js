const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repoRoot = path.join(__dirname, "..");

function readRepoFile(...parts) {
    return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

function waitForCallbacks() {
    return new Promise((resolve) => setTimeout(resolve, 20));
}

async function createOptionsFixture(t, initial = { autoQualityEnabled: true }, { deferLoad = false } = {}) {
    const stored = { ...initial };
    const setCalls = [];
    const permissionRequests = [];
    const changeListeners = [];
    let lastError = null;
    let pendingGetCallback = null;
    // Only the page's initial read can be held; the read inside a later save resolves on the next task.
    let deferNextGet = deferLoad;
    function writeStored(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
            if (!Object.is(stored[key], value)) changes[key] = { oldValue: stored[key], newValue: value };
        }
        Object.assign(stored, values);
        if (Object.keys(changes).length) for (const listener of [...changeListeners]) listener(changes, "sync");
    }
    const chrome = {
        runtime: {
            getManifest: () => ({ version: "1.2.2" }),
            get lastError() {
                return lastError;
            },
        },
        permissions: {
            request(spec, callback) {
                permissionRequests.push(spec);
                callback(true);
            },
        },
        storage: {
            onChanged: {
                addListener: (listener) => changeListeners.push(listener),
            },
            sync: {
                get(_keys, callback) {
                    if (deferNextGet) {
                        deferNextGet = false;
                        pendingGetCallback = callback;
                        return;
                    }
                    setTimeout(() => callback({ ...stored }), 0);
                },
                set(values, callback) {
                    setCalls.push({
                        values: { ...values },
                        complete(error = null) {
                            if (!error) writeStored(values);
                            lastError = error ? { message: String(error) } : null;
                            callback?.();
                            lastError = null;
                        },
                    });
                },
            },
        },
    };
    const dom = new JSDOM(readRepoFile("options.html"), {
        url: "chrome-extension://better-chzzk/options.html",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    dom.window.chrome = chrome;
    dom.window.confirm = () => true;
    dom.window.eval(readRepoFile("shared", "settings.js"));
    dom.window.eval(readRepoFile("options.js"));
    if (!deferLoad) await waitForCallbacks();

    return {
        dom,
        permissionRequests,
        setCalls,
        stored,
        // Another option page, a Chzzk page through the worker, or a settings file writes and Chrome notifies.
        externalWrite: writeStored,
        completeLoad(error = null) {
            assert.ok(pendingGetCallback, "the initial storage read should be pending");
            const callback = pendingGetCallback;
            pendingGetCallback = null;
            lastError = error ? { message: String(error) } : null;
            callback(error ? {} : { ...stored });
            lastError = null;
        },
    };
}

test("retired latency settings have no control and are not included in later option saves", async (t) => {
    const { dom, setCalls, stored, permissionRequests } = await createOptionsFixture(t, {
        autoQualityEnabled: false,
        liveLowLatencyEnabled: true,
    });
    const doc = dom.window.document;
    assert.equal(doc.querySelector('[data-option="liveLowLatencyEnabled"]'), null);
    const quality = doc.querySelector('[data-option="autoQualityEnabled"]');
    quality.checked = true;
    quality.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    doc.getElementById("save").click();
    await waitForCallbacks();
    assert.equal(setCalls.length, 1);
    assert.equal(Object.hasOwn(setCalls[0].values, "liveLowLatencyEnabled"), false);
    assert.equal(setCalls[0].values.autoQualityEnabled, true);
    setCalls[0].complete();
    assert.equal(stored.autoQualityEnabled, true);
    assert.equal(permissionRequests.length, 0);
});

test("global live count saves independently and retains drafts after failed or late writes", async (t) => {
    const { dom, setCalls, stored, permissionRequests } = await createOptionsFixture(t, {
        categoryToolsEnabled: false,
        globalLiveCountEnabled: false,
    });
    const { document } = dom.window;
    const aggregate = document.querySelector('[data-option="globalLiveCountEnabled"]');
    assert.ok(aggregate);
    const category = document.querySelector('[data-option="categoryToolsEnabled"]');
    const save = document.getElementById("save");
    assert.equal(aggregate.disabled, false);
    aggregate.checked = true;
    aggregate.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(setCalls.length, 0);
    save.click();
    await waitForCallbacks();
    assert.equal(setCalls[0].values.globalLiveCountEnabled, true);
    assert.equal(
        Object.hasOwn(setCalls[0].values, "categoryToolsEnabled"),
        false,
        "the stored category choice is left as stored"
    );
    setCalls[0].complete("write failed");
    assert.equal(stored.globalLiveCountEnabled, false);
    assert.equal(aggregate.checked, true);
    assert.equal(document.getElementById("notice").dataset.state, "error");
    save.click();
    category.checked = true;
    category.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await waitForCallbacks();
    assert.equal(Object.hasOwn(setCalls[1].values, "categoryToolsEnabled"), false, "an edit after the click waits");
    setCalls[1].complete();
    assert.equal(stored.globalLiveCountEnabled, true);
    assert.equal(stored.categoryToolsEnabled, false);
    assert.equal(category.checked, true);
    assert.equal(document.getElementById("notice").dataset.state, "dirty");
    save.click();
    await waitForCallbacks();
    setCalls[2].complete();
    assert.equal(stored.globalLiveCountEnabled, true);
    assert.equal(stored.categoryToolsEnabled, true);
    assert.equal(permissionRequests.length, 0);
});

test("playback shortcut reset is blocked while settings load, on load failure, and during a save", async (t) => {
    const customKeys = {
        playbackSpeedHalfKeyCode: "KeyQ",
        playbackSpeedDoubleKeyCode: "KeyW",
        playbackSpeedResetKeyCode: "KeyR",
    };
    const { dom, setCalls, completeLoad } = await createOptionsFixture(t, customKeys, { deferLoad: true });
    const { document } = dom.window;
    const reset = document.getElementById("resetPlaybackSpeedShortcuts");
    assert.ok(reset);
    assert.equal(reset.disabled, true);
    reset.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    assert.equal(setCalls.length, 0);
    assert.equal(document.getElementById("notice").dataset.state, "loading");
    completeLoad();
    assert.equal(reset.disabled, false);

    const halfKey = document.querySelector('[data-option="playbackSpeedHalfKeyCode"]');
    halfKey.dispatchEvent(new dom.window.KeyboardEvent("keydown", { code: "KeyE", bubbles: true }));
    document.getElementById("save").click();
    assert.equal(reset.disabled, true);
    reset.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    assert.equal(halfKey.value, "E");
    await waitForCallbacks();
    assert.equal(setCalls.length, 1);
    setCalls[0].complete();
    assert.equal(reset.disabled, false);
    reset.click();
    assert.equal(halfKey.value, "[");
    assert.equal(setCalls.length, 1, "restoring keys after the save leaves a new draft");
    assert.equal(document.getElementById("notice").dataset.state, "dirty");

    const failed = await createOptionsFixture(t, customKeys, { deferLoad: true });
    failed.completeLoad("initial read failed");
    const failedReset = failed.dom.window.document.getElementById("resetPlaybackSpeedShortcuts");
    assert.equal(failedReset.disabled, true);
    failedReset.dispatchEvent(new failed.dom.window.Event("click", { bubbles: true }));
    assert.equal(failed.setCalls.length, 0);
    assert.equal(failed.dom.window.document.getElementById("notice").dataset.state, "error");
});

test("options blocks edits until the initial settings load completes", async (t) => {
    const { dom, setCalls, stored, completeLoad } = await createOptionsFixture(
        t,
        { autoQualityEnabled: false, skipSeconds: 17 },
        { deferLoad: true }
    );
    const toggle = dom.window.document.querySelector('[data-option="autoQualityEnabled"]');
    const input = dom.window.document.querySelector('[data-option="skipSeconds"]');
    const resetButton = dom.window.document.getElementById("reset");
    const saveButton = dom.window.document.getElementById("save");

    assert.equal(toggle.disabled, true);
    assert.equal(input.disabled, true);
    assert.equal(resetButton.disabled, true);
    assert.equal(saveButton.disabled, true);

    toggle.checked = true;
    toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    input.value = "99";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    resetButton.dispatchEvent(new dom.window.Event("click", { bubbles: true }));

    assert.equal(setCalls.length, 0, "loading-time interactions must not write default form values");

    completeLoad();

    assert.equal(toggle.disabled, false);
    assert.equal(resetButton.disabled, false);
    assert.equal(toggle.checked, false);
    assert.equal(input.value, "17");

    toggle.checked = true;
    toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

    assert.equal(setCalls.length, 0, "a loaded edit must wait for the save button");
    assert.equal(saveButton.disabled, false);
    saveButton.click();
    await waitForCallbacks();

    assert.equal(setCalls.length, 1);
    assert.equal(setCalls[0].values.autoQualityEnabled, true);
    assert.equal(
        Object.hasOwn(setCalls[0].values, "skipSeconds"),
        false,
        "an unrelated loaded setting is preserved by not rewriting it"
    );
    setCalls[0].complete();

    assert.equal(stored.autoQualityEnabled, true);
    assert.equal(stored.skipSeconds, 17);
});

test("options ignores programmatic edits after the initial settings load fails", async (t) => {
    const fixture = await createOptionsFixture(
        t,
        { followingPreviewTooltipEnabled: false, skipSeconds: 17 },
        { deferLoad: true }
    );
    const { dom, permissionRequests, setCalls, completeLoad } = fixture;
    const previewToggle = dom.window.document.querySelector('[data-option="followingPreviewTooltipEnabled"]');
    const input = dom.window.document.querySelector('[data-option="skipSeconds"]');
    const notice = dom.window.document.getElementById("notice");

    completeLoad("initial read failed");

    assert.equal(previewToggle.disabled, true);
    assert.equal(input.disabled, true);
    assert.equal(notice.dataset.state, "error");
    const noticeText = notice.textContent;

    previewToggle.checked = true;
    previewToggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    input.value = "99";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.equal(permissionRequests.length, 0, "a disabled preview toggle must not request host permission");
    assert.equal(setCalls.length, 0, "failed-load events and pagehide must not write default form values");
    assert.equal(notice.dataset.state, "error", "failed-load events must not show a saving state");
    assert.equal(notice.textContent, noticeText);
});

test("options cancels the dirty state when the form returns to its saved value", async (t) => {
    const { dom, setCalls } = await createOptionsFixture(t);
    const toggle = dom.window.document.querySelector('[data-option="autoQualityEnabled"]');
    const saveButton = dom.window.document.getElementById("save");

    toggle.checked = false;
    toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(saveButton.disabled, false);
    assert.equal(dom.window.document.getElementById("notice").dataset.state, "dirty");

    toggle.checked = true;
    toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

    assert.equal(saveButton.disabled, true);
    assert.equal(setCalls.length, 0);
    assert.equal(dom.window.document.getElementById("notice").dataset.state, "saved");
});

test("options keeps edits made during a write dirty until the user saves again", async (t) => {
    const { dom, setCalls, stored } = await createOptionsFixture(t);
    const toggle = dom.window.document.querySelector('[data-option="autoQualityEnabled"]');
    const input = dom.window.document.querySelector('[data-option="skipSeconds"]');
    const saveButton = dom.window.document.getElementById("save");
    const latestValue = Number(input.value) + 3;

    toggle.checked = false;
    toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    saveButton.click();
    await waitForCallbacks();
    assert.equal(setCalls.length, 1);

    input.value = String(latestValue);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    setCalls[0].complete();

    assert.equal(input.value, String(latestValue), "the completed write must not overwrite a newer form edit");
    assert.equal(setCalls.length, 1, "a newer edit is not saved without another button click");
    assert.equal(saveButton.disabled, false);
    assert.equal(dom.window.document.getElementById("notice").dataset.state, "dirty");

    saveButton.click();
    await waitForCallbacks();
    assert.equal(setCalls.length, 2);
    assert.equal(setCalls[1].values.skipSeconds, latestValue);
    setCalls[1].complete();

    assert.equal(stored.skipSeconds, latestValue);
    assert.equal(dom.window.document.getElementById("notice").dataset.state, "saved");
});

test("options keeps a failed write available for an explicit retry", async (t) => {
    const { dom, setCalls, stored } = await createOptionsFixture(t);
    const input = dom.window.document.querySelector('[data-option="skipSeconds"]');
    const saveButton = dom.window.document.getElementById("save");
    const nextValue = Number(input.value) + 2;

    input.value = String(nextValue);
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    saveButton.click();
    await waitForCallbacks();
    setCalls[0].complete("first write failed");

    assert.equal(setCalls.length, 1);
    assert.equal(saveButton.disabled, false);
    assert.equal(dom.window.document.getElementById("notice").dataset.state, "error");

    saveButton.click();
    await waitForCallbacks();
    assert.equal(setCalls.length, 2);
    setCalls[1].complete();

    assert.equal(stored.skipSeconds, nextValue);
    assert.equal(dom.window.document.getElementById("notice").dataset.state, "saved");
});

test("options does not save unsaved changes when the popup closes", async (t) => {
    const { dom, setCalls, stored } = await createOptionsFixture(t);
    const toggle = dom.window.document.querySelector('[data-option="autoQualityEnabled"]');

    toggle.checked = false;
    toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));

    assert.equal(setCalls.length, 0);
    assert.equal(stored.autoQualityEnabled, true);
});

require("../shared/settings.js");

// A profile that has saved the options page before stores every option key.
function savedProfile(overrides) {
    return { ...globalThis.BetterChzzkSettings.DEFAULT_OPTIONS, ...overrides };
}

function optionControls(dom) {
    const { document } = dom.window;
    const option = (key) => document.querySelector(`[data-option="${key}"]`);
    return {
        option,
        notice: () => document.getElementById("notice"),
        message: () => document.getElementById("message").textContent,
        save: () => document.getElementById("save").click(),
        setChecked(key, checked) {
            option(key).checked = checked;
            option(key).dispatchEvent(new dom.window.Event("change", { bubbles: true }));
        },
        setNumber(key, value) {
            option(key).value = String(value);
            option(key).dispatchEvent(new dom.window.Event("input", { bubbles: true }));
            option(key).dispatchEvent(new dom.window.Event("change", { bubbles: true }));
        },
    };
}

test("a long-open options page saves only its edits and keeps a value changed elsewhere", async (t) => {
    const { dom, setCalls, stored } = await createOptionsFixture(t, { autoQualityEnabled: false, skipSeconds: 5 });
    const ui = optionControls(dom);
    // A Chzzk page saved the skip step through the worker; this page never received the change event.
    stored.skipSeconds = 10;
    ui.setChecked("autoQualityEnabled", true);
    ui.save();
    await waitForCallbacks();

    assert.equal(setCalls.length, 1);
    assert.equal(setCalls[0].values.autoQualityEnabled, true);
    assert.equal(Object.hasOwn(setCalls[0].values, "skipSeconds"), false, "an untouched stored option is not written");
    setCalls[0].complete();
    assert.equal(stored.skipSeconds, 10);
    assert.equal(stored.autoQualityEnabled, true);
    assert.equal(ui.option("skipSeconds").value, "10", "the form shows the value read inside the settings lock");
    assert.equal(ui.notice().dataset.state, "saved");
    assert.equal(ui.message(), "옵션을 저장했습니다.");
});

test("storage changes refresh untouched fields, keep pending edits, and survive a write in flight", async (t) => {
    const { dom, setCalls, stored, externalWrite } = await createOptionsFixture(
        t,
        savedProfile({ autoQualityEnabled: false, skipSeconds: 5, ambientIntensity: 60 })
    );
    const ui = optionControls(dom);
    ui.setChecked("autoQualityEnabled", true);
    externalWrite({ skipSeconds: 10 });
    assert.equal(ui.option("skipSeconds").value, "10", "an untouched field follows the stored value");
    assert.equal(ui.option("autoQualityEnabled").checked, true, "the pending edit stays in the form");
    assert.equal(ui.notice().textContent, "변경 1개");

    ui.save();
    await waitForCallbacks();
    assert.deepEqual(Object.keys(setCalls[0].values), ["autoQualityEnabled"]);
    // Another page writes after this save read the latest values but before its write is confirmed.
    externalWrite({ ambientIntensity: 80 });
    assert.equal(ui.option("ambientIntensity").value, "80");
    setCalls[0].complete();

    assert.deepEqual(
        {
            autoQualityEnabled: stored.autoQualityEnabled,
            skipSeconds: stored.skipSeconds,
            ambient: stored.ambientIntensity,
        },
        { autoQualityEnabled: true, skipSeconds: 10, ambient: 80 }
    );
    assert.equal(ui.option("ambientIntensity").value, "80");
    assert.equal(ui.option("skipSeconds").value, "10");
    assert.equal(ui.notice().dataset.state, "saved");
    assert.equal(dom.window.BetterChzzkOptionsPage.hasUnsavedChanges(), false);
});

for (const notified of [true, false]) {
    test(`a value the user set that also changed elsewhere is saved and reported (event ${notified})`, async (t) => {
        const { dom, setCalls, stored, externalWrite } = await createOptionsFixture(
            t,
            savedProfile({ skipSeconds: 5 })
        );
        const ui = optionControls(dom);
        ui.setNumber("skipSeconds", 20);
        if (notified) externalWrite({ skipSeconds: 15 });
        else stored.skipSeconds = 15;
        assert.equal(ui.option("skipSeconds").value, "20", "a change elsewhere never replaces the user's edit");
        ui.save();
        await waitForCallbacks();

        assert.deepEqual({ ...setCalls[0].values }, { skipSeconds: 20 });
        setCalls[0].complete();
        assert.equal(stored.skipSeconds, 20);
        assert.equal(ui.option("skipSeconds").value, "20");
        assert.equal(ui.notice().dataset.state, "saved");
        assert.equal(
            ui.message(),
            "옵션을 저장했습니다. 저장하기 전에 다른 곳에서도 바뀐 항목 1개는 이 화면에서 고른 값으로 저장했습니다."
        );
    });
}

test("a failed save keeps values changed elsewhere and retries only the user's edit", async (t) => {
    const { dom, setCalls, stored, externalWrite } = await createOptionsFixture(
        t,
        savedProfile({ autoQualityEnabled: false, skipSeconds: 5 })
    );
    const ui = optionControls(dom);
    ui.setChecked("autoQualityEnabled", true);
    ui.save();
    await waitForCallbacks();
    externalWrite({ skipSeconds: 10 });
    setCalls[0].complete("write failed");

    assert.equal(stored.autoQualityEnabled, false);
    assert.equal(stored.skipSeconds, 10);
    assert.equal(ui.notice().dataset.state, "error");
    assert.equal(ui.option("skipSeconds").value, "10");
    assert.equal(dom.window.BetterChzzkOptionsPage.hasUnsavedChanges(), true);

    ui.save();
    await waitForCallbacks();
    assert.deepEqual(Object.keys(setCalls[1].values), ["autoQualityEnabled"]);
    setCalls[1].complete();
    assert.equal(stored.autoQualityEnabled, true);
    assert.equal(stored.skipSeconds, 10);
    assert.equal(ui.notice().dataset.state, "saved");
});

test("a page that reloads the stored options before saving keeps the newer stored value", async (t) => {
    const { dom, setCalls, stored } = await createOptionsFixture(t, { autoQualityEnabled: false, skipSeconds: 5 });
    const ui = optionControls(dom);
    stored.skipSeconds = 10;
    assert.equal(await dom.window.BetterChzzkOptionsPage.reloadSavedOptions(), true);
    assert.equal(ui.option("skipSeconds").value, "10");
    ui.setChecked("autoQualityEnabled", true);
    ui.save();
    await waitForCallbacks();
    setCalls[0].complete();
    assert.equal(stored.skipSeconds, 10);
    assert.equal(stored.autoQualityEnabled, true);
});

const SPEED_KEYS = ["playbackSpeedHalfKeyCode", "playbackSpeedDoubleKeyCode", "playbackSpeedResetKeyCode"];
const speedTrio = (values) => SPEED_KEYS.map((key) => values[key]);

function speedKeyControls(dom) {
    const ui = optionControls(dom);
    return {
        ...ui,
        form: () => SPEED_KEYS.map((key) => ui.option(key).dataset.shortcutCode),
        press(key, code) {
            const input = ui.option(key);
            input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { code, bubbles: true, cancelable: true }));
        },
    };
}

const speedProfile = () =>
    savedProfile({
        playbackSpeedShortcutsEnabled: true,
        playbackSpeedHalfKeyCode: "KeyA",
        playbackSpeedDoubleKeyCode: "KeyB",
        playbackSpeedResetKeyCode: "KeyD",
    });

test("a speed key saved elsewhere never mixes into this page's unsaved speed keys", async (t) => {
    const { dom, setCalls, stored, externalWrite } = await createOptionsFixture(t, speedProfile());
    const ui = speedKeyControls(dom);
    ui.press("playbackSpeedDoubleKeyCode", "KeyE");
    assert.deepEqual(ui.form(), ["KeyA", "KeyE", "KeyD"]);
    // Another options tab, still showing the old keys, saves the decrease key as the same E.
    externalWrite({ playbackSpeedHalfKeyCode: "KeyE" });
    assert.deepEqual(ui.form(), ["KeyA", "KeyE", "KeyD"], "the form never shows a duplicate key");

    ui.save();
    await waitForCallbacks();
    setCalls[0].complete();
    assert.deepEqual(speedTrio(stored), ["KeyA", "KeyE", "KeyD"], "the user's keys are saved, not the defaults");
    assert.deepEqual(ui.form(), ["KeyA", "KeyE", "KeyD"]);
    assert.equal(ui.notice().dataset.state, "saved");
    assert.equal(
        ui.message(),
        "옵션을 저장했습니다. 저장하기 전에 다른 곳에서도 바뀐 항목 1개는 이 화면에서 고른 값으로 저장했습니다."
    );
});

test("speed keys from elsewhere apply as one unit, and a touched key keeps this page's whole set", async (t) => {
    const { dom, setCalls, stored, externalWrite } = await createOptionsFixture(t, speedProfile());
    const ui = speedKeyControls(dom);
    // Without a speed key edit here, another page's swap replaces all three keys.
    externalWrite({ playbackSpeedHalfKeyCode: "KeyB", playbackSpeedDoubleKeyCode: "KeyA" });
    assert.deepEqual(ui.form(), ["KeyB", "KeyA", "KeyD"]);
    assert.equal(ui.notice().dataset.state, "saved");

    // Picking the same key again is an explicit choice; a later swap elsewhere must not half-apply.
    ui.press("playbackSpeedHalfKeyCode", "KeyB");
    externalWrite({ playbackSpeedHalfKeyCode: "KeyA", playbackSpeedDoubleKeyCode: "KeyB" });
    assert.deepEqual(ui.form(), ["KeyB", "KeyA", "KeyD"]);
    ui.save();
    await waitForCallbacks();
    setCalls[0].complete();
    assert.deepEqual(speedTrio(stored), ["KeyB", "KeyA", "KeyD"]);
    assert.equal(
        ui.message(),
        "옵션을 저장했습니다. 저장하기 전에 다른 곳에서도 바뀐 항목 2개는 이 화면에서 고른 값으로 저장했습니다."
    );
});

test("a duplicated speed key in the form is never saved as the default keys", async (t) => {
    const { dom, setCalls, stored } = await createOptionsFixture(t, speedProfile());
    const ui = speedKeyControls(dom);
    ui.setChecked("autoQualityEnabled", false);
    // Defensive path: a duplicate reached the form without the key-capture guard.
    ui.option("playbackSpeedDoubleKeyCode").dataset.shortcutCode = "KeyA";
    ui.save();
    await waitForCallbacks();

    assert.equal(setCalls.length, 0);
    assert.deepEqual(speedTrio(stored), ["KeyA", "KeyB", "KeyD"]);
    assert.equal(ui.message(), "배속 감소·증가·초기화는 서로 다른 키로 지정해 주세요.");
    assert.equal(dom.window.BetterChzzkOptionsPage.hasUnsavedChanges(), true, "the edit stays pending");
});
