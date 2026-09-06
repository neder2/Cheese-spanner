/**
 * features/skipControl.js — 재생/라이브 화면에 스킵 컨트롤(초 단위 이동 pill, 키보드 스킵, 라이브 빨리감기
 * 버튼, 라이브 일시정지 재개 가드)을 주입하고 유지하는 기능 모듈.
 *
 * 동작 위치: 재생 라우트(VOD/라이브) 하단 컨트롤 바 부근 DOM. isolated world, content.js 이후 로드.
 * 하는 일:
 *   - #betterchzzk-skip-pill(초 단위 스킵 값 표시/조절 pill)과 #betterchzzk-live-fast-forward(라이브 빨리감기
 *     버튼)를 좌측 버튼 컨테이너 또는 시간 표시 요소 옆에 주입·재배치한다.
 *   - ArrowLeft/ArrowRight로 skipSeconds만큼, comma/period로 1/60초(60fps 기준) 프레임 단위 seek를 처리한다.
 *   - 라이브 일시정지 중 버퍼가 밀려도 사용자가 멈춘 지점을 기억했다가 재생 재개 시 그 지점으로 복원하고,
 *     라이브 엣지에서 벗어난(타임시프트) 상태를 감지해 사용자 seek 제스처가 아니면 원위치로 되돌린다.
 *   - MutationObserver와 페이지 전환 감지로 라우트가 바뀔 때마다 pill/버튼/가드를 재부착한다.
 * 의존: 전역 BetterChzzkSettings(DEFAULT_SKIP_SECONDS, getStorageLastError, normalizeSkipSeconds,
 *   normalizeOptions), 전역 BetterChzzk.utils(bindFeatureOptions, createMutationObserverSync,
 *   createThrottledDomSync, isLiveRoute, isPlaybackRoute, isVisible, isExtensionPreviewVideo,
 *   mutationMatchesSelector, normalizeCompact, onReady, pickLargestVisible, startPageChangeDetection,
 *   injectStyleOnce), chrome.storage.sync.
 * 옵션 키: skipControlEnabled, skipKeyboardEnabled, skipPillEnabled, skipLivePillEnabled,
 *   skipLivePauseResumeEnabled, skipSeconds, skipWheelStep, skipWheelShiftStep, skipWheelAltStep.
 * 공개 API: BetterChzzk.skipControl.markPlaybackToggleIntent()는 다른 재생 키 소유자가 확정한 라이브
 *   일시정지 의도를 재개 가드에 전달한다.
 * DOM 마커: id="betterchzzk-skip-pill", id="betterchzzk-live-fast-forward",
 *   id="betterchzzk-skip-style"(주입 스타일), data-bctm-text-patched(라이브 엣지 버튼 패치 표시),
 *   data-bc-placement(pill 배치 모드), data-better-chzzk-live-fast-forward.
 * 구조:
 *   - 상수/상태 선언, isSkipEnabled/isPillEnabled 등 기능 on/off 판정 함수.
 *   - 라이브 엣지·재생 토글·시크 제스처 버튼을 텍스트/신호로 식별하는 looksLike*, containsAnyTerm 계열.
 *   - getSeekableRange/getBufferedRange/getLiveEdge/getSeekBounds: video 시간 범위 계산 유틸.
 *   - 라이브 일시정지 재개 가드: rememberPausedPosition, startResumeRestore, onVideoPause/Play/Seeked 등
 *     이벤트 핸들러와 pauseSnapshot 상태 관리.
 *   - 라이브 타임시프트 가드: syncLiveTimeShiftGuard, rememberLiveTimeShiftPosition,
 *     restoreLiveTimeShiftPosition로 사용자가 되감기한 지점을 유지.
 *   - injectSkipStyleOnce: pill/버튼 CSS 문자열 주입.
 *   - pill/라이브 빨리감기 버튼 DOM 생성·배치·가시성 동기화 함수군(find*, mount*, sync*).
 *   - onKeyDownSeek: 키보드 스킵/프레임 스텝 처리.
 *   - installRuntime/teardownRuntime/applyOptions: 옵션 변경과 라우트 변경에 따른 전체 생명주기 관리.
 */
