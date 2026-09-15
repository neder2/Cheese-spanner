/**
 * background.js — MV3 service worker. 옵션 정규화, 탭별 컴프레서 상태와 시청 기록 단일 writer를 담당한다.
 *
 * 하는 일: onInstalled에서 chrome.storage.sync 옵션을 스키마 기준으로 정규화한다. runtime 메시지로 받은
 *   시청 기록 mutation은 발신자·스키마를 검증한 뒤 Promise 큐에서 최신 local 값을 읽어 순차 반영한다.
 *   폐기한 설정·알림과 1.3.7 방식 변경 안내의 저장값을 정리한다.
 *   컴프레서 상태는 발신 탭 ID별로 저장하고 탭 종료·브라우저 시작 시 정리한다.
 * 의존: shared/settings.js, shared/data.js, shared/watchHistoryStore.js,
 *   shared/adVideoRegistration.js(importScripts).
 */
importScripts("shared/settings.js", "shared/data.js", "shared/watchHistoryStore.js", "shared/adVideoRegistration.js");

const { OPTION_KEYS, getStorageLastError, normalizeOptions } = BetterChzzkSettings;
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
const MAX_COMPRESSOR_TABS = 128;
let compressorStateQueue = Promise.resolve();
const RETIRED_QUALITY_NOTICE_KEY = "betterchzzk:quality-update-notice";
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
        const data = await storageLocalGet(COMPRESSOR_TABS_KEY);
        const states = Array.isArray(data[COMPRESSOR_TABS_KEY]) ? data[COMPRESSOR_TABS_KEY] : [];
        return task(states.slice(-MAX_COMPRESSOR_TABS));
    });
    compressorStateQueue = pending.catch(() => {});
    return pending;
}

function isCompressorState(state) {
    return (
        typeof state?.active === "boolean" && Number.isFinite(state.volume) && state.volume >= 0 && state.volume <= 1
    );
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
    return enqueueCompressorState(async (states) => {
        if (message.kind === "get") {
            const saved = states.find((state) => state?.tabId === sender.tab.id && isCompressorState(state));
            return saved ? { active: saved.active, volume: saved.volume } : { active: false, volume: 1 };
        }
        const state = { active: message.state.active, volume: Math.round(message.state.volume * 100) / 100 };
        const next = states.filter((saved) => saved?.tabId !== sender.tab.id && isCompressorState(saved));
        next.push({ tabId: sender.tab.id, ...state });
        await storageLocalSet({ [COMPRESSOR_TABS_KEY]: next.slice(-MAX_COMPRESSOR_TABS) });
        return state;
    });
}

chrome.tabs?.onRemoved?.addListener((tabId) => {
    void enqueueCompressorState(async (states) => {
        const next = states.filter((state) => state?.tabId !== tabId);
        if (next.length !== states.length) await storageLocalSet({ [COMPRESSOR_TABS_KEY]: next });
    }).catch(() => {});
});
chrome.runtime.onStartup?.addListener(() => {
    // Tab IDs belong to one browser session; never apply old IDs after a restart.
    void enqueueCompressorState(() => storageLocalSet({ [COMPRESSOR_TABS_KEY]: [] })).catch(() => {});
});

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
        if (sender?.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("options.html")) {
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

chrome.runtime.onInstalled.addListener(() => {
    reconcileAdVideoRegistration();
    clearLegacyUpdateNotice();
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
