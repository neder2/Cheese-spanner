const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

require("../../shared/data.js");
require("../../shared/watchHistoryStore.js");

const watchHistoryStore = globalThis.BetterChzzkWatchHistoryStore;
const repoRoot = path.join(__dirname, "../..");

function readRepoFile(...parts) {
    return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

function createStorageArea(initialData = {}) {
    const data = { ...initialData };

    return {
        data,
        get(keys, callback) {
            const result = {};
            if (Array.isArray(keys)) {
                for (const key of keys) {
                    if (Object.hasOwn(data, key)) result[key] = data[key];
                }
            } else if (typeof keys === "string") {
                if (Object.hasOwn(data, keys)) result[keys] = data[keys];
            } else if (keys && typeof keys === "object") {
                Object.assign(result, keys);
                for (const key of Object.keys(keys)) {
                    if (Object.hasOwn(data, key)) result[key] = data[key];
                }
            } else {
                Object.assign(result, data);
            }

            setTimeout(() => callback(result), 0);
        },
        set(values, callback) {
            Object.assign(data, values || {});
            setTimeout(() => callback?.(), 0);
        },
        remove(keys, callback) {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                delete data[key];
            }
            setTimeout(() => callback?.(), 0);
        },
    };
}

function createFakeChrome({ sync = {}, local = {}, permissionGranted = true } = {}) {
    const syncArea = createStorageArea(sync);
    const localArea = createStorageArea(local);
    const storageChangeListeners = [];
    const permissionRequests = [];
    const runtimeMessages = [];
    const runtime = {
        id: "better-chzzk",
        sendMessage(message, callback) {
            runtimeMessages.push(message);
            if (message?.type !== watchHistoryStore.MESSAGE_TYPE) {
                setTimeout(() => callback?.(), 0);
                return;
            }
            try {
                const current = localArea.data[watchHistoryStore.STORAGE_KEY];
                const outcome = watchHistoryStore.applyMutation(current, message.operation);
                if (outcome.changed) localArea.data[watchHistoryStore.STORAGE_KEY] = outcome.history;
                setTimeout(() => callback?.({ ok: true, result: outcome.result }), 0);
            } catch (error) {
                setTimeout(() => callback?.({ ok: false, error: error.message }), 0);
            }
        },
    };

    return {
        runtime,
        permissions: {
            request(spec, callback) {
                permissionRequests.push(spec);
                callback(permissionGranted);
            },
        },
        storage: {
            sync: syncArea,
            local: localArea,
            onChanged: {
                addListener(listener) {
                    storageChangeListeners.push(listener);
                },
                removeListener(listener) {
                    const index = storageChangeListeners.indexOf(listener);
                    if (index >= 0) storageChangeListeners.splice(index, 1);
                },
            },
        },
        testState: {
            sync: syncArea.data,
            local: localArea.data,
            storageChangeListeners,
            permissionRequests,
            runtimeMessages,
        },
    };
}

function createDom(htmlFile, urlPath, chrome) {
    const dom = new JSDOM(readRepoFile(htmlFile), {
        url: `chrome-extension://better-chzzk/${urlPath}`,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });

    dom.window.chrome = chrome;
    dom.window.confirm = () => true;
    dom.window.fetch = async () => {
        throw new Error("Unexpected network request in page test");
    };

    return dom;
}

function evalRepoScript(dom, ...parts) {
    dom.window.eval(readRepoFile(...parts));
}

function evalFeatureModules(dom, folder) {
    const manifest = JSON.parse(readRepoFile("manifest.json"));
    for (const entry of manifest.content_scripts) {
        if (entry.world === "MAIN") continue;
        for (const file of entry.js) {
            if (file.startsWith(`features/${folder}/`)) evalRepoScript(dom, ...file.split("/"));
        }
    }
}

function dispatch(dom, element, type) {
    element.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
}

function queryOption(document, key) {
    return document.querySelector(`[data-option="${key}"]`);
}

function waitForAsyncCallbacks() {
    return new Promise((resolve) => setTimeout(resolve, 20));
}

async function waitForCondition(predicate, { timeoutMs = 1000, intervalMs = 20 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    assert.fail("Timed out waiting for condition");
}

module.exports = {
    readRepoFile,
    createFakeChrome,
    createDom,
    evalRepoScript,
    evalFeatureModules,
    dispatch,
    queryOption,
    waitForAsyncCallbacks,
    waitForCondition,
};
