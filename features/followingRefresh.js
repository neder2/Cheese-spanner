(() => {
    // 치지직은 탭이 다시 보이거나 창이 포커스를 받을 때 사이드바 팔로잉 목록을
    // 스스로 다시 불러온다(react-query/SWR 계열의 refetch-on-focus 동작).
    // 그 복귀 신호를 주기적으로 합성해 치지직이 자기 코드로 목록을 갱신하게 한다.
    // 사이드바 DOM을 직접 수정하지 않으므로 React와 충돌할 여지가 없다.
    const { normalizeOptions } = BetterChzzkSettings;
    const { bindFeatureOptions } = BetterChzzk.utils;

    let featureOptions = normalizeOptions();
    let refreshTimer = null;

    function isEnabled() {
        return featureOptions.followingRefreshEnabled;
    }

    function getIntervalMs() {
        const seconds = Number(featureOptions.followingRefreshSeconds);
        return (Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000;
    }

    function triggerSidebarRefresh() {
        // 백그라운드 탭은 건드리지 않는다 — 실제 복귀 시 치지직이 알아서 갱신한다.
        if (document.visibilityState !== "visible") return;
        if (navigator.onLine === false) return;

        document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
        window.dispatchEvent(new Event("focus"));
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
