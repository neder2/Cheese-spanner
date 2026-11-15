/**
 * shared/settings.js — 옵션 단일 공급원 (globalThis.CheeseSpannerSettings)
 *
 * 실행 컨텍스트: isolated world 콘텐츠 스크립트 + service worker(background.js의 importScripts) +
 *   확장 페이지(options.html, history.html). 그래서 window/document 같은 DOM API를 쓰면 안 되고
 *   globalThis/chrome만 쓴다.
 * 하는 일: OPTION_SCHEMA(키별 kind/default/min/max/feature 플래그)에서 DEFAULT_OPTIONS, OPTION_KEYS,
 *   FEATURE_KEYS를 파생하고, chrome.storage.sync 기반 옵션 로드·정규화·변경 구독을 제공한다.
 *   새 옵션은 OPTION_SCHEMA에 항목 하나를 추가하면 기본값·정규화·변경 알림이 함께 따라온다.
 * 공개 API: normalizeOptions, getOptions(callback), addOptionsChangeListener(callback),
 *   getStorageLastError, normalizeSkipSeconds, 배속 단축키 검증·표시 도우미, 각종 min/max 상수.
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
    const CHAT_TOOLS_DEFAULT_MODERATOR_BOX_HEIGHT = 420;
    const CHAT_TOOLS_MIN_MODERATOR_BOX_HEIGHT = 240;
    const CHAT_TOOLS_MAX_MODERATOR_BOX_HEIGHT = 720;
    const FOLLOWING_LIST_MAX_ROWS = 30;
    const LEGACY_CHAT_TOOLS_ENABLED_KEY = "chatToolsEnabled";
    const DOWNLOAD_FOLDER_MAX_LENGTH = 120;
    const DOWNLOAD_FOLDER_MAX_SEGMENTS = 5;
    const DOWNLOAD_FOLDER_SEGMENT_MAX_LENGTH = 60;
    // Windows reserves these device names in every folder; chrome.downloads rejects a path that uses one.
    const RESERVED_DOWNLOAD_FOLDER_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;
    const DEFAULT_PLAYBACK_SPEED_HALF_KEY_CODE = "BracketLeft";
    const DEFAULT_PLAYBACK_SPEED_DOUBLE_KEY_CODE = "BracketRight";
    const DEFAULT_PLAYBACK_SPEED_RESET_KEY_CODE = "Backslash";
    const PLAYBACK_SPEED_SHORTCUT_CODE_PATTERN =
        /^(?:Key[A-Z]|Digit[0-9]|Numpad[0-9]|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Minus|Equal|Slash)$/;
    const RESERVED_PLAYBACK_SPEED_SHORTCUT_CODES = new Set(["KeyC", "KeyF", "KeyJ", "KeyK", "KeyL", "KeyM", "KeyT"]);
    const PLAYBACK_SPEED_SHORTCUT_CODE_LABELS = Object.freeze({
        BracketLeft: "[",
        BracketRight: "]",
        Backslash: "\\",
        Semicolon: ";",
        Quote: "'",
        Backquote: "`",
        Minus: "-",
        Equal: "=",
        Slash: "/",
    });

    const OPTION_SCHEMA = Object.freeze({
        optionsTheme: { kind: "theme", default: "system" },
        updateGuideEnabled: { kind: "bool", default: true },
        autoQualityEnabled: { kind: "bool", default: true, feature: true },
        autoQualityPreferred: { kind: "quality", default: DEFAULT_QUALITY },
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
        volumeTooltipEnabled: { kind: "bool", default: true, feature: true },
        playerZoomEnabled: { kind: "bool", default: false, feature: true },
        playerZoomMode: { kind: "zoomMode", default: "manual" },
        playerZoomShortcutKey: { kind: "choice", values: ["alt", "ctrl", "shift", "meta"], default: "alt" },
        ambientEnabled: { kind: "bool", default: false, feature: true },
        ambientIntensity: { kind: "int", default: 60, min: 10, max: 100 },
        hideLiveBadgeEnabled: { kind: "bool", default: false, feature: true },
        playerClipHidden: { kind: "bool", default: false, feature: true },
        playerPipHidden: { kind: "bool", default: false, feature: true },
        // 플레이어 오른쪽 아래 녹화 버튼(features/videoRecorder.js). 녹화는 버튼을 누를 때만 시작해요.
        videoRecorderEnabled: { kind: "bool", default: false, feature: true },
        // Chrome 다운로드 폴더 아래 하위 폴더. 빈 값은 다운로드 폴더 자체예요. 하위 폴더 저장에는 선택 권한 downloads가 필요해요.
        videoRecorderFolder: { kind: "downloadFolder", default: "" },
        liveStartTimeEnabled: { kind: "bool", default: false, feature: true },
        offlineLiveReloadEnabled: { kind: "bool", default: true, feature: true },
        audioCompressorEnabled: { kind: "bool", default: false, feature: true },
        audioCompressorThreshold: { kind: "number", default: -24, min: -60, max: 0, step: 1 },
        audioCompressorKnee: { kind: "number", default: 30, min: 0, max: 40, step: 1 },
        audioCompressorRatio: { kind: "number", default: 12, min: 1, max: 20, step: 0.1 },
        audioCompressorAttack: { kind: "number", default: 0.003, min: 0, max: 1, step: 0.001 },
        audioCompressorRelease: { kind: "number", default: 0.25, min: 0, max: 1, step: 0.01 },
        audioCompressorMakeupGain: { kind: "number", default: 1, min: 0.5, max: 3, step: 0.1 },
        vodBroadcastClockEnabled: { kind: "bool", default: true, feature: true },
        timeMachineLagLabelEnabled: { kind: "bool", default: true, feature: true },
        streamInfoEnabled: { kind: "bool", default: true, feature: true },
        adblockPopupEnabled: { kind: "bool", default: true, feature: true },
        headerStudioHidden: { kind: "bool", default: false, feature: true },
        headerCheeseHidden: { kind: "bool", default: false, feature: true },
        headerNotificationHidden: { kind: "bool", default: false, feature: true },
        adVideoEnabled: { kind: "bool", default: true, feature: true },
        adBannerEnabled: { kind: "bool", default: false, feature: true },
        monthlyBroadcastTimeEnabled: { kind: "bool", default: true, feature: true },
        channelChatLinkEnabled: { kind: "bool", default: true, feature: true },
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
        liveWatchHistoryChatEnabled: { kind: "bool", default: false, feature: true },
        liveWatchHistoryDonationEnabled: { kind: "bool", default: false, feature: true },
        liveWatchHistoryMinMinutes: {
            kind: "int",
            default: 1,
            min: LIVE_WATCH_HISTORY_MIN_MINUTES_MIN,
            max: LIVE_WATCH_HISTORY_MIN_MINUTES_MAX,
        },
        vodCommentTabsEnabled: { kind: "bool", default: true, feature: true },
        chatResizeEnabled: { kind: "bool", default: true, feature: true },
        // 일반 라이브·다시보기의 채팅 열 위치. 기본은 치지직 원래 배치(오른쪽)예요.
        chatPosition: { kind: "choice", values: ["right", "left"], default: "right" },
        chatTimestampEnabled: { kind: "bool", default: false, feature: true },
        vodChatTimestampEnabled: { kind: "bool", default: false, feature: true },
        // 로그인 계정의 작성자 해시로만 비교해요. 계정 해시는 저장하지 않아요(features/vodOwnChat.js).
        vodOwnChatHighlightEnabled: { kind: "bool", default: true, feature: true },
        chatWeeklyRankingHidden: { kind: "bool", default: false, feature: true },
        chatDonationMessagesHidden: { kind: "bool", default: false, feature: true },
        chatWelcomeMessageRemovalEnabled: { kind: "bool", default: false, feature: true },
        chatKeywordFilterEnabled: { kind: "bool", default: true, feature: true },
        chatKeywordFilterWords: { kind: "chatKeywords", default: "" },
        chatKeywordFilterApplyMode: { kind: "choice", values: ["all", "individual"], default: "all" },
        chatKeywordFilterMatchMode: { kind: "choice", values: ["contains", "exact"], default: "contains" },
        // 문구별 조건은 완전 일치를 선택한 문구만 보관하고 나머지는 포함으로 처리해요.
        chatKeywordFilterExactWords: { kind: "chatKeywords", default: "" },
        chatToolsShowBlindEnabled: { kind: "bool", default: false, feature: true },
        chatToolsModeratorBoxEnabled: { kind: "bool", default: false, feature: true },
        chatToolsMaxModeratorMessages: {
            kind: "int",
            default: 100,
            min: CHAT_TOOLS_MIN_MODERATOR_MESSAGES,
            max: CHAT_TOOLS_MAX_MODERATOR_MESSAGES,
        },
        // 기본값 420px은 모아보기 상자의 기존 최대 높이와 같아요.
        chatToolsModeratorBoxHeight: {
            kind: "int",
            default: CHAT_TOOLS_DEFAULT_MODERATOR_BOX_HEIGHT,
            min: CHAT_TOOLS_MIN_MODERATOR_BOX_HEIGHT,
            max: CHAT_TOOLS_MAX_MODERATOR_BOX_HEIGHT,
        },
        videoSearchEnabled: { kind: "bool", default: true, feature: true },
        videoSearchCommentEnabled: { kind: "bool", default: true },
        videoSearchMaxPages: { kind: "int", default: 80, min: 1, max: 200 },
        videoSearchRenderBatchSize: { kind: "int", default: 80, min: 10, max: 300 },
        videoSearchCommentDelayMs: { kind: "int", default: 1000, min: 0, max: 5000 },
        videoSearchCommentMaxVideos: { kind: "int", default: 60, min: 1, max: 200 },
        videoSearchCommentMaxPagesPerVideo: { kind: "int", default: 1, min: 1, max: 3 },
        categoryToolsEnabled: { kind: "bool", default: true, feature: true },
        globalLiveCountEnabled: { kind: "bool", default: false, feature: true },
        titleTooltipEnabled: { kind: "bool", default: true, feature: true },
        categoryToolsMaxMetadataPages: { kind: "int", default: 12, min: 1, max: 50 },
        categoryToolsHideGlobalTagSearch: { kind: "bool", default: true },
        categoryToolsFollowerBadgesEnabled: { kind: "bool", default: true },
        categoryToolsLiveElapsedEnabled: { kind: "bool", default: true },
        categoryToolsExclusionsEnabled: { kind: "bool", default: true },
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
        sidebarResizeEnabled: { kind: "bool", default: true, feature: true },
        sidebarPosition: { kind: "choice", values: ["left", "right"], default: "left" },
        sidebarCheeseFarmHidden: { kind: "bool", default: false, feature: true },
        sidebarPopularCategoriesHidden: { kind: "bool", default: false, feature: true },
        sidebarUpcomingScheduleHidden: { kind: "bool", default: false, feature: true },
        sidebarPartnerStreamersHidden: { kind: "bool", default: false, feature: true },
        sidebarServiceLinksHidden: { kind: "bool", default: false, feature: true },
        followingOfflineHidden: { kind: "bool", default: false, feature: true },
        followingPinEnabled: { kind: "bool", default: true, feature: true },
        followingPinOfflineToTopEnabled: { kind: "bool", default: false },
        followingTitleHistoryEnabled: { kind: "bool", default: true, feature: true },
        followingListStateEnabled: { kind: "bool", default: false, feature: true },
        followingRefreshEnabled: { kind: "bool", default: true, feature: true },
        followingRefreshSeconds: { kind: "int", default: 30, min: 10, max: 600 },
        followingFoldersEnabled: { kind: "bool", default: false, feature: true },
        // 0은 팔로잉 목록 높이를 제한하지 않는다는 뜻이에요.
        followingListMaxRows: { kind: "int", default: 0, min: 0, max: FOLLOWING_LIST_MAX_ROWS },
        liveStartNotificationsEnabled: { kind: "bool", default: false, feature: true },
        liveStartAutoOpenEnabled: { kind: "bool", default: false, feature: true },
        liveStartButtonEnabled: { kind: "bool", default: true, feature: true },
        // 미리보기 HLS가 선택 권한(pstatic.net) 승인을 전제로 하므로, 사용자가
        // 옵션에서 직접 켜면서 권한을 허용하는 흐름이 되도록 기본값은 꺼짐이다.
        liveMultiviewEnabled: { kind: "bool", default: false, feature: true },
        chatMultiviewEnabled: { kind: "bool", default: false, feature: true },
        followingPreviewTooltipEnabled: { kind: "bool", default: false, feature: true },
        followingPreviewSoundEnabled: { kind: "bool", default: true },
        followingPreviewVolumePercent: { kind: "int", default: 15, min: 1, max: 100 },
        livePreviewRightClickSoundEnabled: { kind: "bool", default: true },
        screenShortcutsEnabled: { kind: "bool", default: false, feature: true },
        holdSpeedEnabled: { kind: "bool", default: true, feature: true },
        playbackSpeedShortcutsEnabled: { kind: "bool", default: true, feature: true },
        playbackSpeedHalfKeyCode: { kind: "shortcutCode", default: DEFAULT_PLAYBACK_SPEED_HALF_KEY_CODE },
        // 기존 사용자 지정 키를 유지하며 Half/Double을 감소/증가 키로 사용한다.
        playbackSpeedDoubleKeyCode: { kind: "shortcutCode", default: DEFAULT_PLAYBACK_SPEED_DOUBLE_KEY_CODE },
        playbackSpeedResetKeyCode: { kind: "shortcutCode", default: DEFAULT_PLAYBACK_SPEED_RESET_KEY_CODE },
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
    let optionsLoadingChanges = null;
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

    /**
     * A relative folder under Chrome's download directory: "/" separates at most 5 folders, and characters that
     * Windows, macOS or Chrome refuse in a path are dropped. "", ".", ".." and absolute paths never survive.
     */
    function normalizeDownloadFolder(value, fallback = "") {
        if (typeof value !== "string") return fallback;
        const segments = [];
        for (const raw of value.replace(/\\/g, "/").split("/")) {
            const segment = raw
                // eslint-disable-next-line no-control-regex -- path segments must not carry control characters.
                .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, DOWNLOAD_FOLDER_SEGMENT_MAX_LENGTH)
                .replace(/[. ]+$/, "")
                .replace(/^[. ]+/, "");
            if (!segment) continue;
            segments.push(RESERVED_DOWNLOAD_FOLDER_NAME.test(segment) ? `_${segment}` : segment);
            if (segments.length === DOWNLOAD_FOLDER_MAX_SEGMENTS) break;
        }
        let folder = segments.join("/");
        while (folder.length > DOWNLOAD_FOLDER_MAX_LENGTH && segments.length > 1) {
            segments.pop();
            folder = segments.join("/");
        }
        return folder.slice(0, DOWNLOAD_FOLDER_MAX_LENGTH).replace(/[. ]+$/, "");
    }

    function isPlaybackSpeedShortcutCode(value) {
        return (
            typeof value === "string" &&
            PLAYBACK_SPEED_SHORTCUT_CODE_PATTERN.test(value) &&
            !RESERVED_PLAYBACK_SPEED_SHORTCUT_CODES.has(value)
        );
    }

    function normalizeShortcutCode(value, fallback) {
        const code = typeof value === "string" ? value.trim() : "";
        return isPlaybackSpeedShortcutCode(code) ? code : fallback;
    }

    function getPlaybackSpeedShortcutLabel(code) {
        if (PLAYBACK_SPEED_SHORTCUT_CODE_LABELS[code]) return PLAYBACK_SPEED_SHORTCUT_CODE_LABELS[code];
        if (/^Key[A-Z]$/.test(code)) return code.slice(3);
        if (/^Digit[0-9]$/.test(code)) return code.slice(5);
        if (/^Numpad[0-9]$/.test(code)) return `Num ${code.slice(6)}`;
        return code;
    }

    // Reject oversized lists instead of shortening a phrase into an unintended broader match.
    function normalizeChatKeywordFilterWords(value) {
        if (typeof value !== "string" || value.length > 2000) return null;
        // eslint-disable-next-line no-control-regex -- reject non-text controls and lone surrogates before sync storage.
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(value)) return null;
        const words = [];
        const seen = new Set();
        for (const line of value.split(/\r\n?|\n/)) {
            const word = line.trim().normalize("NFC");
            if (!word) continue;
            if (word.length > 100) return null;
            const key = word.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            words.push(word);
            if (words.length > 50) return null;
        }
        const normalized = words.join("\n");
        return normalized.length <= 2000 ? normalized : null;
    }

    function normalizeOptionValue(key, value) {
        const spec = OPTION_SCHEMA[key];
        const fallback = DEFAULT_OPTIONS[key];

        if (spec.kind === "bool") return normalizeBoolean(value, fallback);
        if (spec.kind === "theme") return ["system", "light", "dark"].includes(value) ? value : fallback;
        if (spec.kind === "quality") return ["1080p", "720p", "480p"].includes(value) ? value : fallback;
        if (spec.kind === "zoomMode") return ["manual", "always", "shortcut"].includes(value) ? value : fallback;
        if (spec.kind === "choice") return spec.values.includes(value) ? value : fallback;
        if (spec.kind === "int") return normalizeInteger(value, fallback, spec.min, spec.max);
        if (spec.kind === "number") return normalizeNumber(value, fallback, spec.min, spec.max, spec.step);
        if (spec.kind === "skipSeconds") return normalizeSkipSeconds(value);
        if (spec.kind === "shortcutCode") return normalizeShortcutCode(value, fallback);
        if (spec.kind === "downloadFolder") return normalizeDownloadFolder(value, fallback);
        if (spec.kind === "chatKeywords") return normalizeChatKeywordFilterWords(value) ?? fallback;
        return fallback;
    }

    function getChatKeywordFilterRules(options = {}) {
        const words = normalizeChatKeywordFilterWords(options.chatKeywordFilterWords) || "";
        const exactWords = new Set(
            (normalizeChatKeywordFilterWords(options.chatKeywordFilterExactWords) || "").toLowerCase().split("\n")
        );
        const individual =
            normalizeOptionValue("chatKeywordFilterApplyMode", options.chatKeywordFilterApplyMode) === "individual";
        const matchMode = normalizeOptionValue("chatKeywordFilterMatchMode", options.chatKeywordFilterMatchMode);
        return words
            .split("\n")
            .filter(Boolean)
            .map((phrase) => ({
                phrase,
                matchMode: individual ? (exactWords.has(phrase.toLowerCase()) ? "exact" : "contains") : matchMode,
            }));
    }

    function normalizeOptions(value = {}) {
        const raw = value && typeof value === "object" ? value : {};
        const out = {};

        for (const key of OPTION_KEYS) {
            out[key] = normalizeOptionValue(key, raw[key]);
        }

        if (
            new Set([out.playbackSpeedHalfKeyCode, out.playbackSpeedDoubleKeyCode, out.playbackSpeedResetKeyCode])
                .size < 3
        ) {
            out.playbackSpeedHalfKeyCode = DEFAULT_PLAYBACK_SPEED_HALF_KEY_CODE;
            out.playbackSpeedDoubleKeyCode = DEFAULT_PLAYBACK_SPEED_DOUBLE_KEY_CODE;
            out.playbackSpeedResetKeyCode = DEFAULT_PLAYBACK_SPEED_RESET_KEY_CODE;
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

    function migrateLegacyChatToolsOption(raw) {
        if (!Object.prototype.hasOwnProperty.call(raw || {}, LEGACY_CHAT_TOOLS_ENABLED_KEY)) return;
        // Only extension pages and the worker hold the settings lock; chzzk pages leave the write to them.
        if (globalThis.location?.protocol !== "chrome-extension:") return;
        const storage = globalThis.chrome?.storage?.sync;
        if (typeof storage?.get !== "function" || typeof storage?.set !== "function") return;
        if (typeof storage.remove !== "function") return;

        void withOptionsStorageLock(
            () =>
                new Promise((resolve) => {
                    // Re-read inside the lock so a newer explicit choice is never replaced by an old snapshot.
                    storage.get(STORAGE_OPTION_KEYS, (latest) => {
                        if (getStorageLastError() || !Object.hasOwn(latest || {}, LEGACY_CHAT_TOOLS_ENABLED_KEY)) {
                            resolve();
                            return;
                        }
                        const normalized = normalizeOptions(latest);
                        storage.set(
                            {
                                chatToolsShowBlindEnabled: normalized.chatToolsShowBlindEnabled,
                                chatToolsModeratorBoxEnabled: normalized.chatToolsModeratorBoxEnabled,
                            },
                            () => {
                                if (getStorageLastError()) {
                                    resolve();
                                    return;
                                }
                                storage.remove(LEGACY_CHAT_TOOLS_ENABLED_KEY, () => {
                                    void getStorageLastError();
                                    resolve();
                                });
                            }
                        );
                    });
                })
        ).catch(() => {});
    }

    function flushOptionCallbacks(options) {
        const callbacks = optionsCallbacks;
        optionsCallbacks = [];
        for (const queued of callbacks) queued(options);
    }

    function getStorageLastError() {
        return globalThis.chrome?.runtime?.lastError || null;
    }

    function withOptionsStorageLock(work) {
        // 확장 페이지와 워커가 같은 origin의 잠금을 저장 콜백 완료까지 공유한다.
        const locks = globalThis.navigator?.locks;
        if (typeof locks?.request === "function") return locks.request("cheese-spanner:options-storage", work);
        // Web Locks가 없는 단일 컨텍스트에서도 기존 콜백 API를 사용할 수 있다.
        try {
            return Promise.resolve(work());
        } catch (error) {
            return Promise.reject(error);
        }
    }

    function installOptionsChangeListener() {
        if (optionsChangeListenerInstalled || !globalThis.chrome?.storage?.onChanged) return;
        optionsChangeListenerInstalled = true;

        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== "sync") return;
            const changedKeys = OPTION_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(changes, key));
            if (!changedKeys.length) return;

            // 첫 읽기가 성공하기 전 변경은 일부 키뿐이라 나머지가 기본값이에요. 읽기 결과에 합쳐 전달하고,
            // 실패한 읽기를 기다리는 구독이 있으면 다시 읽어요. 기본값을 저장값처럼 넘기거나 고정하지 않아요.
            if (!optionsLoaded) {
                if (optionsLoadingChanges) {
                    for (const key of changedKeys) optionsLoadingChanges[key] = changes[key]?.newValue;
                } else if (optionsCallbacks.length) {
                    readOptions();
                }
                return;
            }

            const nextRaw = { ...cachedOptions };
            for (const key of changedKeys) nextRaw[key] = changes[key]?.newValue;
            cachedOptions = normalizeOptions(nextRaw);

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
        readOptions();
    }

    function readOptions() {
        if (optionsLoading) return;
        optionsLoading = true;
        optionsLoadingChanges = {};

        chrome.storage.sync.get(STORAGE_OPTION_KEYS, (data) => {
            optionsLoading = false;
            const pendingChanges = optionsLoadingChanges;
            optionsLoadingChanges = null;
            // 읽기 실패의 기본값은 사용자의 OFF 선택을 대신할 수 있어요. 구독을 보류하고 다음 구독이나 설정 변경 때 다시 읽어요.
            if (getStorageLastError()) return;
            // 최초 읽기가 진행되는 동안 도착한 변경은 이전 스냅샷보다 우선한다.
            cachedOptions = normalizeOptions({ ...data, ...pendingChanges });
            optionsLoaded = true;
            // 읽기 중 변경을 미뤘다면 변경 구독에도 완성된 값을 한 번 알려요. bindFeatureOptions처럼 같은 함수를
            // 읽기 콜백으로도 받은 구독과, 그 콜백 안에서 새로 등록한 구독에는 다시 보내지 않아요.
            const changedListeners = Object.keys(pendingChanges).length ? Array.from(optionListeners) : [];
            const delivered = new Set(optionsCallbacks);
            flushOptionCallbacks(cachedOptions);
            for (const listener of changedListeners) {
                if (!delivered.has(listener) && optionListeners.has(listener)) listener(cachedOptions);
            }
            migrateLegacyChatToolsOption(data);
        });
    }

    function addOptionsChangeListener(callback) {
        if (!globalThis.chrome?.storage?.onChanged) return () => {};
        installOptionsChangeListener();
        optionListeners.add(callback);
        return () => optionListeners.delete(callback);
    }

    function isOptionsPageSender(sender) {
        const runtime = globalThis.chrome?.runtime;
        if (!runtime || sender?.id !== runtime.id || (sender.frameId !== undefined && sender.frameId !== 0))
            return false;
        try {
            const expected = new URL(runtime.getURL("options.html"));
            const actual = new URL(sender.url);
            return (
                actual.protocol === expected.protocol &&
                actual.hostname === expected.hostname &&
                actual.pathname === expected.pathname &&
                !actual.username &&
                !actual.password &&
                !actual.port &&
                !actual.search &&
                [
                    "",
                    "#update-guide-panels",
                    "#update-guide-history",
                    "#update-guide-stream",
                    "#update-guide-categories",
                    "#recording-folder",
                ].includes(actual.hash)
            );
        } catch (_) {
            return false;
        }
    }

    globalThis.CheeseSpannerSettings = {
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
        CHAT_TOOLS_DEFAULT_MODERATOR_BOX_HEIGHT,
        CHAT_TOOLS_MIN_MODERATOR_BOX_HEIGHT,
        CHAT_TOOLS_MAX_MODERATOR_BOX_HEIGHT,
        FOLLOWING_LIST_MAX_ROWS,
        DEFAULT_PLAYBACK_SPEED_HALF_KEY_CODE,
        DEFAULT_PLAYBACK_SPEED_DOUBLE_KEY_CODE,
        DEFAULT_PLAYBACK_SPEED_RESET_KEY_CODE,
        OPTION_SPEC,
        DEFAULT_OPTIONS,
        OPTION_KEYS,
        STORAGE_OPTION_KEYS,
        FEATURE_KEYS,
        DOWNLOAD_FOLDER_MAX_LENGTH,
        normalizeSkipSeconds,
        normalizeDownloadFolder,
        normalizeChatKeywordFilterWords,
        getChatKeywordFilterRules,
        isPlaybackSpeedShortcutCode,
        getPlaybackSpeedShortcutLabel,
        normalizeOptions,
        migrateLegacyChatToolsOption,
        getStorageLastError,
        withOptionsStorageLock,
        getOptions,
        addOptionsChangeListener,
        isOptionsPageSender,
    };
})();
