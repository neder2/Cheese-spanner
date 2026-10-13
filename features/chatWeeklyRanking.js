/** 채팅 상단의 주간 랭킹 영역 숨김. 2026-09-12 실제 접힘·펼침 구조, 2026-10-12 공개 번들의 랭킹 없음·통나무 파워 펼침 상태 기준. */
(() => {
    const { bindFeatureOptions, injectStyleOnce } = BetterChzzk.utils;
    const STYLE_ID = "betterchzzk-chat-weekly-ranking-style";
    // Restrict to direct children of the chat aside, excluding messages and reward notices.
    // States: collapsed list, empty week (collapsed/expanded), log power expanded, donation expanded.
    const RANKING_BOX_SELECTORS = Object.freeze([
        'aside#aside-chatting > div:has(> button[class*="_ranking_button_"])',
        'aside#aside-chatting > div:has(> div > [class*="_no_ranking_header_"])',
        'aside#aside-chatting > div:has(> div[class*="_contents_"] > button[class*="_no_ranking_button_"])',
        'aside#aside-chatting > div:has(> div[class*="_show_power_"])',
        'aside#aside-chatting > div:has(> div > strong > button[class*="_refresh_button_"]):has([class*="_icon_ranking_"])',
    ]);
    // 채팅 멀티뷰가 칸(네이티브 채팅 팝업) 문서에서도 같은 랭킹 상자만 숨기도록 공유해요.
    BetterChzzk.chatWeeklyRanking = Object.freeze({ RANKING_BOX_SELECTORS });
    const STYLE_TEXT = `
${RANKING_BOX_SELECTORS.join(",\n")}{
    display:none!important;
}
`;
    bindFeatureOptions((options) => {
        if (options.chatWeeklyRankingHidden) injectStyleOnce(STYLE_ID, STYLE_TEXT);
        else document.getElementById(STYLE_ID)?.remove();
    });
})();
