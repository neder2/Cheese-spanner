// Cursor-centred zoom for the main player. Native video and controls keep their DOM parents.
(() => {
    "use strict";
    if (BetterChzzk.playerZoom) return;
    BetterChzzk.playerZoom = {};

    const {
        bindFeatureOptions,
        getMainVideoElement,
        getVideoViewportRect,
        setVideoViewportTransform,
        getPlayerRoot,
        isPlaybackRoute,
        startPageChangeDetection,
        createMutationObserverSync,
        mutationMatchesSelector,
        injectStyleOnce,
        syncPlayerButtonTooltip,
    } = BetterChzzk.utils;
    const ID = "betterchzzk-player-zoom";
    const CONTROLS = ".pzp-pc__bottom-buttons-right";
    const EXCLUDED =
        "button, a, input, textarea, select, summary, [contenteditable]:not([contenteditable='false']), " +
        "[role='button'], [role='slider'], [role='menu'], [role='dialog'], [role='separator'], " +
        ".pzp-pc__bottom, .pzp-pc__top, .pzp-pc__settings, [class*='bottom-buttons'], " +
        "[data-bcmv-video], [data-bcmv-channel], [data-bcfp-tooltip], #betterchzzk-stream-info";
    const VIDEO_STYLES = ["transform", "transform-origin", "clip-path", "transition", "will-change"];
    let enabled = false;
    let mode = "manual";
    let suspended = false;
    let state = null;
    let observer = null;
    let removeRoute = null;
    let dragging = null;
    let suppressClick = false;

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const active = () => state && (mode === "always" || state.manual);
    const current = () =>
        enabled && !suspended && isPlaybackRoute() && state?.video.isConnected && state.player.contains(state.video);

    function saveStyles(node, names) {
        return names.map((name) => [name, node.style.getPropertyValue(name), node.style.getPropertyPriority(name)]);
    }

    function restoreStyles(node, saved) {
        for (const [name, value, priority] of saved) {
            if (value) node.style.setProperty(name, value, priority);
            else node.style.removeProperty(name);
        }
    }

    function setStyle(node, name, value) {
        if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value, "important");
    }

    function updateControls() {
        if (!state) return;
        const { toggle, panel, reset, range, value } = state;
        if (toggle) {
            if (toggle.hidden !== (mode === "always")) toggle.hidden = mode === "always";
            const label = state.manual ? "확대 모드 끄기" : "확대 모드 켜기";
            if (toggle.getAttribute("aria-label") !== label) toggle.setAttribute("aria-label", label);
            if (toggle.getAttribute("aria-pressed") !== String(state.manual))
                toggle.setAttribute("aria-pressed", String(state.manual));
            syncPlayerButtonTooltip(toggle, label);
        }
        if (panel) {
            const interacting = state.panelPointer != null || panel.contains(document.activeElement);
            const visible = active() && (state.scale > 1 || state.manual || (!panel.hidden && interacting));
            const hidden = !visible;
            if (panel.hidden !== hidden) panel.hidden = hidden;
            const percent = Math.round(state.scale * 100);
            const text = `${percent}%`;
            if (value.textContent !== text) value.textContent = text;
            if (range.value !== String(percent)) range.value = String(percent);
            if (range.getAttribute("aria-valuetext") !== text) range.setAttribute("aria-valuetext", text);
            const progress = `${(percent - 100) / 4}%`;
            if (range.style.getPropertyValue("--bcz-progress") !== progress)
                range.style.setProperty("--bcz-progress", progress);
            if (reset.disabled !== (state.scale === 1)) reset.disabled = state.scale === 1;
        }
    }

    function resetZoom() {
        endDrag();
        if (!state) return;
        if (state.saved) restoreStyles(state.video, state.saved);
        setVideoViewportTransform(state.video, null);
        state.saved = null;
        state.scale = 1;
        state.x = 0;
        state.y = 0;
        state.width = 0;
        state.height = 0;
        state.video.removeAttribute("data-bcz-zoomed");
        state.player.removeAttribute("data-bcz-pannable");
        updateControls();
    }

    // Share the visible viewport with control placement, including scrolling and player resizing.
    function bounds() {
        const { left, top, width, height } = getVideoViewportRect(state.video);
        if (!(width > 0 && height > 0)) return null;
        if (state.width && (width !== state.width || height !== state.height)) {
            state.x *= width / state.width;
            state.y *= height / state.height;
        }
        state.width = width;
        state.height = height;
        return { left, top, width, height };
    }

    function limitPan() {
        const { video, width, height, scale } = state;
        let contentWidth = width;
        let contentHeight = height;
        if (video.videoWidth > 0 && video.videoHeight > 0 && getComputedStyle(video).objectFit === "contain") {
            const fit = Math.min(width / video.videoWidth, height / video.videoHeight);
            contentWidth = video.videoWidth * fit;
            contentHeight = video.videoHeight * fit;
        }
        const limit = (offset, size, content) => {
            const margin = (size - content) / 2;
            return content * scale <= size
                ? (size - size * scale) / 2
                : clamp(offset, size - (margin + content) * scale, -margin * scale);
        };
        state.x = limit(state.x, width, contentWidth);
        state.y = limit(state.y, height, contentHeight);
    }

    function render() {
        if (!current()) return unmount();
        if (state.scale === 1) return resetZoom();
        limitPan();
        const { video, x, y, width, height, scale } = state;
        if (!state.saved) state.saved = saveStyles(video, VIDEO_STYLES);
        setStyle(video, "transform-origin", "0px 0px");
        setStyle(video, "transform", `translate(${x}px, ${y}px) scale(${scale})`);
        // Clip the transformed video itself, so native menus and control overlays stay untouched.
        const top = Math.max(0, -y / scale);
        const left = Math.max(0, -x / scale);
        const bottom = Math.max(0, height - (height - y) / scale);
        const right = Math.max(0, width - (width - x) / scale);
        setStyle(video, "clip-path", `inset(${top}px ${right}px ${bottom}px ${left}px)`);
        setStyle(video, "transition", "none");
        setStyle(video, "will-change", "transform");
        setVideoViewportTransform(video, { scale, x, y });
        if (!video.hasAttribute("data-bcz-zoomed")) video.setAttribute("data-bcz-zoomed", "");
        if (!state.player.hasAttribute("data-bcz-pannable")) state.player.setAttribute("data-bcz-pannable", "");
        updateControls();
    }

    function surface(event) {
        if (!current() || !active() || event.defaultPrevented) return null;
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
        const target = event.composedPath()[0] || event.target;
        if (!(target instanceof Element) || !state.player.contains(target) || target.closest(EXCLUDED)) return null;
        // Native wrappers can receive the pointer instead of the video they contain.
        if (target !== state.video && !target.contains(state.video)) return null;
        const box = bounds();
        if (
            !box ||
            event.clientX < box.left ||
            event.clientX > box.left + box.width ||
            event.clientY < box.top ||
            event.clientY > box.top + box.height
        )
            return null;
        return box;
    }

    function onWheel(event) {
        if (!Number.isFinite(event.deltaY) || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
        const box = surface(event);
        if (!box) return;
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1;
        const delta = clamp(event.deltaY * unit, -240, 240);
        const next = clamp(state.scale * Math.exp((-delta * Math.log(1.2)) / 100), 1, 5);
        event.preventDefault();
        event.stopImmediatePropagation();
        if (next === 1 && state.scale === 1) return;
        zoomAt(next, event.clientX - box.left, event.clientY - box.top);
    }

    function zoomAt(next, x, y) {
        endDrag();
        const ratio = next / state.scale;
        state.x = x - (x - state.x) * ratio;
        state.y = y - (y - state.y) * ratio;
        state.scale = next < 1.000001 ? 1 : next;
        render();
    }

    function onPointerDown(event) {
        suppressClick = false;
        if (event.button !== 0 || event.isPrimary === false || state?.scale === 1 || !surface(event)) return;
        // Reserve an enlarged main video for panning before multiview's ancestor handler sees it.
        event.stopImmediatePropagation();
        dragging = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            startX: state.x,
            startY: state.y,
            moved: false,
        };
        window.addEventListener("pointermove", onPointerMove, true);
        window.addEventListener("pointerup", onPointerUp, true);
        window.addEventListener("pointercancel", endDrag, true);
        state.player.addEventListener("lostpointercapture", endDrag);
    }

    function onPointerMove(event) {
        if (!dragging || event.pointerId !== dragging.id) return;
        if (!current() || !event.buttons) return endDrag();
        const dx = event.clientX - dragging.x;
        const dy = event.clientY - dragging.y;
        if (!dragging.moved && Math.hypot(dx, dy) < 4) return;
        if (!dragging.moved) {
            dragging.moved = true;
            state.player.setPointerCapture?.(dragging.id);
            state.player.setAttribute("data-bcz-dragging", "");
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        state.x = dragging.startX + dx;
        state.y = dragging.startY + dy;
        render();
    }

    function onPointerUp(event) {
        if (!dragging || event.pointerId !== dragging.id) return;
        if (dragging.moved) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
        endDrag();
    }

    function endDrag() {
        const previous = dragging;
        dragging = null;
        if (previous?.moved) suppressClick = true;
        window.removeEventListener("pointermove", onPointerMove, true);
        window.removeEventListener("pointerup", onPointerUp, true);
        window.removeEventListener("pointercancel", endDrag, true);
        state?.player.removeEventListener("lostpointercapture", endDrag);
        state?.player.removeAttribute("data-bcz-dragging");
        if (previous && state?.player.hasPointerCapture?.(previous.id)) state.player.releasePointerCapture(previous.id);
    }

    function onClick(event) {
        if (!suppressClick || event.detail === 0 || !state?.player.contains(event.target)) return;
        suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    function onToggle(event) {
        event.stopPropagation();
        if (!current() || mode !== "manual" || event.currentTarget !== state.toggle) return;
        state.manual = !state.manual;
        if (!state.manual) resetZoom();
        updateControls();
    }

    function onReset(event) {
        event.stopPropagation();
        if (current() && event.currentTarget === state.reset) resetZoom();
    }

    function onRangeInput(event) {
        event.stopPropagation();
        if (!current() || !active() || event.currentTarget !== state.range) return;
        const percent = state.range.valueAsNumber;
        if (!Number.isFinite(percent)) return;
        const box = bounds();
        if (box) zoomAt(clamp(Math.round(percent), 100, 500) / 100, box.width / 2, box.height / 2);
    }

    function stopPanelEvent(event) {
        event.stopPropagation();
    }

    function endPanelPointer(event) {
        if (event && event.pointerId !== state?.panelPointer) return;
        window.removeEventListener("pointerup", endPanelPointer, true);
        window.removeEventListener("pointercancel", endPanelPointer, true);
        if (!state) return;
        state.panelPointer = null;
        updateControls();
    }

    function onPanelPointerDown(event) {
        event.stopPropagation();
        if (!current() || event.button !== 0 || event.isPrimary === false) return;
        state.panelPointer = event.pointerId;
        // Keep the panel visible at 100% until the native range drag is released.
        window.addEventListener("pointerup", endPanelPointer, true);
        window.addEventListener("pointercancel", endPanelPointer, true);
    }

    function onPanelFocusOut() {
        const panel = state?.panel;
        queueMicrotask(() => {
            if (panel !== state?.panel || !panel || panel.contains(document.activeElement)) return;
            updateControls();
        });
    }

    function endInteractions() {
        endDrag();
        endPanelPointer();
    }

    function removePanel() {
        if (!state) return;
        endPanelPointer();
        state.range?.removeEventListener("input", onRangeInput);
        state.reset?.removeEventListener("click", onReset);
        for (const name of ["click", "dblclick", "keydown"]) state.panel?.removeEventListener(name, stopPanelEvent);
        state.panel?.removeEventListener("pointerdown", onPanelPointerDown);
        state.panel?.removeEventListener("focusout", onPanelFocusOut);
        state.panel?.remove();
        state.panel = state.range = state.value = state.reset = null;
    }

    function panelIsMounted() {
        return (
            state.panel?.parentElement === state.player &&
            [state.range, state.reset, state.value].every((node) => node && state.panel.contains(node))
        );
    }

    function mountControls() {
        const container = state.player.querySelector(CONTROLS);
        if (!container && state.toggle) {
            state.toggle.removeEventListener("click", onToggle);
            state.toggle.remove();
            state.toggle = null;
        }
        if (container && state.toggle?.parentElement !== container) {
            state.toggle?.removeEventListener("click", onToggle);
            state.toggle?.remove();
            const button = document.createElement("button");
            button.id = `${ID}-toggle`;
            button.type = "button";
            button.className = "pzp-button pzp-pc__zoom-button";
            button.innerHTML =
                '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5M7 10.5h7M10.5 7v7"/></svg>';
            button.addEventListener("click", onToggle);
            container.prepend(button);
            state.toggle = button;
        }
        if (!panelIsMounted()) {
            removePanel();
            const panel = document.createElement("div");
            panel.id = `${ID}-panel`;
            panel.hidden = true;
            panel.setAttribute("role", "group");
            panel.setAttribute("aria-label", "화면 확대");
            const value = document.createElement("span");
            value.id = `${ID}-value`;
            value.setAttribute("aria-hidden", "true");
            const button = document.createElement("button");
            button.id = `${ID}-reset`;
            button.type = "button";
            button.innerHTML =
                '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 5v5h5"/><path d="M3.5 10a6.5 6.5 0 1 1 1.9 4.6"/></svg>';
            button.title = "되돌리기";
            button.setAttribute("aria-label", "확대한 화면을 원래 크기로 되돌리기");
            button.addEventListener("click", onReset);
            const range = document.createElement("input");
            range.id = `${ID}-range`;
            range.type = "range";
            range.min = "100";
            range.max = "500";
            range.step = "1";
            range.setAttribute("aria-label", "화면 확대 배율");
            range.addEventListener("input", onRangeInput);
            for (const name of ["click", "dblclick", "keydown"]) panel.addEventListener(name, stopPanelEvent);
            panel.addEventListener("pointerdown", onPanelPointerDown);
            panel.addEventListener("focusout", onPanelFocusOut);
            panel.append(value, range, button);
            state.panel = panel;
            state.range = range;
            state.value = value;
            state.reset = button;
            state.player.append(panel);
        }
        updateControls();
    }

    function onResize() {
        endDrag();
        if (current() && state.scale > 1 && bounds()) render();
    }

    function onSourceChange() {
        resetZoom();
    }

    function unmount() {
        if (!state) return;
        resetZoom();
        state.resize?.disconnect();
        state.video.removeEventListener("emptied", onSourceChange);
        state.video.removeEventListener("loadstart", onSourceChange);
        state.video.removeEventListener("loadedmetadata", onSourceChange);
        state.toggle?.removeEventListener("click", onToggle);
        state.toggle?.remove();
        removePanel();
        state = null;
        suppressClick = false;
    }

    function sync() {
        if (!enabled || suspended || !isPlaybackRoute()) return unmount();
        const video = getMainVideoElement();
        const player = video && getPlayerRoot(video);
        if (!(video instanceof HTMLVideoElement) || !video.isConnected || !player?.contains(video)) return unmount();
        if (state?.video !== video || state.player !== player) {
            unmount();
            state = { video, player, manual: false, scale: 1, x: 0, y: 0, width: 0, height: 0, saved: null };
            video.addEventListener("emptied", onSourceChange);
            video.addEventListener("loadstart", onSourceChange);
            video.addEventListener("loadedmetadata", onSourceChange);
            if (typeof ResizeObserver === "function") {
                state.resize = new ResizeObserver(onResize);
                state.resize.observe(video);
            }
        }
        mountControls();
    }

    function stopPlayback() {
        observer?.disconnectAll();
        observer = null;
        window.removeEventListener("wheel", onWheel, true);
        window.removeEventListener("pointerdown", onPointerDown, true);
        window.removeEventListener("click", onClick, true);
        window.removeEventListener("blur", endInteractions);
        window.removeEventListener("resize", onResize);
        document.removeEventListener("fullscreenchange", onResize);
        document.removeEventListener("visibilitychange", endInteractions);
        unmount();
        document.getElementById(`${ID}-style`)?.remove();
    }

    function routeChanged() {
        stopPlayback();
        if (!enabled || suspended || !isPlaybackRoute()) return;
        injectStyleOnce(
            `${ID}-style`,
            `
#${ID}-toggle { position:relative; display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; padding:6px; border:0; background:transparent; color:inherit; cursor:pointer; flex-shrink:0; }
#${ID}-toggle[aria-pressed="true"] { color:var(--Content-brand-strong,#00ffa3); }
.pzp-pc:not(.pzp-pc--controls) #${ID}-toggle:not(:focus-visible) { opacity:0; pointer-events:none; }
#${ID}-panel { --bcz-fill:var(--Content-neutral-strong,#40444b); --bcz-track:var(--Border-neutral-weak,#d7d9de); position:absolute; right:16px; bottom:64px; z-index:50; display:flex; align-items:center; gap:6px; box-sizing:border-box; width:180px; max-width:calc(100% - 32px); padding:4px 6px; border:1px solid var(--Border-neutral-weak,#dadde3); border-radius:8px; background:var(--Surface-neutral-base,#fff); color:var(--Content-neutral-strong,#20242c); font:500 12px/1.5 sans-serif; cursor:default; user-select:none; transform:none; transition:none; }
html.theme_dark #${ID}-panel { --bcz-fill:var(--Content-neutral-strong,#e7e9ed); --bcz-track:var(--Border-neutral-weak,#555961); background:var(--Surface-neutral-base,#202124); color:var(--Content-neutral-strong,#f1f3f5); border-color:var(--Border-neutral-weak,#454850); }
#${ID}-value { flex:0 0 4.5ch; text-align:right; font-weight:600; font-variant-numeric:tabular-nums; white-space:nowrap; }
#${ID}-reset { display:flex; align-items:center; justify-content:center; flex:0 0 24px; box-sizing:border-box; width:24px; height:24px; padding:4px; border:0; border-radius:4px; background:transparent; color:inherit; font:inherit; cursor:pointer; transition:scale 120ms ease-out; }
#${ID}-reset svg { display:block; flex:none; }
#${ID}-reset:hover:not(:disabled) { background:rgba(0,0,0,.06); }
html.theme_dark #${ID}-reset:hover:not(:disabled) { background:rgba(255,255,255,.08); }
#${ID}-reset:active:not(:disabled) { scale:0.96; }
#${ID}-reset:disabled { opacity:.4; cursor:default; }
#${ID}-range { appearance:none; -webkit-appearance:none; display:block; flex:1 1 0%; box-sizing:border-box; width:0; min-width:0; height:24px; margin:0; padding:0; border:0; border-radius:4px; background:transparent; color:inherit; cursor:pointer; }
#${ID}-range::-webkit-slider-runnable-track { height:2px; border-radius:1px; background:linear-gradient(to right,var(--bcz-fill) var(--bcz-progress,0%),var(--bcz-track) var(--bcz-progress,0%)); }
#${ID}-range::-webkit-slider-thumb { appearance:none; -webkit-appearance:none; width:10px; height:10px; margin-top:-4px; border:0; border-radius:50%; background:var(--bcz-fill); }
#${ID}-toggle:focus-visible, #${ID}-reset:focus-visible, #${ID}-range:focus-visible { outline:2px solid var(--Content-brand-strong,#00d694); outline-offset:2px; }
#${ID}-toggle[hidden], #${ID}-panel[hidden] { display:none; }
@media(prefers-reduced-motion:reduce) { #${ID}-reset { transition:none; } #${ID}-reset:active:not(:disabled) { scale:1; } }
[data-bcz-pannable], [data-bcz-pannable] .pzp-pc__video, video[data-bcz-zoomed] { cursor:grab; }
[data-bcz-dragging], [data-bcz-dragging] .pzp-pc__video, [data-bcz-dragging] video { cursor:grabbing; user-select:none; }
`
        );
        window.addEventListener("wheel", onWheel, { capture: true, passive: false });
        window.addEventListener("pointerdown", onPointerDown, true);
        window.addEventListener("click", onClick, true);
        window.addEventListener("blur", endInteractions);
        window.addEventListener("resize", onResize);
        document.addEventListener("fullscreenchange", onResize);
        document.addEventListener("visibilitychange", endInteractions);
        observer = createMutationObserverSync({
            onBodyReady: sync,
            onMutations(mutations) {
                if (
                    state &&
                    (!state.video.isConnected ||
                        !state.player.isConnected ||
                        (state.toggle && !state.toggle.isConnected) ||
                        !panelIsMounted())
                ) {
                    sync();
                } else if (mutations.some((mutation) => mutationMatchesSelector(mutation, `video, ${CONTROLS}`))) {
                    sync();
                }
            },
        });
        sync();
    }

    function pageHide() {
        suspended = true;
        stopPlayback();
    }

    function pageShow() {
        suspended = false;
        routeChanged();
    }

    bindFeatureOptions((options) => {
        const nextEnabled = options.playerZoomEnabled === true;
        const nextMode = options.playerZoomMode === "always" ? "always" : "manual";
        if (mode !== nextMode) {
            resetZoom();
            if (state) state.manual = false;
            mode = nextMode;
            updateControls();
        }
        if (enabled === nextEnabled) return;
        enabled = nextEnabled;
        if (enabled) {
            removeRoute = startPageChangeDetection(routeChanged);
            window.addEventListener("pagehide", pageHide);
            window.addEventListener("pageshow", pageShow);
            routeChanged();
        } else {
            stopPlayback();
            suspended = false;
            removeRoute?.();
            removeRoute = null;
            window.removeEventListener("pagehide", pageHide);
            window.removeEventListener("pageshow", pageShow);
        }
    });
})();
