/**
 * Isolated mouse resizing, chat height and panel side placement. Sizes are profile-local choices read once per
 * document; sides come from synced options. Native nodes keep their parents: only extension markers, CSS order,
 * left/right anchoring and the body padding side change.
 */
(() => {
    "use strict";
    const root = window.CheeseSpanner;
    if (root.panelResize) return;
    const model = root.panelResizeModel;
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        createThrottledDomSync,
        injectStyleOnce,
        onReady,
        settingsStoreSet,
        startPageChangeDetection,
        storageGet,
    } = root.utils;
    const STYLE_ID = "cheese-spanner-panel-resize-style";
    const PLACEMENT_STYLE_ID = "cheese-spanner-panel-placement-style";
    const VARIABLE = "--bcpr-width";
    const HEIGHT_VARIABLE = "--bcpr-height";
    const SIDE_SPACE_VARIABLE = "--bcpr-sidebar-space";
    const COMPANION_WIDTH_VARIABLE = "--bcpr-companion-width";
    const WIDTH = "data-bcpr-width";
    const HEIGHT = "data-bcpr-height";
    const SPACE = "data-bcpr-sidebar-space";
    const SIDE = "data-bcpr-side";
    const BODY_SIDE = "data-bcpr-sidebar-side";
    const HANDLE = "data-bcpr-handle";
    const EDGE = "data-bcpr-edge";
    const CHAT_ASIDES = ":is(#aside-chatting, #vod-aside, #cheese-spanner-vod-comment-aside)";
    const NATIVE_SIDE = Object.freeze({ sidebar: "left", chat: "right" });
    const TARGETS =
        '#sidebar, #layout-body, #header, #header button[aria-controls="navigation"], #aside-chatting, #vod-aside, #cheese-spanner-vod-comment-aside';
    const COMPANIONS = '[class*="content_right"], [class*="_banner_"]';
    const panels = ["sidebar", "chat"];
    let selected = model.normalizeState(null),
        selectedHeight = null,
        storageLoaded = false,
        disposed = false;
    const saveRevision = { sidebar: 0, chat: 0, height: 0 },
        unsaved = { sidebar: false, chat: false, height: false };
    let options = {},
        optionsLoaded = false,
        ready = false,
        active = false,
        hidden = false,
        generation = 0;
    let entries = {},
        layoutBody = null,
        menu = null,
        nativeDirty = false,
        nativeBodySpace = null,
        heightHandle = null;
    let discovery = null,
        attributes = null,
        resizeObserver = null,
        routeCleanup = null;
    let resizedNodes = new Set();
    let gesture = null,
        previewFrame = 0,
        clickCleanup = null;
    let confirmedLayout = null;
    const signatures = new WeakMap();
    const schedule = createThrottledDomSync(sync, 0);

    function styles() {
        root.utils.ensureUiTheme?.();
        injectStyleOnce(
            STYLE_ID,
            `
#sidebar[${WIDTH}="sidebar"], aside[${WIDTH}="chat"] {
  box-sizing:border-box!important;width:var(${VARIABLE})!important;
  min-width:var(${VARIABLE})!important;max-width:var(${VARIABLE})!important;
}
aside[${WIDTH}="chat"] { flex-basis:var(${VARIABLE})!important; }
#layout-body[${SPACE}] { padding-left:var(${VARIABLE})!important; }
aside[${WIDTH}="chat"] .bcct-moderator-box { max-width:calc(100% - 16px); }
[${HANDLE}] {
  position:absolute;top:0;bottom:0;width:8px;padding:0;margin:0;border:0;
  z-index:3;cursor:col-resize;touch-action:none;user-select:none;
  background:transparent;outline:none;box-shadow:none;
}
[${HANDLE}="sidebar"] { right:0; }
[${HANDLE}="chat"] { left:0; }
[${HANDLE}]::after { content:"";position:absolute;top:0;bottom:0;left:0;width:2px;background:transparent; }
[${HANDLE}="sidebar"]::after { left:auto;right:0; }
#aside-chatting > [${HANDLE}="chat"]::after { left:-1px; }
[${HANDLE}]:hover::after, [${HANDLE}][data-bcpr-dragging]::after {
  background:var(--bct-brand-text);
}
${CHAT_ASIDES}[${HEIGHT}] {
  box-sizing:border-box!important;height:var(${HEIGHT_VARIABLE})!important;
  min-height:0!important;max-height:var(${HEIGHT_VARIABLE})!important;align-self:flex-start!important;
}
/* 2026-10-08 public CSS: the live chat input area is position:relative;z-index:1000 and fills the bottom of
   the chat, so the height grip must stack above it or the drag selects the input area's text instead. */
[${HANDLE}="chat-height"] { top:auto;left:0;right:0;width:auto;height:8px;cursor:row-resize;z-index:1001; }
[${HANDLE}="chat-height"]::after { top:auto;bottom:0;left:0;right:0;width:auto;height:2px; }
`
        );
        // Side placement mirrors native separators, the narrow overlay backdrop and collapsed-menu tooltips.
        // 2026-10-08 public CSS index-B5SHICxp.css: sidebar fixed left:0, overlay :before left:0/right:0/100vw,
        // item tooltip left:100%/padding-left:17px, tooltip area margin-right:-200px/padding-right:220px.
        injectStyleOnce(
            PLACEMENT_STYLE_ID,
            `
${CHAT_ASIDES}[${SIDE}="left"] { order:-1!important; }
#aside-chatting[${SIDE}="left"]::before { left:auto!important;right:-1px!important; }
/* VOD: the aside overhangs the info row by design into the empty right column (._content_right, 353px) and a
   right-anchored banner sits over the chat. A left chat takes that column and banner along so nothing covers
   the title. */
[class*="content_right"][${SIDE}="left"] {
  order:-1!important;width:var(${COMPANION_WIDTH_VARIABLE},353px)!important;
}
[class*="content_right"][${SIDE}="left"]::before { left:auto!important;right:-1px!important; }
[class*="_banner_"][${SIDE}="left"] { left:0!important;right:auto!important; }
#cheese-spanner-vod-comment-aside[${SIDE}="left"] {
  border-left:0!important;border-right:1px solid var(--bcvc-border)!important;
}
#sidebar[${SIDE}="right"] { left:auto!important;right:0!important; }
#sidebar[${SIDE}="right"]::before { left:auto!important;right:0!important; }
#sidebar[${SIDE}="right"] [class*="_show_tooltip_"] {
  margin-right:0!important;margin-left:-200px!important;padding-right:20px!important;padding-left:220px!important;
}
#sidebar[${SIDE}="right"] [class*="_item_"] [class^="_tooltip_"]:not([class*=" "]) {
  left:auto!important;right:100%!important;padding-left:0!important;padding-right:17px!important;
}
#layout-body[${BODY_SIDE}="right"] { padding-left:0!important;padding-right:var(${SIDE_SPACE_VARIABLE})!important; }
[${HANDLE}="sidebar"][${EDGE}="left"] { right:auto;left:0; }
[${HANDLE}="sidebar"][${EDGE}="left"]::after { right:auto;left:0; }
[${HANDLE}="chat"][${EDGE}="right"] { left:auto;right:0; }
[${HANDLE}="chat"][${EDGE}="right"]::after { left:auto;right:0; }
#aside-chatting > [${HANDLE}="chat"][${EDGE}="right"]::after { left:auto;right:-1px; }
`
        );
    }

    function setAttribute(node, name, value) {
        if (node.getAttribute(name) !== String(value)) node.setAttribute(name, String(value));
    }
    function setVariable(node, name, value) {
        if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
    }
    function clearVariable(node, name, marker) {
        if (!node) return;
        if (node.style.getPropertyValue(name)) node.style.removeProperty(name);
        if (marker && node.hasAttribute(marker)) node.removeAttribute(marker);
    }
    function clearWidth(node, marker = WIDTH) {
        clearVariable(node, VARIABLE, marker);
    }
    function sidebarOnRight() {
        return !!layoutBody?.hasAttribute(BODY_SIDE);
    }
    function syncBodySpace(value) {
        if (!layoutBody) return;
        if (sidebarOnRight()) {
            // The right side reuses the native reserved space unless a custom width is applied.
            clearWidth(layoutBody, SPACE);
            const space = value ?? nativeBodySpace;
            if (Number.isFinite(space)) setVariable(layoutBody, SIDE_SPACE_VARIABLE, `${space}px`);
            return;
        }
        if (value === null) clearWidth(layoutBody, SPACE);
        else {
            setVariable(layoutBody, VARIABLE, `${value}px`);
            setAttribute(layoutBody, SPACE, "1");
        }
    }
    function applyWidth(entry, value) {
        if (!entry) return;
        if (value === null) clearWidth(entry.node);
        else {
            setVariable(entry.node, VARIABLE, `${value}px`);
            setAttribute(entry.node, WIDTH, entry.panel);
        }
        if (entry.panel === "sidebar") syncBodySpace(value);
    }
    function appliedWidth(entry) {
        const value = entry?.node.hasAttribute(WIDTH)
            ? Number.parseFloat(entry.node.style.getPropertyValue(VARIABLE))
            : NaN;
        return Number.isFinite(value) ? value : null;
    }
    function applyHeight(entry, value) {
        if (!entry) return;
        if (value === null) clearVariable(entry.node, HEIGHT_VARIABLE, HEIGHT);
        else {
            setVariable(entry.node, HEIGHT_VARIABLE, `${value}px`);
            setAttribute(entry.node, HEIGHT, "1");
        }
    }
    const OWN_VARIABLES = new Set([VARIABLE, HEIGHT_VARIABLE, SIDE_SPACE_VARIABLE, COMPANION_WIDTH_VARIABLE]);
    function nativeSignature(node) {
        const declarations = [];
        for (let i = 0; i < node.style.length; i++) {
            const name = node.style[i];
            if (!OWN_VARIABLES.has(name))
                declarations.push(
                    `${name}:${node.style.getPropertyValue(name)}!${node.style.getPropertyPriority(name)}`
                );
        }
        return [node.className, node.hidden, node.getAttribute("aria-expanded"), ...declarations].join(";");
    }
    function visible(node) {
        if (!node?.isConnected || node.hidden) return false;
        const fullscreen = document.fullscreenElement;
        if (fullscreen && !fullscreen.contains(node)) return false;
        const rect = node.getBoundingClientRect(),
            css = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && css.display !== "none" && css.visibility !== "hidden";
    }
    // Side placement and the chat height are normal-screen choices: fullscreen keeps the native layout and the
    // selections return on exit. Width resizing keeps its existing fullscreen support.
    function inFullscreen() {
        return !!document.fullscreenElement;
    }
    function bodySpace() {
        if (!layoutBody) return Number.NaN;
        if (sidebarOnRight()) return Number.parseFloat(layoutBody.style.getPropertyValue(SIDE_SPACE_VARIABLE));
        return Number.parseFloat(
            layoutBody.style.getPropertyValue(VARIABLE) || getComputedStyle(layoutBody).paddingLeft
        );
    }
    function sidebarUsable(node) {
        if (!visible(node) || !layoutBody || node.parentElement !== layoutBody.parentElement) return false;
        if (window.innerWidth < 1200 || menu?.getAttribute("aria-expanded") !== "true") return false;
        return Math.abs(bodySpace() - node.getBoundingClientRect().width) < 2;
    }
    function chatSide(node) {
        return node.getAttribute(SIDE) === "left" ? "left" : "right";
    }
    // Which side of the media column the chat currently occupies, or null for stacked/overflowing layouts.
    function chatArrangement(node) {
        if (!visible(node) || !/^\/(live|video)\//.test(location.pathname)) return null;
        const parent = node.parentElement,
            css = getComputedStyle(parent);
        if (css.display !== "flex" || (css.flexDirection && css.flexDirection !== "row")) return null;
        const sibling = [...parent.children].find((child) => child !== node && !child.hasAttribute(HANDLE));
        if (!sibling || !visible(sibling)) return null;
        const rect = node.getBoundingClientRect(),
            main = sibling.getBoundingClientRect(),
            row = parent.getBoundingClientRect();
        const viewport = document.documentElement.clientWidth || window.innerWidth;
        // Native minimum-width layouts can overflow a narrow viewport while remaining flex rows.
        if (row.left < -2 || row.right > viewport + 2 || rect.right > viewport + 2 || rect.width >= row.width)
            return null;
        if (main.right <= rect.left + 2 && main.left < rect.left) return "right";
        if (rect.right <= main.left + 2 && rect.left < main.left) return "left";
        return null;
    }
    function chatUsable(node) {
        return chatArrangement(node) === chatSide(node);
    }
    function enabled(panel) {
        return options[`${panel}ResizeEnabled`] !== false;
    }
    function desiredSide(panel) {
        const value = options[panel === "sidebar" ? "sidebarPosition" : "chatPosition"];
        return value === "left" || value === "right" ? value : NATIVE_SIDE[panel];
    }
    function placementWanted(panel) {
        return desiredSide(panel) !== NATIVE_SIDE[panel];
    }
    function featureWanted() {
        return panels.some((panel) => enabled(panel) || placementWanted(panel));
    }
    function usable(entry) {
        return (
            active &&
            enabled(entry.panel) &&
            entry.node.isConnected &&
            entry.node.parentElement === entry.parent &&
            (entry.panel === "sidebar" ? sidebarUsable(entry.node) : chatUsable(entry.node))
        );
    }
    function heightUsable(entry) {
        return (
            !!entry &&
            entry.panel === "chat" &&
            !inFullscreen() &&
            usable(entry) &&
            !!model.getHeightRange(entry.nativeHeight)
        );
    }
    function edgeFor(entry) {
        if (entry.panel === "sidebar") return entry.node.getAttribute(SIDE) === "right" ? "left" : "right";
        return chatSide(entry.node) === "left" ? "right" : "left";
    }
    function geometry() {
        const sidebar = entries.sidebar,
            chat = entries.chat;
        const sideVisible = visible(sidebar?.node),
            chatVisible = chat && chatUsable(chat.node);
        const sideRect = sideVisible ? sidebar.node.getBoundingClientRect() : null;
        const viewport = document.documentElement.clientWidth || window.innerWidth;
        const bodyRect = layoutBody?.getBoundingClientRect();
        const row = chatVisible ? chat.parent.getBoundingClientRect() : null;
        // Wide mode can retain body padding while its player row starts at x=0.
        const occupying =
            sideVisible &&
            layoutBody?.contains(chatVisible ? chat.node : null) &&
            (row.left >= sideRect.right - 2 || row.right <= sideRect.left + 2);
        const sideSpace = row ? (occupying ? sideRect.width : 0) : sideVisible ? sideRect.width : 0;
        const available = row
            ? Math.min(row.width, viewport - row.left) + sideSpace
            : Math.min(bodyRect?.width || viewport, viewport);
        return {
            availableWidthPx: Math.max(0, available),
            sidebar: {
                visible: sideSpace > 0,
                enabled: !!sidebar && usable(sidebar),
                nativeWidthPx: sidebar?.nativeWidth ?? sideSpace,
            },
            chat: { visible: !!chatVisible, enabled: !!chat && usable(chat), nativeWidthPx: chat?.nativeWidth ?? 0 },
        };
    }
    function otherWidth(panel, geo) {
        const other = panel === "sidebar" ? "chat" : "sidebar";
        return geo[other].visible ? entries[other].node.getBoundingClientRect().width : 0;
    }
    async function loadSelection() {
        try {
            const local = globalThis.chrome?.storage?.local;
            if (typeof local?.get === "function") {
                const values = await storageGet(local, [
                    ...Object.values(model.STORAGE_KEYS),
                    model.HEIGHT_STORAGE_KEY,
                ]);
                selected = model.fromStorage(values);
                selectedHeight = model.normalizeHeight(values?.[model.HEIGHT_STORAGE_KEY]);
            }
        } catch {
            /* A failed read leaves native defaults; it never writes them back. */
        } finally {
            storageLoaded = true;
            start();
        }
    }
    function storageKey(kind) {
        return kind === "height" ? model.HEIGHT_STORAGE_KEY : model.STORAGE_KEYS[kind];
    }
    function save(kind, value) {
        if (kind === "height") selectedHeight = value;
        else selected = model.withWidth(selected, kind, value);
        const revision = ++saveRevision[kind];
        unsaved[kind] = true;
        // Issue only this choice immediately, in gesture order, through the worker's settings lock.
        // Completion never changes the selected size or restarts UI, and an old failure is not retried.
        settingsStoreSet("local", { [storageKey(kind)]: value }).then(
            () => {
                if (revision === saveRevision[kind]) unsaved[kind] = false;
            },
            () => {
                /* Keep the current choice in memory for a later explicit retry. */
            }
        );
    }
    function layoutKey(geo) {
        return JSON.stringify([
            geo.availableWidthPx,
            ...panels.flatMap((panel) => [
                geo[panel].visible,
                geo[panel].enabled,
                selected[`${panel}WidthPx`] === null || !geo[panel].enabled ? geo[panel].nativeWidthPx : null,
            ]),
        ]);
    }
    function confirmWidth(entry, value) {
        save(entry.panel, value);
        applyWidth(entry, value);
        // Keep a direct edit where the user released it. Reallocating against the other saved
        // wish here would immediately undo the edit when both panels were previously clamped.
        confirmedLayout = { key: layoutKey(geometry()), suspended: false };
        for (const panel of panels) {
            const current = entries[panel];
            confirmedLayout[`${panel}WidthPx`] = current?.node.hasAttribute(WIDTH)
                ? Math.round(current.node.getBoundingClientRect().width)
                : null;
        }
        const geo = geometry();
        const occupied = panels.reduce(
            (sum, panel) => sum + (geo[panel].visible ? entries[panel].node.getBoundingClientRect().width : 0),
            0
        );
        // Restoring a wider native panel may require clamping its neighbour again.
        if (occupied + model.LIMITS.centerMinPx > geo.availableWidthPx) confirmedLayout = null;
    }
    function confirmHeight(entry, value) {
        save("height", value);
        applyHeight(entry, model.resolveHeight(value, entry.nativeHeight));
    }
    function updateAria(handle, range, size) {
        if (!handle || !range) return;
        const value = Math.round(size);
        setAttribute(handle, "aria-valuemin", range.min);
        setAttribute(handle, "aria-valuemax", range.max);
        setAttribute(handle, "aria-valuenow", value);
        setAttribute(handle, "aria-valuetext", `${value}픽셀`);
    }
    function swallow(event) {
        event.preventDefault();
        event.stopPropagation();
    }
    function reset(entry, event) {
        if (event.button !== 0 || !usable(entry)) return;
        swallow(event);
        cancelGesture();
        confirmWidth(entry, null);
        sync();
    }
    function resetHeight(entry, event) {
        if (event.button !== 0 || !heightUsable(entry)) return;
        swallow(event);
        cancelGesture();
        confirmHeight(entry, null);
        sync();
    }
    function bindHandle(handle, onDown, onReset, owns) {
        let mouseResetAllowed = false;
        const down = (event) => {
                // Touch and pen can also emit compatibility dblclick events. Remember their
                // source even when the drag rejects them, so an earlier mouse cannot permit reset.
                mouseResetAllowed = event.pointerType === "mouse" && event.button === 0 && event.isPrimary !== false;
                onDown(event);
            },
            dbl = (event) => {
                if (mouseResetAllowed) onReset(event);
                mouseResetAllowed = false;
            };
        const lost = () => {
            if (owns()) cancelGesture();
        };
        handle.addEventListener("pointerdown", down);
        handle.addEventListener("dblclick", dbl);
        handle.addEventListener("click", swallow);
        handle.addEventListener("lostpointercapture", lost);
        return () => {
            handle.removeEventListener("pointerdown", down);
            handle.removeEventListener("dblclick", dbl);
            handle.removeEventListener("click", swallow);
            handle.removeEventListener("lostpointercapture", lost);
        };
    }
    function mountHandle(entry) {
        if (entry.handle?.parentElement !== entry.node) {
            unmountHandle(entry);
            const handle = document.createElement("div");
            handle.setAttribute(HANDLE, entry.panel);
            handle.setAttribute("role", "separator");
            handle.setAttribute("aria-orientation", "vertical");
            handle.setAttribute("aria-controls", entry.node.id);
            handle.setAttribute("aria-label", entry.panel === "sidebar" ? "사이드바 너비 조절" : "채팅·댓글 너비 조절");
            handle.title = "마우스로 드래그해 너비 조절 · 더블클릭으로 기본 너비";
            handle.tabIndex = -1;
            entry.cleanup = bindHandle(
                handle,
                (event) => startDrag(entry, event, "width"),
                (event) => reset(entry, event),
                () => gesture?.handle === handle
            );
            entry.handle = handle;
            entry.node.append(handle);
        }
        setAttribute(entry.handle, EDGE, edgeFor(entry));
    }
    function unmountHandle(entry) {
        if (entry.handle && gesture?.handle === entry.handle) cancelGesture(false);
        entry.cleanup?.();
        entry.cleanup = null;
        entry.handle?.remove();
        entry.handle = null;
    }
    function mountHeightHandle(entry) {
        if (heightHandle?.entry === entry && heightHandle.node.parentElement === entry.node) return;
        unmountHeightHandle();
        const handle = document.createElement("div");
        handle.setAttribute(HANDLE, "chat-height");
        handle.setAttribute("role", "separator");
        handle.setAttribute("aria-orientation", "horizontal");
        handle.setAttribute("aria-controls", entry.node.id);
        handle.setAttribute("aria-label", "채팅·댓글 높이 조절");
        handle.title = "마우스로 드래그해 높이 조절 · 더블클릭으로 기본 높이";
        handle.tabIndex = -1;
        const cleanup = bindHandle(
            handle,
            (event) => startDrag(entry, event, "height"),
            (event) => resetHeight(entry, event),
            () => gesture?.handle === handle
        );
        heightHandle = { entry, node: handle, cleanup };
        entry.node.append(handle);
    }
    function unmountHeightHandle() {
        if (!heightHandle) return;
        if (gesture?.handle === heightHandle.node) cancelGesture(false);
        heightHandle.cleanup();
        heightHandle.node.remove();
        heightHandle = null;
    }
    function startDrag(entry, event, kind) {
        if (
            event.pointerType !== "mouse" ||
            event.button !== 0 ||
            event.isPrimary === false ||
            gesture ||
            !(kind === "height" ? heightUsable(entry) : usable(entry))
        )
            return;
        const handle = kind === "height" ? heightHandle?.node : entry.handle;
        if (!handle) return;
        let measure;
        if (kind === "height") {
            if (!model.getHeightRange(entry.nativeHeight)) return;
            measure = {
                native: entry.nativeHeight,
                sign: 1,
                start: event.clientY,
                startSize: entry.node.getBoundingClientRect().height,
            };
        } else {
            const geo = geometry(),
                other = otherWidth(entry.panel, geo);
            if (!model.getResizeRange(entry.panel, geo.availableWidthPx, other)) return;
            measure = {
                available: geo.availableWidthPx,
                other,
                // The handle sits on the edge facing the media; dragging away from it grows the panel.
                sign: handle.getAttribute(EDGE) === "left" ? -1 : 1,
                start: event.clientX,
                startSize: entry.node.getBoundingClientRect().width,
            };
        }
        swallow(event);
        clickCleanup?.();
        gesture = {
            entry,
            kind,
            handle,
            pointerId: event.pointerId,
            pos: measure.start,
            generation,
            changed: false,
            ...measure,
        };
        setAttribute(handle, "data-bcpr-dragging", "1");
        try {
            handle.setPointerCapture(event.pointerId);
        } catch {
            /* Window listeners also cover capture loss/unavailability. */
        }
        window.addEventListener("pointermove", move, true);
        window.addEventListener("pointerup", finish, true);
        window.addEventListener("pointercancel", cancelPointer, true);
        window.addEventListener("blur", cancelGesture);
    }
    function validGesture(current) {
        return (
            current &&
            current === gesture &&
            current.generation === generation &&
            (current.kind === "height" ? heightUsable(current.entry) : usable(current.entry)) &&
            current.handle?.isConnected
        );
    }
    function preview() {
        previewFrame = 0;
        const current = gesture;
        if (!validGesture(current)) {
            cancelGesture();
            return;
        }
        if (!current.moved && current.pos === current.start) return;
        current.moved = true;
        const requested = current.startSize + (current.pos - current.start) * current.sign;
        const value =
            current.kind === "height"
                ? model.clampHeight(requested, current.native)
                : model.clampWidth(current.entry.panel, requested, current.available, current.other);
        if (value === null) {
            cancelGesture();
            return;
        }
        current.value = value;
        current.changed = value !== current.startSize;
        if (current.kind === "height") {
            applyHeight(current.entry, value);
            updateAria(current.handle, model.getHeightRange(current.native), value);
        } else {
            applyWidth(current.entry, value);
            if (current.entry.panel === "chat") syncCompanionWidth(current.entry);
            updateAria(
                current.handle,
                model.getResizeRange(current.entry.panel, current.available, current.other),
                current.entry.node.getBoundingClientRect().width
            );
        }
    }
    function pointerPosition(current, event) {
        return current.kind === "height" ? event.clientY : event.clientX;
    }
    function move(event) {
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        swallow(event);
        gesture.pos = pointerPosition(gesture, event);
        if (gesture.pos !== gesture.start) gesture.moved = true;
        if (!previewFrame) {
            const current = gesture;
            previewFrame = requestAnimationFrame(() => {
                if (gesture === current && current.generation === generation) preview();
            });
        }
    }
    function detachGesture() {
        const current = gesture;
        gesture = null;
        if (previewFrame) cancelAnimationFrame(previewFrame);
        previewFrame = 0;
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", finish, true);
        window.removeEventListener("pointercancel", cancelPointer, true);
        window.removeEventListener("blur", cancelGesture);
        current?.handle?.removeAttribute("data-bcpr-dragging");
        // Clear the gesture before release: browsers may dispatch lostpointercapture immediately.
        try {
            current?.handle?.releasePointerCapture(current.pointerId);
        } catch {
            /* Already released or disconnected. */
        }
        return current;
    }
    function cancelGesture(refresh = true) {
        if (!gesture) return;
        detachGesture();
        if (refresh && active) sync();
    }
    function cancelPointer(event) {
        if (event.pointerId === gesture?.pointerId) cancelGesture();
    }
    function suppressReleasedClick(event) {
        clickCleanup?.();
        const click = (next) => {
            if (
                next.detail > 0 &&
                Math.abs(next.clientX - event.clientX) <= 3 &&
                Math.abs(next.clientY - event.clientY) <= 3
            ) {
                swallow(next);
                clickCleanup?.();
            }
        };
        const cleanup = () => {
            window.clearTimeout(timer);
            window.removeEventListener("click", click, true);
            window.removeEventListener("pointerdown", cleanup, true);
            clickCleanup = null;
        };
        const timer = window.setTimeout(cleanup, 350);
        clickCleanup = cleanup;
        window.addEventListener("click", click, true);
        window.addEventListener("pointerdown", cleanup, true);
    }
    function finish(event) {
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        swallow(event);
        gesture.pos = pointerPosition(gesture, event);
        if (previewFrame) cancelAnimationFrame(previewFrame);
        preview();
        if (!gesture) return;
        const current = detachGesture();
        const kind = current.kind === "height" ? "height" : current.entry.panel;
        if (current.changed || (current.moved && unsaved[kind])) {
            if (current.kind === "height") confirmHeight(current.entry, current.value);
            else confirmWidth(current.entry, current.value);
        }
        if (Math.abs(current.pos - current.start) > 2) suppressReleasedClick(event);
        sync();
    }

    function clearCompanions(entry) {
        for (const node of entry?.companions || []) {
            clearVariable(node, COMPANION_WIDTH_VARIABLE, SIDE);
        }
        if (entry) entry.companions = [];
    }
    function clearPlacement(entry) {
        if (entry?.node.hasAttribute(SIDE)) entry.node.removeAttribute(SIDE);
        if (entry?.panel === "chat") clearCompanions(entry);
        if (entry?.panel === "sidebar") clearVariable(layoutBody, SIDE_SPACE_VARIABLE, BODY_SIDE);
    }
    // 2026-10-08 public CSS (index-B5SHICxp.css): VOD ._wrapper > ._player(video + aside) and ._area > ._content
    // (flex row: ._content_left title column + ._content_right 353px column); ._banner is absolute right:0 top:43px.
    function vodCompanions(entry) {
        if (!/^\/video\//.test(location.pathname)) return [];
        const wrapper = entry.parent?.parentElement;
        if (!(wrapper instanceof HTMLElement)) return [];
        const companions = [];
        for (const child of wrapper.children) {
            if (child === entry.parent) continue;
            if (child.matches('[class*="_banner_"]')) {
                companions.push(child);
                continue;
            }
            const column = child.querySelector('[class*="content_right"]');
            const row = column?.parentElement;
            if (row && getComputedStyle(row).display === "flex" && row.lastElementChild === column)
                companions.push(column);
        }
        return companions;
    }
    function syncCompanionWidth(entry) {
        const width = Math.round(entry?.node.getBoundingClientRect().width || 0);
        for (const node of entry?.companions || []) {
            if (node.matches('[class*="content_right"]') && width > 0)
                setVariable(node, COMPANION_WIDTH_VARIABLE, `${width}px`);
        }
    }
    function release(entry) {
        if (!entry) return;
        unmountHandle(entry);
        if (entry.panel === "chat") {
            if (heightHandle?.entry === entry) unmountHeightHandle();
            applyHeight(entry, null);
        }
        clearPlacement(entry);
        applyWidth(entry, null);
    }
    function horizontalOverflow() {
        const shell = layoutBody?.parentElement;
        if (!shell) return false;
        const viewport = document.documentElement.clientWidth || window.innerWidth;
        // The native shell keeps a 950px minimum; a scrolled page cannot keep a right-fixed sidebar aligned.
        return shell.getBoundingClientRect().width > viewport + 1;
    }
    function placeSidebar() {
        const entry = entries.sidebar;
        if (!layoutBody || !entry) return;
        if (!layoutBody.hasAttribute(BODY_SIDE) && !layoutBody.hasAttribute(SPACE)) {
            // Read the native reserved space while no extension override is applied.
            const value = Number.parseFloat(getComputedStyle(layoutBody).paddingLeft);
            nativeBodySpace = Number.isFinite(value) ? value : null;
        }
        const allowed =
            active &&
            !inFullscreen() &&
            placementWanted("sidebar") &&
            nativeBodySpace !== null &&
            visible(entry.node) &&
            entry.node.parentElement === layoutBody.parentElement &&
            !horizontalOverflow();
        if (allowed) {
            setAttribute(entry.node, SIDE, "right");
            setAttribute(layoutBody, BODY_SIDE, "right");
            syncBodySpace(appliedWidth(entry));
        } else if (entry.node.hasAttribute(SIDE) || layoutBody.hasAttribute(BODY_SIDE)) {
            clearPlacement(entry);
            syncBodySpace(appliedWidth(entry));
        }
    }
    function placeChat() {
        const entry = entries.chat;
        if (!entry) return;
        const wanted =
            active &&
            !inFullscreen() &&
            placementWanted("chat") &&
            entry.node.isConnected &&
            entry.node.parentElement === entry.parent &&
            chatArrangement(entry.node) !== null;
        if (!wanted) {
            clearPlacement(entry);
            return;
        }
        setAttribute(entry.node, SIDE, "left");
        const next = vodCompanions(entry);
        for (const node of entry.companions || []) {
            if (!next.includes(node)) clearVariable(node, COMPANION_WIDTH_VARIABLE, SIDE);
        }
        for (const node of next) setAttribute(node, SIDE, "left");
        entry.companions = next;
    }
    function reconcileTargets() {
        const body = document.getElementById("layout-body");
        if (layoutBody !== body) {
            clearWidth(layoutBody, SPACE);
            clearVariable(layoutBody, SIDE_SPACE_VARIABLE, BODY_SIDE);
            layoutBody = body;
            nativeBodySpace = null;
        }
        menu = document.getElementById("header")?.querySelector('button[aria-controls="navigation"]') || null;
        const nodes = {
            sidebar: document.getElementById("sidebar"),
            chat: /^\/live\//.test(location.pathname)
                ? document.getElementById("aside-chatting")
                : /^\/video\//.test(location.pathname)
                  ? document.getElementById("vod-aside") || document.getElementById("cheese-spanner-vod-comment-aside")
                  : null,
        };
        for (const panel of panels) {
            const node = nodes[panel],
                previous = entries[panel];
            if (previous?.node === node && previous?.parent === node?.parentElement) continue;
            release(previous);
            entries[panel] = node
                ? {
                      node,
                      panel,
                      parent: node.parentElement,
                      nativeWidth: node.getBoundingClientRect().width,
                      nativeHeight: node.getBoundingClientRect().height,
                  }
                : null;
        }
    }
    function observeGeometry() {
        attributes.disconnect();
        const watched = new Set(menu ? [menu] : []);
        for (const node of [layoutBody, ...panels.map((panel) => entries[panel]?.node)]) {
            for (let ancestor = node; ancestor instanceof HTMLElement; ancestor = ancestor.parentElement)
                watched.add(ancestor);
        }
        for (const node of watched) {
            signatures.set(node, nativeSignature(node));
            attributes.observe(node, {
                attributes: true,
                attributeFilter: ["class", "style", "hidden", "aria-expanded"],
            });
        }
        const next = new Set(
            [layoutBody, ...panels.flatMap((panel) => [entries[panel]?.node, entries[panel]?.parent])].filter(Boolean)
        );
        // Reobserving unchanged nodes would request a fresh ResizeObserver delivery forever.
        if (next.size !== resizedNodes.size || [...next].some((node) => !resizedNodes.has(node))) {
            resizeObserver?.disconnect();
            resizedNodes = next;
            for (const node of resizedNodes) resizeObserver?.observe(node);
        }
    }
    // The native height depends on the applied width (VOD: player height + overhang), so it is read after the
    // widths are applied, releasing only the extension height for that synchronous read. The selection is untouched
    // and the restored height leaves the native signature and the observed size unchanged.
    function measureNativeHeight(entry) {
        if (!entry) return;
        const applied = entry.node.hasAttribute(HEIGHT) ? entry.node.style.getPropertyValue(HEIGHT_VARIABLE) : "";
        if (applied) applyHeight(entry, null);
        entry.nativeHeight = entry.node.getBoundingClientRect().height;
        if (applied) {
            setVariable(entry.node, HEIGHT_VARIABLE, applied);
            setAttribute(entry.node, HEIGHT, "1");
        }
    }
    function syncHeight() {
        const entry = entries.chat;
        if (!heightUsable(entry)) {
            unmountHeightHandle();
            applyHeight(entry, null);
            return;
        }
        if (gesture?.kind !== "height") applyHeight(entry, model.resolveHeight(selectedHeight, entry.nativeHeight));
        mountHeightHandle(entry);
        updateAria(
            heightHandle.node,
            model.getHeightRange(entry.nativeHeight),
            entry.node.getBoundingClientRect().height
        );
    }
    function sync() {
        if (!active) return;
        reconcileTargets();
        if (gesture) {
            if (validGesture(gesture)) return;
            cancelGesture(false);
        }
        if (nativeDirty) {
            // Measure native geometry without any extension side, height or width override.
            for (const panel of panels) {
                clearPlacement(entries[panel]);
                if (panel === "chat") applyHeight(entries.chat, null);
            }
            clearVariable(layoutBody, SIDE_SPACE_VARIABLE, BODY_SIDE);
            for (const panel of panels) applyWidth(entries[panel], null);
            nativeDirty = false;
        }
        placeSidebar();
        placeChat();
        for (const panel of panels) {
            const entry = entries[panel];
            if (!entry) continue;
            if (!usable(entry)) {
                unmountHandle(entry);
                applyWidth(entry, null);
            }
            if (!entry.node.hasAttribute(WIDTH)) entry.nativeWidth = entry.node.getBoundingClientRect().width;
        }
        const geo = geometry();
        if (confirmedLayout && confirmedLayout.key !== layoutKey(geo)) confirmedLayout = null;
        const layout = confirmedLayout || model.calculateLayout(selected, geo);
        for (const panel of panels) {
            const entry = entries[panel];
            if (!entry) continue;
            applyWidth(entry, usable(entry) && !layout.suspended ? layout[`${panel}WidthPx`] : null);
        }
        for (const panel of panels) {
            const entry = entries[panel];
            if (!entry) continue;
            const range = model.getResizeRange(panel, geo.availableWidthPx, otherWidth(panel, geo));
            if (usable(entry) && !layout.suspended && range) {
                mountHandle(entry);
                updateAria(entry.handle, range, entry.node.getBoundingClientRect().width);
            } else unmountHandle(entry);
        }
        measureNativeHeight(entries.chat);
        syncHeight();
        syncCompanionWidth(entries.chat);
        observeGeometry();
    }
    function changedLayout() {
        if (!active) return;
        cancelGesture(false);
        nativeDirty = true;
        schedule();
    }
    function relevantMutations(rows) {
        // A left VOD chat also carries its info column and banner; React can replace them at the same size, which
        // no ResizeObserver reports, so their own additions/removals are discovered too (only while that is wanted).
        const companions = placementWanted("chat") && /^\/video\//.test(location.pathname);
        return rows.some((row) => {
            // Message and following-row churn never triggers full target discovery.
            const owner =
                row.target instanceof Element
                    ? row.target.closest("#sidebar, #aside-chatting, #vod-aside, #cheese-spanner-vod-comment-aside")
                    : null;
            if (owner && owner !== row.target) return false;
            return [...row.addedNodes, ...row.removedNodes].some((node) => {
                if (!(node instanceof Element)) return false;
                if (node.hasAttribute(HANDLE))
                    return (
                        !node.isConnected &&
                        (heightHandle?.node === node || Object.values(entries).some((entry) => entry?.handle === node))
                    );
                if (node.matches(TARGETS) || node.querySelector(TARGETS)) return true;
                return companions && (node.matches(COMPANIONS) || !!node.querySelector(COMPANIONS));
            });
        });
    }
    function start() {
        if (!ready || !optionsLoaded || !storageLoaded || disposed || hidden || active || !featureWanted()) return;
        active = true;
        generation++;
        styles();
        attributes = new MutationObserver((rows) => {
            if (!active) return;
            if (rows.some(({ target }) => signatures.get(target) !== nativeSignature(target))) changedLayout();
        });
        resizeObserver =
            typeof ResizeObserver === "function"
                ? new ResizeObserver(() => {
                      if (!active) return;
                      if (gesture) {
                          if (gesture.kind === "height") return;
                          const geo = geometry();
                          if (
                              Math.abs(geo.availableWidthPx - gesture.available) > 1 ||
                              Math.abs(otherWidth(gesture.entry.panel, geo) - gesture.other) > 1
                          )
                              changedLayout();
                      } else schedule();
                  })
                : null;
        discovery = createMutationObserverSync({
            target: document.body,
            options: { childList: true, subtree: true },
            shouldSchedule: relevantMutations,
            schedule,
        });
        routeCleanup = startPageChangeDetection(() => {
            generation++;
            changedLayout();
        });
        window.addEventListener("resize", changedLayout);
        document.addEventListener("fullscreenchange", changedLayout);
        sync();
    }
    function stopUI() {
        active = false;
        generation++;
        cancelGesture(false);
        schedule.cancel();
        clickCleanup?.();
        discovery?.disconnectAll();
        discovery = null;
        attributes?.disconnect();
        resizeObserver?.disconnect();
        resizedNodes = new Set();
        routeCleanup?.();
        routeCleanup = null;
        window.removeEventListener("resize", changedLayout);
        document.removeEventListener("fullscreenchange", changedLayout);
        for (const panel of panels) release(entries[panel]);
        unmountHeightHandle();
        entries = {};
        clearWidth(layoutBody, SPACE);
        clearVariable(layoutBody, SIDE_SPACE_VARIABLE, BODY_SIDE);
        layoutBody = null;
        nativeBodySpace = null;
        menu = null;
        document.getElementById(STYLE_ID)?.remove();
        document.getElementById(PLACEMENT_STYLE_ID)?.remove();
    }
    root.panelResize = {
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
        optionsLoaded = true;
        const resizeChanged = panels.some(
            (panel) => next[`${panel}ResizeEnabled`] !== options[`${panel}ResizeEnabled`]
        );
        const sideChanged =
            next.chatPosition !== options.chatPosition || next.sidebarPosition !== options.sidebarPosition;
        options = next;
        if (!featureWanted()) stopUI();
        else if (active && (resizeChanged || sideChanged)) {
            cancelGesture(false);
            // A side change re-measures native space without the previous side applied.
            if (sideChanged) nativeDirty = true;
            sync();
        } else start();
    });
    void loadSelection();
    onReady(() => {
        ready = true;
        start();
    });
})();
