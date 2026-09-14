/**
 * background.js — MV3 service worker. 옵션 정규화, 탭별 컴프레서 상태와 시청 기록 단일 writer를 담당한다.
 *
 * 하는 일: onInstalled에서 chrome.storage.sync 옵션을 스키마 기준으로 정규화한다. runtime 메시지로 받은
 *   시청 기록 mutation은 발신자·스키마를 검증한 뒤 Promise 큐에서 최신 local 값을 읽어 순차 반영한다.
 *   폐기한 설정·알림을 정리하고 1.3.7 방식 변경 안내를 한 번 전달한다.
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
const QUALITY_NOTICE_KEY = "betterchzzk:quality-update-notice";
const QUALITY_NOTICE_MESSAGE = "betterchzzk:quality-update-notice";
const QUALITY_NOTICE_VERSION = "1.3.7";
let qualityNoticeQueue = Promise.resolve();
let qualityNoticeClaimSeq = 0;
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
            ["betterchzzkUpdateNotice", "betterchzzkUpdateReadVersion", "betterChzzkOptionsGroupOpen:popup-updates"],
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

function enqueueQualityNotice(task) {
    const pending = qualityNoticeQueue.then(task);
    qualityNoticeQueue = pending.catch(() => {});
    return pending;
}

function isBeforeQualityNoticeVersion(version) {
    if (typeof version !== "string" || !/^\d+(?:\.\d+){2,3}$/.test(version)) return false;
    const parts = version.split(".").map(Number);
    const target = QUALITY_NOTICE_VERSION.split(".").map(Number);
    for (let index = 0; index < 4; index++) {
        const delta = (parts[index] || 0) - (target[index] || 0);
        if (delta) return delta < 0;
    }
    return false;
}

async function prepareQualityUpdateNotice(details) {
    if (
        details?.reason !== "update" ||
        chrome.runtime.getManifest().version !== QUALITY_NOTICE_VERSION ||
        !isBeforeQualityNoticeVersion(details.previousVersion)
    )
        return;
    await enqueueQualityNotice(async () => {
        const data = await storageLocalGet([QUALITY_NOTICE_KEY]);
        if (data[QUALITY_NOTICE_KEY]?.version === QUALITY_NOTICE_VERSION) return;
        await storageLocalSet({ [QUALITY_NOTICE_KEY]: { version: QUALITY_NOTICE_VERSION, pending: true } });
    });
    if (!chrome.tabs?.query || !chrome.scripting?.executeScript) return;
    const tabs = await chrome.tabs.query({ url: "https://chzzk.naver.com/*" });
    await Promise.allSettled(
        tabs
            .filter((tab) => Number.isInteger(tab.id))
            .map((tab) =>
                chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    world: "ISOLATED",
                    files: ["features/updateNotice.js"],
                })
            )
    );
}

function handleQualityUpdateNotice(message, sender) {
    if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0)
        return Promise.resolve({ show: false });
    try {
        if (new URL(sender.url).origin !== "https://chzzk.naver.com") return Promise.resolve({ show: false });
    } catch (_) {
        return Promise.resolve({ show: false });
    }
    return enqueueQualityNotice(async () => {
        const data = await storageLocalGet([QUALITY_NOTICE_KEY]);
        const notice = data[QUALITY_NOTICE_KEY];
        if (notice?.version !== QUALITY_NOTICE_VERSION) return { show: false };
        if (message.action === "release" && typeof message.token === "string" && message.token === notice.token) {
            await storageLocalSet({ [QUALITY_NOTICE_KEY]: { version: QUALITY_NOTICE_VERSION, pending: true } });
            return { show: false };
        }
        if (message.action !== "claim" || notice.pending !== true) return { show: false };
        const token = `${Date.now()}:${++qualityNoticeClaimSeq}`;
        await storageLocalSet({ [QUALITY_NOTICE_KEY]: { version: QUALITY_NOTICE_VERSION, pending: false, token } });
        return { show: true, version: QUALITY_NOTICE_VERSION, token };
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
    if (message?.type === QUALITY_NOTICE_MESSAGE) {
        handleQualityUpdateNotice(message, sender).then(
            (result) => sendResponse(result),
            () => sendResponse({ show: false })
        );
        return true;
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

chrome.runtime.onInstalled.addListener((details) => {
    reconcileAdVideoRegistration();
    clearLegacyUpdateNotice();
    prepareQualityUpdateNotice(details).catch((error) =>
        console.warn("[Better Chzzk] 방식 변경 안내 준비 실패", error)
    );
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
