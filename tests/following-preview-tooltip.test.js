const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repoRoot = path.join(__dirname, "..");
const openDoms = new Set();

test.afterEach(() => {
    for (const dom of openDoms) dom.window.close();
    openDoms.clear();
});

function readRepoFile(...parts) {
    return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

function createStorageArea(initialData = {}) {
    const data = { ...initialData };

    return {
        data,
        get(keys, callback) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                if (Object.hasOwn(data, key)) result[key] = data[key];
            }
            setTimeout(() => callback(result), 0);
        },
        set(values, callback) {
            Object.assign(data, values || {});
            setTimeout(() => callback?.(), 0);
        },
    };
}

function createFakeChrome({ sync = {} } = {}) {
    // 기본값이 꺼짐인 기능이므로, 동작 테스트에서는 켜진 상태를 명시적으로 시드한다.
    const syncArea = createStorageArea({ followingPreviewTooltipEnabled: true, ...sync });
    const storageChangeListeners = [];

    return {
        runtime: {},
        storage: {
            sync: syncArea,
            onChanged: {
                addListener(listener) {
                    storageChangeListeners.push(listener);
                },
                removeListener(listener) {
                    const index = storageChangeListeners.indexOf(listener);
                    if (index >= 0) storageChangeListeners.splice(index, 1);
                },
            },
        },
        testState: {
            sync: syncArea.data,
            storageChangeListeners,
        },
    };
}

function createPageDom(html, url, chrome = createFakeChrome()) {
    const dom = new JSDOM(html, {
        url,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });

    dom.window.chrome = chrome;
    dom.window.fetch = async () => {
        throw new Error("Unexpected network request in following preview test");
    };

    openDoms.add(dom);
    return dom;
}

function evalRepoScript(dom, ...parts) {
    dom.window.eval(readRepoFile(...parts));
}

function waitForAsyncCallbacks() {
    return new Promise((resolve) => setTimeout(resolve, 20));
}

function waitForFollowingPreviewDelay() {
    return waitForAsyncCallbacks();
}

function waitForFollowingPreviewFetchDelay() {
    return new Promise((resolve) => setTimeout(resolve, 140));
}

function waitForFollowingPlaybackDelay() {
    return new Promise((resolve) => setTimeout(resolve, 360));
}

function evalFollowingPreviewTooltipScripts(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "followingPreviewTooltip.js");
}

function installFakeHls(
    dom,
    { levels = [{ height: 720 }, { height: 480 }, { height: 360 }], playHandler = null } = {}
) {
    const state = {
        destroyed: [],
        instances: [],
        loadSources: [],
        playCalls: [],
    };

    class FakeHls {
        static isSupported() {
            return true;
        }

        constructor(config) {
            this.config = config;
            this.handlers = {};
            this.levels = levels;
            this.autoLevelCapping = -1;
            this.startLevel = -1;
            this.nextLevel = -1;
            state.instances.push(this);
        }

        on(event, handler) {
            this.handlers[event] = handler;
        }

        attachMedia(video) {
            this.media = video;
        }

        loadSource(url) {
            this.source = url;
            state.loadSources.push(url);
            this.handlers[FakeHls.Events.MANIFEST_PARSED]?.("hlsManifestParsed", {});
        }

        destroy() {
            this.destroyed = true;
            state.destroyed.push(this);
        }
    }

    FakeHls.Events = {
        ERROR: "hlsError",
        MANIFEST_PARSED: "hlsManifestParsed",
    };

    dom.window.Hls = FakeHls;
    dom.window.HTMLMediaElement.prototype.play = function play() {
        state.playCalls.push(this);
        if (playHandler) return playHandler.call(this, state);
        this.dispatchEvent(new dom.window.Event("playing"));
        return Promise.resolve();
    };
    dom.window.HTMLMediaElement.prototype.pause = function pause() {};
    dom.window.HTMLMediaElement.prototype.load = function load() {};

    return state;
}

