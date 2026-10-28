const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

require("../shared/settings.js");

const settings = globalThis.CheeseSpannerSettings;

const expectedDefaults = {
    optionsTheme: "system",
    updateGuideEnabled: true,
    autoQualityEnabled: true,
    autoQualityPreferred: "1080p",
    rewardAutoCollectEnabled: true,
    skipControlEnabled: true,
    skipKeyboardEnabled: true,
    skipPillEnabled: true,
    skipLivePillEnabled: true,
    skipLivePauseResumeEnabled: true,
    skipSeconds: 5,
    skipWheelStep: 1,
    skipWheelShiftStep: 5,
    skipWheelAltStep: 10,
    volumeWheelEnabled: true,
    volumeWheelStep: 5,
    volumeTooltipEnabled: true,
    playerZoomEnabled: false,
    playerZoomMode: "manual",
    playerZoomShortcutKey: "alt",
    ambientEnabled: false,
    ambientIntensity: 60,
    hideLiveBadgeEnabled: false,
    playerClipHidden: false,
    playerPipHidden: false,
    liveStartTimeEnabled: false,
    offlineLiveReloadEnabled: true,
    audioCompressorEnabled: false,
    audioCompressorThreshold: -24,
    audioCompressorKnee: 30,
    audioCompressorRatio: 12,
    audioCompressorAttack: 0.003,
    audioCompressorRelease: 0.25,
    audioCompressorMakeupGain: 1,
    vodBroadcastClockEnabled: true,
    timeMachineLagLabelEnabled: true,
    streamInfoEnabled: true,
    adblockPopupEnabled: true,
    headerStudioHidden: false,
    headerCheeseHidden: false,
    headerNotificationHidden: false,
    adVideoEnabled: true,
    adBannerEnabled: false,
    monthlyBroadcastTimeEnabled: true,
    channelChatLinkEnabled: true,
    monthlyBroadcastTimeWindowDays: 30,
    monthlyBroadcastTimeMaxPages: 12,
    monthlyBroadcastTimeCalendarEnabled: true,
    monthlyBroadcastTimeWatchEnabled: false,
    monthlyBroadcastTimeMaxCalendarPages: 60,
    liveWatchHistoryEnabled: true,
    liveWatchHistoryChatEnabled: false,
    liveWatchHistoryDonationEnabled: false,
    liveWatchHistoryMinMinutes: 1,
    vodCommentTabsEnabled: true,
    chatResizeEnabled: true,
    chatPosition: "right",
    chatTimestampEnabled: false,
    vodChatTimestampEnabled: false,
    vodOwnChatHighlightEnabled: true,
    chatWeeklyRankingHidden: false,
    chatWelcomeMessageRemovalEnabled: false,
    chatToolsShowBlindEnabled: false,
    chatToolsModeratorBoxEnabled: false,
    chatToolsMaxModeratorMessages: 100,
    chatToolsModeratorBoxHeight: 420,
    videoSearchEnabled: true,
    videoSearchCommentEnabled: true,
    videoSearchMaxPages: 80,
    videoSearchRenderBatchSize: 80,
    videoSearchCommentDelayMs: 1000,
    videoSearchCommentMaxVideos: 60,
    videoSearchCommentMaxPagesPerVideo: 1,
    categoryToolsEnabled: true,
    globalLiveCountEnabled: false,
    titleTooltipEnabled: true,
    categoryToolsMaxMetadataPages: 12,
    categoryToolsHideGlobalTagSearch: true,
    categoryToolsFollowerBadgesEnabled: true,
    categoryToolsLiveElapsedEnabled: true,
    categoryToolsExclusionsEnabled: true,
    categoryToolsFollowerFilterPreset1: 1000,
    categoryToolsFollowerFilterPreset2: 5000,
    categoryToolsFollowerFilterPreset3: 10000,
    categoryToolsFollowerFilterPreset4: 30000,
    categoryToolsFollowerFilterPreset5: 50000,
    categoryToolsFollowerFilterPreset6: 100000,
    categoryToolsViewFilterPreset1: 100,
    categoryToolsViewFilterPreset2: 500,
    categoryToolsViewFilterPreset3: 1000,
    categoryToolsViewFilterPreset4: 3000,
    categoryToolsViewFilterPreset5: 5000,
    categoryToolsViewFilterPreset6: 10000,
    categoryToolsDurationFilterPreset1: 1,
    categoryToolsDurationFilterPreset2: 2,
    categoryToolsDurationFilterPreset3: 4,
    categoryToolsDurationFilterPreset4: 6,
    categoryToolsDurationFilterPreset5: 12,
    categoryToolsDurationFilterPreset6: 24,
    categoryToolsFollowerFetchMaxPerPass: 6,
    categoryToolsFollowerFetchConcurrency: 2,
    categoryToolsFollowerFetchDelayMs: 700,
    sidebarResizeEnabled: true,
    sidebarPosition: "left",
    sidebarCheeseFarmHidden: false,
    sidebarPopularCategoriesHidden: false,
    sidebarUpcomingScheduleHidden: false,
    sidebarPartnerStreamersHidden: false,
    sidebarServiceLinksHidden: false,
    followingOfflineHidden: false,
    followingPinEnabled: true,
    followingPinOfflineToTopEnabled: false,
    followingTitleHistoryEnabled: true,
    followingListStateEnabled: false,
    followingRefreshEnabled: true,
    followingRefreshSeconds: 30,
    followingFoldersEnabled: false,
    followingListMaxRows: 0,
    liveStartNotificationsEnabled: false,
    liveStartAutoOpenEnabled: false,
    liveStartButtonEnabled: true,
    liveMultiviewEnabled: false,
    chatMultiviewEnabled: false,
    followingPreviewTooltipEnabled: false,
    followingPreviewSoundEnabled: true,
    followingPreviewVolumePercent: 15,
    livePreviewRightClickSoundEnabled: true,
    screenShortcutsEnabled: false,
    holdSpeedEnabled: true,
    playbackSpeedShortcutsEnabled: true,
    playbackSpeedHalfKeyCode: "BracketLeft",
    playbackSpeedDoubleKeyCode: "BracketRight",
    playbackSpeedResetKeyCode: "Backslash",
};

