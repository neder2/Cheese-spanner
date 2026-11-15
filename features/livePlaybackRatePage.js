/**
 * 메인 라이브의 자동 따라잡기 배속만 제한한다. 설정은 isolated의 DOM 브리지로 받는다.
 * 네이티브 HLS가 목록을 읽은 뒤 기본값을 다시 쓰므로 같은 인스턴스의 완료 이벤트에서 적용한다.
 * 재생 위치·화질·수동 배속은 제어하지 않는다.
 */
(() => {
    const STATE_ATTR = "data-cheese-spanner-live-playback-rate";
    const STATE_EVENT = "cheese-spanner:live-playback-rate:state";
    const MARKER = "data-cheese-spanner-live-rate-lock";
    const LEVEL_EVENT = "hlsLevelLoaded";
    const RATE_KEY = "maxLiveSyncPlaybackRate";
    const HOST_SELECTOR = ".chzzk_player.type_live";
    const MEDIA_SELECTOR = "video.webplayer-internal-video";
    const CHANGE_SELECTOR = `${HOST_SELECTOR}, ${MEDIA_SELECTOR}, #preAdPlayerWrapper, #midAdPlayerWrapper`;
    const MEDIA_EVENTS = ["loadstart", "emptied", "loadedmetadata", "canplay", "playing", "ratechange"];
    const { getMainVideoElement, isNativeAdBreakActive } = globalThis.CheeseSpannerVolumeControls;
    let enabled = false;
    let suspended = false;
    let installed = false;
    let binding = null;
    let observer = null;
    let timer = 0;

    const isLive = () => /^\/live\/[^/]+\/?$/.test(location.pathname);

    function findOwner() {
        const video = getMainVideoElement();
        const host = video?.closest(HOST_SELECTOR);
        if (!host || !video.matches(MEDIA_SELECTOR)) return null;
        const key = Object.getOwnPropertyNames(host).find((name) => name.startsWith("__reactFiber$"));
        const matches = new Map();
        const consider = (player, hook) => {
            if (!player || matches.has(player)) return;
            try {
                const core = player._corePlayer;
                const provider = player.srcObject;
                const sourcePlayer = core?.player;
                const controller = sourcePlayer?._mediaController;
                const hls = controller?.getHlsInstance?.();
                if (
                    !(player.shadowRoot instanceof Element) ||
                    !player.shadowRoot.contains(video) ||
                    !provider ||
                    provider.player !== core ||
                    hls?.media !== video ||
                    typeof hls.on !== "function" ||
                    typeof hls.off !== "function" ||
                    !hls.config ||
                    !hls.userConfig
                )
                    return;
                matches.set(player, { host, video, player, hook, core, provider, sourcePlayer, controller, hls });
            } catch {
                // Unknown or transitioning players remain native.
            }
        };
        for (let owner = key && host[key], depth = 0; owner && depth < 8; owner = owner.return, depth++) {
            for (const fiber of [owner, owner.alternate]) {
                for (let hook = fiber?.memoizedState, index = 0; hook && index < 48; hook = hook.next, index++) {
                    consider(hook.memoizedState, hook);
                    consider(hook.memoizedState?.current, hook);
                }
            }
        }
        return matches.size === 1 ? matches.values().next().value : null;
    }

    function isCurrent(target) {
        try {
            return Boolean(
                enabled &&
                !suspended &&
                isLive() &&
                target.route === location.pathname &&
                target.video.isConnected &&
                target.video.closest(HOST_SELECTOR) === target.host &&
                (target.hook.memoizedState === target.player || target.hook.memoizedState?.current === target.player) &&
                target.player.shadowRoot.contains(target.video) &&
                target.player.srcObject === target.provider &&
                target.provider.player === target.core &&
                target.core.player === target.sourcePlayer &&
                target.sourcePlayer._mediaController === target.controller &&
                target.controller.getHlsInstance() === target.hls &&
                target.hls.media === target.video
            );
        } catch {
            return false;
        }
    }

    function restoreSetting(entry) {
        try {
            if (entry.object[RATE_KEY] !== 1) return;
            if (entry.own) entry.object[RATE_KEY] = entry.value;
            else delete entry.object[RATE_KEY];
        } catch {
            // A disposed native config may no longer be writable.
        }
    }

    function release() {
        const previous = binding;
        binding = null;
        if (!previous) return;
        try {
            previous.hls.off(LEVEL_EVENT, previous.onLevel);
        } catch {
            // A destroyed player cannot receive more events.
        }
        for (const entry of previous.settings.values()) restoreSetting(entry);
        previous.video.removeAttribute(MARKER);
    }

    function limitSetting(target, object) {
        if (!object || typeof object !== "object") throw new Error("Missing native config");
        let entry = target.settings.get(object);
        // Keep the latest native value, including a default re-applied after a playlist refresh.
        if (!entry || object[RATE_KEY] !== 1) {
            entry = { object, own: Object.hasOwn(object, RATE_KEY), value: object[RATE_KEY] };
            target.settings.set(object, entry);
        }
        if (object[RATE_KEY] !== 1) object[RATE_KEY] = 1;
        if (object[RATE_KEY] !== 1) throw new Error("Native config is not writable");
    }

    function applyLimit(target) {
        if (binding !== target) return;
        if (!isCurrent(target) || isNativeAdBreakActive()) {
            release();
            scheduleSync();
            return;
        }
        try {
            // Config objects can be replaced independently of the HLS instance.
            const objects = new Set([target.hls.config, target.hls.userConfig]);
            for (const [object, entry] of target.settings) {
                if (objects.has(object)) continue;
                restoreSetting(entry);
                target.settings.delete(object);
            }
            for (const object of objects) limitSetting(target, object);
            // Only undo a speed-up identified by native. Preserve holds, shortcuts, pauses and 0 rate.
            const automatic = target.player.getPreProcessorControl?.("hls")?.isCatchUpRateActive;
            const rate = target.video.playbackRate;
            if (automatic === true && rate > 1 && [...target.settings.values()].some((entry) => entry.value === rate))
                target.video.playbackRate = 1;
            if (target.video.getAttribute(MARKER) !== "active") target.video.setAttribute(MARKER, "active");
        } catch {
            release();
        }
    }

    function sync() {
        if (!installed || !isLive() || isNativeAdBreakActive()) {
            release();
            return;
        }
        const owner = findOwner();
        if (binding && (!isCurrent(binding) || owner?.player !== binding.player || owner.hls !== binding.hls))
            release();
        if (!binding) {
            if (!owner) return;
            const target = { ...owner, route: location.pathname, settings: new Map() };
            target.onLevel = () => applyLimit(target);
            binding = target;
            try {
                target.hls.on(LEVEL_EVENT, target.onLevel);
            } catch {
                release();
                return;
            }
        }
        applyLimit(binding);
    }

    function scheduleSync() {
        if (!installed || timer) return;
        timer = window.setTimeout(() => {
            timer = 0;
            sync();
        }, 0);
    }

    function onMedia(event) {
        if (!(event.target instanceof HTMLVideoElement)) return;
        if (event.type === "ratechange" && event.target !== binding?.video) return;
        if (event.type === "emptied" && event.target === binding?.video) release();
        scheduleSync();
    }

    function onMutations(records) {
        if (binding && !binding.video.isConnected) {
            release();
            scheduleSync();
            return;
        }
        for (const record of records) {
            if (record.type === "attributes") {
                if (record.target.matches?.("#midAdPlayerWrapper, .pzp-pc")) scheduleSync();
                continue;
            }
            if (
                [...record.addedNodes, ...record.removedNodes].some(
                    (node) =>
                        node instanceof Element &&
                        (node.matches(CHANGE_SELECTOR) || node.querySelector(CHANGE_SELECTOR))
                )
            ) {
                scheduleSync();
                return;
            }
        }
    }

    function stop() {
        installed = false;
        clearTimeout(timer);
        timer = 0;
        observer?.disconnect();
        observer = null;
        for (const event of MEDIA_EVENTS) document.removeEventListener(event, onMedia, true);
        release();
    }

    function update() {
        enabled = document.documentElement?.getAttribute(STATE_ATTR) === "1";
        if (!enabled || suspended || !isLive()) {
            stop();
            return;
        }
        if (!installed) {
            installed = true;
            for (const event of MEDIA_EVENTS) document.addEventListener(event, onMedia, true);
            observer = new MutationObserver(onMutations);
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["class", "style"],
            });
        }
        sync();
    }

    window.addEventListener(STATE_EVENT, update);
    window.addEventListener("cheese-spanner:routechange", update);
    window.addEventListener("popstate", update);
    window.addEventListener("pagehide", () => {
        suspended = true;
        stop();
    });
    window.addEventListener("pageshow", () => {
        suspended = false;
        update();
    });
    update();
})();
