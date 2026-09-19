/**
 * features/holdSpeed.js — Space·좌클릭 홀드 임시 2배속과 재생 배속 단축키를 처리한다.
 *
 * 실행 컨텍스트: isolated world 콘텐츠 스크립트. content.js와 skipControl.js 이후에 로드한다.
 * 동작 위치: 홀드와 배속 조절 단축키 모두 /live/*와 /video/*.
 * 하는 일: capture 단계에서 Space를 먼저 소유해 짧은 탭은 keyup 시 재생 상태를 한 번만 토글하고,
 *   영상 화면 좌클릭도 같은 옵션으로 350ms 이상 홀드하면 재생 상태를 유지한 채 2배속을 적용한다.
 *   짧은 클릭은 네이티브에 맡기고, 드래그는 홀드를 취소한다. 별도 사용자 지정 키로
 *   0.25~4배속을 0.25씩 조절하거나 1배속으로 복원하며, 입력 해제, blur, 문서 숨김, 옵션 비활성화, SPA 이탈, 비디오 교체 시 임시
 *   홀드 상태와 안내 오버레이를 정리한다.
 * 의존: BetterChzzkSettings, BetterChzzk.skipControl(markPlaybackToggleIntent),
 *   BetterChzzk.utils(getMainVideoElement, getPlayerRoot, getVideoViewportRect, injectStyleOnce, isLiveRoute, isPlaybackRoute,
 *   bindFeatureOptions, startPageChangeDetection).
 * 옵션 키: holdSpeedEnabled, playbackSpeedShortcutsEnabled, playbackSpeedHalfKeyCode,
 *   playbackSpeedDoubleKeyCode, playbackSpeedResetKeyCode. 기존 Half/Double 저장 키는 감소/증가용으로 유지한다.
 */
