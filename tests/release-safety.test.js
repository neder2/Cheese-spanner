const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");

const runtimeFiles = ["manifest.json", "background.js", "content.js", "history.js", "options.js"];
const runtimeDirs = ["shared", "features", "vendor"];
const followingPreviewFiles = ["features/followingPreviewTooltip.js"];
const followingPreviewMuxedMasterManifest = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=854x480,CODECS="avc1.64001f,mp4a.40.2"',
    "chunklist_480p.m3u8",
].join("\n");
const forbiddenPatterns = [
    {
        label: ["PLAYER", "VENDOR", "FALLBACK", "URL"].join("_"),
        pattern: new RegExp(["PLAYER", "VENDOR", "FALLBACK", "URL"].join("_")),
    },
    {
        label: ["import", "Player", "Vendor", "Runtime"].join(""),
        pattern: new RegExp(["import", "Player", "Vendor", "Runtime"].join("")),
    },
    {
        label: "dynamic import",
        pattern: /\bimport\s*\(/,
    },
    {
        label: `src${"doc"}`,
        pattern: new RegExp(`\\bsrc${"doc"}\\b`),
    },
    {
        label: "eval(",
        pattern: /\beval\s*\(/,
    },
    {
        label: ["new", "Function"].join(" "),
        pattern: new RegExp(`\\bnew\\s+${"Function"}\\b`),
    },
];
const followingPreviewForbiddenPatterns = [
    {
        label: "window.open",
        pattern: /window\.open/,
    },
    {
        label: "chrome.tabs.create",
        pattern: /chrome\.tabs\.create/,
    },
    {
        label: "chrome.windows.create",
        pattern: /chrome\.windows\.create/,
    },
    {
        label: "blank target fallback",
        pattern: /target\s*=\s*["']_blank["']/,
    },
    {
        label: "iframe fallback",
        pattern: /createElement\(["']iframe["']\)|bcfp-player-frame|srcdoc/i,
    },
    {
        label: "player vendor import",
        pattern: /player-vendor|\bimport\s*\(/i,
    },
    {
        label: "eval(",
        pattern: /\beval\s*\(/,
    },
    {
        label: ["new", "Function"].join(" "),
        pattern: new RegExp(`\\bnew\\s+${"Function"}\\b`),
    },
];

function readRepoFile(...parts) {
    return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

function collectJsFiles(dir) {
    const absoluteDir = path.join(repoRoot, dir);
    const files = [];

    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
        const relativePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectJsFiles(relativePath));
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
            files.push(relativePath);
        }
    }

    return files;
}

test("runtime files must not contain remote-hosted executable code patterns", () => {
    const files = [...runtimeFiles, ...runtimeDirs.flatMap(collectJsFiles)];
    const violations = [];

    for (const file of files) {
        const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
        for (const { label, pattern } of forbiddenPatterns) {
            if (pattern.test(source)) violations.push(`${file}: ${label}`);
        }
    }

    assert.deepEqual(
        violations,
        [],
        `runtime files must not contain remote-hosted executable code patterns:\n${violations.join("\n")}`
    );
});

test("following preview must not fall back to popup, window, iframe, or remote JS execution", () => {
    const violations = [];

    for (const file of followingPreviewFiles) {
        const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
        for (const { label, pattern } of followingPreviewForbiddenPatterns) {
            if (pattern.test(source)) violations.push(`${file}: ${label}`);
        }
    }

    assert.deepEqual(
        violations,
        [],
        `following preview must not contain forbidden fallback patterns:\n${violations.join("\n")}`
    );
});

test("following preview hls.light fixture must stay on muxed master audio", () => {
    assert.doesNotMatch(followingPreviewMuxedMasterManifest, /^#EXT-X-MEDIA:.*TYPE=AUDIO/im);
    assert.match(followingPreviewMuxedMasterManifest, /^#EXT-X-STREAM-INF:.*CODECS="[^"]*mp4a/im);
});

test("low-risk fallback reductions stay removed", () => {
    const videoSearchSource = fs.readFileSync(path.join(repoRoot, "features/videoSearch.js"), "utf8");
    const categoryToolsSource = fs.readFileSync(path.join(repoRoot, "features/categoryTools.js"), "utf8");

    assert.doesNotMatch(videoSearchSource, /COMMENT_MATCH_FALLBACK_TEXT/);
    assert.doesNotMatch(videoSearchSource, /createFallbackPlaybackProgress/);
    assert.doesNotMatch(categoryToolsSource, /touchMapEntry\(followerCache,\s*channelId,\s*0/);
});

test("optimization guards stay in the hot paths", () => {
    const autoQualityPageSource = fs.readFileSync(path.join(repoRoot, "features/autoQualityPage.js"), "utf8");
    const categoryToolsSource = fs.readFileSync(path.join(repoRoot, "features/categoryTools.js"), "utf8");
    const chatToolsSource = fs.readFileSync(path.join(repoRoot, "features/chatTools.js"), "utf8");
    const liveWatchHistorySource = fs.readFileSync(path.join(repoRoot, "features/liveWatchHistory.js"), "utf8");
    const monthlyBroadcastTimeSource = fs.readFileSync(path.join(repoRoot, "features/monthlyBroadcastTime.js"), "utf8");
    const videoSearchSource = fs.readFileSync(path.join(repoRoot, "features/videoSearch.js"), "utf8");

    assert.doesNotMatch(autoQualityPageSource, /querySelectorAll\(["']\*["']\)/);
    assert.match(autoQualityPageSource, /function startPageAutoApply[\s\S]{0,260}hasStableVodApply\(\)/);
    assert.match(categoryToolsSource, /createThrottledDomSync\(runScheduledApply,\s*160\)/);
    assert.match(monthlyBroadcastTimeSource, /createThrottledDomSync\(runScheduledMount,\s*160\)/);
    assert.match(videoSearchSource, /createThrottledDomSync\(runScheduledMount,\s*160\)/);
    assert.doesNotMatch(monthlyBroadcastTimeSource, /scheduleFallbackTimer|let scheduled = false/);
    assert.match(categoryToolsSource, /lastBadgeScrollCheckAt = now;\s*void refreshFollowerHydrationRows\(\);/);
    assert.match(
        categoryToolsSource,
        /rememberVisibleRows\(visible\);[\s\S]{0,240}syncLiveElapsedBadges\(route, rows\);[\s\S]{0,120}syncFollowerBadges\(route, rows\);/
    );
    assert.doesNotMatch(
        categoryToolsSource,
        /rememberFollowerRefreshRows\(route, rows\);[\s\S]{0,220}syncFollowerBadges\(route, rows\);[\s\S]{0,220}const candidateRows = \[\]/
    );
    assert.match(categoryToolsSource, /const injectedEntries = \[\]/);
    assert.match(categoryToolsSource, /entries = entries\.concat\(injectedEntries\)/);
    assert.doesNotMatch(
        categoryToolsSource,
        /await syncInjectedCards[\s\S]{0,160}entries = getCardEntries\(route, scanContext\)/
    );
    assert.match(chatToolsSource, /hasAttribute\(BLIND_PROCESSED_ATTR\)/);
    assert.match(chatToolsSource, /hasAttribute\(MODERATOR_COLLECTED_ATTR\)/);
    assert.match(chatToolsSource, /createThrottledDomSync\(syncChatTools/);
    assert.match(liveWatchHistorySource, /const updatedEntry = updater\(history\);/);
    assert.match(liveWatchHistorySource, /pruneHistory\(history, updatedEntry\);/);
    assert.doesNotMatch(liveWatchHistorySource, /for\s*\(\s*const entry of Object\.values\(history\.entries\)/);
});

test("audio compressor third-party notices stay present", () => {
    const notices = readRepoFile("THIRD_PARTY_NOTICES.md");
    const volumeTooltipSource = readRepoFile("features", "volumeTooltip.js");

    assert.match(notices, /jebibot/);
    assert.match(notices, /MIT License/);
    assert.match(volumeTooltipSource, /cheese-knife/);
    assert.match(volumeTooltipSource, /jebibot/);
});
