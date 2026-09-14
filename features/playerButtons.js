/**
 * 2026-09-14 라이브·VOD에서 실측한 클립·PIP 버튼만 숨긴다.
 * CSS가 SPA 이동과 컨트롤 재마운트에도 적용되어 별도 DOM 감시가 필요하지 않다.
 */
(() => {
    "use strict";

    const { bindFeatureOptions, injectStyleOnce, onReady } = BetterChzzk.utils;
    const targets = [
        ["playerClipHidden", ".pzp-pc__bottom-buttons-right button.custom__clip-button"],
        ["playerPipHidden", ".pzp-pc__bottom-buttons-right button.pzp-pc__pip-button"],
    ];
    let options = {};

    function syncStyles() {
        for (const [key, selector] of targets) {
            const id = `betterchzzk-player-${key}-style`;
            if (!options[key]) {
                document.getElementById(id)?.remove();
            } else if (document.documentElement) {
                injectStyleOnce(id, `${selector} { display: none !important; }`);
            }
        }
    }

    bindFeatureOptions((nextOptions) => {
        options = nextOptions;
        syncStyles();
    });
    onReady(syncStyles);
})();
