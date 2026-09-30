const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function createLocks() {
    const queues = new Map();
    return {
        request(name, callback) {
            const pending = (queues.get(name) || Promise.resolve()).then(callback);
            queues.set(
                name,
                pending.catch(() => {})
            );
            return pending;
        },
    };
}

function createFixture(initial = {}) {
    const stored = { ...initial };
    const localStored = {};
    const locks = createLocks();
    const reads = [];
    const writes = [];
    const listeners = [];
    const consoleMessages = [];
    let installed;
    let lastError;
    let errorReads = 0;
    const control = { deferReads: false, deferWrites: false };
    const chrome = {
        runtime: {
            id: "fixture-extension",
            getURL: (file) => `chrome-extension://fixture-extension/${file}`,
            getManifest: () => ({ version: "1.4.0" }),
            get lastError() {
                if (lastError) errorReads++;
                return lastError;
            },
            onInstalled: { addListener: (listener) => (installed = listener) },
            onMessage: { addListener() {} },
        },
        storage: {
            onChanged: { addListener: (listener) => listeners.push(listener) },
            local: {
                get(keys, callback) {
                    const result = {};
                    if (Array.isArray(keys)) {
                        for (const key of keys) {
                            if (Object.hasOwn(localStored, key)) result[key] = localStored[key];
                        }
                    } else if (typeof keys === "string") {
                        if (Object.hasOwn(localStored, keys)) result[keys] = localStored[keys];
                    } else if (keys && typeof keys === "object") {
                        Object.assign(result, keys);
                        for (const key of Object.keys(keys)) {
                            if (Object.hasOwn(localStored, key)) result[key] = localStored[key];
                        }
                    } else {
                        Object.assign(result, localStored);
                    }
                    callback(result);
                },
                set(values, callback) {
                    Object.assign(localStored, values);
                    callback?.();
                },
                remove(keys, callback) {
                    for (const key of Array.isArray(keys) ? keys : [keys]) delete localStored[key];
                    callback?.();
                },
            },
            sync: {
                get(keys, callback) {
                    const snapshot = Object.fromEntries(
                        (Array.isArray(keys) ? keys : [keys])
                            .filter((key) => Object.hasOwn(stored, key))
                            .map((key) => [key, stored[key]])
                    );
                    const request = {
                        complete(error = null) {
                            lastError = error && { message: error };
                            callback(error ? undefined : snapshot);
                            lastError = undefined;
                        },
                    };
                    reads.push(request);
                    if (!control.deferReads) request.complete();
                },
                set(values, callback) {
                    const request = {
                        values: { ...values },
                        complete(error = null) {
                            if (!error) {
                                const changes = Object.fromEntries(
                                    Object.entries(values)
                                        .filter(([key, value]) => stored[key] !== value)
                                        .map(([key, value]) => [key, { oldValue: stored[key], newValue: value }])
                                );
                                Object.assign(stored, values);
                                for (const listener of listeners) listener(changes, "sync");
                            }
                            lastError = error && { message: error };
                            callback?.();
                            lastError = undefined;
                        },
                    };
                    writes.push(request);
                    if (!control.deferWrites) request.complete();
                },
                remove(_keys, callback) {
                    callback?.();
                },
            },
        },
    };
    const context = vm.createContext({ chrome, navigator: { locks }, URL, console, setTimeout, clearTimeout });
    context.importScripts = (...files) => files.forEach((file) => vm.runInContext(read(file), context));
    vm.runInContext(read("background.js"), context);
    return {
        chrome,
        context,
        control,
        reads,
        writes,
        stored,
        consoleMessages,
        install: (reason = "update") => installed({ reason, previousVersion: "1.4.0" }),
        get errorReads() {
            return errorReads;
        },
        async openOptions(t) {
            const dom = new JSDOM(read("options.html"), {
                url: chrome.runtime.getURL("options.html"),
                runScripts: "outside-only",
                pretendToBeVisual: true,
            });
            t.after(() => dom.window.close());
            for (const level of ["warn", "error"]) {
                const forward = dom.window.console[level].bind(dom.window.console);
                dom.window.console[level] = (...args) => {
                    consoleMessages.push({ level, args });
                    forward(...args);
                };
            }
            dom.window.chrome = chrome;
            Object.defineProperty(dom.window.navigator, "locks", { value: locks });
            dom.window.eval(read("shared/settings.js"));
            dom.window.eval(read("options.js"));
            await flush();
            return dom;
        },
    };
}

