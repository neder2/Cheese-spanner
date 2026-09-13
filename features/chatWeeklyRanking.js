/** 채팅 상단의 주간 랭킹 영역 숨김. 2026-09-12 실제 접힘·펼침 구조 기준. */
(() => {
    const { bindFeatureOptions, injectStyleOnce } = BetterChzzk.utils;
    const STYLE_ID = "betterchzzk-chat-weekly-ranking-style";
    // Restrict to direct children of the chat aside, excluding messages and reward notices.
    const STYLE_TEXT = `
aside#aside-chatting > div:has(> button[class*="_ranking_button_"]),
aside#aside-chatting > div:has(> div > strong > button[class*="_refresh_button_"]):has([class*="_icon_ranking_"]){
    display:none!important;
}
`;
    bindFeatureOptions((options) => {
        if (options.chatWeeklyRankingHidden) injectStyleOnce(STYLE_ID, STYLE_TEXT);
        else document.getElementById(STYLE_ID)?.remove();
    });
})();