test("settings exports the expected option defaults and key order", () => {
    assert.deepEqual(settings.DEFAULT_OPTIONS, expectedDefaults);
    assert.deepEqual(settings.OPTION_KEYS, Object.keys(expectedDefaults));
    assert.equal(settings.normalizeOptions({}).adVideoEnabled, true);
    assert.equal(settings.normalizeOptions({ adVideoEnabled: false }).adVideoEnabled, false);
});

test("unreleased ad auto skip ignores stored opt-ins and stays outside automatic injection", () => {
    const normalized = settings.normalizeOptions({ adAutoSkipEnabled: true, adVideoEnabled: true });
    assert.equal(Object.hasOwn(normalized, "adAutoSkipEnabled"), false);
    assert.equal(normalized.adVideoEnabled, true);
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
    assert.equal(
        manifest.content_scripts.some((entry) => entry.js?.includes("features/adAutoSkip.js")),
        false
    );
});

test("the unified popup preference preserves the existing value and ignores the retired guide option", () => {
    for (const enabled of [false, true]) {
        const normalized = settings.normalizeOptions({
            adblockPopupEnabled: enabled,
            autoQualityEnabled: false,
            autoQualityDismissInstallGuide: !enabled,
        });
        assert.equal(normalized.adblockPopupEnabled, enabled);
        assert.equal(Object.hasOwn(normalized, "autoQualityDismissInstallGuide"), false);
    }
});

