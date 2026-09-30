const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.join(__dirname, "..", "..");
const TYPE = "betterchzzk:audio-compressor-state";

// This VM is a test-only Chrome transport. It loads the complete worker and its packaged imports.
function createAudioCompressorWorker(chrome) {
    let receive;
    let removeTab;
    let nextGetError;
    let nextSetError;
    let pausedGet;
    const startupListeners = [];
    const messages = [];
    const writes = [];
    const runtime = {
        id: chrome.runtime.id || "test-extension",
        lastError: null,
        onInstalled: { addListener() {} },
        onStartup: { addListener: (listener) => startupListeners.push(listener) },
        onMessage: {
            addListener(listener) {
                receive = listener;
            },
        },
    };
    chrome.runtime.id = runtime.id;
    const local = {
        ...chrome.storage.local,
        get(keys, callback) {
            const error = nextGetError;
            nextGetError = null;
            chrome.storage.local.get(keys, (data) => {
                const snapshot = structuredClone(data);
                const finish = () => {
                    runtime.lastError = error;
                    callback(snapshot);
                    runtime.lastError = null;
                };
                if (pausedGet) {
                    const gate = pausedGet;
                    pausedGet = null;
                    gate.pause(finish);
                } else finish();
            });
        },
        set(values, callback) {
            const error = nextSetError;
            nextSetError = null;
            if (error) {
                setTimeout(() => {
                    runtime.lastError = error;
                    callback();
                    runtime.lastError = null;
                }, 0);
                return;
            }
            const snapshot = structuredClone(values);
            chrome.storage.local.set(snapshot, () => {
                writes.push(snapshot);
                callback();
            });
        },
    };
    const workerChrome = {
        runtime,
        tabs: {
            onRemoved: {
                addListener(listener) {
                    removeTab = listener;
                },
            },
        },
        storage: { ...chrome.storage, local, onChanged: { addListener() {} } },
    };
    const context = vm.createContext({ chrome: workerChrome, console, URL, setTimeout, clearTimeout });
    context.importScripts = (...files) => {
        for (const file of files) vm.runInContext(fs.readFileSync(path.join(repoRoot, file), "utf8"), context);
    };
    // Source injection is only for reproducing a regression with the preserved pre-change worker.
    const sourcePath = process.env.BETTERCHZZK_AUDIO_COMPRESSOR_TEST_SOURCE || path.join(repoRoot, "background.js");
    vm.runInContext(fs.readFileSync(sourcePath, "utf8"), context);
    return {
        messages,
        writes,
        sendMessage(message, sender, callback) {
            assert.equal(message.type, TYPE);
            messages.push(structuredClone({ message, sender }));
            assert.equal(
                receive(message, sender, (response) => callback(structuredClone(response))),
                true
            );
        },
        closeTab: (tabId) => removeTab(tabId),
        startup: () => startupListeners.forEach((listener) => listener()),
        idle: () => vm.runInContext("compressorStateQueue", context),
        failNextGet: () => (nextGetError = { message: "test read failed" }),
        failNextSet: () => (nextSetError = { message: "test write failed" }),
        pauseNextGet() {
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
                    assert.equal(typeof release, "function");
                    release();
                },
            };
            pausedGet = gate;
            return gate;
        },
    };
}

module.exports = { createAudioCompressorWorker };
