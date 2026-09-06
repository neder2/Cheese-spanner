/** Offline live-page start detection (isolated world).
 * Measured 2026-09-06 at /live/6c837d7222ccc4431ca7835a4340be8e:
 * #layout-body [class*='_player_'] contains p "다음 라이브를 기대해주세요!".
 * /service/v3/channels/{channelId}/live-detail returned code 200, status CLOSE,
 * liveId 20936615 and channel.channelId matching the route. OPEN is the live status.
 */
(() => {
    const { bindFeatureOptions, createMutationObserverSync, fetchJson, startPageChangeDetection } = BetterChzzk.utils;
    const PLAYER_SELECTOR = "[class*='_player_']";
    const END_SELECTOR = `#layout-body ${PLAYER_SELECTOR} p`;
    const POLL_MS = 30000;
    let enabled = false;
    let suspended = false;
    let observer = null;
    let removeRouteListener = null;
    let session = null;

    function currentChannel() {
        return location.pathname.match(/^\/live\/([a-f0-9]{32})\/?$/i)?.[1] || "";
    }

    function hasEndedScreen() {
        return Array.from(document.querySelectorAll(END_SELECTOR)).some(
            (node) => node.textContent.trim() === "다음 라이브를 기대해주세요!"
        );
    }

    function stopSession() {
        if (!session) return;
        window.clearTimeout(session.timer);
        session.controller?.abort();
        session = null;
    }

    function isCurrent(state) {
        return enabled && !suspended && session === state && currentChannel() === state.channelId && hasEndedScreen();
    }

    async function checkStatus(state) {
        if (!isCurrent(state) || state.reloaded) return;
        const controller = new AbortController();
        state.controller = controller;
        try {
            const json = await fetchJson(
                `https://api.chzzk.naver.com/service/v3/channels/${state.channelId}/live-detail`,
                { signal: controller.signal, timeoutMs: 10000, cache: "no-store" }
            );
            if (controller.signal.aborted || !isCurrent(state)) return;
            const content = json?.content;
            if (json?.code === 200 && content?.channel?.channelId === state.channelId) {
                if (content.status === "CLOSE") state.sawClosed = true;
                if (content.status === "OPEN" && state.sawClosed) {
                    // A new document must observe CLOSE again, preventing a stale end screen reload loop.
                    state.reloaded = true;
                    location.reload();
                }
            }
        } catch {
            // A timeout, denied request or malformed response never establishes a start.
        } finally {
            state.controller = null;
            if (isCurrent(state) && !state.reloaded) {
                state.timer = window.setTimeout(() => void checkStatus(state), POLL_MS);
            }
        }
    }

    function sync() {
        const channelId = enabled && !suspended ? currentChannel() : "";
        if (!channelId || !hasEndedScreen()) {
            stopSession();
            return;
        }
        if (session?.channelId === channelId) return;
        stopSession();
        session = { channelId, sawClosed: false, reloaded: false, timer: 0, controller: null };
        void checkStatus(session);
    }

    function touchesPlayer(node) {
        const element = node instanceof Element ? node : node.parentElement;
        return element && (element.closest(PLAYER_SELECTOR) || element.querySelector(PLAYER_SELECTOR));
    }

    function onPageHide() {
        suspended = true;
        stopSession();
    }

    function onPageShow() {
        suspended = false;
        sync();
    }

    bindFeatureOptions((options) => {
        enabled = options.offlineLiveReloadEnabled;
        if (enabled && !observer) {
            observer = createMutationObserverSync({
                target: () => document.getElementById("layout-body"),
                options: { childList: true, subtree: true, characterData: true },
                shouldSchedule: (mutations) =>
                    mutations.some(
                        (mutation) =>
                            touchesPlayer(mutation.target) ||
                            [...mutation.addedNodes, ...mutation.removedNodes].some(touchesPlayer)
                    ),
                schedule: sync,
                onObserved: sync,
                onBodyReady: sync,
            });
            removeRouteListener = startPageChangeDetection(() => {
                if (session?.channelId !== currentChannel()) stopSession();
                sync();
            });
            window.addEventListener("pagehide", onPageHide);
            window.addEventListener("pageshow", onPageShow);
        } else if (!enabled) {
            observer?.disconnectAll();
            observer = null;
            removeRouteListener?.();
            removeRouteListener = null;
            window.removeEventListener("pagehide", onPageHide);
            window.removeEventListener("pageshow", onPageShow);
            stopSession();
        }
        sync();
    });
})();
