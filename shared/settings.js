/**
 * shared/settings.js — 옵션 단일 공급원 (globalThis.BetterChzzkSettings)
 *
 * 실행 컨텍스트: isolated world 콘텐츠 스크립트 + service worker(background.js의 importScripts) +
 *   확장 페이지(options.html, history.html). 그래서 window/document 같은 DOM API를 쓰면 안 되고
 *   globalThis/chrome만 쓴다.
 * 하는 일: OPTION_SCHEMA(키별 kind/default/min/max/feature 플래그)에서 DEFAULT_OPTIONS, OPTION_KEYS,
 *   FEATURE_KEYS를 파생하고, chrome.storage.sync 기반 옵션 로드·정규화·변경 구독을 제공한다.
 *   새 옵션은 OPTION_SCHEMA에 항목 하나를 추가하면 기본값·정규화·변경 알림이 함께 따라온다.
 * 공개 API: normalizeOptions, getOptions(callback), addOptionsChangeListener(callback),
 *   getStorageLastError, normalizeSkipSeconds, 각종 min/max 상수.
 *   background.js, options.js, 모든 feature가 의존하므로 키 이름과 시그니처를 바꾸지 말 것.
 * 통신: chrome.storage.sync(옵션 저장소), chrome.storage.onChanged 구독.
 */
