const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

require("../shared/settings.js");

const settings = globalThis.BetterChzzkSettings;

const expectedDefaults = {
    autoQualityEnabled: true,
    rewardAutoCollectEnabled: true,
    rewardAutoCollectDelayMs: 800,
    skipControlEnabled: true,
    skipKeyboardEnabled: true,
    skipPillEnabled: true,
    skipLivePillEnabled: true,
    skipLivePauseResumeEnabled: true,
    skipLivePauseResumeDepthMinutes: 120,
    skipSeconds: 5,
    skipWheelStep: 1,
    skipWheelShiftStep: 5,
    skipWheelAltStep: 10,
    volumeWheelEnabled: true,
    volumeWheelStep: 5,
    volumeTooltipEnabled: false,
    audioCompressorEnabled: false,
    audioCompressorThreshold: -24,
    audioCompressorKnee: 30,
    audioCompressorRatio: 12,
    audioCompressorAttack: 0.003,
    audioCompressorRelease: 0.25,
    audioCompressorMakeupGain: 1,
    vodBroadcastClockEnabled: false,
    timeMachineLagLabelEnabled: true,
    adblockPopupEnabled: true,
    monthlyBroadcastTimeEnabled: true,
    monthlyBroadcastTimeWindowDays: 30,
    monthlyBroadcastTimeMaxPages: 12,
    monthlyBroadcastTimeCalendarEnabled: true,
    monthlyBroadcastTimeMaxCalendarPages: 60,
    liveWatchHistoryEnabled: true,
    liveWatchHistoryMinMinutes: 1,
    chatToolsEnabled: false,
    chatToolsShowBlindEnabled: false,
    chatToolsModeratorBoxEnabled: true,
    chatToolsCacheModeratorMessagesEnabled: false,
    chatToolsMaxModeratorMessages: 100,
    videoSearchEnabled: true,
    videoSearchCommentEnabled: true,
    videoSearchMaxPages: 80,
    videoSearchRenderBatchSize: 80,
    videoSearchCommentDelayMs: 1000,
    videoSearchCommentMaxVideos: 60,
    videoSearchCommentMaxPagesPerVideo: 1,
    categoryToolsEnabled: true,
    titleTooltipEnabled: true,
    categoryToolsMaxMetadataPages: 12,
    categoryToolsHideGlobalTagSearch: true,
    categoryToolsFollowerBadgesEnabled: true,
    categoryToolsLiveElapsedEnabled: true,
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
    categoryToolsFollowerFetchMaxPerPass: 6,
    categoryToolsFollowerFetchConcurrency: 2,
    categoryToolsFollowerFetchDelayMs: 700,
    followingRefreshEnabled: true,
    followingRefreshSeconds: 30,
    followingPreviewTooltipEnabled: true,
    followingPreviewSoundEnabled: true,
    shortcutRescueEnabled: true,
};

test("settings exports the expected option defaults and key order", () => {
    assert.deepEqual(settings.DEFAULT_OPTIONS, expectedDefaults);
    assert.deepEqual(settings.OPTION_KEYS, Object.keys(expectedDefaults));
});

test("feature count keys are derived from feature toggles only", () => {
    assert.deepEqual(settings.FEATURE_KEYS, [
        "autoQualityEnabled",
        "rewardAutoCollectEnabled",
        "skipControlEnabled",
        "volumeWheelEnabled",
        "volumeTooltipEnabled",
        "audioCompressorEnabled",
        "vodBroadcastClockEnabled",
        "timeMachineLagLabelEnabled",
        "adblockPopupEnabled",
        "monthlyBroadcastTimeEnabled",
        "liveWatchHistoryEnabled",
        "chatToolsEnabled",
        "videoSearchEnabled",
        "categoryToolsEnabled",
        "titleTooltipEnabled",
        "followingRefreshEnabled",
        "followingPreviewTooltipEnabled",
        "shortcutRescueEnabled",
    ]);
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
        rewardAutoCollectDelayMs: 9999,
        chatToolsMaxModeratorMessages: 9999,
        categoryToolsFollowerFilterPreset1: "50000000",
        categoryToolsFollowerFetchConcurrency: "0",
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
    assert.equal(normalized.rewardAutoCollectDelayMs, settings.REWARD_AUTO_COLLECT_DELAY_MS_MAX);
    assert.equal(normalized.chatToolsMaxModeratorMessages, settings.CHAT_TOOLS_MAX_MODERATOR_MESSAGES);
    assert.equal(normalized.categoryToolsFollowerFilterPreset1, 10000000);
    assert.equal(normalized.categoryToolsFollowerFetchConcurrency, 1);
});

test("options.html data-option keys match the settings keys", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "options.html"), "utf8");
    const dataOptionKeys = Array.from(html.matchAll(/data-option="([^"]+)"/g), (match) => match[1]);
    const uniqueDataOptionKeys = Array.from(new Set(dataOptionKeys));

    assert.equal(dataOptionKeys.length, uniqueDataOptionKeys.length);
    assert.deepEqual(uniqueDataOptionKeys.sort(), [...settings.OPTION_KEYS].sort());
});
