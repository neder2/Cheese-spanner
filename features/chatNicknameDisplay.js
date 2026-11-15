/** 채팅 닉네임만 시각적으로 숨긴다. 배지·본문·작성자 정체성과 접근성 이름은 보존한다. */
(() => {
    "use strict";
    if (window.top !== window) return;
    const root = window.CheeseSpanner;
    const { bindFeatureOptions, injectStyleOnce, verifiedMarks } = root.utils;
    const STYLE_ID = "cheese-spanner-chat-nickname-style";
    // The native author badge slot identifies broadcasters/managers even when collection is off.
    const roleBadgeSelector =
        '> span[class*="_wrapper_"] > span[class*="_icon_"] > span[class*="_container_"] > img:is([alt="스트리머"],[alt="채팅 운영자"])';
    // Native live/popup/replay nickname trees: only the text sibling of the verified mark.
    // Direct-child boundaries exclude message images, nested profiles and other channel names.
    const selectors = ["aside#aside-chatting", "aside#vod-aside"].flatMap((aside) =>
        verifiedMarks.families.map(
            ({ id }) =>
                `${aside} [role="log"] button[class*="_nickname_"] > span[class*="_is_message_"]:not(:has(${roleBadgeSelector})) > span[class*="_nickname_"] > span[class*="_ellipsis_${id}_"]:not(:has(> i[class*="_mark_${id}_"]:is([class*="_is_partner_${id}_"],[class*="_is_challenger_${id}_"]))) > span[class*="_text_${id}_"]`
        )
    );
    // Clipping removes the visible name without removing text from the native accessible button
    // or making the chat parser lose its author when it reads native visibility.
    const STYLE_TEXT = `${selectors.join(",\n")} {
        position:absolute!important;
        inline-size:1px!important;
        block-size:1px!important;
        padding:0!important;
        margin:-1px!important;
        border:0!important;
        overflow:hidden!important;
        clip-path:inset(50%)!important;
        white-space:nowrap!important;
    }`;
    root.chatNicknameDisplay = Object.freeze({ STYLE_TEXT });
    bindFeatureOptions((options) => {
        if (options.chatNicknameHidden) injectStyleOnce(STYLE_ID, STYLE_TEXT);
        else document.getElementById(STYLE_ID)?.remove();
    });
})();
