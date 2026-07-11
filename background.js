/**
 * background.js — MV3 service worker. 옵션 정규화와 시청 기록 단일 writer를 담당한다.
 *
 * 하는 일: onInstalled에서 chrome.storage.sync 옵션을 스키마 기준으로 정규화한다. runtime 메시지로 받은
 *   시청 기록 mutation은 발신자·스키마를 검증한 뒤 Promise 큐에서 최신 local 값을 읽어 순차 반영한다.
 * 의존: shared/settings.js, shared/data.js, shared/watchHistoryStore.js(importScripts).
 */
importScripts("shared/settings.js", "shared/data.js", "shared/watchHistoryStore.js");

const { OPTION_KEYS, getStorageLastError, normalizeOptions } = BetterChzzkSettings;
const {
    MESSAGE_TYPE: WATCH_HISTORY_MESSAGE_TYPE,
    MESSAGE_VERSION: WATCH_HISTORY_MESSAGE_VERSION,
    STORAGE_KEY: WATCH_HISTORY_STORAGE_KEY,
    applyMutation: applyWatchHistoryMutation,
    normalizeMutation: normalizeWatchHistoryMutation,
} = globalThis.BetterChzzkWatchHistoryStore;
let watchHistoryMutationQueue = Promise.resolve();

function storageLocalGet(key) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(key, (data) => {
            const error = getStorageLastError();
            if (error) reject(error);
            else resolve(data || {});
        });
    });
}

function storageLocalSet(value) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set(value, () => {
            const error = getStorageLastError();
            if (error) reject(error);
            else resolve();
        });
    });
}

function isTrustedWatchHistorySender(operation, sender) {
    if (!sender || sender.id !== chrome.runtime.id || !sender.url) return false;

    let senderUrl;
    try {
        senderUrl = new URL(sender.url);
    } catch (_) {
        return false;
    }

    if (operation.kind === "upsertSessionSnapshot" || operation.kind === "migrateRecordId") {
        return Boolean(sender.tab) && senderUrl.protocol === "https:" && senderUrl.hostname === "chzzk.naver.com";
    }

    const historyUrl = new URL(chrome.runtime.getURL("history.html"));
    return senderUrl.origin === historyUrl.origin && senderUrl.pathname === historyUrl.pathname;
}

function enqueueWatchHistoryMutation(operation) {
    const task = watchHistoryMutationQueue.then(async () => {
        const data = await storageLocalGet(WATCH_HISTORY_STORAGE_KEY);
        const outcome = applyWatchHistoryMutation(data[WATCH_HISTORY_STORAGE_KEY], operation);
        if (outcome.changed) {
            await storageLocalSet({ [WATCH_HISTORY_STORAGE_KEY]: outcome.history });
        }
        return outcome.result;
    });
    watchHistoryMutationQueue = task.catch(() => {});
    return task;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== WATCH_HISTORY_MESSAGE_TYPE) return undefined;
    if (message.version !== WATCH_HISTORY_MESSAGE_VERSION) {
        sendResponse({ ok: false, error: "Unsupported watch history message version" });
        return false;
    }

    let operation;
    try {
        operation = normalizeWatchHistoryMutation(message.operation);
        if (!isTrustedWatchHistorySender(operation, sender)) throw new Error("Untrusted watch history sender");
    } catch (error) {
        sendResponse({ ok: false, error: error?.message || "Invalid watch history mutation" });
        return false;
    }

    enqueueWatchHistoryMutation(operation).then(
        (result) => sendResponse({ ok: true, result }),
        (error) => sendResponse({ ok: false, error: error?.message || "Watch history mutation failed" })
    );
    return true;
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.sync.get(OPTION_KEYS, (data) => {
        if (getStorageLastError()) return;

        const normalized = normalizeOptions(data);
        const updates = {};

        for (const key of OPTION_KEYS) {
            if (normalized[key] !== data[key]) updates[key] = normalized[key];
        }

        if (Object.keys(updates).length) {
            chrome.storage.sync.set(updates, () => {
                getStorageLastError();
            });
        }
    });
});
