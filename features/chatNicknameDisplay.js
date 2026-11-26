/** 채팅 닉네임만 시각적으로 숨긴다. 배지·본문·작성자 정체성과 접근성 이름은 보존한다. */
(() => {
    "use strict";
    if (window.top !== window) return;
    const root = window.CheeseSpanner;
    const { bindFeatureOptions, injectStyleOnce, verifiedMarks } = root.utils;
    const STYLE_ID = "cheese-spanner-chat-nickname-style";
    const NATIVE_ROLE_ATTR = "data-bcct-native-nickname-role";
    const NATIVE_NAME_PATH =
        ' > span[class*="_is_message_"] > span[class*="_nickname_"] > span[class*="_ellipsis_"] > span[class*="_text_"]';
    let enabled = false;
    // The native author badge slot identifies broadcasters/managers even when collection is off.
    const roleBadgeSelector =
        '> span[class*="_wrapper_"] > span[class*="_icon_"] > span[class*="_container_"] > img:is([alt="스트리머"],[alt="채팅 운영자"])';
    // Native live/popup/replay nickname trees: only the text sibling of the verified mark.
    // Direct-child boundaries exclude message images, nested profiles and other channel names.
    const selectors = ["aside#aside-chatting", "aside#vod-aside"].flatMap((aside) =>
        verifiedMarks.families.map(
            ({ id }) =>
                `${aside} [role="log"] button[class*="_nickname_"]:not([${NATIVE_ROLE_ATTR}]) > span[class*="_is_message_"]:not(:has(${roleBadgeSelector})) > span[class*="_nickname_"] > span[class*="_ellipsis_${id}_"]:not(:has(> i[class*="_mark_${id}_"]:is([class*="_is_partner_${id}_"],[class*="_is_challenger_${id}_"]))) > span[class*="_text_${id}_"]`
        )
    );
    for (const aside of ["aside#aside-chatting", "aside#vod-aside"]) {
        selectors.push(
            `${aside} [role="log"] button[class*="_nickname_"][${NATIVE_ROLE_ATTR}="none"]${NATIVE_NAME_PATH}`
        );
    }
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
    function clearNativeRoles(container = document) {
        if (container instanceof Element) container.removeAttribute(NATIVE_ROLE_ATTR);
        for (const button of container.querySelectorAll?.("[" + NATIVE_ROLE_ATTR + "]") || []) {
            button.removeAttribute(NATIVE_ROLE_ATTR);
        }
    }

    function syncRole(parsed) {
        const author = parsed?.authorEl;
        const button = author instanceof Element ? author.closest('button[class*="_nickname_"]') : null;
        if (!button || !parsed.node?.contains(button)) return;
        if (
            !enabled ||
            parsed.nativeCoherent !== true ||
            parsed.roleSource !== "native" ||
            !button.querySelector(":scope" + NATIVE_NAME_PATH)
        ) {
            button.removeAttribute(NATIVE_ROLE_ATTR);
            return;
        }
        const role = parsed.role || "none";
        if (button.getAttribute(NATIVE_ROLE_ATTR) !== role) button.setAttribute(NATIVE_ROLE_ATTR, role);
    }

    // The existing chat controller owns observation and cleanup. This module only applies the
    // shared, coherent role result to the native author slot and never hides its badges or button.
    root.chatNicknameDisplay = Object.freeze({ STYLE_TEXT, syncRole, clearNativeRoles });
    bindFeatureOptions((options) => {
        enabled = options.chatNicknameHidden === true;
        if (enabled) injectStyleOnce(STYLE_ID, STYLE_TEXT);
        else {
            document.getElementById(STYLE_ID)?.remove();
            clearNativeRoles();
        }
    });
})();
