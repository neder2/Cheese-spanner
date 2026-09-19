/**
 * features/volumeTooltip.js — 볼륨 컨트롤 주변 hover 시 설정된 볼륨(%)을 보여주는 툴팁 + 오디오 컴프레서 버튼.
 *
 * 실행 컨텍스트: isolated world(확장 컨텍스트).
 * 동작 위치: 메인 볼륨 컨트롤의 좌우 범위와 볼륨 바 상하 8px. 표시 중심은 볼륨 바 시작점에서 오른쪽 40px 위에 고정.
 * 하는 일: 이 파일은 서로 독립된 두 개의 IIFE로 구성된다.
 *   (1) 볼륨 툴팁 — 공용 판정으로 메인 소속을 확인한 볼륨 컨트롤 주변 hover 시 #betterchzzk-volume-tooltip 요소를
 *       표시하고, video의 volumechange 이벤트를 구독해 텍스트를 갱신한다. 전체화면 시 fullscreenElement로 이동.
 *   (2) 오디오 컴프레서(cheese-knife 기반, 출처 주석은 코드 내 유지) — 볼륨 컨트롤 옆에 토글 버튼을 삽입하고,
 *       Web Audio API로 MediaElementSource → DynamicsCompressor → Gain 그래프를 구성/해제한다. MutationObserver와
 *       startPageChangeDetection으로 플레이어 재마운트에 맞춰 버튼과 그래프 상태를 재동기화하며,
 *       버튼 오른쪽 볼륨바로 압축 후 출력 크기를 조절하며, background를 통해 현재 탭의 켜짐 상태와 볼륨을 저장한다.
 * 의존: 전역 BetterChzzkSettings.normalizeOptions, BetterChzzk.utils(bindFeatureOptions, injectStyleOnce,
 *   getMainVideoElement, getVideoViewportRect, createMutationObserverSync, createThrottledDomSync, isPlaybackRoute, isVisible,
 *   mutationMatchesSelector, onReady, startPageChangeDetection, runtimeSendMessage), 브라우저 Web Audio API(AudioContext).
 * 옵션 키: volumeTooltipEnabled, audioCompressorEnabled, audioCompressorThreshold, audioCompressorKnee,
 *   audioCompressorRatio, audioCompressorAttack, audioCompressorRelease, audioCompressorMakeupGain.
 * DOM 마커: #betterchzzk-volume-tooltip, #betterchzzk-volume-tooltip-style, #betterchzzk-audio-compressor,
 *   #betterchzzk-audio-compressor-control, #betterchzzk-audio-compressor-volume,
 *   #betterchzzk-audio-compressor-style, data-better-chzzk-audio-compressor, data-better-chzzk-ready.
 * 구조:
 *   - 볼륨 툴팁 IIFE (ensureTooltipElement, showTooltip/hideTooltip, watchVideo, applyOptions).
 *   - cheese-knife 출처 라이선스 주석(수정 금지).
 *   - 오디오 컴프레서 IIFE.
 *     - createGraph/graphFor/connectGraph/disconnectGraph: Web Audio 그래프 생성과 압축/우회 모드 전환.
 *     - resumeContext/installResumeHandlers: 오디오 상태 변화·탭 복귀·사용자 조작 시 중단 상태 복구.
 *     - createButton/ensureButton/syncButtonState: 토글 버튼 DOM 삽입과 위치/라벨 동기화.
 *     - syncState: 옵션/라우트/비디오 변경에 따른 전체 상태 재계산 진입점.
 *     - installRuntime: MutationObserver + 페이지 변경 감지 설치(1회).
 */
