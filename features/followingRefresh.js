/**
 * features/followingRefresh.js — 팔로잉 사이드바를 주기적으로 자동 새로고침한다.
 *
 * 동작 위치: isolated world, chzzk.naver.com 전역(팔로잉 사이드바가 있는 모든 페이지).
 * 하는 일: DOM에서 팔로잉 사이드바의 네이티브 새로고침 버튼을 찾아 캐시해두고, setInterval로
 *   주기적으로 button.click()을 호출해 CHZZK 자체 refetch 로직을 그대로 트리거한다. 탭이 보이지
 *   않거나(document.visibilityState) 오프라인(navigator.onLine)이면 주기 새로고침을 건너뛰고,
 *   탭이 다시 보이면 즉시 한 번 새로고침한 뒤 그 시점부터 주기를 다시 계산한다.
 * 의존: 전역 CheeseSpannerSettings.normalizeOptions, CheeseSpanner.utils.bindFeatureOptions/normSpace.
 * 옵션 키: followingRefreshEnabled, followingRefreshSeconds.
 */
(() => {
    // CHZZK owns the actual sidebar refetch. Keep a cached handle to its native
    // refresh button instead of synthesizing global focus events every tick.
    const { normalizeOptions } = CheeseSpannerSettings;
    const { bindFeatureOptions, normSpace } = CheeseSpanner.utils;

    const REFRESH_BUTTON_SELECTOR = 'button[aria-label], [role="button"][aria-label]';
    const EXTENSION_OWNED_ROOT_SELECTOR = "[id^='cheese-spanner-']";
    const REFRESH_LABEL_RE = /새로고침|refresh/i;
    const FOLLOWING_SECTION_RE = /팔로(잉|우)|following|follow/i;
    const FOLLOWING_HREF_RE = /(^|\/)following(?:[/?#]|$)/i;
    // 2026-09-11 실측한 팔로잉 구역이에요. 이 구역이 있으면 그 안의 버튼만 써요.
    const FOLLOWING_SECTION_SELECTOR = '#sidebar nav[aria-label="팔로우"]';
    // 대체 탐색에서 팔로잉 신호 없이 이 경계를 지나면 다른 구역의 버튼이에요.
    const SECTION_BOUNDARY_SELECTOR = "nav, section, [role='region']";

    let featureOptions = normalizeOptions();
    let refreshTimer = null;
    let cachedRefreshButton = null;

    function isEnabled() {
        return featureOptions.followingRefreshEnabled;
    }

    function getIntervalMs() {
        const seconds = Number(featureOptions.followingRefreshSeconds);
        return (Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000;
    }

    function isRefreshButton(el) {
        return (
            !el.closest(EXTENSION_OWNED_ROOT_SELECTOR) &&
            REFRESH_LABEL_RE.test(normSpace(el.getAttribute("aria-label")))
        );
    }

    function isUsableRefreshButton(button) {
        return Boolean(
            button &&
            button.isConnected &&
            isRefreshButton(button) &&
            !button.disabled &&
            button.getAttribute("aria-disabled") !== "true"
        );
    }

    function hasFollowingSignal(root) {
        if (FOLLOWING_SECTION_RE.test(normSpace(root.textContent))) return true;

        return Array.from(root.querySelectorAll("a[href]")).some((anchor) => {
            const href = anchor.getAttribute("href") || "";
            return FOLLOWING_HREF_RE.test(href);
        });
    }

    function findFollowingRefreshButton() {
        if (isUsableRefreshButton(cachedRefreshButton)) return cachedRefreshButton;
        cachedRefreshButton = null;

        const buttons = Array.from(document.querySelectorAll(REFRESH_BUTTON_SELECTOR)).filter(isRefreshButton);

        // 팔로잉 구역을 접어 그 버튼이 없을 때 다른 구역 버튼으로 대신하지 않아요.
        const section = document.querySelector(FOLLOWING_SECTION_SELECTOR);
        if (section) {
            cachedRefreshButton = buttons.find((button) => section.contains(button)) || null;
            return cachedRefreshButton;
        }

        for (const button of buttons) {
            let node = button.parentElement;

            for (let depth = 0; node && node !== document.body && depth < 7; depth += 1, node = node.parentElement) {
                // 여러 구역을 함께 담은 조상의 팔로잉 글자는 이 버튼의 구역을 알려 주지 않으므로 먼저 멈춰요.
                const refreshButtons = Array.from(node.querySelectorAll(REFRESH_BUTTON_SELECTOR)).filter(
                    isRefreshButton
                );
                if (refreshButtons.length > 1) break;

                if (hasFollowingSignal(node)) {
                    cachedRefreshButton = button;
                    return button;
                }

                if (node.matches(SECTION_BOUNDARY_SELECTOR)) break;
            }
        }

        return null;
    }

    function clickFollowingRefreshButton() {
        const button = findFollowingRefreshButton();
        if (!isUsableRefreshButton(button)) return false;

        button.click();
        return true;
    }

    function triggerSidebarRefresh() {
        if (document.visibilityState !== "visible") return;
        if (navigator.onLine === false) return;

        clickFollowingRefreshButton();
    }

    function restartRefreshTimer() {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(triggerSidebarRefresh, getIntervalMs());
    }

    function handleVisibilityChange() {
        if (!isEnabled() || document.visibilityState !== "visible") return;

        triggerSidebarRefresh();
        restartRefreshTimer();
    }

    function startRefreshTimer() {
        if (refreshTimer) return;
        restartRefreshTimer();
        document.addEventListener("visibilitychange", handleVisibilityChange, true);
    }

    function stopRefreshTimer() {
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
        document.removeEventListener("visibilitychange", handleVisibilityChange, true);
    }

    function applyOptions(options) {
        featureOptions = options;
        stopRefreshTimer();
        if (isEnabled()) startRefreshTimer();
    }

    bindFeatureOptions(applyOptions);
})();
