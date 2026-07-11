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
    let lastError = null;
    let pendingGetCallback = null;
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
            sync: {
                get(_keys, callback) {
                    if (deferLoad) {
                        pendingGetCallback = callback;
                        return;
                    }
                    setTimeout(() => callback({ ...stored }), 0);
                },
                set(values, callback) {
                    setCalls.push({
                        values: { ...values },
                        complete(error = null) {
                            if (!error) Object.assign(stored, values);
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

test("options blocks edits until the initial settings load completes", async (t) => {
    const { dom, setCalls, stored, completeLoad } = await createOptionsFixture(
        t,
        { autoQualityEnabled: false, skipSeconds: 17 },
        { deferLoad: true }
    );
    const toggle = dom.window.document.querySelector('[data-option="autoQualityEnabled"]');
    const input = dom.window.document.querySelector('[data-option="skipSeconds"]');
    const resetButton = dom.window.document.getElementById("reset");

    assert.equal(toggle.disabled, true);
    assert.equal(input.disabled, true);
    assert.equal(resetButton.disabled, true);

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

    assert.equal(setCalls.length, 1);
    assert.equal(setCalls[0].values.autoQualityEnabled, true);
    assert.equal(setCalls[0].values.skipSeconds, 17, "an unrelated loaded setting must be preserved");
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

test("options serializes rapid saves when the form returns to its original value", async (t) => {
    const { dom, setCalls, stored } = await createOptionsFixture(t);
    const toggle = dom.window.document.querySelector('[data-option="autoQualityEnabled"]');
    assert.equal(toggle.checked, true);

    toggle.checked = false;
    toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    toggle.checked = true;
    toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

    assert.equal(setCalls.length, 1, "only one storage write may be in flight");
    assert.equal(setCalls[0].values.autoQualityEnabled, false);
    setCalls[0].complete();

    assert.equal(setCalls.length, 2, "the latest state is written after the first callback");
    assert.equal(setCalls[1].values.autoQualityEnabled, true);
    setCalls[1].complete();
    await waitForCallbacks();

    assert.equal(stored.autoQualityEnabled, true);
    assert.equal(dom.window.document.getElementById("notice").dataset.state, "saved");
});

test("options saves the latest queued value after an in-flight write fails", async (t) => {
    const { dom, setCalls, stored } = await createOptionsFixture(t);
    const input = dom.window.document.querySelector('[data-option="skipSeconds"]');
    const initialValue = Number(input.value);

    input.value = String(initialValue + 1);
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    input.value = String(initialValue + 2);
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

    assert.equal(setCalls.length, 1);
    setCalls[0].complete("first write failed");

    assert.equal(setCalls.length, 2);
    assert.equal(setCalls[1].values.skipSeconds, initialValue + 2);
    setCalls[1].complete();
    await waitForCallbacks();

    assert.equal(stored.skipSeconds, initialValue + 2);
    assert.equal(dom.window.document.getElementById("notice").dataset.state, "saved");
});

test("options saves form edits made between serialized write callbacks", async (t) => {
    const { dom, setCalls, stored } = await createOptionsFixture(t);
    const toggle = dom.window.document.querySelector('[data-option="autoQualityEnabled"]');
    const input = dom.window.document.querySelector('[data-option="skipSeconds"]');
    const latestValue = Number(input.value) + 3;

    toggle.checked = false;
    toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    toggle.checked = true;
    toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    setCalls[0].complete();

    assert.equal(setCalls.length, 2);
    input.value = String(latestValue);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    setCalls[1].complete();

    assert.equal(setCalls.length, 3);
    assert.equal(setCalls[2].values.skipSeconds, latestValue);
    setCalls[2].complete();

    assert.equal(stored.skipSeconds, latestValue);
});

test("options does not overwrite a newer form edit when the queued value matches the completed write", async (t) => {
    const { dom, setCalls, stored } = await createOptionsFixture(t);
    const toggle = dom.window.document.querySelector('[data-option="autoQualityEnabled"]');
    const input = dom.window.document.querySelector('[data-option="skipSeconds"]');
    const latestValue = Number(input.value) + 4;

    toggle.checked = false;
    toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    toggle.checked = true;
    toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    toggle.checked = false;
    toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

    input.value = String(latestValue);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    setCalls[0].complete();

    assert.equal(input.value, String(latestValue));
    assert.equal(setCalls.length, 2);
    assert.equal(setCalls[1].values.skipSeconds, latestValue);
    setCalls[1].complete();

    assert.equal(stored.skipSeconds, latestValue);
});

test("options issues the latest queued state before pagehide can terminate the popup", async (t) => {
    const { dom, setCalls, stored } = await createOptionsFixture(t);
    const toggle = dom.window.document.querySelector('[data-option="autoQualityEnabled"]');

    toggle.checked = false;
    toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    toggle.checked = true;
    toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

    assert.equal(setCalls.length, 1, "the regular queue should still serialize writes before pagehide");
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));

    assert.equal(setCalls.length, 2, "pagehide should issue the pending state before the first callback returns");
    assert.equal(setCalls[1].values.autoQualityEnabled, true);

    setCalls[0].complete();
    assert.equal(setCalls.length, 3, "the surviving callback queue should reaffirm the latest state");
    assert.equal(setCalls[2].values.autoQualityEnabled, true);
    setCalls[1].complete();
    setCalls[2].complete();

    assert.equal(stored.autoQualityEnabled, true);
});
