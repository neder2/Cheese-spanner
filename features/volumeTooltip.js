(() => {
    const TOOLTIP_ID = "betterchzzk-volume-tooltip";
    const STYLE_ID = "betterchzzk-volume-tooltip-style";
    const VOLUME_CONTROL_SELECTOR = [
        "[class*='pzp'][class*='volume']",
        ".pzp-pc__volume",
        ".pzp-pc__volume-control",
        ".pzp-pc__volume-button",
        ".pzp-pc__volume-slider",
        ".pzp-pc-volume",
        ".pzp-pc-volume-control",
        ".pzp-pc-volume-button",
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
        injectStyleOnce(STYLE_ID, `
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
`);
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
        const control = event.target?.closest?.(VOLUME_CONTROL_SELECTOR);
        if (!(control instanceof HTMLElement)) return;
        showTooltip(control);
    }

    function handleMouseOut(event) {
        if (!hoverControl) return;
        const next = event.relatedTarget;
        if (next instanceof Element && next.closest?.(VOLUME_CONTROL_SELECTOR)) return;
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
