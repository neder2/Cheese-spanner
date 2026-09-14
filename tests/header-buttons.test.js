const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const keys = ["headerStudioHidden", "headerCheeseHidden", "headerNotificationHidden"];
// 2026-09-14 https://chzzk.naver.com/ 헤더: cash → 알림 → cheat_key → 테마 → 프로필.
const header = `<header id="header"><div>
<a id="studio" href="https://studio.chzzk.naver.com/test-channel">스튜디오</a>
<div id="cheese"><a href="https://game.naver.com/profile#cash"><svg></svg></a></div>
<div id="notification"><button type="button"><svg></svg><span class="blind">New</span></button></div>
<div id="cheat"><a href="https://game.naver.com/profile#cheat_key"><svg></svg></a></div>
<div id="theme"><button type="button"><svg></svg></button></div>
<div id="profile"><button type="button"><img alt="프로필"></button></div>
</div></header>`;

function fixture(t) {
    const dom = new JSDOM(
        `<!doctype html>${header}<aside id="sidebar"><a href="/cheezefarm">치즈팜</a></aside><main>${header.replace('id="header"', 'id="unrelated"')}</main>`,
        { url: "https://chzzk.naver.com/", runScripts: "outside-only" }
    );
    t.after(() => dom.window.close());
    const { window } = dom;
    const { document } = window;
    let apply, ready;
    window.BetterChzzk = {
        utils: {
            bindFeatureOptions(fn) {
                apply = fn;
            },
            onReady(fn) {
                ready = fn;
            },
            injectStyleOnce(id, css) {
                if (document.getElementById(id)) return;
                const style = document.createElement("style");
                style.id = id;
                style.textContent = css;
                document.documentElement.append(style);
            },
        },
    };
    window.eval(read("features/headerButtons.js"));
    return {
        window,
        document,
        apply: (options) => apply(options),
        ready: () => ready(),
        hidden: (selector) => window.getComputedStyle(document.querySelector(selector)).display === "none",
    };
}

test("header buttons can each be hidden and restored independently without modifying native DOM", (t) => {
    const h = fixture(t);
    const original = h.document.body.innerHTML;
    assert.equal(h.document.querySelectorAll("style").length, 0);
    for (let mask = 0; mask < 8; mask++) {
        const options = Object.fromEntries(keys.map((key, i) => [key, Boolean(mask & (1 << i))]));
        h.apply(options);
        h.ready();
        h.apply(options);
        for (const [i, id] of ["studio", "cheese", "notification"].entries()) {
            assert.equal(h.hidden(`#header #${id}`), options[keys[i]], `${id}: combination ${mask}`);
            assert.equal(h.hidden(`#unrelated #${id}`), false);
        }
        for (const id of ["cheat", "theme", "profile"]) assert.equal(h.hidden(`#header #${id}`), false);
        assert.equal(h.hidden("#sidebar"), false);
        assert.equal(h.document.querySelectorAll("style").length, Object.values(options).filter(Boolean).length);
        assert.equal(h.document.body.innerHTML, original);
    }
    h.apply({});
    assert.equal(h.document.querySelectorAll("style").length, 0);
    for (const id of ["studio", "cheese", "notification"]) assert.equal(h.hidden(`#header #${id}`), false);
});

test("header hiding survives SPA navigation, remounts and unread badge changes in both themes", (t) => {
    const h = fixture(t);
    h.apply(Object.fromEntries(keys.map((key) => [key, true])));
    for (const route of ["/live/test-channel", "/video/123", "/"]) {
        h.window.history.replaceState(null, "", route);
        h.document.querySelector("#header").outerHTML = header;
        h.document.querySelector("#header .blind").remove();
        for (const theme of ["light", "dark"]) {
            h.document.documentElement.dataset.theme = theme;
            for (const id of ["studio", "cheese", "notification"]) assert.equal(h.hidden(`#header #${id}`), true);
            assert.equal(h.hidden("#header #theme"), false);
        }
    }
    h.apply({});
    for (const id of ["studio", "cheese", "notification"]) assert.equal(h.hidden(`#header #${id}`), false);
    assert.equal(h.document.querySelectorAll("style").length, 0);
});

test("header options default off and have accessible independent settings controls and runtime registration", (t) => {
    const dom = new JSDOM(read("options.html"), { runScripts: "outside-only" });
    t.after(() => dom.window.close());
    dom.window.eval(read("shared/settings.js"));
    const settings = dom.window.BetterChzzkSettings;
    for (const key of keys) {
        assert.equal(settings.DEFAULT_OPTIONS[key], false);
        assert.equal(settings.normalizeOptions({ [key]: true })[key], true);
        const controls = dom.window.document.querySelectorAll(`[data-option="${key}"]`);
        assert.equal(controls.length, 1);
        assert.equal(controls[0].type, "checkbox");
        assert.ok(controls[0].closest("label").textContent.trim());
        assert.equal(controls[0].closest("[data-depends-on]"), null);
    }
    const manifest = JSON.parse(read("manifest.json"));
    const isolated = manifest.content_scripts.find((entry) => entry.js.includes("features/headerButtons.js"));
    assert.notEqual(isolated.world, "MAIN");
    assert.ok(isolated.js.indexOf("content.js") < isolated.js.indexOf("features/headerButtons.js"));
});
