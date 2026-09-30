/**
 * background.js — MV3 service worker. 옵션 정규화, 컴프레서 기본·탭별 선택과 시청 기록 단일 writer를 담당한다.
 *
 * 하는 일: onInstalled에서 chrome.storage.sync 옵션을 스키마 기준으로 정규화한다. runtime 메시지로 받은
 *   시청 기록 mutation은 발신자·스키마를 검증한 뒤 Promise 큐에서 최신 local 값을 읽어 순차 반영한다.
 *   폐기한 설정·알림과 1.3.7 방식 변경 안내의 저장값을 정리한다.
 *   컴프레서 기본 선택은 계속 보관하고, 탭별 스냅샷은 탭 종료·브라우저 시작 시 정리한다.
 *   방송 시작 알림·자동 열기는 shared/liveStartMonitor.js의 독립 큐와 alarm으로 처리한다.
 *   과거 후원 가져오기는 history 페이지의 요청으로 조회하고, 같은 시청 기록 writer 큐에 월별 스냅샷을 저장한다.
 * 의존: shared/settings.js, shared/data.js, shared/watchHistoryStore.js,
 *   shared/adVideoRegistration.js, shared/liveStart.js, shared/liveStartMonitor.js,
 *   shared/donationHistory.js, shared/donationHistoryImport.js(importScripts).
 */
importScripts(
    "shared/settings.js",
    "shared/updateGuide.js",
    "shared/updateGuideController.js",
    "shared/data.js",
    "shared/donationHistory.js",
    "shared/watchHistoryStore.js",
    "shared/watchHistoryBackup.js",
    "shared/watchHistoryBackupMerge.js",
    "shared/watchHistoryBackupController.js",
    "shared/adVideoRegistration.js"
);
importScripts("shared/liveStart.js", "shared/liveStartMonitor.js");
importScripts("shared/donationHistoryImport.js");

const { OPTION_KEYS, getStorageLastError, normalizeOptions, withOptionsStorageLock } = BetterChzzkSettings;
const {
    MESSAGE_TYPE: WATCH_HISTORY_MESSAGE_TYPE,
    MESSAGE_VERSION: WATCH_HISTORY_MESSAGE_VERSION,
    STORAGE_KEY: WATCH_HISTORY_STORAGE_KEY,
    applyMutation: applyWatchHistoryMutation,
    normalizeMutation: normalizeWatchHistoryMutation,
} = globalThis.BetterChzzkWatchHistoryStore;
let watchHistoryMutationQueue = Promise.resolve();
const COMPRESSOR_STATE_MESSAGE = "betterchzzk:audio-compressor-state";
const COMPRESSOR_TABS_KEY = "betterchzzk:audio-compressor-tabs";
const COMPRESSOR_PREFERENCE_KEY = "betterchzzk:audio-compressor-preference";
const COMPRESSOR_CLEANUP_KEY = "betterchzzk:audio-compressor-cleanup-pending";
const MAX_COMPRESSOR_TABS = 128;
let compressorStateQueue = Promise.resolve();
let compressorStartupPending = false;
let compressorSessionGeneration = 0;
let compressorSessionLoaded = false;
let compressorSessionCleanupStored = false;
let compressorStartupGuardPending = false;
const RETIRED_QUALITY_NOTICE_KEY = "betterchzzk:quality-update-notice";
const updateGuide = globalThis.BetterChzzkUpdateGuideController.createController({
    chrome,
    catalog: globalThis.BetterChzzkUpdateGuide,
});
const adVideoRegistration = chrome.scripting?.getRegisteredContentScripts
    ? globalThis.BetterChzzkAdVideoRegistration.createController({
          scripting: chrome.scripting,
          async readEnabled() {
              return normalizeOptions(await BetterChzzk.utils.storageGet(chrome.storage.sync, "adVideoEnabled"))
                  .adVideoEnabled;
          },
      })
    : null;

function reconcileAdVideoRegistration() {
    if (!adVideoRegistration) return;
    adVideoRegistration.reconcile().catch((error) => {
        console.warn("[Better Chzzk] 동영상 광고 차단 등록 실패", error);
    });
}

