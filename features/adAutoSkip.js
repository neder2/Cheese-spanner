/**
 * 광고 중 활성화된 치지직 SKIP 버튼만 한 번 클릭한다.
 * 2026-09-08 라이브: .pzp-pc--adbreak, .vod_player_wrap.pc,
 * button.btn_skip[data-role="skipBtn"] 및 hide 클래스의 해제를 확인했다.
 * 광고나 본방송 영상의 시간·배속·재생 상태는 변경하지 않는다.
 */
(() => {
    "use strict";

    const PLAYER_SELECTOR = ".chzzk_player .pzp-pc";
    const BUTTON_SELECTOR = '.vod_player_wrap.pc > button.btn_skip[data-role="skipBtn"]';
    const { bindFeatureOptions, createMutationObserverSync, isPlaybackRoute, isVisible, mutationMatchesSelector } =
        BetterChzzk.utils;
    let enabled = false;
    let observer = null;
    let hostObserver = null;
    let removeRouteListener = null;
    let player = null;
    let button = null;
    let clickedButton = null;
    let clickAttempts = 0;

    function publishStatus() {
        document.documentElement?.setAttribute(
            "data-betterchzzk-ad-auto-skip-status",
            JSON.stringify({ enabled, clickAttempts })
        );
    }

    function syncButton() {
        if (!enabled || !isPlaybackRoute() || !player?.isConnected) return;
        if (!player.classList.contains("pzp-pc--adbreak")) {
            button = null;
            clickedButton = null;
            return;
        }
        const available = Array.from(player.querySelectorAll(BUTTON_SELECTOR)).filter(
            (candidate) =>
                !candidate.disabled &&
                candidate.getAttribute("aria-disabled") !== "true" &&
                !candidate.closest('[hidden], [aria-hidden="true"], .hide') &&
                isVisible(candidate)
        );
        button = available.length === 1 ? available[0] : null;
        if (!button) {
            clickedButton = null;
            return;
        }
        if (clickedButton === button) return;
        clickedButton = button;
        clickAttempts += 1;
        publishStatus();
        button.click();
    }

    function wasUnavailable(mutation) {
        const { attributeName, oldValue } = mutation;
        if (attributeName === "hidden" || attributeName === "disabled") return oldValue !== null;
        if (attributeName === "aria-hidden" || attributeName === "aria-disabled") return oldValue === "true";
        if (attributeName === "class") return /(?:^|\s)hide(?:\s|$)/.test(oldValue || "");
        if (attributeName === "style") {
            const style = document.createElement("span").style;
            style.cssText = oldValue || "";
            return style.display === "none" || style.visibility === "hidden";
        }
        return false;
    }

    function onMutations(mutations) {
        let relevant = false;
        for (const mutation of mutations) {
            if (mutation.type === "attributes") {
                const target = mutation.target;
                if (
                    target === player ||
                    target.contains(player) ||
                    mutationMatchesSelector(mutation, BUTTON_SELECTOR)
                ) {
                    relevant = true;
                    if (
                        (clickedButton &&
                            (target === clickedButton || target.contains(clickedButton)) &&
                            wasUnavailable(mutation)) ||
                        (target === player &&
                            mutation.attributeName === "class" &&
                            !/(?:^|\s)pzp-pc--adbreak(?:\s|$)/.test(mutation.oldValue || ""))
                    ) {
                        clickedButton = null;
                    }
                }
            } else {
                if (
                    clickedButton &&
                    Array.from(mutation.removedNodes).some(
                        (node) => node === clickedButton || node.contains(clickedButton)
                    )
                ) {
                    clickedButton = null;
                    relevant = true;
                }
                if (mutationMatchesSelector(mutation, BUTTON_SELECTOR)) relevant = true;
            }
        }
        if (relevant) syncButton();
    }

    function stopObserver() {
        observer?.disconnectAll();
        hostObserver?.disconnect();
        hostObserver = null;
        observer = null;
        player = null;
        button = null;
        clickedButton = null;
    }

    function syncRoute() {
        stopObserver();
        if (!enabled || !isPlaybackRoute()) return;
        observer = createMutationObserverSync({
            target: () => document.querySelector(PLAYER_SELECTOR),
            options: {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["class", "disabled", "aria-disabled", "aria-hidden", "hidden", "style"],
                attributeOldValue: true,
            },
            onObserved(_observer, node) {
                player = node;
                button = null;
                clickedButton = null;
                hostObserver?.disconnect();
                hostObserver = new MutationObserver(onMutations);
                // 가시성을 결정하는 부모 체인의 속성만 관찰한다. 형제나 전체 하위 트리는 감시하지 않는다.
                for (let target = node.parentElement; target; target = target.parentElement) {
                    hostObserver.observe(target, {
                        attributes: true,
                        attributeFilter: ["class", "style", "hidden", "aria-hidden"],
                        attributeOldValue: true,
                    });
                }
                syncButton();
            },
            onMutations,
        });
    }

    bindFeatureOptions((options) => {
        const nextEnabled = options.adAutoSkipEnabled;
        if (!document.documentElement?.hasAttribute("data-betterchzzk-ad-auto-skip-status")) publishStatus();
        if (enabled === nextEnabled) return;
        enabled = nextEnabled;
        publishStatus();
        if (enabled) {
            removeRouteListener = BetterChzzk.utils.startPageChangeDetection(syncRoute);
            syncRoute();
        } else {
            removeRouteListener?.();
            removeRouteListener = null;
            stopObserver();
        }
    });
})();