(() => {
    const TOOLTIP_ID = "betterchzzk-volume-tooltip";
    const STYLE_ID = "betterchzzk-volume-tooltip-style";
    const { getVolumeControlCandidates, getVolumeControlForVideo, getMainVideoElement, isPlaybackRoute } =
        globalThis.BetterChzzkVolumeControls;
    // Preserve the control row width; only narrow its vertical hover band.
    const VOLUME_SLIDER_SELECTOR = ".pzp-pc__volume-slider, .pzp-pc-volume-slider";
    const HOVER_VERTICAL_PADDING = 8;
    const TOOLTIP_HORIZONTAL_OFFSET = 40;
    const EXCLUDED_HOVER_SELECTOR =
        "#betterchzzk-skip-pill, #betterchzzk-live-fast-forward, [data-bcfp-player-mount], [data-bcfp-tooltip], .bcfp-player, .bcmv-cell";

    const { normalizeOptions } = BetterChzzkSettings;
    const { bindFeatureOptions, getVideoViewportRect, injectStyleOnce, startPageChangeDetection } = BetterChzzk.utils;

    let featureOptions = normalizeOptions();
    let tooltipEl = null;
    let hoverControl = null;
    let watchedVideo = null;
    let handlersInstalled = false;
    let removePageChangeDetection = null;
    let hoverObserver = null;

    function isEnabled() {
        return featureOptions.volumeTooltipEnabled;
    }

    function injectStyle() {
        injectStyleOnce(
            STYLE_ID,
            `
#${TOOLTIP_ID}{
  position:fixed;
  z-index:2147483647;
  visibility:visible;
  white-space:nowrap;
  pointer-events:none;
  transform:translate(-50%, -100%);
  transform-origin:50% 100%;
  transition:opacity 100ms ease;
}
`
        );
    }

    function getVolumeText(video) {
        if (!(video instanceof HTMLVideoElement)) return "";
        const volume = Number(video.volume);
        if (!Number.isFinite(volume)) return "";
        return `${Math.round(volume * 100)}%`;
    }

    function getTooltipMount() {
        return document.fullscreenElement || document.body;
    }

    function ensureTooltipElement() {
        if (tooltipEl?.isConnected && tooltipEl.parentElement === getTooltipMount()) return tooltipEl;
        injectStyle();
        if (!tooltipEl) {
            tooltipEl = BetterChzzk.utils.createPlayerTooltip();
            tooltipEl.id = TOOLTIP_ID;
        }
        getTooltipMount().appendChild(tooltipEl);
        return tooltipEl;
    }

    function positionTooltip(tooltip, control, video) {
        const rect = control.getBoundingClientRect();
        const videoRect = getVideoViewportRect(video);
        const nativeTooltip = control
            .closest(".pzp-pc")
            ?.querySelector(".pzp-pc__volume-button .pzp-button__tooltip:not(.betterchzzk-player-tooltip)");
        // This tooltip is mounted outside the scaled native control row. Copy its rendered scale too.
        const scaleTarget = nativeTooltip?.offsetWidth > 0 ? nativeTooltip : control;
        const ratio =
            scaleTarget.offsetWidth > 0 ? scaleTarget.getBoundingClientRect().width / scaleTarget.offsetWidth : 1;
        const scale = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
        tooltip.style.transform = `translate(-50%, -100%) scale(${scale})`;
        let tooltipBottom = rect.top - 10 * scale;
        if (nativeTooltip) {
            const nativeStyle = getComputedStyle(nativeTooltip);
            for (const property of [
                "fontFamily",
                "fontSize",
                "fontWeight",
                "lineHeight",
                "letterSpacing",
                "padding",
                "borderRadius",
                "backgroundColor",
                "color",
            ]) {
                tooltip.style[property] = nativeStyle[property];
            }
            const offset = Number.parseFloat(nativeStyle.top);
            if (Number.isFinite(offset)) {
                tooltipBottom =
                    nativeTooltip.parentElement.getBoundingClientRect().top +
                    offset * scale +
                    tooltip.getBoundingClientRect().height;
            }
        }
        const tipRect = tooltip.getBoundingClientRect();
        const left = Math.max(0, videoRect.left);
        const right = Math.min(window.innerWidth, videoRect.right);
        const top = Math.max(0, videoRect.top);
        const bottom = Math.min(window.innerHeight, videoRect.bottom);
        if (rect.width <= 0 || rect.height <= 0 || right - left < tipRect.width || bottom - top < tipRect.height) {
            return false;
        }
        // Keep the percentage centered at a fixed offset while the slider expands.
        tooltip.style.left = `${Math.max(left + tipRect.width / 2, Math.min(right - tipRect.width / 2, rect.left + TOOLTIP_HORIZONTAL_OFFSET * scale))}px`;
        tooltip.style.top = `${Math.max(top + tipRect.height, Math.min(bottom, tooltipBottom))}px`;
        return true;
    }

    function updateTooltipText() {
        if (!tooltipEl?.isConnected || !hoverControl) return;
        if (!hoverControl.isConnected || !watchedVideo?.isConnected) {
            hideTooltip();
            return;
        }
        const text = getVolumeText(watchedVideo);
        if (!text) {
            hideTooltip();
            return;
        }
        if (tooltipEl.textContent !== text) tooltipEl.textContent = text;
        if (!positionTooltip(tooltipEl, hoverControl, watchedVideo)) hideTooltip();
    }

    function onVolumeChange() {
        updateTooltipText();
    }

    function watchVideo(video) {
        if (watchedVideo === video) return;
        unwatchVideo();
        if (!(video instanceof HTMLVideoElement)) return;
        watchedVideo = video;
        watchedVideo.addEventListener("volumechange", onVolumeChange, true);
    }

    function unwatchVideo() {
        if (!watchedVideo) return;
        watchedVideo.removeEventListener("volumechange", onVolumeChange, true);
        watchedVideo = null;
    }

    function showTooltip(control, video) {
        const text = getVolumeText(video);
        if (!text) return;

        hoverControl = control;
        const tooltip = ensureTooltipElement();
        tooltip.textContent = text;
        if (!positionTooltip(tooltip, control, video)) {
            hideTooltip();
            return;
        }
        tooltip.style.opacity = "1";
        watchVideo(video);
        if (!hoverObserver) {
            hoverObserver = new MutationObserver(() => {
                if (!hoverControl?.isConnected || !watchedVideo?.isConnected) hideTooltip();
            });
            hoverObserver.observe(document.body, { childList: true, subtree: true });
        }
    }

    function hideTooltip() {
        hoverControl = null;
        unwatchVideo();
        hoverObserver?.disconnect();
        hoverObserver = null;
        if (tooltipEl?.isConnected) tooltipEl.remove();
    }

    function getTooltipSlider(event, video) {
        const target = event.target;
        if (!(target instanceof Element) || target.closest(EXCLUDED_HOVER_SELECTOR)) return null;
        const controls = getVolumeControlCandidates(event);
        for (const control of controls) {
            const slider = control.matches(VOLUME_SLIDER_SELECTOR)
                ? control
                : control.querySelector(VOLUME_SLIDER_SELECTOR);
            if (!slider || !getVolumeControlForVideo([slider], video)) continue;
            const rect = slider.getBoundingClientRect();
            if (
                rect.width > 0 &&
                rect.height > 0 &&
                event.clientY >= rect.top - HOVER_VERTICAL_PADDING &&
                event.clientY <= rect.bottom + HOVER_VERTICAL_PADDING
            )
                return slider;
        }
        return null;
    }

    function handleMouseOver(event) {
        if (!isEnabled() || !isPlaybackRoute()) return;
        if (!getVolumeControlCandidates(event).length) {
            if (hoverControl) hideTooltip();
            return;
        }
        const video = watchedVideo || getMainVideoElement();
        const control = getTooltipSlider(event, video);
        if (control) showTooltip(control, video);
        else if (hoverControl) hideTooltip();
    }

    function handleMouseOut(event) {
        if (!hoverControl) return;
        const next = getTooltipSlider(
            { target: event.relatedTarget, clientX: event.clientX, clientY: event.clientY },
            watchedVideo
        );
        if (next) {
            showTooltip(next, watchedVideo);
            return;
        }
        hideTooltip();
    }

    function handleViewportChange() {
        if (hoverControl) hideTooltip();
    }

    function installHandlers() {
        if (handlersInstalled) return;
        handlersInstalled = true;
        window.addEventListener("mouseover", handleMouseOver, true);
        window.addEventListener("mousemove", handleMouseOver, true);
        window.addEventListener("mouseout", handleMouseOut, true);
        window.addEventListener("scroll", handleViewportChange, true);
        window.addEventListener("resize", handleViewportChange, true);
        window.addEventListener("pagehide", hideTooltip, true);
        document.addEventListener("fullscreenchange", handleViewportChange, true);
        removePageChangeDetection = startPageChangeDetection(hideTooltip);
    }

    function uninstallHandlers() {
        if (!handlersInstalled) return;
        handlersInstalled = false;
        window.removeEventListener("mouseover", handleMouseOver, true);
        window.removeEventListener("mousemove", handleMouseOver, true);
        window.removeEventListener("mouseout", handleMouseOut, true);
        window.removeEventListener("scroll", handleViewportChange, true);
        window.removeEventListener("resize", handleViewportChange, true);
        window.removeEventListener("pagehide", hideTooltip, true);
        document.removeEventListener("fullscreenchange", handleViewportChange, true);
        removePageChangeDetection?.();
        removePageChangeDetection = null;
    }

    function applyOptions(options) {
        featureOptions = options;
        if (!isEnabled()) {
            uninstallHandlers();
            hideTooltip();
            return;
        }
        installHandlers();
    }

    bindFeatureOptions(applyOptions);
})();

