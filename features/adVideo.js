/** 광고 설정을 MAIN world에 전달한다. 활성화는 다음 문서의 초기 주입부터 적용한다. */
(() => {
    "use strict";

    const STATE_ATTR = "data-cheese-spanner-ad-video-state";
    const STATE_EVENT = "cheese-spanner:ad-video:state";
    let enabled = false;
    let optionsLoaded = false;
    function publishState() {
        if (!optionsLoaded || !document.documentElement) return;
        if (globalThis.chrome?.runtime?.id) {
            document.documentElement.setAttribute("data-cheese-spanner-ad-video-extension-id", chrome.runtime.id);
        }
        document.documentElement.setAttribute(STATE_ATTR, enabled ? "1" : "0");
        document.dispatchEvent(new Event(STATE_EVENT));
    }
    CheeseSpanner.utils.bindFeatureOptions((options) => {
        enabled = options.adVideoEnabled;
        optionsLoaded = true;
        publishState();
    });
    CheeseSpanner.utils.onReady(publishState);
})();
