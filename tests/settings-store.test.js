const assert = require("node:assert/strict");
const test = require("node:test");

require("../shared/settings.js");
require("../shared/data.js");
require("../shared/liveStart.js");
require("../shared/settingsBackup.js");
require("../shared/settingsStore.js");

const settings = globalThis.BetterChzzkSettings;
const catalog = globalThis.BetterChzzkSettingsBackup;
const STORE = catalog.STORE_MESSAGE_TYPE;
const BACKUP = catalog.BACKUP_MESSAGE_TYPE;
const A = "a".repeat(32);
const B = "b".repeat(32);
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const contentSender = { id: "ext", tab: { id: 3 }, frameId: 0, url: "https://chzzk.naver.com/live/" + A };
const optionsSender = { id: "ext", frameId: 0, url: "chrome-extension://ext/options.html" };

// Minimal pure stand-ins for the delegated folder and chat multiview models (their own tests own the rules).
globalThis.BetterChzzkFollowingFolders = {
    STORAGE_KEY: catalog.FOLDERS_KEY,
    EMPTY_STATE: Object.freeze({ version: 1, folders: [] }),
    parseState(value) {
        return value?.version === 1 && Array.isArray(value.folders)
            ? { ok: true, state: clone(value) }
            : { ok: false, error: "invalid" };
    },
};
globalThis.BetterChzzkChatMultiview = {
    STORAGE_KEY: catalog.CHAT_MULTIVIEW_KEY,
    parseConfig(value) {
        return value?.version === 1 && Array.isArray(value.channels)
            ? { ok: true, config: clone(value) }
            : { ok: false, error: "invalid" };
    },
    normalizeConfig(value) {
        return this.parseConfig(value).ok
            ? clone(value)
            : { version: 1, channels: [], width: 960, height: 560, corner: "bottom-right" };
    },
};

async function settle() {
    for (let i = 0; i < 30; i++) await new Promise(setImmediate);
}

function createLock({ exclusive = true } = {}) {
    let tail = Promise.resolve();
    return (task) => {
        if (!exclusive) return Promise.resolve().then(task);
        const run = tail.then(() => task());
        tail = run.catch(() => {});
        return run;
    };
}

function harness({ sync = {}, local = {}, exclusive = true } = {}) {
    const listeners = new Set();
    const runtime = {
        id: "ext",
        lastError: undefined,
        getURL: (file) => `chrome-extension://ext/${file}`,
        getManifest: () => ({ version: "9.9.9" }),
    };
    const calls = [];
    const failures = { set: null, remove: null, get: null };
    const hooks = { beforeGet: null, afterSet: null };
    function area(name, data) {
        const finish = (callback, value, failed) => {
            if (failed) runtime.lastError = { message: `${name} failed` };
            try {
                callback(value);
            } finally {
                runtime.lastError = undefined;
            }
        };
        return {
            data,
            get(keys, callback) {
                calls.push([name, "get", clone(keys)]);
                hooks.beforeGet?.(name, keys);
                setTimeout(() => {
                    const list = keys === null ? Object.keys(data) : [keys].flat();
                    const out = {};
                    for (const key of list) if (Object.hasOwn(data, key)) out[key] = clone(data[key]);
                    finish(callback, out, failures.get?.(name, keys));
                }, 0);
            },
            set(values, callback) {
                calls.push([name, "set", clone(values)]);
                setTimeout(() => {
                    if (failures.set?.(name, values)) {
                        finish(callback, undefined, true);
                        return;
                    }
                    const changes = {};
                    for (const [key, value] of Object.entries(values)) {
                        changes[key] = { oldValue: clone(data[key]), newValue: clone(value) };
                        data[key] = clone(value);
                    }
                    finish(callback, undefined, false);
                    for (const listener of [...listeners]) listener(changes, name);
                    hooks.afterSet?.(name, values);
                }, 0);
            },
            remove(keys, callback) {
                calls.push([name, "remove", clone(keys)]);
                setTimeout(() => {
                    if (failures.remove?.(name, keys)) {
                        finish(callback, undefined, true);
                        return;
                    }
                    const changes = {};
                    for (const key of [keys].flat()) {
                        if (!Object.hasOwn(data, key)) continue;
                        changes[key] = { oldValue: clone(data[key]) };
                        delete data[key];
                    }
                    finish(callback, undefined, false);
                    for (const listener of [...listeners]) listener(changes, name);
                }, 0);
            },
        };
    }
    const chrome = {
        runtime,
        storage: {
            sync: area("sync", clone(sync)),
            local: area("local", clone(local)),
            onChanged: {
                addListener: (listener) => listeners.add(listener),
                removeListener: (listener) => listeners.delete(listener),
            },
        },
    };
    const lock = createLock({ exclusive });
    const controller = globalThis.BetterChzzkSettingsStore.createController({
        chrome,
        withLock: lock,
        isOptionsPageSender: (sender) => sender?.url === "chrome-extension://ext/options.html",
        now: () => 1700000000000,
    });
    function send(message, sender) {
        return new Promise((resolve) => {
            const async = controller.handleMessage(message, sender, resolve);
            assert.ok(async === true || async === false, "settings messages are always answered");
        });
    }
    // An options-page style writer: same lock, read-modify-write inside it.
    function optionsPageWrite(values) {
        return lock(
            () =>
                new Promise((resolve) =>
                    chrome.storage.sync.set(values, () => {
                        resolve();
                    })
                )
        );
    }
    function emitRemote(areaName, key, value) {
        const data = chrome.storage[areaName].data;
        const change = { oldValue: clone(data[key]), newValue: clone(value) };
        data[key] = clone(value);
        for (const listener of [...listeners]) listener({ [key]: change }, areaName);
    }
    return {
        chrome,
        controller,
        send,
        calls,
        failures,
        hooks,
        sync: chrome.storage.sync.data,
        local: chrome.storage.local.data,
        optionsPageWrite,
        emitRemote,
    };
}

