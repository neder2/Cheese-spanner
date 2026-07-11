/**
 * features/holdSpeed.js — 다시보기에서 Space를 누르는 동안 임시 2배속을 적용한다.
 *
 * 실행 컨텍스트: isolated world 콘텐츠 스크립트. content.js 이후, shortcutRescue.js 이전에 로드한다.
 * 동작 위치: /video/* 다시보기 전용.
 * 하는 일: capture 단계에서 Space를 먼저 소유해 짧은 탭은 keyup 시 재생 상태를 한 번만 토글하고,
 *   350ms 이상 홀드는 기존 재생 상태를 유지한 채 2배속을 적용한다. keyup, blur, 문서 숨김,
 *   옵션 비활성화, SPA 이탈, 비디오 교체 시 임시 상태를 정리한다.
 * 의존: BetterChzzkSettings, BetterChzzk.utils(getMainVideoElement, injectStyleOnce, isVodRoute,
 *   bindFeatureOptions, startPageChangeDetection).
 * 옵션 키: holdSpeedEnabled.
 */
(() => {
    "use strict";

    const root = (window.BetterChzzk = window.BetterChzzk || {});
    if (root.holdSpeed) return;

    const OVERLAY_ID = "betterchzzk-hold-speed-overlay";
    const STYLE_ID = "betterchzzk-hold-speed-style";
    const HOLD_THRESHOLD_MS = 350;
    const HOLD_RATE = 2;
    const RECENT_MEDIA_CHANGE_MS = 40;
    const NATIVE_SPACE_GUARD_MS = 140;
    const EXTERNAL_STATE_RESTORE_LIMIT = 5;
    const SPACE_CONSUMER_SELECTOR =
        "button, input, textarea, select, summary, a[href], [contenteditable]:not([contenteditable='false']), " +
        "[role='button'], [role='link'], [role='checkbox'], [role='menuitem'], [role='option'], " +
        "[role='radio'], [role='slider'], [role='switch'], [role='tab']";

    const { bindFeatureOptions, getMainVideoElement, injectStyleOnce, isVodRoute, startPageChangeDetection } =
        BetterChzzk.utils;

    let featureOptions = BetterChzzkSettings.normalizeOptions();
    let activePress = null;
    let lastVodRouteKey = getVodRouteKey();
    const mediaStateByVideo = new WeakMap();

    function isFeatureEnabled() {
        return featureOptions.holdSpeedEnabled === true;
    }

    function isSpaceKey(event) {
        return event.code === "Space" || event.key === " ";
    }

    function stopSpaceEvent(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    function isSpaceConsumerTarget(target) {
        return target instanceof Element && Boolean(target.closest(SPACE_CONSUMER_SELECTOR));
    }

    function getVodRouteKey() {
        const match = location.pathname.match(/^\/video\/[^/?#]+/);
        return match ? match[0] : "";
    }

    function rememberMediaState(video, paused = video?.paused) {
        if (!(video instanceof HTMLVideoElement)) return;

        const nextPaused = Boolean(paused);
        const current = mediaStateByVideo.get(video);
        if (!current) {
            mediaStateByVideo.set(video, {
                paused: nextPaused,
                previousPaused: nextPaused,
                changedAt: Number.NEGATIVE_INFINITY,
            });
            return;
        }
        if (current.paused === nextPaused) return;

        mediaStateByVideo.set(video, {
            paused: nextPaused,
            previousPaused: current.paused,
            changedAt: performance.now(),
        });
    }

    function onObservedMediaState(event) {
        const video = event.target;
        if (!(video instanceof HTMLVideoElement)) return;
        rememberMediaState(video);
        if (activePress?.video === video) syncPressPausedState(activePress);
    }

    function sampleMainMediaState() {
        if (!isFeatureEnabled() || !isVodRoute()) return;
        const video = getMainVideoElement();
        if (video instanceof HTMLVideoElement) rememberMediaState(video);
    }

    function isRecentMediaChange(observed, event) {
        const elapsed = performance.now() - observed.changedAt;
        if (elapsed < 0 || elapsed > RECENT_MEDIA_CHANGE_MS) return false;

        const eventTime = Number(event?.timeStamp);
        const comparableTimeOrigin = Number.isFinite(eventTime) && Math.abs(performance.now() - eventTime) < 60000;
        if (!comparableTimeOrigin) return true;
        return observed.changedAt + 1 >= eventTime;
    }

    function getPausedAtPressStart(video, event) {
        const observed = mediaStateByVideo.get(video);
        if (!observed) return video.paused;
        if (isRecentMediaChange(observed, event)) return observed.previousPaused;
        if (observed.paused !== video.paused) return observed.paused;
        return observed.paused;
    }

    function applyPausedState(video, paused, press = null) {
        if (!(video instanceof HTMLVideoElement) || video.paused === paused) return;
        if (press) press.restoringPaused = true;

        if (paused) {
            video.pause();
        } else {
            try {
                video.play()?.catch?.(() => {});
            } catch (_) {
                // Autoplay rejection must not leave the hold state stuck.
            }
        }

        if (!press) return;
        window.setTimeout(() => {
            if (activePress === press) press.restoringPaused = false;
        }, 0);
    }

    function ensureOverlay() {
        injectStyleOnce(
            STYLE_ID,
            `
#${OVERLAY_ID}{
  position:fixed;
  z-index:2147483647;
  transform:translateX(-50%);
  padding:8px 13px;
  border-radius:8px;
  background:rgba(17,19,24,.86);
  color:#fff;
  font:700 15px/20px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  pointer-events:none;
  box-shadow:0 6px 20px rgba(0,0,0,.24);
}
`
        );

        let overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = OVERLAY_ID;
            overlay.setAttribute("role", "status");
            overlay.setAttribute("aria-live", "polite");
            overlay.textContent = "2배속";
        }
        if (!overlay.isConnected) {
            (document.fullscreenElement || document.body || document.documentElement).appendChild(overlay);
        }
        return overlay;
    }

    function showOverlay(video) {
        const overlay = ensureOverlay();
        const rect = video?.getBoundingClientRect?.();
        if (rect && rect.width > 0 && rect.height > 0) {
            overlay.style.left = `${rect.left + rect.width / 2}px`;
            overlay.style.top = `${rect.top + Math.max(24, rect.height * 0.14)}px`;
            return;
        }
        overlay.style.left = "50%";
        overlay.style.top = "16%";
    }

    function hideOverlay() {
        document.getElementById(OVERLAY_ID)?.remove();
    }

    function clearPressTimer(press) {
        if (!press?.timerId) return;
        window.clearTimeout(press.timerId);
        press.timerId = 0;
    }

    function detachPressListeners(press) {
        if (!press) return;
        press.detachVideoListeners?.();
        press.detachDomObserver?.();
        press.detachVideoListeners = null;
        press.detachDomObserver = null;
    }

    function attachPressListeners(press) {
        const video = press?.video;
        if (!(video instanceof HTMLVideoElement)) return;

        const onStateChange = () => syncPressPausedState(press);
        video.addEventListener("pause", onStateChange);
        video.addEventListener("play", onStateChange);
        video.addEventListener("playing", onStateChange);
        press.detachVideoListeners = () => {
            video.removeEventListener("pause", onStateChange);
            video.removeEventListener("play", onStateChange);
            video.removeEventListener("playing", onStateChange);
        };

        const observer = new MutationObserver(() => {
            window.setTimeout(() => {
                if (activePress !== press || press.mode === "cancelled") return;
                if (!video.isConnected || getMainVideoElement() !== video) cancelActivePress();
            }, 0);
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        press.detachDomObserver = () => observer.disconnect();
    }

    function restoreHold(press) {
        if (!press || press.mode !== "hold") return;
        const video = press.video;
        if (video instanceof HTMLVideoElement && video.playbackRate === press.appliedRate) {
            try {
                video.playbackRate = press.originalRate;
            } catch (_) {
                // A detached media element can reject state restoration.
            }
        }
        hideOverlay();
    }

    function cancelActivePress({ keepCancelled = true } = {}) {
        const press = activePress;
        if (!press) {
            hideOverlay();
            return;
        }

        clearPressTimer(press);
        restoreHold(press);
        detachPressListeners(press);
        hideOverlay();

        if (keepCancelled) {
            // Keep swallowing repeats and the matching keyup after a lost-focus or route cancellation.
            press.mode = "cancelled";
            return;
        }
        activePress = null;
    }

    function syncPressPausedState(press) {
        if (
            !press ||
            activePress !== press ||
            press.mode !== "pending" ||
            press.restoringPaused ||
            performance.now() - press.startedAt > NATIVE_SPACE_GUARD_MS
        ) {
            return;
        }
        const video = press.video;
        if (!(video instanceof HTMLVideoElement) || video.paused === press.pausedAtStart) return;

        press.externalRestoreCount += 1;
        if (press.externalRestoreCount > EXTERNAL_STATE_RESTORE_LIMIT) {
            cancelActivePress();
            return;
        }
        applyPausedState(video, press.pausedAtStart, press);
    }

    function activateHold(press = activePress) {
        if (!press || activePress !== press || press.mode !== "pending") return;
        const video = press.video;
        if (!(video instanceof HTMLVideoElement) || !video.isConnected || getMainVideoElement() !== video) {
            cancelActivePress();
            return;
        }

        clearPressTimer(press);
        press.originalRate = video.playbackRate;
        press.appliedRate = HOLD_RATE;
        try {
            video.playbackRate = HOLD_RATE;
            press.mode = "hold";
            showOverlay(video);
        } catch (_) {
            cancelActivePress({ keepCancelled: false });
        }
    }

    function getStartBlockReason(event) {
        if (!isFeatureEnabled()) return "disabled";
        if (!isVodRoute()) return "not-vod";
        if (event.isComposing) return "composing";
        if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return "modifier";
        if (isSpaceConsumerTarget(event.target)) return "space-consumer";
        return "";
    }

    function onKeyDown(event) {
        if (!isSpaceKey(event)) return;

        if (activePress) {
            if (activePress.mode === "cancelled" && !event.repeat) {
                activePress = null;
            } else {
                stopSpaceEvent(event);
                if (event.repeat) activateHold(activePress);
                return;
            }
        }

        if (event.repeat || getStartBlockReason(event)) return;
        const video = getMainVideoElement();
        if (!(video instanceof HTMLVideoElement)) return;

        stopSpaceEvent(event);
        const press = {
            video,
            mode: "pending",
            pausedAtStart: getPausedAtPressStart(video, event),
            originalRate: null,
            appliedRate: null,
            externalRestoreCount: 0,
            restoringPaused: false,
            startedAt: performance.now(),
            detachVideoListeners: null,
            detachDomObserver: null,
            timerId: 0,
        };
        activePress = press;
        press.timerId = window.setTimeout(() => activateHold(press), HOLD_THRESHOLD_MS);
        attachPressListeners(press);
        syncPressPausedState(press);
    }

    function onKeyUp(event) {
        if (!isSpaceKey(event) || !activePress) return;
        stopSpaceEvent(event);

        const press = activePress;
        activePress = null;
        clearPressTimer(press);
        detachPressListeners(press);

        if (press.mode === "hold") {
            restoreHold(press);
            return;
        }
        hideOverlay();
        if (press.mode === "pending") applyPausedState(press.video, !press.pausedAtStart);
    }

    function onVisibilityChange() {
        if (document.visibilityState === "hidden") cancelActivePress();
    }

    function handlePageChange() {
        const nextRouteKey = getVodRouteKey();
        if (nextRouteKey === lastVodRouteKey) return;
        lastVodRouteKey = nextRouteKey;
        cancelActivePress();
        sampleMainMediaState();
    }

    function applyOptions(options) {
        featureOptions = options;
        if (isFeatureEnabled()) {
            sampleMainMediaState();
            return;
        }
        cancelActivePress();
    }

    // This listener must be registered before shortcutRescue.js so it owns VOD Space exclusively.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", cancelActivePress);
    document.addEventListener("visibilitychange", onVisibilityChange, true);
    document.addEventListener("pause", onObservedMediaState, true);
    document.addEventListener("play", onObservedMediaState, true);
    document.addEventListener("playing", onObservedMediaState, true);
    document.addEventListener("loadedmetadata", onObservedMediaState, true);
    startPageChangeDetection(handlePageChange);
    bindFeatureOptions(applyOptions);

    root.holdSpeed = Object.freeze({});
})();
