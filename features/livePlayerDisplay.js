/** Live badge visibility and the broadcast start clock (isolated world).
 * Measured 2026-09-06 at /live/55e243bd868e55adf3524c85f8db51b5:
 * .player_header .header_info contains the large LIVE em; the status row contains
 * _data_ > span._count_ with "스트리밍 중". v3 live-detail returned status OPEN,
 * liveId 20949832 and openDate "2026-09-06 06:23:31" (KST).
 */
(() => {
    const STYLE_ID = "betterchzzk-live-player-display-style";
    const CLOCK_ID = "betterchzzk-live-start-time";
    const HIDE_ATTR = "data-bclpd-hide-live";
    const STATUS_SELECTOR = "#layout-body [class*='_status_'] > [class*='_data_']";
    const ANCHOR_SELECTOR = `${STATUS_SELECTOR} > span[class*='_count_']`;
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        fetchJson,
        injectStyleOnce,
        parseChzzkDate,
        startPageChangeDetection,
    } = BetterChzzk.utils;
    let options = BetterChzzkSettings.normalizeOptions();
    let channelId = "";
    let request = null;
    let clockText = "";
    let clockEl = null;
    let anchorEl = null;
    let observer = null;
    let removeRouteListener = null;
    let suspended = false;

    function getChannelId() {
        return location.pathname.match(/^\/live\/([a-zA-Z0-9_-]+)\/?$/)?.[1] || "";
    }

    function removeClock() {
        clockEl?.remove();
        clockEl = null;
        anchorEl = null;
    }

    function isAnchor(node) {
        return node?.isConnected && node.matches?.(ANCHOR_SELECTOR) && /스트리밍 중\s*$/.test(node.textContent);
    }

    function renderClock() {
        if (!clockText || !channelId || getChannelId() !== channelId || !options.liveStartTimeEnabled) {
            removeClock();
            return;
        }
        const anchor = isAnchor(anchorEl)
            ? anchorEl
            : Array.from(document.querySelectorAll(ANCHOR_SELECTOR)).find(isAnchor);
        if (!anchor) {
            removeClock();
            return;
        }
        anchorEl = anchor;
        if (!clockEl) {
            clockEl = document.createElement("span");
            clockEl.id = CLOCK_ID;
        }
        if (clockEl.textContent !== clockText) clockEl.textContent = clockText;
        if (anchor.nextElementSibling !== clockEl) anchor.insertAdjacentElement("afterend", clockEl);
    }

    function touchesStatus(node) {
        const element = node instanceof Element ? node : node?.parentElement;
        if (!element || element.id === CLOCK_ID) return false;
        return (
            element.matches(STATUS_SELECTOR) ||
            element.closest(STATUS_SELECTOR) ||
            element.querySelector(STATUS_SELECTOR)
        );
    }

    function observeClock() {
        if (observer) return;
        observer = createMutationObserverSync({
            target: () => document.getElementById("layout-body"),
            options: {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true,
                attributeFilter: ["class"],
            },
            onMutations(mutations) {
                if (!clockText) return;
                if (
                    (anchorEl && !isAnchor(anchorEl)) ||
                    (clockEl && !clockEl.isConnected) ||
                    mutations.some((mutation) => {
                        if (mutation.target === clockEl || clockEl?.contains(mutation.target)) return false;
                        if (mutation.type === "childList") {
                            return [...mutation.addedNodes, ...mutation.removedNodes].some(touchesStatus);
                        }
                        return touchesStatus(mutation.target);
                    })
                )
                    renderClock();
            },
            onBodyReady: renderClock,
        });
    }

    function clearRequest() {
        request?.abort();
        request = null;
        channelId = "";
        clockText = "";
        observer?.disconnectAll();
        observer = null;
        removeClock();
    }

    async function loadStartTime(id, controller) {
        try {
            const json = await fetchJson(
                `https://api.chzzk.naver.com/service/v3/channels/${encodeURIComponent(id)}/live-detail`,
                { signal: controller.signal }
            );
            if (controller.signal.aborted || request !== controller || getChannelId() !== id) return;
            const content = json?.content;
            if (content?.status !== "OPEN") return;
            const start = parseChzzkDate(content.openDate);
            if (!start) return;
            const time = new Intl.DateTimeFormat("en-GB", {
                timeZone: "Asia/Seoul",
                hour: "2-digit",
                minute: "2-digit",
                hourCycle: "h23",
            }).format(start);
            clockText = `시작 ${time}`;
            observeClock();
            renderClock();
        } catch {
            // A missing or failed response does not establish a broadcast start time.
        }
    }

    function sync() {
        const id = suspended ? "" : getChannelId();
        const hideBadge = Boolean(id && options.hideLiveBadgeEnabled);
        if (hideBadge) document.documentElement.setAttribute(HIDE_ATTR, "1");
        else document.documentElement.removeAttribute(HIDE_ATTR);
        if (id && (options.hideLiveBadgeEnabled || options.liveStartTimeEnabled)) {
            injectStyleOnce(
                STYLE_ID,
                `
html[${HIDE_ATTR}="1"] .player_header .header_info em[class*='_live_'][class*='_large_']{display:none!important}
#${CLOCK_ID}{margin-left:8px;white-space:nowrap;font-size:13px;font-weight:600;line-height:16px;color:var(--sem-color-content-neutral-cool-strong,var(--Content-neutral,#545a69))}
html.theme_dark #${CLOCK_ID}{color:var(--sem-color-content-neutral-cool-strong,var(--Content-neutral,#c9cedc))}
`
            );
        } else document.getElementById(STYLE_ID)?.remove();
        const nextChannel = options.liveStartTimeEnabled ? id : "";
        if (nextChannel !== channelId) {
            clearRequest();
            channelId = nextChannel;
            if (channelId) {
                request = new AbortController();
                void loadStartTime(channelId, request);
            }
        }
        renderClock();
    }

    function onPageHide() {
        suspended = true;
        clearRequest();
        sync();
    }

    function onPageShow() {
        suspended = false;
        sync();
    }

    bindFeatureOptions((nextOptions) => {
        options = nextOptions;
        if (options.hideLiveBadgeEnabled || options.liveStartTimeEnabled) {
            if (!removeRouteListener) {
                removeRouteListener = startPageChangeDetection(sync);
                window.addEventListener("pagehide", onPageHide, true);
                window.addEventListener("pageshow", onPageShow, true);
            }
        } else {
            removeRouteListener?.();
            removeRouteListener = null;
            window.removeEventListener("pagehide", onPageHide, true);
            window.removeEventListener("pageshow", onPageShow, true);
        }
        sync();
    });
})();