test("feature count keys are derived from feature toggles only", () => {
    assert.deepEqual(settings.FEATURE_KEYS, [
        "autoQualityEnabled",
        "rewardAutoCollectEnabled",
        "skipControlEnabled",
        "volumeWheelEnabled",
        "volumeTooltipEnabled",
        "playerZoomEnabled",
        "ambientEnabled",
        "hideLiveBadgeEnabled",
        "playerClipHidden",
        "playerPipHidden",
        "liveStartTimeEnabled",
        "offlineLiveReloadEnabled",
        "audioCompressorEnabled",
        "vodBroadcastClockEnabled",
        "timeMachineLagLabelEnabled",
        "streamInfoEnabled",
        "adblockPopupEnabled",
        "headerStudioHidden",
        "headerCheeseHidden",
        "headerNotificationHidden",
        "adVideoEnabled",
        "adBannerEnabled",
        "monthlyBroadcastTimeEnabled",
        "channelChatLinkEnabled",
        "liveWatchHistoryEnabled",
        "liveWatchHistoryChatEnabled",
        "liveWatchHistoryDonationEnabled",
        "vodCommentTabsEnabled",
        "chatResizeEnabled",
        "chatTimestampEnabled",
        "vodChatTimestampEnabled",
        "vodOwnChatHighlightEnabled",
        "chatWeeklyRankingHidden",
        "chatWelcomeMessageRemovalEnabled",
        "chatToolsShowBlindEnabled",
        "chatToolsModeratorBoxEnabled",
        "videoSearchEnabled",
        "categoryToolsEnabled",
        "globalLiveCountEnabled",
        "titleTooltipEnabled",
        "sidebarResizeEnabled",
        "sidebarCheeseFarmHidden",
        "sidebarPopularCategoriesHidden",
        "sidebarUpcomingScheduleHidden",
        "sidebarPartnerStreamersHidden",
        "sidebarServiceLinksHidden",
        "followingOfflineHidden",
        "followingPinEnabled",
        "followingTitleHistoryEnabled",
        "followingListStateEnabled",
        "followingRefreshEnabled",
        "followingFoldersEnabled",
        "liveStartNotificationsEnabled",
        "liveStartAutoOpenEnabled",
        "liveStartButtonEnabled",
        "liveMultiviewEnabled",
        "chatMultiviewEnabled",
        "followingPreviewTooltipEnabled",
        "screenShortcutsEnabled",
        "holdSpeedEnabled",
        "playbackSpeedShortcutsEnabled",
    ]);
});

test("panel resize defaults on for empty and legacy settings and keeps independent explicit opt-outs", () => {
    for (const raw of [{}, { chatToolsEnabled: false, followingPinEnabled: false, vodCommentTabsEnabled: false }]) {
        const normalized = settings.normalizeOptions(raw);
        assert.equal(normalized.chatResizeEnabled, true);
        assert.equal(normalized.sidebarResizeEnabled, true);
    }
    for (const chat of [false, true]) {
        for (const sidebar of [false, true]) {
            const normalized = settings.normalizeOptions({ chatResizeEnabled: chat, sidebarResizeEnabled: sidebar });
            assert.equal(normalized.chatResizeEnabled, chat);
            assert.equal(normalized.sidebarResizeEnabled, sidebar);
        }
    }
});

test("panel placement and list heights accept only declared choices and bounded values", () => {
    for (const chatPosition of ["right", "left"]) {
        assert.equal(settings.normalizeOptions({ chatPosition }).chatPosition, chatPosition);
    }
    for (const sidebarPosition of ["left", "right"]) {
        assert.equal(settings.normalizeOptions({ sidebarPosition }).sidebarPosition, sidebarPosition);
    }
    for (const invalid of [undefined, null, "", "top", "LEFT", 1, true]) {
        const normalized = settings.normalizeOptions({ chatPosition: invalid, sidebarPosition: invalid });
        assert.equal(normalized.chatPosition, "right");
        assert.equal(normalized.sidebarPosition, "left");
    }
    assert.equal(settings.normalizeOptions({ chatToolsModeratorBoxHeight: 100 }).chatToolsModeratorBoxHeight, 240);
    assert.equal(settings.normalizeOptions({ chatToolsModeratorBoxHeight: 9999 }).chatToolsModeratorBoxHeight, 720);
    assert.equal(settings.normalizeOptions({ chatToolsModeratorBoxHeight: "x" }).chatToolsModeratorBoxHeight, 420);
    assert.equal(settings.normalizeOptions({ followingListMaxRows: -3 }).followingListMaxRows, 0);
    assert.equal(settings.normalizeOptions({ followingListMaxRows: "12" }).followingListMaxRows, 12);
    assert.equal(settings.normalizeOptions({ followingListMaxRows: 500 }).followingListMaxRows, 30);
    // Existing users keep the native layout until they opt in.
    const legacy = settings.normalizeOptions({ chatResizeEnabled: false, followingPinEnabled: true });
    assert.equal(legacy.chatPosition, "right");
    assert.equal(legacy.sidebarPosition, "left");
    assert.equal(legacy.followingFoldersEnabled, false);
    assert.equal(legacy.chatMultiviewEnabled, false);
});

