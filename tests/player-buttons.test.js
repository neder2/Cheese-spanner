const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const keys = ["playerClipHidden", "playerPipHidden"];
// 2026-09-14 라이브·VOD 실측. 클립과 설정은 pzp-pc__setting-button을 공유한다.
const buttons = `<button class="custom__clip-button pzp-pc__setting-button pzp-button"><span>클립 만들기</span></button>
<button class="pzp-pip-button pzp-pc__pip-button pzp-button" aria-label="PIP 보기" slot="pip-button"><span>PIP 보기</span></button>
<button class="pzp-setting-button pzp-pc__setting-button" aria-label="설정"></button>
<button class="custom__shop-button pzp-pc__setting-button">스트리머 샵</button>
<button class="pzp-pc__fullscreen-button" aria-label="전체 화면"></button>
<button class="pzp-pc__viewmode-button" aria-label="넓은 화면"></button>`;
const player = `<div class="pzp-pc"><video></video><div class="pzp-pc__bottom-buttons-right">${buttons}</div></div>`;

function fixture(t, options = {}) {
    const dom = new JSDOM(`<!doctype html>${player}<aside>${buttons}</aside>`, {
        url: "https://chzzk.naver.com/live/test-channel",
        runScripts: "outside-only",
    });
    t.after(() => dom.window.close());
    const { window } = dom;
    const { document } = window;
    let apply;
    window.BetterChzzk = {
        utils: {
            bindFeatureOptions(fn) {
                apply = fn;
                fn(options);
            },
            onReady(fn) {
                fn();
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
    window.eval(read("features/playerButtons.js"));
    return { window, document, apply, hidden: (el) => window.getComputedStyle(el).display === "none" };
}

test("clip and PIP toggles apply independently and restore native buttons without affecting other controls", (t) => {
    const h = fixture(t);
    const original = h.document.body.innerHTML;
    assert.equal(h.document.querySelectorAll("style").length, 0);
    for (let mask = 0; mask < 4; mask++) {
        const options = Object.fromEntries(keys.map((key, i) => [key, Boolean(mask & (1 << i))]));
        h.apply(options);
        h.apply(options);
        const controls = h.document.querySelectorAll(".pzp-pc button");
        assert.equal(h.hidden(controls[0]), options.playerClipHidden);
        assert.equal(h.hidden(controls[1]), options.playerPipHidden);
        for (const control of [...controls].slice(2)) assert.equal(h.hidden(control), false);
        for (const control of h.document.querySelectorAll("aside button")) assert.equal(h.hidden(control), false);
        assert.equal(h.document.querySelectorAll("style").length, Object.values(options).filter(Boolean).length);
        assert.equal(h.document.body.innerHTML, original);
    }
    h.apply({});
    for (const control of h.document.querySelectorAll("button")) assert.equal(h.hidden(control), false);
    assert.equal(h.document.querySelectorAll("style").length, 0);
});

test("saved button settings survive initial load, SPA routes and player remounts in either theme", (t) => {
    const h = fixture(t, { playerClipHidden: true, playerPipHidden: true });
    for (const route of ["/live/test-channel", "/video/123", "/live/another-channel"]) {
        h.window.history.replaceState(null, "", route);
        h.document.querySelector(".pzp-pc").outerHTML = player;
        for (const theme of ["light", "dark"]) {
            h.document.documentElement.dataset.theme = theme;
            for (const control of h.document.querySelectorAll(".pzp-pc button")) {
                assert.equal(h.hidden(control), control.matches(".custom__clip-button, .pzp-pc__pip-button"));
            }
        }
    }
    h.apply({});
    for (const control of h.document.querySelectorAll("button")) assert.equal(h.hidden(control), false);
});

test("player button options default off and have labelled independent controls and isolated runtime registration", (t) => {
    const dom = new JSDOM(read("options.html"), { runScripts: "outside-only" });
    t.after(() => dom.window.close());
    dom.window.eval(read("shared/settings.js"));
    for (const key of keys) {
        assert.equal(dom.window.BetterChzzkSettings.DEFAULT_OPTIONS[key], false);
        const controls = dom.window.document.querySelectorAll(`[data-option="${key}"]`);
        assert.equal(controls.length, 1);
        assert.equal(controls[0].type, "checkbox");
        assert.ok(controls[0].closest("label").textContent.trim());
        assert.ok(controls[0].closest("#tab-panel-0"));
        assert.equal(controls[0].closest("[data-depends-on]"), null);
    }
    const manifest = JSON.parse(read("manifest.json"));
    const entry = manifest.content_scripts.find((item) => item.js.includes("features/playerButtons.js"));
    assert.notEqual(entry.world, "MAIN");
    assert.ok(entry.js.indexOf("content.js") < entry.js.indexOf("features/playerButtons.js"));
});
