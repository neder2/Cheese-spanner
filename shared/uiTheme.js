/**
 * shared/uiTheme.js — 치지직 안 확장 UI의 공통 테마 변수와 확장 글꼴 (window.CheeseSpanner.utils.ensureUiTheme)
 *
 * 실행 컨텍스트: isolated world 전용. manifest에서 content.js 바로 뒤, shared/updateGuideView.js와 모든 features/* 앞에 로드된다.
 *   MAIN world·서비스 워커·확장 페이지(options/history/replay-pending)는 이 파일을 읽지 않는다.
 * 하는 일: 기능이 처음 요청할 때 문서당 <style> 하나를 <html>에 넣는다. 요청 전에는 아무것도 하지 않는다.
 *   - :root의 --bct-* 변수는 치지직 시맨틱 토큰(--sem-*)을 그대로 따르고, 토큰이 없을 때만 아래 대체값을 쓴다.
 *   - 대체값은 2026-10-17 실측값 한 벌(docs/measurements/chzzk-design-tokens-2026-10-17.md)이며 루트 표식으로 고른다.
 *     라이트: html.light / html[data-theme="light"], 다크: html.theme_dark / html[data-theme="dark"|"theme_dark"],
 *     표식이 없으면 치지직 기본인 다크다. 두 표식이 엇갈리면 다크 규칙이 뒤에 있어 다크가 된다.
 *   - "CheeseSpanner Pretendard" @font-face를 확장 패키지 주소(chrome.runtime.getURL)로 한 번만 선언한다.
 *   - 변수와 @font-face만 담으므로 그 자체로는 화면에 보이는 효과가 없고, 기능이 꺼져도 지우지 않는다.
 * 의존: content.js의 CheeseSpanner.utils.injectStyleOnce. 기존 utils는 교체하지 않고 함수 하나만 병합한다.
 * 사용: 기능은 자기 스타일을 넣기 전에 CheeseSpanner.utils.ensureUiTheme?.()를 부르고, 대체값 없이 var(--bct-…)를 쓴다.
 */