function createFollowingPreviewDom(chrome = createFakeChrome()) {
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div id="app">',
            '<nav class="sidebar">',
            '<section id="following">',
            "<header>",
            "<strong>\uD314\uB85C\uC789 \uCC44\uB110</strong>",
            '<a href="/following?tab=LIVE">\uC804\uCCB4\uBCF4\uAE30</a>',
            "</header>",
            "<ul>",
            '<li class="following_item" id="followingItem">',
            '<a id="liveLink" href="/live/channel-123" aria-label="\uD14C\uC2A4\uD2B8 \uCC44\uB110">',
            '<img class="live_thumbnail_image" src="https://example.com/dom-thumb.jpg" alt="">',
            '<span class="name_text">\uD14C\uC2A4\uD2B8 \uCC44\uB110</span>',
            '<span class="live_title">DOM \uBC29\uC1A1 \uC81C\uBAA9</span>',
            "</a>",
            "</li>",
            "</ul>",
            "</section>",
            "</nav>",
            '<main><article><a id="mainLiveLink" href="/live/main-channel">MAIN LIVE</a></article></main>',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/",
        chrome
    );
    const { document } = dom.window;
    const item = document.getElementById("followingItem");
    const link = document.getElementById("liveLink");

    item.getBoundingClientRect = () => ({
        left: 12,
        top: 80,
        right: 196,
        bottom: 132,
        width: 184,
        height: 52,
    });
    link.getBoundingClientRect = item.getBoundingClientRect;

    return { document, dom, item, link };
}

test("manifest loads following preview after following refresh without the page bridge", () => {
    const manifest = JSON.parse(readRepoFile("manifest.json"));
    const mainScript = manifest.content_scripts.find((entry) => entry.world === "MAIN");
    const isolatedScript = manifest.content_scripts.find((entry) =>
        entry.js?.includes("features/followingPreviewTooltip.js")
    );

    assert.equal(
        manifest.content_scripts.some((entry) => entry.js?.includes("features/followingPreviewFrame.js")),
        false
    );
    assert.equal(
        manifest.content_scripts.some((entry) => entry.js?.includes("features/followingPreviewPage.js")),
        false
    );
    assert.ok(manifest.optional_host_permissions.includes("https://*.pstatic.net/*"));
    assert.ok(!manifest.host_permissions.includes("https://*.pstatic.net/*"));
    assert.ok(mainScript.js.includes("features/routeBridgePage.js"));
    assert.ok(mainScript.js.includes("features/autoQualityPage.js"));
    assert.ok(isolatedScript.js.includes("vendor/hls.light.min.js"));
    assert.ok(isolatedScript.js.includes("features/followingPreviewTooltip.js"));
    assert.ok(
        isolatedScript.js.indexOf("vendor/hls.light.min.js") <
            isolatedScript.js.indexOf("features/followingPreviewTooltip.js")
    );
    assert.ok(
        isolatedScript.js.indexOf("features/followingPreviewTooltip.js") >
            isolatedScript.js.indexOf("features/followingRefresh.js")
    );
    assert.ok(
        isolatedScript.js.indexOf("features/shortcutRescue.js") >
            isolatedScript.js.indexOf("features/followingPreviewTooltip.js")
    );
});

test("following preview delays live-detail fetches while opening the DOM card immediately", async () => {
    const chrome = createFakeChrome();
    const { document, dom, item, link } = createFollowingPreviewDom(chrome);
    const calls = [];

    dom.window.fetch = (url, init) => {
        calls.push({ init, url });
        return new Promise(() => {});
    };

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));

    let tip = document.getElementById("betterchzzk-following-preview");
    assert.ok(tip);
    assert.equal(tip.getAttribute("data-show"), "1");
    assert.equal(tip.dataset.state, "loading");
    assert.equal(tip.querySelector(".bcfp-title").textContent, "DOM \uBC29\uC1A1 \uC81C\uBAA9");
    assert.equal(item.getAttribute("data-bcfp-active"), "1");
    assert.equal(calls.length, 0);

    link.dispatchEvent(new dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    await waitForFollowingPreviewFetchDelay();
    await waitForAsyncCallbacks();

    assert.equal(calls.length, 0);
    assert.equal(tip.hasAttribute("data-show"), false);
    assert.equal(item.hasAttribute("data-bcfp-active"), false);

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    tip = document.getElementById("betterchzzk-following-preview");
    assert.ok(tip);
    assert.equal(calls.length, 0);

    await waitForFollowingPreviewFetchDelay();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.chzzk.naver.com/service/v2/channels/channel-123/live-detail");
    assert.equal(calls[0].init.signal.aborted, false);
});

