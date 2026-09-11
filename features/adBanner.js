/**
 * 치지직에서 확인한 광고 슬롯만 숨긴다. 광고 요청과 영상 재생에는 관여하지 않는다.
 * 2026-09-08 홈·라이브·VOD 실측 슬롯과 09-11 배포 코드의 광고 연동 RS 슬롯 ID를 사용한다.
 * CSS가 SPA 이동과 슬롯 교체에도 적용되므로 별도 DOM 감시가 필요하지 않다.
 */
(() => {
    "use strict";

    const STYLE_ID = "betterchzzk-ad-banner-style";
    const { bindFeatureOptions, injectStyleOnce, onReady } = BetterChzzk.utils;
    let enabled = false;

    function syncStyle() {
        if (!enabled) {
            document.getElementById(STYLE_ID)?.remove();
            return;
        }
        if (!document.documentElement) return;
        injectStyleOnce(
            STYLE_ID,
            `
#home_banner,
#live_end_banner,
#vod_end_banner,
#live_rs_banner,
#vod_rs_banner {
    display: none !important;
}
`
        );
    }

    bindFeatureOptions((options) => {
        enabled = options.adBannerEnabled;
        syncStyle();
    });
    onReady(syncStyle);
})();
