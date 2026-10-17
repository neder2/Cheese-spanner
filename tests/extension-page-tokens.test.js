const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { readRepoFile } = require("./helpers/extension-page-fixture.js");

const repoRoot = path.join(__dirname, "..");

// Shared code (for example shared/updateGuideView.js) falls back to these names, so the
// CHZZK alignment may change their values but must keep every name in every theme block.
const TOKEN_NAMES = [
    "--bg",
    "--surface",
    "--surface-2",
    "--surface-3",
    "--border",
    "--border-strong",
    "--text",
    "--text-muted",
    "--text-dim",
    "--accent",
    "--accent-text",
    "--accent-weak",
    "--accent-contrast",
    "--focus-ring",
    "--warning",
    "--warning-bg",
    "--danger",
    "--danger-bg",
    "--success-bg",
    "--success-border",
    "--history-level-2",
    "--history-level-3",
    "--bg-translucent",
    "--shadow-1",
    "--shadow-2",
];

// CHZZK --sem-* values measured on 2026-10-17 (dark :root / [data-theme=light]).
// Warning colors and the light danger color stay on their previous contrast-safe values
// because CHZZK has no matching token that keeps 4.5:1 on the extension surfaces.
const EXPECTED = {
    dark: {
        "color-scheme": "dark",
        "--bg": "#141517",
        "--surface": "#1c1d1f",
        "--surface-2": "#202224",
        "--surface-3": "#2e3033",
        "--border": "#2e3033",
        "--border-strong": "#4d4d4d",
        "--text": "#ffffff",
        "--text-muted": "#9da5b6",
        "--text-dim": "#9da5b6",
        "--accent": "#00ffa3",
        "--accent-text": "#00e693",
        "--accent-weak": "#00ffa326",
        "--accent-contrast": "#0e0f10",
        "--focus-ring": "#00e693",
        "--warning": "#ffd166",
        "--warning-bg": "rgba(255,209,102,0.12)",
        "--danger": "#ff5454",
        "--danger-bg": "rgba(255,84,84,0.12)",
        "--success-bg": "#00ffa31a",
        "--success-border": "#00ffa34d",
        "--history-level-2": "#00ffa34d",
        "--history-level-3": "#00ffa366",
        "--bg-translucent": "rgba(20,21,23,0.82)",
        "--shadow-1": "02px2px0#0000004d,02px6px2px#0003",
        "--shadow-2": "04px4px0#0000004d,04px12px4px#0003",
    },
    light: {
        "color-scheme": "light",
        "--bg": "#ffffff",
        "--surface": "#ffffff",
        "--surface-2": "#f0f1f2",
        "--surface-3": "#e1e1e5",
        "--border": "#d0d1d3",
        "--border-strong": "#c0c1c2",
        "--text": "#0e0f10",
        "--text-muted": "#4d4d4d",
        "--text-dim": "#6d6e70",
        "--accent": "#00ffa3",
        "--accent-text": "#23815a",
        "--accent-weak": "#1bb3730d",
        "--accent-contrast": "#0e0f10",
        "--focus-ring": "#23815a",
        "--warning": "#9f6b00",
        "--warning-bg": "rgba(255,190,76,0.18)",
        "--danger": "#c73737",
        "--danger-bg": "rgba(199,55,55,0.08)",
        "--success-bg": "#1bb3730d",
        "--success-border": "#1bb3734d",
        "--history-level-2": "#1bb37326",
        "--history-level-3": "#1bb3734d",
        "--bg-translucent": "rgba(255,255,255,0.85)",
        "--shadow-1": "02px2px0#0000001a,02px6px2px#0000000d",
        "--shadow-2": "04px4px0#0000001a,04px12px4px#0000000d",
    },
};

function normalize(value) {
    return String(value).replace(/\s+/g, "").toLowerCase();
}