test("normal options opening and group changes use local storage without warnings or sync writes", async (t) => {
    const fixture = createFixture({ categoryToolsEnabled: true });
    const dom = await fixture.openOptions(t);
    assert.deepEqual(fixture.consoleMessages, [], "normal initialization must not report storage API failures");
    const readCount = fixture.reads.length;
    const writeCount = fixture.writes.length;
    const group = dom.window.document.querySelector('[data-option-group="player-auto"]');
    assert.equal(group.open, true);
    group.firstElementChild.click();
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    const key = "betterChzzkOptionsGroupOpen:player-auto";
    const saved = await new Promise((resolve) => fixture.chrome.storage.local.get(key, resolve));
    assert.deepEqual(saved, { [key]: false });
    assert.equal(fixture.reads.length, readCount, "local reads must not enter the sync queue");
    assert.equal(fixture.writes.length, writeCount, "group choices must not write feature options");
    assert.deepEqual(fixture.stored, { categoryToolsEnabled: true });

    const reopened = await fixture.openOptions(t);
    assert.equal(reopened.window.document.querySelector('[data-option-group="player-auto"]').open, false);
    assert.deepEqual(fixture.consoleMessages, []);
    const independent = createFixture({ categoryToolsEnabled: false });
    const fresh = await independent.openOptions(t);
    assert.equal(fresh.window.document.querySelector('[data-option-group="player-auto"]').open, true);
    assert.deepEqual(independent.consoleMessages, []);
});

test("local storage callbacks and key forms remain independent of deferred sync requests", async () => {
    const fixture = createFixture({ sharedKey: "sync" });
    fixture.control.deferReads = true;
    fixture.control.deferWrites = true;
    let syncCallbacks = 0;
    fixture.chrome.storage.sync.get("sharedKey", () => syncCallbacks++);
    fixture.chrome.storage.sync.set({ pending: true }, () => syncCallbacks++);
    const local = fixture.chrome.storage.local;
    let localCallbacks = 0;
    const complete = () => {
        localCallbacks++;
        assert.equal(fixture.chrome.runtime.lastError, undefined);
    };
    local.set({ sharedKey: "local", extra: true }, complete);
    const get = (keys) =>
        new Promise((resolve) =>
            local.get(keys, (values) => {
                complete();
                resolve(values);
            })
        );
    assert.deepEqual(await get("sharedKey"), { sharedKey: "local" });
    assert.deepEqual(await get(["extra", "missing"]), { extra: true });
    assert.deepEqual(await get({ sharedKey: "fallback", missing: false }), {
        sharedKey: "local",
        missing: false,
    });
    local.remove("extra", complete);
    assert.deepEqual(await get(null), { sharedKey: "local" });
    local.remove(["sharedKey", "missing"], complete);
    assert.deepEqual(await get(null), {});
    assert.equal(localCallbacks, 8);
    assert.equal(syncCallbacks, 0, "local completion must not complete deferred sync operations");
    assert.equal(fixture.reads.length, 1);
    assert.equal(fixture.writes.length, 1);
    assert.deepEqual(fixture.stored, { sharedKey: "sync" });
    fixture.reads[0].complete();
    fixture.writes[0].complete();
    assert.equal(syncCallbacks, 2);
    assert.deepEqual(fixture.stored, { sharedKey: "sync", pending: true });
});

