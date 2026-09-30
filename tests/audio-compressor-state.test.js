const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");
const TYPE = "betterchzzk:audio-compressor-state";
const KEY = "betterchzzk:audio-compressor-tabs";
const PREFERENCE_KEY = "betterchzzk:audio-compressor-preference";
const CLEANUP_KEY = "betterchzzk:audio-compressor-cleanup-pending";

function createBackground(local = {}, session = {}) {
    let receive;
    let removeTab;
    let failGet = false;
    let failSet = false;
    let pausedGet;
    let pausedSet;
    let failSessionGet = false;
    let failSessionSet = false;
    const reads = [];
    const writes = [];
    const sessionWrites = [];
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
                    const keys = Array.isArray(key) ? key : [key];
                    reads.push(keys);
                    const result = structuredClone(Object.fromEntries(keys.map((name) => [name, local[name]])));
                    const failed = failGet;
                    failGet = false;
                    const finish = () => {
                        runtime.lastError = failed ? { message: "read failed" } : null;
                        callback(result);
                        runtime.lastError = null;
                    };
                    if (pausedGet) {
                        const gate = pausedGet;
                        pausedGet = null;
                        gate.pause(finish);
                    } else finish();
                },
                set(values, callback) {
                    const failed = failSet;
                    failSet = false;
                    const finish = () => {
                        if (failed) runtime.lastError = { message: "write failed" };
                        else {
                            const saved = structuredClone(values);
                            writes.push(saved);
                            Object.assign(local, saved);
                        }
                        callback();
                        runtime.lastError = null;
                    };
                    if (pausedSet) {
                        const gate = pausedSet;
                        pausedSet = null;
                        gate.pause(finish);
                    } else finish();
                },
            },
            sync: {
                get(_keys, callback) {
                    callback({});
                },
            },
            session: session && {
                get(key, callback) {
                    runtime.lastError = failSessionGet ? { message: "session read failed" } : null;
                    failSessionGet = false;
                    callback(structuredClone({ [key]: session[key] }));
                    runtime.lastError = null;
                },
                set(values, callback) {
                    runtime.lastError = failSessionSet ? { message: "session write failed" } : null;
                    failSessionSet = false;
                    if (!runtime.lastError) {
                        const saved = structuredClone(values);
                        sessionWrites.push(saved);
                        Object.assign(session, saved);
                    }
                    callback();
                    runtime.lastError = null;
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
    const pauseNext = (kind) => {
        let resume;
        let started;
        const gate = {
            started: new Promise((resolve) => {
                started = resolve;
            }),
            pause(finish) {
                resume = finish;
                started();
            },
            release() {
                assert.equal(typeof resume, "function");
                resume();
            },
        };
        if (kind === "get") pausedGet = gate;
        else pausedSet = gate;
        return gate;
    };
    return {
        local,
        session,
        reads,
        writes,
        sessionWrites,
        sender,
        send,
        get: (tabId) => send({ kind: "get" }, sender(tabId)),
        set: (tabId, state) => send({ kind: "set", state }, sender(tabId)),
        close: (tabId) => removeTab(tabId),
        startup: () => startup.forEach((fn) => fn()),
        idle: () => vm.runInContext("compressorStateQueue", context),
        pauseNextGet: () => pauseNext("get"),
        pauseNextSet: () => pauseNext("set"),
        failNextGet: () => {
            failGet = true;
        },
        failNextSet: () => {
            failSet = true;
        },
        failNextSessionGet: () => {
            failSessionGet = true;
        },
        failNextSessionSet: () => {
            failSessionSet = true;
        },
    };
}

test("existing and inherited compressor tabs keep their snapshot after other choices and worker restart", async () => {
    const h = createBackground();
    assert.deepEqual((await h.get(2)).state, { active: false, volume: 1 });
    await h.set(1, { active: true, volume: 0.3 });
    assert.deepEqual((await h.get(3)).state, { active: true, volume: 0.3 });
    const outcomes = await Promise.all([
        h.set(1, { active: true, volume: 0.6 }),
        h.set(4, { active: false, volume: 0.8 }),
    ]);
    assert.ok(outcomes.every((response) => response.ok));
    const before = structuredClone(h.local);
    assert.deepEqual((await h.get(1)).state, { active: true, volume: 0.6 });
    assert.deepEqual((await h.get(2)).state, { active: false, volume: 1 });
    assert.deepEqual((await h.get(3)).state, { active: true, volume: 0.3 });
    assert.deepEqual(h.local, before);
    const restarted = createBackground(h.local, h.session);
    assert.deepEqual((await restarted.get(3)).state, { active: true, volume: 0.3 });
    assert.deepEqual((await restarted.get(5)).state, { active: false, volume: 0.8 });
});

test("compressor background removes closed tabs and clears browser-session tab IDs on startup", async () => {
    const h = createBackground();
    await h.set(1, { active: true, volume: 0.4 });
    await h.set(2, { active: true, volume: 0.7 });
    h.close(1);
    await h.idle();
    assert.deepEqual((await h.get(2)).state, { active: true, volume: 0.7 });
    assert.equal(h.local[KEY].length, 1);
    assert.deepEqual(Object.keys(h.writes.at(-1)), [KEY]);
    h.close(2);
    await h.idle();
    assert.deepEqual(h.local[KEY], []);
    assert.deepEqual(h.local[PREFERENCE_KEY], { active: true, volume: 0.7 });
    assert.deepEqual((await h.get(1)).state, { active: true, volume: 0.7 });
    h.startup();
    await h.idle();
    assert.equal(h.local[KEY].length, 0);
    assert.deepEqual((await h.get(2)).state, { active: true, volume: 0.7 });
});

test("compressor background trusts the sender tab and rejects foreign senders and invalid state", async () => {
    const h = createBackground();
    const valid = { kind: "set", state: { active: true, volume: 0.5 } };
    for (const sender of [
        { ...h.sender(1), id: "other-extension" },
        { ...h.sender(1), url: "https://example.com" },
        { ...h.sender(1), url: "http://chzzk.naver.com" },
        { ...h.sender(1), url: "not a URL" },
        { ...h.sender(1), frameId: 1 },
        { ...h.sender(1), tab: { id: -1 } },
        { ...h.sender(1), tab: { id: 1.5 } },
        { ...h.sender(1), tab: { id: "1" } },
        { ...h.sender(1), tab: null },
        null,
    ]) {
        assert.equal((await h.send(valid, sender)).ok, false);
        assert.equal((await h.send({ kind: "get" }, sender)).ok, false);
    }
    for (const state of [
        { active: 1, volume: 1 },
        { active: true, volume: -0.1 },
        { active: false, volume: 1.1 },
        { active: false, volume: NaN },
        { active: true, volume: Infinity },
        null,
    ]) {
        assert.equal((await h.set(1, state)).ok, false);
    }
    assert.equal((await h.send({ kind: "unknown" }, h.sender(1))).ok, false);
    assert.deepEqual(h.local, {});
    assert.equal(h.reads.length, 0);
    assert.equal(h.writes.length, 0);
    await h.get(2);
    await h.send({ ...valid, tabId: 2 }, h.sender(1));
    assert.deepEqual((await h.get(1)).state, valid.state);
    assert.deepEqual((await h.get(2)).state, { active: false, volume: 1 });
    assert.deepEqual((await h.get(3)).state, valid.state);
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
    await h.set(130, { active: false, volume: 0.8 });
    assert.deepEqual((await h.get(1)).state, { active: false, volume: 0.8 });
    assert.equal(h.local[KEY].length, 128);
    assert.equal(new Set(h.local[KEY].map((state) => state.tabId)).size, 128);
});

test("first compressor get migrates the last valid legacy tab and atomically stores its own snapshot", async () => {
    const h = createBackground({
        [KEY]: [
            { tabId: 1, active: true, volume: 0.4 },
            { tabId: 2, active: false, volume: 0 },
            { tabId: -1, active: true, volume: 0.8 },
            { tabId: 3, active: true, volume: Infinity },
        ],
        "betterchzzk:audio-compressor-active": true,
    });
    assert.deepEqual(await h.get(4), { ok: true, state: { active: false, volume: 0 } });
    assert.deepEqual(h.local[PREFERENCE_KEY], { active: false, volume: 0 });
    assert.deepEqual(h.local[KEY], [
        { tabId: 1, active: true, volume: 0.4 },
        { tabId: 2, active: false, volume: 0 },
        { tabId: 4, active: false, volume: 0 },
    ]);
    assert.deepEqual(Object.keys(h.writes[0]).sort(), [KEY, PREFERENCE_KEY].sort());
    assert.equal(h.writes.length, 1);
    assert.equal(h.local["betterchzzk:audio-compressor-active"], true);
    const before = structuredClone(h.local);
    assert.deepEqual((await h.get(1)).state, { active: true, volume: 0.4 });
    assert.deepEqual(h.local, before);
});

test("valid compressor preference wins over legacy choices without overwriting existing tab snapshots", async () => {
    const h = createBackground({
        [PREFERENCE_KEY]: { active: false, volume: 0 },
        [KEY]: [{ tabId: 1, active: true, volume: 0.4 }],
    });
    assert.deepEqual((await h.get(1)).state, { active: true, volume: 0.4 });
    assert.equal(h.writes.length, 0);
    assert.deepEqual((await h.get(2)).state, { active: false, volume: 0 });
    assert.deepEqual(Object.keys(h.writes[0]), [KEY]);
    assert.deepEqual(h.local[PREFERENCE_KEY], { active: false, volume: 0 });
});

test("invalid compressor preferences and legacy states initialize only from a valid tab or the default", async () => {
    for (const invalid of [
        null,
        true,
        {},
        { active: 1, volume: 0.4 },
        { active: true, volume: "0.4" },
        { active: false, volume: NaN },
        { active: true, volume: Infinity },
        { active: false, volume: -0.1 },
        { active: true, volume: 1.1 },
    ]) {
        const h = createBackground({
            [PREFERENCE_KEY]: invalid,
            [KEY]: [
                { tabId: 7, active: true, volume: 0.45 },
                { active: true, volume: 0.9 },
                { tabId: 8.5, active: false, volume: 0 },
                { tabId: "8", active: false, volume: 0 },
            ],
        });
        assert.deepEqual((await h.get(9)).state, { active: true, volume: 0.45 });
        assert.deepEqual(h.local[PREFERENCE_KEY], { active: true, volume: 0.45 });
    }
    const h = createBackground({
        [KEY]: [{ tabId: -1, active: true, volume: 0.8 }],
        "betterchzzk:audio-compressor-active": true,
    });
    assert.deepEqual((await h.get(1)).state, { active: false, volume: 1 });
    assert.deepEqual(h.local[PREFERENCE_KEY], { active: false, volume: 1 });
    assert.deepEqual(h.local[KEY], [{ tabId: 1, active: false, volume: 1 }]);
});

test("initial compressor snapshot write failure preserves all source data and recovers in the queue", async () => {
    const h = createBackground({ [KEY]: [{ tabId: 1, active: true, volume: 0.2 }] });
    const before = structuredClone(h.local);
    h.failNextSet();
    const response = await h.get(2);
    assert.equal(response.ok, false);
    assert.match(response.error, /write failed/);
    assert.deepEqual(h.local, before);
    assert.equal(h.writes.length, 0);
    assert.deepEqual((await h.get(2)).state, { active: true, volume: 0.2 });
    assert.deepEqual(h.local[PREFERENCE_KEY], { active: true, volume: 0.2 });
    assert.deepEqual(h.local[KEY].at(-1), { tabId: 2, active: true, volume: 0.2 });
});

test("compressor read and explicit write failures preserve both keys and later set keeps two-decimal rounding", async () => {
    const h = createBackground({
        [KEY]: [{ tabId: 1, active: false, volume: 0 }],
        [PREFERENCE_KEY]: { active: false, volume: 0 },
    });
    const before = structuredClone(h.local);
    h.failNextGet();
    const read = await h.get(2);
    assert.equal(read.ok, false);
    assert.match(read.error, /read failed/);
    assert.deepEqual(h.local, before);
    assert.equal(h.writes.length, 0);
    h.failNextSet();
    assert.equal((await h.set(1, { active: true, volume: 0.456 })).ok, false);
    assert.deepEqual(h.local, before);
    assert.deepEqual(await h.set(1, { active: true, volume: 0.456 }), {
        ok: true,
        state: { active: true, volume: 0.46 },
    });
    assert.deepEqual(h.local[PREFERENCE_KEY], { active: true, volume: 0.46 });
    assert.deepEqual(Object.keys(h.writes[0]).sort(), [KEY, PREFERENCE_KEY].sort());
});

test("browser startup migrates the legacy choice before clearing IDs and ignores legacy boolean", async () => {
    const h = createBackground({
        [KEY]: [
            { tabId: 1, active: true, volume: 0.3 },
            { tabId: 2, active: false, volume: 0 },
        ],
        "betterchzzk:audio-compressor-active": true,
    });
    h.startup();
    await h.idle();
    assert.deepEqual(h.local[KEY], []);
    assert.deepEqual(h.local[PREFERENCE_KEY], { active: false, volume: 0 });
    assert.deepEqual(Object.keys(h.writes[0]).sort(), [KEY, PREFERENCE_KEY].sort());
    assert.deepEqual((await h.get(1)).state, { active: false, volume: 0 });
    const empty = createBackground({ "betterchzzk:audio-compressor-active": true });
    empty.startup();
    await empty.idle();
    assert.deepEqual(empty.local[PREFERENCE_KEY], { active: false, volume: 1 });
    assert.equal(empty.local["betterchzzk:audio-compressor-active"], true);
});

test("failed startup cleanup stays pending so reused IDs cannot read a previous session snapshot", async () => {
    for (const failure of ["get", "set"]) {
        for (const operation of ["get", "set"]) {
            const h = createBackground({
                [KEY]: [{ tabId: 1, active: true, volume: 0.2 }],
                [PREFERENCE_KEY]: { active: false, volume: 0.7 },
            });
            const before = structuredClone(h.local);
            if (failure === "get") h.failNextGet();
            else h.failNextSet();
            h.startup();
            await h.idle();
            assert.deepEqual(h.local, before);
            assert.equal(h.writes.length, 0);
            const state = operation === "get" ? { active: false, volume: 0.7 } : { active: true, volume: 0.5 };
            const response = operation === "get" ? await h.get(1) : await h.set(1, state);
            assert.deepEqual(response, { ok: true, state });
            assert.deepEqual(h.local[KEY], [{ tabId: 1, ...state }]);
            assert.deepEqual(h.local[PREFERENCE_KEY], state);
        }
    }
});

test("startup cleanup cannot overtake queued choices when its storage read is delayed", async () => {
    const h = createBackground({ [KEY]: [{ tabId: 1, active: true, volume: 0.2 }] });
    const gate = h.pauseNextGet();
    h.startup();
    await gate.started;
    const set = h.set(2, { active: false, volume: 0.8 });
    const get = h.get(1);
    assert.equal(h.writes.length, 0);
    gate.release();
    assert.equal((await set).ok, true);
    assert.deepEqual((await get).state, { active: false, volume: 0.8 });
    await h.idle();
    assert.deepEqual(h.local[KEY], [
        { tabId: 2, active: false, volume: 0.8 },
        { tabId: 1, active: false, volume: 0.8 },
    ]);
});

test("startup invalidates an earlier pending read without responding with the old session tab state", async () => {
    const h = createBackground({
        [KEY]: [{ tabId: 1, active: true, volume: 0.2 }],
        [PREFERENCE_KEY]: { active: false, volume: 0.7 },
    });
    const gate = h.pauseNextGet();
    const get = h.get(1);
    await gate.started;
    h.startup();
    gate.release();
    assert.deepEqual((await get).state, { active: false, volume: 0.7 });
    await h.idle();
    assert.deepEqual(h.local[KEY], [{ tabId: 1, active: false, volume: 0.7 }]);
});

test("startup during a pending snapshot write retries before responding and keeps the new snapshot", async () => {
    const h = createBackground({
        [KEY]: [{ tabId: 1, active: true, volume: 0.2 }],
        [PREFERENCE_KEY]: { active: false, volume: 0.7 },
    });
    const gate = h.pauseNextSet();
    const get = h.get(2);
    await Promise.race([
        gate.started,
        get.then(() => assert.fail("The initial tab snapshot must be saved before get responds")),
    ]);
    h.startup();
    gate.release();
    assert.deepEqual((await get).state, { active: false, volume: 0.7 });
    await h.idle();
    assert.deepEqual(h.local[KEY], [{ tabId: 2, active: false, volume: 0.7 }]);
});

test("first-get snapshots stay bounded at 128 tabs and preserve a valid zero volume preference", async () => {
    const h = createBackground({ [PREFERENCE_KEY]: { active: false, volume: 0 } });
    for (let tabId = 1; tabId <= 130; tabId++)
        assert.deepEqual(await h.get(tabId), { ok: true, state: { active: false, volume: 0 } });
    assert.equal(h.local[KEY].length, 128);
    assert.deepEqual(
        h.local[KEY].map((state) => state.tabId),
        Array.from({ length: 128 }, (_, index) => index + 3)
    );
    assert.deepEqual(h.local[PREFERENCE_KEY], { active: false, volume: 0 });
});

test("first get of an existing tab preserves its own value while migrating the latest valid legacy choice", async () => {
    const h = createBackground({
        [KEY]: [
            { tabId: 1, active: false, volume: 0.123 },
            { tabId: 2, active: true, volume: 0.45 },
            { tabId: 2, active: false, volume: 0.678 },
        ],
    });
    assert.deepEqual((await h.get(1)).state, { active: false, volume: 0.123 });
    assert.deepEqual(h.local[PREFERENCE_KEY], { active: false, volume: 0.678 });
    assert.deepEqual(h.local[KEY], [
        { tabId: 1, active: false, volume: 0.123 },
        { tabId: 2, active: false, volume: 0.678 },
    ]);
    assert.deepEqual((await h.get(3)).state, { active: false, volume: 0.678 });
});

test("explicit compressor set responds only after both keys are saved and queued get sees that choice", async () => {
    const h = createBackground({
        [KEY]: [{ tabId: 1, active: false, volume: 1 }],
        [PREFERENCE_KEY]: { active: false, volume: 1 },
    });
    const before = structuredClone(h.local);
    const gate = h.pauseNextSet();
    let responded = false;
    const set = h.set(1, { active: true, volume: 0 }).then((response) => {
        responded = true;
        return response;
    });
    await gate.started;
    const get = h.get(2);
    assert.equal(responded, false);
    assert.deepEqual(h.local, before);
    gate.release();
    assert.deepEqual(await set, { ok: true, state: { active: true, volume: 0 } });
    assert.deepEqual((await get).state, { active: true, volume: 0 });
    assert.deepEqual(h.local[PREFERENCE_KEY], { active: true, volume: 0 });
    assert.deepEqual(Object.keys(h.writes[0]).sort(), [KEY, PREFERENCE_KEY].sort());
});

test("delayed startup failure leaves cleanup pending for already queued get and set", async () => {
    for (const failure of ["get", "set"]) {
        const h = createBackground({
            [KEY]: [{ tabId: 1, active: true, volume: 0.2 }],
            [PREFERENCE_KEY]: { active: false, volume: 0.7 },
        });
        const gate = failure === "get" ? h.pauseNextGet() : h.pauseNextSet();
        if (failure === "get") h.failNextGet();
        else h.failNextSet();
        h.startup();
        await gate.started;
        const get = h.get(1);
        const set = h.set(2, { active: true, volume: 0.5 });
        assert.equal(h.writes.length, 0);
        gate.release();
        assert.deepEqual((await get).state, { active: false, volume: 0.7 });
        assert.equal((await set).ok, true);
        assert.deepEqual(h.local[KEY], [
            { tabId: 1, active: false, volume: 0.7 },
            { tabId: 2, active: true, volume: 0.5 },
        ]);
        assert.deepEqual(h.local[PREFERENCE_KEY], { active: true, volume: 0.5 });
    }
});

test("failed browser startup cleanup survives worker restart without restoring reused tab IDs", async () => {
    for (const failure of ["get", "set"]) {
        const h = createBackground({
            [KEY]: [{ tabId: 1, active: true, volume: 0.2 }],
            [PREFERENCE_KEY]: { active: false, volume: 0.7 },
        });
        const before = structuredClone(h.local);
        if (failure === "get") h.failNextGet();
        else h.failNextSet();
        h.startup();
        await h.idle();
        assert.deepEqual(h.local, before);
        assert.equal(h.session[CLEANUP_KEY], true);
        const restarted = createBackground(h.local, h.session);
        assert.deepEqual((await restarted.get(1)).state, { active: false, volume: 0.7 });
        assert.deepEqual(h.local[PREFERENCE_KEY], { active: false, volume: 0.7 });
        assert.deepEqual(h.local[KEY], [{ tabId: 1, active: false, volume: 0.7 }]);
        assert.equal(h.session[CLEANUP_KEY], false);
        await restarted.set(2, { active: true, volume: 0.4 });
        const ordinaryRestart = createBackground(h.local, h.session);
        assert.deepEqual((await ordinaryRestart.get(1)).state, { active: false, volume: 0.7 });
        assert.deepEqual((await ordinaryRestart.get(2)).state, { active: true, volume: 0.4 });
    }
});

test("session marker read failure rejects the request before touching local and recovers", async () => {
    for (const kind of ["get", "set"]) {
        const h = createBackground({
            [KEY]: [{ tabId: 1, active: true, volume: 0.2 }],
            [PREFERENCE_KEY]: { active: false, volume: 0.7 },
        });
        const before = structuredClone(h.local);
        h.failNextSessionGet();
        const result = kind === "get" ? await h.get(1) : await h.set(1, { active: true, volume: 0.5 });
        assert.equal(result.ok, false);
        assert.match(result.error, /session read failed/);
        assert.deepEqual(h.local, before);
        assert.equal(h.reads.length, 0);
        assert.equal(h.writes.length, 0);
        assert.deepEqual((await h.get(1)).state, { active: true, volume: 0.2 });
    }
});

test("failed session pending write preserves source selections and survives worker restart through a local guard", async () => {
    const h = createBackground({
        [KEY]: [{ tabId: 1, active: true, volume: 0.2 }],
        [PREFERENCE_KEY]: { active: false, volume: 0.7 },
    });
    const before = structuredClone(h.local);
    h.failNextSessionSet();
    h.startup();
    await h.idle();
    assert.deepEqual(h.local[KEY], before[KEY]);
    assert.deepEqual(h.local[PREFERENCE_KEY], before[PREFERENCE_KEY]);
    assert.equal(h.local[CLEANUP_KEY], true);
    assert.equal(h.reads.length, 0);
    const restarted = createBackground(h.local, h.session);
    assert.deepEqual(await restarted.get(1), { ok: true, state: { active: false, volume: 0.7 } });
    assert.deepEqual(h.local[PREFERENCE_KEY], before[PREFERENCE_KEY]);
    assert.equal(h.local[CLEANUP_KEY], false);
    assert.equal(h.session[CLEANUP_KEY], false);
});

test("a repeated session guard failure returns an error and preserves the recoverable local pending marker", async () => {
    const h = createBackground({
        [KEY]: [{ tabId: 1, active: true, volume: 0.2 }],
        [PREFERENCE_KEY]: { active: false, volume: 0.7 },
    });
    h.failNextSessionSet();
    h.startup();
    await h.idle();
    const before = structuredClone(h.local);
    h.failNextSessionSet();
    const result = await h.get(1);
    assert.equal(result.ok, false);
    assert.match(result.error, /session write failed/);
    assert.deepEqual(h.local, before);
    assert.deepEqual((await h.get(1)).state, { active: false, volume: 0.7 });
});

test("absent session API or a cleared session store preserves normal existing snapshots", async () => {
    const local = {
        [KEY]: [{ tabId: 1, active: true, volume: 0.2 }],
        [PREFERENCE_KEY]: { active: false, volume: 0.7 },
    };
    for (const session of [null, {}]) {
        const h = createBackground(structuredClone(local), session);
        assert.deepEqual((await h.get(1)).state, { active: true, volume: 0.2 });
        assert.deepEqual(h.local, local);
    }
});

test("startup cleanup failure survives worker restart when the session API is unavailable", async () => {
    const h = createBackground(
        {
            [KEY]: [{ tabId: 1, active: true, volume: 0.2 }],
            [PREFERENCE_KEY]: { active: false, volume: 0.7 },
        },
        null
    );
    h.failNextGet();
    h.startup();
    await h.idle();
    assert.equal(h.local[CLEANUP_KEY], true);
    assert.deepEqual(h.local[KEY], [{ tabId: 1, active: true, volume: 0.2 }]);
    const restarted = createBackground(h.local, null);
    assert.deepEqual((await restarted.get(1)).state, { active: false, volume: 0.7 });
    assert.equal(h.local[CLEANUP_KEY], false);
});

test("failure to release the session guard leaves cleanup recoverable and does not accept new choices", async () => {
    const h = createBackground({
        [KEY]: [{ tabId: 1, active: true, volume: 0.2 }],
        [PREFERENCE_KEY]: { active: false, volume: 0.7 },
    });
    const gate = h.pauseNextSet();
    h.startup();
    await gate.started;
    assert.equal(h.session[CLEANUP_KEY], true);
    h.failNextSessionSet();
    gate.release();
    await h.idle();
    assert.deepEqual(h.local[KEY], []);
    assert.deepEqual(h.local[PREFERENCE_KEY], { active: false, volume: 0.7 });
    assert.equal(h.session[CLEANUP_KEY], true);
    const restarted = createBackground(h.local, h.session);
    restarted.failNextSessionSet();
    const response = await restarted.set(1, { active: true, volume: 0.5 });
    assert.equal(response.ok, false);
    assert.match(response.error, /session write failed/);
    assert.deepEqual(h.local[KEY], []);
    assert.deepEqual(h.local[PREFERENCE_KEY], { active: false, volume: 0.7 });
    assert.deepEqual((await restarted.get(1)).state, { active: false, volume: 0.7 });
});

test("failure of both pending storage areas returns an error, preserves source data, and recovers in the worker", async () => {
    const h = createBackground({
        [KEY]: [{ tabId: 1, active: true, volume: 0.2 }],
        [PREFERENCE_KEY]: { active: false, volume: 0.7 },
    });
    const before = structuredClone(h.local);
    h.failNextSessionSet();
    h.failNextSet();
    h.startup();
    await h.idle();
    assert.deepEqual(h.local, before);
    h.failNextSessionSet();
    h.failNextSet();
    const result = await h.get(1);
    assert.equal(result.ok, false);
    assert.match(result.error, /write failed/);
    assert.deepEqual(h.local, before);
    assert.equal(h.writes.length, 0);
    assert.equal(h.sessionWrites.length, 0);
    assert.deepEqual((await h.get(1)).state, { active: false, volume: 0.7 });
});
