const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const source = fs.readFileSync(path.join(__dirname, "../features/screenShortcuts.js"), "utf8");

function fixture(t) {
    const dom = new JSDOM(
        '<main><video></video><button class="pzp-pc__fullscreen-button"></button><button class="pzp-pc__viewmode-button"></button></main><input><div role="textbox"></div><button id="outside"></button>',
        { url: "https://chzzk.naver.com/live/test", runScripts: "outside-only" }
    );
    t.after(() => dom.window.close());
    const w = dom.window;
    let apply;
    let clicks = 0;
    let native = 0;
    w.eval(fs.readFileSync(path.join(__dirname, "../content.js"), "utf8"));
    w.CheeseSpanner = {
        utils: {
            PLAYER_SHORTCUT_PANEL_SELECTOR: w.CheeseSpanner.utils.PLAYER_SHORTCUT_PANEL_SELECTOR,
            isSpaceConsumerTarget: w.CheeseSpanner.utils.isSpaceConsumerTarget,
            bindFeatureOptions(fn) {
                apply = fn;
                fn({});
            },
            getMainVideoElement: () => w.document.querySelector("video"),
            getPlayerRoot: (v) => v.closest("main"),
            isNativeAdBreakActive: () => false,
            isLiveAdBreakActive: () => false,
            isPlaybackRoute: () => /^\/(live|video)\//.test(w.location.pathname),
            isEditableTarget: (el) => !!el.closest("input,textarea,select"),
            isVodMultiviewInput: (event) => !!event.target?.closest?.("[data-bcvm]"),
        },
    };
    w.document.querySelector("main").addEventListener("click", () => clicks++);
    w.addEventListener("keydown", () => native++);
    w.eval(source);
    const press = (code = "KeyF", extra = {}, target = w.document.body) => {
        const e = new w.KeyboardEvent("keydown", { code, bubbles: true, cancelable: true, ...extra });
        target.dispatchEvent(e);
        return e;
    };
    return { w, apply: (options) => apply(options), press, counts: () => ({ clicks, native }) };
}

test("screen shortcuts default off and ignore retired opt-in; enabling owns F/T exactly once", (t) => {
    const f = fixture(t);
    f.apply({ shortcutRescueEnabled: true });
    assert.equal(f.press().defaultPrevented, false);
    f.apply({ screenShortcutsEnabled: true });
    f.apply({ screenShortcutsEnabled: true });
    f.w.eval(source);
    assert.equal(f.press().defaultPrevented, true);
    assert.equal(f.press("KeyT").defaultPrevented, true);
    f.press("KeyT", { repeat: true });
    assert.deepEqual(f.counts(), { clicks: 2, native: 1 });
    f.apply({ screenShortcutsEnabled: false });
    assert.equal(f.press().defaultPrevented, false);
    assert.deepEqual(f.counts(), { clicks: 2, native: 2 });
});

test("screen shortcuts yield typing, modifiers, other keys and unavailable controls", (t) => {
    const f = fixture(t);
    f.apply({ screenShortcutsEnabled: true });
    for (const selector of ["input", "[role=textbox]", "#outside"]) {
        assert.equal(f.press("KeyT", {}, f.w.document.querySelector(selector)).defaultPrevented, false);
    }
    for (const key of ["Space", "ArrowRight", "BracketRight"]) assert.equal(f.press(key).defaultPrevented, false);
    for (const modifier of ["ctrlKey", "altKey", "shiftKey", "metaKey", "isComposing"])
        assert.equal(f.press("KeyF", { [modifier]: true }).defaultPrevented, false);
    f.w.document.querySelector(".pzp-pc__fullscreen-button").disabled = true;
    assert.equal(f.press().defaultPrevented, false);
    f.w.document.querySelector(".pzp-pc__viewmode-button").remove();
    assert.equal(f.press("KeyT").defaultPrevented, false);
    assert.equal(f.counts().clicks, 0);
});

test("Space and M use their native buttons once and Space yields to hold-speed", (t) => {
    const f = fixture(t);
    const main = f.w.document.querySelector("main");
    for (const className of ["pzp-pc__playback-switch", "pzp-pc__volume-button"]) {
        const button = f.w.document.createElement("button");
        button.className = className;
        main.append(button);
    }
    f.apply({ screenShortcutsEnabled: true, holdSpeedEnabled: false });
    for (const code of ["Space", "KeyM"]) {
        assert.equal(f.press(code).defaultPrevented, true);
        assert.equal(f.press(code, { repeat: true }).defaultPrevented, true);
        assert.equal(f.press(code, {}, f.w.document.querySelector("input")).defaultPrevented, false);
    }
    assert.deepEqual(f.counts(), { clicks: 2, native: 2 });
    f.apply({ screenShortcutsEnabled: true, holdSpeedEnabled: true });
    assert.equal(f.press("Space").defaultPrevented, false);
    assert.equal(f.counts().clicks, 2);
    f.press("KeyM");
    assert.equal(f.counts().clicks, 3);
    f.apply({ screenShortcutsEnabled: true, holdSpeedEnabled: false });
    f.press("Space");
    assert.equal(f.counts().clicks, 4);
});

test("Space on a focused player control keeps its native action while an unfocused player receives playback Space", (t) => {
    const f = fixture(t);
    const doc = f.w.document;
    const play = doc.createElement("button");
    play.className = "pzp-pc__playback-switch";
    doc.querySelector("main").append(play);
    f.apply({ screenShortcutsEnabled: true, holdSpeedEnabled: false });
    const fullscreen = doc.querySelector(".pzp-pc__fullscreen-button");
    fullscreen.focus();
    assert.equal(f.press("Space", { key: " " }, doc.activeElement).defaultPrevented, false);
    const menuItem = doc.createElement("div");
    menuItem.setAttribute("role", "menuitemradio");
    menuItem.tabIndex = 0;
    doc.querySelector("main").append(menuItem);
    menuItem.focus();
    assert.equal(f.press("Space", { key: " " }, doc.activeElement).defaultPrevented, false);
    assert.equal(f.counts().clicks, 0);
    menuItem.blur();
    assert.equal(f.press("Space", { key: " " }).defaultPrevented, true);
    assert.equal(f.counts().clicks, 1);
});

test("screen shortcuts resolve current player after SPA navigation and DOM remount", (t) => {
    const f = fixture(t);
    f.apply({ screenShortcutsEnabled: true });
    f.w.history.pushState({}, "", "/lives");
    assert.equal(f.press().defaultPrevented, false);
    f.w.history.pushState({}, "", "/video/123");
    const old = f.w.document.querySelector("main");
    const replacement = old.cloneNode(true);
    let replacementClicks = 0;
    replacement.addEventListener("click", () => replacementClicks++);
    old.replaceWith(replacement);
    f.press();
    f.press("KeyT", {}, replacement.querySelector("button"));
    assert.equal(replacementClicks, 2);
    assert.equal(f.counts().clicks, 0);
    replacement.querySelector("video").remove();
    assert.equal(f.press().defaultPrevented, false);
});

test("screen shortcut script is loaded after its shared utilities", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
    const scripts = manifest.content_scripts.find((entry) => entry.js.includes("features/screenShortcuts.js")).js;
    assert.ok(scripts.indexOf("content.js") < scripts.indexOf("features/screenShortcuts.js"));
});