test("preferred quality accepts only supported choices and retains the existing default", () => {
    for (const quality of ["1080p", "720p", "480p"]) {
        assert.equal(settings.normalizeOptions({ autoQualityPreferred: quality }).autoQualityPreferred, quality);
    }
    for (const quality of [undefined, null, "auto", "1440p", 720]) {
        assert.equal(settings.normalizeOptions({ autoQualityPreferred: quality }).autoQualityPreferred, "1080p");
    }
});

test("normalizeOptions preserves boolean parsing and integer bounds", () => {
    const normalized = settings.normalizeOptions({
        autoQualityEnabled: "false",
        skipSeconds: -1,
        skipWheelStep: 999,
        skipWheelShiftStep: "2.4",
        volumeWheelStep: 999,
        audioCompressorThreshold: -999,
        audioCompressorRatio: 99,
        audioCompressorAttack: 0.12345,
        audioCompressorMakeupGain: 99,
        monthlyBroadcastTimeMaxCalendarPages: 9999,
        videoSearchCommentDelayMs: -2,
        chatToolsMaxModeratorMessages: 9999,
        categoryToolsFollowerFilterPreset1: "50000000",
        categoryToolsDurationFilterPreset1: "0",
        categoryToolsDurationFilterPreset6: "999",
        categoryToolsFollowerFetchConcurrency: "0",
        followingPreviewVolumePercent: 200,
        playbackSpeedHalfKeyCode: "KeyQ",
        playbackSpeedDoubleKeyCode: "KeyW",
    });

    assert.equal(normalized.autoQualityEnabled, false);
    assert.equal(normalized.skipSeconds, settings.DEFAULT_SKIP_SECONDS);
    assert.equal(normalized.skipWheelStep, 60);
    assert.equal(normalized.skipWheelShiftStep, 2);
    assert.equal(normalized.volumeWheelStep, 50);
    assert.equal(normalized.audioCompressorThreshold, -60);
    assert.equal(normalized.audioCompressorRatio, 20);
    assert.equal(normalized.audioCompressorAttack, 0.123);
    assert.equal(normalized.audioCompressorMakeupGain, 3);
    assert.equal(normalized.monthlyBroadcastTimeMaxCalendarPages, settings.MONTHLY_CALENDAR_MAX_PAGES);
    assert.equal(normalized.videoSearchCommentDelayMs, 0);
    assert.equal(normalized.chatToolsMaxModeratorMessages, settings.CHAT_TOOLS_MAX_MODERATOR_MESSAGES);
    assert.equal(normalized.categoryToolsFollowerFilterPreset1, 10000000);
    assert.equal(normalized.categoryToolsDurationFilterPreset1, 1);
    assert.equal(normalized.categoryToolsDurationFilterPreset6, 168);
    assert.equal(normalized.categoryToolsFollowerFetchConcurrency, 1);
    assert.equal(normalized.followingPreviewVolumePercent, 100);
    assert.equal(normalized.playbackSpeedHalfKeyCode, "KeyQ");
    assert.equal(normalized.playbackSpeedDoubleKeyCode, "KeyW");
    assert.equal(settings.normalizeOptions({ followingPreviewVolumePercent: 0 }).followingPreviewVolumePercent, 1);
});