(() => {
    const root = (window.BetterChzzk = window.BetterChzzk || {});
    const SKIP_PILL_ID = "betterchzzk-skip-pill";
    const LIVE_FAST_FORWARD_BUTTON_ID = "betterchzzk-live-fast-forward";
    const SKIP_STYLE_ID = "betterchzzk-skip-style";
    const VOD_TIME_SELECTOR = "div.pzp-vod-time, div.pzp-pc__vod-time, div.pzp-pc-vod-time";
    const LIVE_TIME_SELECTOR = "div.pzp-live-time, div.pzp-pc__live-time, div.pzp-pc-live-time";
    const TIME_SELECTOR = `${VOD_TIME_SELECTOR}, ${LIVE_TIME_SELECTOR}`;
    const LIVE_LEFT_BUTTONS_SELECTOR = [
        "div.pzp-pc__bottom-buttons--left",
        "div.pzp-pc-bottom-buttons--left",
        "div[class*='pzp'][class*='bottom-buttons'][class*='left']",
    ].join(", ");
    const LIVE_PLAYBACK_SWITCH_SELECTOR = [
        ".pzp-pc__playback-switch",
        ".pzp-pc-playback-switch",
        "[class*='pzp'][class*='playback-switch']",
    ].join(", ");
    const BUTTON_SELECTOR = "button, [role='button']";
    const LIVE_EDGE_PATCHED_ATTR = "data-bctm-text-patched";
    const LIVE_EDGE_BUTTON_TERMS = ["\uC2E4\uC2DC\uAC04", "\uB77C\uC774\uBE0C", "live"];
    const LIVE_FAST_FORWARD_LABEL = "\uBE68\uB9AC \uAC10\uAE30";
    const LIVE_FAST_FORWARD_BUTTON_TERMS = [LIVE_FAST_FORWARD_LABEL, "fast forward", "fast-forward", "fastforward"];
    const EXTERNAL_FAST_FORWARD_SIGNATURE_TERMS = ["knifeff", "fastforward", "livefastforward"];
    const PLAYBACK_TOGGLE_BUTTON_TERMS = ["play", "pause", "playback", "\uC7AC\uC0DD", "\uC77C\uC2DC\uC815\uC9C0"];
    const RELEVANT_DOM_SELECTOR = `video, ${TIME_SELECTOR}, ${LIVE_LEFT_BUTTONS_SELECTOR}, ${LIVE_PLAYBACK_SWITCH_SELECTOR}, [${LIVE_EDGE_PATCHED_ATTR}], #${SKIP_PILL_ID}, #${LIVE_FAST_FORWARD_BUTTON_ID}`;
    const SKIP_VISIBILITY_RESYNC_DELAY_MS = 240;
    const CONTROL_AREA_BEFORE_VIDEO_BOTTOM = 150;
    const CONTROL_AREA_AFTER_VIDEO_BOTTOM = 110;
    const CONTROL_AREA_MAX_HEIGHT = 96;
    const LIVE_EDGE_INTENT_GRACE_MS = 1200;
    const PAUSED_CONTROL_INTENT_GRACE_MS = 1200;
    const LIVE_RESUME_RESTORE_WINDOW_MS = 8000;
    const LIVE_RESUME_RESTORE_RETRY_MS = 180;
    const LIVE_RESUME_RESTORE_MAX_ATTEMPTS = 45;
    const LIVE_RESUME_ALLOWED_DRIFT_SECONDS = 1.5;
    const LIVE_PAUSE_CACHE_SYNC_INTERVAL_MS = 1000;
    const LIVE_TIMESHIFT_ARM_LAG_SECONDS = 4;
    const LIVE_TIMESHIFT_SNAP_AHEAD_SECONDS = 2;
    const LIVE_TIMESHIFT_NEAR_EDGE_SECONDS = 2;
    const LIVE_TIMESHIFT_RESTORE_COOLDOWN_MS = 120;
    const LIVE_TIMESHIFT_SYNC_INTERVAL_MS = 500;
    const LIVE_TIMESHIFT_USER_SEEK_GRACE_MS = LIVE_EDGE_INTENT_GRACE_MS;
    const LIVE_TIMESHIFT_USER_SEEK_DRAG_MAX_MS = LIVE_RESUME_RESTORE_WINDOW_MS;
    const SEEK_GESTURE_SIGNATURE_TERMS = ["progress", "seek", "scrub", "timeline", "timebar", "playbackbar"];
    const NON_SEEK_GESTURE_SIGNATURE_TERMS = ["volume", "mute", "sound", "audio", "\uC74C\uB7C9", "\uC74C\uC18C\uAC70"];
    // 치지직 플레이어는 프레임레이트를 노출하지 않으므로 주류인 1080p60 기준(60fps)으로 이동한다.
    const FRAME_STEP_SECONDS = 1 / 60;
    const OWNED_LIVE_CONTROL_IDS = new Set([SKIP_PILL_ID, LIVE_FAST_FORWARD_BUTTON_ID]);
    const { DEFAULT_SKIP_SECONDS, getStorageLastError, normalizeSkipSeconds, normalizeOptions } = BetterChzzkSettings;
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        createThrottledDomSync,
        isLiveRoute,
        isPlaybackRoute,
        isVisible,
        isExtensionPreviewVideo,
        mutationMatchesSelector,
        normalizeCompact,
        onReady,
        pickLargestVisible,
        startPageChangeDetection,
    } = BetterChzzk.utils;

    let featureOptions = normalizeOptions();
    let skipSeconds = featureOptions.skipSeconds;
    let persistTimer = null;
    let skipSyncRafId = null;
    let delayedSkipSyncTimer = null;
    let skipPillEl = null;
    let skipValueEl = null;
    let skipPillAnchorEl = null;
    let liveFastForwardButtonEl = null;
    const liveFastForwardButtonsWithClickHandler = new WeakSet();
    let lastUrl = location.href;
    let pageChangeTimer = null;
    let attachedVideo = null;
    let pauseSnapshot = null;
    let pauseCacheSyncTimer = null;
    let resumeRestoreState = null;
    let resumeRestoreTimer = null;
    let liveTimeShiftState = null;
    let liveTimeShiftSyncTimer = null;
    let liveTimeShiftRestoring = false;
    let liveVideoGeneration = 0;
    let lastLiveEdgeIntentAt = Number.NEGATIVE_INFINITY;
    let lastUserSeekGestureAt = Number.NEGATIVE_INFINITY;
    let lastUserPauseIntentAt = Number.NEGATIVE_INFINITY;
    let userSeekGestureDragging = false;
    let lastPausedControlIntentAt = Number.NEGATIVE_INFINITY;
    let domObserver = null;
    let domObserverMode = "";
    let removePageChangeDetection = null;
    let startupSyncTimer = 0;
    let runtimeInstalled = false;
    let skipPillHandlersInstalled = false;
    let keyboardHandlerInstalled = false;
    let liveResumeHandlersInstalled = false;
    const scheduleDomSync = createThrottledDomSync(() => {
        ensureLiveResumeGuardAttached();
        ensureLiveFastForwardButtonInjected();
        ensureSkipPillInjected();
        scheduleSkipPillSync({ delayed: true });
    });

    function isSkipEnabled() {
        return featureOptions.skipControlEnabled;
    }

    function isKeyboardEnabled() {
        return isSkipEnabled() && isPlaybackRoute() && featureOptions.skipKeyboardEnabled;
    }

    function isPillEnabled() {
        if (!isSkipEnabled() || !isPlaybackRoute() || !featureOptions.skipPillEnabled) return false;
        return !isLiveRoute() || featureOptions.skipLivePillEnabled;
    }

    function isLiveResumeGuardEnabled() {
        return isSkipEnabled() && featureOptions.skipLivePauseResumeEnabled;
    }

    function isLiveFastForwardButtonEnabled() {
        return isSkipEnabled() && isLiveRoute();
    }

    function compact(value) {
        if (typeof normalizeCompact === "function") return normalizeCompact(value);
        return String(value || "")
            .toLowerCase()
            .replace(/\s+/g, "");
    }

    function containsAnyTerm(value, terms) {
        const text = compact(value);
        return terms.some((term) => text.includes(compact(term)));
    }

    function setAttributeIfChanged(el, name, value) {
        if (!(el instanceof Element)) return;
        const next = String(value);
        if (el.getAttribute(name) !== next) el.setAttribute(name, next);
    }

    function setElementTitleIfChanged(el, value) {
        if (!(el instanceof HTMLElement)) return;
        const next = String(value);
        if (el.title !== next) el.title = next;
    }

    function setClassNameIfChanged(el, value) {
        if (!(el instanceof HTMLElement)) return;
        const next = String(value || "");
        if (el.className !== next) el.className = next;
    }

    function classNameWithToken(className, token) {
        const tokens = String(className || "")
            .trim()
            .split(/\s+/)
            .filter(Boolean);
        if (!tokens.includes(token)) tokens.push(token);
        return tokens.join(" ");
    }

    function getCandidateText(el) {
        return [
            el?.getAttribute?.("label"),
            el?.getAttribute?.("aria-label"),
            el?.getAttribute?.("tooltip"),
            el?.getAttribute?.("title"),
            el?.textContent,
        ].join(" ");
    }

    function isOwnedLiveControl(el) {
        return (
            el instanceof HTMLElement &&
            (OWNED_LIVE_CONTROL_IDS.has(el.id) || el.dataset?.betterChzzkLiveFastForward === "1")
        );
    }

    function getElementSignature(el) {
        return [
            el?.id,
            el?.className,
            el?.getAttribute?.("data-testid"),
            el?.getAttribute?.("data-test-id"),
            el?.getAttribute?.("data-name"),
        ].join(" ");
    }

    function getWheelStep(event) {
        if (event.altKey) return featureOptions.skipWheelAltStep;
        if (event.shiftKey) return featureOptions.skipWheelShiftStep;
        return featureOptions.skipWheelStep;
    }

    function persistSkipSecondsDebounced() {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
            persistTimer = null;
            chrome.storage.sync.set({ skipSeconds }, () => {
                getStorageLastError?.();
            });
        }, 250);
    }

    function isEditableTarget(target) {
        if (!target) return false;
        if (target.isContentEditable) return true;
        if (typeof target.closest === "function") {
            return !!target.closest("input, textarea, select, [contenteditable='true'], [role='separator']");
        }
        return false;
    }

    function getMainVideoElement() {
        const videos = Array.from(document.querySelectorAll("video")).filter(
            (video) => !isExtensionPreviewVideo?.(video)
        );
        return pickLargestVisible(videos) || videos[0] || null;
    }

    function getVisibleArea(el) {
        if (!(el instanceof HTMLElement) || !el.isConnected) return 0;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return 0;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return 0;
        return rect.width * rect.height;
    }

    function getEffectiveControlState(el) {
        let node = el;
        let opacity = 1;
        let depth = 0;

        while (node instanceof HTMLElement && depth < 10) {
            const style = getComputedStyle(node);
            if (
                node.hidden ||
                node.getAttribute("aria-hidden") === "true" ||
                style.display === "none" ||
                style.visibility === "hidden" ||
                style.visibility === "collapse"
            ) {
                return { opacity: "0", visibility: "hidden", pointerEvents: "none" };
            }

            const nodeOpacity = Number(style.opacity);
            if (Number.isFinite(nodeOpacity)) opacity *= nodeOpacity;

            if (node === document.body || node === document.documentElement) break;
            node = node.parentElement;
            depth += 1;
        }

        if (opacity <= 0.05) {
            return { opacity: "0", visibility: "", pointerEvents: "none" };
        }

        return { opacity: "", visibility: "", pointerEvents: "" };
    }

    function syncStandalonePillVisibility(pill, anchorEl) {
        if (!(pill instanceof HTMLElement) || !(anchorEl instanceof HTMLElement)) return;
        const state = getEffectiveControlState(anchorEl);
        pill.style.opacity = state.opacity;
        pill.style.visibility = state.visibility;
        pill.style.pointerEvents = state.pointerEvents;
    }

    function syncLiveInlineControlVisibility(control, reference) {
        if (!(control instanceof HTMLElement) || !(reference instanceof HTMLElement)) return;
        const state = getEffectiveControlState(reference);
        control.style.opacity = state.opacity;
        control.style.visibility = state.visibility;
        control.style.pointerEvents = state.pointerEvents;
    }

    function getSeekableRange(video) {
        if (!(video instanceof HTMLVideoElement) || !video.seekable?.length) return null;
        try {
            const lastIndex = video.seekable.length - 1;
            const start = video.seekable.start(lastIndex);
            const end = video.seekable.end(lastIndex);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
            return { start, end };
        } catch {
            return null;
        }
    }

    function getBufferedRange(video) {
        if (!(video instanceof HTMLVideoElement) || !video.buffered?.length) return null;
        try {
            const lastIndex = video.buffered.length - 1;
            const start = video.buffered.start(lastIndex);
            const end = video.buffered.end(lastIndex);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
            return { start, end };
        } catch {
            return null;
        }
    }

    function getLiveEdge(video) {
        const bufferedRange = getBufferedRange(video);
        const seekableRange = getSeekableRange(video);
        const bufferedEnd = bufferedRange?.end;
        const seekableEnd = seekableRange?.end;

        if (Number.isFinite(bufferedEnd) && Number.isFinite(seekableEnd)) return Math.max(bufferedEnd, seekableEnd);
        if (Number.isFinite(bufferedEnd)) return bufferedEnd;
        if (Number.isFinite(seekableEnd)) return seekableEnd;

        return NaN;
    }

    function getSeekBounds(video) {
        const seekableRange = getSeekableRange(video);
        if (seekableRange && (isLiveRoute() || !Number.isFinite(video.duration))) {
            return { min: seekableRange.start, max: seekableRange.end };
        }

        const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
        return { min: 0, max: duration };
    }

    function clampSeekTime(video, time) {
        const value = Number(time);
        if (!Number.isFinite(value)) return NaN;

        const bounds = getSeekBounds(video);
        return Math.min(Math.max(value, bounds.min), bounds.max);
    }

    function looksLikeLiveEdgeButton(button) {
        if (!(button instanceof HTMLElement)) return false;
        if (button.id === LIVE_FAST_FORWARD_BUTTON_ID) return true;
        if (looksLikeExternalLiveFastForwardButton(button)) return true;
        if (looksLikePlaybackToggleButton(button)) return false;
        return (
            button.hasAttribute(LIVE_EDGE_PATCHED_ATTR) ||
            containsAnyTerm(getCandidateText(button), LIVE_EDGE_BUTTON_TERMS)
        );
    }

    function looksLikeExternalLiveFastForwardButton(button) {
        if (!(button instanceof HTMLElement) || isOwnedLiveControl(button)) return false;
        if (containsAnyTerm(getCandidateText(button), LIVE_FAST_FORWARD_BUTTON_TERMS)) return true;

        const signature = compact(getElementSignature(button));
        return EXTERNAL_FAST_FORWARD_SIGNATURE_TERMS.some((term) => signature.includes(term));
    }

    function looksLikePlaybackToggleButton(button) {
        if (!(button instanceof HTMLElement)) return false;
        if (button.matches?.(LIVE_PLAYBACK_SWITCH_SELECTOR)) return true;

        const signature = compact(
            [
                getElementSignature(button),
                getCandidateText(button),
                button.getAttribute("role"),
                button.getAttribute("type"),
            ].join(" ")
        );
        return PLAYBACK_TOGGLE_BUTTON_TERMS.some((term) => signature.includes(compact(term)));
    }

    function isLikelyPlaybackToggleIntentTarget(target, button) {
        if (!canUseLiveResumeGuard(attachedVideo) || attachedVideo.paused) return false;
        if (target === attachedVideo) return true;
        if (!(button instanceof HTMLElement)) return false;
        if (button.id === SKIP_PILL_ID || looksLikeLiveEdgeButton(button)) return false;
        return looksLikePlaybackToggleButton(button) || isInLikelyVideoControlArea(button, attachedVideo);
    }

    function clearLiveTimeShiftState(video = null) {
        if (!video || liveTimeShiftState?.video === video) liveTimeShiftState = null;
    }

    function startLiveTimeShiftSync(video = attachedVideo) {
        if (!(video instanceof HTMLVideoElement) || liveTimeShiftSyncTimer) return;
        liveTimeShiftSyncTimer = setInterval(() => {
            if (attachedVideo) syncLiveTimeShiftGuard(attachedVideo);
        }, LIVE_TIMESHIFT_SYNC_INTERVAL_MS);
    }

    function stopLiveTimeShiftSync() {
        if (!liveTimeShiftSyncTimer) return;
        clearInterval(liveTimeShiftSyncTimer);
        liveTimeShiftSyncTimer = null;
    }

    function markLiveEdgeIntent() {
        lastLiveEdgeIntentAt = performance.now();
        clearLiveTimeShiftState();
        cancelResumeRestore({ clearSnapshot: true });
    }

    function isInLikelyVideoControlArea(el, video) {
        if (!(el instanceof HTMLElement) || !(video instanceof HTMLVideoElement)) return false;
        if (!isVisible?.(video)) return false;

        const elRect = el.getBoundingClientRect();
        const videoRect = video.getBoundingClientRect();
        if (elRect.width <= 0 || elRect.height <= 0) return false;

        const centerX = elRect.left + elRect.width / 2;
        const centerY = elRect.top + elRect.height / 2;
        const horizontallyInsideVideo = centerX >= videoRect.left - 36 && centerX <= videoRect.right + 36;
        const nearVideoBottom =
            centerY >= videoRect.bottom - CONTROL_AREA_BEFORE_VIDEO_BOTTOM &&
            centerY <= videoRect.bottom + CONTROL_AREA_AFTER_VIDEO_BOTTOM;

        return horizontallyInsideVideo && nearVideoBottom && elRect.height <= CONTROL_AREA_MAX_HEIGHT;
    }

    function isPointerEventInVideoArea(event, video) {
        if (!(video instanceof HTMLVideoElement) || !isVisible?.(video)) return false;
        const clientX = Number(event?.clientX);
        const clientY = Number(event?.clientY);
        if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;

        const videoRect = video.getBoundingClientRect();
        return (
            clientX >= videoRect.left &&
            clientX <= videoRect.right &&
            clientY >= videoRect.top &&
            clientY <= videoRect.bottom
        );
    }

    function findPillAnchorElement() {
        if (isLiveRoute()) return findLivePillAnchorElement();
        return findVodPillAnchorElement() || findVodTimeElement() || findTimeElement();
    }

    function isRecentLiveEdgeIntent() {
        return performance.now() - lastLiveEdgeIntentAt <= LIVE_EDGE_INTENT_GRACE_MS;
    }

    function markUserSeekGesture() {
        lastUserSeekGestureAt = performance.now();
    }

    function clearUserSeekGestureIntent() {
        userSeekGestureDragging = false;
        lastUserSeekGestureAt = Number.NEGATIVE_INFINITY;
    }

    function isRecentUserSeekGesture() {
        const now = performance.now();
        if (userSeekGestureDragging) {
            if (now - lastUserSeekGestureAt <= LIVE_TIMESHIFT_USER_SEEK_DRAG_MAX_MS) return true;
            userSeekGestureDragging = false;
        }

        return now - lastUserSeekGestureAt <= LIVE_TIMESHIFT_USER_SEEK_GRACE_MS;
    }

    function markUserPauseIntent() {
        lastUserPauseIntentAt = performance.now();
    }

    function markPlaybackToggleIntent() {
        if (!isLiveResumeGuardEnabled() || !isLiveRoute()) return;
        ensureLiveResumeGuardAttached();
        if (canUseLiveResumeGuard(attachedVideo)) markUserPauseIntent();
    }

    function isRecentUserPauseIntent() {
        return performance.now() - lastUserPauseIntentAt <= PAUSED_CONTROL_INTENT_GRACE_MS;
    }

    function isRecentPausedControlIntent() {
        return performance.now() - lastPausedControlIntentAt <= PAUSED_CONTROL_INTENT_GRACE_MS;
    }

    function getLiveRouteKey() {
        return isLiveRoute() ? location.pathname : "";
    }

    function getCurrentVideoGeneration(video = attachedVideo) {
        return video instanceof HTMLVideoElement && video === attachedVideo ? liveVideoGeneration : 0;
    }

    function isLiveTimeShiftStateForVideo(video) {
        return Boolean(
            liveTimeShiftState?.video === video &&
            liveTimeShiftState.routeKey === getLiveRouteKey() &&
            liveTimeShiftState.videoGeneration === getCurrentVideoGeneration(video)
        );
    }

    function isPauseSnapshotForCurrentRoute(video = attachedVideo) {
        return Boolean(
            pauseSnapshot?.routeKey &&
            pauseSnapshot.routeKey === getLiveRouteKey() &&
            pauseSnapshot.video === video &&
            pauseSnapshot.videoGeneration === getCurrentVideoGeneration(video) &&
            pauseSnapshot.armedByUser
        );
    }

    function canUseLiveResumeGuard(video) {
        return (
            isLiveResumeGuardEnabled() &&
            isLiveRoute() &&
            video instanceof HTMLVideoElement &&
            video.isConnected &&
            Boolean(getSeekableRange(video))
        );
    }

    function getExpectedLiveTimeShiftTime(state) {
        const elapsedSeconds = Math.max(0, (performance.now() - state.updatedAt) / 1000);
        const rate = Number(state.video?.playbackRate);
        const playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
        return state.video?.paused ? state.time : state.time + elapsedSeconds * playbackRate;
    }

    function rememberLiveTimeShiftPosition(video, edge, lag) {
        const currentTime = Number(video?.currentTime);
        if (!Number.isFinite(currentTime) || !Number.isFinite(edge) || lag < LIVE_TIMESHIFT_ARM_LAG_SECONDS) {
            if (Number.isFinite(lag) && lag <= LIVE_TIMESHIFT_NEAR_EDGE_SECONDS) clearLiveTimeShiftState(video);
            return;
        }

        const routeKey = getLiveRouteKey();
        const previous =
            liveTimeShiftState?.routeKey === routeKey && liveTimeShiftState?.video === video
                ? liveTimeShiftState
                : null;
        liveTimeShiftState = {
            video,
            routeKey,
            videoGeneration: getCurrentVideoGeneration(video),
            armedByUser: true,
            time: currentTime,
            edge,
            lag,
            storedAt: previous?.storedAt || performance.now(),
            updatedAt: performance.now(),
            restores: previous?.restores || 0,
            lastRestoreAt: previous?.lastRestoreAt ?? Number.NEGATIVE_INFINITY,
        };
    }

    function canCreateLiveTimeShiftState(video, { allowCurrent, recentUserSeekGesture }) {
        if (isLiveTimeShiftStateForVideo(video)) return true;
        return Boolean(allowCurrent || recentUserSeekGesture);
    }

    function restoreLiveTimeShiftPosition(video, state, expectedTime, edge) {
        const bounds = getSeekBounds(video);
        if (!Number.isFinite(expectedTime) || expectedTime < bounds.min) {
            clearLiveTimeShiftState(video);
            return false;
        }

        const target = Math.min(Math.max(expectedTime, bounds.min), bounds.max);
        if (!Number.isFinite(target) || edge - target <= LIVE_TIMESHIFT_NEAR_EDGE_SECONDS) {
            clearLiveTimeShiftState(video);
            return false;
        }

        const now = performance.now();
        if (now - (state.lastRestoreAt || 0) < LIVE_TIMESHIFT_RESTORE_COOLDOWN_MS) return false;

        try {
            liveTimeShiftRestoring = true;
            video.currentTime = target;
        } catch {
            clearLiveTimeShiftState(video);
            return false;
        } finally {
            setTimeout(() => {
                liveTimeShiftRestoring = false;
            }, 0);
        }

        liveTimeShiftState = {
            ...state,
            time: target,
            edge,
            lag: Math.max(0, edge - target),
            updatedAt: now,
            restores: (state.restores || 0) + 1,
            lastRestoreAt: now,
        };
        return true;
    }

    function syncLiveTimeShiftGuard(video, { allowCurrent = false } = {}) {
        if (!canUseLiveResumeGuard(video) || isRecentLiveEdgeIntent()) {
            clearLiveTimeShiftState(video);
            return;
        }

        const currentTime = Number(video.currentTime);
        const edge = getLiveEdge(video);
        if (!Number.isFinite(currentTime) || !Number.isFinite(edge)) {
            clearLiveTimeShiftState(video);
            return;
        }

        const lag = edge - currentTime;
        const state = liveTimeShiftState;
        const recentUserSeekGesture = isRecentUserSeekGesture();
        const shouldProtectPosition =
            state?.video === video &&
            state.routeKey === getLiveRouteKey() &&
            state.videoGeneration === getCurrentVideoGeneration(video) &&
            !allowCurrent &&
            !recentUserSeekGesture;

        if (shouldProtectPosition) {
            const expectedTime = getExpectedLiveTimeShiftTime(state);
            const jumpedAhead = currentTime > expectedTime + LIVE_TIMESHIFT_SNAP_AHEAD_SECONDS;
            const collapsedLag =
                lag <= LIVE_TIMESHIFT_NEAR_EDGE_SECONDS || lag < state.lag - LIVE_TIMESHIFT_SNAP_AHEAD_SECONDS;
            if (jumpedAhead && collapsedLag) {
                if (!liveTimeShiftRestoring) restoreLiveTimeShiftPosition(video, state, expectedTime, edge);
                return;
            }
        }

        if ((allowCurrent || recentUserSeekGesture) && lag < LIVE_TIMESHIFT_ARM_LAG_SECONDS) {
            clearLiveTimeShiftState(video);
            return;
        }

        if (!canCreateLiveTimeShiftState(video, { allowCurrent, recentUserSeekGesture })) return;

        rememberLiveTimeShiftPosition(video, edge, lag);
    }

    function rememberPausedPosition(video, { preserveCachedTime = false, allowUserIntent = false } = {}) {
        if (!canUseLiveResumeGuard(video) || isRecentLiveEdgeIntent()) {
            if (pauseSnapshot?.video === video) pauseSnapshot = null;
            return;
        }

        const seekableRange = getSeekableRange(video);
        if (!seekableRange) return;

        const routeKey = getLiveRouteKey();
        const hasCurrentSnapshot = isPauseSnapshotForCurrentRoute(video);
        const existingTime = preserveCachedTime && hasCurrentSnapshot ? pauseSnapshot.time : video.currentTime;
        const time = Number(existingTime);
        if (!Number.isFinite(time)) return;

        const edge = getLiveEdge(video);
        const lag = Number.isFinite(edge) ? edge - time : seekableRange.end - time;
        if (!Number.isFinite(lag)) {
            if (pauseSnapshot?.video === video) pauseSnapshot = null;
            return;
        }

        const userArmed =
            allowUserIntent || isRecentUserPauseIntent() || isLiveTimeShiftStateForVideo(video) || hasCurrentSnapshot;
        if (!userArmed) {
            if (pauseSnapshot?.video === video) pauseSnapshot = null;
            return;
        }

        const now = performance.now();
        pauseSnapshot = {
            video,
            routeKey,
            videoGeneration: getCurrentVideoGeneration(video),
            armedByUser: true,
            time,
            seekableStart: seekableRange.start,
            seekableEnd: seekableRange.end,
            storedAt: hasCurrentSnapshot ? pauseSnapshot.storedAt : now,
            refreshedAt: now,
        };
    }

    function refreshPauseCacheSnapshot(video = attachedVideo) {
        if (!(video instanceof HTMLVideoElement) || !video.paused || !isLiveResumeGuardEnabled() || !isLiveRoute()) {
            stopPauseCacheSync();
            return;
        }

        if (!canUseLiveResumeGuard(video) || isRecentLiveEdgeIntent()) return;

        if (isPauseSnapshotForCurrentRoute(video)) rememberPausedPosition(video, { preserveCachedTime: true });
    }

    function startPauseCacheSync(video = attachedVideo) {
        if (!(video instanceof HTMLVideoElement) || pauseCacheSyncTimer) return;
        pauseCacheSyncTimer = setInterval(() => {
            refreshPauseCacheSnapshot(attachedVideo);
        }, LIVE_PAUSE_CACHE_SYNC_INTERVAL_MS);
    }

    function stopPauseCacheSync() {
        if (!pauseCacheSyncTimer) return;
        clearInterval(pauseCacheSyncTimer);
        pauseCacheSyncTimer = null;
    }

    function cancelResumeRestore({ clearSnapshot = false } = {}) {
        if (resumeRestoreTimer) {
            clearTimeout(resumeRestoreTimer);
            resumeRestoreTimer = null;
        }
        resumeRestoreState = null;
        if (clearSnapshot) pauseSnapshot = null;
    }

    function getResumeExpectedTime(state) {
        const elapsedSeconds = Math.max(0, (performance.now() - state.startedAt) / 1000);
        return clampSeekTime(state.video, state.target + elapsedSeconds);
    }

    function runResumeRestoreAttempt() {
        const state = resumeRestoreState;
        if (!state) return;

        resumeRestoreTimer = null;
        if (
            state.video !== attachedVideo ||
            state.videoGeneration !== getCurrentVideoGeneration(state.video) ||
            !canUseLiveResumeGuard(state.video) ||
            isRecentLiveEdgeIntent() ||
            performance.now() > state.untilAt
        ) {
            cancelResumeRestore({ clearSnapshot: true });
            return;
        }

        const expectedTime = getResumeExpectedTime(state);
        const currentTime = state.video.currentTime;
        if (Number.isFinite(expectedTime) && Number.isFinite(currentTime)) {
            const jumpedAhead = currentTime > expectedTime + LIVE_RESUME_ALLOWED_DRIFT_SECONDS;
            if (jumpedAhead) {
                try {
                    state.video.currentTime = expectedTime;
                } catch {
                    cancelResumeRestore({ clearSnapshot: true });
                    return;
                }
            }
        }

        state.attempts += 1;
        if (state.attempts >= LIVE_RESUME_RESTORE_MAX_ATTEMPTS) {
            cancelResumeRestore({ clearSnapshot: true });
            return;
        }

        resumeRestoreTimer = setTimeout(runResumeRestoreAttempt, LIVE_RESUME_RESTORE_RETRY_MS);
    }

    function startResumeRestore(video) {
        if (!isPauseSnapshotForCurrentRoute(video)) return;
        if (!canUseLiveResumeGuard(video) || isRecentLiveEdgeIntent()) {
            cancelResumeRestore({ clearSnapshot: true });
            return;
        }

        const rawTarget = Number(pauseSnapshot.time);
        if (!Number.isFinite(rawTarget)) return;

        const target = clampSeekTime(video, rawTarget);
        if (!Number.isFinite(target)) return;
        pauseSnapshot.video = video;
        pauseSnapshot.time = target;

        resumeRestoreState = {
            video,
            videoGeneration: getCurrentVideoGeneration(video),
            target,
            startedAt: performance.now(),
            untilAt: performance.now() + LIVE_RESUME_RESTORE_WINDOW_MS,
            attempts: 0,
        };

        runResumeRestoreAttempt();
    }

    function onVideoPause(event) {
        const video = event.currentTarget;
        cancelResumeRestore();
        rememberPausedPosition(video, {
            allowUserIntent: isRecentUserPauseIntent() || isLiveTimeShiftStateForVideo(video),
        });
        if (isPauseSnapshotForCurrentRoute(video)) startPauseCacheSync(video);
    }

    function onVideoPlay(event) {
        stopPauseCacheSync();
        startResumeRestore(event.currentTarget);
    }

    function onVideoProgress(event) {
        refreshPauseCacheSnapshot(event.currentTarget);
    }

    function onVideoTimeShiftChange(event) {
        syncLiveTimeShiftGuard(event.currentTarget);
    }

    function onVideoSeeked(event) {
        const video = event.currentTarget;
        syncLiveTimeShiftGuard(video);
        if (
            !video?.paused ||
            resumeRestoreState?.video === video ||
            isRecentLiveEdgeIntent() ||
            isRecentPausedControlIntent()
        ) {
            return;
        }
        rememberPausedPosition(video, {
            allowUserIntent: isRecentUserSeekGesture() || isLiveTimeShiftStateForVideo(video),
        });
        if (isPauseSnapshotForCurrentRoute(video)) startPauseCacheSync(video);
    }

    function detachLiveResumeGuard({ clearSnapshot = true } = {}) {
        clearUserSeekGestureIntent();
        if (!attachedVideo) {
            stopPauseCacheSync();
            stopLiveTimeShiftSync();
            cancelResumeRestore({ clearSnapshot });
            return;
        }
        attachedVideo.removeEventListener("pause", onVideoPause, true);
        attachedVideo.removeEventListener("play", onVideoPlay, true);
        attachedVideo.removeEventListener("playing", onVideoPlay, true);
        attachedVideo.removeEventListener("seeking", onVideoTimeShiftChange, true);
        attachedVideo.removeEventListener("seeked", onVideoSeeked, true);
        attachedVideo.removeEventListener("timeupdate", onVideoTimeShiftChange, true);
        attachedVideo.removeEventListener("progress", onVideoProgress, true);
        attachedVideo.removeEventListener("durationchange", onVideoProgress, true);
        attachedVideo.removeEventListener("loadedmetadata", onVideoProgress, true);
        clearLiveTimeShiftState(attachedVideo);
        attachedVideo = null;
        stopPauseCacheSync();
        stopLiveTimeShiftSync();
        cancelResumeRestore({ clearSnapshot });
    }

    function attachLiveResumeGuard(video) {
        if (attachedVideo === video) {
            if (video instanceof HTMLVideoElement && video.paused && isPauseSnapshotForCurrentRoute(video)) {
                refreshPauseCacheSnapshot(video);
                startPauseCacheSync(video);
            }
            return;
        }
        detachLiveResumeGuard({ clearSnapshot: true });
        if (!(video instanceof HTMLVideoElement)) return;

        attachedVideo = video;
        liveVideoGeneration += 1;
        attachedVideo.addEventListener("pause", onVideoPause, true);
        attachedVideo.addEventListener("play", onVideoPlay, true);
        attachedVideo.addEventListener("playing", onVideoPlay, true);
        attachedVideo.addEventListener("seeking", onVideoTimeShiftChange, true);
        attachedVideo.addEventListener("seeked", onVideoSeeked, true);
        attachedVideo.addEventListener("timeupdate", onVideoTimeShiftChange, true);
        attachedVideo.addEventListener("progress", onVideoProgress, true);
        attachedVideo.addEventListener("durationchange", onVideoProgress, true);
        attachedVideo.addEventListener("loadedmetadata", onVideoProgress, true);
        startLiveTimeShiftSync(video);

        if (video.paused && isPauseSnapshotForCurrentRoute(video)) {
            refreshPauseCacheSnapshot(video);
            startPauseCacheSync(video);
        } else if (isPauseSnapshotForCurrentRoute(video)) {
            startResumeRestore(video);
        }
    }

    function ensureLiveResumeGuardAttached() {
        if (!isLiveResumeGuardEnabled() || !isLiveRoute()) {
            detachLiveResumeGuard();
            return;
        }
        attachLiveResumeGuard(getMainVideoElement());
    }

    function seekVideoBy(video, deltaSeconds) {
        const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        const bounds = getSeekBounds(video);
        const next = Math.min(Math.max(current + deltaSeconds, bounds.min), bounds.max);
        video.currentTime = next;
        syncLiveTimeShiftGuard(video, { allowCurrent: true });
        if (video.paused) rememberPausedPosition(video, { allowUserIntent: true });
    }

    function isFrameStepKey(event) {
        if (event.shiftKey) return false;
        return event.key === "," || event.key === "." || event.code === "Comma" || event.code === "Period";
    }

    function onKeyDownSeek(event) {
        if (!isKeyboardEnabled()) return;
        if (event.ctrlKey || event.altKey || event.metaKey) return;
        if (isEditableTarget(event.target)) return;

        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            const video = getMainVideoElement();
            if (!video) return;

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            const step = normalizeSkipSeconds(skipSeconds);
            seekVideoBy(video, event.key === "ArrowRight" ? step : -step);
            return;
        }

        if (isFrameStepKey(event)) {
            const video = getMainVideoElement();
            if (!video || !video.paused) return;

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            const forward = event.key === "." || event.code === "Period";
            seekVideoBy(video, forward ? FRAME_STEP_SECONDS : -FRAME_STEP_SECONDS);
        }
    }

    function injectSkipStyleOnce() {
        BetterChzzk.utils.injectStyleOnce(
            SKIP_STYLE_ID,
            `
#${SKIP_PILL_ID}{
  display:inline-flex;
  align-items:center;
  gap:1px;
  margin-left:14px;
  height:24px;
  min-width:0;
  padding:0 7px;
  border-radius:9999px;
  border:1px solid transparent;
  background-color:transparent !important;
  appearance:none;
  -webkit-appearance:none;
  color:rgba(255,255,255,0.9);
  font-family:inherit;
  font-size:14px;
  font-weight:700;
  line-height:20px;
  letter-spacing:0;
  font-variant-numeric:tabular-nums;
  white-space:nowrap;
  cursor:pointer;
  user-select:none;
  pointer-events:auto;
  flex:0 0 auto;
  align-self:center;
  transition:opacity 120ms ease, background-color 120ms ease, border-color 120ms ease;
  position:relative;
  z-index:2;
  box-sizing:border-box;
}
#${SKIP_PILL_ID}[data-bc-placement="live-inline"],
#${SKIP_PILL_ID}[data-bc-placement="vod-inline"]{
  margin-left:0;
  margin-right:0;
  order:9999;
  width:auto;
}
#${SKIP_PILL_ID}:hover{
  background-color:rgba(255,255,255,0.14) !important;
  border-color:rgba(255,255,255,0.22);
  opacity:1;
}
#${SKIP_PILL_ID}:active{
  opacity:0.78;
  background-color:rgba(255,255,255,0.18) !important;
}
#${SKIP_PILL_ID}:focus-visible{
  outline:none;
  box-shadow: 0 0 0 2px rgba(255,255,255,0.22);
}
#${SKIP_PILL_ID} .bc-value,
#${SKIP_PILL_ID} .bc-unit{
  display:inline-flex;
  align-items:center;
  height:100%;
  line-height:20px;
}
#${SKIP_PILL_ID} .bc-unit{
  opacity:1;
  font-weight:700;
  margin-left:0;
}
#${SKIP_PILL_ID} .bc-value{
  min-width:0;
  text-align:left;
}
#${LIVE_FAST_FORWARD_BUTTON_ID}{
  position:relative;
  overflow:visible;
}
#${LIVE_FAST_FORWARD_BUTTON_ID}:focus-visible{
  outline:none;
}
#${LIVE_FAST_FORWARD_BUTTON_ID}:disabled{
  opacity:0.35;
  cursor:default;
  pointer-events:none;
}
#${LIVE_FAST_FORWARD_BUTTON_ID} .bc-live-ff-icon{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  width:24px;
  height:24px;
  flex:0 0 auto;
  color:currentColor;
}
#${LIVE_FAST_FORWARD_BUTTON_ID} .bc-live-ff-icon svg{
  display:block;
  width:24px;
  height:24px;
  fill:currentColor;
}
`
        );
    }

    function findTimeElement() {
        return pickLargestVisible(document.querySelectorAll(TIME_SELECTOR));
    }

    function findVodTimeElement() {
        return pickLargestVisible(document.querySelectorAll(VOD_TIME_SELECTOR));
    }

    function findLeftButtonsContainer() {
        const video = getMainVideoElement();
        const candidates = [];
        for (const el of document.querySelectorAll(LIVE_LEFT_BUTTONS_SELECTOR)) {
            if (!(el instanceof HTMLElement) || getVisibleArea(el) <= 0) continue;
            if (video instanceof HTMLVideoElement && !isInLikelyVideoControlArea(el, video)) continue;

            const rect = el.getBoundingClientRect();
            candidates.push({ el, width: rect.width, left: rect.left });
        }

        if (!candidates.length) return null;
        candidates.sort((a, b) => a.left - b.left || a.width - b.width);
        return candidates[0].el;
    }

    function findLivePillAnchorElement() {
        return findLeftButtonsContainer();
    }

    function findVodPillAnchorElement() {
        return findLeftButtonsContainer();
    }

    function getLiveFastForwardButtonElement() {
        if (liveFastForwardButtonEl && liveFastForwardButtonEl.isConnected) return liveFastForwardButtonEl;
        liveFastForwardButtonEl = document.getElementById(LIVE_FAST_FORWARD_BUTTON_ID);
        return liveFastForwardButtonEl;
    }

    function getSkipPillElement() {
        if (skipPillEl && skipPillEl.isConnected) return skipPillEl;
        skipPillEl = document.getElementById(SKIP_PILL_ID);
        if (!skipPillEl) skipValueEl = null;
        return skipPillEl;
    }

    function showSkipPill(pill) {
        if (!pill) return;

        pill.style.display = "";
        if (["live-inline", "vod-inline"].includes(pill.getAttribute("data-bc-placement"))) {
            const reference = pill.parentElement?.matches?.(LIVE_LEFT_BUTTONS_SELECTOR)
                ? findLiveButtonBoxReference(pill.parentElement)
                : null;
            if (reference) syncLiveInlineControlVisibility(pill, reference);
            return;
        }

        const anchorEl = findAnchorElementForPill(pill);
        if (anchorEl) {
            syncStandalonePillVisibility(pill, anchorEl);
            return;
        }

        pill.style.pointerEvents = "";
        pill.style.opacity = "";
        pill.style.visibility = "";
    }

    function resetPillPlacementStyles(pill) {
        pill.removeAttribute("data-bc-placement");
        pill.style.left = "";
        pill.style.top = "";
        pill.style.right = "";
        pill.style.bottom = "";
        pill.style.transform = "";
        pill.style.transition = "";
        setClassNameIfChanged(pill, "");
    }

    function pickVisibleControls(elements) {
        const candidates = [];
        for (const el of elements) {
            if (!(el instanceof HTMLElement) || getVisibleArea(el) <= 0) continue;
            const rect = el.getBoundingClientRect();
            candidates.push({ el, width: rect.width, left: rect.left });
        }
        return candidates;
    }

    function pickFirstVisibleControl(elements) {
        const candidates = pickVisibleControls(elements);
        if (!candidates.length) return null;
        candidates.sort((a, b) => a.left - b.left || a.width - b.width);
        return candidates[0].el;
    }

    function findLiveButtonBoxReference(container) {
        if (!(container instanceof HTMLElement)) return null;

        const children = Array.from(container.children || []).filter((child) => {
            return child instanceof HTMLElement && !OWNED_LIVE_CONTROL_IDS.has(child.id);
        });
        const playbackReference = pickFirstVisibleControl(
            children.filter((child) => child.matches?.(LIVE_PLAYBACK_SWITCH_SELECTOR))
        );
        if (playbackReference) return playbackReference;

        const buttonReference = pickFirstVisibleControl(children.filter((child) => child.matches?.(BUTTON_SELECTOR)));
        if (buttonReference) return buttonReference;

        const fallbackReference = pickFirstVisibleControl(children);
        return fallbackReference || children[0] || null;
    }

    function syncLivePillButtonBoxClass(pill, container) {
        if (!(pill instanceof HTMLElement) || !(container instanceof HTMLElement)) return;

        const reference = findLiveButtonBoxReference(container);
        setClassNameIfChanged(pill, reference?.className || "");
        pill.style.order = "9999";
        pill.style.marginLeft = "8px";

        if (!reference) return;
        syncLiveInlineControlVisibility(pill, reference);
        pill.style.transition = reference.style.transition || "";
    }

    function mountLivePillInLeftButtons(pill, container) {
        if (!pill || !(container instanceof HTMLElement)) return false;

        syncLivePillButtonBoxClass(pill, container);
        if (pill.parentElement !== container) {
            if (pill.parentElement) pill.remove();
            container.appendChild(pill);
        } else if (pill.nextElementSibling) {
            container.appendChild(pill);
        }

        return true;
    }

    function findLiveFastForwardReference(container) {
        if (!(container instanceof HTMLElement)) return null;

        const playbackSwitches = Array.from(container.querySelectorAll(LIVE_PLAYBACK_SWITCH_SELECTOR)).filter((el) => {
            return el instanceof HTMLElement && el.id !== LIVE_FAST_FORWARD_BUTTON_ID && getVisibleArea(el) > 0;
        });
        if (playbackSwitches.length) {
            playbackSwitches.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
            return playbackSwitches[0];
        }

        const children = Array.from(container.children || []).filter((child) => {
            return child instanceof HTMLElement && !OWNED_LIVE_CONTROL_IDS.has(child.id);
        });
        const visibleChildren = children.filter((child) => getVisibleArea(child) > 0);
        return visibleChildren[0] || children[0] || null;
    }

    function findExternalLiveFastForwardButton(container) {
        if (!(container instanceof HTMLElement)) return null;

        const candidates = Array.from(container.querySelectorAll(BUTTON_SELECTOR)).filter(
            (button) =>
                button instanceof HTMLElement &&
                getVisibleArea(button) > 0 &&
                looksLikeExternalLiveFastForwardButton(button)
        );

        if (!candidates.length) return null;
        candidates.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        return candidates[0];
    }

    function syncLiveFastForwardButtonClass(button, container) {
        if (!(button instanceof HTMLElement) || !(container instanceof HTMLElement)) return;

        const reference = findLiveFastForwardReference(container);
        setClassNameIfChanged(button, classNameWithToken(reference?.className, "knife-ff"));
        button.style.order = "";
        button.style.marginLeft = "";

        if (!reference) return;
        syncLiveInlineControlVisibility(button, reference);
        button.style.transition = reference.style.transition || "";
    }

    function getLiveFastForwardTarget(video) {
        // 타임머신 채널에서는 buffered.end가 현재 위치 기준 forward 버퍼 끝(수십 초)일 뿐이라
        // 라이브 엣지에 한참 못 미친다. seekable.end까지 반영한 실제 라이브 엣지로 점프한다.
        return getLiveEdge(video);
    }

    function syncLiveFastForwardButtonLabels(button) {
        if (!(button instanceof HTMLElement)) return;
        setAttributeIfChanged(button, "label", LIVE_FAST_FORWARD_LABEL);
        setAttributeIfChanged(button, "aria-label", LIVE_FAST_FORWARD_LABEL);
        setAttributeIfChanged(button, "tooltip", LIVE_FAST_FORWARD_LABEL);
        BetterChzzk.utils.syncPlayerButtonTooltip(button, LIVE_FAST_FORWARD_LABEL);
        if (button.hasAttribute("title")) button.removeAttribute("title");
    }

    function syncLiveFastForwardButtonState(button = getLiveFastForwardButtonElement()) {
        if (!(button instanceof HTMLButtonElement)) return;
        const video = getMainVideoElement();
        const target = getLiveFastForwardTarget(video);
        const available = Number.isFinite(target);
        const disabled = !available;

        if (button.disabled !== disabled) button.disabled = disabled;
        syncLiveFastForwardButtonLabels(button);
        button.dataset.betterChzzkReady = available ? "1" : "0";
    }

    function seekLiveToBufferedEnd(video = getMainVideoElement()) {
        if (!(video instanceof HTMLVideoElement)) return false;

        const target = getLiveFastForwardTarget(video);
        if (!Number.isFinite(target)) return false;

        markLiveEdgeIntent();
        try {
            video.currentTime = target;
            return true;
        } catch {
            const fallbackTarget = target - 0.5;
            if (!Number.isFinite(fallbackTarget)) return false;
            try {
                video.currentTime = fallbackTarget;
                return true;
            } catch {
                return false;
            }
        }
    }

    function handleLiveFastForwardClick(event) {
        const button = getLiveFastForwardButtonElement();
        if (!button || !button.contains(event.target)) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const video = getMainVideoElement();
        if (seekLiveToBufferedEnd(video) && video?.paused) {
            video.play()?.catch?.(() => {});
        }
        syncLiveFastForwardButtonState(button);
    }

    function ensureLiveFastForwardButtonClickHandler(button) {
        if (!(button instanceof HTMLButtonElement) || liveFastForwardButtonsWithClickHandler.has(button)) return;
        button.addEventListener("click", handleLiveFastForwardClick, true);
        liveFastForwardButtonsWithClickHandler.add(button);
    }

    function createLiveFastForwardButton() {
        injectSkipStyleOnce();

        const button = document.createElement("button");
        button.id = LIVE_FAST_FORWARD_BUTTON_ID;
        button.type = "button";
        syncLiveFastForwardButtonLabels(button);
        button.dataset.betterChzzkLiveFastForward = "1";
        button.innerHTML = `
<ui-next-media-icon class="bc-live-ff-icon" aria-hidden="true">
  <svg viewBox="0 0 24 24" focusable="false">
    <path d="M6 18V6l8.5 6L6 18Zm10-12h2v12h-2V6Z"></path>
  </svg>
</ui-next-media-icon>
`;
        ensureLiveFastForwardButtonClickHandler(button);

        liveFastForwardButtonEl = button;
        return button;
    }

    function mountLiveFastForwardButton(button, container) {
        if (!(button instanceof HTMLElement) || !(container instanceof HTMLElement)) return false;

        syncLiveFastForwardButtonClass(button, container);

        const reference = findLiveFastForwardReference(container);
        if (reference?.parentElement === container) {
            if (button.parentElement !== container || button.previousElementSibling !== reference) {
                if (button.parentElement) button.remove();
                reference.insertAdjacentElement("afterend", button);
            }
            return true;
        }

        if (button.parentElement !== container) {
            if (button.parentElement) button.remove();
            container.appendChild(button);
        }
        return true;
    }

    function updateSkipPill() {
        const pill = getSkipPillElement();
        if (!pill) return;

        if (!skipValueEl || !skipValueEl.isConnected || !pill.contains(skipValueEl)) {
            skipValueEl = pill.querySelector(".bc-value");
        }

        if (skipValueEl) {
            const nextText = String(skipSeconds);
            if (skipValueEl.textContent !== nextText) skipValueEl.textContent = nextText;
        }

        setElementTitleIfChanged(
            pill,
            `Wheel: +/- ${featureOptions.skipWheelStep}s (Shift: ${featureOptions.skipWheelShiftStep}s, Alt: ${featureOptions.skipWheelAltStep}s)\nClick: reset to default`
        );
    }

    function setSkipSeconds(next, { persist = true } = {}) {
        const normalized = normalizeSkipSeconds(next);
        if (normalized === skipSeconds) return;

        skipSeconds = normalized;
        updateSkipPill();

        if (persist) persistSkipSecondsDebounced();
    }

    function createSkipPill() {
        injectSkipStyleOnce();

        const pill = document.createElement("button");
        pill.id = SKIP_PILL_ID;
        pill.type = "button";
        pill.setAttribute("aria-label", "Skip seconds control");

        pill.innerHTML = `
<span class="bc-value">${skipSeconds}</span><span class="bc-unit">s</span>
`;

        skipPillEl = pill;
        skipValueEl = pill.querySelector(".bc-value");
        return pill;
    }

    function handleSkipPillClick(event) {
        const pill = getSkipPillElement();
        if (!pill || !pill.contains(event.target)) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        setSkipSeconds(DEFAULT_SKIP_SECONDS);
    }

    function handleSkipPillWheel(event) {
        const pill = getSkipPillElement();
        if (!pill || !pill.contains(event.target)) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const direction = event.deltaY < 0 ? 1 : -1;
        const step = getWheelStep(event);
        setSkipSeconds(Math.max(1, skipSeconds + direction * step));
    }

    function installSkipPillGlobalHandlers() {
        if (skipPillHandlersInstalled) return;
        skipPillHandlersInstalled = true;
        window.addEventListener("click", handleSkipPillClick, true);
        window.addEventListener("wheel", handleSkipPillWheel, { capture: true, passive: false });
    }

    function uninstallSkipPillGlobalHandlers() {
        if (!skipPillHandlersInstalled) return;
        skipPillHandlersInstalled = false;
        window.removeEventListener("click", handleSkipPillClick, true);
        window.removeEventListener("wheel", handleSkipPillWheel, true);
    }

    function syncPillTypography(pill, anchorEl) {
        if (!pill || !anchorEl) return;
        const style = getComputedStyle(anchorEl);
        pill.style.fontFamily = style.fontFamily;
        pill.style.fontSize = style.fontSize;
    }

    function mountPillNearAnchor(pill, anchorEl) {
        if (!pill || !anchorEl?.parentElement) return false;
        syncPillTypography(pill, anchorEl);
        skipPillAnchorEl = anchorEl;

        resetPillPlacementStyles(pill);
        if (anchorEl.matches?.(LIVE_LEFT_BUTTONS_SELECTOR)) {
            pill.setAttribute("data-bc-placement", isLiveRoute() ? "live-inline" : "vod-inline");
            return mountLivePillInLeftButtons(pill, anchorEl);
        }

        if (isLiveRoute()) {
            return false;
        }

        if (pill.parentElement === anchorEl.parentElement && pill.previousElementSibling === anchorEl) return true;
        if (pill.parentElement) pill.remove();
        anchorEl.insertAdjacentElement("afterend", pill);
        return true;
    }

    function findAnchorElementForPill(pill) {
        if (skipPillAnchorEl?.isConnected && getVisibleArea(skipPillAnchorEl) > 0) return skipPillAnchorEl;
        if (pill?.parentElement?.matches?.(LIVE_LEFT_BUTTONS_SELECTOR)) return pill.parentElement;

        const previous = pill?.previousElementSibling;
        if (previous?.matches?.(TIME_SELECTOR)) return previous;
        if (looksLikeLiveEdgeButton(previous)) return previous;
        return findPillAnchorElement();
    }

    function syncExistingSkipPill() {
        const pill = getSkipPillElement();
        if (!pill) {
            ensureSkipPillInjected();
            return;
        }

        const anchorEl = findAnchorElementForPill(pill);
        if (!anchorEl) {
            pill.remove();
            skipPillEl = null;
            skipValueEl = null;
            skipPillAnchorEl = null;
            return;
        }

        if (!mountPillNearAnchor(pill, anchorEl)) {
            pill.remove();
            skipPillEl = null;
            skipValueEl = null;
            skipPillAnchorEl = null;
            return;
        }

        showSkipPill(pill);
    }

    function runSkipPillSync() {
        skipSyncRafId = null;
        ensureLiveFastForwardButtonInjected();
        syncExistingSkipPill();
    }

    function scheduleSkipPillSync({ delayed = false } = {}) {
        if (skipSyncRafId === null) {
            skipSyncRafId = requestAnimationFrame(runSkipPillSync);
        }

        if (!delayed) return;

        if (delayedSkipSyncTimer) clearTimeout(delayedSkipSyncTimer);
        delayedSkipSyncTimer = setTimeout(() => {
            delayedSkipSyncTimer = null;
            scheduleSkipPillSync();
        }, SKIP_VISIBILITY_RESYNC_DELAY_MS);
    }

    function ensureSkipPillInjected() {
        if (!isPillEnabled()) {
            removeSkipPill();
            return;
        }

        const anchorEl = findPillAnchorElement();
        const existing = getSkipPillElement();

        if (!anchorEl) {
            if (existing) {
                existing.remove();
                skipPillEl = null;
                skipValueEl = null;
                skipPillAnchorEl = null;
            }
            return;
        }

        injectSkipStyleOnce();
        installSkipPillGlobalHandlers();

        const pill = existing || createSkipPill();

        if (!mountPillNearAnchor(pill, anchorEl)) return;

        updateSkipPill();
        showSkipPill(pill);
    }

    function ensureLiveFastForwardButtonInjected() {
        if (!isLiveFastForwardButtonEnabled()) {
            removeLiveFastForwardButton();
            return;
        }

        const container = findLeftButtonsContainer();
        const existing = getLiveFastForwardButtonElement();
        if (!container) {
            if (existing) removeLiveFastForwardButton();
            return;
        }

        if (findExternalLiveFastForwardButton(container)) {
            if (existing) removeLiveFastForwardButton();
            return;
        }

        injectSkipStyleOnce();

        const button = existing || createLiveFastForwardButton();
        ensureLiveFastForwardButtonClickHandler(button);
        if (!mountLiveFastForwardButton(button, container)) return;
        syncLiveFastForwardButtonState(button);
    }

    function removeSkipPill() {
        uninstallSkipPillGlobalHandlers();
        const pill = getSkipPillElement();
        if (pill) pill.remove();
        skipPillEl = null;
        skipValueEl = null;
        skipPillAnchorEl = null;
    }

    function removeLiveFastForwardButton() {
        const button = getLiveFastForwardButtonElement();
        if (button) button.remove();
        liveFastForwardButtonEl = null;
    }

    function handlePageChange() {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        skipPillAnchorEl = null;
        clearUserSeekGestureIntent();
        clearLiveTimeShiftState();
        cancelResumeRestore({ clearSnapshot: true });
        if (pageChangeTimer) {
            clearTimeout(pageChangeTimer);
            pageChangeTimer = null;
        }

        if (!isPlaybackRoute()) {
            removeSkipPill();
            removeLiveFastForwardButton();
            detachLiveResumeGuard();
            refreshDomObserverConfig();
            return;
        }
        refreshDomObserverConfig();

        pageChangeTimer = setTimeout(() => {
            pageChangeTimer = null;
            ensureLiveResumeGuardAttached();
            ensureLiveFastForwardButtonInjected();
            ensureSkipPillInjected();
            scheduleSkipPillSync({ delayed: true });
        }, 500);
    }

    function mutationCouldAffectExtension(mutation) {
        if (
            mutation.type === "attributes" &&
            mutation.target instanceof HTMLElement &&
            mutation.target.closest(LIVE_LEFT_BUTTONS_SELECTOR)
        ) {
            return true;
        }
        if (mutationMatchesSelector(mutation, BUTTON_SELECTOR)) return true;
        return mutationMatchesSelector(mutation, RELEVANT_DOM_SELECTOR);
    }

    function startDomObserver() {
        if (domObserver) return;

        domObserver = createMutationObserverSync({
            onMutations(mutations) {
                handlePageChange();
                if (!isSkipEnabled() || !isPlaybackRoute()) return;
                if (mutations.some(mutationCouldAffectExtension)) scheduleDomSync();
            },
            onBodyReady() {
                refreshDomObserverConfig();
                scheduleDomSync();
            },
        });

        refreshDomObserverConfig();
    }

    function getDomObserverConfig(mode) {
        if (mode !== "playback") {
            return {
                childList: true,
                subtree: true,
            };
        }

        return {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: [
                "class",
                "style",
                "hidden",
                "aria-hidden",
                "label",
                "aria-label",
                "tooltip",
                "title",
                "disabled",
                "aria-disabled",
                LIVE_EDGE_PATCHED_ATTR,
            ],
        };
    }

    function refreshDomObserverConfig() {
        if (!domObserver || !document.body) return;
        const nextMode = isSkipEnabled() && isPlaybackRoute() ? "playback" : "idle";
        if (domObserverMode === nextMode) return;

        domObserver.disconnect();
        domObserver.observe(document.body, getDomObserverConfig(nextMode));
        domObserverMode = nextMode;
    }

    function stopDomObserver() {
        if (domObserver) {
            domObserver.disconnectAll?.();
            domObserver.disconnect();
            domObserver = null;
        }
        domObserverMode = "";
    }

    function installKeyboardHandler() {
        if (keyboardHandlerInstalled) return;
        keyboardHandlerInstalled = true;
        window.addEventListener("keydown", onKeyDownSeek, true);
    }

    function uninstallKeyboardHandler() {
        if (!keyboardHandlerInstalled) return;
        keyboardHandlerInstalled = false;
        window.removeEventListener("keydown", onKeyDownSeek, true);
    }

    function getEventElementTarget(target) {
        if (target instanceof HTMLElement) return target;
        if (target?.parentElement instanceof HTMLElement) return target.parentElement;
        return null;
    }

    function looksLikeSeekGestureElement(el) {
        if (!(el instanceof HTMLElement)) return false;

        const signature = compact(
            [getElementSignature(el), getCandidateText(el), el.getAttribute("role"), el.getAttribute("type")].join(" ")
        );
        if (NON_SEEK_GESTURE_SIGNATURE_TERMS.some((term) => signature.includes(compact(term)))) return false;

        return SEEK_GESTURE_SIGNATURE_TERMS.some((term) => signature.includes(term));
    }

    function findLikelySeekGestureElement(target) {
        const el = getEventElementTarget(target);
        if (!(el instanceof HTMLElement)) return null;

        let node = el;
        for (let depth = 0; node instanceof HTMLElement && depth < 6; depth += 1, node = node.parentElement) {
            if (looksLikeSeekGestureElement(node)) return node;
        }
        return null;
    }

    function isLikelyUserSeekGestureTarget(target) {
        if (!canUseLiveResumeGuard(attachedVideo)) return false;
        const seekEl = findLikelySeekGestureElement(target);
        return seekEl instanceof HTMLElement && isInLikelyVideoControlArea(seekEl, attachedVideo);
    }

    function isLikelyPlaybackTogglePointerEvent(event, button) {
        if (!canUseLiveResumeGuard(attachedVideo) || attachedVideo.paused) return false;
        if (isLikelyUserSeekGestureTarget(event.target)) return false;
        if (button instanceof HTMLElement && (button.id === SKIP_PILL_ID || looksLikeLiveEdgeButton(button)))
            return false;
        return isPointerEventInVideoArea(event, attachedVideo);
    }

    function handleUserSeekGestureRelease() {
        if (!userSeekGestureDragging) return;
        userSeekGestureDragging = false;
        markUserSeekGesture();
    }

    function handleUserSeekGestureCancel() {
        clearUserSeekGestureIntent();
        lastUserPauseIntentAt = Number.NEGATIVE_INFINITY;
    }

    function handleUserSeekVisibilityChange() {
        if (document.hidden) {
            clearUserSeekGestureIntent();
            lastUserPauseIntentAt = Number.NEGATIVE_INFINITY;
        }
    }

    function handleLiveMediaKeyIntent(event) {
        if (!isLiveRoute() || !canUseLiveResumeGuard(attachedVideo)) return;
        if (event.ctrlKey || event.altKey || event.metaKey || isEditableTarget(event.target)) return;

        const key = String(event.key || "").toLowerCase();
        if (
            event.code === "ArrowLeft" ||
            event.code === "ArrowRight" ||
            event.code === "KeyJ" ||
            event.code === "KeyL" ||
            key === "arrowleft" ||
            key === "arrowright" ||
            key === "j" ||
            key === "l"
        ) {
            markUserSeekGesture();
            return;
        }

        const isSpace = event.code === "Space" || key === " ";
        if (event.code === "KeyK" || key === "k" || (isSpace && featureOptions.holdSpeedEnabled !== true)) {
            markUserPauseIntent();
        }
    }

    function handleLiveControlIntent(event) {
        if (!isLiveRoute()) return;
        if (event.type === "pointerdown" && isLikelyUserSeekGestureTarget(event.target)) {
            userSeekGestureDragging = true;
            markUserSeekGesture();
        }

        const button = event.target?.closest?.(BUTTON_SELECTOR);
        if (
            isLikelyPlaybackToggleIntentTarget(event.target, button) ||
            (event.type === "pointerdown" && isLikelyPlaybackTogglePointerEvent(event, button))
        ) {
            markUserPauseIntent();
        }
        if (!(button instanceof HTMLElement)) return;

        if (looksLikePlaybackToggleButton(button)) {
            return;
        }

        if (looksLikeLiveEdgeButton(button)) {
            markLiveEdgeIntent();
            return;
        }

        if (
            button.id !== SKIP_PILL_ID &&
            attachedVideo?.paused &&
            canUseLiveResumeGuard(attachedVideo) &&
            isInLikelyVideoControlArea(button, attachedVideo)
        ) {
            lastPausedControlIntentAt = performance.now();
        }
    }

    function installLiveResumeGlobalHandlers() {
        if (liveResumeHandlersInstalled) return;
        liveResumeHandlersInstalled = true;
        window.addEventListener("pointerdown", handleLiveControlIntent, true);
        window.addEventListener("click", handleLiveControlIntent, true);
        window.addEventListener("keydown", handleLiveMediaKeyIntent, true);
        window.addEventListener("pointerup", handleUserSeekGestureRelease, true);
        window.addEventListener("pointercancel", handleUserSeekGestureRelease, true);
        window.addEventListener("blur", handleUserSeekGestureCancel, true);
        document.addEventListener("visibilitychange", handleUserSeekVisibilityChange, true);
    }

    function uninstallLiveResumeGlobalHandlers() {
        if (!liveResumeHandlersInstalled) return;
        liveResumeHandlersInstalled = false;
        clearUserSeekGestureIntent();
        lastUserPauseIntentAt = Number.NEGATIVE_INFINITY;
        window.removeEventListener("pointerdown", handleLiveControlIntent, true);
        window.removeEventListener("click", handleLiveControlIntent, true);
        window.removeEventListener("keydown", handleLiveMediaKeyIntent, true);
        window.removeEventListener("pointerup", handleUserSeekGestureRelease, true);
        window.removeEventListener("pointercancel", handleUserSeekGestureRelease, true);
        window.removeEventListener("blur", handleUserSeekGestureCancel, true);
        document.removeEventListener("visibilitychange", handleUserSeekVisibilityChange, true);
    }

    function clearRuntimeTimers() {
        if (pageChangeTimer) {
            clearTimeout(pageChangeTimer);
            pageChangeTimer = null;
        }
        if (delayedSkipSyncTimer) {
            clearTimeout(delayedSkipSyncTimer);
            delayedSkipSyncTimer = null;
        }
        if (skipSyncRafId !== null) {
            cancelAnimationFrame(skipSyncRafId);
            skipSyncRafId = null;
        }
        if (startupSyncTimer) {
            clearTimeout(startupSyncTimer);
            startupSyncTimer = 0;
        }
    }

    function installRuntime() {
        if (runtimeInstalled) return;
        runtimeInstalled = true;
        installKeyboardHandler();
        installLiveResumeGlobalHandlers();
        if (!removePageChangeDetection) {
            removePageChangeDetection = startPageChangeDetection(handlePageChange);
        }
        startDomObserver();
        ensureLiveResumeGuardAttached();
        ensureLiveFastForwardButtonInjected();
        if (isPillEnabled()) {
            ensureSkipPillInjected();
            scheduleSkipPillSync({ delayed: true });
        }
        startupSyncTimer = setTimeout(() => {
            startupSyncTimer = 0;
            ensureLiveFastForwardButtonInjected();
            if (isPillEnabled()) ensureSkipPillInjected();
        }, 800);
    }

    function teardownRuntime() {
        runtimeInstalled = false;
        clearRuntimeTimers();
        uninstallSkipPillGlobalHandlers();
        uninstallKeyboardHandler();
        uninstallLiveResumeGlobalHandlers();
        if (removePageChangeDetection) {
            removePageChangeDetection();
            removePageChangeDetection = null;
        }
        stopDomObserver();
        removeSkipPill();
        removeLiveFastForwardButton();
        detachLiveResumeGuard();
    }

    function applyOptions(options) {
        featureOptions = options;
        skipSeconds = normalizeSkipSeconds(options.skipSeconds);
        if (!isSkipEnabled()) {
            teardownRuntime();
            return;
        }
        installRuntime();
        ensureLiveResumeGuardAttached();
        ensureLiveFastForwardButtonInjected();
        refreshDomObserverConfig();
        if (!isPlaybackRoute()) {
            removeSkipPill();
            removeLiveFastForwardButton();
            return;
        }
        if (isPillEnabled()) {
            ensureSkipPillInjected();
            updateSkipPill();
            scheduleSkipPillSync({ delayed: true });
        } else {
            removeSkipPill();
        }
    }

    root.skipControl = Object.freeze({ markPlaybackToggleIntent });
    bindFeatureOptions(applyOptions);

    onReady(() => {
        if (isSkipEnabled()) installRuntime();
    });
})();
