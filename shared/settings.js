(() => {
    const DEFAULT_QUALITY = "1080p";
    const DEFAULT_SKIP_SECONDS = 5;
    const SKIP_MIN = 1;
    const SKIP_MAX = 600;
    const MONTHLY_CALENDAR_MIN_PAGES = 1;
    const MONTHLY_CALENDAR_MAX_PAGES = 300;
    const FILTER_PRESET_MIN = 1;
    const FILTER_PRESET_MAX = 10000000;
    const LIVE_WATCH_HISTORY_MIN_MINUTES_MIN = 1;
    const LIVE_WATCH_HISTORY_MIN_MINUTES_MAX = 1440;
    const LIVE_PAUSE_CACHE_DEPTH_MINUTES_MIN = 1;
    const LIVE_PAUSE_CACHE_DEPTH_MINUTES_MAX = 360;
    const LIVE_PAUSE_CACHE_DEPTH_MINUTES_DEFAULT = 120;

    const OPTION_SCHEMA = Object.freeze({
        autoQualityEnabled: { kind: "bool", default: true, feature: true },
        skipControlEnabled: { kind: "bool", default: true, feature: true },
        skipKeyboardEnabled: { kind: "bool", default: true },
        skipPillEnabled: { kind: "bool", default: true },
        skipLivePillEnabled: { kind: "bool", default: true },
        skipLivePauseResumeEnabled: { kind: "bool", default: true },
        skipLivePauseResumeDepthMinutes: {
            kind: "int",
            default: LIVE_PAUSE_CACHE_DEPTH_MINUTES_DEFAULT,
            min: LIVE_PAUSE_CACHE_DEPTH_MINUTES_MIN,
            max: LIVE_PAUSE_CACHE_DEPTH_MINUTES_MAX,
        },
        skipSeconds: { kind: "skipSeconds", default: DEFAULT_SKIP_SECONDS },
        skipWheelStep: { kind: "int", default: 1, min: 1, max: 60 },
        skipWheelShiftStep: { kind: "int", default: 5, min: 1, max: 300 },
        skipWheelAltStep: { kind: "int", default: 10, min: 1, max: 600 },
        volumeWheelEnabled: { kind: "bool", default: true, feature: true },
        volumeWheelStep: { kind: "int", default: 5, min: 1, max: 50 },
        vodBroadcastClockEnabled: { kind: "bool", default: false, feature: true },
        timeMachineLagLabelEnabled: { kind: "bool", default: true, feature: true },
        adblockPopupEnabled: { kind: "bool", default: true, feature: true },
        monthlyBroadcastTimeEnabled: { kind: "bool", default: true, feature: true },
        monthlyBroadcastTimeWindowDays: { kind: "int", default: 30, min: 1, max: 365 },
        monthlyBroadcastTimeMaxPages: { kind: "int", default: 12, min: 1, max: 200 },
        monthlyBroadcastTimeCalendarEnabled: { kind: "bool", default: true },
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
        categoryToolsFollowerFetchMaxPerPass: { kind: "int", default: 6, min: 1, max: 50 },
        categoryToolsFollowerFetchConcurrency: { kind: "int", default: 2, min: 1, max: 10 },
        categoryToolsFollowerFetchDelayMs: { kind: "int", default: 700, min: 0, max: 5000 },
    });

    const OPTION_SPEC = OPTION_SCHEMA;
    const OPTION_KEYS = Object.freeze(Object.keys(OPTION_SCHEMA));
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
        if (spec.kind === "skipSeconds") return normalizeSkipSeconds(value);
        return fallback;
    }

    function normalizeOptions(value = {}) {
        const raw = value && typeof value === "object" ? value : {};
        const out = {};

        for (const key of OPTION_KEYS) {
            out[key] = normalizeOptionValue(key, raw[key]);
        }

        return out;
    }

    function flushOptionCallbacks(options) {
        const callbacks = optionsCallbacks;
        optionsCallbacks = [];
        for (const queued of callbacks) queued(options);
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

        chrome.storage.sync.get(OPTION_KEYS, (data) => {
            optionsLoading = false;
            cachedOptions = normalizeOptions(data);
            optionsLoaded = true;
            flushOptionCallbacks(cachedOptions);
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
        LIVE_PAUSE_CACHE_DEPTH_MINUTES_MIN,
        LIVE_PAUSE_CACHE_DEPTH_MINUTES_MAX,
        LIVE_PAUSE_CACHE_DEPTH_MINUTES_DEFAULT,
        OPTION_SPEC,
        DEFAULT_OPTIONS,
        OPTION_KEYS,
        FEATURE_KEYS,
        normalizeSkipSeconds,
        normalizeOptions,
        getOptions,
        addOptionsChangeListener,
    };
})();
