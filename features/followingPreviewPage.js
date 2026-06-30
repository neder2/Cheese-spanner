(() => {
    const INSTALL_FLAG = "__betterChzzkFollowingPreviewPageInstalled";
    const PLAY_EVENT = "betterchzzk:following-preview:play";
    const STOP_EVENT = "betterchzzk:following-preview:stop";
    const STATUS_EVENT = "betterchzzk:following-preview:status";
    const MOUNT_ATTR = "data-bcfp-player-mount";
    const STATE_ATTR = "data-bcfp-player-state";
    const WEBPACK_CHUNK_NAME = "webpackChunkglive_fe_pc";
    const WEBPACK_CAPTURE_ID = "betterchzzk-following-preview";
    const WAIT_FOR_WEBPACK_RETRIES = 120;
    const WAIT_FOR_WEBPACK_MS = 50;
    const LIVE_PLAYBACK_OPTIONS = {
        countryCode: "kr",
        devt: "HTML5_PC",
        maxLevel: 480,
        p2pDisabled: true,
        serviceId: 2099,
    };
    const PREVIEW_AUDIO_VOLUME = 0.2;
    const EXTENSION_PREVIEW_VIDEO_SELECTOR = "[data-bcfp-player-mount], .bcfp-player, [data-bcfp-tooltip]";

    if (window[INSTALL_FLAG]) return;
    try {
        Object.defineProperty(window, INSTALL_FLAG, { value: true });
    } catch (_) {
        window[INSTALL_FLAG] = true;
    }

    let webpackRequirePromise = null;
    let playerRuntimePromise = null;
    let playerRuntime = null;
    let player = null;
    let mountedEl = null;
    let activeRequestId = "";
    let pendingLoadedMetadata = null;
    let pendingLoadedMetadataTargets = [];
    let encryptedPlayer = null;
    let encryptedHandler = null;
    let lastMainAudioState = null;
    let watchedMainVideo = null;
    let mainAudioSyncTimer = 0;
    let mainVideoObserver = null;

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function normalizeVolume(value) {
        const volume = Number(value);
        return Number.isFinite(volume) ? clamp(volume, 0, 1) : PREVIEW_AUDIO_VOLUME;
    }

    function isVisible(el) {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden";
    }

    function pickLargestVisible(nodes) {
        let best = null;
        let bestArea = -1;
        for (const el of nodes || []) {
            if (!isVisible(el)) continue;
            const rect = el.getBoundingClientRect();
            const area = Math.max(0, rect.width) * Math.max(0, rect.height);
            if (area > bestArea) {
                best = el;
                bestArea = area;
            }
        }
        return best || null;
    }

    function elementOrHostMatches(node, selector) {
        let current = node;
        while (current) {
            if (current instanceof Element && current.matches(selector)) return true;

            if (current.parentElement) {
                current = current.parentElement;
                continue;
            }

            const rootNode = current.getRootNode?.();
            if (
                typeof ShadowRoot !== "undefined" &&
                rootNode instanceof ShadowRoot &&
                rootNode.host &&
                rootNode.host !== current
            ) {
                current = rootNode.host;
                continue;
            }

            break;
        }
        return false;
    }

    function isExtensionPreviewVideo(video) {
        return video instanceof HTMLVideoElement && elementOrHostMatches(video, EXTENSION_PREVIEW_VIDEO_SELECTOR);
    }

    function getMainPlaybackVideo() {
        const videos = Array.from(document.querySelectorAll("video")).filter(
            (video) => !isExtensionPreviewVideo(video)
        );
        return pickLargestVisible(videos) || videos[0] || null;
    }

    function readAudioState(video) {
        return {
            muted: Boolean(video.muted),
            volume: normalizeVolume(video.volume),
        };
    }

    function rememberMainAudioState(video) {
        if (!(video instanceof HTMLVideoElement) || isExtensionPreviewVideo(video)) return null;
        lastMainAudioState = readAudioState(video);
        return lastMainAudioState;
    }

    function clearWatchedMainVideo() {
        if (!watchedMainVideo) return;
        watchedMainVideo.removeEventListener?.("volumechange", onMainVideoVolumeChange, true);
        watchedMainVideo = null;
    }

    function watchMainVideo(video) {
        if (!(video instanceof HTMLVideoElement)) {
            clearWatchedMainVideo();
            return null;
        }

        if (watchedMainVideo !== video) {
            clearWatchedMainVideo();
            watchedMainVideo = video;
            watchedMainVideo.addEventListener?.("volumechange", onMainVideoVolumeChange, true);
        }
        return rememberMainAudioState(video);
    }

    function syncMainAudioState() {
        const mainVideo = getMainPlaybackVideo();
        if (mainVideo instanceof HTMLVideoElement) return watchMainVideo(mainVideo);
        clearWatchedMainVideo();
        return null;
    }

    function scheduleMainAudioSync() {
        if (mainAudioSyncTimer) return;
        mainAudioSyncTimer = window.setTimeout(() => {
            mainAudioSyncTimer = 0;
            syncMainAudioState();
        }, 0);
    }

    function onMainVideoVolumeChange(event) {
        const video = event?.target;
        if (!(video instanceof HTMLVideoElement) || isExtensionPreviewVideo(video)) return;

        const mainVideo = getMainPlaybackVideo();
        if (video === mainVideo || video === watchedMainVideo) watchMainVideo(video);
    }

    function startMainAudioTracking() {
        syncMainAudioState();
        document.addEventListener("volumechange", onMainVideoVolumeChange, true);
        window.addEventListener("pageshow", scheduleMainAudioSync, true);
        window.addEventListener("popstate", scheduleMainAudioSync, true);
        window.addEventListener("hashchange", scheduleMainAudioSync, true);

        if (typeof MutationObserver === "undefined" || mainVideoObserver) return;
        mainVideoObserver = new MutationObserver(scheduleMainAudioSync);
        mainVideoObserver.observe(document.documentElement || document, { childList: true, subtree: true });
    }

    function getPreviewAudioState(audioEnabled = true) {
        const audioState = syncMainAudioState() ||
            lastMainAudioState || {
                muted: false,
                volume: PREVIEW_AUDIO_VOLUME,
            };

        return audioEnabled === false ? { ...audioState, muted: true } : audioState;
    }

    function parseDetail(detail) {
        if (!detail) return {};
        if (typeof detail === "string") {
            try {
                return JSON.parse(detail) || {};
            } catch (_) {
                return {};
            }
        }
        return detail;
    }

    function dispatchStatus(detail) {
        window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: JSON.stringify(detail || {}) }));
    }

    function getMountSelector(mountId) {
        return `[${MOUNT_ATTR}="${String(mountId || "").replace(/["\\]/g, "\\$&")}"]`;
    }

    function unwrapPlayerRuntime(value) {
        if (!value) return null;

        const candidates = [value, value.default, value.x, value.X, value.Player, value.player];

        for (const candidate of candidates) {
            if (candidate?.CorePlayer && candidate?.LiveProvider) return candidate;
            if (typeof candidate === "function") {
                try {
                    const resolved = candidate();
                    if (resolved?.CorePlayer && resolved?.LiveProvider) return resolved;
                } catch (_) {
                    // Some bundled exports are factories with required arguments.
                }
            }
        }

        return null;
    }

    async function waitForWebpackChunk() {
        for (let attempt = 0; attempt <= WAIT_FOR_WEBPACK_RETRIES; attempt += 1) {
            const chunk = getAvailableWebpackChunk();
            if (chunk && typeof chunk.push === "function") return chunk;
            await sleep(WAIT_FOR_WEBPACK_MS);
        }
        return null;
    }

    function getAvailableWebpackChunk() {
        const chunk = window[WEBPACK_CHUNK_NAME];
        return chunk && typeof chunk.push === "function" ? chunk : null;
    }

    function captureWebpackRequire(chunk) {
        return new Promise((resolve, reject) => {
            const id = `${WEBPACK_CAPTURE_ID}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            try {
                chunk.push([
                    [id],
                    {
                        [id]: (module, exports, __webpack_require__) => {
                            resolve(__webpack_require__);
                        },
                    },
                    (req) => req(id),
                ]);
            } catch (error) {
                reject(error);
            }
        });
    }

    async function getWebpackRequire() {
        if (!webpackRequirePromise) {
            webpackRequirePromise = waitForWebpackChunk().then((chunk) =>
                chunk ? captureWebpackRequire(chunk) : null
            );
        }
        return webpackRequirePromise;
    }

    function getRuntimeFromWebpackCache(__webpack_require__) {
        if (!__webpack_require__) return null;

        const cache = __webpack_require__.c || {};
        for (const module of Object.values(cache)) {
            const runtime = unwrapPlayerRuntime(module?.exports);
            if (runtime) return runtime;
        }

        return null;
    }

    async function getPlayerRuntime() {
        if (playerRuntime) return playerRuntime;

        if (!playerRuntimePromise) {
            playerRuntimePromise = (async () => {
                const fromWebpack = getRuntimeFromWebpackCache(await getWebpackRequire().catch(() => null));
                if (fromWebpack) return fromWebpack;

                throw new Error("following-preview-player-runtime-unavailable");
            })().catch((error) => {
                playerRuntimePromise = null;
                webpackRequirePromise = null;
                throw error;
            });
        }

        playerRuntime = await playerRuntimePromise;
        return playerRuntime;
    }

    async function ensurePlayer() {
        const Player = await getPlayerRuntime();
        if (!player) {
            player = new Player.CorePlayer();
            player.autoplay = true;
            player.muted = true;
            player.playsInline = true;
            player.controls = false;
        }
        return { Player, player };
    }

    function getKeySystemConfig(initDataType) {
        if (initDataType !== "aes-encrypted-hls") return null;
        return [
            "com.naver.hlsaes",
            [
                {
                    initDataTypes: [initDataType],
                    videoCapabilities: [{ contentType: "application/x-mpegURL" }],
                },
            ],
        ];
    }

    async function requestMediaLicense(session, message) {
        const request = JSON.parse(new TextDecoder().decode(message));
        const response = await fetch(request.url, {
            credentials: "include",
            method: request.method || "GET",
        });
        await session.update(await response.arrayBuffer());
    }

    function clearEncryptedListener() {
        if (!encryptedPlayer || !encryptedHandler) return;
        encryptedPlayer.removeEventListener?.("encrypted", encryptedHandler);
        encryptedPlayer = null;
        encryptedHandler = null;
    }

    function attachEncryptedListener(Player, previewPlayer, mount, requestId) {
        clearEncryptedListener();
        encryptedPlayer = previewPlayer;
        const markEncryptedError = () => {
            if (activeRequestId === requestId && mountedEl === mount) markMountState(mount, "error");
        };
        encryptedHandler = async (event) => {
            try {
                const keySystemConfig = getKeySystemConfig(event.initDataType);
                if (!keySystemConfig) return;

                const [keySystem, supportedConfigurations] = keySystemConfig;
                const mediaKeys = await (
                    await Player.CorePlayer.requestMediaKeySystemAccess(keySystem, supportedConfigurations)
                ).createMediaKeys();
                await previewPlayer.setMediaKeys(mediaKeys);

                const session = mediaKeys.createSession("temporary");
                session.addEventListener("message", (messageEvent) => {
                    if (messageEvent.messageType === "license-request") {
                        requestMediaLicense(session, messageEvent.message).catch(markEncryptedError);
                    }
                });
                await session.generateRequest(event.initDataType, event.initData);
            } catch (_) {
                markEncryptedError();
            }
        };
        previewPlayer.addEventListener?.("encrypted", encryptedHandler);
    }

    function markMountState(el, state) {
        if (!el) return;
        el.setAttribute(STATE_ATTR, state);
    }

    function findPlayerVideoNode(previewPlayer) {
        if (previewPlayer instanceof HTMLVideoElement) return previewPlayer;

        const roots = [];
        if (previewPlayer?.shadowRoot?.querySelector) roots.push(previewPlayer.shadowRoot);
        if (previewPlayer?.querySelector) roots.push(previewPlayer);

        for (const root of roots) {
            const video = root.querySelector("video");
            if (video instanceof HTMLVideoElement) return video;
        }

        return null;
    }

    function getPlayerMountNode(previewPlayer) {
        if (previewPlayer?.shadowRoot instanceof Element) return previewPlayer.shadowRoot;
        if (previewPlayer instanceof Node) return previewPlayer;
        return null;
    }

    function clearLoadedMetadataListener() {
        if (!pendingLoadedMetadata) return;
        for (const target of pendingLoadedMetadataTargets) {
            target?.removeEventListener?.("loadedmetadata", pendingLoadedMetadata);
        }
        pendingLoadedMetadata = null;
        pendingLoadedMetadataTargets = [];
    }

    function detachPlayer(nextState = "idle") {
        clearLoadedMetadataListener();
        clearEncryptedListener();

        if (player) {
            try {
                player.src = "";
            } catch (_) {
                // CorePlayer versions differ in how they expose teardown fields.
            }
            try {
                player.srcObject = null;
            } catch (_) {
                // CorePlayer versions differ in how they expose teardown fields.
            }
        }

        if (mountedEl?.isConnected) {
            markMountState(mountedEl, nextState);
            mountedEl.replaceChildren();
        }
        mountedEl = null;
        activeRequestId = "";
    }

    function markPlaybackError(requestId) {
        if (requestId && requestId !== activeRequestId) return;
        if (mountedEl?.isConnected) markMountState(mountedEl, "error");
    }

    function playPreview(requestId = activeRequestId) {
        let result = null;
        try {
            result = player?.play?.();
        } catch (error) {
            if (error?.name !== "AbortError") markPlaybackError(requestId);
            return;
        }
        if (!result?.catch) return;

        result.catch((error) => {
            if (error?.name === "AbortError") return;
            markPlaybackError(requestId);
        });
    }

    function revealWhenReady(requestId, mount) {
        const reveal = () => {
            if (activeRequestId !== requestId || mountedEl !== mount || !mount.isConnected) return;
            clearLoadedMetadataListener();
            markMountState(mount, "ready");
            playPreview(requestId);
        };

        const playerVideo = findPlayerVideoNode(player);
        if (player?.readyState || playerVideo?.readyState) {
            reveal();
            return;
        }

        pendingLoadedMetadata = reveal;
        pendingLoadedMetadataTargets = [player, playerVideo].filter((target, index, targets) => {
            return target?.addEventListener && targets.indexOf(target) === index;
        });
        if (!pendingLoadedMetadataTargets.length) {
            reveal();
            return;
        }
        for (const target of pendingLoadedMetadataTargets) {
            target.addEventListener("loadedmetadata", reveal, { once: true });
        }
    }

    async function handlePlay(event) {
        const detail = parseDetail(event.detail);
        const requestId = String(detail.requestId || "");
        const mountId = String(detail.mountId || "");
        const playbackJson = String(detail.playbackJson || "");
        if (!requestId || !mountId || !playbackJson) return;

        const mount = document.querySelector(getMountSelector(mountId));
        if (!mount) return;

        try {
            const playback = JSON.parse(playbackJson);
            const { Player, player: previewPlayer } = await ensurePlayer();
            if (!mount.isConnected) return;

            if (activeRequestId && activeRequestId !== requestId) detachPlayer();

            activeRequestId = requestId;
            mountedEl = mount;
            markMountState(mount, "loading");

            const audioState = getPreviewAudioState(detail.audioEnabled !== false);
            previewPlayer.volume = audioState.volume;
            previewPlayer.muted = audioState.muted;
            attachEncryptedListener(Player, previewPlayer, mount, requestId);
            previewPlayer.srcObject = Player.LiveProvider.fromJSON(playback, LIVE_PLAYBACK_OPTIONS);

            const playerNode = getPlayerMountNode(previewPlayer);
            if (playerNode && playerNode.parentNode !== mount) mount.replaceChildren(playerNode);

            revealWhenReady(requestId, mount);
        } catch (error) {
            if (mountedEl === mount) detachPlayer("error");
            else markMountState(mount, "error");
            if (error?.message === "following-preview-player-runtime-unavailable") {
                dispatchStatus({
                    mountId,
                    requestId,
                    state: "runtime-unavailable",
                });
            }
        }
    }

    function handleStop(event) {
        const detail = parseDetail(event.detail);
        const requestId = String(detail.requestId || "");
        if (requestId && activeRequestId && requestId !== activeRequestId) return;
        detachPlayer();
    }

    startMainAudioTracking();
    window.addEventListener(PLAY_EVENT, handlePlay);
    window.addEventListener(STOP_EVENT, handleStop);
    window.addEventListener("pagehide", () => detachPlayer());
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") detachPlayer();
    });
})();
