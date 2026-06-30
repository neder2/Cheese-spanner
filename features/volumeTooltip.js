(() => {
    const TOOLTIP_ID = "betterchzzk-volume-tooltip";
    const STYLE_ID = "betterchzzk-volume-tooltip-style";
    // 스피커 아이콘이 아니라 볼륨 바(슬라이더) 위에서만 툴팁을 띄운다.
    const VOLUME_SLIDER_SELECTOR = [
        "[class*='pzp'][class*='volume'][class*='slider']",
        ".pzp-pc__volume-slider",
        ".pzp-pc-volume-slider",
    ].join(", ");
    const MUTED_LABEL = "음소거";

    const { normalizeOptions } = BetterChzzkSettings;
    const { bindFeatureOptions, injectStyleOnce, getMainVideoElement } = BetterChzzk.utils;

    let featureOptions = normalizeOptions();
    let tooltipEl = null;
    let hoverControl = null;
    let watchedVideo = null;
    let handlersInstalled = false;

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
  padding:6px 12px;
  border-radius:9999px;
  background:rgba(18,18,20,0.92);
  color:#fff;
  font-size:13px;
  font-weight:600;
  line-height:18px;
  letter-spacing:0;
  font-variant-numeric:tabular-nums;
  white-space:nowrap;
  pointer-events:none;
  transform:translate(-50%, -100%);
  transition:opacity 100ms ease;
}
`
        );
    }

    function getVolumeText(video) {
        if (!(video instanceof HTMLVideoElement)) return "";
        if (video.muted) return MUTED_LABEL;
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
            tooltipEl = document.createElement("div");
            tooltipEl.id = TOOLTIP_ID;
        }
        getTooltipMount().appendChild(tooltipEl);
        return tooltipEl;
    }

    function positionTooltip(tooltip, control) {
        const rect = control.getBoundingClientRect();
        tooltip.style.left = `${rect.left + rect.width / 2}px`;
        tooltip.style.top = `${rect.top - 10}px`;
    }

    function updateTooltipText() {
        if (!tooltipEl?.isConnected || !hoverControl) return;
        const text = getVolumeText(getMainVideoElement());
        if (!text) {
            hideTooltip();
            return;
        }
        if (tooltipEl.textContent !== text) tooltipEl.textContent = text;
    }

    function onVolumeChange() {
        updateTooltipText();
    }

    function watchVideo() {
        const video = getMainVideoElement();
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

    function showTooltip(control) {
        const text = getVolumeText(getMainVideoElement());
        if (!text) return;

        hoverControl = control;
        const tooltip = ensureTooltipElement();
        tooltip.textContent = text;
        positionTooltip(tooltip, control);
        tooltip.style.opacity = "1";
        watchVideo();
    }

    function hideTooltip() {
        hoverControl = null;
        unwatchVideo();
        if (tooltipEl?.isConnected) tooltipEl.remove();
    }

    function handleMouseOver(event) {
        if (!isEnabled()) return;
        const control = event.target?.closest?.(VOLUME_SLIDER_SELECTOR);
        if (!(control instanceof HTMLElement)) return;
        showTooltip(control);
    }

    function handleMouseOut(event) {
        if (!hoverControl) return;
        const next = event.relatedTarget;
        if (next instanceof Element && next.closest?.(VOLUME_SLIDER_SELECTOR)) return;
        hideTooltip();
    }

    function handleViewportChange() {
        if (hoverControl) hideTooltip();
    }

    function installHandlers() {
        if (handlersInstalled) return;
        handlersInstalled = true;
        window.addEventListener("mouseover", handleMouseOver, true);
        window.addEventListener("mouseout", handleMouseOut, true);
        window.addEventListener("scroll", handleViewportChange, true);
        document.addEventListener("fullscreenchange", handleViewportChange, true);
    }

    function uninstallHandlers() {
        if (!handlersInstalled) return;
        handlersInstalled = false;
        window.removeEventListener("mouseover", handleMouseOver, true);
        window.removeEventListener("mouseout", handleMouseOut, true);
        window.removeEventListener("scroll", handleViewportChange, true);
        document.removeEventListener("fullscreenchange", handleViewportChange, true);
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

(() => {
    const BUTTON_ID = "betterchzzk-audio-compressor";
    const STYLE_ID = "betterchzzk-audio-compressor-style";
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
    const SMOOTHING_SECONDS = 0.01;

    const { normalizeOptions } = BetterChzzkSettings;
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        createThrottledDomSync,
        getMainVideoElement,
        injectStyleOnce,
        isPlaybackRoute,
        isVisible,
        mutationMatchesSelector,
        onReady,
        startPageChangeDetection,
    } = BetterChzzk.utils;

    const graphs = new WeakMap();
    let featureOptions = normalizeOptions();
    let compressorActive = false;
    let activeVideo = null;
    let buttonEl = null;
    let runtimeInstalled = false;
    let removePageChangeDetection = null;
    const scheduleSync = createThrottledDomSync(syncState, 240);

    function featureEnabled() {
        return Boolean(featureOptions.audioCompressorEnabled);
    }

    function compressorEnabled() {
        return featureEnabled() && compressorActive;
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
        const videoRect = video.getBoundingClientRect();
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
        setParam(graph.gain.gain, featureOptions.audioCompressorMakeupGain, graph.context);
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

    function cleanupResumeHandlers(graph) {
        if (!graph?.removeResumeHandlers) return;
        graph.removeResumeHandlers();
        graph.removeResumeHandlers = null;
    }

    function installResumeHandlers(graph) {
        if (!graph || graph.removeResumeHandlers || graph.context?.state === "running") return;
        const resume = () => resumeContext(graph);
        for (const eventName of RESUME_EVENTS) window.addEventListener(eventName, resume, true);
        graph.removeResumeHandlers = () => {
            for (const eventName of RESUME_EVENTS) window.removeEventListener(eventName, resume, true);
        };
    }

    function resumeContext(graph) {
        const context = graph?.context;
        if (!context || context.state === "closed") return;
        if (context.state === "running") {
            cleanupResumeHandlers(graph);
            return;
        }
        try {
            const result = context.resume?.();
            if (result && typeof result.then === "function") {
                result.then(() => cleanupResumeHandlers(graph)).catch(() => installResumeHandlers(graph));
            }
        } catch (_) {
            installResumeHandlers(graph);
        }
        if (context.state !== "running") installResumeHandlers(graph);
    }

    function markFailed(video, graph = null) {
        if (graph) {
            connectGraph(graph, "bypass");
            graph.failed = true;
            cleanupResumeHandlers(graph);
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
            context = new AudioContextConstructor();
            const graph = {
                context,
                source: context.createMediaElementSource(video),
                compressor: context.createDynamicsCompressor(),
                gain: context.createGain(),
                mode: "",
                failed: false,
                removeResumeHandlers: null,
            };
            graphs.set(video, graph);
            return graph;
        } catch (_) {
            try {
                context?.close?.();
            } catch (_) {
                // Ignore close failures after setup failure.
            }
            return markFailed(video);
        }
    }

    function graphFor(video) {
        const existing = graphs.get(video);
        if (existing) return existing.failed ? null : existing;
        return createGraph(video);
    }

    function closeGraph(graph) {
        cleanupResumeHandlers(graph);
        disconnectGraph(graph);
        try {
            graph?.context?.close?.();
        } catch (_) {
            // Best effort only.
        }
    }

    function releaseActiveGraph() {
        if (!activeVideo) return;
        closeGraph(graphs.get(activeVideo));
        graphs.delete(activeVideo);
        activeVideo = null;
    }

    function injectButtonStyle() {
        injectStyleOnce(
            STYLE_ID,
            `
#${BUTTON_ID}{position:relative;overflow:visible;}
#${BUTTON_ID}:focus-visible{outline:none;}
#${BUTTON_ID}:disabled{opacity:0.35;cursor:default;pointer-events:none;}
#${BUTTON_ID}[tooltip]:not(:disabled)::after{
  position:absolute;left:50%;bottom:calc(100% + 12px);z-index:2147483647;display:block;
  padding:9px 15px;border-radius:9999px;background:rgba(18,18,20,0.92);color:#fff;
  content:attr(tooltip);font-size:14px;font-weight:400;line-height:18px;letter-spacing:0;
  white-space:nowrap;opacity:0;visibility:hidden;pointer-events:none;
  transform:translateX(-50%) translateY(4px);
  transition:opacity 120ms ease, transform 120ms ease, visibility 120ms ease;
}
#${BUTTON_ID}[tooltip]:not(:disabled):hover::after,
#${BUTTON_ID}[tooltip]:not(:disabled):focus-visible::after{opacity:1;visibility:visible;transform:translateX(-50%) translateY(0);}
#${BUTTON_ID} .bcac-icon{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;flex:0 0 auto;color:currentColor;}
#${BUTTON_ID} .bcac-icon svg{display:block;width:36px;height:36px;}
#${BUTTON_ID} .bcac-icon svg.bcac-icon-on{display:none;}
#${BUTTON_ID}[aria-pressed="true"] .bcac-icon svg.bcac-icon-on{display:block;}
#${BUTTON_ID}[aria-pressed="true"] .bcac-icon svg.bcac-icon-off{display:none;}
`
        );
    }

    function findVolumeControl() {
        const video = getMainVideoElement?.();
        const candidates = [];
        for (const el of document.querySelectorAll(VOLUME_CONTROL_SELECTOR)) {
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
        if (buttonEl?.isConnected) return buttonEl;
        buttonEl = document.getElementById(BUTTON_ID);
        return buttonEl;
    }

    function syncButtonLabels(button) {
        button.setAttribute("label", BUTTON_LABEL);
        button.setAttribute("aria-label", BUTTON_LABEL);
        button.setAttribute("tooltip", BUTTON_LABEL);
        button.removeAttribute("title");
    }

    function syncButtonClass(button, container) {
        const reference = findVolumeButton(container);
        button.className = reference?.className || "";
        button.classList.add("knife-audio-compressor");
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
        syncButtonLabels(button);
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
                compressorActive = !compressorActive && featureEnabled();
                syncState();
            },
            true
        );
        buttonEl = button;
        return button;
    }

    function removeButton() {
        const button = currentButton();
        if (button) button.remove();
        buttonEl = null;
    }

    function ensureButton() {
        if (!featureEnabled() || !isPlaybackRoute()) {
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
        const reference = findVolumeButton(container);
        if (reference?.parentElement === container) {
            if (button.parentElement !== container || button.previousElementSibling !== reference) {
                if (button.parentElement) button.remove();
                reference.insertAdjacentElement("afterend", button);
            }
        } else if (button.parentElement !== container) {
            if (button.parentElement) button.remove();
            container.appendChild(button);
        }
        syncButtonState(button);
    }

    function syncDisabledState() {
        compressorActive = false;
        removeButton();
        const graph = activeVideo ? graphs.get(activeVideo) : null;
        if (graph && !graph.failed) {
            connectGraph(graph, "bypass");
            resumeContext(graph);
        }
    }

    function syncState() {
        if (!featureEnabled()) {
            syncDisabledState();
            return;
        }
        ensureButton();
        if (!isPlaybackRoute()) {
            compressorActive = false;
            releaseActiveGraph();
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
                connectGraph(existing, "bypass");
                resumeContext(existing);
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
        resumeContext(graph);
        syncButtonState();
    }

    function installRuntime() {
        if (runtimeInstalled) return;
        runtimeInstalled = true;
        if (!removePageChangeDetection) removePageChangeDetection = startPageChangeDetection(syncState);
        window.addEventListener("pagehide", releaseActiveGraph, true);
        createMutationObserverSync({
            onMutations(mutations) {
                if (
                    mutations.some(
                        (mutation) =>
                            mutationMatchesSelector(mutation, "video") ||
                            mutationMatchesSelector(mutation, VOLUME_CONTROL_SELECTOR) ||
                            mutationMatchesSelector(mutation, VOLUME_BUTTON_SELECTOR)
                    )
                ) {
                    scheduleSync();
                }
            },
            onBodyReady: syncState,
        });
    }

    bindFeatureOptions((options) => {
        featureOptions = options;
        installRuntime();
        syncState();
    });

    onReady(() => {
        installRuntime();
        syncState();
    });
})();