(() => {
    "use strict";

    const root = (window.BetterChzzk = window.BetterChzzk || {});
    if (root.holdSpeed) return;

    const OVERLAY_ID = "betterchzzk-hold-speed-overlay";
    const STYLE_ID = "betterchzzk-hold-speed-style";
    const HOLD_THRESHOLD_MS = 350;
    const HOLD_RATE = 2;
    const POINTER_DRAG_DISTANCE = 4;
    const SHORTCUT_OVERLAY_MS = 900;
    const RECENT_MEDIA_CHANGE_MS = 40;
    const NATIVE_SPACE_GUARD_MS = 140;
    const EXTERNAL_STATE_RESTORE_LIMIT = 5;
    const SPACE_CONSUMER_SELECTOR =
        "button, input, textarea, select, summary, a[href], [contenteditable]:not([contenteditable='false']), " +
        "[role='button'], [role='link'], [role='checkbox'], [role='menuitem'], [role='option'], " +
        "[role='radio'], [role='slider'], [role='switch'], [role='tab'], [role='textbox'], " +
        "[role='combobox'], [role='searchbox'], [role='spinbutton'], [role='treeitem']";

    const {
        bindFeatureOptions,
        getMainVideoElement,
        getPlayerRoot,
        getVideoViewportRect,
        injectStyleOnce,
        isLiveRoute,
        isPlaybackRoute,
        startPageChangeDetection,
    } = BetterChzzk.utils;

    let featureOptions = BetterChzzkSettings.normalizeOptions();
    let activePress = null;
    let suppressedSpacePress = false;
    let suppressedPointerClick = null;
    let lastPlaybackRouteKey = getPlaybackRouteKey();
    let overlayHideTimer = 0;
    let overlayOwner = "";
    let overlayVideo = null;
    let overlayVideoObserver = null;
    const mediaStateByVideo = new WeakMap();

    function isFeatureEnabled() {
        return featureOptions.holdSpeedEnabled === true;
    }

    function areSpeedShortcutsEnabled() {
        return featureOptions.playbackSpeedShortcutsEnabled === true;
    }

    function isSpaceKey(event) {
        return event.code === "Space" || event.key === " ";
    }

    function stopKeyboardEvent(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    function isSpaceConsumerTarget(target) {
        return target instanceof Element && Boolean(target.closest(SPACE_CONSUMER_SELECTOR));
    }

    function getPlaybackRouteKey() {
        const match = location.pathname.match(/^\/(?:live|video)\/[^/?#]+/);
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
        if (!isFeatureEnabled() || !isPlaybackRoute()) return;
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
        }
        if (!overlay.isConnected) {
            (document.fullscreenElement || document.body || document.documentElement).appendChild(overlay);
        }
        return overlay;
    }

    function clearOverlayTimer() {
        if (!overlayHideTimer) return;
        window.clearTimeout(overlayHideTimer);
        overlayHideTimer = 0;
    }

    function clearOverlayVideoObserver() {
        overlayVideoObserver?.disconnect();
        overlayVideoObserver = null;
        overlayVideo = null;
    }

    function observeOverlayVideo(video, owner) {
        clearOverlayVideoObserver();
        if (!(video instanceof HTMLVideoElement)) return;

        overlayVideo = video;
        overlayVideoObserver = new MutationObserver(() => {
            window.setTimeout(() => {
                if (overlayOwner !== owner || overlayVideo !== video) return;
                if (!video.isConnected || getMainVideoElement() !== video) hideOverlay(owner);
            }, 0);
        });
        overlayVideoObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    function showOverlay(video, label = "2배속", owner = "hold", hideAfterMs = 0) {
        clearOverlayTimer();
        overlayOwner = owner;
        const overlay = ensureOverlay();
        overlay.textContent = label;
        if (hideAfterMs > 0) observeOverlayVideo(video, owner);
        else clearOverlayVideoObserver();
        const rect = video ? getVideoViewportRect(video) : null;
        if (rect && rect.width > 0 && rect.height > 0) {
            overlay.style.left = `${rect.left + rect.width / 2}px`;
            overlay.style.top = `${rect.top + Math.max(24, rect.height * 0.14)}px`;
        } else {
            overlay.style.left = "50%";
            overlay.style.top = "16%";
        }

        if (hideAfterMs > 0) {
            overlayHideTimer = window.setTimeout(() => {
                overlayHideTimer = 0;
                if (overlayOwner !== owner) return;
                document.getElementById(OVERLAY_ID)?.remove();
                overlayOwner = "";
                clearOverlayVideoObserver();
            }, hideAfterMs);
        }
    }

    function hideOverlay(owner = "") {
        if (owner && overlayOwner !== owner) return;
        clearOverlayTimer();
        clearOverlayVideoObserver();
        document.getElementById(OVERLAY_ID)?.remove();
        overlayOwner = "";
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
        press.detachPointerListeners?.();
        press.detachVideoListeners = null;
        press.detachDomObserver = null;
        press.detachPointerListeners = null;
    }

    function attachPressListeners(press) {
        const video = press?.video;
        if (!(video instanceof HTMLVideoElement)) return;

        const onStateChange = () => syncPressPausedState(press);
        const onSourceChange = () => {
            if (activePress === press) cancelActivePress();
        };
        video.addEventListener("pause", onStateChange);
        video.addEventListener("play", onStateChange);
        video.addEventListener("playing", onStateChange);
        video.addEventListener("emptied", onSourceChange);
        video.addEventListener("loadstart", onSourceChange);
        press.detachVideoListeners = () => {
            video.removeEventListener("pause", onStateChange);
            video.removeEventListener("play", onStateChange);
            video.removeEventListener("playing", onStateChange);
            video.removeEventListener("emptied", onSourceChange);
            video.removeEventListener("loadstart", onSourceChange);
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
        hideOverlay("hold");
    }

    function cancelActivePress({ keepCancelled = true } = {}) {
        const press = activePress;
        if (!press) {
            hideOverlay();
            return;
        }

        clearPressTimer(press);
        if (press.input === "pointer" && press.mode === "hold") {
            suppressedPointerClick = { video: press.video, player: press.player, pointerId: press.pointerId };
        }
        restoreHold(press);
        detachPressListeners(press);
        hideOverlay();

        if (keepCancelled && press.input === "keyboard") {
            // Keep swallowing repeats and the matching keyup after a lost-focus or route cancellation.
            press.mode = "cancelled";
            return;
        }
        activePress = null;
    }

    function syncPressPausedState(press) {
        if (
            !press ||
            press.input !== "keyboard" ||
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
            showOverlay(video, "2배속", "hold");
        } catch (_) {
            cancelActivePress({ keepCancelled: false });
        }
    }

    function getStartBlockReason(event) {
        if (!isFeatureEnabled()) return "disabled";
        if (!isPlaybackRoute()) return "not-playback";
        if (event.isComposing) return "composing";
        if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return "modifier";
        if (isSpaceConsumerTarget(event.target)) return "space-consumer";
        return "";
    }

    function onSpaceKeyDown(event) {
        if (!event.repeat) suppressedSpacePress = false;
        if (suppressedSpacePress || (activePress?.input === "pointer" && !getStartBlockReason(event))) {
            suppressedSpacePress = true;
            stopKeyboardEvent(event);
            return;
        }
        if (activePress?.input === "pointer") return;
        if (activePress) {
            if (activePress.mode === "cancelled" && !event.repeat) {
                activePress = null;
            } else {
                stopKeyboardEvent(event);
                if (event.repeat) activateHold(activePress);
                return;
            }
        }

        if (event.repeat || getStartBlockReason(event)) return;
        const video = getMainVideoElement();
        if (!(video instanceof HTMLVideoElement)) return;

        stopKeyboardEvent(event);
        startPress(video, event, "keyboard");
    }

    function startPress(video, event, input) {
        hideOverlay("shortcut");
        const press = {
            video,
            input,
            mode: "pending",
            pausedAtStart: input === "keyboard" ? getPausedAtPressStart(video, event) : video.paused,
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
        return press;
    }

    function onPointerDown(event) {
        suppressedPointerClick = null;
        if (
            event.defaultPrevented ||
            event.pointerType !== "mouse" ||
            event.button !== 0 ||
            event.buttons !== 1 ||
            event.isPrimary === false ||
            getStartBlockReason(event)
        )
            return;
        if (activePress && activePress.mode !== "cancelled") return;

        const video = getMainVideoElement();
        if (!(video instanceof HTMLVideoElement) || !video.isConnected) return;
        const player = getPlayerRoot(video);
        const target = event.composedPath()[0] || event.target;
        // Only the main video or a wrapper containing it can begin a hold; controls and overlays yield.
        if (
            !(target instanceof Element) ||
            !player?.contains(target) ||
            (target !== video && !target.contains(video)) ||
            target.closest("[role='menu'], [role='dialog'], [role='separator'], [draggable='true']")
        )
            return;
        const rect = getVideoViewportRect(video);
        if (
            rect.width <= 0 ||
            rect.height <= 0 ||
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
        )
            return;

        if (activePress?.input === "keyboard") suppressedSpacePress = true;
        const press = startPress(video, event, "pointer");
        press.player = player;
        press.pointerId = event.pointerId;
        press.startX = event.clientX;
        press.startY = event.clientY;
        // Observe without capturing the pointer or stopping propagation, so native clicks and panning remain available.
        window.addEventListener("pointermove", onPointerMove, true);
        window.addEventListener("pointerup", onPointerEnd, true);
        window.addEventListener("pointercancel", onPointerEnd, true);
        window.addEventListener("lostpointercapture", onPointerEnd, true);
        window.addEventListener("dragstart", onPointerDragStart, true);
        press.detachPointerListeners = () => {
            window.removeEventListener("pointermove", onPointerMove, true);
            window.removeEventListener("pointerup", onPointerEnd, true);
            window.removeEventListener("pointercancel", onPointerEnd, true);
            window.removeEventListener("lostpointercapture", onPointerEnd, true);
            window.removeEventListener("dragstart", onPointerDragStart, true);
        };
    }

    function onPointerMove(event) {
        const press = activePress;
        if (press?.input !== "pointer" || event.pointerId !== press.pointerId) return;
        if (
            !(event.buttons & 1) ||
            Math.hypot(event.clientX - press.startX, event.clientY - press.startY) >= POINTER_DRAG_DISTANCE
        )
            cancelActivePress();
    }

    function onPointerEnd(event) {
        if (activePress?.input !== "pointer" || event.pointerId !== activePress.pointerId) return;
        cancelActivePress();
    }

    function onPointerDragStart() {
        if (activePress?.input === "pointer") cancelActivePress();
    }

    function onPointerClick(event) {
        const suppressed = suppressedPointerClick;
        if (!suppressed || event.button !== 0 || event.detail === 0) return;
        if (!suppressed.video.isConnected || !suppressed.player.contains(suppressed.video)) {
            suppressedPointerClick = null;
            return;
        }
        const target = event.composedPath()[0] || event.target;
        if (
            !(target instanceof Element) ||
            !suppressed.player.contains(target) ||
            (target !== suppressed.video && !target.contains(suppressed.video)) ||
            (event.pointerId != null && event.pointerId !== suppressed.pointerId)
        )
            return;
        event.preventDefault();
        event.stopImmediatePropagation();
        // A second held click can also produce dblclick immediately after click.
        if (event.type === "dblclick" || event.detail < 2) suppressedPointerClick = null;
    }

    function getSpeedShortcutAction(event) {
        if (!areSpeedShortcutsEnabled() || !isPlaybackRoute()) return null;
        if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
        if (isSpaceConsumerTarget(event.target)) return null;

        if (event.code === featureOptions.playbackSpeedHalfKeyCode) return "decrease";
        if (event.code === featureOptions.playbackSpeedDoubleKeyCode) return "increase";
        if (event.code === featureOptions.playbackSpeedResetKeyCode) return "reset";
        return null;
    }

    function applySpeedShortcut(event, action) {
        const video = getMainVideoElement();
        if (!(video instanceof HTMLVideoElement) || !video.isConnected) return;

        stopKeyboardEvent(event);
        if (event.repeat && action === "reset") return;
        if (activePress) cancelActivePress();
        const nextRate =
            action === "reset"
                ? 1
                : Math.min(
                      4,
                      Math.max(0.25, (Math.round(video.playbackRate * 4) + (action === "decrease" ? -1 : 1)) / 4)
                  );
        if (event.repeat && nextRate === video.playbackRate) return;

        try {
            video.playbackRate = nextRate;
            showOverlay(video, `${nextRate}배속`, "shortcut", SHORTCUT_OVERLAY_MS);
        } catch (_) {
            hideOverlay("shortcut");
        }
    }

    function onKeyDown(event) {
        if (isSpaceKey(event)) {
            onSpaceKeyDown(event);
            return;
        }

        const action = getSpeedShortcutAction(event);
        if (action !== null) applySpeedShortcut(event, action);
    }

    function onKeyUp(event) {
        if (!isSpaceKey(event)) return;
        if (suppressedSpacePress) {
            suppressedSpacePress = false;
            stopKeyboardEvent(event);
            return;
        }
        if (activePress?.input !== "keyboard") return;
        stopKeyboardEvent(event);

        const press = activePress;
        activePress = null;
        clearPressTimer(press);
        detachPressListeners(press);

        if (press.mode === "hold") {
            restoreHold(press);
            return;
        }
        if (press.mode === "pending") {
            hideOverlay("hold");
            const nextPaused = !press.pausedAtStart;
            if (nextPaused && isLiveRoute()) root.skipControl?.markPlaybackToggleIntent?.();
            applyPausedState(press.video, nextPaused);
        }
    }

    function onVisibilityChange() {
        if (document.visibilityState === "hidden") cancelActivePress();
    }

    function handlePageChange() {
        const nextRouteKey = getPlaybackRouteKey();
        if (nextRouteKey === lastPlaybackRouteKey) return;
        lastPlaybackRouteKey = nextRouteKey;
        cancelActivePress();
        sampleMainMediaState();
    }

    function applyOptions(options) {
        featureOptions = options;
        if (isFeatureEnabled()) {
            sampleMainMediaState();
        } else if (activePress) {
            cancelActivePress();
        }
        if (!areSpeedShortcutsEnabled()) hideOverlay("shortcut");
    }

    // Capture Space while enabled to distinguish a short press from a speed hold.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("click", onPointerClick, true);
    window.addEventListener("dblclick", onPointerClick, true);
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