function clearLegacyUpdateNotice() {
    for (const [area, keys] of [
        [
            chrome.storage.local,
            [
                "betterchzzkUpdateNotice",
                "betterchzzkUpdateReadVersion",
                "betterChzzkOptionsGroupOpen:popup-updates",
                RETIRED_QUALITY_NOTICE_KEY,
            ],
        ],
        [chrome.storage.sync, ["updateNotificationsEnabled", "gridBypassEnabled", "autoQualityDismissInstallGuide"]],
    ]) {
        area.remove?.(keys, () => {
            getStorageLastError();
        });
    }
    if (chrome.action) {
        Promise.all([
            chrome.action.setBadgeText({ text: "" }),
            chrome.action.setTitle({ title: "치즈 스패너 설정" }),
        ]).catch((error) => console.warn("[BetterChzzk] 이전 알림 배지 정리 실패", error));
    }
}

chrome.storage.onChanged?.addListener((changes, area) => {
    void updateGuide.onOptionsChanged(changes, area);
    if (area === "sync" && Object.hasOwn(changes, "adVideoEnabled")) reconcileAdVideoRegistration();
});
clearLegacyUpdateNotice();
reconcileAdVideoRegistration();
chrome.runtime.onStartup?.addListener(reconcileAdVideoRegistration);

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

function enqueueCompressorState(task) {
    const pending = compressorStateQueue.then(async () => {
        for (;;) {
            const generation = compressorSessionGeneration;
            await prepareCompressorSession();
            if (generation !== compressorSessionGeneration) continue;
            const data = await storageLocalGet([
                COMPRESSOR_TABS_KEY,
                COMPRESSOR_PREFERENCE_KEY,
                COMPRESSOR_CLEANUP_KEY,
            ]);
            // Startup can arrive while an earlier storage callback is still pending.
            if (generation !== compressorSessionGeneration) continue;
            const storedStates = normalizeCompressorTabs(data[COMPRESSOR_TABS_KEY]);
            const initializePreference = !isCompressorState(data[COMPRESSOR_PREFERENCE_KEY]);
            const source = initializePreference ? storedStates.at(-1) : data[COMPRESSOR_PREFERENCE_KEY];
            const preference = source ? { active: source.active, volume: source.volume } : { active: false, volume: 1 };
            if (data[COMPRESSOR_CLEANUP_KEY] === true) compressorStartupPending = true;
            if (compressorStartupPending) {
                if (hasCompressorSessionStorage() && !compressorSessionCleanupStored) {
                    await storeCompressorStartupGuard();
                    if (generation !== compressorSessionGeneration) continue;
                }
                // Preserve the legacy choice in the same write that retires old session IDs.
                const cleanup = { [COMPRESSOR_TABS_KEY]: [] };
                if (initializePreference) cleanup[COMPRESSOR_PREFERENCE_KEY] = preference;
                if (data[COMPRESSOR_CLEANUP_KEY] === true) cleanup[COMPRESSOR_CLEANUP_KEY] = false;
                await storageLocalSet(cleanup);
                if (generation !== compressorSessionGeneration) continue;
                if (hasCompressorSessionStorage()) {
                    await storageCompressorSession("set", false);
                    if (generation !== compressorSessionGeneration) continue;
                }
                // Accept new snapshots only after both cleanup and its guard release succeed.
                compressorStartupPending = false;
                compressorSessionCleanupStored = false;
                continue;
            }
            const { result, updates = {} } = task(storedStates, preference, initializePreference);
            if (Object.keys(updates).length) await storageLocalSet(updates);
            if (generation !== compressorSessionGeneration) continue;
            return result;
        }
    });
    compressorStateQueue = pending.catch(() => {});
    return pending;
}

function hasCompressorSessionStorage() {
    return typeof chrome.storage.session?.get === "function" && typeof chrome.storage.session?.set === "function";
}

function storageCompressorSession(kind, pending) {
    return new Promise((resolve, reject) => {
        const value = kind === "get" ? COMPRESSOR_CLEANUP_KEY : { [COMPRESSOR_CLEANUP_KEY]: pending };
        chrome.storage.session[kind](value, (data) => {
            const error = getStorageLastError();
            if (error) reject(error);
            else resolve(data || {});
        });
    });
}

async function storeCompressorStartupGuard() {
    if (hasCompressorSessionStorage()) {
        try {
            await storageCompressorSession("set", true);
            compressorSessionCleanupStored = true;
        } catch (error) {
            // Keep the startup signal across worker restarts even when session storage fails.
            await storageLocalSet({ [COMPRESSOR_CLEANUP_KEY]: true });
            throw error;
        }
    } else {
        await storageLocalSet({ [COMPRESSOR_CLEANUP_KEY]: true });
    }
    compressorStartupGuardPending = false;
    compressorSessionLoaded = true;
}