function storeMessage(area, values, expected) {
    return { type: STORE, version: 1, area, values, ...(expected ? { expected } : {}) };
}

function file(sync = {}, local = {}) {
    return {
        kind: catalog.FILE_KIND,
        formatVersion: 1,
        extensionVersion: "1.4.3",
        createdAt: 1700000000000,
        sync,
        local,
    };
}

test("content writes require a top-level chzzk sender, allowlisted keys and valid values", async () => {
    const h = harness();
    for (const sender of [
        { ...contentSender, id: "other" },
        { ...contentSender, frameId: 1 },
        { ...contentSender, tab: undefined },
        { ...contentSender, url: "https://chzzk.naver.com.evil.example/" },
        { ...contentSender, url: "https://user@chzzk.naver.com/" },
        optionsSender,
    ]) {
        assert.deepEqual(await h.send(storeMessage("sync", { skipSeconds: 7 }), sender), {
            ok: false,
            error: "untrusted-sender",
        });
    }
    const rejected = [
        [{ ...storeMessage("sync", { skipSeconds: 7 }), extra: true }, "invalid-request"],
        [{ ...storeMessage("sync", { skipSeconds: 7 }), version: 2 }, "invalid-request"],
        [storeMessage("session", { skipSeconds: 7 }), "invalid-request"],
        [storeMessage("sync", {}), "invalid-request"],
        [storeMessage("sync", Object.fromEntries([...Array(9)].map((_, i) => [`x${i}`, 1]))), "invalid-request"],
        [storeMessage("sync", { adVideoEnabled: false }), "key-not-allowed"],
        [storeMessage("local", { betterChzzkLiveWatchHistory: {} }), "key-not-allowed"],
        [
            storeMessage("local", { "betterChzzkMultiviewDelay:short": { version: 1, delaySeconds: 1 } }),
            "key-not-allowed",
        ],
        [storeMessage("sync", { skipSeconds: "7" }), "invalid-value"],
        [storeMessage("sync", { ambientIntensity: 5 }), "invalid-value"],
        [storeMessage("sync", { [catalog.PINS_KEY]: ["a", "a"] }), "invalid-value"],
        [storeMessage("local", { [catalog.PANEL_KEYS.chatWidth]: 0 }), "invalid-value"],
        [storeMessage("local", { [catalog.PANEL_KEYS.chatHeight]: 1.5 }), "invalid-value"],
        [
            storeMessage("local", { [`betterChzzkMultiviewDelay:${A}`]: { version: 2, delaySeconds: 1 } }),
            "invalid-value",
        ],
        [storeMessage("local", { [`betterChzzkMultiviewQuality:${A}`]: 9000 }), "invalid-value"],
        [storeMessage("sync", { [catalog.FOLDERS_KEY]: { version: 2 } }), "invalid-value"],
        [storeMessage("sync", { skipSeconds: 7 }, { skipSeconds: { value: 5, extra: 1 } }), "invalid-request"],
        [storeMessage("sync", { skipSeconds: 7 }, { adVideoEnabled: { absent: true } }), "key-not-allowed"],
    ];
    for (const [message, error] of rejected) {
        assert.deepEqual(await h.send(message, contentSender), { ok: false, error }, JSON.stringify(message));
    }
    assert.equal(h.calls.filter(([, method]) => method === "set").length, 0, "rejected requests never write");
    assert.deepEqual(
        await h.send(
            storeMessage("local", {
                [catalog.PANEL_KEYS.chatHeight]: 480,
                [`betterChzzkMultiviewDelay:${A}`]: { version: 2, basis: "live-edge-clock", delaySeconds: 2.5 },
                [`betterChzzkMultiviewQuality:${A}`]: 720,
            }),
            contentSender
        ),
        { ok: true }
    );
    assert.equal(h.local[catalog.PANEL_KEYS.chatHeight], 480);
    assert.deepEqual(await h.send(storeMessage("sync", { [catalog.PINS_KEY]: [A, "channel-c"] }), contentSender), {
        ok: true,
    });
    assert.deepEqual(h.sync[catalog.PINS_KEY], [A, "channel-c"]);
});

test("expected values compare inside the lock and reject a stale caller with the current state", async () => {
    const h = harness({ sync: { [catalog.FOLDERS_KEY]: { version: 1, folders: [{ id: "f1" }] } } });
    const stale = { version: 1, folders: [] };
    const response = await h.send(
        storeMessage(
            "sync",
            { [catalog.FOLDERS_KEY]: { version: 1, folders: [{ id: "f2" }] } },
            {
                [catalog.FOLDERS_KEY]: { value: stale },
            }
        ),
        contentSender
    );
    assert.equal(response.ok, false);
    assert.equal(response.error, "conflict");
    assert.deepEqual(response.current, { [catalog.FOLDERS_KEY]: { value: { version: 1, folders: [{ id: "f1" }] } } });
    assert.deepEqual(h.sync[catalog.FOLDERS_KEY], { version: 1, folders: [{ id: "f1" }] });
    assert.deepEqual(
        await h.send(
            storeMessage(
                "local",
                { [catalog.CHAT_MULTIVIEW_KEY]: { version: 1, channels: [] } },
                {
                    [catalog.CHAT_MULTIVIEW_KEY]: { absent: true },
                }
            ),
            contentSender
        ),
        { ok: true }
    );
    const again = await h.send(
        storeMessage(
            "local",
            { [catalog.CHAT_MULTIVIEW_KEY]: { version: 1, channels: [] } },
            {
                [catalog.CHAT_MULTIVIEW_KEY]: { absent: true },
            }
        ),
        contentSender
    );
    assert.deepEqual(again.current, { [catalog.CHAT_MULTIVIEW_KEY]: { value: { version: 1, channels: [] } } });
});

