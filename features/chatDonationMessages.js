/** 채팅 목록의 후원 메시지만 CSS로 숨긴다. 메시지·후원 기록과 네이티브 DOM은 그대로 둔다. */
(() => {
    "use strict";
    if (window.top !== window) return;
    const root = window.CheeseSpanner;
    const { bindFeatureOptions, injectStyleOnce } = root.utils;
    const STYLE_ID = "cheese-spanner-chat-donation-messages-style";
    // Component families from the 2026-11-08 and 2026-11-15 public CHZZK bundles.
    // The mission message modifier distinguishes a chat row from the fixed mission board.
    const contents = [
        '[class*="_container_17em1_"]',
        '[class*="_container_120bf_"]',
        '[class*="_container_2dqjk_"][class*="_is_message_2dqjk_"]',
        '[class*="_container_1oei1_"][class*="_is_message_1oei1_"]',
        '[class*="_container_18byk_"]',
        '[class*="_container_baf00_"]',
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