async function prepareCompressorSession() {
    if (compressorStartupGuardPending) await storeCompressorStartupGuard();
    if (compressorSessionLoaded) return;
    if (hasCompressorSessionStorage()) {
        const data = await storageCompressorSession("get");
        compressorSessionCleanupStored = data[COMPRESSOR_CLEANUP_KEY] === true;
        if (compressorSessionCleanupStored) compressorStartupPending = true;
    }
    // A missing session marker also occurs on extension reload/update; it does not retire tabs.
    compressorSessionLoaded = true;
}

function isCompressorState(state) {
    return (
        typeof state?.active === "boolean" && Number.isFinite(state.volume) && state.volume >= 0 && state.volume <= 1
    );
}

function normalizeCompressorTabs(value) {
    const source = Array.isArray(value) ? value : [];
    const states = [];
    const seen = new Set();
    for (let index = source.length - 1; index >= 0 && states.length < MAX_COMPRESSOR_TABS; index--) {
        const state = source[index];
        if (!Number.isInteger(state?.tabId) || state.tabId < 0 || !isCompressorState(state) || seen.has(state.tabId)) {
            continue;
        }
        seen.add(state.tabId);
        states.unshift({ tabId: state.tabId, active: state.active, volume: state.volume });
    }
    return states;
}

function handleCompressorState(message, sender) {
    if (
        sender?.id !== chrome.runtime.id ||
        !Number.isInteger(sender.tab?.id) ||
        sender.tab.id < 0 ||
        sender.frameId !== 0
    ) {
        return Promise.reject(new Error("Untrusted compressor sender"));
    }
    try {
        if (new URL(sender.url).origin !== "https://chzzk.naver.com") throw new Error();
    } catch (_) {
        return Promise.reject(new Error("Untrusted compressor sender"));
    }
    if (message.kind !== "get" && (message.kind !== "set" || !isCompressorState(message.state))) {
        return Promise.reject(new Error("Invalid compressor state"));
    }
    return enqueueCompressorState((states, preference, initializePreference) => {
        if (message.kind === "get") {
            const saved = states.find((state) => state.tabId === sender.tab.id);
            const state = saved ? { active: saved.active, volume: saved.volume } : preference;
            const updates = {};
            if (!saved || initializePreference) {
                const next = saved ? states : [...states, { tabId: sender.tab.id, ...state }];
                updates[COMPRESSOR_TABS_KEY] = next.slice(-MAX_COMPRESSOR_TABS);
            }
            if (initializePreference) updates[COMPRESSOR_PREFERENCE_KEY] = preference;
            return { result: state, updates };
        }
        const state = { active: message.state.active, volume: Math.round(message.state.volume * 100) / 100 };
        const next = states.filter((saved) => saved.tabId !== sender.tab.id);
        next.push({ tabId: sender.tab.id, ...state });
        return {
            result: state,
            updates: {
                [COMPRESSOR_TABS_KEY]: next.slice(-MAX_COMPRESSOR_TABS),
                [COMPRESSOR_PREFERENCE_KEY]: state,
            },
        };
    });
}

chrome.tabs?.onRemoved?.addListener((tabId) => {
    void enqueueCompressorState((states) => {
        const next = states.filter((state) => state.tabId !== tabId);
        return { updates: next.length !== states.length ? { [COMPRESSOR_TABS_KEY]: next } : {} };
    }).catch(() => {});
});
chrome.runtime.onStartup?.addListener(() => {
    // Tab IDs belong to one browser session; never apply old IDs after a restart.
    compressorStartupPending = true;
    compressorStartupGuardPending = true;
    compressorSessionGeneration++;
    void enqueueCompressorState(() => ({})).catch(() => {});
});

function isTrustedWatchHistorySender(operation, sender) {
    if (!sender || sender.id !== chrome.runtime.id || !sender.url) return false;
    // API snapshots are committed only by the background importer after all pages and identity checks succeed.
    if (operation.kind === "replaceDonationMonths") return false;

    let senderUrl;
    try {
        senderUrl = new URL(sender.url);
    } catch (_) {
        return false;
    }

    if (
        operation.kind === "upsertSessionSnapshot" ||
        operation.kind === "appendActivities" ||
        operation.kind === "migrateRecordId"
    ) {
        return Boolean(sender.tab) && senderUrl.protocol === "https:" && senderUrl.hostname === "chzzk.naver.com";
    }

    const historyUrl = new URL(chrome.runtime.getURL("history.html"));
    return (
        senderUrl.protocol === historyUrl.protocol &&
        senderUrl.hostname === historyUrl.hostname &&
        senderUrl.pathname === historyUrl.pathname &&
        !senderUrl.username &&
        !senderUrl.password &&
        !senderUrl.port
    );
}