function themeBlocks() {
    const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>");
    const style = dom.window.document.createElement("style");
    style.textContent = readRepoFile("styles.css");
    dom.window.document.head.append(style);
    const blocks = {};
    for (const rule of style.sheet.cssRules) {
        const selector = rule.selectorText?.replace(/\s+/g, " ").trim();
        if (selector === ':root, :root[data-theme="dark"]') blocks.dark = rule.style;
        if (selector === ':root[data-theme="light"]') blocks.light = rule.style;
        if (rule.media && /prefers-color-scheme:\s*light/.test(rule.conditionText)) {
            for (const inner of rule.cssRules) {
                if (inner.selectorText?.trim() === ":root:not([data-theme])") blocks.systemLight = inner.style;
            }
        }
    }
    dom.window.close();
    const read = (declaration) =>
        Object.fromEntries(
            Array.from({ length: declaration.length }, (_, index) => {
                const name = declaration[index];
                return [name, normalize(declaration.getPropertyValue(name))];
            })
        );
    return { dark: read(blocks.dark), light: read(blocks.light), systemLight: read(blocks.systemLight) };
}

function parseColor(value) {
    const text = normalize(value);
    let match = text.match(/^#([0-9a-f]{3,8})$/);
    if (match) {
        let hex = match[1];
        if (hex.length <= 4) hex = [...hex].map((digit) => digit + digit).join("");
        const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
        return [...channels, hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1];
    }
    match = text.match(/^rgba?\(([^)]+)\)$/);
    if (match) {
        const [red, green, blue, alpha = 1] = match[1].split(",").map(Number);
        return [red, green, blue, alpha];
    }
    throw new Error(`unsupported color ${value}`);
}

function composite(layers) {
    // layers: topmost first, opaque base last.
    let base = parseColor(layers[layers.length - 1]);
    assert.equal(base[3], 1, `${layers[layers.length - 1]} must be an opaque base`);
    for (let index = layers.length - 2; index >= 0; index--) {
        const top = parseColor(layers[index]);
        base = [0, 1, 2].map((channel) => top[channel] * top[3] + base[channel] * (1 - top[3])).concat(1);
    }
    return base;
}

function luminance([red, green, blue]) {
    const linear = [red, green, blue].map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground, ...backgroundLayers) {
    const background = composite(backgroundLayers);
    const text = composite([foreground, ...backgroundLayers]);
    const [high, low] = [luminance(text), luminance(background)].sort((a, b) => b - a);
    return (high + 0.05) / (low + 0.05);
}

test("extension page theme blocks keep every shared token name", () => {
    const blocks = themeBlocks();
    for (const [theme, declarations] of Object.entries(blocks)) {
        assert.deepEqual(
            Object.keys(declarations).sort(),
            ["color-scheme", ...TOKEN_NAMES].sort(),
            `${theme} block defines exactly the shared token names`
        );
    }
    assert.deepEqual(blocks.systemLight, blocks.light, "system light uses the explicit light values");
});

test("extension page tokens follow the measured CHZZK palette", () => {
    const blocks = themeBlocks();
    for (const theme of ["dark", "light"]) {
        for (const [name, value] of Object.entries(EXPECTED[theme])) {
            assert.equal(blocks[theme][name], normalize(value), `${theme} ${name}`);
        }
    }
    // Spec §3.4: these lighter CHZZK shades fail small-text contrast and stay out of text tokens.
    for (const name of ["--text", "--text-muted", "--text-dim", "--accent-text", "--focus-ring"]) {
        assert.notEqual(blocks.dark[name], "#697183", `dark ${name}`);
        assert.notEqual(blocks.light[name], "#168f5c", `light ${name}`);
    }
});

