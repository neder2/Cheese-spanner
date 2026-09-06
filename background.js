/**
 * background.js — MV3 service worker. 옵션 정규화와 시청 기록 단일 writer를 담당한다.
 *
 * 하는 일: onInstalled에서 chrome.storage.sync 옵션을 스키마 기준으로 정규화한다. runtime 메시지로 받은
 *   시청 기록 mutation은 발신자·스키마를 검증한 뒤 Promise 큐에서 최신 local 값을 읽어 순차 반영한다.
 *   버전 업데이트의 미확인 안내를 로컬에 저장하고 확장 아이콘의 NEW 배지를 동기화한다.
 * 의존: shared/settings.js, shared/data.js, shared/watchHistoryStore.js, shared/updateGuide.js(importScripts).
 */
importScripts("shared/settings.js", "shared/data.js", "shared/watchHistoryStore.js", "shared/updateGuide.js");

const { OPTION_KEYS, getStorageLastError, normalizeOptions } = BetterChzzkSettings;
const {
    MESSAGE_TYPE: WATCH_HISTORY_MESSAGE_TYPE,
    MESSAGE_VERSION: WATCH_HISTORY_MESSAGE_VERSION,
    STORAGE_KEY: WATCH_HISTORY_STORAGE_KEY,
    applyMutation: applyWatchHistoryMutation,
    normalizeMutation: normalizeWatchHistoryMutation,
} = globalThis.BetterChzzkWatchHistoryStore;
let watchHistoryMutationQueue = Promise.resolve();
const { UPDATE_KEY, READ_KEY, NOTIFICATIONS_KEY } = globalThis.BetterChzzkUpdateGuide;
let updateNoticeQueue = Promise.resolve();

async function refreshUpdateBadge() {
    if (!chrome.action) return;
    const [data, options] = await Promise.all([
        storageLocalGet([UPDATE_KEY, READ_KEY]),
        BetterChzzk.utils.storageGet(chrome.storage.sync, NOTIFICATIONS_KEY),
    ]);
    const version = chrome.runtime.getManifest().version;
    const unread =
        options[NOTIFICATIONS_KEY] !== false && data[UPDATE_KEY]?.version === version && data[READ_KEY] !== version;
    await chrome.action.setBadgeBackgroundColor({ color: "#087a4b" });
    await chrome.action.setBadgeText({ text: unread ? "NEW" : "" });
    await chrome.action.setTitle({
        title: unread ? `Better Chzzk ${version} 업데이트 · 새 기능 안내` : "Better Chzzk 설정",
    });
}

function enqueueUpdateNotice(task = refreshUpdateBadge) {
    updateNoticeQueue = updateNoticeQueue.then(task).catch((error) => {
        console.warn("[Better Chzzk] 업데이트 안내 상태 처리 실패", error);
    });
}

chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === "sync" && Object.hasOwn(changes, NOTIFICATIONS_KEY)) enqueueUpdateNotice();
    if (area === "local" && (Object.hasOwn(changes, UPDATE_KEY) || Object.hasOwn(changes, READ_KEY))) {
        enqueueUpdateNotice();
    }
});
enqueueUpdateNotice();

function injectUpdateNotice(tabId) {
    return globalThis.BetterChzzkUpdateGuide.injectNotice(tabId);
}

async function previewUpdateNotice() {
    return globalThis.BetterChzzkUpdateGuide.previewInChzzkTab();
}

async function showUpdateInOpenTabs() {
    const options = await BetterChzzk.utils.storageGet(chrome.storage.sync, NOTIFICATIONS_KEY);
    if (options[NOTIFICATIONS_KEY] === false) return;
    const tabs = await chrome.tabs.query({ url: "https://chzzk.naver.com/*" });
    await Promise.all(
        tabs
            .filter(
                (tab) =>
                    Number.isInteger(tab.id) && !tab.discarded && /^https:\/\/chzzk\.naver\.com\//.test(tab.url || "")
            )
            .map(async (tab) => {
                try {
                    await injectUpdateNotice(tab.id);
                } catch (error) {
                    // A tab can navigate or close between the query and injection.
                    console.warn("[Better Chzzk] 열린 탭 업데이트 안내 표시 실패", error);
                }
            })
    );
}

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
    if (message?.type === "betterchzzk:update:preview") {
        if (sender?.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("options.html")) {
            sendResponse({ ok: false });
            return false;
        }
        previewUpdateNotice().then(sendResponse, () =>
            sendResponse({ ok: false, error: "알림을 표시하지 못했어요. 확장을 다시 로드한 뒤 시도해 주세요." })
        );
        return true;
    }
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

chrome.runtime.onInstalled.addListener((details) => {
    const version = chrome.runtime.getManifest?.()?.version;
    if (details?.reason === "update" && details.previousVersion && version && details.previousVersion !== version) {
        enqueueUpdateNotice(async () => {
            await storageLocalSet({ [UPDATE_KEY]: { version, previousVersion: details.previousVersion } });
            await refreshUpdateBadge();
            await showUpdateInOpenTabs();
        });
    }
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
