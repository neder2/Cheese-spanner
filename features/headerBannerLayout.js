/** Preserve CHZZK's measured banner offsets when cosmetic filters reset the surrounding layout. */
(() => {
    "use strict";
    const root = window.BetterChzzk;
    if (root.headerBannerLayout) return;
    const { createMutationObserverSync, injectStyleOnce, onReady, startPageChangeDetection } = root.utils;
    const STYLE_ID = "betterchzzk-header-banner-layout-style";
    const MARKER = "data-bchbl-offset";
    const STICKY_STYLE_ID = "betterchzzk-header-banner-sticky-style";
    const STICKY_MARKER = "data-bchbl-sticky";
    const STICKY_VARIABLE = "--bchbl-sticky-top";
    const properties = [
        ["header", "transform"],
        ["sidebar", "transform"],
        ["sidebar", "height"],
        ["layout-body", "padding-top"],
    ];
    let layoutObserver = null;
    let attributeObserver = null;
    let resizeObserver = null;
    let routeCleanup = null;
    let targets = [];
    let banner = null;
    let scheduled = false;
    let active = false;
    let stickyBody = null;

    function clearSticky() {
        stickyBody?.style.removeProperty(STICKY_VARIABLE);
        stickyBody?.removeAttribute(STICKY_MARKER);
        stickyBody = null;
        document.getElementById(STICKY_STYLE_ID)?.remove();
    }

    function updateSticky(header, bannerStyle, offset) {
        const body = document.getElementById("layout-body");
        const bottom = header?.getBoundingClientRect().bottom;
        // Measured watchparty layout: hidden top skin, reset header, but native sticky top still includes the skin.
        if (
            !/^\/watchparty\//.test(location.pathname) ||
            bannerStyle?.display !== "none" ||
            !(Number(offset?.[1]) > 0) ||
            !body ||
            body.parentElement !== header.parentElement ||
            getComputedStyle(header).transform !== "none" ||
            !(bottom > 0)
        ) {
            clearSticky();
            return;
        }
        if (stickyBody !== body) clearSticky();
        stickyBody = body;
        const value = `${bottom}px`;
        if (body.style.getPropertyValue(STICKY_VARIABLE) !== value) body.style.setProperty(STICKY_VARIABLE, value);
        if (!body.hasAttribute(STICKY_MARKER)) body.setAttribute(STICKY_MARKER, "1");
        injectStyleOnce(
            STICKY_STYLE_ID,
            `#layout-body[${STICKY_MARKER}] > div > section > div[class*="_header_"][class*="_is_sticky_"] { top: var(${STICKY_VARIABLE}) !important; }`
        );
    }

    function clearTargets() {
        clearSticky();
        attributeObserver?.disconnect();
        resizeObserver?.disconnect();
        for (const { node, variable, marker } of targets) {
            node.style.removeProperty(variable);
            node.removeAttribute(marker);
        }
        targets = [];
        banner = null;
        document.getElementById(STYLE_ID)?.remove();
    }

    function updateOffsets() {
        scheduled = false;
        if (!active) return;
        const header = document.getElementById("header");
        const offset = header?.style.transform.match(/^translateY\((-?\d+(?:\.\d+)?)px\)$/);
        const rect = banner?.getBoundingClientRect();
        const style = banner?.isConnected ? getComputedStyle(banner) : null;
        updateSticky(header, style, offset);
        const visible =
            header?.isConnected &&
            banner === header.previousElementSibling &&
            offset &&
            Number(offset[1]) > 0 &&
            rect?.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            style?.position === "fixed" &&
            style.visibility !== "hidden" &&
            Number(style.opacity) > 0;
        if (!visible) {
            for (const { node, variable, marker } of targets) {
                if (node.style.getPropertyValue(variable)) node.style.removeProperty(variable);
                if (node.hasAttribute(marker)) node.removeAttribute(marker);
            }
            document.getElementById(STYLE_ID)?.remove();
            return;
        }
        injectStyleOnce(
            STYLE_ID,
            properties
                .map(
                    ([id, property]) =>
                        `#${id}[${MARKER}-${property}] { ${property}: var(--bchbl-${property}) !important; }`
                )
                .join("\n")
        );
        for (const { node, property, variable, marker } of targets) {
            const value = node.style.getPropertyValue(property);
            if (!value) {
                if (node.style.getPropertyValue(variable)) node.style.removeProperty(variable);
                if (node.hasAttribute(marker)) node.removeAttribute(marker);
                continue;
            }
            if (node.style.getPropertyValue(variable) !== value) node.style.setProperty(variable, value);
            if (!node.hasAttribute(marker)) node.setAttribute(marker, "1");
        }
    }

    function schedule() {
        if (!active || scheduled) return;
        scheduled = true;
        queueMicrotask(updateOffsets);
    }

    function bindLayout() {
        clearTargets();
        const header = document.getElementById("header");
        const candidate = header?.previousElementSibling;
        // Measured top-promotion structure: a fixed sibling immediately before #header, containing wrapper links.
        if (!candidate?.matches('div[class*="_container_"]:has(> a[class*="_wrapper_"])')) return;
        banner = candidate;
        targets = properties.flatMap(([id, property]) => {
            const node = document.getElementById(id);
            return node && node.parentElement === header.parentElement
                ? [{ node, property, variable: `--bchbl-${property}`, marker: `${MARKER}-${property}` }]
                : [];
        });
        attributeObserver ||= new MutationObserver(schedule);
        for (const node of new Set([banner, ...targets.map(({ node }) => node)]))
            attributeObserver.observe(node, { attributes: true, attributeFilter: ["style", "class", "hidden"] });
        resizeObserver ||= new ResizeObserver(schedule);
        resizeObserver.observe(banner);
        resizeObserver.observe(header);
        updateOffsets();
    }

    function start() {
        if (active) return;
        active = true;
        layoutObserver = createMutationObserverSync({
            target: () => document.getElementById("header")?.parentElement,
            options: { childList: true },
            onObserved: bindLayout,
            onMutations: bindLayout,
        });
        routeCleanup = startPageChangeDetection(bindLayout);
    }

    function stop() {
        active = false;
        scheduled = false;
        layoutObserver?.disconnectAll();
        layoutObserver = null;
        routeCleanup?.();
        routeCleanup = null;
        clearTargets();
    }

    root.headerBannerLayout = { stop };
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", start);
    onReady(start);
})();
