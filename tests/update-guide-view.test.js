const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { evalRepoScript, readRepoFile } = require("./helpers/extension-page-fixture.js");

function fixture(t, { oneCard = false, summaryOnly = false, maliciousText = false } = {}) {
    const dom = new JSDOM(
        '<body><button id="opener">안내 열기</button><button id="elsewhere">다른 버튼</button><aside id="panel"><button data-bcpr-handle="chat"></button></aside></body>',
        { url: "https://chzzk.naver.com/live/test", runScripts: "outside-only", pretendToBeVisual: true }
    );
    const win = dom.window,
        doc = win.document,
        frames = new Map();
    let frameId = 0,
        closes = 0;
    win.requestAnimationFrame = (fn) => {
        frames.set(++frameId, fn);
        return frameId;
    };
    win.cancelAnimationFrame = (id) => frames.delete(id);
    evalRepoScript(dom, "shared/updateGuide.js");
    evalRepoScript(dom, "shared/updateGuideView.js");
    const guide = structuredClone(win.BetterChzzkUpdateGuide.getGuide("1.4.1"));
    if (oneCard) guide.cards = guide.cards.slice(0, 1);
    if (summaryOnly) guide.cards = [];
    if (maliciousText) {
        guide.cards[0].title = '<img src="bad" onerror="alert(1)">';
        guide.cards[0].instructions = ["<script>bad()</script>"];
    }
    const view = win.BetterChzzkUpdateGuideView.create({ document: doc, guide, onClose: () => closes++ });
    const opener = doc.getElementById("opener");
    opener.focus();
    t.after(() => {
        view.destroy();
        win.close();
    });
    const flush = async () => {
        await new Promise((resolve) => setImmediate(resolve));
    };
    return { win, doc, view, opener, guide, frames, flush, closes: () => closes };
}

test("one nonmodal window shows both features safely with one close control and focus return", async (t) => {
    const f = fixture(t, { maliciousText: true });
    assert.equal(f.view.open(), true);
    await f.flush();
    const root = f.doc.querySelector("[data-bcug-view]");
    assert.equal(root.getAttribute("aria-modal"), "false");
    assert.equal(root.querySelectorAll("li").length, 2);
    assert.equal(root.querySelector("h3").textContent, '<img src="bad" onerror="alert(1)">');
    assert.equal(root.querySelector("li p").textContent, "<script>bad()</script>");
    assert.equal(root.querySelector("img, script"), null);
    assert.match(root.textContent, /시청기록 백업 및 불러오기/);
    assert.equal(f.doc.activeElement, root.querySelector("h2"));
    assert.equal(root.querySelectorAll("button").length, 1);
    assert.equal(root.querySelector("button").getAttribute("aria-label"), "닫기");
    assert.equal(
        root.querySelector(
            '[data-bcug-action="previous"],[data-bcug-action="next"],[data-bcug-action="settings"],[data-bcug-action="complete"]'
        ),
        null
    );
    root.querySelector("button").click();
    assert.equal(f.doc.querySelector("[data-bcug-view]"), null);
    assert.equal(f.doc.activeElement, f.opener);
    assert.equal(f.closes(), 1);
});

