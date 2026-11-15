(() => {
    "use strict";

    const MEDIA = "video.webplayer-internal-video";
    const HOST = "#player_layout.chzzk_player.type_vod";
    const SOURCE = /^vod3:\/\/2099:[\w-]+@([\w-]+)\?env=real(?:&[^#]*)?(?:#.*)?$/;
    const VERIFIED_VERSIONS = new Set(["1.16.3", "1.17.0"]);
    // Same five auxiliary positions as live multiview. Each core keeps its SDK heartbeat.
    const maxAuxiliary = 5;
    const slots = Array(maxAuxiliary).fill(undefined);

    const CDN_ORIGIN = "https://ex-nlive-slitvod-streaming.navercdn.com";
    const trackTextFields = [
        "encodingTrackId",
        "videoProfile",
        "audioProfile",
        "videoCodec",
        "videoFrameRate",
        "videoDynamicRange",
    ];
    const trackNumberFields = [
        "videoBitRate",
        "audioBitRate",
        "videoWidth",
        "videoHeight",
        "audioSamplingRate",
        "audioChannel",
    ];

    function readTrack(input) {
        const track = {};
        for (const field of trackTextFields) {
            const value = input?.[field];
            if (typeof value === "string" && value.length <= 80) track[field] = value;
        }
        for (const field of trackNumberFields) {
            const value = input?.[field];
            if (Number.isSafeInteger(value) && value >= 0) track[field] = value;
        }
        return track.encodingTrackId && track.videoWidth > 0 && track.videoHeight > 0 ? track : null;
    }

    function readRewindSource(value, videoId, duration) {
        if (typeof value !== "string" || value.length > 65536) return null;
        try {
            const { meta, media } = JSON.parse(value);
            if (
                meta?.liveRewind !== true ||
                meta.videoId !== videoId ||
                meta.paidLive !== false ||
                meta.playbackAuthType !== "NONE" ||
                typeof meta.liveId !== "string" ||
                !/^\d{1,20}$/.test(meta.liveId) ||
                !Number.isSafeInteger(meta.streamSeq) ||
                meta.streamSeq < 0 ||
                !Number.isFinite(meta.duration) ||
                meta.duration <= 0 ||
                Math.abs(meta.duration - duration) > 2 ||
                typeof meta.cdnInfo?.cdnType !== "string" ||
                !/^[A-Z0-9_-]{1,24}$/.test(meta.cdnInfo.cdnType) ||
                !Array.isArray(media) ||
                media.length !== 1
            )
                return null;

            const [hls] = media;
            if (
                hls?.protocol !== "HLS" ||
                hls.mediaId !== "HLS" ||
                typeof hls.path !== "string" ||
                !Array.isArray(hls.encodingTrack) ||
                !hls.encodingTrack.length ||
                hls.encodingTrack.length > 16
            )
                return null;
            const url = new URL(hls.path);
            if (
                url.origin !== CDN_ORIGIN ||
                url.username ||
                url.password ||
                url.hash ||
                !url.pathname.startsWith("/chzzk/") ||
                !url.pathname.endsWith(".m3u8")
            )
                return null;
            const encodingTrack = hls.encodingTrack.map(readTrack);
            if (encodingTrack.includes(null)) return null;

            // Forward only the VOD playlist and track descriptions to the native provider.
            const { liveId, streamSeq } = meta;
            return {
                meta: {
                    videoId,
                    liveId,
                    streamSeq,
                    liveRewind: true,
                    paidLive: false,
                    playbackAuthType: "NONE",
                    duration: meta.duration,
                    cdnInfo: { cdnType: meta.cdnInfo.cdnType },
                },
                api: [],
                media: [{ protocol: "HLS", mediaId: "HLS", path: url.href, encodingTrack }],
            };
        } catch {
            return null;
        }
    }

    function find(host, video) {
        if (!host?.isConnected || !host.matches(HOST) || !video?.matches(MEDIA) || !host.contains(video)) return null;
        const key = Object.getOwnPropertyNames(host).find((name) => name.startsWith("__reactFiber$"));
        const fiber = host[key];
        if (!fiber) return null;

        const matches = new Set();
        function consider(player) {
            const root = player?.shadowRoot;
            if (
                root instanceof Element &&
                root.parentElement === host &&
                root.querySelector(MEDIA) === video &&
                typeof player.querySelector === "function" &&
                typeof player.constructor?.upgrade === "function"
            )
                matches.add(player);
        }

        try {
            for (let owner = fiber, depth = 0; owner && depth < 10; owner = owner.return, depth++) {
                for (const candidate of [owner, owner.alternate]) {
                    for (
                        let hook = candidate?.memoizedState, index = 0;
                        hook && index < 48;
                        hook = hook.next, index++
                    ) {
                        consider(hook.memoizedState);
                        consider(hook.memoizedState?.current);
                    }
                }
            }
        } catch {
            return null;
        }
        return host[key] === fiber && matches.size === 1 ? matches.values().next().value : null;
    }

    function ownsMedia(player, video, mediaId) {
        if (!video.isConnected || player.shadowRoot?.querySelector(MEDIA) !== video) return false;
        const provider = player.srcObject;
        if (provider?.protocol === "live:") {
            const meta = provider.data?.meta;
            return provider.player === player._corePlayer && meta?.liveRewind === true && meta.videoId === mediaId;
        }
        return provider?.protocol === "vod3:" && SOURCE.exec(player.src)?.[1] === mediaId;
    }

    function canAllocate(player) {
        return (
            VERIFIED_VERSIONS.has(player.constructor?.version) &&
            typeof player.constructor.upgrade === "function" &&
            typeof player._corePlayer?._loadSrcObject === "function"
        );
    }

    function acquire(main, index = 0) {
        if (!Number.isInteger(index) || index < 0 || index >= maxAuxiliary || !canAllocate(main)) return null;
        const existing = slots[index];
        if (existing !== undefined) return existing?.constructor === main.constructor ? existing : null;
        // The SDK registers each core with a shared heartbeat and offers no instance disposal.
        // Cap allocation even if construction only partially succeeds.
        slots[index] = null;
        const layout = document.createElement("pzp-pc-layout");
        layout.setAttribute("feature", "replay");
        // The default SDK layout uses the live clock. Give the owned player the native VOD controls.
        layout.innerHTML = `
            <div class="pzp-pc__bottom-buttons" slot="functions">
                <div class="pzp-pc__bottom-buttons-left">
                    <pzp-playback-switch class="pzp-pc__playback-switch"></pzp-playback-switch>
                    <div class="pzp-pc__volume-control">
                        <pzp-pc-volume-button class="pzp-pc__volume-button"></pzp-pc-volume-button>
                        <pzp-pc-volume-slider class="pzp-pc__volume-slider"></pzp-pc-volume-slider>
                    </div>
                    <pzp-pc-vod-time class="pzp-pc__vod-time"></pzp-pc-vod-time>
                </div>
                <div class="pzp-pc__bottom-buttons-right">
                    <pzp-pc-pip-button class="pzp-pc__pip-button" slot="pip-button"></pzp-pc-pip-button>
                    <pzp-pc-setting-button class="pzp-pc__setting-button"></pzp-pc-setting-button>
                    <pzp-pc-fullscreen-button class="pzp-pc__fullscreen-button"></pzp-pc-fullscreen-button>
                </div>
            </div>
            <pzp-pc-settings slot="settings" class="pzp-pc__settings">
                <pzp-pc-setting-intro-quality></pzp-pc-setting-intro-quality>
                <pzp-pc-setting-intro-playbackrate></pzp-pc-setting-intro-playbackrate>
                <pzp-pc-setting-intro-subtitle></pzp-pc-setting-intro-subtitle>
            </pzp-pc-settings>
        `;
        const player = main.constructor.upgrade(layout);
        const root = player.shadowRoot;
        const media = root?.querySelector(MEDIA);
        if (!media || typeof player.play !== "function" || typeof player.pause !== "function") return null;

        root.tabIndex = 0;
        root.dataset.bcmvVideo = "1";
        root.setAttribute("aria-label", "보조 다시보기 플레이어");
        player.autoplay = false;
        const slot = { constructor: main.constructor, player, root, media, idle: Promise.resolve(true), load: null };
        slots[index] = slot;
        return slot;
    }

    function assign(slot, info, source) {
        const { player, media } = slot;
        player.muted = true;
        media.muted = true;
        player.volume = 1;
        const core = player._corePlayer;
        const load = core._loadSrcObject;
        let preparingRewind = info.rewind;
        // Observe the exact load promise on this owned core. The SDK clears its pending pointer
        // before an aborted provider's load callback settles.
        core._loadSrcObject = function (...args) {
            if (preparingRewind) throw new Error("The rewind source is not ready to load");
            const pending = load.apply(this, args);
            slot.load = pending;
            const clearPending = () => {
                if (slot.load === pending) slot.load = null;
            };
            Promise.resolve(pending).then(clearPending, clearPending);
            return pending;
        };
        try {
            if (info.rewind) {
                // Use the SDK's live provider factory without loading the live broadcast.
                player.preload = "none";
                player.src = `live://${source.meta.liveId}?devt=HTML5_PC&country-code=kr&p2p-disabled=true&env=real`;
                const provider = player.srcObject;
                if (
                    provider?.protocol !== "live:" ||
                    provider.player !== core ||
                    typeof provider._injectPlaybackResponse !== "function"
                )
                    throw new Error("The native rewind provider is unavailable");
                provider._injectPlaybackResponse(source, {
                    devt: "HTML5_PC",
                    serviceId: 2099,
                    countryCode: "kr",
                    startLevel: 720,
                    maxLevel: 1080,
                    p2pConfigServer: "real",
                    p2pDisabled: true,
                    audioSyncFixer: true,
                    disableAudioTrack: false,
                });
                preparingRewind = false;
                player.preload = "auto";
            } else {
                const { key, aes } = source;
                player.preload = "auto";
                player.src = `vod3://2099:${key}@${info.id}?env=real${aes ? "" : "&st=13"}#start-level=720&max-level=1080`;
            }
        } finally {
            delete core._loadSrcObject;
        }
    }

    function release(slot, play) {
        if (!slot || !slots.includes(slot)) return;
        const { player, root, media, load } = slot;
        const core = player._corePlayer;
        let closedSource = player.srcObject;
        if (closedSource?.player !== core || !["vod3:", "live:"].includes(closedSource.protocol)) closedSource = null;
        slot.load = null;
        slot.idle = new Promise((resolve) => {
            let settled = false;
            function isEmpty() {
                return (
                    player.src === "" &&
                    player.srcObject == null &&
                    media.paused &&
                    !media.srcObject &&
                    !media.hasAttribute("src") &&
                    media.readyState === 0 &&
                    media.buffered.length === 0
                );
            }
            const preventLatePlay = (event) => event.preventDefault();
            const finish = (ready) => {
                closedSource = null;
                clearTimeout(deadline);
                media.removeEventListener("emptied", check);
                if (play) core.removeEventListener("play", preventLatePlay);
                resolve(ready);
            };
            function check() {
                if (!settled || !isEmpty()) return;
                // PZP updates this cache on loadstart. Clearing src emits no loadstart for the empty source.
                const lastSource = Object.getOwnPropertyDescriptor(player, "_lastSrcObj");
                if (closedSource && lastSource?.writable && lastSource.value === closedSource)
                    player._lastSrcObj = null;
                finish(true);
            }
            function clearSource() {
                try {
                    player.pause();
                    player.preload = "none";
                } finally {
                    try {
                        player.src = "";
                    } finally {
                        media.pause();
                        if (media.srcObject) media.srcObject = null;
                        media.removeAttribute("src");
                        media.load();
                    }
                }
            }
            const deadline = setTimeout(() => finish(false), 15000);
            // Chrome can clear the media on the subsequent emptied event, after the SDK load has settled.
            media.addEventListener("emptied", check);
            try {
                // A pending play can finish warming up after pause() and try to play the empty source.
                if (play) core.addEventListener("play", preventLatePlay);
                media.muted = true;
                try {
                    if (document.pictureInPictureElement === media) document.exitPictureInPicture().catch(() => {});
                } finally {
                    clearSource();
                }
            } catch {
                finish(false);
                return;
            } finally {
                root.remove();
            }
            // The site can replace window.Promise with a version without allSettled.
            const completions = [load, play].map((pending) => Promise.resolve(pending).catch(() => {}));
            Promise.all(completions)
                .then(() => {
                    // Track setup can subscribe to the core after the source was cleared. Abort those
                    // subscriptions, then reset the native abort state before reusing the slot.
                    if (load && closedSource && player.srcObject == null && typeof core._handleAbort === "function") {
                        try {
                            // The rewind provider can finish wiring its playback monitoring after close.
                            if (closedSource.protocol === "live:") closedSource.close();
                            core._handleAbort();
                        } finally {
                            clearSource();
                        }
                    } else if (!player.paused || !isEmpty()) clearSource();
                    settled = true;
                    check();
                })
                .catch(() => finish(false));
        });
    }

    const isAttached = (slot) => slot?.root.isConnected && slot.root.dataset.bcvmVideoNo;

    function auxiliaryAt(target) {
        if (!(target instanceof Element)) return null;
        return slots.find((slot) => isAttached(slot) && slot.root.contains(target));
    }

    window.CheeseSpannerVodNative = Object.freeze({
        find,
        ownsMedia,
        canAllocate,
        acquire,
        readRewindSource,
        assign,
        release,
        auxiliaryAt,
        getAuxiliaries: () => slots.filter(isAttached),
        maxAuxiliary,
    });
})();
