const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { readRepoFile } = require("./helpers/extension-page-fixture.js");

const MODULE = "shared/uiTheme.js";
const STYLE_ID = "betterchzzk-ui-theme";
const FONT_PATH = "vendor/fonts/PretendardVariable.woff2";
const EXTENSION_ORIGIN = "chrome-extension://cheese-spanner-test/";

// spec §3.2, measured from the public CHZZK CSS on 2026-10-17
// (docs/measurements/chzzk-design-tokens-2026-10-17.md): [variable, semantic token, dark, light].
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
const STATIC_TOKENS = [
    ["--bct-radius-sm", "var(--sem-radius-sm, 6px)"],
    ["--bct-radius-md", "var(--sem-radius-md, 8px)"],
    ["--bct-radius-lg", "var(--sem-radius-lg, 12px)"],
    ["--bct-radius-full", "var(--sem-radius-circular, 9999px)"],
    [
        "--bct-font",
        '"BetterChzzk Pretendard", -apple-system, BlinkMacSystemFont, system-ui, "Malgun Gothic", sans-serif',
    ],
    ["--bct-shadow", "0 4px 4px 0 var(--bct-shadow-color-strong), 0 4px 12px 4px var(--bct-shadow-color)"],
    ["--bct-focus-ring", "var(--bct-brand-text)"],
];
const ROOT_SELECTORS = {
    base: ":root",
    light: ':root.light, :root[data-theme="light"]',
    dark: ':root.theme_dark, :root[data-theme="dark"], :root[data-theme="theme_dark"]',
};

function compact(value) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .replace(/\s*,\s*/g, ", ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .trim();
}

