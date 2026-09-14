/**
 * 2026-09-14 치지직 헤더 실측 구조에 한정해 상단 버튼을 숨긴다.
 * 알림은 치트키 링크 바로 앞의 버튼 항목이며, New 배지 유무로 판별하지 않는다.
 * CSS로 항목을 숨겨 SPA 이동·DOM 교체에도 적용하고 원본 DOM은 유지한다.
 */
(() => {
    "use strict";

    const { bindFeatureOptions, injectStyleOnce, onReady } = BetterChzzk.utils;
    const targets = [
        ["headerStudioHidden", '#header a[href^="https://studio.chzzk.naver.com/"]'],
        ["headerCheeseHidden", '#header div:has(> a[href="https://game.naver.com/profile#cash"])'],
        [
            "headerNotificationHidden",
            '#header div:has(> button):has(+ div > a[href="https://game.naver.com/profile#cheat_key"])',
        ],
    ];
    let options = {};

    function syncStyles() {
        for (const [key, selector] of targets) {
            const id = `betterchzzk-header-${key}-style`;
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