/*
 * The audio compressor below is derived from cheese-knife
 * (https://github.com/jebibot/cheese-knife) — Copyright (c) 2023- jebibot,
 * MIT License — and was modified for Better Chzzk.
 * Full license text: THIRD_PARTY_NOTICES.md
 */
(() => {
    const BUTTON_ID = "betterchzzk-audio-compressor";
    const CONTROL_ID = "betterchzzk-audio-compressor-control";
    const SLIDER_ID = "betterchzzk-audio-compressor-volume";
    const STYLE_ID = "betterchzzk-audio-compressor-style";
    const STATE_MESSAGE = "betterchzzk:audio-compressor-state";
    const RESUME_EVENTS = ["pointerdown", "keydown", "click"];
    const VOLUME_CONTROL_SELECTOR = [
        ".pzp-pc__volume-control",
        ".pzp-pc-volume-control",
        "[class*='pzp'][class*='volume-control']",
    ].join(", ");
    const VOLUME_BUTTON_SELECTOR = [
        ".pzp-pc__volume-button",
        ".pzp-pc-volume-button",
        "[class*='pzp'][class*='volume-button']",
    ].join(", ");
    const BUTTON_LABEL = "오디오 컴프레서";
    const EXTERNAL_COMPRESSOR_SELECTOR = ".knife-comp";
    const SMOOTHING_SECONDS = 0.01;

    const { normalizeOptions } = BetterChzzkSettings;
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        createThrottledDomSync,
        getMainVideoElement,
        getVideoViewportRect,
        injectStyleOnce,
        isPlaybackRoute,
        isVisible,
        mutationMatchesSelector,
        onReady,
        runtimeSendMessage,
        startPageChangeDetection,
    } = BetterChzzk.utils;

    const graphs = new WeakMap();
    let featureOptions = normalizeOptions();
    let optionsReady = false;
    let stateReady = false;
    let compressorActive = false;
    let compressorVolume = 1;
    let activeVideo = null;
    let audioContext = null;
    let pendingResume = null;
    let removeResumeHandlers = null;
    let audioRecoveryStopped = false;
    let buttonEl = null;
    let controlEl = null;
    let runtimeInstalled = false;
    let removePageChangeDetection = null;
    const scheduleSync = createThrottledDomSync(syncState, 240);

    function featureEnabled() {
        return Boolean(featureOptions.audioCompressorEnabled);
    }

    function compressorEnabled() {
        return featureEnabled() && compressorActive;
    }

    function saveCompressorState() {
        void runtimeSendMessage({
            type: STATE_MESSAGE,
            kind: "set",
            state: { active: compressorActive, volume: compressorVolume },
        }).catch(() => {});
    }

    function setCompressorActive(active) {
        compressorActive = Boolean(active);
        saveCompressorState();
        syncState();
    }

    async function restoreCompressorState() {
        try {
            const response = await runtimeSendMessage({ type: STATE_MESSAGE, kind: "get" });
            const state = response?.ok ? response.state : null;
            compressorActive = state?.active === true;
            if (typeof state?.volume === "number" && Number.isFinite(state.volume)) {
                compressorVolume = normalizeCompressorVolume(state.volume);
            }
        } catch (_) {
            compressorActive = false;
        } finally {
            stateReady = true;
            syncState();
        }
    }

    function normalizeCompressorVolume(value) {
        return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
    }

    function setCompressorVolume(value) {
        if (!Number.isFinite(value)) return;
        compressorVolume = normalizeCompressorVolume(value);
        saveCompressorState();
        const graph = activeVideo ? graphs.get(activeVideo) : null;
        if (graph?.mode === "compressed") {
            setParam(graph.gain.gain, featureOptions.audioCompressorMakeupGain * compressorVolume, graph.context);
        }
        syncVolumeControl();
    }

    function visibleArea(el) {
        if (!(el instanceof HTMLElement) || !el.isConnected) return 0;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return 0;
        const style = getComputedStyle(el);
        return style.display === "none" || style.visibility === "hidden" ? 0 : rect.width * rect.height;
    }

    function isControlNearVideo(el, video) {
        if (!(el instanceof HTMLElement) || !(video instanceof HTMLVideoElement) || !isVisible?.(video)) return false;
        const controlRect = el.getBoundingClientRect();
        const videoRect = getVideoViewportRect(video);
        const centerX = controlRect.left + controlRect.width / 2;
        const centerY = controlRect.top + controlRect.height / 2;
        return (
            centerX >= videoRect.left - 36 &&
            centerX <= videoRect.right + 36 &&
            centerY >= videoRect.bottom - 150 &&
            centerY <= videoRect.bottom + 110 &&
            controlRect.height <= 112
        );
    }

    function usableVideo(video) {
        return video instanceof HTMLVideoElement && video.isConnected;
    }

    function safeDisconnect(node) {
        try {
            node?.disconnect?.();
        } catch (_) {
            // Some browser media pipelines reject Web Audio graph edits; playback must survive.
        }
    }

    function setParam(param, value, context) {
        if (!param) return;
        try {
            if (typeof param.setTargetAtTime === "function") {
                param.setTargetAtTime(value, Number(context?.currentTime) || 0, SMOOTHING_SECONDS);
                return;
            }
        } catch (_) {
            // Fall back to direct assignment.
        }
        try {
            param.value = value;
        } catch (_) {
            // Ignore unsupported parameter writes.
        }
    }

    function applyGraphOptions(graph) {
        if (!graph?.compressor || !graph?.gain) return;
        setParam(graph.compressor.threshold, featureOptions.audioCompressorThreshold, graph.context);
        setParam(graph.compressor.knee, featureOptions.audioCompressorKnee, graph.context);
        setParam(graph.compressor.ratio, featureOptions.audioCompressorRatio, graph.context);
        setParam(graph.compressor.attack, featureOptions.audioCompressorAttack, graph.context);
        setParam(graph.compressor.release, featureOptions.audioCompressorRelease, graph.context);
        setParam(graph.gain.gain, featureOptions.audioCompressorMakeupGain * compressorVolume, graph.context);
    }

    function disconnectGraph(graph) {
        safeDisconnect(graph?.source);
        safeDisconnect(graph?.compressor);
        safeDisconnect(graph?.gain);
        if (graph) graph.mode = "";
    }

    function connectGraph(graph, mode) {
        if (!graph || graph.failed || graph.mode === mode) return Boolean(graph && !graph.failed);
        disconnectGraph(graph);
        try {
            if (mode === "compressed") {
                graph.source.connect(graph.compressor);
                graph.compressor.connect(graph.gain);
            } else {
                setParam(graph.gain?.gain, 1, graph.context);
                graph.source.connect(graph.gain);
            }
            graph.gain.connect(graph.context.destination);
            graph.mode = mode;
            return true;
        } catch (_) {
            graph.mode = "";
            return false;
        }
    }

    function cleanupResumeHandlers() {
        removeResumeHandlers?.();
        removeResumeHandlers = null;
    }

    function installResumeHandlers() {
        if (
            audioRecoveryStopped ||
            !audioContext ||
            removeResumeHandlers ||
            audioContext.state === "running" ||
            audioContext.state === "closed"
        )
            return;
        const resume = () => resumeContext(true);
        for (const eventName of RESUME_EVENTS) window.addEventListener(eventName, resume, true);
        removeResumeHandlers = () => {
            for (const eventName of RESUME_EVENTS) window.removeEventListener(eventName, resume, true);
        };
    }

    function resumeContext(fromGesture = false) {
        const context = audioContext;
        if (audioRecoveryStopped || !context) return;
        if (context.state === "running" || context.state === "closed") {
            cleanupResumeHandlers();
            return;
        }
        installResumeHandlers();
        // A pending autoplay request may need a real user gesture. Allow that one
        // escalation, but share repeated focus/visibility/mutation requests.
        if (pendingResume && (!fromGesture || pendingResume.fromGesture)) return;
        const request = { fromGesture };
        pendingResume = request;
        const settle = () => {
            if (audioRecoveryStopped || pendingResume !== request) return;
            pendingResume = null;
            if (context.state === "running" || context.state === "closed") cleanupResumeHandlers();
            else installResumeHandlers();
        };
        try {
            Promise.resolve(context.resume()).then(settle, settle);
        } catch (_) {
            settle();
        }
    }

    function handleAudioStateChange() {
        resumeContext();
    }

    function handleAudioVisibility() {
        if (!document.hidden) resumeContext();
    }

    function handleAudioFocus() {
        resumeContext();
    }

    function markFailed(video, graph = null) {
        if (graph) {
            connectGraph(graph, "bypass");
            graph.failed = true;
            return graph;
        }
        graphs.set(video, { failed: true });
        return null;
    }

    function createGraph(video) {
        const AudioContextConstructor = globalThis.AudioContext || globalThis.webkitAudioContext || null;
        if (!AudioContextConstructor) return markFailed(video);
        let context = null;
        try {
            // MediaElementSource ownership lasts for the element's lifetime, including
            // native mini-player reparenting. Keep one context for this document.
            if (!audioContext) {
                audioContext = new AudioContextConstructor();
                audioContext.addEventListener?.("statechange", handleAudioStateChange);
                document.addEventListener("visibilitychange", handleAudioVisibility);
                window.addEventListener("focus", handleAudioFocus);
            }
            context = audioContext;
            const graph = {
                context,
                source: context.createMediaElementSource(video),
                compressor: context.createDynamicsCompressor(),
                gain: context.createGain(),
                mode: "",
                failed: false,
            };
            graphs.set(video, graph);
            return graph;
        } catch (_) {
            // Another media element may already be using this document's context.
            return markFailed(video);
        }
    }

    function graphFor(video) {
        const existing = graphs.get(video);
        if (existing) return existing.failed ? null : existing;
        return createGraph(video);
    }

    function releaseActiveGraph() {
        if (!activeVideo) return;
        // Losing the main-player role does not mean the native video is destroyed.
        // Preserve its source in the WeakMap so the same element can return safely.
        bypassActiveGraph();
        activeVideo = null;
    }

    function bypassActiveGraph() {
        const graph = activeVideo ? graphs.get(activeVideo) : null;
        if (!graph || graph.failed) return;
        connectGraph(graph, "bypass");
        resumeContext();
    }

    function handlePageHide(event) {
        if (event?.persisted) return;
        const graph = activeVideo ? graphs.get(activeVideo) : null;
        audioRecoveryStopped = true;
        pendingResume = null;
        cleanupResumeHandlers();
        audioContext?.removeEventListener?.("statechange", handleAudioStateChange);
        document.removeEventListener("visibilitychange", handleAudioVisibility);
        window.removeEventListener("focus", handleAudioFocus);
        disconnectGraph(graph);
        activeVideo = null;
        try {
            audioContext?.close?.();
        } catch (_) {
            // Only final document teardown can close the shared audio context.
        }
    }

    function handlePageShow(event) {
        if (event?.persisted) {
            resumeContext();
            syncState();
        }
    }

    function injectButtonStyle() {
        injectStyleOnce(
            STYLE_ID,
            `
#${BUTTON_ID}{position:relative;overflow:visible;}
#${BUTTON_ID}:focus-visible{outline:none;}
#${BUTTON_ID}:disabled{opacity:0.35;cursor:default;pointer-events:none;}
#${BUTTON_ID} .bcac-icon{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;flex:0 0 auto;color:currentColor;}
#${BUTTON_ID} .bcac-icon svg{display:block;width:36px;height:36px;}
#${BUTTON_ID} .bcac-icon svg.bcac-icon-on{display:none;}
#${BUTTON_ID}[aria-pressed="true"] .bcac-icon svg.bcac-icon-on{display:block;}
#${BUTTON_ID}[aria-pressed="true"] .bcac-icon svg.bcac-icon-off{display:none;}
#${CONTROL_ID}{position:relative;display:flex;align-items:center;flex:0 0 auto;color:inherit;}
#${CONTROL_ID} .bcac-volume{position:relative;display:flex;align-items:center;width:0;margin-right:0;opacity:0;pointer-events:none;transition:width .23s cubic-bezier(.33,1,.68,1),opacity .15s;}
#${CONTROL_ID}:hover .bcac-volume,#${CONTROL_ID}:focus-within .bcac-volume{width:72px;margin-right:10px;opacity:1;pointer-events:auto;}
#${SLIDER_ID}{appearance:none;-webkit-appearance:none;flex:0 0 72px;width:72px;height:max(14px,var(--bcac-thumb-size,10px));margin:0;padding:0;border:0;border-radius:0;background:transparent;color:inherit;cursor:pointer;}
#${SLIDER_ID}::-webkit-slider-runnable-track{height:var(--bcac-track-height,2px);background:linear-gradient(to right,var(--bcac-fill,#fff) var(--bcac-volume,100%),var(--bcac-track,rgba(255,255,255,.5)) var(--bcac-volume,100%));}
#${SLIDER_ID}::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:var(--bcac-thumb-size,10px);height:var(--bcac-thumb-size,10px);margin-top:calc((var(--bcac-track-height,2px) - var(--bcac-thumb-size,10px))/2);border:0;border-radius:50%;background:var(--bcac-fill,#fff);}
#${SLIDER_ID}::-moz-range-track{height:var(--bcac-track-height,2px);background:var(--bcac-track,rgba(255,255,255,.5));}
#${SLIDER_ID}::-moz-range-progress{height:var(--bcac-track-height,2px);background:var(--bcac-fill,#fff);}
#${SLIDER_ID}::-moz-range-thumb{width:var(--bcac-thumb-size,10px);height:var(--bcac-thumb-size,10px);border:0;border-radius:50%;background:var(--bcac-fill,#fff);}
#${SLIDER_ID}:is(:hover,:focus-visible,:active)::-webkit-slider-thumb{transform:scale(1.4);}
#${SLIDER_ID}:is(:hover,:focus-visible,:active)::-moz-range-thumb{transform:scale(1.4);}
#${BUTTON_ID}:focus-visible,#${SLIDER_ID}:focus-visible{outline:2px solid var(--sem-color-content-brand-strong,var(--Content-Brand-Strong,#00ffa3));outline-offset:3px;}
#${SLIDER_ID}:disabled{opacity:.35;cursor:default;}
#${CONTROL_ID} .bcac-volume:hover > .betterchzzk-player-tooltip,#${CONTROL_ID} .bcac-volume:focus-within > .betterchzzk-player-tooltip{visibility:visible;}
#${CONTROL_ID}:has(.bcac-volume:hover,.bcac-volume:focus-within) #${BUTTON_ID} > .betterchzzk-player-tooltip{visibility:hidden;}
@media(prefers-reduced-motion:reduce){#${CONTROL_ID} .bcac-volume{transition:none;}}
`
        );
    }

    function findVolumeControl() {
        const video = getMainVideoElement?.();
        const candidates = [];
        for (const el of document.querySelectorAll(VOLUME_CONTROL_SELECTOR)) {
            if (el.id === CONTROL_ID || controlEl?.contains(el)) continue;
            if (!(el instanceof HTMLElement) || visibleArea(el) <= 0) continue;
            if (video instanceof HTMLVideoElement && !isControlNearVideo(el, video)) continue;
            const rect = el.getBoundingClientRect();
            candidates.push({ el, left: rect.left, width: rect.width });
        }
        candidates.sort((a, b) => a.left - b.left || a.width - b.width);
        return candidates[0]?.el || null;
    }

    function findVolumeButton(container) {
        const buttons = Array.from(container?.querySelectorAll?.(VOLUME_BUTTON_SELECTOR) || []).filter((el) => {
            return el instanceof HTMLElement && el.id !== BUTTON_ID && visibleArea(el) > 0;
        });
        buttons.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        return buttons[0] || null;
    }

    function currentButton() {
        if (buttonEl && (buttonEl.isConnected || controlEl?.contains(buttonEl))) return buttonEl;
        buttonEl = document.getElementById(BUTTON_ID);
        return buttonEl;
    }

    function findExternalCompressor() {
        for (const el of document.querySelectorAll(EXTERNAL_COMPRESSOR_SELECTOR)) {
            if (el instanceof HTMLElement && el.id !== BUTTON_ID && !el.contains(currentButton())) return el;
        }
        return null;
    }

    function syncButtonLabels(button, failed = false) {
        const label = failed ? `${BUTTON_LABEL}(사용할 수 없음)` : BUTTON_LABEL;
        button.setAttribute("label", label);
        button.setAttribute("aria-label", label);
        button.setAttribute("tooltip", label);
        BetterChzzk.utils.syncPlayerButtonTooltip(button, label);
        button.removeAttribute("title");
    }

    function syncButtonClass(button, container) {
        const reference = findVolumeButton(container);
        button.className = reference?.className || "";
        button.style.order = "";
        button.style.marginLeft = "";
        if (!reference) return;
        const style = getComputedStyle(reference);
        button.style.opacity = reference.style.opacity || "";
        button.style.visibility = style.visibility === "hidden" ? "hidden" : "";
        button.style.pointerEvents = style.pointerEvents === "none" ? "none" : "";
        button.style.transition = reference.style.transition || "";
    }

    function syncButtonState(button = currentButton()) {
        if (!(button instanceof HTMLButtonElement)) return;
        const video = getMainVideoElement?.();
        const active = compressorEnabled();
        const failed = active && video instanceof HTMLVideoElement && graphs.get(video)?.failed === true;
        button.disabled = !isPlaybackRoute() || !usableVideo(video);
        button.setAttribute("aria-pressed", active ? "true" : "false");
        button.dataset.betterChzzkAudioCompressor = active ? "1" : "0";
        button.dataset.betterChzzkReady = failed ? "0" : "1";
        syncButtonLabels(button, failed);
        syncVolumeControl();
    }

    function syncVolumeControl() {
        const slider = controlEl?.querySelector("input");
        if (!slider) return;
        const percent = String(Math.round(compressorVolume * 100));
        if (slider.value !== percent) slider.value = percent;
        if (slider.style.getPropertyValue("--bcac-volume") !== `${percent}%`) {
            slider.style.setProperty("--bcac-volume", `${percent}%`);
        }
        slider.setAttribute("aria-valuetext", `${percent}%`);
        slider.disabled = Boolean(buttonEl?.disabled) || buttonEl?.dataset.betterChzzkReady === "0";
        const tooltip = controlEl.querySelector(".bcac-volume .betterchzzk-player-tooltip");
        const text = `컴프레서 볼륨 ${percent}%`;
        if (tooltip && tooltip.textContent !== text) tooltip.textContent = text;
    }

    function createControl(button) {
        const control = document.createElement("div");
        control.id = CONTROL_ID;
        const volume = document.createElement("div");
        volume.className = "bcac-volume";
        const slider = document.createElement("input");
        slider.id = SLIDER_ID;
        slider.type = "range";
        slider.min = "0";
        slider.max = "100";
        slider.step = "1";
        slider.setAttribute("aria-label", "컴프레서 볼륨");
        slider.addEventListener("input", () => setCompressorVolume(Number(slider.value) / 100));
        volume.append(slider, BetterChzzk.utils.createPlayerTooltip());
        control.append(button, volume);
        for (const eventName of ["pointerdown", "pointerup", "click", "keydown", "keyup"]) {
            volume.addEventListener(eventName, (event) => event.stopPropagation());
        }
        control.addEventListener(
            "wheel",
            (event) => {
                if (
                    !featureOptions.volumeWheelEnabled ||
                    slider.disabled ||
                    !Number.isFinite(event.deltaY) ||
                    !event.deltaY
                )
                    return;
                event.preventDefault();
                event.stopPropagation();
                setCompressorVolume(
                    compressorVolume + ((event.deltaY < 0 ? 1 : -1) * featureOptions.volumeWheelStep) / 100
                );
            },
            { passive: false }
        );
        controlEl = control;
        return control;
    }

    function syncControlAppearance(container) {
        if (controlEl.className !== container.className) controlEl.className = container.className;
        // Read untransformed dimensions: the shared native row already applies its fullscreen scale.
        for (const [property, selector, dimension] of [
            ["--bcac-thumb-size", ".pzp-ui-slider__handler-wrap", "width"],
            ["--bcac-track-height", ".pzp-ui-progress", "height"],
        ]) {
            const node = container.querySelector(selector);
            const value = node ? getComputedStyle(node)[dimension] : "";
            const size = Number.parseFloat(value);
            const next = Number.isFinite(size) && size > 0 && value.endsWith("px") ? value : "";
            if (controlEl.style.getPropertyValue(property) !== next) {
                if (next) controlEl.style.setProperty(property, next);
                else controlEl.style.removeProperty(property);
            }
        }
        // 2026-09-11: CHZZK's volume track and thumb stay white over the video in both themes.
        const fill = container.querySelector(".pzp-ui-progress__volume");
        const track = container.querySelector(".pzp-ui-progress__entire-background");
        for (const [property, node] of [
            ["--bcac-fill", fill],
            ["--bcac-track", track],
        ]) {
            const color = node ? getComputedStyle(node).backgroundColor : "";
            if (controlEl.style.getPropertyValue(property) !== color) controlEl.style.setProperty(property, color);
        }
    }

    function createButton() {
        injectButtonStyle();
        const button = document.createElement("button");
        button.id = BUTTON_ID;
        button.type = "button";
        syncButtonLabels(button);
        button.innerHTML = `
<ui-icon class="bcac-icon" aria-hidden="true">
  <svg class="bcac-icon-on" xmlns="http://www.w3.org/2000/svg" viewBox="-300 -300 1600 1600" focusable="false">
    <path fill="currentColor" d="M850 200C877.7 200 900 222.3 900 250V750C900 777.7 877.7 800 850 800S800 777.7 800 750V250C800 222.3 822.3 200 850 200ZM570 250C597.7 250 620 272.3 620 300V700C620 727.7 597.7 750 570 750S520 727.7 520 700V300C520 272.3 542.3 250 570 250ZM710 225C737.7 225 760 247.3 760 275V725C760 752.7 737.7 775 710 775S660 752.7 660 725V275C660 247.3 682.3 225 710 225ZM430 250C457.7 250 480 272.3 480 300V700C480 727.7 457.7 750 430 750S380 727.7 380 700V300C380 272.3 402.3 250 430 250ZM290 225C317.7 225 340 247.3 340 275V725C340 752.7 317.7 775 290 775S240 752.7 240 725V275C240 247.3 262.3 225 290 225ZM150 200C177.7 200 200 222.3 200 250V750C200 777.7 177.7 800 150 800S100 777.7 100 750V250C100 222.3 122.3 200 150 200Z"></path>
    <circle r="160" cx="900" cy="800" fill="#00ffa3"></circle>
  </svg>
  <svg class="bcac-icon-off" xmlns="http://www.w3.org/2000/svg" viewBox="-300 -300 1600 1600" focusable="false">
    <path fill="currentColor" d="M850 202.3C877.7 202.3 900 224.6 900 252.3V745.5C900 773.2 877.7 795.5 850 795.5S800 773.2 800 745.5V252.3C800 224.6 822.3 202.3 850 202.3ZM570 167.8C597.7 167.8 620 190.1 620 217.8V780C620 807.7 597.7 830 570 830S520 807.7 520 780V217.8C520 190.1 542.3 167.8 570 167.8ZM710 264.4C737.7 264.4 760 286.7 760 314.4V683.3C760 711 737.7 733.3 710 733.3S660 711 660 683.3V314.4C660 286.7 682.3 264.4 710 264.4ZM430 98.1C457.7 98.1 480 120.4 480 148.1V849.6C480 877.3 457.7 899.6 430 899.6S380 877.3 380 849.6V148.1C380 120.4 402.3 98.1 430 98.1ZM290 217.2C317.7 217.2 340 239.5 340 267.2V730.5C340 758.2 317.7 780.5 290 780.5S240 758.2 240 730.5V267.2C240 239.5 262.3 217.2 290 217.2ZM150 299.6C177.7 299.6 200 321.9 200 349.6V648.1C200 675.8 177.7 698.1 150 698.1S100 675.8 100 648.1V349.6C100 321.9 122.3 299.6 150 299.6Z"></path>
    <circle r="160" cx="900" cy="800" fill="#838285"></circle>
  </svg>
</ui-icon>
`;
        button.addEventListener(
            "click",
            (event) => {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                setCompressorActive(!compressorActive && featureEnabled());
            },
            true
        );
        buttonEl = button;
        return button;
    }

    function removeButton() {
        const button = currentButton();
        if (button) button.remove();
        controlEl?.remove();
        controlEl = null;
        buttonEl = null;
    }

    function ensureButton() {
        if (!featureEnabled() || !isPlaybackRoute()) {
            removeButton();
            return;
        }
        if (findExternalCompressor()) {
            removeButton();
            return;
        }
        const container = findVolumeControl();
        if (!container) {
            removeButton();
            return;
        }
        const button = currentButton() || createButton();
        syncButtonClass(button, container);
        const control = controlEl || createControl(button);
        if (button.parentElement !== control) control.prepend(button);
        if (control.previousElementSibling !== container || control.parentElement !== container.parentElement) {
            container.insertAdjacentElement("afterend", control);
        }
        syncControlAppearance(container);
        syncButtonState(button);
    }

    function syncDisabledState() {
        removeButton();
        bypassActiveGraph();
    }

    function syncState() {
        if (!optionsReady || !stateReady) return;
        if (!featureEnabled()) {
            syncDisabledState();
            return;
        }
        if (findExternalCompressor()) {
            removeButton();
            bypassActiveGraph();
            return;
        }
        ensureButton();
        if (!isPlaybackRoute()) {
            bypassActiveGraph();
            return;
        }
        const video = getMainVideoElement?.();
        if (activeVideo && activeVideo !== video) releaseActiveGraph();
        if (!usableVideo(video)) {
            syncButtonState();
            return;
        }
        if (!compressorEnabled()) {
            const existing = graphs.get(video);
            if (existing && !existing.failed) {
                activeVideo = video;
                connectGraph(existing, "bypass");
                resumeContext();
            }
            syncButtonState();
            return;
        }
        activeVideo = video;
        const graph = graphFor(video);
        if (!graph || graph.failed) {
            syncButtonState();
            return;
        }
        applyGraphOptions(graph);
        if (!connectGraph(graph, "compressed")) markFailed(video, graph);
        resumeContext();
        syncButtonState();
    }

    function isOwnButtonMutation(mutation) {
        // syncState가 매번 버튼의 class/style을 다시 쓰므로, 자기 자신이 만든
        // attribute mutation으로 sync가 다시 깨어나는 자기 루프를 끊는다.
        if (!controlEl || !(mutation.target instanceof Node)) return false;
        return mutation.target === controlEl || controlEl.contains(mutation.target);
    }

    function installRuntime() {
        if (runtimeInstalled) return;
        runtimeInstalled = true;
        if (!removePageChangeDetection) removePageChangeDetection = startPageChangeDetection(syncState);
        window.addEventListener("pagehide", handlePageHide, true);
        window.addEventListener("pageshow", handlePageShow, true);
        createMutationObserverSync({
            // childList만으로는 플레이어 지연 로드를 놓친다: 컨트롤이 DOM에 들어온 뒤
            // 상태 변화가 class 토글로만 일어나면 재동기화 기회가 없어 버튼이 영영 안 생긴다.
            options: {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["class", "style", "hidden", "aria-hidden"],
            },
            onMutations(mutations) {
                if (
                    mutations.some(
                        (mutation) =>
                            !isOwnButtonMutation(mutation) &&
                            (mutationMatchesSelector(mutation, "video") ||
                                (mutation.target instanceof Element &&
                                    mutation.target.closest(VOLUME_CONTROL_SELECTOR) &&
                                    mutationMatchesSelector(
                                        mutation,
                                        ".pzp-ui-slider__handler-wrap, .pzp-ui-progress"
                                    )) ||
                                mutationMatchesSelector(mutation, VOLUME_CONTROL_SELECTOR) ||
                                mutationMatchesSelector(mutation, VOLUME_BUTTON_SELECTOR) ||
                                mutationMatchesSelector(mutation, EXTERNAL_COMPRESSOR_SELECTOR))
                    )
                ) {
                    scheduleSync();
                }
            },
            onBodyReady: syncState,
        });
    }

    void restoreCompressorState();

    bindFeatureOptions((options) => {
        featureOptions = options;
        optionsReady = true;
        installRuntime();
        syncState();
    });

    onReady(() => {
        installRuntime();
        syncState();
    });
})();