function enqueueWatchHistoryTask(work) {
    const task = watchHistoryMutationQueue.then(work);
    watchHistoryMutationQueue = task.catch(() => {});
    return task;
}

function enqueueWatchHistoryMutation(operation) {
    return enqueueWatchHistoryTask(async () => {
        const data = await storageLocalGet(WATCH_HISTORY_STORAGE_KEY);
        const outcome = applyWatchHistoryMutation(data[WATCH_HISTORY_STORAGE_KEY], operation);
        if (outcome.changed) {
            await storageLocalSet({ [WATCH_HISTORY_STORAGE_KEY]: outcome.history });
        }
        return outcome.result;
    });
}

const watchHistoryBackup = globalThis.BetterChzzkWatchHistoryBackupController.createController({
    runtime: chrome.runtime,
    enqueue: enqueueWatchHistoryTask,
    readHistory: async () => (await storageLocalGet(WATCH_HISTORY_STORAGE_KEY))[WATCH_HISTORY_STORAGE_KEY],
    writeHistory: (history) => storageLocalSet({ [WATCH_HISTORY_STORAGE_KEY]: history }),
    maxStorageBytes: chrome.storage.local.QUOTA_BYTES,
});

globalThis.BetterChzzkDonationHistoryImport.install({
    chrome,
    readHistory: async () => (await storageLocalGet(WATCH_HISTORY_STORAGE_KEY))[WATCH_HISTORY_STORAGE_KEY],
    writeHistory: enqueueWatchHistoryMutation,
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === globalThis.BetterChzzkUpdateGuide.MESSAGE_TYPE) {
        updateGuide.handleMessage(message, sender).then(sendResponse);
        return true;
    }
    if (message?.type === globalThis.BetterChzzkWatchHistoryBackupController.MESSAGE_TYPE) {
        watchHistoryBackup.handle(message, sender).then(sendResponse);
        return true;
    }
    if (message?.type === RETIRED_QUALITY_NOTICE_KEY) {
        // 새로고침하지 않은 이전 탭의 공지 요청도 표시·재예약하지 않는다.
        sendResponse({ show: false });
        return false;
    }
    if (message?.type === COMPRESSOR_STATE_MESSAGE) {
        handleCompressorState(message, sender).then(
            (state) => sendResponse({ ok: true, state }),
            (error) => sendResponse({ ok: false, error: error.message })
        );
        return true;
    }
    if (message?.type === "betterchzzk:ad-video:sync") {
        if (!BetterChzzkSettings.isOptionsPageSender(sender)) {
            sendResponse({ ok: false });
            return false;
        }
        if (!adVideoRegistration) {
            sendResponse({ ok: false });
            return false;
        }
        adVideoRegistration.reconcile().then(
            ({ enabled }) => sendResponse({ ok: true, enabled }),
            () => sendResponse({ ok: false })
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
    void updateGuide.onInstalled(details);
    reconcileAdVideoRegistration();
    clearLegacyUpdateNotice();
    void withOptionsStorageLock(
        () =>
            new Promise((resolve) => {
                chrome.storage.sync.get(OPTION_KEYS, (data) => {
                    if (getStorageLastError()) {
                        resolve();
                        return;
                    }

                    const raw = data || {};
                    const normalized = normalizeOptions(raw);
                    if (details?.reason === "update" && !Object.hasOwn(raw, "globalLiveCountEnabled")) {
                        normalized.globalLiveCountEnabled = normalized.categoryToolsEnabled;
                    }
                    const updates = {};
                    for (const key of OPTION_KEYS) {
                        if (normalized[key] !== raw[key]) updates[key] = normalized[key];
                    }

                    if (!Object.keys(updates).length) {
                        resolve();
                        return;
                    }
                    chrome.storage.sync.set(updates, () => {
                        getStorageLastError();
                        resolve();
                    });
                });
            })
    ).catch((error) => console.warn("[BetterChzzk] 옵션 초기화 실패", error));
});