test("content writes keep arrival order and a failed write does not block the next one", async () => {
    const h = harness();
    h.failures.set = (_area, values) => values.skipSeconds === 8;
    const results = await Promise.all([
        h.send(storeMessage("sync", { skipSeconds: 7 }), contentSender),
        h.send(storeMessage("sync", { skipSeconds: 8 }), contentSender),
        h.send(storeMessage("sync", { skipSeconds: 9 }), contentSender),
    ]);
    assert.deepEqual(results, [{ ok: true }, { ok: false, error: "storage-write-failed" }, { ok: true }]);
    assert.deepEqual(
        h.calls.filter(([, method]) => method === "set").map(([, , values]) => values.skipSeconds),
        [7, 8, 9]
    );
    assert.equal(h.sync.skipSeconds, 9);
});

test("settings files are strict, report unknown option keys, and keep cross-option rules", () => {
    const valid = file({ options: { skipSeconds: 10, futureOption: true } });
    const parsed = catalog.parseBackup(JSON.stringify(valid));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ignoredOptionKeys, ["futureOption"]);
    assert.deepEqual(parsed.backup.sync.options, { skipSeconds: 10 });
    for (const [input, error] of [
        ["{", "invalid-json"],
        [{ ...valid, kind: "cheese-spanner.watch-history-backup" }, "invalid-kind"],
        [{ ...valid, formatVersion: 2 }, "unsupported-version"],
        [{ ...valid, extra: 1 }, "invalid-file"],
        [{ ...valid, sync: { ...valid.sync, unknownSection: [] } }, "invalid-file"],
        [file({ options: { skipSeconds: 0 } }), "invalid-options"],
        [file({ options: { chatPosition: "top" } }), "invalid-options"],
        [file({}, { panelSizes: { chatWidth: -1 } }), "invalid-panel-size"],
        [file({}, { panelSizes: { other: 1 } }), "invalid-panel-size"],
        [file({}, { multiviewDelays: { short: { version: 1, delaySeconds: 1 } } }), "invalid-multiviewDelays"],
        [
            file({}, { liveStartChannels: [{ channelId: A, channelName: "x", notify: true }] }),
            "invalid-live-start-channels",
        ],
        [
            file({}, { liveStartChannels: [{ channelId: A, channelName: " x", notify: true, autoOpen: false }] }),
            "invalid-live-start-channels",
        ],
        ["x".repeat(catalog.MAX_FILE_BYTES + 1), "too-large"],
    ]) {
        assert.deepEqual(catalog.parseBackup(typeof input === "string" ? input : JSON.stringify(input)), {
            ok: false,
            error,
        });
    }
    const duplicateShortcut = catalog.parseBackup(
        file({ options: { playbackSpeedHalfKeyCode: "KeyQ", playbackSpeedDoubleKeyCode: "KeyQ" } })
    );
    assert.equal(duplicateShortcut.ok, true);
    assert.deepEqual(catalog.planImport({ sync: {}, local: {} }, duplicateShortcut.backup), {
        ok: false,
        error: "option-combination",
    });
});