function createPage(t, { html = "<!doctype html><html><head></head><body></body></html>", scripts } = {}) {
    const dom = new JSDOM(html, {
        url: "https://chzzk.naver.com/live/test-channel",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const urlRequests = [];
    dom.window.chrome = {
        runtime: {
            getURL(path) {
                urlRequests.push(path);
                return EXTENSION_ORIGIN + path;
            },
        },
    };
    t.after(() => dom.window.close());
    for (const file of scripts || ["shared/data.js", "content.js", MODULE]) dom.window.eval(readRepoFile(file));
    return { dom, window: dom.window, document: dom.window.document, urlRequests };
}

function themeStyle(document) {
    return document.getElementById(STYLE_ID);
}

function styleRules(style) {
    return Array.from(style.sheet.cssRules).filter((rule) => rule.constructor.name === "CSSStyleRule");
}

function ruleFor(style, selector) {
    return styleRules(style).find((rule) => compact(rule.selectorText) === selector);
}

function rootValue(window, name) {
    return compact(window.getComputedStyle(window.document.documentElement).getPropertyValue(name));
}

function luminance(hex) {
    const channels = hex
        .replace("#", "")
        .match(/../g)
        .slice(0, 3)
        .map((part) => parseInt(part, 16) / 255)
        .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
    const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (high + 0.05) / (low + 0.05);
}

test("loading the theme module merges one request function and injects nothing until a feature asks", (t) => {
    const page = createPage(t, { scripts: ["shared/data.js", "content.js"] });
    const before = { ...page.window.BetterChzzk.utils };
    const styleCount = page.document.querySelectorAll("style").length;
    page.window.eval(readRepoFile(MODULE));
    const { utils } = page.window.BetterChzzk;

    assert.equal(typeof utils.ensureUiTheme, "function");
    for (const [name, value] of Object.entries(before)) assert.equal(utils[name], value, `utils.${name} is preserved`);
    assert.equal(themeStyle(page.document), null);
    assert.equal(page.document.querySelectorAll("style").length, styleCount);
    assert.deepEqual(page.urlRequests, []);
    assert.equal(rootValue(page.window, "--bct-text"), "");
});

test("the theme module refuses to load ahead of content.js instead of registering a broken request", (t) => {
    const page = createPage(t, { scripts: ["shared/data.js"] });
    assert.throws(() => page.window.eval(readRepoFile(MODULE)), /content\.js/);
    assert.equal(page.window.BetterChzzk.utils.ensureUiTheme, undefined);
    assert.equal(themeStyle(page.document), null);
});

test("the first request injects one root style and repeated requests do nothing", (t) => {
    const page = createPage(t);
    const { ensureUiTheme } = page.window.BetterChzzk.utils;

    ensureUiTheme();
    const style = themeStyle(page.document);
    assert.ok(style);
    assert.equal(style.parentNode, page.document.documentElement);
    const text = style.textContent;
    ensureUiTheme();
    ensureUiTheme();

    assert.equal(page.document.querySelectorAll(`#${STYLE_ID}`).length, 1);
    assert.equal(themeStyle(page.document), style);
    assert.equal(style.textContent, text);
    assert.deepEqual(page.urlRequests, [FONT_PATH]);
});

test("the injected style only declares theme variables and the single bundled font face", (t) => {
    const page = createPage(t);
    page.window.BetterChzzk.utils.ensureUiTheme();
    const style = themeStyle(page.document);
    const css = style.textContent;
    const fontUrl = EXTENSION_ORIGIN + FONT_PATH;

    const rules = Array.from(style.sheet.cssRules);
    assert.deepEqual(
        rules.map((rule) => rule.constructor.name),
        ["CSSFontFaceRule", "CSSStyleRule", "CSSStyleRule", "CSSStyleRule"]
    );
    assert.deepEqual(
        styleRules(style).map((rule) => compact(rule.selectorText)),
        [ROOT_SELECTORS.base, ROOT_SELECTORS.light, ROOT_SELECTORS.dark]
    );
    for (const rule of styleRules(style)) {
        assert.ok(rule.style.length > 0);
        for (let index = 0; index < rule.style.length; index += 1)
            assert.match(rule.style[index], /^--bct-[a-z-]+$/, `${rule.selectorText} declares only theme variables`);
    }

    const fontFaces = css.match(/@font-face\s*\{[^}]*\}/g) || [];
    assert.equal(fontFaces.length, 1);
    assert.match(fontFaces[0], /font-family:\s*"BetterChzzk Pretendard"\s*[;}]/);
    assert.match(fontFaces[0], /font-weight:\s*100 900\s*[;}]/);
    assert.match(fontFaces[0], /font-style:\s*normal\s*[;}]/);
    assert.match(fontFaces[0], /font-display:\s*swap\s*[;}]/);
    assert.equal(fontFaces[0].match(/url\(/g).length, 1);
    assert.ok(fontFaces[0].includes(`src:url("${fontUrl}") format("woff2")`));
    assert.doesNotMatch(css.replace(`src:url("${fontUrl}")`, ""), /url\(|@import|https?:|\/\//i);
    assert.doesNotMatch(readRepoFile(MODULE), /https?:\/\/|@import/i);
    assert.match(css, /Pretendard[^*]*SIL OFL 1\.1: vendor\/fonts\/Pretendard\.LICENSE\.txt/);

    const manifest = JSON.parse(readRepoFile("manifest.json"));
    const access = manifest.web_accessible_resources.filter((entry) => entry.resources.includes(FONT_PATH));
    assert.equal(access.length, 1);
    assert.deepEqual(access[0].matches, ["https://chzzk.naver.com/*"]);
});

test("theme variables follow CHZZK semantic tokens with one fallback set chosen by the root markers", (t) => {
    const page = createPage(t);
    page.window.BetterChzzk.utils.ensureUiTheme();
    const style = themeStyle(page.document);
    const base = ruleFor(style, ROOT_SELECTORS.base);
    const light = ruleFor(style, ROOT_SELECTORS.light);
    const dark = ruleFor(style, ROOT_SELECTORS.dark);

    assert.equal(base.style.length, COLOR_TOKENS.length + STATIC_TOKENS.length);
    assert.equal(light.style.length, COLOR_TOKENS.length);
    assert.equal(dark.style.length, COLOR_TOKENS.length);
    for (const [name, token, darkValue, lightValue] of COLOR_TOKENS) {
        assert.equal(compact(base.style.getPropertyValue(name)), `var(${token}, ${darkValue})`, name);
        assert.equal(compact(light.style.getPropertyValue(name)), `var(${token}, ${lightValue})`, name);
        assert.equal(compact(dark.style.getPropertyValue(name)), `var(${token}, ${darkValue})`, name);
    }
    for (const [name, value] of STATIC_TOKENS) {
        assert.equal(compact(base.style.getPropertyValue(name)), value, name);
        assert.equal(light.style.getPropertyValue(name), "", `${name} does not depend on the theme`);
    }

    const root = page.document.documentElement;
    const expectTheme = (label, values) => {
        assert.equal(
            rootValue(page.window, "--bct-bg"),
            `var(--sem-color-background-neutral-base, ${values[0]})`,
            label
        );
        assert.equal(rootValue(page.window, "--bct-brand-text"), `var(--sem-color-content-brand-strong, ${values[1]})`);
    };
    const darkValues = ["#141517", "#00ffa3"];
    const lightValues = ["#ffffff", "#23815a"];
    expectTheme("no marker uses the CHZZK default dark", darkValues);
    for (const [className, theme, values] of [
        ["light", null, lightValues],
        ["", "light", lightValues],
        ["light", "light", lightValues],
        ["theme_dark", "dark", darkValues],
        ["theme_dark", "theme_dark", darkValues],
        ["theme_dark", null, darkValues],
        ["", "dark", darkValues],
        ["light", "dark", darkValues],
    ]) {
        root.className = className;
        if (theme === null) root.removeAttribute("data-theme");
        else root.setAttribute("data-theme", theme);
        expectTheme(`class="${className}" data-theme=${theme}`, values);
    }
});

test("fallback text colors keep 4.5:1 on CHZZK backgrounds and panel surfaces in both themes", () => {
    const values = Object.fromEntries(COLOR_TOKENS.map(([name, , dark, light]) => [name, { dark, light }]));
    for (const theme of ["dark", "light"]) {
        for (const background of ["--bct-bg", "--bct-surface"]) {
            for (const text of [
                "--bct-text",
                "--bct-text-body",
                "--bct-text-muted",
                "--bct-brand-text",
                "--bct-danger",
            ]) {
                const ratio = contrast(values[text][theme], values[background][theme]);
                assert.ok(ratio >= 4.5, `${theme} ${text} on ${background}: ${ratio.toFixed(2)}`);
            }
        }
    }
    assert.ok(contrast(values["--bct-on-brand"].dark, values["--bct-brand"].dark) >= 4.5);
    assert.ok(contrast(values["--bct-on-brand"].light, values["--bct-brand"].light) >= 4.5);
});

test("manifest loads the theme module once, in the isolated world, right after content.js and before consumers", () => {
    const manifest = JSON.parse(readRepoFile("manifest.json"));
    const entries = manifest.content_scripts.filter((entry) => entry.js?.includes(MODULE));
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.notEqual(entry.world, "MAIN");
    assert.equal(entry.js.filter((file) => file === MODULE).length, 1);
    const themeIndex = entry.js.indexOf(MODULE);
    assert.equal(themeIndex, entry.js.indexOf("content.js") + 1);
    for (const file of entry.js) {
        if (file.startsWith("features/") || file === "shared/updateGuideView.js")
            assert.ok(entry.js.indexOf(file) > themeIndex, `${file} loads after ${MODULE}`);
    }

    const mainWorld = manifest.content_scripts.filter((item) => item.world === "MAIN").flatMap((item) => item.js);
    assert.equal(mainWorld.includes(MODULE), false);
    require("../shared/adVideoRegistration.js");
    assert.equal(globalThis.BetterChzzkAdVideoRegistration.CONTENT_SCRIPT.js.includes(MODULE), false);
    assert.doesNotMatch(readRepoFile("background.js"), /uiTheme/);
    for (const page of ["options.html", "history.html", "replay-pending.html"])
        assert.doesNotMatch(readRepoFile(page), /uiTheme/, `${page} keeps its own extension page tokens`);
});
