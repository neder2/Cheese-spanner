(() => {
    const INSTALL_FLAG = "__betterChzzkAutoQualityPageInstalled";
    const INJECT_ATTR = "data-betterchzzk-auto-quality-page-injected";

    if (globalThis.chrome?.runtime?.getURL) {
        try {
            if (!document.documentElement.hasAttribute(INJECT_ATTR)) {
                document.documentElement.setAttribute(INJECT_ATTR, "1");

                const script = document.createElement("script");
                script.src = chrome.runtime.getURL("features/autoQualityPage.js");
                script.async = false;
                script.onload = () => script.remove();
                (document.head || document.documentElement).prepend(script);
            }
        } catch (_) {
            // If script injection is unavailable, keep the isolated-world fallback from running.
        }
        return;
    }

    if (window[INSTALL_FLAG]) return;
    try {
        Object.defineProperty(window, INSTALL_FLAG, { value: true });
    } catch (_) {
        window[INSTALL_FLAG] = true;
    }

    const APPLY_EVENT = "betterchzzk:auto-quality:apply";
    const REQUEST_ATTR = "data-betterchzzk-auto-quality-request";
    const RESULT_ATTR = "data-betterchzzk-auto-quality-result";
    const STATE_EVENT = "betterchzzk:auto-quality:state";
    const STATE_ATTR = "data-betterchzzk-auto-quality-state";
    const STATE_CACHE_KEY = "betterchzzk:auto-quality:state-cache";
    const STATUS_ATTR = "data-betterchzzk-auto-quality-status";
    const DEFAULT_QUALITY = "1080p";
    const PLAYBACK_ROUTE_RE = /^\/(?:live|video)(?:\/|$)/;
    const PAGE_APPLY_WINDOW_MS = 8000;
    const TRACK_RECOVERY_WINDOW_MS = 5000;
    const PAGE_FAST_RETRY_WINDOW_MS = 3000;
    const PAGE_FAST_RETRY_DELAY_MS = 90;
    const PAGE_SLOW_RETRY_DELAY_MS = 350;
    const PAGE_VERIFY_DELAY_MS = 180;
    const FULL_PLAYER_SCAN_INTERVAL_MS = 1200;
    const PLAYBACK_RESTORE_DELAY_MS = 250;
    const PLAYBACK_RESTORE_RETRY_MS = 180;
    const PLAYBACK_RESTORE_MAX_ATTEMPTS = 12;
    const STARTUP_AUTOPLAY_GRACE_MS = 3500;
    const RESTORE_TIME_EPSILON_SECONDS = 1.5;
    const RESTORE_TIME_ALLOWED_DRIFT_SECONDS = 2.5;
    const VOD_STARTUP_READY_SECONDS = 1.25;
    const VOD_STARTUP_MAX_WAIT_MS = 1500;
    const VOD_STARTUP_SEEK_SETTLE_MS = 180;
    const VOD_RESUME_CONTROL_TEXT_RE = /(?:이어\s*보기|이어서\s*보기|마지막\s*시청|보던\s*위치|시청\s*중인\s*위치)/;
    const USER_MEDIA_INTENT_WINDOW_MS = 1500;
    const COMMENT_TIMELINE_SEEK_EPSILON_SECONDS = 1.25;
    const COMMENT_TIMELINE_SEEK_STABLE_MS = 450;
    const COMMENT_TIMELINE_SEEK_INTENT_WINDOW_MS = 5000;
    const COMMENT_TIMELINE_SEEK_RETRIES = [500, 1000, 1700, 2600, 3400];
    const COMMENT_TIMELINE_SEEK_CLEANUP_MS =
        COMMENT_TIMELINE_SEEK_RETRIES[COMMENT_TIMELINE_SEEK_RETRIES.length - 1] + COMMENT_TIMELINE_SEEK_STABLE_MS + 100;
    const URL_START_PARAM = "currentTime";
    const URL_START_SEEK_EPSILON_SECONDS = 1.25;
    const URL_START_SEEK_STABLE_MS = 650;
    const URL_START_SEEK_INTENT_WINDOW_MS = 12000;
    const URL_START_SEEK_RETRIES = [250, 700, 1200, 2000, 3200, 5000, 7500, 10500];
    const URL_START_SEEK_CLEANUP_MS =
        URL_START_SEEK_RETRIES[URL_START_SEEK_RETRIES.length - 1] + URL_START_SEEK_STABLE_MS + 100;
    const MAX_TRACKED_QUALITY_TARGETS = 40;
    const TIMECODE_TEXT_RE = /^(?:\d{1,2}:)?\d{1,2}:\d{2}$/;
    const QUALITY_TARGET_KEYS = [
        "_corePlayer",
        "corePlayer",
        "_player",
        "player",
        "_controller",
        "controller",
        "_mediaController",
        "mediaController",
    ];
    const PLAYER_INTERACTION_SELECTOR = [
        "video",
        "pzp-pc",
        "pzp-player",
        "pzp-core-player",
        "pzp-pc-player",
        "[class^='pzp']",
        "[class*=' pzp']",
    ].join(", ");
    const PLAYER_DISCOVERY_SELECTORS = Object.freeze([
        "pzp-pc",
        "pzp-player",
        "pzp-core-player",
        "pzp-pc-player",
        "[class^='pzp']",
        "[class*=' pzp']",
    ]);
    const PLAYER_MUTATION_SELECTOR = `video, ${PLAYER_DISCOVERY_SELECTORS.join(", ")}`;

    let cachedPlayer = null;
    let preferredQuality = DEFAULT_QUALITY;
    let pageApplyTimer = 0;
    let pageApplyStartedAt = 0;
    let pageApplyDeadline = 0;
    let observedTrackList = null;
    let pageObserver = null;
    let lastFullPlayerScanAt = 0;
    let playerSearchMisses = 0;
    let autoQualityEnabled = true;
    let commentTimelineSeekSeq = 0;
    let activeCommentTimelineSeek = null;
    let lastCommentTimelineSeekAt = 0;
    let lastUserMediaIntentAt = 0;
    let vodGuardVideo = null;
    let vodStartupHref = "";
    let vodStartupFirstSeenAt = 0;
    let vodStartupMediaReadyAt = 0;
    let vodStartupLastSeekAt = 0;
    let vodStartupSettled = false;
    let urlStartSeekSeq = 0;
    let activeUrlStartSeek = null;
    let lastUrlStartSeekAt = 0;
    let lastUrlStartSeekHref = "";
    let pageEventListenersInstalled = false;
    const trackedQualityTargets = [];

    const nativeDefineProperty = Object.defineProperty;
    const nativeDefineProperties = Object.defineProperties;
    const nativeReflectDefineProperty = Reflect?.defineProperty;

    function isPlaybackRoute() {
        return PLAYBACK_ROUTE_RE.test(location.pathname);
    }

    function isVodRoute() {
        return /^\/video(?:\/|$)/.test(location.pathname);
    }

    function getCompactText(el) {
        if (!(el instanceof Element)) return "";
        return String(el.textContent || "").replace(/\s+/g, " ").trim();
    }

    function parseTimecodeSeconds(text) {
        const parts = String(text || "").trim().split(":").map(Number);
        if ((parts.length !== 2 && parts.length !== 3) || parts.some((value) => !Number.isFinite(value))) {
            return NaN;
        }

        const hasHours = parts.length === 3;
        const seconds = parts.pop();
        const minutes = parts.pop();
        const hours = parts.pop() || 0;
        if (seconds < 0 || seconds >= 60 || minutes < 0 || (hasHours && minutes >= 60) || hours < 0) return NaN;
        return hours * 3600 + minutes * 60 + seconds;
    }

    function isVideoNavigationControl(control) {
        if (!(control instanceof Element)) return false;

        const anchor = control.matches?.("a[href]")
            ? control
            : control.closest?.("a[href]");
        const href = anchor?.getAttribute?.("href") || "";
        return /(?:^|\/\/chzzk\.naver\.com)?\/video\/\d+(?:[/?#]|$)/.test(href);
    }

    function getCommentTimelineSeekSeconds(target) {
        if (!isVodRoute() || !(target instanceof Element)) return NaN;

        let el = target;
        for (let depth = 0; el && el !== document.documentElement && depth < 6; depth += 1) {
            const control = el.matches?.("button, a, [role='button'], [onclick]")
                ? el
                : el.closest?.("button, a, [role='button'], [onclick]");
            if (control instanceof Element) {
                if (isVideoNavigationControl(control)) return NaN;

                const text = getCompactText(control);
                if (TIMECODE_TEXT_RE.test(text)) {
                    const seconds = parseTimecodeSeconds(text);
                    if (Number.isFinite(seconds)) return seconds;
                }
            }
            el = el.parentElement;
        }

        return NaN;
    }

    function isCommentTimelineSeekSatisfied(video, currentTime, targetSeconds, clickedAt) {
        if (!Number.isFinite(currentTime)) return false;
        if (Math.abs(currentTime - targetSeconds) <= COMMENT_TIMELINE_SEEK_EPSILON_SECONDS) return true;
        if (currentTime < targetSeconds) return false;

        const elapsedSeconds = Math.max(0, (performance.now() - clickedAt) / 1000);
        const playbackRate = Number(video?.playbackRate);
        const expectedProgress = elapsedSeconds * (Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1);
        return currentTime <= targetSeconds + expectedProgress + COMMENT_TIMELINE_SEEK_EPSILON_SECONDS;
    }

    function hasRecentCommentTimelineSeekIntent(now = performance.now()) {
        return isVodRoute() &&
            lastCommentTimelineSeekAt > 0 &&
            now - lastCommentTimelineSeekAt <= COMMENT_TIMELINE_SEEK_INTENT_WINDOW_MS;
    }

    function finishCommentTimelineSeek(seq) {
        if (seq !== commentTimelineSeekSeq) return;
        activeCommentTimelineSeek = null;
        commentTimelineSeekSeq += 1;
    }

    function getUrlStartSeekSeconds() {
        if (!isVodRoute()) return NaN;

        try {
            const raw = new URL(location.href).searchParams.get(URL_START_PARAM);
            if (!raw) return NaN;

            const seconds = Number(raw);
            return Number.isFinite(seconds) && seconds > 0 ? seconds : NaN;
        } catch (_) {
            return NaN;
        }
    }

    function isUrlStartSeekSatisfied(video, currentTime, targetSeconds, startedAt) {
        if (!Number.isFinite(currentTime)) return false;
        if (Math.abs(currentTime - targetSeconds) <= URL_START_SEEK_EPSILON_SECONDS) return true;
        if (currentTime < targetSeconds) return false;

        const elapsedSeconds = Math.max(0, (performance.now() - startedAt) / 1000);
        const playbackRate = Number(video?.playbackRate);
        const expectedProgress = elapsedSeconds * (Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1);
        return currentTime <= targetSeconds + expectedProgress + URL_START_SEEK_EPSILON_SECONDS;
    }

    function hasRecentUrlStartSeekIntent(now = performance.now()) {
        return isVodRoute() &&
            lastUrlStartSeekAt > 0 &&
            now - lastUrlStartSeekAt <= URL_START_SEEK_INTENT_WINDOW_MS;
    }

    function finishUrlStartSeek(seq) {
        if (seq !== urlStartSeekSeq) return;
        activeUrlStartSeek = null;
        urlStartSeekSeq += 1;
    }

    function enforceUrlStartSeek(targetSeconds, seq, startedAt) {
        const state = activeUrlStartSeek;
        if (!state || state.seq !== seq || seq !== urlStartSeekSeq || !isVodRoute()) return;
        if (location.href !== state.href) {
            finishUrlStartSeek(seq);
            return;
        }

        const video = getMainVideo();
        if (!(video instanceof HTMLVideoElement)) return;
        if (Number.isFinite(video.duration) && video.duration > 0 && targetSeconds > video.duration + 1) {
            finishUrlStartSeek(seq);
            return;
        }

        const currentTime = Number(video.currentTime);
        const now = performance.now();
        if (isUrlStartSeekSatisfied(video, currentTime, targetSeconds, startedAt)) {
            state.satisfiedAt = state.satisfiedAt || now;
            return;
        }

        state.satisfiedAt = 0;

        try {
            video.currentTime = targetSeconds;
        } catch (_) {
            // The player can reject seeks until metadata has settled; scheduled retries cover that.
        }
    }

    function scheduleUrlStartSeekFix(targetSeconds, href = location.href) {
        if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) return;

        const seq = ++urlStartSeekSeq;
        const startedAt = performance.now();
        lastUrlStartSeekAt = startedAt;
        activeUrlStartSeek = { seq, href, targetSeconds, startedAt, satisfiedAt: 0 };
        for (const delay of URL_START_SEEK_RETRIES) {
            setTimeout(() => enforceUrlStartSeek(targetSeconds, seq, startedAt), delay);
        }
        setTimeout(() => finishUrlStartSeek(seq), URL_START_SEEK_CLEANUP_MS);
    }

    function syncUrlStartSeekIntent() {
        const href = location.href;
        const targetSeconds = getUrlStartSeekSeconds();
        if (!Number.isFinite(targetSeconds)) {
            lastUrlStartSeekHref = href;
            lastUrlStartSeekAt = 0;
            if (activeUrlStartSeek) finishUrlStartSeek(activeUrlStartSeek.seq);
            return;
        }

        if (
            lastUrlStartSeekHref === href &&
            activeUrlStartSeek?.targetSeconds === targetSeconds
        ) {
            return;
        }

        lastUrlStartSeekHref = href;
        scheduleUrlStartSeekFix(targetSeconds, href);
    }

    function enforceCommentTimelineSeek(targetSeconds, seq, clickedAt) {
        const state = activeCommentTimelineSeek;
        if (!state || state.seq !== seq || seq !== commentTimelineSeekSeq || !isVodRoute()) return;

        const video = getMainVideo();
        if (!(video instanceof HTMLVideoElement)) return;
        if (Number.isFinite(video.duration) && video.duration > 0 && targetSeconds > video.duration + 1) return;

        const currentTime = Number(video.currentTime);
        const now = performance.now();
        if (isCommentTimelineSeekSatisfied(video, currentTime, targetSeconds, clickedAt)) {
            state.satisfiedAt = state.satisfiedAt || now;
            return;
        }

        state.satisfiedAt = 0;

        try {
            video.currentTime = targetSeconds;
        } catch (_) {
            // Some player states reject direct seeks briefly; later retries cover that.
        }
    }

    function scheduleCommentTimelineSeekFix(targetSeconds) {
        if (!Number.isFinite(targetSeconds) || targetSeconds < 0) return;

        const seq = ++commentTimelineSeekSeq;
        const clickedAt = performance.now();
        lastCommentTimelineSeekAt = clickedAt;
        activeCommentTimelineSeek = { seq, targetSeconds, clickedAt, satisfiedAt: 0 };
        for (const delay of COMMENT_TIMELINE_SEEK_RETRIES) {
            setTimeout(() => enforceCommentTimelineSeek(targetSeconds, seq, clickedAt), delay);
        }
        setTimeout(() => finishCommentTimelineSeek(seq), COMMENT_TIMELINE_SEEK_CLEANUP_MS);
    }

    function handleCommentTimelineClick(event) {
        const targetSeconds = getCommentTimelineSeekSeconds(event.target);
        if (Number.isFinite(targetSeconds)) scheduleCommentTimelineSeekFix(targetSeconds);
    }

    function isEditableTarget(target) {
        return target instanceof Element &&
            Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
    }

    function isPlayerInteractionTarget(target) {
        return target instanceof Element &&
            Boolean(target.closest(PLAYER_INTERACTION_SELECTOR));
    }

    function cancelCommentTimelineSeekOnUserIntent(event) {
        const shouldCancelUrlStartSeek = Boolean(activeUrlStartSeek) &&
            (event.type === "keydown" || isPlayerInteractionTarget(event.target));
        if (!activeCommentTimelineSeek && !shouldCancelUrlStartSeek) return;

        if (event.type === "keydown") {
            if (isEditableTarget(event.target)) return;
            if (!["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "j", "J", "l", "L"].includes(event.key)) {
                return;
            }
        }

        if (activeCommentTimelineSeek) finishCommentTimelineSeek(activeCommentTimelineSeek.seq);
        if (shouldCancelUrlStartSeek && activeUrlStartSeek) {
            lastUrlStartSeekAt = 0;
            finishUrlStartSeek(activeUrlStartSeek.seq);
        }
    }

    function rememberUserMediaIntent(event) {
        if (!isVodRoute()) return;

        if (event.type === "keydown") {
            if (isEditableTarget(event.target)) return;
            if (!["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", " ", "k", "K", "j", "J", "l", "L"].includes(event.key)) {
                return;
            }
        }

        const now = performance.now();
        lastUserMediaIntentAt = now;
    }

    function hasRecentUserMediaIntent(now = performance.now()) {
        return lastUserMediaIntentAt > 0 && now - lastUserMediaIntentAt <= USER_MEDIA_INTENT_WINDOW_MS;
    }


    function readAutoQualityState() {
        let raw = document.documentElement.getAttribute(STATE_ATTR);
        if (!raw) {
            try {
                raw = localStorage.getItem(STATE_CACHE_KEY);
            } catch (_) {
                raw = "";
            }
        }
        if (!raw) return;

        try {
            const state = JSON.parse(raw);
            autoQualityEnabled = Boolean(state?.enabled);
            preferredQuality = state?.quality || DEFAULT_QUALITY;
        } catch {
            autoQualityEnabled = false;
        }
    }

    function syncAutoQualityState() {
        readAutoQualityState();
        if (autoQualityEnabled) {
            syncUrlStartSeekIntent();
            installPageEventListeners();
        } else {
            uninstallPageEventListeners();
        }

        if (!isPlaybackRoute()) {
            clearPageAutoApply();
            detachVodPlaybackGuard();
            return;
        }

        if (!autoQualityEnabled) {
            clearPageAutoApply();
            detachVodPlaybackGuard();
            return;
        }

        ensureVodPlaybackGuardAttached();
        startPageAutoApply();
    }

    function installPageEventListeners() {
        if (pageEventListenersInstalled) return;
        pageEventListenersInstalled = true;
        document.addEventListener("click", handleCommentTimelineClick, true);
        document.addEventListener("pointerdown", cancelCommentTimelineSeekOnUserIntent, true);
        document.addEventListener("mousedown", cancelCommentTimelineSeekOnUserIntent, true);
        document.addEventListener("touchstart", cancelCommentTimelineSeekOnUserIntent, true);
        window.addEventListener("keydown", cancelCommentTimelineSeekOnUserIntent, true);
        document.addEventListener("pointerdown", rememberUserMediaIntent, true);
        document.addEventListener("mousedown", rememberUserMediaIntent, true);
        document.addEventListener("touchstart", rememberUserMediaIntent, true);
        window.addEventListener("keydown", rememberUserMediaIntent, true);
    }

    function uninstallPageEventListeners() {
        if (!pageEventListenersInstalled) return;
        pageEventListenersInstalled = false;
        if (activeCommentTimelineSeek) finishCommentTimelineSeek(activeCommentTimelineSeek.seq);
        if (activeUrlStartSeek) {
            lastUrlStartSeekAt = 0;
            finishUrlStartSeek(activeUrlStartSeek.seq);
        }
        document.removeEventListener("click", handleCommentTimelineClick, true);
        document.removeEventListener("pointerdown", cancelCommentTimelineSeekOnUserIntent, true);
        document.removeEventListener("mousedown", cancelCommentTimelineSeekOnUserIntent, true);
        document.removeEventListener("touchstart", cancelCommentTimelineSeekOnUserIntent, true);
        window.removeEventListener("keydown", cancelCommentTimelineSeekOnUserIntent, true);
        document.removeEventListener("pointerdown", rememberUserMediaIntent, true);
        document.removeEventListener("mousedown", rememberUserMediaIntent, true);
        document.removeEventListener("touchstart", rememberUserMediaIntent, true);
        window.removeEventListener("keydown", rememberUserMediaIntent, true);
    }

    function rememberQualityTarget(target) {
        if (!target || (typeof target !== "object" && typeof target !== "function")) return;
        if (trackedQualityTargets.includes(target)) return;

        trackedQualityTargets.push(target);
        if (trackedQualityTargets.length > MAX_TRACKED_QUALITY_TARGETS) {
            trackedQualityTargets.shift();
        }
    }

    function findTrackedQualityTarget() {
        for (let index = trackedQualityTargets.length - 1; index >= 0; index -= 1) {
            const target = trackedQualityTargets[index];
            if (hasQualityControlTarget(target)) return target;
        }

        return null;
    }

    function readLooseProp(target, prop) {
        try {
            return target?.[prop];
        } catch {
            return null;
        }
    }

    function collectQualityTargets(root, includeTracked = true) {
        const targets = [];
        const seen = new WeakSet();

        const add = (target, depth) => {
            if (!target || (typeof target !== "object" && typeof target !== "function")) return;
            if (seen.has(target)) return;
            seen.add(target);
            targets.push(target);

            if (depth <= 0) return;
            for (const key of QUALITY_TARGET_KEYS) {
                add(readLooseProp(target, key), depth - 1);
            }
        };

        add(root, 2);
        if (includeTracked) {
            for (const target of trackedQualityTargets) add(target, 1);
        }

        return targets;
    }

    function getTrackListFromTarget(target) {
        const tracks = readLooseProp(target, "videoTracks");
        return tracks && Number.isFinite(Number(tracks.length)) && Number(tracks.length) > 0
            ? tracks
            : null;
    }

    function findVideoTrackListTarget(player, includeTracked = true) {
        for (const target of collectQualityTargets(player, includeTracked)) {
            if (isElement(target) && !target.isConnected) continue;
            const trackList = getTrackListFromTarget(target);
            if (!trackList) continue;
            rememberQualityTarget(target);
            return { target, trackList };
        }

        return null;
    }

    function wrapVideoTracksDescriptor(prop, descriptor) {
        if (prop !== "videoTracks" || !descriptor) return descriptor;
        if (descriptor.get?.__betterChzzkVideoTracksWrapped || descriptor.set?.__betterChzzkVideoTracksWrapped) return descriptor;

        const nextDescriptor = { ...descriptor };

        if (typeof descriptor.get === "function") {
            const originalGet = descriptor.get;
            nextDescriptor.get = function() {
                const tracks = originalGet.call(this);
                if (tracks && Number.isFinite(Number(tracks.length)) && Number(tracks.length) > 0) {
                    rememberQualityTarget(this);
                }
                return tracks;
            };

            try {
                nativeDefineProperty(nextDescriptor.get, "__betterChzzkVideoTracksWrapped", { value: true });
            } catch (_) {
                nextDescriptor.get.__betterChzzkVideoTracksWrapped = true;
            }
        }

        if (typeof descriptor.set === "function") {
            const originalSet = descriptor.set;
            nextDescriptor.set = function(value) {
                rememberQualityTarget(this);
                return originalSet.call(this, value);
            };

            try {
                nativeDefineProperty(nextDescriptor.set, "__betterChzzkVideoTracksWrapped", { value: true });
            } catch (_) {
                nextDescriptor.set.__betterChzzkVideoTracksWrapped = true;
            }
        }

        return nextDescriptor;
    }

    function wrapQualityDescriptor(prop, descriptor) {
        return wrapVideoTracksDescriptor(prop, descriptor);
    }

    function safeWrapQualityDescriptor(prop, descriptor) {
        try {
            return wrapQualityDescriptor(prop, descriptor);
        } catch (_) {
            return descriptor;
        }
    }

    function installQualityTargetInterceptor() {
        try {
            Object.defineProperty = function(target, prop, descriptor) {
                return nativeDefineProperty.call(Object, target, prop, safeWrapQualityDescriptor(prop, descriptor));
            };
        } catch (_) {
            // If the runtime blocks patching, the normal videoTracks path still runs.
        }

        if (nativeDefineProperties) {
            try {
                Object.defineProperties = function(target, descriptors) {
                    if (descriptors == null) {
                        return nativeDefineProperties.call(Object, target, descriptors);
                    }

                    let nextDescriptors = descriptors;
                    try {
                        nextDescriptors = {};
                        for (const key of Reflect.ownKeys(descriptors)) {
                            nextDescriptors[key] = wrapQualityDescriptor(key, descriptors[key]);
                        }
                    } catch (_) {
                        nextDescriptors = descriptors;
                    }

                    return nativeDefineProperties.call(Object, target, nextDescriptors);
                };
            } catch (_) {
                // Keep Object.defineProperty interception even if defineProperties cannot be patched.
            }
        }

        if (nativeReflectDefineProperty) {
            try {
                Reflect.defineProperty = function(target, prop, descriptor) {
                    return nativeReflectDefineProperty.call(Reflect, target, prop, safeWrapQualityDescriptor(prop, descriptor));
                };
            } catch (_) {
                // Reflect.defineProperty patching is opportunistic.
            }
        }
    }

    installQualityTargetInterceptor();
    syncAutoQualityState();
    window.addEventListener(STATE_EVENT, syncAutoQualityState);
    window.addEventListener("pageshow", syncAutoQualityState, true);

    function isElement(value) {
        return value instanceof HTMLElement;
    }

    function isVisible(el) {
        if (!isElement(el) || !el.isConnected) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
    }

    function visibleArea(el) {
        if (!isVisible(el)) return 0;
        const rect = el.getBoundingClientRect();
        return rect.width * rect.height;
    }

    function getMainVideo() {
        const videos = Array.from(document.querySelectorAll("video"));
        if (!videos.length) return null;
        videos.sort((a, b) => visibleArea(b) - visibleArea(a));
        return videos[0];
    }

    function hasVideoTrackList(el) {
        return Boolean(findVideoTrackListTarget(el, false));
    }

    function hasQualityControlTarget(el) {
        if (isElement(el) && !el.isConnected) return false;
        return hasVideoTrackList(el);
    }

    function findPlayerBySelectorOnly() {
        for (const selector of PLAYER_DISCOVERY_SELECTORS) {
            for (const el of document.querySelectorAll(selector)) {
                if (hasQualityControlTarget(el)) return el;
            }
        }

        return null;
    }

    function elementContainsVideo(el, video) {
        if (!isElement(el) || !isElement(video)) return false;
        if (el.contains(video)) return true;
        try {
            return Boolean(el.shadowRoot?.contains(video));
        } catch {
            return false;
        }
    }

    function overlapsVideo(el, video) {
        if (!isVisible(el) || !isVisible(video)) return false;
        const rect = el.getBoundingClientRect();
        const videoRect = video.getBoundingClientRect();
        return (
            rect.right >= videoRect.left - 80 &&
            rect.left <= videoRect.right + 80 &&
            rect.bottom >= videoRect.top - 80 &&
            rect.top <= videoRect.bottom + 80
        );
    }

    function findPlayerFromAncestors(video) {
        let node = video;
        let depth = 0;

        while (node && node !== document.body && depth < 16) {
            if (hasQualityControlTarget(node)) return node;
            node = node.parentElement || node.getRootNode?.()?.host || null;
            depth += 1;
        }

        return null;
    }

    function findPlayerFromDocument(video) {
        for (const selector of PLAYER_DISCOVERY_SELECTORS) {
            for (const el of document.querySelectorAll(selector)) {
                if (!hasQualityControlTarget(el)) continue;
                if (elementContainsVideo(el, video) || overlapsVideo(el, video)) {
                    playerSearchMisses = 0;
                    return el;
                }
            }
        }

        playerSearchMisses += 1;
        if (playerSearchMisses < 3) return null;

        const now = performance.now();
        if (now - lastFullPlayerScanAt < FULL_PLAYER_SCAN_INTERVAL_MS) return null;
        lastFullPlayerScanAt = now;

        for (const el of document.querySelectorAll("*")) {
            if (!hasQualityControlTarget(el)) continue;
            if (elementContainsVideo(el, video) || overlapsVideo(el, video)) {
                playerSearchMisses = 0;
                return el;
            }
        }

        return null;
    }

    function getPlayer() {
        if (!isPlaybackRoute()) return null;

        const video = getMainVideo();
        if (!video) {
            if (hasQualityControlTarget(cachedPlayer)) return cachedPlayer;
            cachedPlayer = findTrackedQualityTarget() || findPlayerBySelectorOnly();
            return cachedPlayer;
        }

        if (hasQualityControlTarget(cachedPlayer) && (elementContainsVideo(cachedPlayer, video) || overlapsVideo(cachedPlayer, video))) {
            return cachedPlayer;
        }

        cachedPlayer = findPlayerFromAncestors(video) || findTrackedQualityTarget() || findPlayerFromDocument(video);
        return cachedPlayer;
    }

    function toTrackArray(trackList) {
        const tracks = [];
        const length = Number(trackList?.length) || 0;

        for (let index = 0; index < length; index += 1) {
            const track = trackList[index] || trackList.item?.(index);
            if (track) tracks.push(track);
        }

        return tracks;
    }

    function pushTrackTextPart(parts, value) {
        if (value == null || value === "") return;
        if (typeof value === "object") {
            const width = Number(readLooseProp(value, "width") || readLooseProp(value, "videoWidth"));
            const height = Number(readLooseProp(value, "height") || readLooseProp(value, "videoHeight"));
            if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
                parts.push(`${Math.round(width)}x${Math.round(height)}`);
            }
            return;
        }
        parts.push(String(value));
    }

    function pushTrackTextProp(parts, target, prop) {
        pushTrackTextPart(parts, readLooseProp(target, prop));
    }

    function trackText(track) {
        const parts = [];
        [
            "id",
            "label",
            "kind",
            "videoQuality",
            "qualityLabel",
            "quality",
            "resolution",
            "displayResolution",
            "height",
            "width",
            "videoHeight",
            "videoWidth",
            "videoBitrate",
            "encodingOptionID",
            "encodingOptionId",
            "src",
            "baseUrl",
            "url",
        ].forEach((prop) => pushTrackTextProp(parts, track, prop));

        const dataset = readLooseProp(track, "dataset");
        [
            "encodingTrackId",
            "encodingOptionID",
            "encodingOptionId",
            "quality",
            "qualityLabel",
            "label",
            "resolution",
            "height",
            "videoHeight",
            "width",
            "videoWidth",
        ].forEach((prop) => pushTrackTextProp(parts, dataset, prop));

        const attributes = readLooseProp(track, "attributes");
        [
            "RESOLUTION",
            "resolution",
            "height",
            "videoHeight",
            "BANDWIDTH",
            "bandwidth",
        ].forEach((prop) => pushTrackTextProp(parts, attributes, prop));

        return parts.join(" ").toLowerCase();
    }

    function isAutomaticTrack(track) {
        const text = trackText(track);
        return text.includes("abr") || text.includes("auto") || text.includes("\uC790\uB3D9");
    }

    function getPreferredHeight(quality) {
        const match = String(quality || DEFAULT_QUALITY).match(/\d{3,4}/);
        return match ? Number(match[0]) : 1080;
    }

    function shouldResumeAfterQualityChange(video, wasPaused) {
        if (!(video instanceof HTMLVideoElement)) return false;
        if (!wasPaused) return true;
        if (video.autoplay) return true;
        if (document.visibilityState === "hidden") return false;

        const elapsedSinceAutoApply = pageApplyStartedAt
            ? performance.now() - pageApplyStartedAt
            : Number.POSITIVE_INFINITY;
        return elapsedSinceAutoApply <= STARTUP_AUTOPLAY_GRACE_MS;
    }

    function shouldRestorePlaybackTime(video, capturedTime) {
        if (!(video instanceof HTMLVideoElement) || !Number.isFinite(capturedTime) || capturedTime <= 0) return false;
        if (hasRecentCommentTimelineSeekIntent()) return false;
        if (hasRecentUrlStartSeekIntent()) return false;

        const currentTime = Number(video.currentTime);
        if (!Number.isFinite(currentTime)) return false;

        return currentTime < RESTORE_TIME_EPSILON_SECONDS && capturedTime > RESTORE_TIME_EPSILON_SECONDS;
    }

    function isPlaybackTimeNearExpected(video, currentTime, capturedTime, startedAt) {
        if (!Number.isFinite(currentTime) || !Number.isFinite(capturedTime)) return false;

        const elapsedSeconds = Math.max(0, (performance.now() - startedAt) / 1000);
        const playbackRate = Number(video?.playbackRate);
        const expectedProgress = elapsedSeconds * (Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1);
        return Math.abs(currentTime - (capturedTime + expectedProgress)) <= RESTORE_TIME_ALLOWED_DRIFT_SECONDS;
    }

    function shouldCancelPlaybackTimeRestore(video, capturedTime, startedAt) {
        if (!(video instanceof HTMLVideoElement) || !Number.isFinite(capturedTime) || capturedTime <= 0) return true;
        if (hasRecentCommentTimelineSeekIntent()) return true;
        if (lastUserMediaIntentAt >= startedAt) return true;

        const currentTime = Number(video.currentTime);
        if (!Number.isFinite(currentTime)) return false;
        if (shouldRestorePlaybackTime(video, capturedTime)) return false;
        return !isPlaybackTimeNearExpected(video, currentTime, capturedTime, startedAt);
    }

    function restorePlaybackAfterQualityChange(video, currentTime, shouldResume) {
        let attemptCount = 0;
        let timeRestoreCancelled = false;
        const startedAt = performance.now();

        const runRestore = () => {
            const nextVideo = getMainVideo() || video;
            if (!(nextVideo instanceof HTMLVideoElement)) return;

            attemptCount += 1;

            if (!timeRestoreCancelled && shouldCancelPlaybackTimeRestore(nextVideo, currentTime, startedAt)) {
                timeRestoreCancelled = true;
            }

            if (!timeRestoreCancelled && shouldRestorePlaybackTime(nextVideo, currentTime)) {
                try {
                    nextVideo.currentTime = currentTime;
                } catch (_) {
                    // Some streams reject seeks until metadata is ready.
                }
            }

            let shouldRetry = !timeRestoreCancelled;

            if (shouldResume && nextVideo.paused) {
                const playResult = nextVideo.play?.();
                playResult?.catch?.(() => {});
                shouldRetry = shouldRetry || nextVideo.paused;
            }

            if (shouldRetry && attemptCount < PLAYBACK_RESTORE_MAX_ATTEMPTS) {
                setTimeout(runRestore, PLAYBACK_RESTORE_RETRY_MS);
            }
        };

        setTimeout(runRestore, PLAYBACK_RESTORE_DELAY_MS);
    }

    function clearVodGuardState() {
        vodStartupHref = "";
        vodStartupFirstSeenAt = 0;
        vodStartupMediaReadyAt = 0;
        vodStartupLastSeekAt = 0;
        vodStartupSettled = false;
    }

    function detachVodPlaybackGuard() {
        if (!vodGuardVideo) return;
        vodGuardVideo.removeEventListener("loadedmetadata", onVodStartupProgress, true);
        vodGuardVideo.removeEventListener("playing", onVodStartupProgress, true);
        vodGuardVideo.removeEventListener("seeking", onVodStartupProgress, true);
        vodGuardVideo.removeEventListener("seeked", onVodStartupProgress, true);
        vodGuardVideo.removeEventListener("timeupdate", onVodStartupProgress, true);
        vodGuardVideo = null;
        clearVodGuardState();
    }

    function ensureVodPlaybackGuardAttached() {
        if (!autoQualityEnabled || !isVodRoute()) {
            detachVodPlaybackGuard();
            return;
        }

        const video = getMainVideo();
        if (!(video instanceof HTMLVideoElement)) {
            detachVodPlaybackGuard();
            return;
        }

        if (vodGuardVideo === video) return;
        detachVodPlaybackGuard();
        vodGuardVideo = video;
        resetVodStartupState(video);
        vodGuardVideo.addEventListener("loadedmetadata", onVodStartupProgress, true);
        vodGuardVideo.addEventListener("playing", onVodStartupProgress, true);
        vodGuardVideo.addEventListener("seeking", onVodStartupProgress, true);
        vodGuardVideo.addEventListener("seeked", onVodStartupProgress, true);
        vodGuardVideo.addEventListener("timeupdate", onVodStartupProgress, true);
    }

    function getVodTime(video) {
        const value = Number(video?.currentTime);
        return Number.isFinite(value) ? value : NaN;
    }

    function resetVodStartupState(video) {
        vodStartupHref = location.href;
        vodStartupFirstSeenAt = performance.now();
        vodStartupMediaReadyAt = 0;
        vodStartupLastSeekAt = 0;
        vodStartupSettled = !isVodRoute() || !(video instanceof HTMLVideoElement);
    }

    function ensureVodStartupState(video) {
        if (vodGuardVideo !== video || vodStartupHref !== location.href || !vodStartupFirstSeenAt) {
            resetVodStartupState(video);
        }
    }

    function getResumeControlText(el) {
        if (!(el instanceof Element)) return "";
        return [
            el.textContent,
            el.getAttribute("aria-label"),
            el.getAttribute("title"),
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    }

    function hasVisibleVodResumeControl() {
        if (!isVodRoute()) return false;
        const controls = document.querySelectorAll("button, a, [role='button']");
        for (const el of controls) {
            if (!isVisible(el)) continue;
            if (VOD_RESUME_CONTROL_TEXT_RE.test(getResumeControlText(el))) return true;
        }
        return false;
    }

    function isVodStartupQualityReady(video) {
        if (!isVodRoute()) return true;
        if (!(video instanceof HTMLVideoElement)) return false;

        ensureVodStartupState(video);
        if (vodStartupSettled) return true;

        const now = performance.now();
        const currentTime = getVodTime(video);
        const mediaReady = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ||
            (Number.isFinite(Number(video.duration)) && Number(video.duration) > 0);
        if (mediaReady && !vodStartupMediaReadyAt) vodStartupMediaReadyAt = now;

        if (hasVisibleVodResumeControl()) return false;
        if (video.seeking) return false;
        if (vodStartupLastSeekAt && now - vodStartupLastSeekAt < VOD_STARTUP_SEEK_SETTLE_MS) return false;
        if (!mediaReady && (!Number.isFinite(currentTime) || currentTime < RESTORE_TIME_EPSILON_SECONDS)) return false;

        if (hasRecentUserMediaIntent(now) && Number.isFinite(currentTime) && currentTime > RESTORE_TIME_EPSILON_SECONDS) {
            vodStartupSettled = true;
        } else if (Number.isFinite(currentTime) && currentTime >= VOD_STARTUP_READY_SECONDS) {
            vodStartupSettled = true;
        } else if (vodStartupMediaReadyAt && now - vodStartupMediaReadyAt >= VOD_STARTUP_MAX_WAIT_MS) {
            vodStartupSettled = true;
        }

        return vodStartupSettled;
    }

    function shouldDeferVodStartupQuality() {
        if (!autoQualityEnabled || !isVodRoute()) return false;

        const video = getMainVideo();
        if (!(video instanceof HTMLVideoElement)) return true;
        ensureVodPlaybackGuardAttached();
        return !isVodStartupQualityReady(video);
    }

    function onVodStartupProgress(event) {
        const video = event.currentTarget;
        if (!(video instanceof HTMLVideoElement) || video !== vodGuardVideo) return;

        if (event.type === "seeking" || event.type === "seeked") {
            vodStartupLastSeekAt = performance.now();
        }

        if (isVodStartupQualityReady(video)) startPageAutoApply(TRACK_RECOVERY_WINDOW_MS);
    }

    function readNumericHeight(target, props) {
        for (const prop of props) {
            const value = Number(readLooseProp(target, prop));
            if (Number.isFinite(value) && value > 0) return Math.round(value);
        }

        return NaN;
    }

    function getTrackHeight(track) {
        const directHeight = readNumericHeight(track, ["height", "videoHeight"]);
        if (Number.isFinite(directHeight)) return directHeight;

        const datasetHeight = readNumericHeight(readLooseProp(track, "dataset"), ["height", "videoHeight"]);
        if (Number.isFinite(datasetHeight)) return datasetHeight;

        const attributesHeight = readNumericHeight(readLooseProp(track, "attributes"), ["height", "videoHeight"]);
        if (Number.isFinite(attributesHeight)) return attributesHeight;

        const text = trackText(track);
        const resolutionMatch = text.match(/\b\d{3,5}\s*x\s*(\d{3,4})\b/);
        if (resolutionMatch) return Number(resolutionMatch[1]);

        const labelMatch = text.match(/(?:^|[^\d])(\d{3,4})\s*p(?:\b|[^\d])/);
        return labelMatch ? Number(labelMatch[1]) : NaN;
    }

    function trackMatchesQuality(track, preferredHeight) {
        return !isAutomaticTrack(track) && getTrackHeight(track) === preferredHeight;
    }

    function getSelectableTrackCandidates(tracks) {
        const candidates = [];
        for (const track of tracks) {
            if (isAutomaticTrack(track)) continue;
            const height = getTrackHeight(track);
            if (!Number.isFinite(height)) continue;
            candidates.push({ track, height });
        }
        return candidates;
    }

    function isSelectedTrackValue(value) {
        if (value === true || value === 1) return true;
        if (typeof value !== "string") return false;

        const normalized = value.trim().toLowerCase();
        return ["1", "true", "selected", "active", "current", "enabled", "showing"].includes(normalized);
    }

    function getSingleSelectedTrackByProps(tracks, props) {
        for (const prop of props) {
            const matches = tracks.filter((track) => isSelectedTrackValue(readLooseProp(track, prop)));
            if (matches.length === 1) return matches[0];
        }

        return null;
    }

    function getSelectedTrack(tracks, trackList) {
        const selectedTrack = getSingleSelectedTrackByProps(tracks, [
            "selected",
            "isSelected",
            "active",
            "isActive",
            "current",
            "isCurrent",
            "enabled",
        ]);
        if (selectedTrack) return selectedTrack;

        const selectedIndex = Number(trackList?.selectedIndex);
        if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && tracks[selectedIndex]) {
            return tracks[selectedIndex];
        }

        return null;
    }

    function selectTrack(trackList, tracks, targetTrack) {
        const targetIndex = tracks.indexOf(targetTrack);

        for (const track of tracks) {
            if (track === targetTrack) continue;
            try {
                if (track?.selected) track.selected = false;
            } catch (_) {
                // Some player adapters expose selected as readonly.
            }
        }

        try {
            targetTrack.selected = true;
        } catch (_) {
            // Fall back to selectedIndex when the track object rejects writes.
        }

        try {
            if (targetIndex >= 0 && Number(trackList?.selectedIndex) !== targetIndex) {
                trackList.selectedIndex = targetIndex;
            }
        } catch (_) {
            // selectedIndex is not writable on every PZP adapter.
        }

        const selectedIndex = Number(trackList?.selectedIndex);
        const selectedTrack = Number.isInteger(selectedIndex) && selectedIndex >= 0
            ? tracks[selectedIndex]
            : getSelectedTrack(tracks, trackList);

        return selectedTrack === targetTrack || targetTrack.selected === true;
    }

    function scoreTrack(track, selectedTrack) {
        let score = 0;
        const text = trackText(track);

        if (track?.kind && selectedTrack?.kind && track.kind === selectedTrack.kind) score += 20;
        if (!text.includes("p2p")) score += 8;
        if (text.includes("low-latency")) score += 4;
        if (Number.isFinite(Number(track?.videoBitrate))) score += Math.min(Number(track.videoBitrate) / 1000000, 10);

        return score;
    }

    function pickTargetTrack(tracks, selectedTrack, preferredHeight) {
        const candidates = getSelectableTrackCandidates(tracks);
        if (!candidates.length) return null;

        const exactCandidates = candidates.filter((candidate) => candidate.height === preferredHeight);
        if (exactCandidates.length) {
            exactCandidates.sort((a, b) => scoreTrack(b.track, selectedTrack) - scoreTrack(a.track, selectedTrack));
            return exactCandidates[0].track;
        }

        const lowerCandidates = candidates.filter((candidate) => candidate.height < preferredHeight);
        if (!lowerCandidates.length) return null;

        const fallbackHeight = Math.max(...lowerCandidates.map((candidate) => candidate.height));
        const fallbackCandidates = lowerCandidates.filter((candidate) => candidate.height === fallbackHeight);
        fallbackCandidates.sort((a, b) => scoreTrack(b.track, selectedTrack) - scoreTrack(a.track, selectedTrack));
        return fallbackCandidates[0].track;
    }

    function describeTrack(track) {
        if (!track) return null;
        const height = getTrackHeight(track);
        return {
            id: String(track.id || ""),
            label: String(track.label || ""),
            kind: String(track.kind || ""),
            qualityLabel: String(track.qualityLabel || ""),
            height: Number.isFinite(height) ? height : null,
            automatic: isAutomaticTrack(track),
            selected: Boolean(track.selected),
        };
    }

    function describeTarget(target) {
        if (!target) return "";
        if (isElement(target)) {
            return [
                target.localName,
                target.id ? `#${target.id}` : "",
                target.className ? `.${String(target.className).trim().replace(/\s+/g, ".")}` : "",
            ].join("");
        }

        return String(target.constructor?.name || typeof target);
    }

    function applyQualityToPlayer(player, quality) {
        if (!player) return { status: "pending", reason: "player-missing" };

        ensureVodPlaybackGuardAttached();
        const preferredHeight = getPreferredHeight(quality);
        const video = getMainVideo();
        const currentTime = Number(video?.currentTime);
        const wasPaused = video?.paused !== false;
        const shouldResume = shouldResumeAfterQualityChange(video, wasPaused);
        const trackTarget = findVideoTrackListTarget(player);
        const trackList = trackTarget?.trackList || null;
        const tracks = toTrackArray(trackList);
        if (!tracks.length) {
            return { status: "pending", reason: "tracks-missing" };
        }

        const selectedTrack = getSelectedTrack(tracks, trackList);
        const targetTrack = pickTargetTrack(tracks, selectedTrack, preferredHeight);
        if (!targetTrack) {
            return {
                status: "unavailable",
                selected: describeTrack(selectedTrack),
                targetType: describeTarget(trackTarget?.target),
                trackCount: tracks.length,
            };
        }

        const targetHeight = getTrackHeight(targetTrack);
        if (selectedTrack && trackMatchesQuality(selectedTrack, targetHeight)) {
            return {
                status: "already",
                selected: describeTrack(selectedTrack),
                targetType: describeTarget(trackTarget?.target),
                trackCount: tracks.length,
            };
        }

        const selected = selectTrack(trackList, tracks, targetTrack);
        if (selected) {
            restorePlaybackAfterQualityChange(video, isVodRoute() ? currentTime : NaN, shouldResume);
        }

        return {
            status: selected ? "selected" : "pending",
            selected: describeTrack(targetTrack),
            previous: describeTrack(selectedTrack),
            targetType: describeTarget(trackTarget?.target),
            trackCount: tracks.length,
        };
    }

    function applyQuality(quality) {
        if (shouldDeferVodStartupQuality()) {
            return { status: "pending", reason: "vod-resume-wait" };
        }

        const player = getPlayer();
        bindTrackList(player);
        return applyQualityToPlayer(player, quality);
    }

    function removeTrackListListeners() {
        if (!observedTrackList?.removeEventListener) return;
        observedTrackList.removeEventListener("addtrack", onTrackListChanged, true);
        observedTrackList.removeEventListener("change", onTrackListChanged, true);
        observedTrackList.removeEventListener("removetrack", onTrackListChanged, true);
    }

    function bindTrackList(player) {
        const trackList = findVideoTrackListTarget(player)?.trackList || null;
        if (observedTrackList === trackList) return;

        removeTrackListListeners();
        observedTrackList = trackList;

        if (!observedTrackList?.addEventListener) return;
        observedTrackList.addEventListener("addtrack", onTrackListChanged, true);
        observedTrackList.addEventListener("change", onTrackListChanged, true);
        observedTrackList.addEventListener("removetrack", onTrackListChanged, true);
    }

    function clearPageAutoApply() {
        if (pageApplyTimer) {
            clearTimeout(pageApplyTimer);
            pageApplyTimer = 0;
        }

        pageApplyStartedAt = 0;
        pageApplyDeadline = 0;
        removeTrackListListeners();
        observedTrackList = null;
        stopPageObserver();
    }

    function schedulePageApply(delayMs) {
        if (!isPlaybackRoute()) {
            clearPageAutoApply();
            return;
        }

        if (pageApplyTimer) {
            if (delayMs > 0) return;
            clearTimeout(pageApplyTimer);
        }

        pageApplyTimer = setTimeout(runPageApply, delayMs);
    }

    function startPageAutoApply(windowMs = PAGE_APPLY_WINDOW_MS) {
        if (!isPlaybackRoute()) {
            clearPageAutoApply();
            return;
        }

        extendPageApplyWindow(windowMs);
        ensurePageObserver();
        schedulePageApply(0);
    }

    function extendPageApplyWindow(windowMs = PAGE_APPLY_WINDOW_MS) {
        const now = performance.now();
        if (!pageApplyDeadline || now > pageApplyDeadline) pageApplyStartedAt = now;
        pageApplyDeadline = Math.max(pageApplyDeadline, now + windowMs);
    }

    function scheduleNextPageApply(result) {
        if (result.status === "already") return;
        if (performance.now() >= pageApplyDeadline) return;

        if (result.status === "selected") {
            schedulePageApply(PAGE_VERIFY_DELAY_MS);
            return;
        }

        const elapsed = performance.now() - pageApplyStartedAt;
        schedulePageApply(elapsed < PAGE_FAST_RETRY_WINDOW_MS ? PAGE_FAST_RETRY_DELAY_MS : PAGE_SLOW_RETRY_DELAY_MS);
    }

    function runPageApply() {
        pageApplyTimer = 0;
        if (!isPlaybackRoute()) {
            clearPageAutoApply();
            return;
        }

        const result = applyQuality(preferredQuality);
        writeStatus(result);
        scheduleNextPageApply(result);
    }

    function onTrackListChanged() {
        startPageAutoApply(TRACK_RECOVERY_WINDOW_MS);
    }

    function mutationCouldAffectPlayer(mutation) {
        if (mutation.type !== "childList") return false;
        for (const node of mutation.addedNodes || []) {
            if (!(node instanceof Element)) continue;
            if (isVodRoute()) {
                if (node.matches("video")) return true;
                if (node.querySelector?.("video")) return true;
                continue;
            }
            if (node.matches(PLAYER_MUTATION_SELECTOR)) return true;
            if (node.querySelector?.(PLAYER_MUTATION_SELECTOR)) return true;
        }
        return false;
    }

    function ensurePageObserver() {
        if (pageObserver || !document.documentElement) return;

        pageObserver = new MutationObserver((mutations) => {
            if (!isPlaybackRoute()) {
                clearPageAutoApply();
                return;
            }
            if (mutations.some(mutationCouldAffectPlayer)) startPageAutoApply(TRACK_RECOVERY_WINDOW_MS);
        });

        pageObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });
    }

    function stopPageObserver() {
        if (!pageObserver) return;
        pageObserver.disconnect();
        pageObserver = null;
    }

    function readRequest() {
        const raw = document.documentElement.getAttribute(REQUEST_ATTR);
        if (!raw) return null;

        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    function writeResult(result) {
        document.documentElement.setAttribute(RESULT_ATTR, JSON.stringify(result));
    }

    function writeStatus(result) {
        try {
            document.documentElement.setAttribute(STATUS_ATTR, JSON.stringify({
                href: location.href,
                enabled: autoQualityEnabled,
                at: Date.now(),
                ...result,
            }));
        } catch (_) {
            // Diagnostics only.
        }
    }

    window.addEventListener(APPLY_EVENT, () => {
        const request = readRequest();
        if (!request?.requestId) return;
        preferredQuality = request.quality || DEFAULT_QUALITY;
        autoQualityEnabled = true;
        syncUrlStartSeekIntent();
        ensurePageObserver();

        try {
            const result = applyQuality(preferredQuality);
            writeStatus(result);
            writeResult({
                requestId: request.requestId,
                ...result,
            });
        } catch (error) {
            writeStatus({
                status: "error",
                reason: error?.message || String(error),
            });
            writeResult({
                requestId: request.requestId,
                status: "error",
                reason: error?.message || String(error),
            });
        }
    });
})();
