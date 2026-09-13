const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness({ failRemoval = false } = {}) {
    const local = {
        betterchzzkUpdateNotice: { version: "1.3.5" },
        betterchzzkUpdateReadVersion: "1.3.4",
        "betterChzzkOptionsGroupOpen:popup-updates": true,
        unrelated: 123,
    };
    const sync = { updateNotificationsEnabled: true, holdSpeedEnabled: false };
    const listeners = [];
    const badges = [];
    const titles = [];
    let installed;
    let lastError;
    let errorReads = 0;
    const chrome = {
        runtime: {
            get lastError() {
                errorReads++;
                return lastError;
            },
            getManifest: () => ({ version: "1.3.6" }),
            onInstalled: {
                addListener(fn) {
                    installed = fn;
                },
            },
            onMessage: { addListener() {} },
        },
        tabs: {
            query() {
                assert.fail("updates must not query or navigate tabs");
            },
        },
        scripting: {
            executeScript() {
                assert.fail("updates must not inject UI");
            },
        },
        action: {
            async setBadgeText({ text }) {
                badges.push(text);
            },
            async setTitle({ title }) {
                titles.push(title);
            },
        },
        storage: {
            onChanged: {
                addListener(fn) {
                    listeners.push(fn);
                },
            },
        },
    };
    for (const [name, data] of [
        ["local", local],
        ["sync", sync],
    ]) {
        chrome.storage[name] = {
            get(keys, cb) {
                cb(Object.fromEntries(keys.map((key) => [key, data[key]])));
            },
            set(values, cb) {
                Object.assign(data, values);
                cb();
            },
            remove(keys, cb) {
                if (failRemoval) lastError = { message: "removal failed" };
                else for (const key of keys) delete data[key];
                cb();
                lastError = undefined;
            },
        };
    }
    const context = vm.createContext({ chrome, URL, console, setTimeout, clearTimeout });
    context.importScripts = (...files) => files.forEach((file) => vm.runInContext(read(file), context));
    vm.runInContext(read("background.js"), context);
    return {
        local,
        sync,
        badges,
        titles,
        install: (details) => installed(details),
        get errorReads() {
            return errorReads;
        },
        change: (changes, area) => listeners.forEach((fn) => fn(changes, area)),
    };
}

test("startup removes legacy notice state and clears NEW without touching other data", async () => {
    const h = harness();
    await flush();
    assert.deepEqual(h.local, { unrelated: 123 });
    assert.deepEqual(h.sync, { holdSpeedEnabled: false });
    assert.deepEqual(h.badges, [""]);
    assert.deepEqual(h.titles, ["Better Chzzk 설정"]);
});

test("install, upgrade, worker reload and old storage events never recreate update UI", async () => {
    const h = harness();
    for (const details of [
        { reason: "install" },
        { reason: "update", previousVersion: "1.3.5" },
        { reason: "update", previousVersion: "1.3.6" },
        { reason: "chrome_update" },
    ]) {
        h.install(details);
        await flush();
        assert.equal(h.local.betterchzzkUpdateNotice, undefined);
        assert.equal(h.sync.updateNotificationsEnabled, undefined);
        assert.equal(h.sync.holdSpeedEnabled, false);
    }
    h.change({ betterchzzkUpdateNotice: { newValue: { version: "1.3.6" } } }, "local");
    h.change({ updateNotificationsEnabled: { newValue: true } }, "sync");
    await flush();
    assert.ok(h.badges.every((text) => text === ""));
    assert.ok(h.titles.every((title) => title === "Better Chzzk 설정"));
});

test("legacy storage cleanup consumes errors and still clears the badge and normalizes options", async () => {
    const h = harness({ failRemoval: true });
    h.install({ reason: "update", previousVersion: "1.3.5" });
    await flush();
    assert.ok(h.errorReads >= 4);
    assert.ok(h.badges.every((text) => text === ""));
    assert.equal(h.sync.holdSpeedEnabled, false);
});

test("popup and content scripts provide no update notice, tutorial or replay entry point", (t) => {
    const dom = new JSDOM(read("options.html"));
    t.after(() => dom.window.close());
    const document = dom.window.document;
    assert.equal(
        document.querySelector(
            '#updateNotice, [data-option="updateNotificationsEnabled"], [data-option-group="popup-updates"]'
        ),
        null
    );
    assert.doesNotMatch(document.body.textContent, /튜토리얼|새로고침해서 업데이트/);
    const manifest = JSON.parse(read("manifest.json"));
    const loaded = [
        ...manifest.content_scripts.flatMap((s) => s.js || []),
        ...Array.from(document.scripts, (s) => s.getAttribute("src")),
    ];
    assert.ok(loaded.every((file) => !/updateNotice|tutorial|guide/i.test(file)));
    for (const file of ["shared/updateNotice.js", "features/updateNotice.js", "optionsUpdateNotice.js"])
        assert.equal(fs.existsSync(path.join(root, file)), false);
});
