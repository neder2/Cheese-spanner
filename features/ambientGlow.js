/** Ambient glow around the main live/VOD player (isolated world).
 * The main video is drawn into a tiny extension-owned canvas and shown blurred outside the
 * player box, so its light spills over the adjacent chat, sidebar and header edges. Pixels are never
 * read back, so cross-origin media cannot fail the effect, and native nodes are never restyled.
 * Live multiview shrinks the native player into a tile beside secondary videos, so the effect
 * stays off while its host is active instead of glowing over the other tiles.
 * Layout basis: docs/measurements/panel-resize-2026-09-28.md (#sidebar, #aside-chatting,
 * #vod-aside and the header beside the player). Since 2026-10-08 the header is not clipped on
 * request. Stacking above the sidebar was seen in Chrome; above the header it follows the public
 * CSS z-index and still needs a Chrome check.
 * While the option is on, the player's gear menu gets an "앰비언트" row: its switch turns the glow
 * on/off and clicking the label reveals the strength slider underneath (collapsed by default).
 * The switch is a profile-local choice that survives reloads and other tabs; the slider edits the
 * synced ambientIntensity option itself, like the skip-seconds control does for skipSeconds.
 */
(() => {
    "use strict";
    const root = window.BetterChzzk;
    if (root.ambientGlow) return;
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        createThrottledDomSync,
        getMainVideoElement,
        getPlayerRoot,
        injectStyleOnce,
        isPlaybackRoute,
        onReady,
        startPageChangeDetection,
        storageGet,
        storageSet,
    } = root.utils;
    const STYLE_ID = "betterchzzk-ambient-style";
    const LAYER_ID = "betterchzzk-ambient";
    const ROW_ID = "betterchzzk-ambient-row";
    const EXPAND_ID = "betterchzzk-ambient-expand";
    const TOGGLE_ID = "betterchzzk-ambient-toggle";
    const STRENGTH_ID = "betterchzzk-ambient-strength";
    const READY = "data-bcam-ready";
    // Same native home menu that stream info extends (docs/measurements/stream-info-settings-2026-09-15.md).
    const SETTINGS_MENU = ':scope > .pzp-pc__settings[role="menu"]';
    const STATE_KEY = "betterChzzkAmbientPlayerOff";
    const PERSIST_DELAY_MS = 250;
    const CANVAS_WIDTH = 48;
    const CANVAS_HEIGHT = 27;
    const DRAW_INTERVAL_MS = 100;
    // Each draw keeps part of the previous one so scene cuts fade instead of flashing.
    const FRAME_BLEND = 0.35;
    // 2026-10-08: the measured 60-90px reach into chat/sidebar was doubled on request.
    const BLUR_PX = 96;
    const SPREAD_PX = BLUR_PX * 3;
    const CANVAS_INSET_PX = BLUR_PX / 2;
    const PANEL_SELECTOR = "#sidebar, #aside-chatting, #vod-aside, #betterchzzk-vod-comment-aside";
    const TARGET_SELECTOR = "video, [class*='pzp']";
    const PLAYER_TARGET_SELECTOR = "video, .pzp-pc__settings";
    const MULTIVIEW_ATTR = "data-bcmv-host";
    const MULTIVIEW_SELECTOR = `[${MULTIVIEW_ATTR}="active"]`;
    const SLIDER_KEYS = new Set([
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "PageUp",
        "PageDown",
    ]);
    const HAVE_CURRENT_DATA = 2;

    let options = {};
    let ready = false,
        active = false,
        hidden = false,
        disposed = false;
    let userOff = false,
        expanded = false,
        stateLoaded = false,
        stateRevision = 0;
    let intensityOverride = null,
        persistTimer = 0,
        persistRevision = 0;
    let layer = null,
        canvas = null,
        context = null,
        video = null,
        player = null;
    let menu = null,
        menuRow = null,
        expandButton = null,
        switchButton = null,
        strengthRow = null,
        strengthInput = null,
        strengthValue = null;
    let hasFrame = false,
        drawnAt = -Infinity,
        frameRequest = 0,
        frameVideo = null,
        drawTimer = 0,
        layoutFrame = 0,
        layoutKey = "";
    let discovery = null,
        resizeObserver = null,
        routeCleanup = null;
    const schedule = createThrottledDomSync(sync, 160);

    function enabled() {
        return options.ambientEnabled === true;
    }

    function glowWanted() {
        return active && stateLoaded && !userOff;
    }

    function styles() {
        // The header container is z-index:10000 and the sidebar 9999 (public CHZZK CSS, 2026-10-08).
        // Matching the header's value and being appended last paints the glow above both, while
        // native dimmed layers, modals and the mini player (20000+) stay above the glow.
        injectStyleOnce(
            STYLE_ID,
            `
#${LAYER_ID}{position:fixed;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;z-index:10000;
  pointer-events:none;opacity:0;mix-blend-mode:multiply;contain:strict;transition:opacity .6s ease}
#${LAYER_ID}[hidden]{display:none!important}
#${LAYER_ID}[${READY}="1"]{opacity:calc(var(--bcam-strength,.6) * .55)}
html.theme_dark #${LAYER_ID}{mix-blend-mode:screen}
html.theme_dark #${LAYER_ID}[${READY}="1"]{opacity:var(--bcam-strength,.6)}
#${LAYER_ID} > canvas{position:absolute;display:block;filter:blur(${BLUR_PX}px) saturate(1.4) brightness(1.25)}
html.theme_dark #${LAYER_ID} > canvas{filter:blur(${BLUR_PX}px) saturate(1.5)}
@media (prefers-reduced-motion:reduce){#${LAYER_ID}{transition:none}}
.pzp-ui-setting-home-item:where(#${ROW_ID},#${STRENGTH_ID}){display:block;width:100%;border:0;background:transparent;text-align:start}
:is(#${ROW_ID},#${STRENGTH_ID})[hidden]{display:none!important}
#${ROW_ID} .pzp-ui-setting-home-item__left{flex:1 1 auto;min-width:0}
:is(#${EXPAND_ID},#${TOGGLE_ID}){display:flex;align-items:center;height:100%;margin:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:start;cursor:pointer}
#${EXPAND_ID}{flex:1 1 auto;min-width:0}
#${EXPAND_ID}::after{content:"";flex:none;width:6px;height:6px;margin:0 0 3px 8px;border-right:1.5px solid #fff9;border-bottom:1.5px solid #fff9;transform:rotate(45deg);transition:transform .15s ease,margin .15s ease}
#${EXPAND_ID}[aria-expanded="true"]::after{margin:3px 0 0 8px;transform:rotate(-135deg)}
@media (prefers-reduced-motion:reduce){#${EXPAND_ID}::after{transition:none}}
/* Buttons center text by default, which pushed the native track (no left) off its handle. */
#${TOGGLE_ID} .pzp-ui-toggle__handle:before{left:0}
#${TOGGLE_ID}[aria-checked="true"] .pzp-ui-toggle__handle:before{background-color:#00f889}
#${TOGGLE_ID}[aria-checked="true"] .pzp-ui-toggle__handle:after{left:13px}
:is(#${EXPAND_ID},#${TOGGLE_ID},#${STRENGTH_ID} input):focus-visible{outline:2px solid #00d694;outline-offset:2px}
#${STRENGTH_ID}{cursor:default}
#${STRENGTH_ID} input{width:96px;margin:0 8px 0 0;accent-color:#00f889;cursor:pointer}
#${STRENGTH_ID} .pzp-ui-setting-home-item__value{min-width:4ch;text-align:end;font-variant-numeric:tabular-nums}
`
        );
    }

    function clampIntensity(value) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.min(100, Math.max(10, Math.round(number))) : 60;
    }

    function intensity() {
        return clampIntensity(intensityOverride ?? options.ambientIntensity);
    }

    function strength() {
        return (intensity() / 100).toFixed(2);
    }

    function renderStrength() {
        layer?.style.setProperty("--bcam-strength", strength());
        if (!strengthInput) return;
        const value = String(intensity());
        if (strengthInput.value !== value) strengthInput.value = value;
        const text = `${value}%`;
        strengthInput.setAttribute("aria-valuetext", text);
        if (strengthValue.textContent !== text) strengthValue.textContent = text;
    }

    function mountLayer() {
        if (layer?.isConnected) return true;
        if (!document.body) return false;
        if (!layer) {
            layer = document.createElement("div");
            layer.id = LAYER_ID;
            layer.setAttribute("aria-hidden", "true");
            layer.hidden = true;
            canvas = document.createElement("canvas");
            canvas.width = CANVAS_WIDTH;
            canvas.height = CANVAS_HEIGHT;
            layer.append(canvas);
            try {
                context = canvas.getContext("2d", { alpha: true });
            } catch {
                context = null;
            }
        }
        layer.style.setProperty("--bcam-strength", strength());
        document.body.append(layer);
        return true;
    }

    function clearFrame() {
        hasFrame = false;
        drawnAt = -Infinity;
        context?.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        layer?.removeAttribute(READY);
    }

    function cancelDraw() {
        if (frameRequest) {
            try {
                frameVideo?.cancelVideoFrameCallback?.(frameRequest);
            } catch {
                /* The element may already be detached. */
            }
        }
        frameRequest = 0;
        frameVideo = null;
        if (drawTimer) window.clearTimeout(drawTimer);
        drawTimer = 0;
    }

    function shown() {
        return Boolean(layer?.isConnected && !layer.hidden);
    }

    function draw() {
        if (!context || !shown() || video.readyState < HAVE_CURRENT_DATA) return;
        try {
            context.globalAlpha = hasFrame ? FRAME_BLEND : 1;
            context.drawImage(video, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        } catch {
            return;
        }
        drawnAt = performance.now();
        if (!hasFrame) {
            hasFrame = true;
            layer.setAttribute(READY, "1");
        }
    }

    function onVideoFrame() {
        frameRequest = 0;
        frameVideo = null;
        if (!active || !video) return;
        if (performance.now() - drawnAt >= DRAW_INTERVAL_MS) draw();
        scheduleDraw();
    }

    function onDrawTimer() {
        drawTimer = 0;
        if (!active || !video || video.paused) return;
        draw();
        scheduleDraw();
    }

    function scheduleDraw() {
        if (!active || !video || !context || !shown() || document.hidden || frameRequest || drawTimer) return;
        if (typeof video.requestVideoFrameCallback === "function") {
            // Frame callbacks stop on their own while the video is paused or the tab is hidden.
            frameVideo = video;
            frameRequest = video.requestVideoFrameCallback(onVideoFrame);
        } else if (!video.paused) drawTimer = window.setTimeout(onDrawTimer, DRAW_INTERVAL_MS);
    }

    function onMediaFrameChange() {
        draw();
        scheduleDraw();
    }

    function onMediaEmptied() {
        clearFrame();
    }

    function bindVideo(next) {
        if (video === next) return;
        cancelDraw();
        if (video) {
            video.removeEventListener("loadeddata", onMediaFrameChange);
            video.removeEventListener("seeked", onMediaFrameChange);
            video.removeEventListener("play", scheduleDraw);
            video.removeEventListener("emptied", onMediaEmptied);
        }
        video = next;
        clearFrame();
        if (!video) return;
        video.addEventListener("loadeddata", onMediaFrameChange);
        video.addEventListener("seeked", onMediaFrameChange);
        video.addEventListener("play", scheduleDraw);
        video.addEventListener("emptied", onMediaEmptied);
    }

    function bindPlayer(next) {
        if (player === next) return;
        resizeObserver?.disconnect();
        player = next;
        if (player) resizeObserver?.observe(player);
    }

    function hideLayer() {
        cancelDraw();
        layoutKey = "";
        if (layer && !layer.hidden) layer.hidden = true;
    }

    function updateLayout() {
        if (!glowWanted() || !layer || !video || !player) return hideLayer();
        const rect = player.getBoundingClientRect();
        const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
        const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
        if (
            !context ||
            document.fullscreenElement ||
            player.closest(MULTIVIEW_SELECTOR) ||
            rect.width <= 0 ||
            rect.height <= 0 ||
            rect.bottom + SPREAD_PX <= 0 ||
            rect.top - SPREAD_PX >= viewportHeight ||
            rect.right + SPREAD_PX <= 0 ||
            rect.left - SPREAD_PX >= viewportWidth
        )
            return hideLayer();
        const box = {
            left: Math.round(rect.left - SPREAD_PX),
            top: Math.round(rect.top - SPREAD_PX),
            width: Math.round(rect.width + SPREAD_PX * 2),
            height: Math.round(rect.height + SPREAD_PX * 2),
        };
        // The hole is the whole player box, even where a scrolled player sits under the header:
        // the header then keeps the falloff above the video instead of a full-strength band.
        const hole = {
            left: Math.round(rect.left) - box.left,
            top: Math.round(rect.top) - box.top,
            right: Math.round(rect.right) - box.left,
            bottom: Math.round(rect.bottom) - box.top,
        };
        const key = JSON.stringify([box, hole]);
        if (key !== layoutKey) {
            layoutKey = key;
            const { style } = layer;
            style.left = `${box.left}px`;
            style.top = `${box.top}px`;
            style.width = `${box.width}px`;
            style.height = `${box.height}px`;
            style.clipPath =
                `polygon(evenodd, 0px 0px, ${box.width}px 0px, ${box.width}px ${box.height}px, ` +
                `0px ${box.height}px, 0px 0px, ${hole.left}px ${hole.top}px, ${hole.right}px ${hole.top}px, ` +
                `${hole.right}px ${hole.bottom}px, ${hole.left}px ${hole.bottom}px, ${hole.left}px ${hole.top}px)`;
            canvas.style.left = `${SPREAD_PX - CANVAS_INSET_PX}px`;
            canvas.style.top = `${SPREAD_PX - CANVAS_INSET_PX}px`;
            canvas.style.width = `${Math.round(rect.width + CANVAS_INSET_PX * 2)}px`;
            canvas.style.height = `${Math.round(rect.height + CANVAS_INSET_PX * 2)}px`;
        }
        if (layer.hidden) {
            layer.hidden = false;
            draw();
        }
        scheduleDraw();
    }

    function scheduleLayout() {
        if (!active || layoutFrame) return;
        layoutFrame = requestAnimationFrame(() => {
            layoutFrame = 0;
            updateLayout();
        });
    }

    // ── Gear menu: switch + strength ──

    function persistIntensity() {
        if (persistTimer) window.clearTimeout(persistTimer);
        persistTimer = 0;
        if (intensityOverride === null) return;
        const value = intensityOverride;
        const revision = ++persistRevision;
        const area = globalThis.chrome?.storage?.sync;
        if (typeof area?.set !== "function") return;
        storageSet(area, { ambientIntensity: value }).then(
            () => {
                // A later drag keeps its own pending value; only the latest write releases it. The
                // saved value stands in until the option echo arrives, so the slider never snaps back.
                if (revision === persistRevision && intensityOverride === value) {
                    options = { ...options, ambientIntensity: value };
                    intensityOverride = null;
                    renderStrength();
                }
            },
            () => {
                /* Keep the choice in this document; a later explicit change retries the save. */
            }
        );
    }

    function setUserOff(next) {
        if (next === userOff) return;
        userOff = next;
        stateRevision++;
        const local = globalThis.chrome?.storage?.local;
        if (typeof local?.set === "function") {
            storageSet(local, { [STATE_KEY]: next }).catch(() => {
                /* The current document keeps the choice even when the profile write fails. */
            });
        }
        applyPlayerState();
    }

    function applyPlayerState() {
        renderMenu();
        if (active) sync();
    }

    function validMenuRow(row) {
        return (
            active &&
            stateLoaded &&
            row?.isConnected &&
            player?.isConnected &&
            row.parentElement === player.querySelector(SETTINGS_MENU)
        );
    }

    function setExpanded(next) {
        if (next === expanded) return;
        expanded = next;
        renderMenu();
    }

    function onRowClick(event) {
        event.stopPropagation();
        if (event.currentTarget !== menuRow || !validMenuRow(menuRow)) return;
        // The switch owns on/off; anywhere else on the row opens or closes the strength slider.
        if (switchButton.contains(event.target)) setUserOff(!userOff);
        else setExpanded(!expanded);
    }

    function onRowButtonKeyDown(event) {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) event.currentTarget.click();
            return;
        }
        // Left and right move between the label and the switch of the same row.
        const next =
            event.key === "ArrowRight" && event.currentTarget === expandButton
                ? switchButton
                : event.key === "ArrowLeft" && event.currentTarget === switchButton
                  ? expandButton
                  : null;
        if (!next) return;
        event.preventDefault();
        event.stopPropagation();
        next.focus();
    }

    function onStrengthInput(event) {
        event.stopPropagation();
        if (event.currentTarget !== strengthInput || !validMenuRow(strengthRow)) return;
        intensityOverride = clampIntensity(strengthInput.value);
        renderStrength();
        if (persistTimer) window.clearTimeout(persistTimer);
        persistTimer = window.setTimeout(persistIntensity, PERSIST_DELAY_MS);
    }

    function onStrengthChange(event) {
        event.stopPropagation();
        persistIntensity();
    }

    function stopInside(event) {
        // The rows live inside the player; clicks, drags and wheels must not reach player controls.
        event.stopPropagation();
    }

    function onStrengthKeyDown(event) {
        // Keys the slider consumes must not also move menu focus or seek the video.
        if (SLIDER_KEYS.has(event.key)) event.stopPropagation();
    }

    function onMenuNavigation(event) {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || !menuRow?.isConnected) return;
        const current = menuRow.contains(event.target) && event.target !== menuRow ? menuRow : event.target;
        if (current.parentElement !== menu) return;
        const rows = Array.from(menu.children).filter(
            (row) =>
                (row === menuRow || ["menuitem", "menuitemcheckbox"].includes(row.getAttribute("role"))) &&
                row.getClientRects().length &&
                getComputedStyle(row).visibility !== "hidden"
        );
        const index = rows.indexOf(current);
        if (index < 0) return;
        const next =
            event.key === "Home"
                ? rows[0]
                : event.key === "End"
                  ? rows[rows.length - 1]
                  : rows[(index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length];
        // The native keyboard list excludes injected rows; bridge only moves into or out of ours.
        if (current !== menuRow && next !== menuRow) return;
        event.preventDefault();
        event.stopPropagation();
        (next === menuRow ? expandButton : next).focus();
    }

    function createRowShell(element, id) {
        element.id = id;
        element.className = "pzp-ui-setting-home-item";
        const top = document.createElement("span");
        top.className = "pzp-ui-setting-home-item__top";
        const left = document.createElement("span");
        left.className = "pzp-ui-setting-home-item__left";
        const right = document.createElement("span");
        right.className = "pzp-ui-setting-home-item__right";
        top.append(left, right);
        element.append(top);
        return { left, right };
    }

    function buildMenu(container) {
        menu = container;
        menuRow = document.createElement("div");
        // The two buttons are the menu items; the row itself only lays them out.
        menuRow.setAttribute("role", "none");
        const rowParts = createRowShell(menuRow, ROW_ID);
        expandButton = document.createElement("button");
        expandButton.id = EXPAND_ID;
        expandButton.type = "button";
        expandButton.setAttribute("role", "menuitem");
        expandButton.setAttribute("aria-controls", STRENGTH_ID);
        const label = document.createElement("span");
        label.className = "pzp-ui-setting-home-item__label";
        label.textContent = "앰비언트";
        expandButton.append(label);
        rowParts.left.append(expandButton);
        switchButton = document.createElement("button");
        switchButton.id = TOGGLE_ID;
        switchButton.type = "button";
        switchButton.setAttribute("role", "menuitemcheckbox");
        switchButton.setAttribute("aria-label", "앰비언트 켜기");
        const toggle = document.createElement("span");
        toggle.className = "pzp-ui-toggle";
        toggle.setAttribute("aria-hidden", "true");
        const handle = document.createElement("span");
        handle.className = "pzp-ui-toggle__handle";
        toggle.append(handle);
        switchButton.append(toggle);
        rowParts.right.append(switchButton);
        menuRow.addEventListener("click", onRowClick);
        expandButton.addEventListener("keydown", onRowButtonKeyDown);
        switchButton.addEventListener("keydown", onRowButtonKeyDown);

        strengthRow = document.createElement("div");
        strengthRow.setAttribute("role", "group");
        strengthRow.setAttribute("aria-label", "앰비언트 세기");
        const strengthParts = createRowShell(strengthRow, STRENGTH_ID);
        const strengthLabel = document.createElement("label");
        strengthLabel.className = "pzp-ui-setting-home-item__label";
        strengthLabel.htmlFor = `${STRENGTH_ID}-input`;
        strengthLabel.textContent = "세기";
        strengthParts.left.append(strengthLabel);
        strengthInput = document.createElement("input");
        strengthInput.id = `${STRENGTH_ID}-input`;
        strengthInput.type = "range";
        strengthInput.min = "10";
        strengthInput.max = "100";
        strengthInput.step = "5";
        strengthValue = document.createElement("span");
        strengthValue.className = "pzp-ui-setting-home-item__value";
        strengthValue.setAttribute("aria-hidden", "true");
        strengthParts.right.append(strengthInput, strengthValue);
        strengthInput.addEventListener("input", onStrengthInput);
        strengthInput.addEventListener("change", onStrengthChange);
        strengthInput.addEventListener("keydown", onStrengthKeyDown);
        for (const type of ["click", "pointerdown", "mousedown", "dblclick", "wheel"]) {
            menuRow.addEventListener(type, stopInside);
            strengthRow.addEventListener(type, stopInside);
        }
        menu.addEventListener("keydown", onMenuNavigation, true);
        container.append(menuRow, strengthRow);
        renderMenu();
    }

    function removeMenu() {
        menu?.removeEventListener("keydown", onMenuNavigation, true);
        menu = null;
        menuRow?.remove();
        strengthRow?.remove();
        menuRow = expandButton = switchButton = strengthRow = strengthInput = strengthValue = null;
    }

    function renderMenu() {
        if (!menuRow) return;
        const checked = String(!userOff);
        if (switchButton.getAttribute("aria-checked") !== checked) switchButton.setAttribute("aria-checked", checked);
        const open = String(expanded);
        if (expandButton.getAttribute("aria-expanded") !== open) expandButton.setAttribute("aria-expanded", open);
        strengthRow.hidden = !expanded;
        renderStrength();
    }

    function syncMenu() {
        const container = active && stateLoaded && player ? player.querySelector(SETTINGS_MENU) : null;
        if (menuRow && menu === container && menuRow.parentElement === container) {
            // Keep the slider directly under its row even if native rows were inserted between them.
            if (menuRow.nextElementSibling !== strengthRow) menuRow.after(strengthRow);
            return;
        }
        removeMenu();
        if (container) buildMenu(container);
    }

    function onStorageChanged(changes, areaName) {
        if (areaName !== "local" || !Object.hasOwn(changes, STATE_KEY)) return;
        const next = changes[STATE_KEY]?.newValue === true;
        stateRevision++;
        if (next === userOff) return;
        userOff = next;
        applyPlayerState();
    }

    async function loadPlayerState() {
        const revision = ++stateRevision;
        let next = userOff;
        try {
            const local = globalThis.chrome?.storage?.local;
            if (typeof local?.get === "function") next = (await storageGet(local, [STATE_KEY]))[STATE_KEY] === true;
        } catch {
            /* An unreadable choice falls back to the current state; it is never written back. */
        }
        // A switch flip or another tab's change after this read started wins over the read.
        if (revision === stateRevision) userOff = next;
        stateLoaded = true;
        applyPlayerState();
    }

    // ── Lifecycle ──

    function sync() {
        if (!active) return;
        let nextVideo = null,
            nextPlayer = null;
        if (isPlaybackRoute()) {
            const candidate = getMainVideoElement();
            const candidatePlayer = candidate ? getPlayerRoot(candidate) : null;
            if (candidatePlayer?.contains(candidate)) {
                nextVideo = candidate;
                nextPlayer = candidatePlayer;
            }
        }
        bindPlayer(nextPlayer);
        bindVideo(glowWanted() ? nextVideo : null);
        syncMenu();
        if (video && !mountLayer()) return;
        updateLayout();
    }

    function onRouteChange() {
        // Never carry the previous broadcast's colours onto the next page.
        clearFrame();
        schedule();
    }

    function onScroll(event) {
        // Chat and sidebar lists scroll constantly without moving the player.
        if (event.target instanceof Element && event.target.closest(PANEL_SELECTOR)) return;
        scheduleLayout();
    }

    function onVisibilityChange() {
        if (document.hidden) cancelDraw();
        else scheduleLayout();
    }

    function relevantMutations(rows) {
        return rows.some((row) => {
            if (row.type === "attributes") return row.attributeName === MULTIVIEW_ATTR;
            if (row.target instanceof Element && row.target.closest(PANEL_SELECTOR)) return false;
            // Control churn inside the current player matters only for video or settings menu swaps.
            const selector = player?.contains(row.target) ? PLAYER_TARGET_SELECTOR : TARGET_SELECTOR;
            return [...row.addedNodes, ...row.removedNodes].some(
                (node) =>
                    node instanceof Element &&
                    node !== menuRow &&
                    node !== strengthRow &&
                    (node.matches(selector) || !!node.querySelector(selector))
            );
        });
    }

    function start() {
        if (!ready || !enabled() || active || hidden || disposed) return;
        active = true;
        styles();
        resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleLayout) : null;
        discovery = createMutationObserverSync({
            target: () => document.body,
            options: { childList: true, subtree: true, attributes: true, attributeFilter: [MULTIVIEW_ATTR] },
            shouldSchedule: relevantMutations,
            schedule,
        });
        routeCleanup = startPageChangeDetection(onRouteChange);
        window.addEventListener("resize", scheduleLayout);
        document.addEventListener("scroll", onScroll, { capture: true, passive: true });
        document.addEventListener("fullscreenchange", scheduleLayout);
        document.addEventListener("visibilitychange", onVisibilityChange);
        globalThis.chrome?.storage?.onChanged?.addListener(onStorageChanged);
        stateLoaded = false;
        sync();
        void loadPlayerState();
    }

    function stopUI() {
        if (!active) return;
        // Keep a strength the user just chose even when the feature or page goes away mid-debounce.
        if (persistTimer) persistIntensity();
        active = false;
        schedule.cancel();
        if (layoutFrame) cancelAnimationFrame(layoutFrame);
        layoutFrame = 0;
        discovery?.disconnectAll();
        discovery = null;
        routeCleanup?.();
        routeCleanup = null;
        window.removeEventListener("resize", scheduleLayout);
        document.removeEventListener("scroll", onScroll, { capture: true });
        document.removeEventListener("fullscreenchange", scheduleLayout);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        globalThis.chrome?.storage?.onChanged?.removeListener(onStorageChanged);
        stateRevision++;
        removeMenu();
        bindVideo(null);
        bindPlayer(null);
        resizeObserver = null;
        layoutKey = "";
        layer?.remove();
        layer = null;
        canvas = null;
        context = null;
        document.getElementById(STYLE_ID)?.remove();
    }

    root.ambientGlow = {
        stop() {
            disposed = true;
            stopUI();
        },
    };
    window.addEventListener("pagehide", () => {
        hidden = true;
        stopUI();
    });
    window.addEventListener("pageshow", () => {
        hidden = false;
        start();
    });
    bindFeatureOptions((next) => {
        if (disposed) return;
        options = next;
        if (!enabled()) stopUI();
        else if (active) renderStrength();
        else start();
    });
    onReady(() => {
        ready = true;
        start();
    });
})();