test("a partial file is checked against the speed shortcuts it keeps, before anything is written", async () => {
    const stored = {
        playbackSpeedHalfKeyCode: "KeyQ",
        playbackSpeedDoubleKeyCode: "BracketLeft",
        playbackSpeedResetKeyCode: "KeyW",
    };
    const effective = (sync) => {
        const options = settings.normalizeOptions(sync);
        return [
            options.playbackSpeedHalfKeyCode,
            options.playbackSpeedDoubleKeyCode,
            options.playbackSpeedResetKeyCode,
        ];
    };
    const conflicting = file({ options: { playbackSpeedHalfKeyCode: "BracketLeft" } });
    const parsed = catalog.parseBackup(JSON.stringify(conflicting));
    assert.equal(parsed.ok, true);
    assert.deepEqual(catalog.planImport({ sync: stored, local: {} }, parsed.backup), {
        ok: false,
        error: "option-combination",
    });

    const h = harness({ sync: stored });
    for (const action of ["preview", "apply"]) {
        const result = await h.send(
            { type: BACKUP, version: 1, action, backup: conflicting, fingerprint: "x" },
            optionsSender
        );
        assert.deepEqual(result, { ok: false, error: "invalid-file" }, `${action} rejects the merged duplicate`);
    }
    assert.equal(h.calls.filter(([, method]) => method === "set").length, 0);
    assert.deepEqual(h.sync, stored, "raw values stay");
    assert.deepEqual(effective(h.sync), ["KeyQ", "BracketLeft", "KeyW"], "shortcuts in use stay");

    // A raw duplicate already resolved to the defaults must not come back into effect through a partial write.
    const brokenStored = { ...stored, playbackSpeedHalfKeyCode: "KeyW" };
    const unrelated = catalog.parseBackup(JSON.stringify(file({ options: { playbackSpeedHalfKeyCode: "KeyE" } })));
    assert.deepEqual(catalog.planImport({ sync: brokenStored, local: {} }, unrelated.backup), {
        ok: false,
        error: "option-combination",
    });

    const fitting = file({ options: { playbackSpeedHalfKeyCode: "KeyE" } });
    const preview = await h.send({ type: BACKUP, version: 1, action: "preview", backup: fitting }, optionsSender);
    assert.equal(preview.ok, true);
    assert.equal(preview.changes, 1);
    // Another tab moves the double-speed key onto the imported key after the preview.
    await h.optionsPageWrite({ playbackSpeedDoubleKeyCode: "KeyE" });
    h.calls.length = 0;
    const stale = await h.send(
        { type: BACKUP, version: 1, action: "apply", backup: fitting, fingerprint: preview.fingerprint },
        optionsSender
    );
    assert.deepEqual(stale, { ok: false, error: "invalid-file" });
    assert.equal(h.calls.filter(([, method]) => method === "set").length, 0);
    assert.deepEqual(effective(h.sync), ["KeyQ", "KeyE", "KeyW"]);

    await h.optionsPageWrite({ playbackSpeedDoubleKeyCode: "BracketLeft" });
    const again = await h.send({ type: BACKUP, version: 1, action: "preview", backup: fitting }, optionsSender);
    const applied = await h.send(
        { type: BACKUP, version: 1, action: "apply", backup: fitting, fingerprint: again.fingerprint },
        optionsSender
    );
    assert.equal(applied.result.status, "applied");
    assert.deepEqual(effective(h.sync), ["KeyE", "BracketLeft", "KeyW"], "a fitting partial file keeps the others");

    const whole = file({
        options: {
            playbackSpeedHalfKeyCode: "BracketLeft",
            playbackSpeedDoubleKeyCode: "BracketRight",
            playbackSpeedResetKeyCode: "Backslash",
        },
    });
    const wholePreview = await h.send({ type: BACKUP, version: 1, action: "preview", backup: whole }, optionsSender);
    const wholeApplied = await h.send(
        { type: BACKUP, version: 1, action: "apply", backup: whole, fingerprint: wholePreview.fingerprint },
        optionsSender
    );
    assert.equal(wholeApplied.result.status, "applied");
    assert.deepEqual(effective(h.sync), ["BracketLeft", "BracketRight", "Backslash"], "a whole file still applies");
});

test("export, change and import restore the backed-up values in effect-safe stage order", async () => {
    const h = harness({
        sync: {
            ...settings.DEFAULT_OPTIONS,
            chatPosition: "left",
            liveStartAutoOpenEnabled: true,
            rewardAutoCollectEnabled: false,
            [catalog.PINS_KEY]: [A],
            [catalog.FOLDERS_KEY]: { version: 1, folders: [{ id: "games" }] },
        },
        local: {
            [catalog.PANEL_KEYS.chatWidth]: 400,
            [catalog.PANEL_KEYS.chatHeight]: 500,
            [catalog.LIVE_START_CHANNELS_KEY]: [{ channelId: A, channelName: "가", notify: true, autoOpen: true }],
            [`betterChzzkMultiviewDelay:${A}`]: { version: 1, delaySeconds: 3 },
            [`betterChzzkMultiviewQuality:${B}`]: 480,
            [catalog.CHAT_MULTIVIEW_KEY]: { version: 1, channels: [{ channelId: B, channelName: "나" }] },
            betterChzzkLiveWatchHistory: { secret: true },
            "betterchzzk:live-start-state": { checkedAt: 1 },
        },
    });
    const exported = await h.send({ type: BACKUP, version: 1, action: "export" }, optionsSender);
    assert.equal(exported.ok, true);
    const backup = exported.backup;
    assert.equal(backup.extensionVersion, "9.9.9");
    assert.equal(JSON.stringify(backup).includes("secret"), false, "history never enters settings files");
    assert.equal(JSON.stringify(backup).includes("live-start-state"), false);
    assert.deepEqual(backup.local.multiviewDelays, { [A]: { version: 1, delaySeconds: 3 } });
    assert.deepEqual(backup.local.panelSizes, { sidebarWidth: null, chatWidth: 400, chatHeight: 500 });
    // Change everything after exporting.
    Object.assign(h.sync, { chatPosition: "right", liveStartAutoOpenEnabled: false, rewardAutoCollectEnabled: true });
    h.sync[catalog.PINS_KEY] = [];
    h.local[catalog.PANEL_KEYS.chatHeight] = null;
    h.local[catalog.LIVE_START_CHANNELS_KEY] = [];
    h.local[`betterChzzkMultiviewDelay:${A}`] = { version: 2, basis: "live-edge-clock", delaySeconds: 9 };
    const preview = await h.send({ type: BACKUP, version: 1, action: "preview", backup }, optionsSender);
    assert.equal(preview.ok, true);
    assert.equal(preview.summary.options.changed, 3);
    assert.equal(preview.summary.liveStartChannels.changed, true);
    h.calls.length = 0;
    const applied = await h.send(
        { type: BACKUP, version: 1, action: "apply", backup, fingerprint: preview.fingerprint },
        optionsSender
    );
    assert.equal(applied.ok, true);
    assert.equal(applied.result.status, "applied");
    const sets = h.calls
        .filter(([, method]) => method === "set")
        .map(([area, , values]) => [area, Object.keys(values)]);
    assert.deepEqual(sets, [
        ["sync", ["rewardAutoCollectEnabled"]],
        ["sync", ["chatPosition", catalog.PINS_KEY]],
        ["local", [catalog.PANEL_KEYS.chatHeight, `betterChzzkMultiviewDelay:${A}`]],
        ["local", [catalog.LIVE_START_CHANNELS_KEY]],
        ["sync", ["liveStartAutoOpenEnabled"]],
    ]);
    assert.equal(h.sync.chatPosition, "left");
    assert.equal(h.sync.liveStartAutoOpenEnabled, true);
    assert.equal(h.sync.rewardAutoCollectEnabled, false);
    assert.deepEqual(h.sync[catalog.PINS_KEY], [A]);
    assert.equal(h.local[catalog.PANEL_KEYS.chatHeight], 500);
    assert.deepEqual(h.local[`betterChzzkMultiviewDelay:${A}`], { version: 1, delaySeconds: 3 });
    assert.deepEqual(h.local.betterChzzkLiveWatchHistory, { secret: true });
    const repeated = await h.send({ type: BACKUP, version: 1, action: "preview", backup }, optionsSender);
    assert.equal(repeated.changes, 0, "the same file applies idempotently");
});

