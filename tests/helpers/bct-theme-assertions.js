// Helpers for in-page UI that is styled with the shared theme variables of shared/uiTheme.js (--bct-*).
// JSDOM keeps var() text in computed values, so resolveCssVars substitutes it from the element's custom
// properties (with each var() fallback when the property is missing), the way Chrome resolves it.

const COLOR_LITERAL_RE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi;

function findClosingParen(text, open) {
    let depth = 0;
    for (let index = open; index < text.length; index += 1) {
        if (text[index] === "(") depth += 1;
        else if (text[index] === ")" && --depth === 0) return index;
    }
    throw new Error(`Unbalanced var() in ${text}`);
}

function topLevelComma(text) {
    let depth = 0;
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === "(") depth += 1;
        else if (text[index] === ")") depth -= 1;
        else if (text[index] === "," && depth === 0) return index;
    }
    return -1;
}

function resolveCssVars(window, element, value, depth = 0) {
    if (depth > 16) throw new Error(`var() nests too deeply: ${value}`);
    const text = String(value ?? "");
    let output = "";
    let cursor = 0;
    for (let start = text.indexOf("var(", cursor); start >= 0; start = text.indexOf("var(", cursor)) {
        const end = findClosingParen(text, start + 3);
        const inner = text.slice(start + 4, end);
        const comma = topLevelComma(inner);
        const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
        const own = window.getComputedStyle(element).getPropertyValue(name).trim();
        const replacement = own || (comma < 0 ? "" : inner.slice(comma + 1).trim());
        output += text.slice(cursor, start) + resolveCssVars(window, element, replacement, depth + 1);
        cursor = end + 1;
    }
    return (output + text.slice(cursor))
        .replace(/\s+/g, " ")
        .replace(/\s*,\s*/g, ", ")
        .trim();
}

function computedThemeValue(window, element, property) {
    return resolveCssVars(window, element, window.getComputedStyle(element).getPropertyValue(property));
}

// Names of the shared theme variables a style uses, e.g. ["--bct-text", "--bct-radius-md"].
function themeVariableNames(cssText) {
    return Array.from(new Set((String(cssText).match(/var\(--bct-[a-z-]+/g) || []).map((match) => match.slice(4))));
}

function colorLiterals(cssText) {
    return String(cssText).match(COLOR_LITERAL_RE) || [];
}

// Style rules with the ones nested in @media; JSDOM gives style rules an empty cssRules list of their own.
function flattenStyleRules(rules) {
    return Array.from(rules).flatMap((rule) =>
        rule.type !== 1 && rule.cssRules ? flattenStyleRules(rule.cssRules) : [rule]
    );
}

// Selector and declaration text of each rule, read from the source text so that declarations JSDOM cannot
// parse (var() in shorthands, color-mix) are still checked. Rules nested in @media keep their own selector.
function cssBlocks(cssText) {
    return String(cssText)
        .split("}")
        .filter((block) => block.includes("{"))
        .map((block) => {
            const parts = block.split("{");
            return { selector: parts.at(-2).trim(), declarations: parts.at(-1).trim() };
        });
}

// The feature's own style must request the shared theme instead of carrying CHZZK tokens, theme selectors,
// static fallbacks for shared variables or its own @font-face; every shared variable it uses must exist.
function assertUsesSharedTheme(assert, window, style, label) {
    const css = style.textContent;
    const theme = window.document.getElementById("cheese-spanner-ui-theme");
    assert.ok(theme, `${label} requests the shared theme`);
    assert.ok(
        theme.compareDocumentPosition(style) & window.Node.DOCUMENT_POSITION_FOLLOWING,
        `${label} requests the shared theme before inserting its own style`
    );
    assert.doesNotMatch(css, /@font-face|PretendardVariable|url\(/, `${label} relies on the shared font face`);
    assert.doesNotMatch(css, /var\(--sem-|var\(--[A-Z]/, `${label} reads CHZZK tokens only through --bct-*`);
    assert.doesNotMatch(css, /var\(--bct-[a-z-]+\s*,/, `${label} adds no fallback to shared variables`);
    assert.doesNotMatch(css, /theme_dark|\[data-theme|\[dark\]|\[theme=/, `${label} keeps no theme tables`);
    const names = themeVariableNames(css);
    assert.ok(names.length > 0, `${label} uses shared variables`);
    const root = window.document.documentElement;
    for (const name of names)
        assert.notEqual(window.getComputedStyle(root).getPropertyValue(name).trim(), "", `${name} exists`);
    return names;
}

module.exports = {
    assertUsesSharedTheme,
    colorLiterals,
    computedThemeValue,
    cssBlocks,
    flattenStyleRules,
    resolveCssVars,
    themeVariableNames,
};
