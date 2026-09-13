const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");
const TYPE = "betterchzzk:audio-compressor-state";
const KEY = "betterchzzk:audio-compressor-tabs";

function createBackground(local = {}) {
    let receive;
    let removeTab;
    let failSet = false;
    const startup = [];
    const runtime = {
        id: "test-extension",
        lastError: null,
        onInstalled: { addListener() {} },
        onStartup: {
            addListener(fn) {
                startup.push(fn);
            },
        },
        onMessage: {
            addListener(fn) {
                receive = fn;
            },
        },
    };
    const chrome = {
        runtime,
        tabs: {
            onRemoved: {
                addListener(fn) {
                    removeTab = fn;
                },
            },
        },
        storage: {
            local: {
                get(key, callback) {
                    callback({ [key]: local[key] });
                },
                set(values, callback) {
                    if (failSet) {
                        failSet = false;
                        runtime.lastError = { message: "write failed" };
                        callback();
                        runtime.lastError = null;
                        return;
                    }
                    Object.assign(local, values);
                    callback();
                },
            },
            sync: {
                get(_keys, callback) {
                    callback({});
                },
            },
            onChanged: { addListener() {} },
        },
    };
    const context = vm.createContext({ chrome, console, URL, setTimeout, clearTimeout });
    context.importScripts = (...files) => {
        for (const file of files) vm.runInContext(fs.readFileSync(path.join(repoRoot, file), "utf8"), context);
    };
    vm.runInContext(fs.readFileSync(path.join(repoRoot, "background.js"), "utf8"), context);
    const sender = (tabId) => ({
        id: runtime.id,
        tab: { id: tabId },
        frameId: 0,
        url: "https://chzzk.naver.com/live/channel",
    });
    const send = (message, source) =>
        new Promise((resolve) => {
            assert.equal(
                receive({ type: TYPE, ...message }, source, (response) =>
                    resolve(JSON.parse(JSON.stringify(response)))
                ),
                true
            );
        });
    return {
        local,
        sender,
        send,
        get: (tabId) => send({ kind: "get" }, sender(tabId)),
        set: (tabId, state) => send({ kind: "set", state }, sender(tabId)),
        close: (tabId) => removeTab(tabId),
        startup: () => startup.forEach((fn) => fn()),
        failNextSet: () => {
            failSet = true;
        },
    };
}

test("compressor background serializes per-tab writes and restores them after worker restart", async () => {
    const h = createBackground();
    assert.deepEqual((await h.get(1)).state, { active: false, volume: 1 });
    const outcomes = await Promise.all([
        h.set(1, { active: true, volume: 0.3 }),
        h.set(2, { active: false, volume: 0.8 }),
    ]);
    assert.ok(outcomes.every((response) => response.ok));
    assert.deepEqual((await h.get(1)).state, { active: true, volume: 0.3 });
    assert.deepEqual((await h.get(2)).state, { active: false, volume: 0.8 });
    const restarted = createBackground(h.local);
    assert.deepEqual((await restarted.get(1)).state, { active: true, volume: 0.3 });
    assert.deepEqual((await restarted.get(3)).state, { active: false, volume: 1 });
});

test("compressor background removes closed tabs and clears browser-session tab IDs on startup", async () => {
    const h = createBackground();
    await h.set(1, { active: true, volume: 0.4 });
    await h.set(2, { active: true, volume: 0.7 });
    h.close(1);
    assert.deepEqual((await h.get(1)).state, { active: false, volume: 1 });
    assert.deepEqual((await h.get(2)).state, { active: true, volume: 0.7 });
    assert.equal(h.local[KEY].length, 1);
    h.startup();
    assert.deepEqual((await h.get(2)).state, { active: false, volume: 1 });
    assert.equal(h.local[KEY].length, 0);
});

test("compressor background trusts the sender tab and rejects foreign senders and invalid state", async () => {
    const h = createBackground();
    const valid = { kind: "set", state: { active: true, volume: 0.5 } };
    for (const sender of [
        { ...h.sender(1), id: "other-extension" },
        { ...h.sender(1), url: "https://example.com" },
        { ...h.sender(1), url: "not a URL" },
        { ...h.sender(1), frameId: 1 },
        { ...h.sender(1), tab: { id: -1 } },
    ])
        assert.equal((await h.send(valid, sender)).ok, false);
    for (const state of [
        { active: 1, volume: 1 },
        { active: true, volume: -0.1 },
        { active: false, volume: 1.1 },
        { active: false, volume: NaN },
        null,
    ]) {
        assert.equal((await h.set(1, state)).ok, false);
    }
    assert.deepEqual(h.local, {});
    await h.send({ ...valid, tabId: 2 }, h.sender(1));
    assert.deepEqual((await h.get(1)).state, valid.state);
    assert.deepEqual((await h.get(2)).state, { active: false, volume: 1 });
});

test("compressor background bounds tab state and recovers after a storage write failure", async () => {
    const h = createBackground();
    h.failNextSet();
    const failed = await h.set(1, { active: true, volume: 0.5 });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /write failed/);
    for (let tabId = 1; tabId <= 130; tabId++)
        assert.equal((await h.set(tabId, { active: true, volume: 0.6 })).ok, true);
    assert.equal(h.local[KEY].length, 128);
    assert.deepEqual((await h.get(130)).state, { active: true, volume: 0.6 });
    assert.deepEqual((await h.get(1)).state, { active: false, volume: 1 });
});
