(() => {
    // CHZZK owns the actual sidebar refetch. Keep a cached handle to its native
    // refresh button instead of synthesizing global focus events every tick.
    const { normalizeOptions } = BetterChzzkSettings;
    const { bindFeatureOptions, normSpace } = BetterChzzk.utils;

    const REFRESH_BUTTON_SELECTOR = "button[aria-label], [role=\"button\"][aria-label]";
    const REFRESH_LABEL_RE = /새로고침|refresh/i;
    const FOLLOWING_SECTION_RE = /팔로(잉|우)|following|follow/i;
    const FOLLOWING_HREF_RE = /(^|\/)following(?:[/?#]|$)/i;

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
        return REFRESH_LABEL_RE.test(normSpace(el.getAttribute("aria-label")));
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

        for (const button of buttons) {
            let node = button.parentElement;

            for (let depth = 0; node && node !== document.body && depth < 7; depth += 1, node = node.parentElement) {
                if (hasFollowingSignal(node)) {
                    cachedRefreshButton = button;
                    return button;
                }

                const refreshButtons = Array.from(node.querySelectorAll(REFRESH_BUTTON_SELECTOR)).filter(isRefreshButton);
                if (refreshButtons.length > 1) break;
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

    function startRefreshTimer() {
        if (refreshTimer) return;
        refreshTimer = setInterval(triggerSidebarRefresh, getIntervalMs());
    }

    function stopRefreshTimer() {
        if (!refreshTimer) return;
        clearInterval(refreshTimer);
        refreshTimer = null;
    }

    function applyOptions(options) {
        featureOptions = options;
        stopRefreshTimer();
        if (isEnabled()) startRefreshTimer();
    }

    bindFeatureOptions(applyOptions);
})();