(() => {
    const DEFAULT_QUALITY = "1080p";
    const DEFAULT_SKIP_SECONDS = 5;
    const SKIP_MIN = 1;
    const SKIP_MAX = 600;
    const MONTHLY_CALENDAR_MIN_PAGES = 1;
    const MONTHLY_CALENDAR_MAX_PAGES = 300;
    const FILTER_PRESET_MIN = 1;
    const FILTER_PRESET_MAX = 10000000;
    const DURATION_FILTER_PRESET_MIN = 1;
    const DURATION_FILTER_PRESET_MAX = 168;
    const LIVE_WATCH_HISTORY_MIN_MINUTES_MIN = 1;
    const LIVE_WATCH_HISTORY_MIN_MINUTES_MAX = 1440;
    const CHAT_TOOLS_MIN_MODERATOR_MESSAGES = 20;
    const CHAT_TOOLS_MAX_MODERATOR_MESSAGES = 200;
    const LEGACY_CHAT_TOOLS_ENABLED_KEY = "chatToolsEnabled";

    const OPTION_SCHEMA = Object.freeze({
        autoQualityEnabled: { kind: "bool", default: true, feature: true },
        rewardAutoCollectEnabled: { kind: "bool", default: true, feature: true },
        skipControlEnabled: { kind: "bool", default: true, feature: true },
        skipKeyboardEnabled: { kind: "bool", default: true },
        skipPillEnabled: { kind: "bool", default: true },
        skipLivePillEnabled: { kind: "bool", default: true },
        skipLivePauseResumeEnabled: { kind: "bool", default: true },
        skipSeconds: { kind: "skipSeconds", default: DEFAULT_SKIP_SECONDS },
        skipWheelStep: { kind: "int", default: 1, min: 1, max: 60 },
        skipWheelShiftStep: { kind: "int", default: 5, min: 1, max: 300 },
        skipWheelAltStep: { kind: "int", default: 10, min: 1, max: 600 },
        volumeWheelEnabled: { kind: "bool", default: true, feature: true },
        volumeWheelStep: { kind: "int", default: 5, min: 1, max: 50 },
        volumeTooltipEnabled: { kind: "bool", default: false, feature: true },
        audioCompressorEnabled: { kind: "bool", default: false, feature: true },
        audioCompressorThreshold: { kind: "number", default: -24, min: -60, max: 0, step: 1 },
        audioCompressorKnee: { kind: "number", default: 30, min: 0, max: 40, step: 1 },
        audioCompressorRatio: { kind: "number", default: 12, min: 1, max: 20, step: 0.1 },
        audioCompressorAttack: { kind: "number", default: 0.003, min: 0, max: 1, step: 0.001 },
        audioCompressorRelease: { kind: "number", default: 0.25, min: 0, max: 1, step: 0.01 },
        audioCompressorMakeupGain: { kind: "number", default: 1, min: 0.5, max: 3, step: 0.1 },
        vodBroadcastClockEnabled: { kind: "bool", default: true, feature: true },
        timeMachineLagLabelEnabled: { kind: "bool", default: true, feature: true },
        adblockPopupEnabled: { kind: "bool", default: true, feature: true },
        monthlyBroadcastTimeEnabled: { kind: "bool", default: true, feature: true },
        monthlyBroadcastTimeWindowDays: { kind: "int", default: 30, min: 1, max: 365 },
        monthlyBroadcastTimeMaxPages: { kind: "int", default: 12, min: 1, max: 200 },
        monthlyBroadcastTimeCalendarEnabled: { kind: "bool", default: true },
        monthlyBroadcastTimeWatchEnabled: { kind: "bool", default: false },
        monthlyBroadcastTimeMaxCalendarPages: {
            kind: "int",
            default: 60,
            min: MONTHLY_CALENDAR_MIN_PAGES,
            max: MONTHLY_CALENDAR_MAX_PAGES,
        },
        liveWatchHistoryEnabled: { kind: "bool", default: true, feature: true },
        liveWatchHistoryMinMinutes: {
            kind: "int",
            default: 1,
            min: LIVE_WATCH_HISTORY_MIN_MINUTES_MIN,
            max: LIVE_WATCH_HISTORY_MIN_MINUTES_MAX,
        },
        vodCommentTabsEnabled: { kind: "bool", default: true, feature: true },
        chatTimestampEnabled: { kind: "bool", default: false, feature: true },
        chatWelcomeMessageRemovalEnabled: { kind: "bool", default: false, feature: true },
        chatToolsShowBlindEnabled: { kind: "bool", default: false, feature: true },
        chatToolsModeratorBoxEnabled: { kind: "bool", default: false, feature: true },
        chatToolsMaxModeratorMessages: {
            kind: "int",
            default: 100,
            min: CHAT_TOOLS_MIN_MODERATOR_MESSAGES,
            max: CHAT_TOOLS_MAX_MODERATOR_MESSAGES,
        },
        videoSearchEnabled: { kind: "bool", default: true, feature: true },
        videoSearchCommentEnabled: { kind: "bool", default: true },
        videoSearchMaxPages: { kind: "int", default: 80, min: 1, max: 200 },
        videoSearchRenderBatchSize: { kind: "int", default: 80, min: 10, max: 300 },
        videoSearchCommentDelayMs: { kind: "int", default: 1000, min: 0, max: 5000 },
        videoSearchCommentMaxVideos: { kind: "int", default: 60, min: 1, max: 200 },
        videoSearchCommentMaxPagesPerVideo: { kind: "int", default: 1, min: 1, max: 3 },
        categoryToolsEnabled: { kind: "bool", default: true, feature: true },
        titleTooltipEnabled: { kind: "bool", default: true, feature: true },
        categoryToolsMaxMetadataPages: { kind: "int", default: 12, min: 1, max: 50 },
        categoryToolsHideGlobalTagSearch: { kind: "bool", default: true },
        categoryToolsFollowerBadgesEnabled: { kind: "bool", default: true },
        categoryToolsLiveElapsedEnabled: { kind: "bool", default: true },
        categoryToolsFollowerFilterPreset1: {
            kind: "int",
            default: 1000,
            min: FILTER_PRESET_MIN,
            max: FILTER_PRESET_MAX,
        },
        categoryToolsFollowerFilterPreset2: {
            kind: "int",
            default: 5000,
            min: FILTER_PRESET_MIN,
            max: FILTER_PRESET_MAX,
        },
        categoryToolsFollowerFilterPreset3: {
            kind: "int",
            default: 10000,
            min: FILTER_PRESET_MIN,
            max: FILTER_PRESET_MAX,
        },
        categoryToolsFollowerFilterPreset4: {
            kind: "int",
            default: 30000,
            min: FILTER_PRESET_MIN,
            max: FILTER_PRESET_MAX,
        },
        categoryToolsFollowerFilterPreset5: {
            kind: "int",
            default: 50000,
            min: FILTER_PRESET_MIN,
            max: FILTER_PRESET_MAX,
        },
        categoryToolsFollowerFilterPreset6: {
            kind: "int",
            default: 100000,
            min: FILTER_PRESET_MIN,
            max: FILTER_PRESET_MAX,
        },
        categoryToolsViewFilterPreset1: { kind: "int", default: 100, min: FILTER_PRESET_MIN, max: FILTER_PRESET_MAX },
        categoryToolsViewFilterPreset2: { kind: "int", default: 500, min: FILTER_PRESET_MIN, max: FILTER_PRESET_MAX },
        categoryToolsViewFilterPreset3: { kind: "int", default: 1000, min: FILTER_PRESET_MIN, max: FILTER_PRESET_MAX },
        categoryToolsViewFilterPreset4: { kind: "int", default: 3000, min: FILTER_PRESET_MIN, max: FILTER_PRESET_MAX },
        categoryToolsViewFilterPreset5: { kind: "int", default: 5000, min: FILTER_PRESET_MIN, max: FILTER_PRESET_MAX },
        categoryToolsViewFilterPreset6: { kind: "int", default: 10000, min: FILTER_PRESET_MIN, max: FILTER_PRESET_MAX },
        categoryToolsDurationFilterPreset1: {
            kind: "int",
            default: 1,
            min: DURATION_FILTER_PRESET_MIN,
            max: DURATION_FILTER_PRESET_MAX,
        },
        categoryToolsDurationFilterPreset2: {
            kind: "int",
            default: 2,
            min: DURATION_FILTER_PRESET_MIN,
            max: DURATION_FILTER_PRESET_MAX,
        },
        categoryToolsDurationFilterPreset3: {
            kind: "int",
            default: 4,
            min: DURATION_FILTER_PRESET_MIN,
            max: DURATION_FILTER_PRESET_MAX,
        },
        categoryToolsDurationFilterPreset4: {
            kind: "int",
            default: 6,
            min: DURATION_FILTER_PRESET_MIN,
            max: DURATION_FILTER_PRESET_MAX,
        },
        categoryToolsDurationFilterPreset5: {
            kind: "int",
            default: 12,
            min: DURATION_FILTER_PRESET_MIN,
            max: DURATION_FILTER_PRESET_MAX,
        },
        categoryToolsDurationFilterPreset6: {
            kind: "int",
            default: 24,
            min: DURATION_FILTER_PRESET_MIN,
            max: DURATION_FILTER_PRESET_MAX,
        },
        categoryToolsFollowerFetchMaxPerPass: { kind: "int", default: 6, min: 1, max: 50 },
        categoryToolsFollowerFetchConcurrency: { kind: "int", default: 2, min: 1, max: 10 },
        categoryToolsFollowerFetchDelayMs: { kind: "int", default: 700, min: 0, max: 5000 },
        followingRefreshEnabled: { kind: "bool", default: true, feature: true },
        followingRefreshSeconds: { kind: "int", default: 30, min: 10, max: 600 },
        // 미리보기 HLS가 선택 권한(pstatic.net) 승인을 전제로 하므로, 사용자가
        // 옵션에서 직접 켜면서 권한을 허용하는 흐름이 되도록 기본값은 꺼짐이다.
        followingPreviewTooltipEnabled: { kind: "bool", default: false, feature: true },
        followingPreviewSoundEnabled: { kind: "bool", default: true },
        followingPreviewVolumePercent: { kind: "int", default: 15, min: 1, max: 100 },
        livePreviewRightClickSoundEnabled: { kind: "bool", default: true },
        holdSpeedEnabled: { kind: "bool", default: true, feature: true },
    });

    const OPTION_SPEC = OPTION_SCHEMA;
    const OPTION_KEYS = Object.freeze(Object.keys(OPTION_SCHEMA));
    const STORAGE_OPTION_KEYS = Object.freeze([...OPTION_KEYS, LEGACY_CHAT_TOOLS_ENABLED_KEY]);
    const FEATURE_KEYS = Object.freeze(OPTION_KEYS.filter((key) => OPTION_SCHEMA[key].feature));
    const DEFAULT_OPTIONS = Object.freeze(
        OPTION_KEYS.reduce((out, key) => {
            out[key] = OPTION_SCHEMA[key].default;
            return out;
        }, {})
    );
    let cachedOptions = normalizeOptions();
    let optionsLoaded = false;
    let optionsLoading = false;
    let optionsCallbacks = [];
    let optionsChangeListenerInstalled = false;
    const optionListeners = new Set();

    function normalizeInteger(value, fallback, min, max) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(Math.max(Math.round(parsed), min), max);
    }

    function normalizeNumber(value, fallback, min, max, step) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        const clamped = Math.min(Math.max(parsed, min), max);
        if (!Number.isFinite(step) || step <= 0) return clamped;
        const rounded = Math.round(clamped / step) * step;
        const decimals = Math.max(0, String(step).split(".")[1]?.length || 0);
        return Number(rounded.toFixed(decimals));
    }

    function normalizeBoolean(value, fallback = true) {
        if (typeof value === "boolean") return value;
        if (value === "true") return true;
        if (value === "false") return false;
        return fallback;
    }

    function normalizeSkipSeconds(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SKIP_SECONDS;
        return Math.min(Math.max(Math.round(parsed), SKIP_MIN), SKIP_MAX);
    }

    function normalizeOptionValue(key, value) {
        const spec = OPTION_SCHEMA[key];
        const fallback = DEFAULT_OPTIONS[key];

        if (spec.kind === "bool") return normalizeBoolean(value, fallback);
        if (spec.kind === "int") return normalizeInteger(value, fallback, spec.min, spec.max);
        if (spec.kind === "number") return normalizeNumber(value, fallback, spec.min, spec.max, spec.step);
        if (spec.kind === "skipSeconds") return normalizeSkipSeconds(value);
        return fallback;
    }

    function normalizeOptions(value = {}) {
        const raw = value && typeof value === "object" ? value : {};
        const out = {};

        for (const key of OPTION_KEYS) {
            out[key] = normalizeOptionValue(key, raw[key]);
        }

        if (Object.prototype.hasOwnProperty.call(raw, LEGACY_CHAT_TOOLS_ENABLED_KEY)) {
            const legacyEnabled = normalizeBoolean(raw[LEGACY_CHAT_TOOLS_ENABLED_KEY], false);
            if (!legacyEnabled) {
                out.chatToolsShowBlindEnabled = false;
                out.chatToolsModeratorBoxEnabled = false;
            } else if (!Object.prototype.hasOwnProperty.call(raw, "chatToolsModeratorBoxEnabled")) {
                // 기존 상위 토글을 켠 사용자는 당시 기본값이던 모아보기를 그대로 유지한다.
                out.chatToolsModeratorBoxEnabled = true;
            }
        }

        return out;
    }

    function migrateLegacyChatToolsOption(raw, normalized = normalizeOptions(raw)) {
        if (!Object.prototype.hasOwnProperty.call(raw || {}, LEGACY_CHAT_TOOLS_ENABLED_KEY)) return;
        const storage = globalThis.chrome?.storage?.sync;
        if (typeof storage?.set !== "function" || typeof storage?.remove !== "function") return;

        storage.set(
            {
                chatToolsShowBlindEnabled: normalized.chatToolsShowBlindEnabled,
                chatToolsModeratorBoxEnabled: normalized.chatToolsModeratorBoxEnabled,
            },
            () => {
                if (getStorageLastError()) return;
                storage.remove(LEGACY_CHAT_TOOLS_ENABLED_KEY, () => {
                    void getStorageLastError();
                });
            }
        );
    }

    function flushOptionCallbacks(options) {
        const callbacks = optionsCallbacks;
        optionsCallbacks = [];
        for (const queued of callbacks) queued(options);
    }

    function getStorageLastError() {
        return globalThis.chrome?.runtime?.lastError || null;
    }

    function installOptionsChangeListener() {
        if (optionsChangeListenerInstalled || !globalThis.chrome?.storage?.onChanged) return;
        optionsChangeListenerInstalled = true;

        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== "sync") return;
            const changedKeys = OPTION_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(changes, key));
            if (!changedKeys.length) return;

            const nextRaw = { ...cachedOptions };
            for (const key of changedKeys) nextRaw[key] = changes[key]?.newValue;
            cachedOptions = normalizeOptions(nextRaw);
            optionsLoaded = true;

            for (const listener of Array.from(optionListeners)) listener(cachedOptions);
        });
    }

    function getOptions(callback) {
        if (!globalThis.chrome?.storage?.sync) {
            callback(cachedOptions);
            return;
        }

        installOptionsChangeListener();

        if (optionsLoaded) {
            callback(cachedOptions);
            return;
        }

        optionsCallbacks.push(callback);
        if (optionsLoading) return;
        optionsLoading = true;

        chrome.storage.sync.get(STORAGE_OPTION_KEYS, (data) => {
            optionsLoading = false;
            if (getStorageLastError()) {
                flushOptionCallbacks(cachedOptions);
                return;
            }
            cachedOptions = normalizeOptions(data);
            optionsLoaded = true;
            flushOptionCallbacks(cachedOptions);
            migrateLegacyChatToolsOption(data, cachedOptions);
        });
    }

    function addOptionsChangeListener(callback) {
        if (!globalThis.chrome?.storage?.onChanged) return () => {};
        installOptionsChangeListener();
        optionListeners.add(callback);
        return () => optionListeners.delete(callback);
    }

    globalThis.BetterChzzkSettings = {
        DEFAULT_QUALITY,
        DEFAULT_SKIP_SECONDS,
        SKIP_MIN,
        SKIP_MAX,
        MONTHLY_CALENDAR_MIN_PAGES,
        MONTHLY_CALENDAR_MAX_PAGES,
        LIVE_WATCH_HISTORY_MIN_MINUTES_MIN,
        LIVE_WATCH_HISTORY_MIN_MINUTES_MAX,
        CHAT_TOOLS_MIN_MODERATOR_MESSAGES,
        CHAT_TOOLS_MAX_MODERATOR_MESSAGES,
        OPTION_SPEC,
        DEFAULT_OPTIONS,
        OPTION_KEYS,
        STORAGE_OPTION_KEYS,
        FEATURE_KEYS,
        normalizeSkipSeconds,
        normalizeOptions,
        migrateLegacyChatToolsOption,
        getStorageLastError,
        getOptions,
        addOptionsChangeListener,
    };
})();
