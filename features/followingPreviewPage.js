(() => {
    const INSTALL_FLAG = "__betterChzzkFollowingPreviewPageInstalled";
    const PLAY_EVENT = "betterchzzk:following-preview:play";
    const STOP_EVENT = "betterchzzk:following-preview:stop";
    const MOUNT_ATTR = "data-bcfp-player-mount";
    const STATE_ATTR = "data-bcfp-player-state";
    const WEBPACK_CHUNK_NAME = "webpackChunkglive_fe_pc";
    const WEBPACK_CAPTURE_ID = "betterchzzk-following-preview";
    const WEBPACK_PLAYER_MODULE_ID = 49588;
    const WAIT_FOR_WEBPACK_RETRIES = 120;
    const WAIT_FOR_WEBPACK_MS = 50;
    const PREVIEW_OPTIONS = {
        countryCode: "kr",
        devt: "HTML5_PC",
        maxLevel: 480,
        mediaType: "PREVIEW",
        p2pDisabled: true,
        serviceId: 2099,
        track: 360,
    };

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

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
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

        try {
            const runtime = unwrapPlayerRuntime(__webpack_require__(WEBPACK_PLAYER_MODULE_ID));
            if (runtime) return runtime;
        } catch (_) {
            // The current CHZZK bundle can move the player module id.
        }

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
            })();
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

    function markMountState(el, state) {
        if (!el) return;
        el.setAttribute(STATE_ATTR, state);
    }

    function getPlayerMountNode(previewPlayer) {
        if (previewPlayer instanceof Node) return previewPlayer;
        if (previewPlayer?.shadowRoot instanceof Element) return previewPlayer.shadowRoot;
        return null;
    }

    function clearLoadedMetadataListener() {
        if (!pendingLoadedMetadata || !player?.removeEventListener) return;
        player.removeEventListener("loadedmetadata", pendingLoadedMetadata);
        pendingLoadedMetadata = null;
    }

    function detachPlayer(nextState = "idle") {
        clearLoadedMetadataListener();

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

    function playPreview() {
        const result = player?.play?.();
        if (!result?.catch) return;

        result.catch((error) => {
            if (error?.name === "AbortError") return;
            try {
                player.muted = true;
                player.play?.();
            } catch (_) {
                // Autoplay can still be denied by the browser.
            }
        });
    }

    function revealWhenReady(requestId, mount) {
        const reveal = () => {
            if (activeRequestId !== requestId || mountedEl !== mount || !mount.isConnected) return;
            clearLoadedMetadataListener();
            markMountState(mount, "ready");
            playPreview();
        };

        if (player?.readyState) {
            reveal();
            return;
        }

        pendingLoadedMetadata = reveal;
        player?.addEventListener?.("loadedmetadata", reveal, { once: true });
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

            const playerNode = getPlayerMountNode(previewPlayer);
            if (playerNode && playerNode.parentNode !== mount) mount.replaceChildren(playerNode);

            previewPlayer.volume = Number.isFinite(detail.volume) ? detail.volume : 0;
            previewPlayer.muted = detail.muted !== false;
            previewPlayer.srcObject = Player.LiveProvider.fromJSON(playback, PREVIEW_OPTIONS);
            revealWhenReady(requestId, mount);
        } catch (_) {
            if (mountedEl === mount) detachPlayer("error");
            else markMountState(mount, "error");
        }
    }

    function handleStop(event) {
        const detail = parseDetail(event.detail);
        const requestId = String(detail.requestId || "");
        if (requestId && activeRequestId && requestId !== activeRequestId) return;
        detachPlayer();
    }

    window.addEventListener(PLAY_EVENT, handlePlay);
    window.addEventListener(STOP_EVENT, handleStop);
    window.addEventListener("pagehide", () => detachPlayer());
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") detachPlayer();
    });
})();