test("a change after preview requires re-confirmation and writes nothing", async () => {
    const h = harness({ sync: { skipSeconds: 5 } });
    const backup = file({ options: { skipSeconds: 10 } });
    const preview = await h.send({ type: BACKUP, version: 1, action: "preview", backup }, optionsSender);
    await h.send(storeMessage("sync", { skipSeconds: 6 }), contentSender);
    h.calls.length = 0;
    const result = await h.send(
        { type: BACKUP, version: 1, action: "apply", backup, fingerprint: preview.fingerprint },
        optionsSender
    );
    assert.equal(result.result.status, "reconfirm");
    assert.notEqual(result.result.fingerprint, preview.fingerprint);
    assert.equal(h.calls.filter(([, method]) => method === "set").length, 0);
    assert.equal(h.sync.skipSeconds, 6);
});

test("writers that arrive between the restore's last read and its write run after it and keep their value", async () => {
    const h = harness({ sync: { skipSeconds: 5, ambientIntensity: 60 } });
    const backup = file({ options: { skipSeconds: 10, ambientIntensity: 30 } });
    const preview = await h.send({ type: BACKUP, version: 1, action: "preview", backup }, optionsSender);
    let content, options;
    h.hooks.beforeGet = (area) => {
        // Exactly once: interleave a page write and an options page write after the restore's read began.
        if (area !== "sync" || content) return;
        content = h.send(storeMessage("sync", { skipSeconds: 20 }), contentSender);
        options = h.optionsPageWrite({ ambientIntensity: 90 });
    };
    const result = await h.send(
        { type: BACKUP, version: 1, action: "apply", backup, fingerprint: preview.fingerprint },
        optionsSender
    );
    assert.equal(result.result.status, "applied");
    assert.deepEqual(await content, { ok: true });
    await options;
    const sets = h.calls.filter(([, method]) => method === "set").map(([, , values]) => values);
    // The restore's single write comes first; both interleaved writers run only after it.
    assert.deepEqual(sets[0], { skipSeconds: 10, ambientIntensity: 30 });
    assert.deepEqual(
        sets.slice(1).sort((a, b) => Object.keys(a)[0].localeCompare(Object.keys(b)[0])),
        [{ ambientIntensity: 90 }, { skipSeconds: 20 }]
    );
    assert.equal(h.sync.skipSeconds, 20);
    assert.equal(h.sync.ambientIntensity, 90);
});

test("without an exclusive lock the same interleaving would lose the newer page value", async () => {
    // Control for the previous test: proves the interleaving hook reaches the read/write window.
    const h = harness({ sync: { ambientIntensity: 60 }, exclusive: false });
    const backup = file({ options: { ambientIntensity: 30 } });
    const preview = await h.send({ type: BACKUP, version: 1, action: "preview", backup }, optionsSender);
    let options;
    h.hooks.beforeGet = (area) => {
        if (area === "sync" && !options) options = h.optionsPageWrite({ ambientIntensity: 90 });
    };
    await h.send(
        { type: BACKUP, version: 1, action: "apply", backup, fingerprint: preview.fingerprint },
        optionsSender
    );
    await options;
    assert.equal(h.sync.ambientIntensity, 30, "the restore overwrote a newer value");
});

