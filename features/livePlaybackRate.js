/** 라이브 자동 배속 방지 설정만 MAIN world에 전달한다. */
(() => {
    const STATE_ATTR = "data-cheese-spanner-live-playback-rate";
    const STATE_EVENT = "cheese-spanner:live-playback-rate:state";
    let enabled = false;
    let loaded = false;

    function publish() {
        const root = document.documentElement;
        if (!loaded || !root) return;
        const value = enabled ? "1" : "0";
        if (root.getAttribute(STATE_ATTR) === value) return;
        root.setAttribute(STATE_ATTR, value);
        window.dispatchEvent(new Event(STATE_EVENT));
    }

    CheeseSpanner.utils.bindFeatureOptions((options) => {
        enabled = options.livePlaybackRateLockEnabled === true;
        loaded = true;
        publish();
    });
    CheeseSpanner.utils.onReady(publish);
})();