test("playback speed shortcut codes reject reserved, invalid, and duplicate keys", () => {
    assert.equal(settings.isPlaybackSpeedShortcutCode("KeyQ"), true);
    assert.equal(settings.isPlaybackSpeedShortcutCode("BracketLeft"), true);
    for (const code of [
        "Space",
        "KeyC",
        "KeyF",
        "KeyJ",
        "KeyK",
        "KeyL",
        "KeyM",
        "KeyT",
        "ArrowLeft",
        "ArrowRight",
        "Comma",
        "Period",
    ]) {
        assert.equal(settings.isPlaybackSpeedShortcutCode(code), false, `${code} must stay reserved`);
    }

    const invalid = settings.normalizeOptions({
        playbackSpeedHalfKeyCode: " KeyM ",
        playbackSpeedDoubleKeyCode: "Unidentified",
    });
    const previousSubtitleKey = settings.normalizeOptions({ playbackSpeedHalfKeyCode: "KeyC" });
    assert.equal(previousSubtitleKey.playbackSpeedHalfKeyCode, settings.DEFAULT_PLAYBACK_SPEED_HALF_KEY_CODE);
    assert.equal(invalid.playbackSpeedHalfKeyCode, settings.DEFAULT_PLAYBACK_SPEED_HALF_KEY_CODE);
    assert.equal(invalid.playbackSpeedDoubleKeyCode, settings.DEFAULT_PLAYBACK_SPEED_DOUBLE_KEY_CODE);

    const duplicate = settings.normalizeOptions({
        playbackSpeedHalfKeyCode: "KeyQ",
        playbackSpeedDoubleKeyCode: "KeyQ",
    });
    assert.equal(duplicate.playbackSpeedHalfKeyCode, settings.DEFAULT_PLAYBACK_SPEED_HALF_KEY_CODE);
    assert.equal(duplicate.playbackSpeedDoubleKeyCode, settings.DEFAULT_PLAYBACK_SPEED_DOUBLE_KEY_CODE);
    assert.equal(settings.getPlaybackSpeedShortcutLabel("BracketLeft"), "[");
    assert.equal(settings.getPlaybackSpeedShortcutLabel("Numpad7"), "Num 7");
});

test("removed chat tools master toggle migrates its previous disabled and enabled states", () => {
    const previouslyDisabled = settings.normalizeOptions({
        chatToolsEnabled: false,
        chatToolsShowBlindEnabled: true,
        chatToolsModeratorBoxEnabled: true,
    });
    const previouslyEnabled = settings.normalizeOptions({
        chatToolsEnabled: true,
        chatToolsShowBlindEnabled: true,
        chatToolsModeratorBoxEnabled: true,
    });

    assert.equal(settings.OPTION_KEYS.includes("chatToolsEnabled"), false);
    assert.equal(previouslyDisabled.chatToolsShowBlindEnabled, false);
    assert.equal(previouslyDisabled.chatToolsModeratorBoxEnabled, false);
    assert.equal(previouslyEnabled.chatToolsShowBlindEnabled, true);
    assert.equal(previouslyEnabled.chatToolsModeratorBoxEnabled, true);
});

function createSettingsWorker(sync) {
    const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const queues = new Map();
    const locks = {
        request(name, callback) {
            const pending = (queues.get(name) || Promise.resolve()).then(callback);
            queues.set(
                name,
                pending.catch(() => {})
            );
            return pending;
        },
    };
    const area = (data) => ({
        get(keys, callback) {
            const names =
                keys === null || keys === undefined
                    ? Object.keys(data)
                    : typeof keys === "object" && !Array.isArray(keys)
                      ? Object.keys(keys)
                      : [].concat(keys);
            const values = typeof keys === "object" && keys && !Array.isArray(keys) ? { ...keys } : {};
            for (const key of names) if (Object.hasOwn(data, key)) values[key] = structuredClone(data[key]);
            setImmediate(() => callback(values));
        },
        set(values, callback) {
            setImmediate(() => {
                Object.assign(data, structuredClone(values));
                callback?.();
            });
        },
        remove(keys, callback) {
            setImmediate(() => {
                for (const key of [].concat(keys)) delete data[key];
                callback?.();
            });
        },
    });
    let installed;
    const stored = { ...sync };
    const chrome = {
        runtime: {
            id: "fixture-extension",
            getURL: (file) => `chrome-extension://fixture-extension/${file}`,
            getManifest: () => ({ version: "1.4.4" }),
            lastError: undefined,
            onInstalled: { addListener: (listener) => (installed = listener) },
            onMessage: { addListener() {} },
        },
        storage: { onChanged: { addListener() {} }, sync: area(stored), local: area({}) },
    };
    const context = vm.createContext({ chrome, navigator: { locks }, URL, console, setTimeout, clearTimeout });
    context.importScripts = (...files) =>
        files.forEach((file) => vm.runInContext(read(file), context, { filename: file }));
    vm.runInContext(read("background.js"), context, { filename: "background.js" });
    return {
        stored,
        install: (details) => installed(details),
        openExtensionPage() {
            const page = vm.createContext({
                chrome,
                navigator: { locks },
                location: { protocol: "chrome-extension:" },
            });
            vm.runInContext(read("shared/settings.js"), page, { filename: "shared/settings.js" });
            page.CheeseSpannerSettings.getOptions(() => {});
        },
    };
}