test("a failed later stage rolls back earlier stages under the lock and never enables effects", async () => {
    const h = harness({
        sync: { skipSeconds: 5, liveStartAutoOpenEnabled: false, [catalog.PINS_KEY]: [A] },
        local: { [catalog.PANEL_KEYS.chatWidth]: 300 },
    });
    const backup = file(
        { options: { skipSeconds: 10, liveStartAutoOpenEnabled: true }, pinnedChannelIds: [B] },
        { panelSizes: { chatWidth: 500, chatHeight: 400 } }
    );
    const preview = await h.send({ type: BACKUP, version: 1, action: "preview", backup }, optionsSender);
    h.failures.set = (area) => area === "local";
    let queued;
    h.hooks.afterSet = (area) => {
        if (area === "sync" && !queued) queued = h.send(storeMessage("sync", { skipSeconds: 42 }), contentSender);
    };
    const result = await h.send(
        { type: BACKUP, version: 1, action: "apply", backup, fingerprint: preview.fingerprint },
        optionsSender
    );
    assert.equal(result.result.status, "failed");
    assert.equal(result.result.stage, "local");
    assert.equal(result.result.rolledBack, true);
    assert.deepEqual(result.result.conflicted, []);
    assert.deepEqual(result.result.failed, []);
    assert.deepEqual(await queued, { ok: true });
    assert.equal(h.sync.liveStartAutoOpenEnabled, false, "effects stage never ran");
    assert.deepEqual(h.sync[catalog.PINS_KEY], [A]);
    assert.equal(h.local[catalog.PANEL_KEYS.chatWidth], 300);
    assert.equal(Object.hasOwn(h.local, catalog.PANEL_KEYS.chatHeight), false);
    assert.equal(h.sync.skipSeconds, 42, "the page write queued during the restore applies after the rollback");
    assert.equal(
        h.calls.some(
            ([area, method, values]) => area === "sync" && method === "set" && values.liveStartAutoOpenEnabled
        ),
        false
    );
});

test("rollback leaves keys changed by Chrome sync from another device and reports them", async () => {
    const h = harness({ sync: { skipSeconds: 5, [catalog.PINS_KEY]: [A] } });
    const backup = file({ options: { skipSeconds: 10 }, pinnedChannelIds: [B] }, { panelSizes: { chatWidth: 500 } });
    const preview = await h.send({ type: BACKUP, version: 1, action: "preview", backup }, optionsSender);
    h.failures.set = (area) => area === "local";
    let emitted = false;
    h.hooks.afterSet = (area) => {
        if (area !== "sync" || emitted) return;
        emitted = true;
        h.emitRemote("sync", catalog.PINS_KEY, ["remote"]);
    };
    const result = await h.send(
        { type: BACKUP, version: 1, action: "apply", backup, fingerprint: preview.fingerprint },
        optionsSender
    );
    assert.equal(result.result.status, "failed");
    assert.equal(result.result.rolledBack, false);
    assert.deepEqual(result.result.conflicted, [`sync:${catalog.PINS_KEY}`]);
    assert.deepEqual(result.result.failed, []);
    assert.deepEqual(h.sync[catalog.PINS_KEY], ["remote"]);
    assert.equal(h.sync.skipSeconds, 5);
});

test("rollback read or write failures are reported apart from conflicts", async () => {
    const h = harness({ sync: { skipSeconds: 5 } });
    const backup = file({ options: { skipSeconds: 10 } }, { panelSizes: { chatWidth: 500 } });
    const preview = await h.send({ type: BACKUP, version: 1, action: "preview", backup }, optionsSender);
    let syncSets = 0;
    h.failures.set = (area) => area === "local" || (area === "sync" && ++syncSets > 1);
    const result = await h.send(
        { type: BACKUP, version: 1, action: "apply", backup, fingerprint: preview.fingerprint },
        optionsSender
    );
    assert.equal(result.result.status, "failed");
    assert.equal(result.result.rolledBack, false);
    assert.deepEqual(result.result.conflicted, []);
    assert.deepEqual(result.result.failed, ["sync:skipSeconds"]);
    assert.equal(h.sync.skipSeconds, 10, "the failed rollback leaves the restored value, which is reported");
    assert.equal(catalog.sectionOf("sync:skipSeconds"), "options");
    assert.equal(catalog.sectionOf(`local:${catalog.PANEL_KEYS.chatHeight}`), "panelSizes");
    assert.equal(catalog.sectionOf(`local:betterChzzkMultiviewDelay:${A}`), "multiview");
});

test("a key changed outside the boundary during a restore is not written by later stages", async () => {
    const panelKey = catalog.PANEL_KEYS.chatWidth;
    const h = harness({ sync: { skipSeconds: 5 }, local: { [panelKey]: 300 } });
    const backup = file({ options: { skipSeconds: 10 } }, { panelSizes: { chatWidth: 500 } });
    const preview = await h.send({ type: BACKUP, version: 1, action: "preview", backup }, optionsSender);
    let emitted = false;
    h.hooks.afterSet = (area) => {
        if (area !== "sync" || emitted) return;
        emitted = true;
        h.emitRemote("local", panelKey, 777);
    };
    const result = await h.send(
        { type: BACKUP, version: 1, action: "apply", backup, fingerprint: preview.fingerprint },
        optionsSender
    );
    assert.equal(result.result.status, "applied");
    assert.deepEqual(result.result.conflicts, [`local:${panelKey}`]);
    assert.equal(h.local[panelKey], 777, "the outside value is kept instead of the file value");
    assert.equal(
        h.calls.some(
            ([area, method, values]) => area === "local" && method === "set" && Object.hasOwn(values, panelKey)
        ),
        false
    );
    assert.equal(h.sync.skipSeconds, 10);
});

test("only the options page may export, preview or apply files, and requests stay strict", async () => {
    const h = harness();
    for (const sender of [contentSender, { ...optionsSender, url: "chrome-extension://ext/history.html" }]) {
        assert.deepEqual(await h.send({ type: BACKUP, version: 1, action: "export" }, sender), {
            ok: false,
            error: "untrusted-sender",
        });
    }
    for (const message of [
        { type: BACKUP, version: 2, action: "export" },
        { type: BACKUP, version: 1, action: "delete" },
        { type: BACKUP, version: 1, action: "apply", backup: file() },
        { type: BACKUP, version: 1, action: "preview", backup: file(), disabledOptionKeys: ["nope"] },
        { type: BACKUP, version: 1, action: "export", extra: 1 },
    ]) {
        assert.equal((await h.send(message, optionsSender)).ok, false, JSON.stringify(message));
    }
    assert.deepEqual(
        await h.send({ type: BACKUP, version: 1, action: "preview", backup: { kind: "x" } }, optionsSender),
        {
            ok: false,
            error: "invalid-file",
        }
    );
});

