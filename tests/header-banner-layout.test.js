const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { evalRepoScript, waitForCondition } = require("./helpers/extension-page-fixture.js");

const layout = `<div id="layout"><div id="viewport-box"></div>
<div class="_container_banner_2" style="position:fixed;opacity:1"><a class="_wrapper_banner_16" href="/events">안내 배너</a></div>
<header id="header" style="transform:translateY(51px)"><input aria-label="검색창"></header>
<aside id="sidebar" style="transform:translateY(111px);height:calc(100vh - 111px)"></aside>
<div id="layout-body" style="padding-top:51px"></div></div>`;

async function fixture(t, markup = layout) {
    const dom = new JSDOM(`<body>${markup}</body>`, {
        url: "https://chzzk.naver.com/",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    let height = 51;
    const resizes = new Set();
    dom.window.ResizeObserver = class {
        constructor(callback) {
            this.callback = callback;
            resizes.add(this);
        }
        observe(node) {
            this.node = node;
        }
        disconnect() {
            this.node = null;
        }
    };
    const bindRect = () => {
        const banner = dom.window.document.querySelector("._container_banner_2");
        if (banner)
            banner.getBoundingClientRect = () => ({
                width: 1200,
                height,
                top: 0,
                bottom: height,
                left: 0,
                right: 1200,
            });
        return banner;
    };
    bindRect();
    for (const file of [
        "shared/settings.js",
        "shared/data.js",
        "features/routeBridgePage.js",
        "content.js",
        "features/headerBannerLayout.js",
    ])
        evalRepoScript(dom, file);
    t.after(() => {
        dom.window.BetterChzzk.headerBannerLayout.stop();
        dom.window.close();
    });
    await new Promise((resolve) => setImmediate(resolve));
    return {
        dom,
        document: dom.window.document,
        bindRect,
        resize(value) {
            height = value;
            for (const observer of resizes) if (observer.node) observer.callback([]);
        },
        resizes,
    };
}

test("visible top banners preserve native offsets and follow React updates without changing native properties", async (t) => {
    const f = await fixture(t),
        doc = f.document;
    await waitForCondition(
        () => doc.getElementById("header").style.getPropertyValue("--bchbl-transform") === "translateY(51px)"
    );
    const header = doc.getElementById("header"),
        sidebar = doc.getElementById("sidebar"),
        body = doc.getElementById("layout-body");
    assert.equal(header.style.transform, "translateY(51px)");
    assert.equal(header.style.getPropertyPriority("transform"), "");
    assert.equal(sidebar.style.getPropertyValue("--bchbl-transform"), "translateY(111px)");
    assert.equal(sidebar.style.getPropertyValue("--bchbl-height"), sidebar.style.height);
    assert.equal(body.style.getPropertyValue("--bchbl-padding-top"), "51px");
    header.style.transform = "translateY(110px)";
    sidebar.style.transform = "translateY(170px)";
    sidebar.style.height = "calc(100vh - 170px)";
    body.style.paddingTop = "110px";
    f.resize(110);
    await waitForCondition(() => header.style.getPropertyValue("--bchbl-transform") === "translateY(110px)");
    assert.equal(sidebar.style.getPropertyValue("--bchbl-transform"), "translateY(170px)");
    assert.equal(body.style.getPropertyValue("--bchbl-padding-top"), "110px");
    sidebar.style.removeProperty("height");
    await waitForCondition(() => !sidebar.hasAttribute("data-bchbl-offset-height"));
    assert.equal(sidebar.style.getPropertyValue("--bchbl-height"), "");
    assert.equal(sidebar.style.getPropertyValue("--bchbl-transform"), "translateY(170px)");
    let mutations = 0;
    const observer = new f.dom.window.MutationObserver((rows) => {
        mutations += rows.length;
    });
    observer.observe(doc.documentElement, { attributes: true, subtree: true });
    // Two task turns drain the feature's own style mutations; an unchanged resize must not write again.
    await new Promise((resolve) => setImmediate(resolve));
    mutations = 0;
    f.resize(110);
    await new Promise((resolve) => setImmediate(resolve));
    observer.disconnect();
    assert.equal(mutations, 0);
});

test("hidden or removed banners release corrections, while native zero offsets and unrelated siblings stay untouched", async (t) => {
    const f = await fixture(t),
        doc = f.document,
        header = doc.getElementById("header");
    await waitForCondition(() => header.hasAttribute("data-bchbl-offset-transform"));
    f.resize(0);
    await waitForCondition(() => !header.hasAttribute("data-bchbl-offset-transform"));
    assert.equal(header.style.transform, "translateY(51px)");
    assert.equal(doc.getElementById("betterchzzk-header-banner-layout-style"), null);
    f.resize(51);
    await waitForCondition(() => header.hasAttribute("data-bchbl-offset-transform"));
    header.style.transform = "translateY(0px)";
    await waitForCondition(() => !header.hasAttribute("data-bchbl-offset-transform"));
    header.style.transform = "translateY(51px)";
    await waitForCondition(() => header.hasAttribute("data-bchbl-offset-transform"));
    doc.querySelector("._container_banner_2").remove();
    await waitForCondition(() => !header.hasAttribute("data-bchbl-offset-transform"));
    assert.equal(doc.getElementById("sidebar").style.getPropertyValue("--bchbl-height"), "");
    const unrelated = doc.createElement("div");
    unrelated.style.position = "fixed";
    unrelated.textContent = "일반 안내";
    header.before(unrelated);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(header.hasAttribute("data-bchbl-offset-transform"), false);
});

test("header remount, SPA navigation and page lifecycle clean up old nodes and retain one active banner observer", async (t) => {
    const f = await fixture(t),
        doc = f.document;
    await waitForCondition(() => doc.getElementById("header").hasAttribute("data-bchbl-offset-transform"));
    const oldHeader = doc.getElementById("header");
    const replacement = oldHeader.cloneNode(false);
    replacement.removeAttribute("data-bchbl-offset-transform");
    replacement.style.removeProperty("--bchbl-transform");
    oldHeader.replaceWith(replacement);
    await waitForCondition(() => replacement.hasAttribute("data-bchbl-offset-transform"));
    assert.equal(oldHeader.style.getPropertyValue("--bchbl-transform"), "");
    f.dom.window.history.pushState({}, "", "/lives");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(replacement.style.getPropertyValue("--bchbl-transform"), "translateY(51px)");
    assert.equal([...f.resizes].filter((observer) => observer.node).length, 1);
    f.dom.window.dispatchEvent(new f.dom.window.Event("pagehide"));
    assert.equal(replacement.style.getPropertyValue("--bchbl-transform"), "");
    assert.equal([...f.resizes].filter((observer) => observer.node).length, 0);
    f.dom.window.dispatchEvent(new f.dom.window.Event("pageshow"));
    await waitForCondition(() => replacement.hasAttribute("data-bchbl-offset-transform"));
    assert.equal([...f.resizes].filter((observer) => observer.node).length, 1);
});

test("watchparty sticky title follows the actual header when a hidden skin leaves native offsets behind", async (t) => {
    const f = await fixture(t),
        doc = f.document,
        header = doc.getElementById("header"),
        body = doc.getElementById("layout-body"),
        banner = doc.querySelector("._container_banner_2");
    const filter = doc.createElement("style");
    filter.textContent = "#header { transform:none !important; }";
    doc.head.append(filter);
    let bottom = 60;
    header.getBoundingClientRect = () => ({ bottom });
    body.innerHTML =
        '<div><section><div class="_header_fixture_20 _is_sticky_fixture_31" style="top:111px">같이보기</div></section></div>';
    const title = body.querySelector("section > div");
    banner.style.display = "none";
    f.resize(0);
    f.dom.window.history.pushState({}, "", "/watchparty/535");
    await waitForCondition(() => body.style.getPropertyValue("--bchbl-sticky-top") === "60px");
    assert.equal(title.style.top, "111px", "native React state remains intact");
    const rule = doc.getElementById("betterchzzk-header-banner-sticky-style").sheet.cssRules[0];
    assert.equal(title.matches(rule.selectorText), true);
    assert.equal(rule.style.getPropertyValue("top"), "var(--bchbl-sticky-top)");
    // JSDOM does not retain !important on this var() declaration in CSSOM.
    assert.match(
        doc.getElementById("betterchzzk-header-banner-sticky-style").textContent,
        /top: var\(--bchbl-sticky-top\) !important/
    );
    bottom = 72;
    f.resize(0);
    await waitForCondition(() => body.style.getPropertyValue("--bchbl-sticky-top") === "72px");
    title.replaceWith(title.cloneNode(true));
    assert.equal(body.querySelector("section > div").matches(rule.selectorText), true);
    banner.style.display = "block";
    f.resize(51);
    await waitForCondition(() => !body.hasAttribute("data-bchbl-sticky"));
    assert.equal(body.style.getPropertyValue("--bchbl-sticky-top"), "");
    banner.style.display = "none";
    f.resize(0);
    await waitForCondition(() => body.hasAttribute("data-bchbl-sticky"));
    f.dom.window.history.pushState({}, "", "/lives");
    await waitForCondition(() => !body.hasAttribute("data-bchbl-sticky"));
    f.dom.window.history.pushState({}, "", "/watchparty/all");
    await waitForCondition(() => body.hasAttribute("data-bchbl-sticky"));
    banner.remove();
    await waitForCondition(() => !body.hasAttribute("data-bchbl-sticky"));
    assert.equal(doc.getElementById("betterchzzk-header-banner-sticky-style"), null);
});