for (const [reason, initial, expected] of [
    ["install", {}, false],
    ["install", { categoryToolsEnabled: true }, false],
    ["update", {}, true],
    ["update", { categoryToolsEnabled: true }, true],
    ["update", { categoryToolsEnabled: false }, false],
    ["update", { categoryToolsEnabled: "false" }, false],
    ["update", { categoryToolsEnabled: "invalid" }, true],
    ["update", { categoryToolsEnabled: true, globalLiveCountEnabled: false }, false],
    ["update", { categoryToolsEnabled: false, globalLiveCountEnabled: true }, true],
    ["update", { categoryToolsEnabled: true, globalLiveCountEnabled: "false" }, false],
]) {
    test(`installation ${reason} ${JSON.stringify(initial)} preserves global count=${expected}`, async () => {
        const fixture = createFixture(initial);
        fixture.install(reason);
        await flush();
        assert.equal(fixture.stored.globalLiveCountEnabled, expected);
        const count = fixture.writes.length;
        fixture.install("update");
        await flush();
        assert.equal(fixture.stored.globalLiveCountEnabled, expected);
        assert.equal(fixture.writes.length, count, "repeated initialization must not rewrite normalized settings");
        fixture.chrome.storage.sync.set({ categoryToolsEnabled: !expected });
        fixture.install("update");
        await flush();
        assert.equal(fixture.stored.globalLiveCountEnabled, expected, "future category edits are independent");
    });
}

test("failed migration reads do not write defaults and a later event can retry", async () => {
    const fixture = createFixture({ categoryToolsEnabled: false, skipSeconds: 17 });
    fixture.control.deferReads = true;
    fixture.install();
    await flush();
    fixture.reads[0].complete("read failed");
    await flush();
    assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.stored.skipSeconds, 17);
    assert.equal(fixture.errorReads, 1);
    fixture.control.deferReads = false;
    fixture.install();
    await flush();
    assert.equal(fixture.stored.globalLiveCountEnabled, false);
});

test("failed migration writes leave the missing key retryable", async () => {
    const fixture = createFixture({ categoryToolsEnabled: true, skipSeconds: 17 });
    fixture.control.deferWrites = true;
    fixture.install();
    await flush();
    fixture.writes[0].complete("write failed");
    await flush();
    assert.equal(Object.hasOwn(fixture.stored, "globalLiveCountEnabled"), false);
    assert.equal(fixture.errorReads, 1);
    fixture.control.deferWrites = false;
    fixture.install();
    await flush();
    assert.equal(fixture.stored.globalLiveCountEnabled, true);
    assert.equal(fixture.stored.skipSeconds, 17);
});

for (const inherited of [false, true]) {
    test(`an explicit save wins while migration of ${inherited} is waiting on storage`, async (t) => {
        const fixture = createFixture({ categoryToolsEnabled: inherited });
        const dom = await fixture.openOptions(t);
        const { document } = dom.window;
        fixture.control.deferWrites = true;
        fixture.install();
        await flush();
        assert.equal(fixture.writes.length, 1);
        const aggregate = document.querySelector('[data-option="globalLiveCountEnabled"]');
        assert.ok(aggregate);
        aggregate.checked = !inherited;
        aggregate.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
        const category = document.querySelector('[data-option="categoryToolsEnabled"]');
        category.checked = !inherited;
        category.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
        document.getElementById("save").click();
        await flush();
        assert.equal(fixture.writes.length, 1, "the user's save waits for migration's write callback");
        fixture.writes[0].complete();
        await flush();
        assert.equal(fixture.writes.length, 2);
        fixture.writes[1].complete();
        await flush();
        assert.equal(fixture.stored.globalLiveCountEnabled, !inherited);
        assert.equal(fixture.stored.categoryToolsEnabled, !inherited);
        assert.equal(document.getElementById("notice").dataset.state, "saved");
    });
}