test("permission-denied imports can turn the permission options off without touching other choices", async () => {
    const h = harness({ sync: { liveStartNotificationsEnabled: false, chatPosition: "right" } });
    const backup = file({
        options: { liveStartNotificationsEnabled: true, liveMultiviewEnabled: true, chatPosition: "left" },
    });
    const preview = await h.send({ type: BACKUP, version: 1, action: "preview", backup }, optionsSender);
    assert.deepEqual(preview.summary.permissions, { notifications: true, previewHosts: true });
    const disabled = ["liveStartNotificationsEnabled", "liveMultiviewEnabled"];
    const result = await h.send(
        {
            type: BACKUP,
            version: 1,
            action: "apply",
            backup,
            fingerprint: preview.fingerprint,
            disabledOptionKeys: disabled,
        },
        optionsSender
    );
    assert.equal(result.result.status, "applied");
    assert.equal(h.sync.liveStartNotificationsEnabled, false);
    assert.equal(h.sync.liveMultiviewEnabled, false);
    assert.equal(h.sync.chatPosition, "left");
    await settle();
});

const channelId = (index) => index.toString(16).padStart(32, "0");

test("multiview settings round-trip up to the shared bound and a larger section is reported, never cut", () => {
    const max = catalog.MAX_MULTIVIEW_CHANNELS;
    assert.ok(max > 200, "more than the old 200-channel bound");
    for (const count of [200, 201, max - 1, max]) {
        const localData = {};
        for (let i = 0; i < count; i++) {
            localData[catalog.MULTIVIEW_QUALITY_PREFIX + channelId(i)] = 720;
            localData[catalog.MULTIVIEW_DELAY_PREFIX + channelId(i)] = { version: 1, delaySeconds: 3 };
        }
        const { backup, omitted } = catalog.createBackup({ localData, extensionVersion: "1.4.4" });
        assert.deepEqual(omitted, [], `${count} channels`);
        const parsed = catalog.parseBackup(JSON.stringify(backup));
        assert.equal(parsed.ok, true, `${count} channels: ${parsed.error}`);
        assert.equal(Object.keys(parsed.backup.local.multiviewQualities).length, count);
        assert.equal(Object.keys(parsed.backup.local.multiviewDelays).length, count);
    }

    const localData = { [catalog.MULTIVIEW_DELAY_PREFIX + channelId(0)]: { version: 1, delaySeconds: 3 } };
    for (let i = 0; i <= max; i++) localData[catalog.MULTIVIEW_QUALITY_PREFIX + channelId(i)] = 720;
    const over = catalog.createBackup({ localData, extensionVersion: "1.4.4" });
    assert.deepEqual(over.omitted, ["multiviewQualities"], "the export reports the section it could not include");
    assert.equal(Object.hasOwn(over.backup.local, "multiviewQualities"), false, "no partial section is written");
    assert.deepEqual(over.backup.local.multiviewDelays, { [channelId(0)]: { version: 1, delaySeconds: 3 } });
    assert.equal(catalog.parseBackup(JSON.stringify(over.backup)).ok, true, "the rest of the file stays importable");

    const entries = (value) => Object.fromEntries([...Array(max + 1)].map((_, i) => [channelId(i), value]));
    assert.deepEqual(catalog.parseBackup(file({}, { multiviewQualities: entries(720) })), {
        ok: false,
        error: "invalid-multiviewQualities",
    });
    assert.deepEqual(catalog.parseBackup(file({}, { multiviewDelays: entries({ version: 1, delaySeconds: 3 }) })), {
        ok: false,
        error: "invalid-multiviewDelays",
    });
});

test("a file with both multiview sections at the bound still fits the size limit as the options page saves it", () => {
    const max = catalog.MAX_MULTIVIEW_CHANNELS;
    const localData = {
        [catalog.LIVE_START_CHANNELS_KEY]: [...Array(32)].map((_, i) => ({
            channelId: channelId(i),
            channelName: "가".repeat(100),
            channelImageUrl: `https://nng-phinf.pstatic.net/${"i".repeat(300)}.png`,
            notify: true,
            autoOpen: true,
        })),
        [catalog.CHAT_MULTIVIEW_KEY]: { version: 1, channels: [] },
    };
    for (let i = 0; i < max; i++) {
        // The longest JSON number a valid delay can have, and the largest quality.
        localData[catalog.MULTIVIEW_DELAY_PREFIX + channelId(i)] = {
            version: 2,
            basis: "live-edge-clock",
            delaySeconds: 1.2345678901234567e-100,
        };
        localData[catalog.MULTIVIEW_QUALITY_PREFIX + channelId(i)] = 8640;
    }
    const syncData = {
        ...settings.DEFAULT_OPTIONS,
        [catalog.PINS_KEY]: [...Array(64)].map((_, i) => String(i).padStart(100, "p")),
        [catalog.FOLDERS_KEY]: {
            version: 1,
            folders: [{ id: "f", name: "가".repeat(20), channelIds: [...Array(150)].map((_, i) => channelId(i)) }],
        },
    };
    const { backup, omitted } = catalog.createBackup({ syncData, localData, extensionVersion: "1.4.4" });
    assert.deepEqual(omitted, []);
    assert.equal(backup.local.liveStartChannels.length, 32);
    // optionsSettingsBackup.js downloads JSON with a 2-space indent and checks the file size before reading it.
    const text = JSON.stringify(backup, null, 2);
    const bytes = Buffer.byteLength(text);
    assert.ok(bytes <= catalog.MAX_FILE_BYTES, `${bytes} bytes`);
    const parsed = catalog.parseBackup(text);
    assert.equal(parsed.ok, true, parsed.error);
    assert.equal(Object.keys(parsed.backup.local.multiviewDelays).length, max);
    assert.equal(Object.keys(parsed.backup.local.multiviewQualities).length, max);
});

