const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const {
    createFakeChrome,
    evalFeatureModules,
    evalRepoScript,
    readRepoFile,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

// Design rules (shared/AGENTS.md, features/AGENTS.md) for the discovery panels: category tools (방송 목록), video search (다시보기 검색) and the
// monthly broadcast calendar. Each panel asks for the shared CHZZK theme (shared/uiTheme.js) before its own
// style, keeps no theme fallback table of its own and keeps the two-class font rule in features/AGENTS.md.

const THEME_STYLE_ID = "betterchzzk-ui-theme";
const CATEGORY_STYLE_ID = "betterchzzk-category-tools-style";
const VIDEO_STYLE_ID = "betterchzzk-video-search-style";
const MONTHLY_STYLE_ID = "betterchzzk-monthly-broadcast-time-style";
const MONTHLY_CHANNEL_ID = "0123456789abcdef0123456789abcdef";
const MONTHLY_FONT_FAMILY =
    '"Sandoll Nemony2", "Sandoll Nemony", "Apple SD Gothic Neo", "Apple SD Gothic NEO", "Malgun Gothic", "맑은 고딕", sans-serif';
// Badges drawn on top of card media keep theme-independent colors (features/AGENTS.md).
const CATEGORY_FIXED_COLOR_SELECTORS = ['[data-bcgt-follower-badge="1"]', '[data-bcgt-live-elapsed-badge="1"]'];
const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(|\b(?:white|black)\b/i;
const THEME_SELECTOR = /\[class\*=|\[dark\]|\[theme=|theme_dark|data-theme|(?:^|[\s,(])\.light\b/;

function setRect(element, { left = 0, top = 0, width = 100, height = 40 } = {}) {
    element.getBoundingClientRect = () => ({
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
    });
}

async function waitFor(read, options) {
    let value;
    await waitForCondition(() => (value = read()), options);
    return value;
}

function flush() {
    return new Promise((resolve) => setTimeout(resolve, 20));
}

async function loadPage(t, { html, url, sync, folder, feature, extraShared = [], prepare, disableKey }) {
    const chrome = createFakeChrome({ sync });
    chrome.runtime.getURL = (path) => `chrome-extension://cheese-spanner-test/${path}`;
    const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
    dom.window.chrome = chrome;
    dom.window.HTMLCanvasElement.prototype.getContext = () => null;
    dom.window.fetch = async () => ({
        ok: true,
        json: async () => ({ content: { data: [], last: true, page: { next: null } } }),
    });
    t.after(async () => {
        for (const listener of [...chrome.testState.storageChangeListeners])
            listener({ [disableKey]: { newValue: false } }, "sync");
        await flush();
        dom.window.close();
    });
    prepare?.(dom.window.document, dom.window);
    // Same order as the manifest's isolated content script: content.js, then the shared theme, then features.
    for (const file of ["shared/settings.js", "shared/data.js", "content.js", "shared/uiTheme.js", ...extraShared])
        evalRepoScript(dom, ...file.split("/"));
    evalFeatureModules(dom, folder);
    evalRepoScript(dom, "features", feature);
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await flush();
    return { dom, window: dom.window, document: dom.window.document, chrome };
}

function loadCategoryPage(t, prepare) {
    return loadPage(t, {
        html: [
            "<!doctype html><body>",
            '<nav id="tabs"><button>라이브</button><button>동영상</button><button>클립</button></nav>',
            '<main id="grid">',
            '<article id="card-a"><a href="/live/channel-a"><strong>Alpha live</strong><span>LIVE 10명</span></a></article>',
            '<article id="card-b"><a href="/live/channel-b"><strong>Beta live</strong><span>LIVE 20명</span></a></article>',
            "</main></body>",
        ].join(""),
        url: "https://chzzk.naver.com/category/game/test/lives",
        sync: { categoryToolsFollowerBadgesEnabled: false, categoryToolsLiveElapsedEnabled: false },
        folder: "categoryTools",
        feature: "categoryTools.js",
        disableKey: "categoryToolsEnabled",
        prepare(document, window) {
            setRect(document.getElementById("tabs"), { left: 16, top: 20, width: 360, height: 40 });
            document.querySelectorAll("#tabs button").forEach((button, index) => {
                setRect(button, { left: 24 + index * 80, top: 24, width: 70, height: 32 });
            });
            setRect(document.getElementById("grid"), { left: 16, top: 100, width: 760, height: 560 });
            for (const [id, top] of [
                ["card-a", 120],
                ["card-b", 5000],
            ]) {
                setRect(document.getElementById(id), { left: 24, top, width: 320, height: 180 });
                setRect(document.querySelector(`#${id} a`), { left: 24, top, width: 320, height: 180 });
            }
            prepare?.(document, window);
        },
    });
}

function loadVideoSearchPage(t) {
    return loadPage(t, {
        html: [
            "<!doctype html><body>",
            '<main id="app">',
            '<nav id="filters"><button aria-selected="true">전체</button><button aria-selected="false">지난 방송</button>',
            '<button aria-selected="false">업로드한 영상</button></nav>',
            '<section id="grid">',
            '<article><a href="/video/100"><strong>Existing 100</strong><span>1:00</span></a></article>',
            '<article><a href="/video/101"><strong>Existing 101</strong><span>1:00</span></a></article>',
            "</section></main></body>",
        ].join(""),
        url: `https://chzzk.naver.com/${MONTHLY_CHANNEL_ID}/videos`,
        sync: { videoSearchCommentEnabled: false },
        folder: "videoSearch",
        feature: "videoSearch.js",
        disableKey: "videoSearchEnabled",
        prepare(document) {
            document.querySelectorAll("#filters button").forEach((button, index) => {
                setRect(button, { left: 24 + index * 90, top: 24, width: 80, height: 32 });
                const selected = button.getAttribute("aria-selected") === "true";
                // 2026-09-11 dark measurement of the channel video filter pills (tests/navigation-data.test.js).
                button.style.backgroundColor = selected ? "rgb(223, 226, 234)" : "rgb(46, 48, 51)";
                button.style.color = selected ? "rgb(14, 15, 16)" : "rgb(157, 165, 182)";
                button.style.fontFamily = '"Native Pill", sans-serif';
            });
        },
    });
}

function loadMonthlyPage(t) {
    return loadPage(t, {
        html: [
            "<!doctype html><body>",
            '<main id="channel"><section id="profile">',
            '<div id="actions"><button id="follow" type="button">팔로우</button></div>',
            "</section></main></body>",
        ].join(""),
        url: `https://chzzk.naver.com/${MONTHLY_CHANNEL_ID}`,
        sync: {
            monthlyBroadcastTimeEnabled: true,
            monthlyBroadcastTimeCalendarEnabled: true,
            monthlyBroadcastTimeWatchEnabled: false,
        },
        folder: "monthlyBroadcastTime",
        feature: "monthlyBroadcastTime.js",
        extraShared: ["shared/vodTimeline.js"],
        disableKey: "monthlyBroadcastTimeEnabled",
        prepare(document) {
            setRect(document.getElementById("profile"), { left: 0, top: 0, width: 640, height: 80 });
            setRect(document.getElementById("actions"), { left: 260, top: 24, width: 280, height: 42 });
            setRect(document.getElementById("follow"), { left: 430, top: 28, width: 90, height: 34 });
        },
    });
}

// A small brace parser: top-level and @media style rules with their declarations (keyframes are skipped).
function parseRules(css) {
    const rules = [];
    const walk = (source) => {
        let index = 0;
        while (index < source.length) {
            const open = source.indexOf("{", index);
            if (open === -1) break;
            const selector = source.slice(index, open).replace(/\s+/g, " ").trim();
            let depth = 1;
            let cursor = open + 1;
            while (depth && cursor < source.length) {
                if (source[cursor] === "{") depth += 1;
                else if (source[cursor] === "}") depth -= 1;
                cursor += 1;
            }
            const body = source.slice(open + 1, cursor - 1);
            if (selector.startsWith("@media")) walk(body);
            else if (!selector.startsWith("@")) {
                const declarations = body
                    .split(";")
                    .map((part) => part.trim())
                    .filter(Boolean)
                    .map((part) => {
                        const colon = part.indexOf(":");
                        return {
                            property: part.slice(0, colon).trim(),
                            value: part
                                .slice(colon + 1)
                                .replace(/\s*!important\s*$/, "")
                                .trim(),
                        };
                    });
                rules.push({ selector, declarations });
            }
            index = cursor;
        }
    };
    walk(css.replace(/\/\*[\s\S]*?\*\//g, ""));
    return rules;
}

function declaration(rules, selector, property) {
    const values = rules
        .filter((rule) => rule.selector === selector)
        .flatMap((rule) => rule.declarations.filter((item) => item.property === property).map((item) => item.value));
    return values.at(-1);
}

function assertSharedThemeContract(document, styleId, fixedColorSelectors = []) {
    const themes = document.querySelectorAll(`#${THEME_STYLE_ID}`);
    assert.equal(themes.length, 1, "the shared theme is injected once");
    const style = document.getElementById(styleId);
    assert.ok(style, `${styleId} is injected`);
    assert.ok(
        themes[0].compareDocumentPosition(style) & document.defaultView.Node.DOCUMENT_POSITION_FOLLOWING,
        `${styleId} is injected after the shared theme was requested`
    );

    const css = style.textContent;
    assert.doesNotMatch(css, /--sem-/, `${styleId} reads CHZZK tokens only through the shared theme`);
    assert.doesNotMatch(css, /var\(\s*--bct-[a-z0-9-]+\s*,/, `${styleId} adds no fallback to shared variables`);
    assert.doesNotMatch(css, /@font-face/, `${styleId} declares no font face of its own`);
    const rules = parseRules(css);
    assert.ok(rules.length > 10);
    for (const rule of rules) {
        assert.doesNotMatch(rule.selector, THEME_SELECTOR, `${rule.selector} keeps no theme branch of its own`);
        for (const { property, value } of rule.declarations) {
            if (!COLOR_LITERAL.test(value)) continue;
            assert.ok(
                fixedColorSelectors.includes(rule.selector),
                `${rule.selector} { ${property}: ${value} } uses a shared variable instead of a literal color`
            );
        }
    }
    return { css, rules };
}

// Small text must not use the low-contrast shared tokens (shared/AGENTS.md).
function assertSmallTextTokens(rules) {
    const aliases = new Map();
    for (const rule of rules)
        for (const { property, value } of rule.declarations)
            if (property.startsWith("--")) aliases.set(property, value);
    const expand = (value, depth = 0) =>
        depth > 4
            ? value
            : value.replace(/var\((--[a-z0-9-]+)\)/g, (match, name) =>
                  aliases.has(name) ? expand(aliases.get(name), depth + 1) : match
              );
    for (const rule of rules) {
        for (const { property, value } of rule.declarations) {
            if (property !== "color") continue;
            const resolved = expand(value);
            assert.doesNotMatch(resolved, /--bct-brand-text-base/, `${rule.selector} small text uses --bct-brand-text`);
            if (/--bct-text-dim/.test(resolved))
                assert.match(
                    rule.selector,
                    /:disabled|data-future/,
                    `${rule.selector} uses dim text only when disabled`
                );
        }
    }
}

function themeFallbacks(document) {
    const rules = parseRules(document.getElementById(THEME_STYLE_ID).textContent);
    const read = (selector) =>
        Object.fromEntries(
            rules
                .find((rule) => rule.selector === selector)
                .declarations.map(({ property, value }) => [property, value.match(/,\s*(#[0-9a-f]+)\)$/i)?.[1]])
                .filter(([, value]) => value)
        );
    return { dark: read(":root"), light: read(':root.light,:root[data-theme="light"]') };
}

function channels(hex) {
    return hex
        .replace("#", "")
        .match(/../g)
        .slice(0, 3)
        .map((part) => parseInt(part, 16));
}

function luminance(rgb) {
    const [r, g, b] = rgb
        .map((value) => value / 255)
        .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(left, right) {
    const [high, low] = [luminance(left), luminance(right)].sort((a, b) => b - a);
    return (high + 0.05) / (low + 0.05);
}

test("category tools request the shared theme and keep only the media badge colors of their own", async (t) => {
    const page = await loadCategoryPage(t);
    await waitFor(() => page.document.getElementById("betterchzzk-category-tools"));
    const { css, rules } = assertSharedThemeContract(page.document, CATEGORY_STYLE_ID, CATEGORY_FIXED_COLOR_SELECTORS);
    assertSmallTextTokens(rules);

    // Feature-local names stay, but every palette value now points at a shared variable.
    for (const [name, value] of [
        ["--bcgt-accent", "var(--bct-brand-text)"],
        ["--bcgt-bg", "var(--bct-surface-weak)"],
        ["--bcgt-text", "var(--bct-text-muted)"],
        ["--bcgt-text-strong", "var(--bct-text)"],
        ["--bcgt-focus", "var(--bct-focus-ring)"],
        ["--bcgt-radius", "var(--bct-radius-full)"],
    ])
        assert.equal(declaration(rules, "#betterchzzk-category-tools, .bcgt-category-summary", name), value, name);
    const menuSelector = "#betterchzzk-category-filter-menu, #betterchzzk-category-add-panel";
    for (const [name, value] of [
        ["--bcgt-menu-bg", "var(--bct-surface)"],
        ["--bcgt-menu-field-bg", "var(--bct-surface-weak)"],
        ["--bcgt-menu-hover", "var(--bct-hover)"],
        ["--bcgt-menu-checked-bg", "var(--bct-brand-weak)"],
        ["--bcgt-menu-focus", "var(--bct-focus-ring)"],
    ])
        assert.equal(declaration(rules, menuSelector, name), value, name);
    assert.equal(declaration(rules, menuSelector, "box-shadow"), "var(--bct-shadow)");
    assert.equal(declaration(rules, menuSelector, "border-radius"), "var(--bct-radius-lg)");
    assert.equal(declaration(rules, ".bcgt-category-summary .bcgt-category-row", "background"), "var(--bcgt-chip-bg)");
    assert.match(css, /--bcgt-chip-bg:var\(--bct-brand\);--bcgt-chip-text:var\(--bct-on-brand\)/);

    // Native font classification (features/AGENTS.md): the bar copies the host font and the follower badge keeps its stack.
    assert.doesNotMatch(css, /--bct-font/);
    assert.equal(declaration(rules, "#betterchzzk-category-tools", "font-family"), "var(--bcgt-font-family)");
    assert.match(declaration(rules, '[data-bcgt-follower-badge="1"]', "font-family"), /^"Sandoll Nemony2",/);
});

test("category tools still copy the computed host font into the bar and the filter menu", async (t) => {
    const page = await loadCategoryPage(t, (document) => {
        document.querySelectorAll("#tabs button").forEach((button) => {
            button.style.fontFamily = '"Native Tab", sans-serif';
            button.style.fontWeight = "600";
        });
    });
    await waitFor(() => page.document.getElementById("betterchzzk-category-filter-menu"));
    const bar = page.document.getElementById("betterchzzk-category-tools");
    const menu = page.document.getElementById("betterchzzk-category-filter-menu");
    const native = page.window.getComputedStyle(page.document.querySelector("#tabs button")).fontFamily;
    assert.match(native, /Native Tab/);
    assert.equal(bar.style.getPropertyValue("--bcgt-font-family"), native);
    assert.equal(bar.style.getPropertyValue("--bcgt-font-weight"), "600");
    assert.equal(menu.style.fontFamily, native);
});

test("category tools show the polite empty result message", async (t) => {
    const page = await loadCategoryPage(t);
    const input = await waitFor(() => page.document.querySelector("#betterchzzk-category-tools input[type='search']"));
    input.value = "결과가 없을 검색어";
    input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    const empty = await waitFor(() => {
        const node = page.document.querySelector('[data-bcgt-empty="1"]');
        return node?.textContent === "조건에 맞는 결과가 없어요." ? node : null;
    });
    assert.ok(empty);
});

test("video search requests the shared theme, uses the bundled font and still mirrors native pill colors", async (t) => {
    const page = await loadVideoSearchPage(t);
    const bar = await waitFor(() => page.document.getElementById("betterchzzk-video-search-bar"));
    const { rules } = assertSharedThemeContract(page.document, VIDEO_STYLE_ID);
    assertSmallTextTokens(rules);

    assert.equal(bar.getAttribute("data-mode"), "inline");
    assert.equal(bar.style.getPropertyValue("--bcvs-bg"), "rgb(46, 48, 51)", "native unselected pill color");
    assert.equal(bar.style.getPropertyValue("--bcvs-text"), "rgb(157, 165, 182)");
    assert.equal(bar.style.getPropertyValue("--bcvs-font-family"), "", "the native pill font is not copied");
    assert.equal(bar.style.fontFamily, "");

    for (const selector of ["#betterchzzk-video-search-bar", "[data-bcvs-load-more] button", ".bcvs-comment-tooltip"])
        assert.equal(declaration(rules, selector, "font-family"), "var(--bct-font)", selector);
    for (const [name, value] of [
        ["--bcvs-accent", "var(--bct-brand-text)"],
        ["--bcvs-bg", "var(--bct-surface-base)"],
        ["--bcvs-border", "var(--bct-border)"],
        ["--bcvs-text", "var(--bct-text-muted)"],
        ["--bcvs-focus", "var(--bct-focus-ring)"],
    ])
        assert.equal(declaration(rules, "#betterchzzk-video-search-bar", name), value, name);
    assert.equal(declaration(rules, ".bcvs-comment-tooltip", "box-shadow"), "var(--bct-shadow)");
    assert.equal(declaration(rules, ".bcvs-comment-tooltip", "background"), "var(--bct-surface)");
});

test("monthly calendar requests the shared theme and keeps its specified font stack", async (t) => {
    const page = await loadMonthlyPage(t);
    const widget = await waitFor(() => page.document.getElementById("betterchzzk-monthly-broadcast-time"));
    const { css, rules } = assertSharedThemeContract(page.document, MONTHLY_STYLE_ID);
    assertSmallTextTokens(rules);

    assert.equal(declaration(rules, "#betterchzzk-monthly-broadcast-time", "font-family"), MONTHLY_FONT_FAMILY);
    assert.doesNotMatch(css, /--bct-font/);
    assert.equal(
        declaration(rules, "#betterchzzk-monthly-broadcast-time .bcmb-calendar", "background"),
        "var(--bct-surface)"
    );
    assert.equal(
        declaration(rules, "#betterchzzk-monthly-broadcast-time .bcmb-calendar", "box-shadow"),
        "var(--bct-shadow)"
    );
    assert.equal(
        widget.querySelector(".bcmb-calendar-legend").getAttribute("aria-label"),
        "방송 시간에 따라 3시간 단위로 9단계로 표시하며, 가장 진한 색은 24시간 이상이에요."
    );
    assert.equal(widget.querySelectorAll(".bcmb-calendar-legend-step").length, 9);
});

test("monthly calendar levels grow in intensity and keep 4.5:1 day numbers in both fallback themes", async (t) => {
    const page = await loadMonthlyPage(t);
    await waitFor(() => page.document.getElementById(MONTHLY_STYLE_ID));
    const rules = parseRules(page.document.getElementById(MONTHLY_STYLE_ID).textContent);
    const themes = themeFallbacks(page.document);
    const widgetSelector = "#betterchzzk-monthly-broadcast-time";
    for (const theme of ["dark", "light"]) {
        const values = themes[theme];
        let previous = 1;
        for (let level = 1; level <= 9; level += 1) {
            const background = declaration(rules, widgetSelector, `--bcmb-duration-${level}-bg`);
            const foreground = declaration(rules, widgetSelector, `--bcmb-duration-${level}-fg`);
            const mix = background.match(
                /^color-mix\(in srgb,\s*var\((--bct-[a-z-]+)\)\s+(\d+(?:\.\d+)?)%,\s*var\((--bct-[a-z-]+)\)\)$/
            );
            assert.ok(mix, `level ${level} mixes shared variables: ${background}`);
            const ratio = Number(mix[2]) / 100;
            const rgb = channels(values[mix[1]]).map(
                (value, index) => value * ratio + channels(values[mix[3]])[index] * (1 - ratio)
            );
            const text = foreground.match(/^var\((--bct-[a-z-]+)\)$/)?.[1];
            assert.ok(text && values[text], `level ${level} text uses a shared variable`);
            const textContrast = contrast(channels(values[text]), rgb);
            assert.ok(textContrast >= 4.5, `${theme} level ${level} day number ${textContrast.toFixed(2)}:1`);
            const intensity = contrast(rgb, channels(values["--bct-surface"]));
            assert.ok(intensity > previous, `${theme} level ${level} is stronger than the previous level`);
            previous = intensity;
        }
    }
});

test("discovery panels use polite 해요체 copy in every user-visible string", () => {
    for (const file of [
        "features/categoryTools.js",
        "features/categoryTools/filterModel.js",
        "features/categoryTools/repository.js",
        "features/categoryTools/searchController.js",
        "features/videoSearch.js",
        "features/videoSearch/model.js",
        "features/videoSearch/repository.js",
        "features/monthlyBroadcastTime.js",
        "features/monthlyBroadcastTime/model.js",
        "features/monthlyBroadcastTime/repository.js",
    ]) {
        // 합니다체 어미는 받침 ㅂ 음절 뒤의 '니다'(합니다·없습니다·입니다)예요. 주석의 '아니다' 같은 한다체는 제외해요.
        const formal = [...readRepoFile(file).matchAll(/([가-힣])니다/g)]
            .map((match) => match[0])
            .filter((text) => (text.charCodeAt(0) - 0xac00) % 28 === 17);
        assert.deepEqual(formal, [], `${file} keeps no 합니다체 sentence`);
    }
});