test("following preview loading card prefers live thumbnails over channel profile images", async () => {
    const chrome = createFakeChrome();
    const { document, dom, link } = createFollowingPreviewDom(chrome);
    const profileImage = link.querySelector("img");
    const liveThumbnail = document.createElement("img");

    profileImage.className = "channel_profile_image";
    profileImage.src = "https://example.com/channel-profile.jpg";
    liveThumbnail.className = "live_thumbnail_image";
    liveThumbnail.src = "https://example.com/live-thumbnail.jpg";
    link.insertBefore(liveThumbnail, link.querySelector(".name_text"));
    dom.window.fetch = () => new Promise(() => {});

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForAsyncCallbacks();

    const tip = document.getElementById("betterchzzk-following-preview");
    assert.ok(tip);
    assert.equal(tip.dataset.state, "loading");
    assert.match(tip.querySelector(".bcfp-media img").getAttribute("src"), /live-thumbnail\.jpg/);
    assert.doesNotMatch(tip.querySelector(".bcfp-media img").getAttribute("src"), /channel-profile\.jpg/);
});

test("following preview loading card leaves the media area empty when no live thumbnail exists", async () => {
    const chrome = createFakeChrome();
    const { document, dom, link } = createFollowingPreviewDom(chrome);
    const profileImage = link.querySelector("img");

    profileImage.className = "channel_profile_image";
    profileImage.src = "https://example.com/channel-profile.jpg";
    dom.window.fetch = () => new Promise(() => {});

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForAsyncCallbacks();

    const tip = document.getElementById("betterchzzk-following-preview");
    assert.ok(tip);
    assert.equal(tip.dataset.state, "loading");
    assert.equal(tip.querySelector(".bcfp-media img"), null);
    assert.equal(tip.querySelector(".bcfp-media-fallback"), null);
});

test("following preview loading card does not use verified badges as thumbnails", async () => {
    const chrome = createFakeChrome();
    const { document, dom, link } = createFollowingPreviewDom(chrome);
    const profileImage = link.querySelector("img");
    const verifiedBadge = document.createElement("img");

    profileImage.className = "channel_profile_image";
    profileImage.src = "https://example.com/channel-profile.jpg";
    verifiedBadge.className = "verified_mark_image";
    verifiedBadge.alt = "\uCE58\uC9C0\uC9C1 \uC778\uC99D";
    verifiedBadge.src = "https://example.com/verified-badge.svg";
    link.insertBefore(verifiedBadge, link.querySelector(".live_title"));
    dom.window.fetch = () => new Promise(() => {});

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForAsyncCallbacks();

    const tip = document.getElementById("betterchzzk-following-preview");
    assert.ok(tip);
    assert.equal(tip.dataset.state, "loading");
    assert.equal(tip.querySelector(".bcfp-media img"), null);
    assert.equal(tip.querySelector(".bcfp-media-fallback"), null);
    assert.doesNotMatch(tip.textContent, /verified-badge/);
});