test("extension page token pairs keep small text at 4.5:1", () => {
    const blocks = themeBlocks();
    for (const theme of ["dark", "light"]) {
        const token = blocks[theme];
        const surfaces = [token["--bg"], token["--surface"], token["--surface-2"]];
        const pairs = [];
        for (const surface of surfaces) {
            for (const name of ["--text", "--text-muted", "--text-dim", "--danger"]) {
                pairs.push([`${name} on ${surface}`, token[name], surface]);
            }
        }
        for (const name of ["--text", "--text-muted"]) {
            pairs.push([`${name} on --surface-3`, token[name], token["--surface-3"]]);
        }
        // Brand text (spec §3.4 fixes light #23815a) and the retained warning colors are guarded on the
        // page and card surfaces.
        for (const surface of [token["--bg"], token["--surface"]]) {
            pairs.push([`--accent-text on ${surface}`, token["--accent-text"], surface]);
            pairs.push([
                `--accent-text on --accent-weak over ${surface}`,
                token["--accent-text"],
                token["--accent-weak"],
                surface,
            ]);
            pairs.push([`--warning on ${surface}`, token["--warning"], surface]);
        }
        // Deliberately skipped in light: #23815a on --surface-2 is about 4.26:1, so this pair must not be
        // used for small text. Its one current use (.history-entry-chats in styles.css) is restyled by the
        // history page task in history-layout.css.
        if (theme === "dark") {
            pairs.push(["--accent-text on --surface-2", token["--accent-text"], token["--surface-2"]]);
        }
        pairs.push(
            ["--accent-contrast on --accent", token["--accent-contrast"], token["--accent"]],
            ["--accent-text on --success-bg", token["--accent-text"], token["--success-bg"], token["--surface"]],
            ["--danger on --danger-bg", token["--danger"], token["--danger-bg"], token["--surface"]],
            ["--text on --accent-weak", token["--text"], token["--accent-weak"], token["--surface"]],
            ["--text on --history-level-2", token["--text"], token["--history-level-2"], token["--surface"]],
            ["--text on --history-level-3", token["--text"], token["--history-level-3"], token["--surface"]]
        );
        for (const [label, foreground, ...background] of pairs) {
            const ratio = contrast(foreground, ...background);
            assert.ok(ratio >= 4.5, `${theme} ${label}: ${ratio.toFixed(2)}`);
        }
        for (const surface of surfaces) {
            const ratio = contrast(token["--focus-ring"], surface);
            assert.ok(ratio >= 3, `${theme} focus ring on ${surface}: ${ratio.toFixed(2)}`);
        }
    }
});

test("bundled Pretendard stays the local extension page font", () => {
    const brand = readRepoFile("options-brand.css");
    assert.match(brand, /@font-face\s*\{[^}]*font-family:\s*"Pretendard Variable"/);
    assert.match(brand, /src:\s*url\("vendor\/fonts\/PretendardVariable\.woff2"\)/);
    assert.equal(/https?:\/\//.test(brand), false, "no remote font server");
    assert.ok(fs.existsSync(path.join(repoRoot, "vendor/fonts/PretendardVariable.woff2")));
    assert.match(brand, /--options-font:\s*"Pretendard Variable",/);
});

test("replay pending page uses the shared tokens, Pretendard, and polite copy without new behavior", () => {
    const source = readRepoFile("replay-pending.html");
    const dom = new JSDOM(source);
    const { document } = dom.window;
    try {
        assert.equal(document.title, "다시보기 찾는 중");
        assert.equal(document.documentElement.lang, "ko");
        assert.equal(
            document.documentElement.hasAttribute("data-theme"),
            false,
            "the page follows the system theme instead of optionsTheme"
        );
        assert.deepEqual(
            [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.getAttribute("href")),
            ["styles.css", "options-brand.css"]
        );
        assert.equal(document.querySelectorAll("script").length, 0, "navigation stays owned by history.js");
        assert.equal(/https?:\/\//.test(source), false, "no remote resources");

        const inline = [...document.querySelectorAll("style")].map((style) => style.textContent).join("\n");
        assert.equal(/\bCanvas(Text)?\b/.test(inline), false, "system colors are replaced by tokens");
        for (const name of ["--bg", "--surface", "--border", "--text", "--text-muted"]) {
            assert.match(inline, new RegExp(`var\\(${name}\\)`), name);
        }
        assert.match(inline, /font-family:\s*"Pretendard Variable",/);
        assert.equal(/#[0-9a-f]{3,8}\b/i.test(inline), false, "colors come from the shared tokens only");

        const main = document.querySelector("body > main");
        assert.deepEqual(
            [...main.children].map((child) => child.tagName),
            ["H1", "P", "P"]
        );
        assert.equal(main.querySelector("h1").textContent.trim(), "다시보기를 찾고 있어요");
        const paragraphs = [...main.querySelectorAll("p")].map((paragraph) =>
            paragraph.textContent.replace(/\s+/g, " ").trim()
        );
        assert.deepEqual(paragraphs, [
            "시청 기록에 저장된 방송 정보로 다시보기 번호를 조회하고 있어요.",
            "다시보기를 찾으면 이 탭에서 바로 이동해요. 잠시 후에도 이동하지 않으면 기록 목록에서 다시 시도해 주세요.",
        ]);
        assert.equal(/(습니다|입니다|합니다|됩니다)/.test(main.textContent), false, "visible copy uses 해요체");
    } finally {
        dom.window.close();
    }
});
