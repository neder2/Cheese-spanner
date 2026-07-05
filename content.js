(() => {
    const root = (window.BetterChzzk = window.BetterChzzk || {});
    const existingUtils = root.utils || {};
    const PAGE_ROUTE_CHANGE_EVENT = "betterchzzk:routechange";
    const FEATURE_ROUTE_CHANGE_EVENT = "betterchzzk:routechange:detected";
    const EXTENSION_PREVIEW_VIDEO_SELECTOR = "[data-bcfp-player-mount], .bcfp-player, [data-bcfp-tooltip]";
    const INTERACTIVE_SELECTOR =
        "button, [role='button'], a[href], input, textarea, select, summary, [contenteditable='true']";
    const ROUTE_CHECK_DELAYS_MS = [0, 80, 250, 800];
    let routeDetectionUsers = 0;
    let routeDetectionInstalled = false;
    let routeDetectionLastHref = location.href;

    function onReady(fn) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", fn, { once: true });
            return;
        }
        fn();
    }

    const normSpace =
        existingUtils.compactSpaces ||
        ((value) =>
            String(value || "")
                .replace(/\s+/g, " ")
                .trim());

    const normalizeCompact =
        existingUtils.normalizeCompact ||
        ((value) =>
            String(value || "")
                .toLowerCase()
                .replace(/\s+/g, ""));

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function isVisible(el) {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden";
    }

    function pickLargestVisible(nodes) {
        let best = null;
        let bestArea = -1;
        for (const el of nodes || []) {
            if (!isVisible(el)) continue;
            const rect = el.getBoundingClientRect();
            const area = Math.max(0, rect.width) * Math.max(0, rect.height);
            if (area > bestArea) {
                best = el;
                bestArea = area;
            }
        }
        return best || null;
    }

    function elementOrHostMatches(node, selector) {
        let current = node;
        while (current) {
            if (current instanceof Element && current.matches(selector)) return true;
            if (current.parentElement) {
                current = current.parentElement;
                continue;
            }

            const rootNode = current.getRootNode?.();
            if (
                typeof ShadowRoot !== "undefined" &&
                rootNode instanceof ShadowRoot &&
                rootNode.host &&
                rootNode.host !== current
            ) {
                current = rootNode.host;
                continue;
            }

            break;
        }
        return false;
    }

    function isExtensionPreviewVideo(video) {
        return video instanceof HTMLVideoElement && elementOrHostMatches(video, EXTENSION_PREVIEW_VIDEO_SELECTOR);
    }

    function getMainVideoElement() {
        const videos = Array.from(document.querySelectorAll("video")).filter(
            (video) => !isExtensionPreviewVideo(video)
        );
        return pickLargestVisible(videos) || videos[0] || null;
    }

    function isEditableTarget(target) {
        if (!target) return false;
        if (target.isContentEditable) return true;
        if (typeof target.closest === "function") {
            return !!target.closest("input, textarea, select, [contenteditable='true']");
        }
        return false;
    }

    function getPlayerRoot(video) {
        let node = video?.closest?.("[class*='pzp']") || null;
        while (node) {
            const parent = node.parentElement?.closest?.("[class*='pzp']");
            if (!parent) break;
            node = parent;
        }
        if (node instanceof HTMLElement) return node;
        const fallback = document.querySelector(".pzp-pc, [class*='pzp-pc']");
        return fallback instanceof HTMLElement ? fallback : null;
    }

    function isOutsidePlayerInteractiveTarget(target, video) {
        if (!(target instanceof Element)) return false;
        const interactive = target.closest(INTERACTIVE_SELECTOR);
        if (!interactive) return false;
        const root = getPlayerRoot(video);
        return !(root && root.contains(interactive));
    }

    function elementMatchesOrContains(node, selector) {
        if (!(node instanceof Element)) return false;
        return node.matches(selector) || Boolean(node.querySelector(selector));
    }

    function mutationMatchesSelector(mutation, selector) {
        if (mutation.type === "attributes") {
            return elementMatchesOrContains(mutation.target, selector);
        }
        if (mutation.type !== "childList") return false;
        for (const node of mutation.addedNodes || []) {
            if (elementMatchesOrContains(node, selector)) return true;
        }
        for (const node of mutation.removedNodes || []) {
            if (elementMatchesOrContains(node, selector)) return true;
        }
        return false;
    }

    function createThrottledDomSync(run, throttleMs = 160) {
        let scheduled = false;
        let lastRunAt = 0;
        return function scheduleDomSync() {
            if (scheduled) return;

            const elapsed = performance.now() - lastRunAt;
            const delay = Math.max(0, throttleMs - elapsed);
            scheduled = true;

            const queue = () => {
                requestAnimationFrame(() => {
                    scheduled = false;
                    lastRunAt = performance.now();
                    run();
                });
            };

            if (delay > 0) {
                window.setTimeout(queue, delay);
                return;
            }

            queue();
        };
    }

    function publishRouteChange(source = "fallback") {
        const href = location.href;
        if (href === routeDetectionLastHref) return false;
        routeDetectionLastHref = href;
        window.dispatchEvent(
            new CustomEvent(FEATURE_ROUTE_CHANGE_EVENT, {
                detail: { href, source },
            })
        );
        return true;
    }

    function scheduleRouteChecks(source = "scheduled") {
        for (const delay of ROUTE_CHECK_DELAYS_MS) {
            window.setTimeout(() => publishRouteChange(source), delay);
        }
    }

    function onPageRouteChange(event) {
        publishRouteChange(event?.detail?.source || "page-bridge");
    }

    function onRoutePageshow() {
        scheduleRouteChecks("pageshow");
    }

    function onRouteClick() {
        scheduleRouteChecks("click");
    }

    function installRouteDetection() {
        if (routeDetectionInstalled) return;
        routeDetectionInstalled = true;
        routeDetectionLastHref = location.href;
        window.addEventListener(PAGE_ROUTE_CHANGE_EVENT, onPageRouteChange, true);
        window.addEventListener("popstate", onPageRouteChange, true);
        window.addEventListener("hashchange", onPageRouteChange, true);
        window.addEventListener("pageshow", onRoutePageshow, true);
        document.addEventListener("click", onRouteClick, true);
    }

    function uninstallRouteDetection() {
        if (!routeDetectionInstalled) return;
        routeDetectionInstalled = false;
        window.removeEventListener(PAGE_ROUTE_CHANGE_EVENT, onPageRouteChange, true);
        window.removeEventListener("popstate", onPageRouteChange, true);
        window.removeEventListener("hashchange", onPageRouteChange, true);
        window.removeEventListener("pageshow", onRoutePageshow, true);
        document.removeEventListener("click", onRouteClick, true);
    }

    // Feature runtimes stay installed while enabled; route-specific handlers decide mount/unmount/no-op.
    function startPageChangeDetection(handlePageChange) {
        if (typeof handlePageChange !== "function") return () => {};
        routeDetectionUsers += 1;
        installRouteDetection();
        window.addEventListener(FEATURE_ROUTE_CHANGE_EVENT, handlePageChange, true);
        return () => {
            window.removeEventListener(FEATURE_ROUTE_CHANGE_EVENT, handlePageChange, true);
            routeDetectionUsers = Math.max(0, routeDetectionUsers - 1);
            if (routeDetectionUsers === 0) uninstallRouteDetection();
        };
    }

    function injectStyleOnce(id, cssText) {
        if (document.getElementById(id)) return null;
        const style = document.createElement("style");
        style.id = id;
        style.textContent = cssText;
        document.documentElement.appendChild(style);
        return style;
    }

    const isLastPage =
        existingUtils.isLastPage ||
        ((json, rows, pageSize) => {
            const content = json?.content ?? json;
            if (!content) return true;
            if (typeof content.totalPages === "number" && typeof content.page?.number === "number") {
                return content.page.number >= content.totalPages - 1;
            }
            if (typeof content.last === "boolean") return content.last;
            return rows.length < pageSize;
        });

    function isPlaybackRoute(pathname = location.pathname) {
        return /^\/(?:live|video)(?:\/|$)/.test(pathname);
    }

    function isLiveRoute(pathname = location.pathname) {
        return /^\/live(?:\/|$)/.test(pathname);
    }

    function getLiveChannelIdFromPath(pathname = location.pathname) {
        const match = pathname.match(/^\/live\/([^/?#]+)/);
        return match ? decodeURIComponent(match[1]) : "";
    }

    function isVodRoute(pathname = location.pathname) {
        return /^\/video(?:\/|$)/.test(pathname);
    }

    function getVodVideoNoFromPath(pathname = location.pathname) {
        const match = pathname.match(/^\/video\/([^/?#]+)/);
        return match ? match[1] : "";
    }

    function setLoadingReason(reasons, on, reason, sync) {
        if (on) reasons.add(reason);
        else reasons.delete(reason);
        sync?.();
    }

    function createMutationObserverSync({
        target = () => document.body,
        options = { childList: true, subtree: true },
        onMutations,
        shouldIgnoreMutations,
        shouldSchedule,
        schedule,
        onObserved,
        onBodyReady,
    } = {}) {
        let bodyObserver = null;
        let disconnectedAll = false;
        const observer = new MutationObserver((mutations) => {
            if (disconnectedAll) return;
            onMutations?.(mutations);
            if (!schedule) return;
            if (shouldIgnoreMutations?.(mutations)) return;
            if (shouldSchedule && !shouldSchedule(mutations)) return;
            schedule();
        });
        const disconnectObserver = observer.disconnect.bind(observer);

        observer.disconnect = () => {
            disconnectObserver();
            if (bodyObserver) {
                bodyObserver.disconnect();
                bodyObserver = null;
            }
        };
        observer.disconnectAll = () => {
            disconnectedAll = true;
            observer.disconnect();
        };

        const resolveTarget = () => (typeof target === "function" ? target() : target);
        const resolveOptions = () => (typeof options === "function" ? options() : options);
        const observeTarget = (node) => {
            observer.observe(node, resolveOptions());
            onObserved?.(observer, node);
        };

        const initialTarget = resolveTarget();
        if (initialTarget) {
            observeTarget(initialTarget);
            return observer;
        }

        bodyObserver = new MutationObserver(() => {
            if (disconnectedAll) return;
            const readyTarget = resolveTarget();
            if (!readyTarget) return;
            bodyObserver.disconnect();
            bodyObserver = null;
            observeTarget(readyTarget);
            onBodyReady?.(observer, readyTarget);
        });

        bodyObserver.observe(document.documentElement, { childList: true, subtree: true });
        return observer;
    }

    function bindFeatureOptions(applyOptions) {
        BetterChzzkSettings.getOptions(applyOptions);
        return BetterChzzkSettings.addOptionsChangeListener(applyOptions);
    }

    root.utils = {
        ...(root.utils || {}),
        onReady,
        normSpace,
        normalizeCompact,
        sleep,
        isVisible,
        pickLargestVisible,
        getMainVideoElement,
        isExtensionPreviewVideo,
        isEditableTarget,
        getPlayerRoot,
        isOutsidePlayerInteractiveTarget,
        elementMatchesOrContains,
        mutationMatchesSelector,
        createThrottledDomSync,
        startPageChangeDetection,
        injectStyleOnce,
        isLastPage,
        getLiveChannelIdFromPath,
        isLiveRoute,
        isPlaybackRoute,
        isVodRoute,
        getVodVideoNoFromPath,
        setLoadingReason,
        createMutationObserverSync,
        bindFeatureOptions,
    };
})();