test("migration reads the latest explicit value when a user save owns the storage lock first", async (t) => {
    const fixture = createFixture({ categoryToolsEnabled: true });
    const dom = await fixture.openOptions(t);
    const { document } = dom.window;
    const category = document.querySelector('[data-option="categoryToolsEnabled"]');
    category.checked = false;
    category.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    fixture.control.deferWrites = true;
    document.getElementById("save").click();
    await flush();
    fixture.install();
    await flush();
    assert.equal(fixture.writes.length, 1);
    fixture.writes[0].complete();
    await flush();
    assert.equal(fixture.stored.globalLiveCountEnabled, false);
    assert.equal(fixture.stored.categoryToolsEnabled, false);
    assert.equal(fixture.writes.length, 1, "initialization must observe the explicitly saved new key");
});

test("options opened during initialization waits and displays the inherited choice", async (t) => {
    const fixture = createFixture({ categoryToolsEnabled: true });
    fixture.control.deferWrites = true;
    fixture.install();
    await flush();
    const dom = await fixture.openOptions(t);
    const aggregate = dom.window.document.querySelector('[data-option="globalLiveCountEnabled"]');
    assert.equal(aggregate.disabled, true);
    fixture.writes[0].complete();
    await flush();
    assert.equal(aggregate.checked, true);
    assert.equal(aggregate.disabled, false);
    assert.equal(fixture.writes.length, 1);
});

test("a failed migration write releases the waiting explicit save", async (t) => {
    const fixture = createFixture({ categoryToolsEnabled: true });
    const dom = await fixture.openOptions(t);
    fixture.control.deferWrites = true;
    fixture.install();
    await flush();
    const category = dom.window.document.querySelector('[data-option="categoryToolsEnabled"]');
    category.checked = false;
    category.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    dom.window.document.getElementById("save").click();
    await flush();
    assert.equal(fixture.writes.length, 1);
    fixture.writes[0].complete("migration write failed");
    await flush();
    assert.equal(fixture.writes.length, 2);
    fixture.writes[1].complete();
    await flush();
    assert.equal(fixture.stored.globalLiveCountEnabled, false);
    fixture.install();
    await flush();
    assert.equal(fixture.writes.length, 2, "later initialization respects the explicit key after a failed migration");
});

test("a late initial subscription read does not roll back a newer aggregate choice", async () => {
    const fixture = createFixture({ categoryToolsEnabled: false, skipSeconds: 17 });
    const settings = fixture.context.BetterChzzkSettings;
    fixture.control.deferReads = true;
    const initial = new Promise((resolve) => settings.getOptions(resolve));
    fixture.chrome.storage.sync.set({ globalLiveCountEnabled: true });
    fixture.reads[0].complete();
    const loaded = await initial;
    assert.equal(loaded.globalLiveCountEnabled, true);
    assert.equal(loaded.categoryToolsEnabled, false);
    assert.equal(loaded.skipSeconds, 17);
    assert.equal((await new Promise((resolve) => settings.getOptions(resolve))).globalLiveCountEnabled, true);
});

test("global count normalization and sync subscriptions keep both toggles independent", async () => {
    const fixture = createFixture({ categoryToolsEnabled: false, globalLiveCountEnabled: true });
    const settings = fixture.context.BetterChzzkSettings;
    assert.equal(settings.normalizeOptions({ categoryToolsEnabled: true }).globalLiveCountEnabled, false);
    for (const category of [false, true]) {
        for (const aggregate of [false, true]) {
            const options = settings.normalizeOptions({
                categoryToolsEnabled: category,
                globalLiveCountEnabled: aggregate,
            });
            assert.equal(options.categoryToolsEnabled, category);
            assert.equal(options.globalLiveCountEnabled, aggregate);
        }
    }
    const loaded = await new Promise((resolve) => settings.getOptions(resolve));
    assert.equal(loaded.globalLiveCountEnabled, true);
    const changes = [];
    const remove = settings.addOptionsChangeListener((options) => changes.push(options));
    fixture.chrome.storage.sync.set({ categoryToolsEnabled: true });
    assert.equal(changes.at(-1).globalLiveCountEnabled, true);
    fixture.chrome.storage.sync.set({ globalLiveCountEnabled: false });
    assert.equal(changes.at(-1).categoryToolsEnabled, true);
    assert.equal(changes.at(-1).globalLiveCountEnabled, false);
    remove();
});