test("following preview plays auto-play-info HLS in the hover card and reuses cache", async () => {
    const chrome = createFakeChrome();
    const { document, dom, item, link } = createFollowingPreviewDom(chrome);
    const hlsState = installFakeHls(dom);
    const calls = [];
    let now = Date.parse("2026-06-23T03:02:03Z");
    const playbackJson = JSON.stringify({
        media: [
            { mediaId: "HLS", path: "https://nvelop-livecloud.pstatic.net/chzzk/live/master.m3u8" },
            {
                mediaId: "LLHLS",
                path: "https://nvelop-livecloud.pstatic.net/chzzk/live/ll.m3u8",
                latency: "lowLatency",
            },
        ],
    });

    dom.window.Date.now = () => now;
    dom.window.fetch = async (url, init) => {
        calls.push({ init, url });
        if (String(url).includes("/live-detail")) {
            return {
                ok: true,
                json: async () => ({
                    content: {
                        liveId: "live-789",
                        liveTitle: "API \uBC29\uC1A1 \uC81C\uBAA9",
                        liveImageUrl: "https://example.com/live-{type}.jpg",
                        liveCategoryValue: "\uAC8C\uC784",
                        concurrentUserCount: 1234,
                        openDate: new Date(now - (3600 + 120 + 3) * 1000).toISOString(),
                        channel: {
                            channelName: "API \uCC44\uB110",
                        },
                    },
                }),
            };
        }

        if (String(url).includes("/auto-play-info")) {
            return {
                ok: true,
                json: async () => ({
                    content: {
                        livePlaybackJson: playbackJson,
                        previewPlaybackJson: "",
                    },
                }),
            };
        }

        throw new Error(`Unexpected URL: ${url}`);
    };

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForAsyncCallbacks();

    let tip = document.getElementById("betterchzzk-following-preview");
    assert.ok(tip);
    assert.equal(tip.getAttribute("data-show"), "1");
    assert.equal(tip.dataset.state, "loading");
    assert.equal(tip.querySelector(".bcfp-title").textContent, "DOM \uBC29\uC1A1 \uC81C\uBAA9");
    assert.match(tip.querySelector(".bcfp-media img").getAttribute("src"), /dom-thumb\.jpg/);

    const source = readRepoFile("features", "followingPreviewTooltip.js");
    assert.match(source, /LIVE_AUTO_PLAY_API_BASE/);
    assert.match(source, /auto-play-info/);
    assert.match(source, /PREVIEW_PLAYBACK_DELAY_MS = 300/);
    assert.match(source, /font-family:system-ui/);
    assert.doesNotMatch(source, /following-preview:play/);
    assert.doesNotMatch(source, /webpackChunkglive_fe_pc/);
    assert.doesNotMatch(source, /LiveProvider\.fromJSON/);
    assert.doesNotMatch(source, /player-vendor/i);
    assert.doesNotMatch(source, /\bimport\s*\(/);
    assert.doesNotMatch(source, /createElement\("iframe"\)/);
    assert.doesNotMatch(source, new RegExp(`src${"doc"}`));
    assert.doesNotMatch(source, /\beval\s*\(/);
    assert.doesNotMatch(source, new RegExp(`\\bnew\\s+${"Function"}\\b`));
    assert.equal(item.getAttribute("data-bcfp-active"), "1");
    assert.equal(calls.length, 0);

    await waitForFollowingPreviewFetchDelay();
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();

    tip = document.getElementById("betterchzzk-following-preview");
    assert.equal(tip.dataset.state, "ready");
    assert.equal(tip.querySelector(".bcfp-channel").textContent, "API \uCC44\uB110");
    assert.equal(tip.querySelector(".bcfp-title").textContent, "API \uBC29\uC1A1 \uC81C\uBAA9");
    assert.match(tip.textContent, /\uAC8C\uC784/);
    assert.doesNotMatch(tip.textContent, /1,234\uBA85/);
    assert.doesNotMatch(tip.querySelector(".bcfp-meta").textContent, /\uBC29\uC1A1|\uBD84\uC9F8|\uBA85/);
    assert.deepEqual(
        Array.from(tip.querySelectorAll(".bcfp-meta span"), (span) => span.textContent),
        ["\uAC8C\uC784", "01:02:03"]
    );
    assert.match(tip.querySelector("[data-bcfp-elapsed='1']").textContent, /^\d{2}:\d{2}:\d{2}$/);
    const video = tip.querySelector("video.bcfp-player");
    assert.ok(video);
    assert.match(video.getAttribute("data-bcfp-player-mount"), /^bcfp/);
    assert.equal(video.getAttribute("data-bcfp-player-state"), "loading");
    assert.equal(video.muted, false);
    assert.equal(video.volume, 0.15);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://api.chzzk.naver.com/service/v2/channels/channel-123/live-detail");
    assert.equal(calls[0].init.credentials, "include");
    assert.equal(calls[1].url, "https://api.chzzk.naver.com/service/v1/live/live-789/auto-play-info");
    assert.equal(calls[1].init.credentials, "include");

    await waitForFollowingPlaybackDelay();

    assert.equal(hlsState.instances.length, 1);
    assert.equal(hlsState.instances[0].config.enableWorker, false);
    assert.equal(hlsState.instances[0].autoLevelCapping, 1);
    assert.equal(hlsState.loadSources[0], "https://nvelop-livecloud.pstatic.net/chzzk/live/master.m3u8");
    assert.equal(hlsState.playCalls[0], video);
    assert.equal(video.getAttribute("data-bcfp-player-state"), "ready");

    now += 2000;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(tip.querySelector("[data-bcfp-elapsed='1']").textContent, "01:02:05");

    link.dispatchEvent(new dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: video }));
    assert.equal(tip.getAttribute("data-show"), "1");

    tip.dispatchEvent(new dom.window.MouseEvent("pointerleave", { bubbles: false, relatedTarget: document.body }));
    assert.equal(tip.hasAttribute("data-show"), false);
    assert.equal(item.hasAttribute("data-bcfp-active"), false);
    assert.equal(hlsState.destroyed.length, 1);

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForAsyncCallbacks();

    tip = document.getElementById("betterchzzk-following-preview");
    assert.equal(tip.getAttribute("data-show"), "1");
    assert.equal(tip.dataset.state, "ready");
    assert.equal(calls.length, 2);
    await waitForFollowingPlaybackDelay();
    assert.equal(hlsState.instances.length, 2);

    link.dispatchEvent(new dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    assert.equal(tip.hasAttribute("data-show"), false);
    assert.equal(item.hasAttribute("data-bcfp-active"), false);
});

function attachMainPlayerVideo(dom, volume) {
    const { document } = dom.window;
    const main = document.querySelector("main") || document.body;
    const video = document.createElement("video");
    video.id = "mainPlayerVideo";
    video.volume = volume;
    video.getBoundingClientRect = () => ({
        width: 800,
        height: 450,
        left: 0,
        top: 0,
        right: 800,
        bottom: 450,
    });
    main.appendChild(video);
    return video;
}

function createSoundPreviewFetch(dom, { liveId }) {
    const playbackJson = JSON.stringify({
        media: [{ mediaId: "HLS", path: "https://example.com/live-sound.m3u8" }],
    });

    return async (url) => {
        if (String(url).includes("/live-detail")) {
            return {
                ok: true,
                json: async () => ({
                    content: {
                        liveId,
                        liveTitle: "API \uBC29\uC1A1 \uC81C\uBAA9",
                        liveImageUrl: "https://example.com/live-{type}.jpg",
                        liveCategoryValue: "\uAC8C\uC784",
                        openDate: new Date(Date.now() - 60 * 1000).toISOString(),
                        channel: {
                            channelName: "API \uCC44\uB110",
                        },
                    },
                }),
            };
        }

        if (String(url).includes("/auto-play-info")) {
            return {
                ok: true,
                json: async () => ({
                    content: {
                        livePlaybackJson: playbackJson,
                    },
                }),
            };
        }

        throw new Error(`Unexpected URL: ${url}`);
    };
}

async function runSoundPreview(dom, link, document) {
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForFollowingPreviewFetchDelay();
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();

    const tip = document.getElementById("betterchzzk-following-preview");
    const video = tip.querySelector("video.bcfp-player");
    assert.ok(video);

    await waitForFollowingPlaybackDelay();
    return { tip, video };
}

test("following preview sound follows the main player volume", async () => {
    const chrome = createFakeChrome({
        sync: {
            followingPreviewSoundEnabled: true,
        },
    });
    const { document, dom, link } = createFollowingPreviewDom(chrome);
    const hlsState = installFakeHls(dom);
    dom.window.fetch = createSoundPreviewFetch(dom, { liveId: "live-sound" });

    evalFollowingPreviewTooltipScripts(dom);
    attachMainPlayerVideo(dom, 0.3);

    const { tip, video } = await runSoundPreview(dom, link, document);

    assert.equal(hlsState.playCalls.length, 1);
    assert.equal(hlsState.playCalls[0], video);
    assert.equal(video.muted, false);
    assert.equal(video.defaultMuted, false);
    assert.equal(video.hasAttribute("muted"), false);
    assert.ok(Math.abs(video.volume - 0.3) < 1e-6);
    assert.equal(tip.querySelector(".bcfp-sound-unlock"), null);
    assert.equal(video.getAttribute("data-bcfp-player-state"), "ready");
});

test("following preview sound falls back to the stored player volume without a main video", async () => {
    const chrome = createFakeChrome({
        sync: {
            followingPreviewSoundEnabled: true,
        },
    });
    const { document, dom, link } = createFollowingPreviewDom(chrome);
    const hlsState = installFakeHls(dom);
    dom.window.fetch = createSoundPreviewFetch(dom, { liveId: "live-stored" });
    dom.window.localStorage.setItem("live-player-volume", '{"value":40}');
    dom.window.localStorage.setItem("embed-player-volume", '{"value":90}');
    dom.window.localStorage.setItem("live-player-volume-muted", "true");

    evalFollowingPreviewTooltipScripts(dom);

    const { video } = await runSoundPreview(dom, link, document);

    assert.equal(hlsState.playCalls.length, 1);
    assert.equal(video.muted, false);
    assert.ok(Math.abs(video.volume - 0.4) < 1e-6);
});

test("following preview sound falls back to the default volume without any source", async () => {
    const chrome = createFakeChrome({
        sync: {
            followingPreviewSoundEnabled: true,
        },
    });
    const { document, dom, link } = createFollowingPreviewDom(chrome);
    const hlsState = installFakeHls(dom);
    dom.window.fetch = createSoundPreviewFetch(dom, { liveId: "live-default" });

    evalFollowingPreviewTooltipScripts(dom);

    const { video } = await runSoundPreview(dom, link, document);

    assert.equal(hlsState.playCalls.length, 1);
    assert.equal(video.muted, false);
    assert.ok(Math.abs(video.volume - 0.15) < 1e-6);
});

test("following preview falls back to muted playback and unlocks sound from the badge", async () => {
    const chrome = createFakeChrome({
        sync: {
            followingPreviewSoundEnabled: true,
        },
    });
    const { document, dom, link } = createFollowingPreviewDom(chrome);
    let blockedOnce = false;
    const hlsState = installFakeHls(dom, {
        playHandler() {
            if (!this.muted && !blockedOnce) {
                blockedOnce = true;
                const error = new Error("Autoplay blocked");
                error.name = "NotAllowedError";
                return Promise.reject(error);
            }
            this.dispatchEvent(new dom.window.Event("playing"));
            return Promise.resolve();
        },
    });
    const playbackJson = JSON.stringify({
        media: [{ mediaId: "HLS", path: "https://example.com/live-blocked.m3u8" }],
    });

    dom.window.fetch = async (url) => {
        if (String(url).includes("/live-detail")) {
            return {
                ok: true,
                json: async () => ({
                    content: {
                        liveId: "live-blocked",
                        liveTitle: "API \uBC29\uC1A1 \uC81C\uBAA9",
                        liveImageUrl: "https://example.com/live-{type}.jpg",
                        liveCategoryValue: "\uAC8C\uC784",
                        openDate: new Date(Date.now() - 60 * 1000).toISOString(),
                        channel: {
                            channelName: "API \uCC44\uB110",
                        },
                    },
                }),
            };
        }

        if (String(url).includes("/auto-play-info")) {
            return {
                ok: true,
                json: async () => ({
                    content: {
                        livePlaybackJson: playbackJson,
                    },
                }),
            };
        }

        throw new Error(`Unexpected URL: ${url}`);
    };

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForFollowingPreviewFetchDelay();
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();

    const tip = document.getElementById("betterchzzk-following-preview");
    const video = tip.querySelector("video.bcfp-player");
    assert.ok(video);

    await waitForFollowingPlaybackDelay();
    await waitForAsyncCallbacks();

    let badge = tip.querySelector(".bcfp-sound-unlock");
    assert.ok(badge);
    assert.equal(hlsState.playCalls.length, 2);
    assert.equal(video.muted, true);
    assert.equal(video.defaultMuted, true);
    assert.equal(video.volume, 0);
    assert.equal(video.getAttribute("data-bcfp-player-state"), "ready");

    badge.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitForAsyncCallbacks();

    badge = tip.querySelector(".bcfp-sound-unlock");
    assert.equal(badge, null);
    assert.equal(hlsState.playCalls.length, 3);
    assert.equal(video.muted, false);
    assert.equal(video.defaultMuted, false);
    assert.equal(video.hasAttribute("muted"), false);
    assert.ok(Math.abs(video.volume - 0.15) < 1e-6);
});

test("following preview aborts stale live-detail requests during rapid hover", async () => {
    const chrome = createFakeChrome();
    const { document, dom, link } = createFollowingPreviewDom(chrome);
    const ul = document.querySelector("#following ul");
    const secondItem = document.createElement("li");
    secondItem.className = "following_item";
    secondItem.innerHTML = [
        '<a id="secondLiveLink" href="/live/channel-456" aria-label="\uB450 \uBC88\uC9F8 \uCC44\uB110">',
        '<img src="https://example.com/second-thumb.jpg" alt="">',
        '<span class="name_text">\uB450 \uBC88\uC9F8 \uCC44\uB110</span>',
        '<span class="live_title">\uB450 \uBC88\uC9F8 \uBC29\uC1A1</span>',
        "</a>",
    ].join("");
    ul.appendChild(secondItem);

    const secondLink = document.getElementById("secondLiveLink");
    secondItem.getBoundingClientRect = () => ({
        left: 12,
        top: 136,
        right: 196,
        bottom: 188,
        width: 184,
        height: 52,
    });
    secondLink.getBoundingClientRect = secondItem.getBoundingClientRect;

    const calls = [];
    dom.window.fetch = (url, init) => {
        calls.push({ signal: init.signal, url });
        return new Promise((resolve, reject) => {
            init.signal.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
            });
        });
    };

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewFetchDelay();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, false);
    assert.match(calls[0].url, /channel-123/);

    link.dispatchEvent(new dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: secondLink }));
    secondLink.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewFetchDelay();

    assert.equal(calls.length, 2);
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls[1].signal.aborted, false);
    assert.match(calls[1].url, /channel-456/);
    assert.equal(
        document.querySelector("#betterchzzk-following-preview[data-show='1'] .bcfp-title").textContent,
        "\uB450 \uBC88\uC9F8 \uBC29\uC1A1"
    );

    secondLink.dispatchEvent(new dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    await waitForAsyncCallbacks();
    assert.equal(calls[1].signal.aborted, true);
});