(() => {
    "use strict";
    const root = (window.CheeseSpanner = window.CheeseSpanner || {});
    const utils = (root.utils = root.utils || {});
    if (typeof utils.injectStyleOnce !== "function") throw new Error("shared/uiTheme.js must load after content.js");

    const STYLE_ID = "cheese-spanner-ui-theme";
    const FONT_PATH = "vendor/fonts/PretendardVariable.woff2";
    const ROOT_RULE = ":root";
    const LIGHT_RULE = ':root.light,:root[data-theme="light"]';
    // Main-page React writes the mapped class value into data-theme as well, so dark accepts both spellings.
    const DARK_RULE = ':root.theme_dark,:root[data-theme="dark"],:root[data-theme="theme_dark"]';

    // [variable, CHZZK semantic token, dark fallback, light fallback]. The only fallback table for in-page UI.
    // Small text (<18px): --bct-text-dim is dark 3.7:1 and --bct-brand-text-base is light 4.1:1, so use them
    // only for large text, disabled states or non-text marks.
    const COLOR_TOKENS = [
        ["--bct-bg", "--sem-color-background-neutral-base", "#141517", "#ffffff"],
        ["--bct-surface", "--sem-color-surface-neutral-weaker", "#1c1d1f", "#ffffff"],
        ["--bct-surface-weak", "--sem-color-surface-neutral-weak", "#202224", "#f0f1f2"],
        ["--bct-surface-base", "--sem-color-surface-neutral-base", "#2e3033", "#e1e1e5"],
        ["--bct-hover", "--sem-color-surface-interaction-lighten-hovered", "#ffffff0d", "#0000000d"],
        ["--bct-border", "--sem-color-border-neutral-weak", "#2e3033", "#d0d1d3"],
        ["--bct-border-weaker", "--sem-color-border-neutral-weaker", "#202224", "#e1e1e5"],
        ["--bct-border-strong", "--sem-color-border-neutral-base", "#4d4d4d", "#c0c1c2"],
        ["--bct-border-alpha", "--sem-color-border-neutral-alpha-weak", "#ffffff26", "#00000026"],
        ["--bct-border-alpha-weaker", "--sem-color-border-neutral-alpha-weaker", "#ffffff1a", "#0000001a"],
        ["--bct-text", "--sem-color-content-neutral-primary", "#ffffff", "#0e0f10"],
        ["--bct-text-body", "--sem-color-content-neutral-cool-strong", "#c9cedc", "#2e3033"],
        ["--bct-text-muted", "--sem-color-content-neutral-cool-base", "#9da5b6", "#4d4d4d"],
        ["--bct-text-dim", "--sem-color-content-neutral-cool-weak", "#697183", "#6d6e70"],
        ["--bct-brand-text", "--sem-color-content-brand-strong", "#00ffa3", "#23815a"],
        ["--bct-brand-text-base", "--sem-color-content-brand-base", "#00e693", "#168f5c"],
        ["--bct-brand", "--sem-color-surface-brand-strongest-static", "#00ffa3", "#00ffa3"],
        ["--bct-on-brand", "--sem-color-content-neutral-inverse-static", "#0e0f10", "#0e0f10"],
        ["--bct-brand-weak", "--sem-color-surface-brand-alpha-weak", "#00ffa326", "#1bb37326"],
        ["--bct-danger", "--sem-color-content-accent-red-strong", "#ff5454", "#e02020"],
        ["--bct-shadow-color", "--sem-color-shadow-base", "#0003", "#0000000d"],
        ["--bct-shadow-color-strong", "--sem-color-shadow-strong", "#0000004d", "#0000001a"],
    ];
    // Theme-independent values. The shadow is CHZZK's most common popover elevation (2026-10-17 index CSS).
    const STATIC_TOKENS = [
        ["--bct-radius-sm", "var(--sem-radius-sm,6px)"],
        ["--bct-radius-md", "var(--sem-radius-md,8px)"],
        ["--bct-radius-lg", "var(--sem-radius-lg,12px)"],
        ["--bct-radius-full", "var(--sem-radius-circular,9999px)"],
        [
            "--bct-font",
            '"CheeseSpanner Pretendard",-apple-system,BlinkMacSystemFont,system-ui,"Malgun Gothic",sans-serif',
        ],
        ["--bct-shadow", "0 4px 4px 0 var(--bct-shadow-color-strong),0 4px 12px 4px var(--bct-shadow-color)"],
        ["--bct-focus-ring", "var(--bct-brand-text)"],
    ];

    let cssText = "";

    function colorDeclarations(themeIndex) {
        return COLOR_TOKENS.map((token) => `${token[0]}:var(${token[1]},${token[themeIndex]})`).join(";");
    }

    function readFontUrl() {
        try {
            const url = globalThis.chrome?.runtime?.getURL?.(FONT_PATH);
            return typeof url === "string" ? url : "";
        } catch (_error) {
            return "";
        }
    }

    function buildCss() {
        const fontUrl = readFontUrl();
        const fontFace = fontUrl
            ? `/* Pretendard 1.3.9, SIL OFL 1.1: vendor/fonts/Pretendard.LICENSE.txt */\n` +
              `@font-face{font-family:"CheeseSpanner Pretendard";src:url("${fontUrl}") format("woff2");` +
              `font-style:normal;font-weight:100 900;font-display:swap}\n`
            : "";
        const staticDeclarations = STATIC_TOKENS.map(([name, value]) => `${name}:${value}`).join(";");
        return (
            fontFace +
            `${ROOT_RULE}{${colorDeclarations(2)};${staticDeclarations}}\n` +
            `${LIGHT_RULE}{${colorDeclarations(3)}}\n` +
            `${DARK_RULE}{${colorDeclarations(2)}}\n`
        );
    }

    // Repeated requests reuse the built text; injectStyleOnce leaves an existing <style> untouched.
    function ensureUiTheme() {
        cssText ||= buildCss();
        utils.injectStyleOnce(STYLE_ID, cssText);
    }

    utils.ensureUiTheme = ensureUiTheme;
})();
