(() => {
    const VOD_ROUTE_RE = /^\/video\/\d+(?:\/|$)/;
    const CHAT_HEADING_TEXT = "\uB77C\uC774\uBE0C \uCC44\uD305 \uB2E4\uC2DC\uBCF4\uAE30";
    const RELOAD_KEY_PREFIX = "betterchzzk:vod-chat-reload:";
    const RELOAD_MARK_TTL_MS = 60 * 1000;
    const MIN_RELOAD_DELAY_MS = 12000;
    const LAYOUT_SETTLE_DELAY_MS = 2500;
    const CHECK_DELAYS_MS = [12000, 16000, 22000];
    const OBSERVER_THROTTLE_MS = 500;
    const EXPANDED_PLAYER_TERMS = [
        "\uAE30\uBCF8 \uD654\uBA74",
        "\uC881\uC740 \uD654\uBA74",
        "\uC77C\uBC18 \uD654\uBA74",
        "exit wide",
        "normal screen",
    ];

    const {
        createThrottledDomSync,
        getMainVideoElement,
        onReady,
        startPageChangeDetection,
    } = BetterChzzk.utils;

    let lastHref = location.href;
    let lastVodRouteKey = getVodRouteKey();
    let lastLayoutMutationAt = 0;
    let checkSeq = 0;
    let observer = null;
    let bodyObserver = null;
    let routeStartedAt = performance.now();
    let routeNeedsReplayChatFix = false;
    let removePageChangeDetection = null;
    let runtimeInstalled = false;

    function isVodRoute() {
        return VOD_ROUTE_RE.test(location.pathname);
    }

    function getVodRouteKey() {
        const match = location.pathname.match(/^\/video\/\d+/);
        return match ? match[0] : "";
    }

    function getReloadKey() {
        return `${RELOAD_KEY_PREFIX}${location.pathname}`;
    }

    function getReloadMark() {
        try {
            const value = Number(sessionStorage.getItem(getReloadKey()));
            return Number.isFinite(value) ? value : 0;
        } catch (_) {
            return 0;
        }
    }

    function setReloadMark() {
        try {
            sessionStorage.setItem(getReloadKey(), String(Date.now()));
        } catch (_) {
            // If sessionStorage is unavailable, location.replace still prevents history churn.
        }
    }

    function hasRecentReloadMark() {
        const mark = getReloadMark();
        if (!mark) return false;

        if (Date.now() - mark <= RELOAD_MARK_TTL_MS) return true;
        try {
            sessionStorage.removeItem(getReloadKey());
        } catch (_) {
            // Ignore storage cleanup failures; the stale mark naturally expires.
        }
        return false;
    }

    function hasReplayChat() {
        return Boolean(document.body?.textContent?.includes(CHAT_HEADING_TEXT));
    }

    function compact(value) {
        return String(value || "").replace(/\s+/g, "").toLowerCase();
    }

    function getControlText(el) {
        return compact([
            el?.getAttribute?.("aria-label"),
            el?.getAttribute?.("title"),
            el?.textContent,
        ].join(" "));
    }

    function isExpandedPlayerLayout() {
        for (const button of document.querySelectorAll("button, [role='button']")) {
            const text = getControlText(button);
            if (!text) continue;
            if (EXPANDED_PLAYER_TERMS.some((term) => text.includes(compact(term)))) return true;
        }
        return false;
    }

    function isLayoutSettling() {
        return lastLayoutMutationAt > 0 && performance.now() - lastLayoutMutationAt < LAYOUT_SETTLE_DELAY_MS;
    }

    function hasPlayableVod() {
        const video = getMainVideoElement?.() || document.querySelector("video");
        return video instanceof HTMLVideoElement && video.isConnected;
    }

    function getReloadHref() {
        const video = getMainVideoElement?.() || document.querySelector("video");
        const currentTime = Number(video?.currentTime);
        if (!Number.isFinite(currentTime) || currentTime <= 1) return location.href;

        try {
            const url = new URL(location.href);
            if (!url.searchParams.has("currentTime")) {
                url.searchParams.set("currentTime", String(Math.floor(currentTime)));
            }
            return url.href;
        } catch (_) {
            return location.href;
        }
    }

    function reloadOnceForReplayChat() {
        if (!routeNeedsReplayChatFix || !isVodRoute()) {
            return;
        }
        if (hasReplayChat() || hasRecentReloadMark()) {
            routeNeedsReplayChatFix = false;
            return;
        }
        if (isExpandedPlayerLayout() || isLayoutSettling() || !hasPlayableVod()) return;
        if (performance.now() - routeStartedAt < MIN_RELOAD_DELAY_MS) return;

        setReloadMark();
        location.replace(getReloadHref());
    }

    function scheduleChecks({ spaNavigation = false } = {}) {
        routeStartedAt = performance.now();
        routeNeedsReplayChatFix = spaNavigation && isVodRoute();
        checkSeq += 1;
        const seq = checkSeq;
        for (const delay of CHECK_DELAYS_MS) {
            setTimeout(() => {
                if (seq !== checkSeq) return;
                reloadOnceForReplayChat();
            }, delay);
        }
    }

    const scheduleObserverCheck = createThrottledDomSync(reloadOnceForReplayChat, OBSERVER_THROTTLE_MS);

    function handlePageChange() {
        if (location.href === lastHref) return;
        const previousVodRouteKey = lastVodRouteKey;
        lastHref = location.href;
        lastVodRouteKey = getVodRouteKey();

        if (!lastVodRouteKey) {
            routeNeedsReplayChatFix = false;
            checkSeq += 1;
            return;
        }

        if (lastVodRouteKey !== previousVodRouteKey) {
            scheduleChecks({ spaNavigation: true });
        }
    }

    function startObserver() {
        if (observer) return;

        const config = {
            childList: true,
            subtree: true,
        };

        observer = new MutationObserver(() => {
            lastLayoutMutationAt = performance.now();
            handlePageChange();
            if (routeNeedsReplayChatFix && isVodRoute() && !hasReplayChat() && !hasRecentReloadMark()) {
                scheduleObserverCheck();
            }
        });

        if (document.body) {
            observer.observe(document.body, config);
            return;
        }

        bodyObserver = new MutationObserver(() => {
            if (!document.body) return;
            bodyObserver.disconnect();
            bodyObserver = null;
            observer.observe(document.body, config);
            scheduleChecks({ spaNavigation: false });
        });
        bodyObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    function installRuntime({ checkCurrentRoute = false } = {}) {
        if (!runtimeInstalled) {
            runtimeInstalled = true;
            if (!removePageChangeDetection) {
                removePageChangeDetection = startPageChangeDetection(handlePageChange);
            }
            startObserver();
        }
        scheduleChecks({ spaNavigation: checkCurrentRoute });
    }

    onReady(() => {
        installRuntime();
    });
})();
