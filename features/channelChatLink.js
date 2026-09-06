/**
 * 채널 정보 탭 옆에 채팅을 볼 수 있는 일반 라이브 화면 링크를 붙인다. 방송이 꺼져 있어도 사용할 수 있다.
 * isolated world: settings/data/content 이후 로드. 추가 API 조회나 채팅 전송은 하지 않는다.
 */
(() => {
    const LINK_ID = "betterchzzk-channel-chat-link";
    const STYLE_ID = "betterchzzk-channel-chat-link-style";
    const ABOUT_SELECTOR = '[role="tablist"] > button[role="tab"][id="about"]';
    const WATCH_SELECTOR = `${ABOUT_SELECTOR}, [role="tablist"], a[href*="game.naver.com/profile/"], #${LINK_ID}`;
    const { bindFeatureOptions, createMutationObserverSync, injectStyleOnce, startPageChangeDetection } =
        BetterChzzk.utils;
    let enabled = false;
    let observer = null;
    let removeRouteListener = null;
    let frame = 0;
    let link = null;

    function getChannelId() {
        return /^\/([a-f0-9]{32})(?:\/(?:about|videos|clips|community))?\/?$/i.exec(location.pathname)?.[1] || "";
    }

    function findAbout(channelId) {
        const main = document.getElementById("layout-body");
        // SPA 이동 중 이전 채널의 탭이 남아 있을 수 있으므로 현재 프로필과 함께 확인한다.
        if (!main?.querySelector(`a[href="https://game.naver.com/profile/${channelId}"]`)) return null;
        return main.querySelector(ABOUT_SELECTOR);
    }

    function removeLink() {
        link?.remove();
        link = null;
    }

    function sync() {
        frame = 0;
        const channelId = enabled ? getChannelId() : "";
        const about = channelId ? findAbout(channelId) : null;
        if (!about) {
            removeLink();
            return;
        }
        if (!link) {
            link = document.createElement("a");
            link.id = LINK_ID;
            link.textContent = "채팅";
            link.setAttribute("aria-label", "채팅이 있는 라이브 화면으로 이동");
            const validateTarget = (event) => {
                if (
                    event.currentTarget !== link ||
                    !enabled ||
                    getChannelId() !== link?.dataset.channelId ||
                    findAbout(getChannelId()) !== link?.previousElementSibling
                ) {
                    event.preventDefault();
                    if (event.currentTarget === link) removeLink();
                    schedule();
                }
            };
            link.addEventListener("click", validateTarget);
            link.addEventListener("auxclick", validateTarget);
        }
        const href = `/live/${channelId}`;
        if (link.getAttribute("href") !== href) link.setAttribute("href", href);
        if (link.dataset.channelId !== channelId) link.dataset.channelId = channelId;
        if (link.className !== about.className) link.className = about.className;
        if (about.nextElementSibling !== link) about.after(link);
    }

    function schedule() {
        if (!frame && enabled) frame = requestAnimationFrame(sync);
    }

    function shouldSchedule(mutations) {
        return mutations.some((mutation) => {
            if (mutation.target === link || link?.contains(mutation.target)) return false;
            if (mutation.type === "attributes") return mutation.target.matches(WATCH_SELECTOR);
            return [...mutation.addedNodes, ...mutation.removedNodes].some(
                (node) =>
                    node instanceof Element &&
                    // 자신의 삽입은 무시하되 React가 링크를 제거한 경우에는 다시 붙인다.
                    !(node === link && [...mutation.addedNodes].includes(node)) &&
                    (node.matches(WATCH_SELECTOR) || node.querySelector(WATCH_SELECTOR))
            );
        });
    }

    function stopPage() {
        observer?.disconnectAll();
        observer = null;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        removeLink();
    }

    function handleRoute() {
        stopPage();
        if (!enabled || !getChannelId()) return;
        observer = createMutationObserverSync({
            target: () => document.getElementById("layout-body"),
            options: { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "class", "id"] },
            shouldSchedule,
            schedule,
            onObserved: schedule,
            onBodyReady: schedule,
        });
        schedule();
    }

    bindFeatureOptions((options) => {
        const next = options.channelChatLinkEnabled;
        if (enabled === next) return;
        enabled = next;
        if (enabled) {
            injectStyleOnce(
                STYLE_ID,
                `
#${LINK_ID}{display:block;box-sizing:border-box;flex-shrink:0;text-decoration:none;cursor:pointer;
font-size:16px;line-height:22px;padding:8px 15px 13px;color:var(--color-content-05,#697183)}
#${LINK_ID}:hover,#${LINK_ID}:focus-visible{color:var(--color-content-04,#424a58)}
#${LINK_ID}:focus-visible{outline:2px solid currentColor;outline-offset:-2px}
`
            );
            removeRouteListener = startPageChangeDetection(handleRoute);
            handleRoute();
        } else {
            removeRouteListener?.();
            removeRouteListener = null;
            stopPage();
            document.getElementById(STYLE_ID)?.remove();
        }
    });
})();
