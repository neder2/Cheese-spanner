const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const ROOT = path.resolve(__dirname, "../..");
const STORAGE_KEY = "betterchzzkCategoryExclusionsV1";
const copy = (value) => structuredClone(value);

function createCategoryExclusionsStorage(initial = {}) {
    const local = copy(initial);
    const sync = { liveStartNotificationsEnabled: false, liveStartAutoOpenEnabled: false };
    const reads = [];
    const writes = [];
    const listeners = { messages: [], installed: [], startup: [], changed: [], alarms: [] };
    const failures = new Map();
    const pauses = new Map();
    let callbackError = null;
    let callbackOperation = null;
    const lastErrorReads = [];

    const event = (items) => ({
        addListener(listener) {
            items.push(listener);
        },
    });
    const runtime = {
        id: "category-test-extension",
        get lastError() {
            lastErrorReads.push({ operation: callbackOperation, error: Boolean(callbackError) });
            return callbackError;
        },
        getManifest: () => ({ version: "1.4.1" }),
        getURL: (file) => `chrome-extension://category-test-extension/${file}`,
        onMessage: event(listeners.messages),
        onInstalled: event(listeners.installed),
        onStartup: event(listeners.startup),
    };

    function complete(operation, error, callback, value) {
        callbackError = error;
        callbackOperation = operation;
        try {
            callback?.(value);
        } finally {
            callbackError = null;
            callbackOperation = null;
        }
    }

    function schedule(operation, keys, finish) {
        const key = Array.isArray(keys) ? keys.find((item) => pauses.has(`${operation}:${item}`)) : keys;
        const pauseKey = `${operation}:${key}`;
        const gate = pauses.get(pauseKey);
        if (gate) {
            pauses.delete(pauseKey);
            gate.pause(finish);
        } else queueMicrotask(finish);
    }

    function takeFailure(operation, keys) {
        const key = Array.isArray(keys) ? keys.find((item) => failures.has(`${operation}:${item}`)) : keys;
        const failureKey = `${operation}:${key}`;
        const failure = failures.get(failureKey);
        failures.delete(failureKey);
        if (failure?.kind === "throw") throw new Error(failure.message);
        return failure;
    }

    function storageArea(data, area) {
        return {
            get(keys, callback) {
                reads.push({ area, keys: copy(keys) });
                const failure = takeFailure("get", keys);
                const result = {};
                for (const key of typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(data))
                    if (Object.hasOwn(data, key)) result[key] = copy(data[key]);
                schedule("get", keys, () => complete("get", failure, callback, result));
            },
            set(values, callback) {
                const keys = Object.keys(values);
                const failure = takeFailure("set", keys);
                const snapshot = copy(values);
                schedule("set", keys, () => {
                    if (!failure) {
                        const changes = {};
                        for (const [key, newValue] of Object.entries(snapshot)) {
                            changes[key] = { oldValue: copy(data[key]), newValue: copy(newValue) };
                            data[key] = copy(newValue);
                        }
                        writes.push({ area, values: copy(snapshot) });
                        complete("set", null, callback);
                        for (const listener of listeners.changed) listener(changes, area);
                    } else complete("set", failure, callback);
                });
            },
            remove(keys, callback) {
                for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
                queueMicrotask(() => complete("remove", null, callback));
            },
        };
    }

    const chrome = {
        runtime,
        storage: {
            local: storageArea(local, "local"),
            sync: storageArea(sync, "sync"),
            onChanged: event(listeners.changed),
        },
        tabs: { onRemoved: event([]) },
        permissions: { contains: async () => false, onAdded: event([]), onRemoved: event([]) },
        alarms: {
            onAlarm: event(listeners.alarms),
            get: async () => undefined,
            clear: async () => true,
            create: async () => {},
        },
    };

    return {
        chrome,
        local,
        sync,
        listeners,
        lastErrorReads,
        get categoryReads() {
            return reads.filter((read) => read.area === "local" && read.keys === STORAGE_KEY);
        },
        get categoryWrites() {
            return writes
                .filter((write) => Object.hasOwn(write.values, STORAGE_KEY))
                .map((write) => copy(write.values));
        },
        get allWrites() {
            return copy(writes);
        },
        failNext(operation, kind = "callback", key = STORAGE_KEY) {
            failures.set(`${operation}:${key}`, {
                kind,
                message: "private response body and cookie must stay private",
            });
        },
        pauseNext(operation, key = STORAGE_KEY) {
            let release;
            let started;
            const gate = {
                started: new Promise((resolve) => {
                    started = resolve;
                }),
                pause(finish) {
                    release = finish;
                    started();
                },
                release() {
                    assert.equal(typeof release, "function", "the storage callback must be pending");
                    const finish = release;
                    release = null;
                    finish();
                },
            };
            pauses.set(`${operation}:${key}`, gate);
            return gate;
        },
    };
}

function loadCategoryExclusions(context = vm.createContext({ URL })) {
    const file = "shared/categoryExclusions.js";
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
    return context.BetterChzzk.categoryExclusions;
}

function createCategoryExclusionsWorker(storage = createCategoryExclusionsStorage()) {
    const context = vm.createContext({
        chrome: storage.chrome,
        console,
        URL,
        crypto: webcrypto,
        setTimeout,
        clearTimeout,
    });
    const imported = [];
    context.importScripts = (...files) => {
        for (const file of files) {
            imported.push(file);
            vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
        }
    };
    // Load the packaged worker and its actual listener; do not inject a substitute category route.
    vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), context, { filename: "background.js" });
    assert.ok(imported.includes("shared/categoryExclusions.js"), "the packaged worker must import category exclusions");
    return {
        imported,
        context,
        storage,
        ready: () => new Promise((resolve) => setImmediate(resolve)),
        send(message, sender) {
            return new Promise((resolve, reject) => {
                let handled = false;
                try {
                    for (const listener of storage.listeners.messages) {
                        const result = listener(message, sender, (response) => {
                            handled = true;
                            resolve(copy(response));
                        });
                        if (result === true) handled = true;
                    }
                    if (!handled) reject(new Error("The packaged background listener did not handle this request"));
                } catch (error) {
                    reject(error);
                }
            });
        },
    };
}

module.exports = { createCategoryExclusionsStorage, createCategoryExclusionsWorker, loadCategoryExclusions };