async function settleStorage() {
    for (let index = 0; index < 40; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("worker update keeps the chat tool choices of the removed master toggle", async () => {
    for (const [legacyEnabled, moderatorBox] of [
        [true, true],
        [false, false],
    ]) {
        const worker = createSettingsWorker({ chatToolsEnabled: legacyEnabled });
        worker.install({ reason: "update", previousVersion: "1.2.3" });
        await settleStorage();
        assert.equal(worker.stored.chatToolsModeratorBoxEnabled, moderatorBox);
        assert.equal(worker.stored.chatToolsShowBlindEnabled, false);
        assert.equal(settings.normalizeOptions(worker.stored).chatToolsModeratorBoxEnabled, moderatorBox);

        // The extension page later retires the legacy key without changing what the worker stored.
        worker.openExtensionPage();
        await settleStorage();
        assert.equal(Object.hasOwn(worker.stored, "chatToolsEnabled"), false);
        assert.equal(worker.stored.chatToolsModeratorBoxEnabled, moderatorBox);
        assert.equal(worker.stored.chatToolsShowBlindEnabled, false);
    }
});

test("options.html data-option keys match the settings keys", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "options.html"), "utf8");
    const dataOptionKeys = Array.from(html.matchAll(/data-option="([^"]+)"/g), (match) => match[1]);
    const uniqueDataOptionKeys = Array.from(new Set(dataOptionKeys));

    assert.equal(dataOptionKeys.length, uniqueDataOptionKeys.length);
    assert.deepEqual(uniqueDataOptionKeys.sort(), [...settings.OPTION_KEYS].sort());
});

test("speed reset key is customizable and all key pairs reject collisions", () => {
    assert.equal(settings.normalizeOptions({ playbackSpeedResetKeyCode: "KeyR" }).playbackSpeedResetKeyCode, "KeyR");
    assert.equal(
        settings.normalizeOptions({ playbackSpeedResetKeyCode: "KeyC" }).playbackSpeedResetKeyCode,
        "Backslash"
    );
    const keys = ["playbackSpeedHalfKeyCode", "playbackSpeedDoubleKeyCode", "playbackSpeedResetKeyCode"];
    for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
            const options = settings.normalizeOptions({ [keys[i]]: "KeyQ", [keys[j]]: "KeyQ" });
            assert.deepEqual(
                keys.map((key) => options[key]),
                ["BracketLeft", "BracketRight", "Backslash"]
            );
        }
    }
    const legacy = settings.normalizeOptions({ playbackSpeedHalfKeyCode: "KeyQ", playbackSpeedDoubleKeyCode: "KeyW" });
    assert.deepEqual(
        keys.map((key) => legacy[key]),
        ["KeyQ", "KeyW", "Backslash"]
    );
    const legacyConflict = settings.normalizeOptions({ playbackSpeedHalfKeyCode: "Backslash" });
    assert.deepEqual(
        keys.map((key) => legacyConflict[key]),
        ["BracketLeft", "BracketRight", "Backslash"]
    );
});