test("following preview tooltip ignores live links outside the following sidebar", async () => {
    const chrome = createFakeChrome();
    const { document, dom } = createFollowingPreviewDom(chrome);
    const mainLiveLink = document.getElementById("mainLiveLink");
    let fetchCount = 0;

    dom.window.fetch = async () => {
        fetchCount += 1;
        throw new Error("main live cards should not request following preview data");
    };

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    mainLiveLink.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForAsyncCallbacks();

    assert.equal(fetchCount, 0);
    assert.equal(document.getElementById("betterchzzk-following-preview"), null);
});

test("following preview tooltip removes listeners and UI when the option is disabled", async () => {
    const chrome = createFakeChrome();
    const { document, dom, item, link } = createFollowingPreviewDom(chrome);

    dom.window.fetch = async () => ({
        ok: true,
        json: async () => ({
            content: {
                liveTitle: "\uC635\uC158 \uD14C\uC2A4\uD2B8 \uC81C\uBAA9",
                channel: { channelName: "\uC635\uC158 \uD14C\uC2A4\uD2B8" },
            },
        }),
    });

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForAsyncCallbacks();

    assert.ok(document.querySelector("#betterchzzk-following-preview[data-show='1']"));
    assert.equal(item.getAttribute("data-bcfp-active"), "1");

    for (const listener of [...chrome.testState.storageChangeListeners]) {
        listener({ followingPreviewTooltipEnabled: { newValue: false } }, "sync");
    }
    await waitForAsyncCallbacks();

    assert.equal(document.getElementById("betterchzzk-following-preview"), null);
    assert.equal(document.getElementById("betterchzzk-following-preview-style"), null);
    assert.equal(item.hasAttribute("data-bcfp-active"), false);

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForAsyncCallbacks();

    assert.equal(document.getElementById("betterchzzk-following-preview"), null);
});