test("Escape is scoped to guide focus and manually moved focus is never stolen", (t) => {
    const f = fixture(t);
    f.view.open();
    const elsewhere = f.doc.getElementById("elsewhere");
    elsewhere.focus();
    elsewhere.dispatchEvent(new f.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.ok(f.doc.querySelector("[data-bcug-view]"));
    f.view.close();
    assert.equal(f.doc.activeElement, elsewhere);
    f.view.open();
    f.doc.activeElement.dispatchEvent(new f.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(f.doc.querySelector("[data-bcug-view]"), null);
});

test("window and tab switches keep the same manual notice without restoring its focus", (t) => {
    const f = fixture(t);
    f.view.open();
    const root = f.doc.querySelector("[data-bcug-view]");
    const elsewhere = f.doc.getElementById("elsewhere");
    elsewhere.focus();
    f.win.dispatchEvent(new f.win.Event("blur"));
    Object.defineProperty(f.doc, "visibilityState", { configurable: true, value: "hidden" });
    f.doc.dispatchEvent(new f.win.Event("visibilitychange"));
    assert.equal(f.doc.querySelector("[data-bcug-view]"), root);
    assert.equal(f.closes(), 0);
    Object.defineProperty(f.doc, "visibilityState", { configurable: true, value: "visible" });
    f.doc.dispatchEvent(new f.win.Event("visibilitychange"));
    f.win.dispatchEvent(new f.win.Event("focus"));
    assert.equal(f.doc.querySelector("[data-bcug-view]"), root);
    assert.equal(f.doc.activeElement, elsewhere);
    f.view.close();
    assert.equal(f.doc.activeElement, elsewhere);
    assert.equal(f.closes(), 1);
});

test("two brief introductions are visible together without stream information or repeated explanations", (t) => {
    const f = fixture(t);
    f.view.open();
    const root = f.doc.querySelector("[data-bcug-view]");
    assert.deepEqual(
        [...root.querySelectorAll("h3")].map((node) => node.textContent),
        ["채팅창·사이드바 크기 조절", "시청기록 백업 및 불러오기"]
    );
    assert.deepEqual(
        [...root.querySelectorAll("li p")].map((node) => node.textContent),
        ["경계 드래그로 조절, 더블클릭으로 초기화."]
    );
    assert.equal(root.querySelectorAll("li")[1].textContent, "시청기록 백업 및 불러오기");
    assert.equal(root.querySelectorAll("li")[1].querySelector("p"), null);
    assert.doesNotMatch(root.textContent, /스트림|1 \/ 2|이전|다음|설정 보기|초록색|JSON|살펴보세요/);
    assert.equal(root.querySelectorAll("button").length, 1);
});

test("page target replacement and hiding do not add overlays, navigate or rebuild the notice", async (t) => {
    const f = fixture(t);
    f.view.open();
    const root = f.doc.querySelector("[data-bcug-view]");
    const firstItem = root.querySelector("li");
    const panel = f.doc.getElementById("panel");
    panel.hidden = true;
    panel.replaceChildren(f.doc.createElement("input"));
    panel.remove();
    f.win.dispatchEvent(new f.win.Event("resize"));
    f.win.dispatchEvent(new f.win.Event("scroll"));
    await f.flush();
    assert.equal(root.querySelector("li"), firstItem);
    assert.equal(f.doc.querySelector("[data-bcug-highlight],[data-bcug-location]"), null);
    assert.equal(f.frames.size, 0);
    assert.equal(f.doc.activeElement, root.querySelector("h2"));
});

test("one-item notice keeps only close and destroys its UI on fullscreen", async (t) => {
    const f = fixture(t, { oneCard: true });
    f.view.open();
    await f.flush();
    const root = f.doc.querySelector("[data-bcug-view]");
    assert.equal(root.querySelectorAll("li").length, 1);
    assert.equal(root.querySelectorAll("button").length, 1);
    Object.defineProperty(f.doc, "fullscreenElement", { configurable: true, value: f.doc.body });
    f.doc.dispatchEvent(new f.win.Event("fullscreenchange"));
    assert.equal(f.doc.querySelector("[data-bcug-view]"), null);
    assert.equal(f.frames.size, 0);
});

test("repeated open and destroy leave no duplicate UI or late visibility restoration", (t) => {
    const f = fixture(t);
    assert.equal(f.view.open(), true);
    assert.equal(f.view.open(), false);
    assert.equal(f.doc.querySelectorAll("[data-bcug-view]").length, 1);
    f.view.destroy();
    f.view.destroy();
    f.doc.dispatchEvent(new f.win.Event("visibilitychange"));
    assert.equal(f.view.open(), false);
    assert.equal(f.doc.querySelector("[data-bcug-view]"), null);
    assert.equal(f.closes(), 1);
    assert.equal(f.frames.size, 0);
});

test("summary-only releases show their authored summary without invented items or extra controls", (t) => {
    const f = fixture(t, { summaryOnly: true });
    f.view.open();
    const root = f.doc.querySelector("[data-bcug-view]");
    assert.ok(root.textContent.includes(f.guide.summary));
    assert.equal(root.querySelector("li"), null);
    assert.equal(root.querySelectorAll("button").length, 1);
    root.querySelector("button").click();
    assert.equal(f.doc.querySelector("[data-bcug-view]"), null);
});

// Extension page tokens (styles.css) the shared view may fall back to on the options page, which has no
// CHZZK theme module.
const EXTENSION_TOKENS = new Set([
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
    "--shadow-1",
    "--shadow-2",
    "--options-font",
]);

function splitTopLevel(text, separator) {
    const parts = [];
    let depth = 0,
        start = 0;
    for (let index = 0; index < text.length; index++) {
        if (text[index] === "(") depth++;
        else if (text[index] === ")") depth--;
        else if (text[index] === separator && depth === 0) {
            parts.push(text.slice(start, index));
            start = index + 1;
        }
    }
    parts.push(text.slice(start));
    return parts.map((part) => part.trim()).filter(Boolean);
}

// Top-level style rules of the shared CSS text; @media and @keyframes blocks only hold layout and motion.
function topLevelRules(css) {
    const rules = [];
    let index = 0;
    while (index < css.length) {
        const open = css.indexOf("{", index);
        if (open < 0) break;
        const selector = css.slice(index, open).trim();
        let depth = 1,
            close = open + 1;
        for (; close < css.length && depth; close++) {
            if (css[close] === "{") depth++;
            else if (css[close] === "}") depth--;
        }
        if (!selector.startsWith("@")) {
            const declarations = splitTopLevel(css.slice(open + 1, close - 1), ";").map((item) => {
                const colon = item.indexOf(":");
                return [item.slice(0, colon).trim(), item.slice(colon + 1).trim()];
            });
            rules.push({ selector, declarations });
        }
        index = close;
    }
    return rules;
}

// JSDOM keeps custom properties but does not substitute var(); follow the chain like the browser does.
function resolveVars(win, element, value, depth = 0) {
    assert.ok(depth < 20, `variable chain too deep: ${value}`);
    let output = "",
        index = 0;
    for (;;) {
        const start = value.indexOf("var(", index);
        if (start < 0) return output + value.slice(index);
        output += value.slice(index, start);
        let level = 0,
            end = start + 3,
            comma = -1;
        for (; end < value.length; end++) {
            if (value[end] === "(") level++;
            else if (value[end] === ")" && --level === 0) break;
            else if (value[end] === "," && level === 1 && comma < 0) comma = end;
        }
        const name = value.slice(start + 4, comma < 0 ? end : comma).trim();
        const own = win.getComputedStyle(element).getPropertyValue(name).trim();
        const next = own || (comma < 0 ? "" : value.slice(comma + 1, end).trim());
        assert.ok(next, `${name} resolves to a value`);
        output += resolveVars(win, element, next, depth + 1);
        index = end + 1;
    }
}

function parseColor(text) {
    const mix = text.match(/^color-mix\(in srgb,\s*(#[0-9a-f]{3,8})\s+([\d.]+)%,\s*transparent\)$/i);
    if (mix) {
        const [red, green, blue, alpha] = parseColor(mix[1]);
        return [red, green, blue, (alpha * Number(mix[2])) / 100];
    }
    if (/^transparent$/i.test(text)) return [0, 0, 0, 0];
    let hex = text.slice(1);
    if (hex.length <= 4) hex = [...hex].map((digit) => digit + digit).join("");
    const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
    return [...channels, hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1];
}

const COLOR_PATTERN =
    /color-mix\(in srgb,\s*#[0-9a-f]{3,8}\s+[\d.]+%,\s*transparent\)|#[0-9a-f]{3,8}\b|\btransparent\b/gi;

// Colors are compared as they appear on the card surface so translucent hover layers can be matched.
// Whitespace is dropped because JSDOM serializes custom property values with inconsistent spacing.
function describe(value, surface) {
    const colors = [];
    const text = value
        .replace(COLOR_PATTERN, (match) => {
            const [red, green, blue, alpha] = parseColor(match);
            colors.push([red, green, blue].map((channel, index) => channel * alpha + surface[index] * (1 - alpha)));
            return "<color>";
        })
        .replace(/\s+/g, "");
    return { text, colors };
}

function renderedGuide(t, { page, theme }) {
    const chzzk = page === "chzzk";
    const rootMarker = chzzk
        ? theme === "light"
            ? ' class="light" data-theme="light"'
            : ' class="theme_dark" data-theme="dark"'
        : ` data-theme="${theme}"`;
    const optionsStyles = chzzk
        ? ""
        : `<style>${readRepoFile("styles.css")}</style><style>${readRepoFile("options-brand.css")}</style>`;
    const dom = new JSDOM(
        `<!doctype html><html${rootMarker}><head>${optionsStyles}</head><body${chzzk ? "" : ' class="options-body"'}></body></html>`,
        {
            url: chzzk ? "https://chzzk.naver.com/live/test" : "chrome-extension://better-chzzk/options.html",
            runScripts: "outside-only",
            pretendToBeVisual: true,
        }
    );
    t.after(() => dom.window.close());
    if (chzzk) {
        dom.window.chrome = { runtime: { getURL: (file) => `chrome-extension://better-chzzk/${file}` } };
        for (const file of ["shared/data.js", "content.js", "shared/uiTheme.js"]) evalRepoScript(dom, file);
        dom.window.BetterChzzk.utils.ensureUiTheme();
    }
    evalRepoScript(dom, "shared/updateGuide.js");
    evalRepoScript(dom, "shared/updateGuideView.js");
    const views = dom.window.BetterChzzkUpdateGuideView;
    const guide = dom.window.BetterChzzkUpdateGuide.getGuide("1.4.1");
    const view = views.create({ document: dom.window.document, guide, focusOnOpen: false });
    assert.equal(view.open(), true);
    t.after(() => view.destroy());
    const root = dom.window.document.querySelector("[data-bcug-view]");
    const progress = dom.window.document.createElement("div");
    progress.dataset.bcugProgress = "";
    const fill = dom.window.document.createElement("span");
    fill.dataset.bcugProgressFill = "";
    progress.append(fill);
    root.prepend(progress);
    const resolve = (value, element = root) => resolveVars(dom.window, element, value);
    const surface = parseColor(resolve("var(--bcug-surface)"));
    const declarations = new Map();
    for (const rule of topLevelRules(views.CSS_TEXT)) {
        const plain = rule.selector.replace(/::?[a-z-]+(\([^)]*\))?/g, "");
        const element = splitTopLevel(plain, ",")
            .map((selector) => (root.matches(selector) ? root : root.querySelector(selector)))
            .find(Boolean);
        for (const [property, value] of rule.declarations) {
            if (property.startsWith("--")) continue;
            declarations.set(`${rule.selector} { ${property} }`, resolve(value, element || root));
        }
    }
    return { surface, declarations, resolve };
}

test("the new-version notice is a flat card without a gradient, decorative icon or its own theme palette", () => {
    const dom = new JSDOM("<body></body>", { runScripts: "outside-only" });
    evalRepoScript(dom, "shared/updateGuideView.js");
    const css = dom.window.BetterChzzkUpdateGuideView.CSS_TEXT;
    dom.window.close();
    assert.doesNotMatch(css, /gradient\(/i, "no radial or linear gradient decoration");
    assert.doesNotMatch(css, /url\(|[{;]\s*content\s*:/i, "no decorative sparkle icon or pseudo-element content");
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i, "no static color values");
    assert.doesNotMatch(css, /prefers-color-scheme|theme_dark|theme_light|data-theme|--sem-/, "no own theme table");
    const rules = topLevelRules(css);
    const aliases = rules.flatMap((rule) => rule.declarations).filter(([property]) => property.startsWith("--bcug-"));
    assert.ok(aliases.length >= 8);
    for (const [property, value] of aliases) {
        const match = value.match(/^var\((--bct-[a-z-]+),\s*(.+)\)$/);
        assert.ok(match, `${property} reads the shared CHZZK theme first`);
        const fallback = match[2];
        const extension = fallback.match(/^var\((--[a-z0-9-]+)\)$/) || fallback.match(/var\((--[a-z0-9-]+)\)/);
        if (extension) assert.ok(EXTENSION_TOKENS.has(extension[1]), `${property} falls back to ${extension[1]}`);
        else assert.match(fallback, /^\d+px$/, `${property} only falls back to an extension token or a radius`);
    }
    for (const rule of rules) {
        for (const [property, value] of rule.declarations) {
            if (property.startsWith("--") || !/color|background|border|outline|shadow|font-family/.test(property))
                continue;
            assert.doesNotMatch(value, /var\(--(?!bcug-)/, `${rule.selector} ${property} uses the notice aliases`);
        }
    }
});

test("the notice looks the same with CHZZK theme variables and with extension page tokens", (t) => {
    for (const theme of ["dark", "light"]) {
        const chzzk = renderedGuide(t, { page: "chzzk", theme });
        const options = renderedGuide(t, { page: "options", theme });
        assert.deepEqual([...chzzk.declarations.keys()], [...options.declarations.keys()]);
        for (const [key, value] of chzzk.declarations) {
            const other = options.declarations.get(key);
            if (/\{ font-family \}$/.test(key) && value !== "inherit") {
                assert.match(value, /^"BetterChzzk Pretendard",/, `${theme} CHZZK ${key} uses the bundled font`);
                assert.match(other, /^"Pretendard Variable",/, `${theme} options ${key} uses the bundled font`);
                continue;
            }
            if (/:focus-visible \{ outline \}$/.test(key)) {
                // Each surface keeps its own brand focus token (CHZZK --bct-focus-ring, options --focus-ring).
                assert.equal(value, `2px solid ${chzzk.resolve("var(--bct-focus-ring)")}`, `${theme} CHZZK ${key}`);
                assert.equal(other, `2px solid ${options.resolve("var(--focus-ring)")}`, `${theme} options ${key}`);
                continue;
            }
            const left = describe(value, chzzk.surface),
                right = describe(other, options.surface);
            assert.equal(left.text, right.text, `${theme} ${key}`);
            assert.equal(left.colors.length, right.colors.length, `${theme} ${key}`);
            left.colors.forEach((color, index) =>
                color.forEach((channel, part) =>
                    assert.ok(
                        Math.abs(channel - right.colors[index][part]) <= 2,
                        `${theme} ${key}: ${value} vs ${other}`
                    )
                )
            );
        }
        const card = "[data-bcug-view],[data-bcug-toast]";
        assert.ok(chzzk.declarations.size >= 40, "every drawn declaration is compared");
        assert.match(chzzk.declarations.get(`${card} { border-radius }`), /^12px$/);
        assert.equal(chzzk.declarations.get(`${card} { background }`), theme === "dark" ? "#1c1d1f" : "#ffffff");
        assert.equal(options.declarations.get(`${card} { background }`), theme === "dark" ? "#1c1d1f" : "#ffffff");
        assert.equal(
            chzzk.declarations.get("[data-bcug-heading] button:hover { background }"),
            theme === "dark" ? "#ffffff0d" : "#0000000d",
            "hover uses the shared CHZZK hover token"
        );
        assert.equal(
            chzzk.declarations.get("[data-bcug-progress-fill] { background }"),
            "#00ffa3",
            "the 20-second gauge keeps the brand fill"
        );
    }
});
