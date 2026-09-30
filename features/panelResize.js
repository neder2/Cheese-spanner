/** Isolated mouse resizing with profile-local choices read once per document. */
(() => {
    "use strict";
    const root = window.BetterChzzk;
    if (root.panelResize) return;
    const model = root.panelResizeModel;
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        createThrottledDomSync,
        injectStyleOnce,
        onReady,
        startPageChangeDetection,
        storageGet,
        storageSet,
    } = root.utils;
    const STYLE_ID = "betterchzzk-panel-resize-style";
    const VARIABLE = "--bcpr-width";
    const WIDTH = "data-bcpr-width";
    const SPACE = "data-bcpr-sidebar-space";
    const HANDLE = "data-bcpr-handle";
    const TARGETS =
        '#sidebar, #layout-body, #header, #header button[aria-controls="navigation"], #aside-chatting, #vod-aside, #betterchzzk-vod-comment-aside';
    const panels = ["sidebar", "chat"];
    let selected = model.normalizeState(null),
        storageLoaded = false,
        disposed = false;
    const saveRevision = { sidebar: 0, chat: 0 },
        unsaved = { sidebar: false, chat: false };
    let options = {},
        optionsLoaded = false,
        ready = false,
        active = false,
        hidden = false,
        generation = 0;
    let entries = {},
        layoutBody = null,
        menu = null,
        nativeDirty = false;
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
  background:var(--sem-color-content-brand-strong,var(--Content-Brand-Strong,#00b87c));
}
`
        );
    }

    function setAttribute(node, name, value) {
        if (node.getAttribute(name) !== String(value)) node.setAttribute(name, String(value));
    }
    function clearWidth(node, marker = WIDTH) {
        if (!node) return;
        if (node.style.getPropertyValue(VARIABLE)) node.style.removeProperty(VARIABLE);
        if (node.hasAttribute(marker)) node.removeAttribute(marker);
    }
    function applyWidth(entry, value) {
        if (!entry) return;
        if (value === null) clearWidth(entry.node);
        else {
            const px = `${value}px`;
            if (entry.node.style.getPropertyValue(VARIABLE) !== px) entry.node.style.setProperty(VARIABLE, px);
            setAttribute(entry.node, WIDTH, entry.panel);
        }
        if (entry.panel === "sidebar" && layoutBody) {
            if (value === null) clearWidth(layoutBody, SPACE);
            else {
                const px = `${value}px`;
                if (layoutBody.style.getPropertyValue(VARIABLE) !== px) layoutBody.style.setProperty(VARIABLE, px);
                setAttribute(layoutBody, SPACE, "1");
            }
        }
    }
    function nativeSignature(node) {
        const declarations = [];
        for (let i = 0; i < node.style.length; i++) {
            const name = node.style[i];
            if (name !== VARIABLE)
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
    function sidebarUsable(node) {
        if (!visible(node) || !layoutBody || node.parentElement !== layoutBody.parentElement) return false;
        if (window.innerWidth < 1200 || menu?.getAttribute("aria-expanded") !== "true") return false;
        const pad = Number.parseFloat(
            layoutBody.style.getPropertyValue(VARIABLE) || getComputedStyle(layoutBody).paddingLeft
        );
        return Math.abs(pad - node.getBoundingClientRect().width) < 2;
    }
    function chatUsable(node) {
        if (!visible(node) || !/^\/(live|video)\//.test(location.pathname)) return false;
        const parent = node.parentElement,
            css = getComputedStyle(parent);
        if (css.display !== "flex" || (css.flexDirection && css.flexDirection !== "row")) return false;
        const sibling = [...parent.children].find((child) => child !== node && !child.hasAttribute(HANDLE));
        if (!sibling || !visible(sibling)) return false;
        const rect = node.getBoundingClientRect(),
            main = sibling.getBoundingClientRect(),
            row = parent.getBoundingClientRect();
        const viewport = document.documentElement.clientWidth || window.innerWidth;
        // Native minimum-width layouts can overflow a narrow viewport while remaining flex rows.
        return (
            row.left >= -2 &&
            row.right <= viewport + 2 &&
            rect.right <= viewport + 2 &&
            main.right <= rect.left + 2 &&
            main.left < rect.left &&
            rect.width < row.width
        );
    }
    function enabled(panel) {
        return options[`${panel}ResizeEnabled`] !== false;
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
            sideVisible && layoutBody?.contains(chatVisible ? chat.node : null) && row.left >= sideRect.right - 2;
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
                const values = await storageGet(local, Object.values(model.STORAGE_KEYS));
                selected = model.fromStorage(values);
            }
        } catch {
            /* A failed read leaves native defaults; it never writes them back. */
        } finally {
            storageLoaded = true;
            start();
        }
    }
    function save(panel, value) {
        selected = model.withWidth(selected, panel, value);
        const revision = ++saveRevision[panel];
        unsaved[panel] = true;
        const local = globalThis.chrome?.storage?.local;
        if (typeof local?.set !== "function") return;
        // Issue only this panel's explicit choice immediately, in gesture order. Completion
        // never changes the selected width or restarts UI, and an old failure is not retried.
        storageSet(local, { [model.STORAGE_KEYS[panel]]: value }).then(
            () => {
                if (revision === saveRevision[panel]) unsaved[panel] = false;
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
    function updateAria(entry, range) {
        if (!entry.handle || !range) return;
        const value = Math.round(entry.node.getBoundingClientRect().width);
        setAttribute(entry.handle, "aria-valuemin", range.min);
        setAttribute(entry.handle, "aria-valuemax", range.max);
        setAttribute(entry.handle, "aria-valuenow", value);
        setAttribute(entry.handle, "aria-valuetext", `${value}픽셀`);
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
    function mountHandle(entry) {
        if (entry.handle?.parentElement === entry.node) return;
        unmountHandle(entry);
        const handle = document.createElement("div");
        handle.setAttribute(HANDLE, entry.panel);
        handle.setAttribute("role", "separator");
        handle.setAttribute("aria-orientation", "vertical");
        handle.setAttribute("aria-controls", entry.node.id);
        handle.setAttribute("aria-label", entry.panel === "sidebar" ? "사이드바 너비 조절" : "채팅·댓글 너비 조절");
        handle.title = "마우스로 드래그해 너비 조절 · 더블클릭으로 기본 너비";
        handle.tabIndex = -1;
        let mouseResetAllowed = false;
        const down = (event) => {
                // Touch and pen can also emit compatibility dblclick events. Remember their
                // source even when startDrag rejects them, so an earlier mouse cannot permit reset.
                mouseResetAllowed = event.pointerType === "mouse" && event.button === 0 && event.isPrimary !== false;
                startDrag(entry, event);
            },
            dbl = (event) => {
                if (mouseResetAllowed) reset(entry, event);
                mouseResetAllowed = false;
            };
        const lost = () => {
            if (gesture?.entry === entry) cancelGesture();
        };
        handle.addEventListener("pointerdown", down);
        handle.addEventListener("dblclick", dbl);
        handle.addEventListener("click", swallow);
        handle.addEventListener("lostpointercapture", lost);
        entry.cleanup = () => {
            handle.removeEventListener("pointerdown", down);
            handle.removeEventListener("dblclick", dbl);
            handle.removeEventListener("click", swallow);
            handle.removeEventListener("lostpointercapture", lost);
        };
        entry.handle = handle;
        entry.node.append(handle);
    }
    function unmountHandle(entry) {
        if (gesture?.entry === entry) cancelGesture(false);
        entry.cleanup?.();
        entry.cleanup = null;
        entry.handle?.remove();
        entry.handle = null;
    }
    function startDrag(entry, event) {
        if (
            event.pointerType !== "mouse" ||
            event.button !== 0 ||
            event.isPrimary === false ||
            !usable(entry) ||
            gesture
        )
            return;
        const geo = geometry(),
            other = otherWidth(entry.panel, geo);
        if (!model.getResizeRange(entry.panel, geo.availableWidthPx, other)) return;
        swallow(event);
        clickCleanup?.();
        gesture = {
            entry,
            pointerId: event.pointerId,
            startX: event.clientX,
            x: event.clientX,
            startWidth: entry.node.getBoundingClientRect().width,
            available: geo.availableWidthPx,
            other,
            generation,
            changed: false,
        };
        setAttribute(entry.handle, "data-bcpr-dragging", "1");
        try {
            entry.handle.setPointerCapture(event.pointerId);
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
            usable(current.entry) &&
            current.entry.handle?.isConnected
        );
    }
    function preview() {
        previewFrame = 0;
        const current = gesture;
        if (!validGesture(current)) {
            cancelGesture();
            return;
        }
        if (!current.moved && current.x === current.startX) return;
        current.moved = true;
        const value = model.clampWidth(
            current.entry.panel,
            current.startWidth + (current.x - current.startX) * (current.entry.panel === "sidebar" ? 1 : -1),
            current.available,
            current.other
        );
        if (value === null) {
            cancelGesture();
            return;
        }
        current.value = value;
        current.changed = value !== current.startWidth;
        applyWidth(current.entry, value);
        updateAria(current.entry, model.getResizeRange(current.entry.panel, current.available, current.other));
    }
    function move(event) {
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        swallow(event);
        gesture.x = event.clientX;
        if (gesture.x !== gesture.startX) gesture.moved = true;
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
        current?.entry.handle?.removeAttribute("data-bcpr-dragging");
        // Clear the gesture before release: browsers may dispatch lostpointercapture immediately.
        try {
            current?.entry.handle?.releasePointerCapture(current.pointerId);
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
        gesture.x = event.clientX;
        if (previewFrame) cancelAnimationFrame(previewFrame);
        preview();
        if (!gesture) return;
        const current = detachGesture();
        if (current.changed || (current.moved && unsaved[current.entry.panel]))
            confirmWidth(current.entry, current.value);
        if (Math.abs(current.x - current.startX) > 2) suppressReleasedClick(event);
        sync();
    }

    function release(entry) {
        if (!entry) return;
        unmountHandle(entry);
        applyWidth(entry, null);
    }
    function reconcileTargets() {
        const body = document.getElementById("layout-body");
        if (layoutBody !== body) {
            clearWidth(layoutBody, SPACE);
            layoutBody = body;
        }
        menu = document.getElementById("header")?.querySelector('button[aria-controls="navigation"]') || null;
        const nodes = {
            sidebar: document.getElementById("sidebar"),
            chat: /^\/live\//.test(location.pathname)
                ? document.getElementById("aside-chatting")
                : /^\/video\//.test(location.pathname)
                  ? document.getElementById("vod-aside") || document.getElementById("betterchzzk-vod-comment-aside")
                  : null,
        };
        for (const panel of panels) {
            const node = nodes[panel],
                previous = entries[panel];
            if (previous?.node === node && previous?.parent === node?.parentElement) continue;
            release(previous);
            entries[panel] = node
                ? { node, panel, parent: node.parentElement, nativeWidth: node.getBoundingClientRect().width }
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
    function sync() {
        if (!active) return;
        reconcileTargets();
        if (gesture) {
            if (validGesture(gesture)) return;
            cancelGesture(false);
        }
        if (nativeDirty) {
            for (const panel of panels) applyWidth(entries[panel], null);
            nativeDirty = false;
        }
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
                updateAria(entry, range);
            } else unmountHandle(entry);
        }
        observeGeometry();
    }
    function changedLayout() {
        if (!active) return;
        cancelGesture(false);
        nativeDirty = true;
        schedule();
    }
    function relevantMutations(rows) {
        return rows.some((row) => {
            // Message and following-row churn never triggers full target discovery.
            const owner =
                row.target instanceof Element
                    ? row.target.closest("#sidebar, #aside-chatting, #vod-aside, #betterchzzk-vod-comment-aside")
                    : null;
            if (owner && owner !== row.target) return false;
            return [...row.addedNodes, ...row.removedNodes].some((node) => {
                if (!(node instanceof Element)) return false;
                if (node.hasAttribute(HANDLE))
                    return !node.isConnected && Object.values(entries).some((entry) => entry?.handle === node);
                return node.matches(TARGETS) || !!node.querySelector(TARGETS);
            });
        });
    }
    function start() {
        if (
            !ready ||
            !optionsLoaded ||
            !storageLoaded ||
            disposed ||
            hidden ||
            active ||
            (!enabled("sidebar") && !enabled("chat"))
        )
            return;
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
        entries = {};
        clearWidth(layoutBody, SPACE);
        layoutBody = null;
        menu = null;
        document.getElementById(STYLE_ID)?.remove();
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
        const changed = panels.some((panel) => next[`${panel}ResizeEnabled`] !== options[`${panel}ResizeEnabled`]);
        options = next;
        if (!enabled("sidebar") && !enabled("chat")) stopUI();
        else if (active && changed) {
            cancelGesture(false);
            sync();
        } else start();
    });
    void loadSelection();
    onReady(() => {
        ready = true;
        start();
    });
})();