test("a file needs only the permissions of features it turns on, whatever else is on now", () => {
    const only = catalog.parseBackup(file({ options: { skipSeconds: 10 } }));
    const plan = catalog.planImport(
        { sync: { skipSeconds: 5, liveMultiviewEnabled: true, liveStartNotificationsEnabled: true } },
        only.backup
    );
    assert.deepEqual(plan.summary.permissions, { notifications: false, previewHosts: false });
    assert.deepEqual(plan.summary.permissionOptionKeys, []);
    const same = catalog.parseBackup(
        file({ options: { liveMultiviewEnabled: true, followingPreviewTooltipEnabled: false } })
    );
    assert.deepEqual(catalog.planImport({ sync: { liveMultiviewEnabled: true } }, same.backup).summary.permissions, {
        notifications: false,
        previewHosts: false,
    });
    const turnsOn = catalog.parseBackup(file({ options: { followingPreviewTooltipEnabled: true } }));
    const needed = catalog.planImport({ sync: { liveStartNotificationsEnabled: true } }, turnsOn.backup).summary;
    assert.deepEqual(needed.permissions, { notifications: false, previewHosts: true });
    assert.deepEqual(needed.permissionOptionKeys, ["followingPreviewTooltipEnabled"]);
});

test("keeping permission features off skips only what the file turns on and keeps current choices", async () => {
    const h = harness({
        sync: { followingPreviewTooltipEnabled: true, liveStartNotificationsEnabled: true, skipSeconds: 5 },
    });
    const backup = file({
        options: {
            followingPreviewTooltipEnabled: true,
            liveStartNotificationsEnabled: true,
            liveMultiviewEnabled: true,
            skipSeconds: 10,
        },
    });
    const preview = await h.send({ type: BACKUP, version: 1, action: "preview", backup }, optionsSender);
    assert.deepEqual(preview.summary.permissions, { notifications: false, previewHosts: true });
    assert.deepEqual(preview.summary.permissionOptionKeys, ["liveMultiviewEnabled"]);
    // Even a broader list than the options page sends cannot turn off a feature that is on now.
    const result = await h.send(
        {
            type: BACKUP,
            version: 1,
            action: "apply",
            backup,
            fingerprint: preview.fingerprint,
            disabledOptionKeys: [
                "followingPreviewTooltipEnabled",
                "liveStartNotificationsEnabled",
                "liveMultiviewEnabled",
            ],
        },
        optionsSender
    );
    assert.equal(result.result.status, "applied");
    assert.deepEqual(result.result.summary.keptOffOptionKeys, ["liveMultiviewEnabled"]);
    assert.deepEqual(result.result.summary.permissionOptionKeys, []);
    assert.equal(h.sync.followingPreviewTooltipEnabled, true);
    assert.equal(h.sync.liveStartNotificationsEnabled, true);
    assert.notEqual(h.sync.liveMultiviewEnabled, true);
    assert.equal(h.sync.skipSeconds, 10);
    assert.equal(
        h.calls.some(
            ([area, method, values]) =>
                area === "sync" &&
                method === "set" &&
                (Object.hasOwn(values, "followingPreviewTooltipEnabled") ||
                    Object.hasOwn(values, "liveStartNotificationsEnabled"))
        ),
        false,
        "features already on are never rewritten"
    );
    await settle();
});

test("a re-confirmation reports how many keys still change against the newer values", async () => {
    const h = harness({ sync: { skipSeconds: 5, ambientIntensity: 60 } });
    const backup = file({ options: { skipSeconds: 10, ambientIntensity: 30 } });
    const preview = await h.send({ type: BACKUP, version: 1, action: "preview", backup }, optionsSender);
    assert.equal(preview.changes, 2);
    await h.send(storeMessage("sync", { skipSeconds: 10 }), contentSender);
    const partly = await h.send(
        { type: BACKUP, version: 1, action: "apply", backup, fingerprint: preview.fingerprint },
        optionsSender
    );
    assert.equal(partly.result.status, "reconfirm");
    assert.equal(partly.result.changes, 1, "only the value another writer did not already set");
    await h.send(storeMessage("sync", { ambientIntensity: 30 }), contentSender);
    h.calls.length = 0;
    const none = await h.send(
        { type: BACKUP, version: 1, action: "apply", backup, fingerprint: partly.result.fingerprint },
        optionsSender
    );
    assert.equal(none.result.status, "reconfirm");
    assert.equal(none.result.changes, 0, "the same count a fresh preview would show");
    const fresh = await h.send({ type: BACKUP, version: 1, action: "preview", backup }, optionsSender);
    assert.equal(fresh.changes, none.result.changes);
    assert.equal(h.calls.filter(([, method]) => method === "set").length, 0);
});
