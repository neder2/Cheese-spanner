/** 채팅 목록의 후원 메시지만 CSS로 숨긴다. 메시지·후원 기록과 네이티브 DOM은 그대로 둔다. */
(() => {
    "use strict";
    if (window.top !== window) return;
    const root = window.CheeseSpanner;
    const { bindFeatureOptions, injectStyleOnce } = root.utils;
    const STYLE_ID = "cheese-spanner-chat-donation-messages-style";
    // 2026-11-08 public CHZZK bundle: CHAT, MISSION, and MISSION_PARTICIPATION/PARTY.
    // Match the measured component families, not message text, padding shared with purchases,
    // or the fixed mission board. The numeric CSS line suffix may change independently.
    const contents = [
        '[class*="_container_17em1_"]',
        '[class*="_container_2dqjk_"][class*="_is_message_2dqjk_"]',
        '[class*="_container_18byk_"]',
    ];
    const lists = [
        'aside#aside-chatting [role="log"] > [class*="_wrapper_"]',
        'aside#vod-aside [role="log"] > [class*="_list_"]',
    ];
    const selectors = lists.flatMap((list) =>
        contents.map((content) => `${list} > [class*="_item_"]:has(> ${content})`)
    );
    const STYLE_TEXT = `${selectors.join(",\n")}{display:none!important;}`;
    // Chat multiview applies this same rule inside its verified native chat documents.
    root.chatDonationMessages = Object.freeze({ STYLE_TEXT });
    bindFeatureOptions((options) => {
        if (options.chatDonationMessagesHidden) injectStyleOnce(STYLE_ID, STYLE_TEXT);
        else document.getElementById(STYLE_ID)?.remove();
    });
})();
