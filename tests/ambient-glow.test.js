const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const {
    readRepoFile,
    createFakeChrome,
    createDom,
    evalRepoScript,
    dispatch,
    queryOption,
    waitForAsyncCallbacks,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

const LAYER_ID = "betterchzzk-ambient";
const STYLE_ID = "betterchzzk-ambient-style";
// Geometry from docs/measurements/panel-resize-2026-09-28.md: 2048x996 live page with a
// 240px expanded sidebar, a 60px header, a 1455px main column and a 353px chat.
const PLAYER = { left: 240, top: 60, width: 1455, height: 818 };
// Native home menu shape from docs/measurements/stream-info-settings-2026-09-15.md.
const MENU = `<div class="pzp-settings pzp-pc-settings pzp-pc__settings" role="menu"><button class="pzp-ui-setting-home-item" role="menuitem" id="native-quality"><span class="pzp-ui-setting-home-item__top"><span class="pzp-ui-setting-home-item__left"><span class="pzp-ui-setting-home-item__label">해상도</span></span></span></button></div>`;
const STATE_KEY = "betterChzzkAmbientPlayerOff";
const markup = `<header id="header"></header>
<aside id="sidebar" class="sidebar_container"><a href="/live/a">팔로잉</a></aside>
<div id="layout-body"><div class="wrapper"><main><div class="pzp-pc"><div class="pzp-pc__video"><video></video></div>
<div class="pzp-pc__bottom-buttons-right"><button class="pzp-setting-button" aria-label="설정" aria-expanded="false"></button></div>
${MENU}</div><section class="info">방송 정보</section></main>
<aside id="aside-chatting"><div class="chat-list"><div class="chat-row">안녕</div></div></aside></div></div>`;

function rect({ left, top, width, height }) {
    return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height };
}

function fixture(t, sync = { ambientEnabled: true }, path = "/live/test-channel", local = {}) {
    const chrome = createFakeChrome({ sync, local });
    const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, {
        url: `https://chzzk.naver.com${path}`,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    const doc = w.document;
    w.chrome = chrome;
    Object.defineProperty(w, "innerWidth", { configurable: true, value: 2048 });
    Object.defineProperty(w, "innerHeight", { configurable: true, value: 996 });
    let now = 1000;
    w.performance.now = () => now;
    let hidden = false,
        fullscreenElement = null;
    Object.defineProperty(doc, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(doc, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
    const resizers = new Set();
    w.ResizeObserver = class {
        constructor(fn) {
            this.fn = fn;
        }
        observe() {
            resizers.add(this);
        }
        disconnect() {
            resizers.delete(this);
        }
    };
    const draws = [];
    const pixelReads = [];
    let contexts = 0;
    w.HTMLCanvasElement.prototype.getContext = function () {
        contexts++;
        return {
            globalAlpha: 1,
            clearRect() {},
            drawImage(source, ...args) {
                draws.push({ source, args, alpha: this.globalAlpha });
            },
            getImageData() {
                pixelReads.push("getImageData");
                throw new Error("ambient glow must never read pixels");
            },
        };
    };
    let playerBox = { ...PLAYER };
    const frameCallbacks = new Map();
    const cancelled = [];
    let nextFrameId = 1;
    function prepareVideo(video) {
        let readyState = 4;
        Object.defineProperty(video, "readyState", { configurable: true, get: () => readyState });
        Object.defineProperty(video, "paused", { configurable: true, get: () => false });
        video.setReadyState = (value) => {
            readyState = value;
        };
        video.requestVideoFrameCallback = (callback) => {
            const id = nextFrameId++;
            frameCallbacks.set(id, { video, callback });
            return id;
        };
        video.cancelVideoFrameCallback = (id) => {
            cancelled.push(id);
            frameCallbacks.delete(id);
        };
        video.getBoundingClientRect = () => rect(playerBox);
        for (let node = video.parentElement; node; node = node.parentElement) {
            if (node.matches("[class*='pzp']")) node.getBoundingClientRect = () => rect(playerBox);
        }
    }
    prepareVideo(doc.querySelector("video"));
    const panels = () => [doc.getElementById("sidebar").outerHTML, doc.getElementById("aside-chatting").outerHTML];
    const nativePanels = panels();
    w.eval(readRepoFile("shared", "settings.js"));
    w.eval(readRepoFile("shared", "data.js"));
    w.eval(readRepoFile("content.js"));
    w.eval(readRepoFile("features", "ambientGlow.js"));
    t.after(() => {
        w.BetterChzzk.ambientGlow?.stop();
        dom.window.close();
    });
    const layer = () => doc.getElementById(LAYER_ID);
    return {
        w,
        doc,
        chrome,
        draws,
        pixelReads,
        cancelled,
        frameCallbacks,
        resizers,
        layer,
        panels,
        nativePanels,
        prepareVideo,
        contexts: () => contexts,
        advance(ms) {
            now += ms;
        },
        setHidden(value) {
            hidden = value;
            doc.dispatchEvent(new w.Event("visibilitychange"));
        },
        setFullscreen(element) {
            fullscreenElement = element;
            doc.dispatchEvent(new w.Event("fullscreenchange"));
        },
        setPlayerBox(next) {
            playerBox = { ...next };
        },
        // Deliver the pending frame callback of the current main video, as Chrome would on a new frame.
        frame() {
            const pending = [...frameCallbacks.entries()];
            assert.equal(pending.length, 1, "exactly one frame callback is pending");
            const [id, { callback }] = pending[0];
            frameCallbacks.delete(id);
            callback(now, {});
        },
        change(changes) {
            const payload = {};
            for (const [key, newValue] of Object.entries(changes)) {
                payload[key] = { oldValue: chrome.testState.sync[key], newValue };
                chrome.testState.sync[key] = newValue;
            }
            for (const listener of [...chrome.testState.storageChangeListeners]) listener(payload, "sync");
        },
        changeLocal(changes) {
            const payload = {};
            for (const [key, newValue] of Object.entries(changes)) {
                payload[key] = { oldValue: chrome.testState.local[key], newValue };
                chrome.testState.local[key] = newValue;
            }
            for (const listener of [...chrome.testState.storageChangeListeners]) listener(payload, "local");
        },
        row: () => doc.getElementById("betterchzzk-ambient-row"),
        expand: () => doc.getElementById("betterchzzk-ambient-expand"),
        toggle: () => doc.getElementById("betterchzzk-ambient-toggle"),
        strength: () => doc.getElementById("betterchzzk-ambient-strength"),
        async route(path) {
            w.history.pushState(null, "", path);
            w.dispatchEvent(new w.CustomEvent("betterchzzk:routechange"));
        },
    };
}

test("ambient glow is off by default and leaves the page and canvas untouched", async (t) => {
    const f = fixture(t, {});
    await waitForAsyncCallbacks();
    assert.equal(f.layer(), null);
    assert.equal(f.doc.getElementById(STYLE_ID), null);
    assert.equal(f.contexts(), 0);
    assert.equal(f.frameCallbacks.size, 0);
    assert.deepEqual(f.panels(), f.nativePanels);
});

test("enabled glow surrounds the player, spills over chat and sidebar, and never reads pixels", async (t) => {
    const f = fixture(t, { ambientEnabled: true, ambientIntensity: 80 });
    await waitForCondition(() => f.layer() && !f.layer().hidden);
    const layer = f.layer();
    assert.equal(layer.parentElement, f.doc.body);
    assert.equal(layer.getAttribute("aria-hidden"), "true");
    assert.equal(layer.style.getPropertyValue("--bcam-strength"), "0.80");
    const css = f.doc.getElementById(STYLE_ID).textContent;
    assert.match(css, /pointer-events:none/);
    // Same z-index as the native header container, appended last, so the header is lit too.
    assert.match(css, /z-index:10000;/);
    assert.equal(layer, f.doc.body.lastElementChild);
    assert.match(css, /html\.theme_dark #betterchzzk-ambient\{mix-blend-mode:screen\}/);
    assert.match(css, /mix-blend-mode:multiply/);

    // 288px layer margin on every side (3x the 96px blur, doubled on 2026-10-08 so the light
    // reaches deeper into the sidebar on the left and the chat on the right).
    assert.equal(layer.style.left, "-48px");
    assert.equal(layer.style.top, "-228px");
    assert.equal(layer.style.width, "2031px");
    assert.equal(layer.style.height, "1394px");
    assert.equal(
        layer.style.clipPath,
        // The outer region starts at the layer top: the 60px header is lit too (2026-10-08 request).
        "polygon(evenodd, 0px 0px, 2031px 0px, 2031px 1394px, 0px 1394px, 0px 0px, " +
            "288px 288px, 1743px 288px, 1743px 1106px, 288px 1106px, 288px 288px)"
    );
    const canvas = layer.querySelector("canvas");
    assert.match(css, /filter:blur\(96px\)/);
    assert.equal(canvas.style.left, "240px");
    assert.equal(canvas.style.top, "240px");
    assert.equal(canvas.style.width, "1551px");
    assert.equal(canvas.style.height, "914px");
    assert.equal(canvas.width, 48);
    assert.equal(canvas.height, 27);

    // The layer is drawn on show; later frames are throttled to 10 per second and blended.
    const firstDraws = f.draws.length;
    assert.ok(firstDraws >= 1);
    assert.equal(f.draws[0].source, f.doc.querySelector("video"));
    assert.deepEqual(f.draws[0].args, [0, 0, 48, 27]);
    assert.equal(f.draws[0].alpha, 1);
    assert.equal(layer.getAttribute("data-bcam-ready"), "1");
    f.advance(50);
    f.frame();
    assert.equal(f.draws.length, firstDraws);
    f.advance(60);
    f.frame();
    assert.equal(f.draws.length, firstDraws + 1);
    assert.equal(f.draws.at(-1).alpha, 0.35);
    assert.equal(f.frameCallbacks.size, 1);

    assert.deepEqual(f.pixelReads, []);
    assert.deepEqual(f.panels(), f.nativePanels, "native chat and sidebar nodes are never restyled");
});

test("glow reaches the header and keeps the whole player cut out when the page scrolls", async (t) => {
    const f = fixture(t);
    await waitForCondition(() => f.layer() && !f.layer().hidden);
    f.setPlayerBox({ ...PLAYER, top: -200 });
    f.doc.querySelector("main").dispatchEvent(new f.w.Event("scroll"));
    await waitForCondition(() => f.layer().style.top === "-488px");
    // The player now sits partly under the header; its full box stays cut out so the header only
    // gets the falloff above the video, never a full-strength band of the frame.
    assert.match(f.layer().style.clipPath, /^polygon\(evenodd, 0px 0px, .*, 288px 288px, 1743px 288px, /);

    const before = f.layer().style.top;
    f.setPlayerBox(PLAYER);
    f.doc.querySelector(".chat-list").dispatchEvent(new f.w.Event("scroll"));
    await new Promise((resolve) => f.w.requestAnimationFrame(resolve));
    assert.equal(f.layer().style.top, before, "chat scrolling does not relayout the glow");

    f.setPlayerBox({ ...PLAYER, top: -2000 });
    f.w.dispatchEvent(new f.w.Event("resize"));
    await waitForCondition(() => f.layer().hidden);
    assert.equal(f.frameCallbacks.size, 0, "an off-screen player is not sampled");
});

test("hidden tabs and fullscreen stop sampling and resume afterwards", async (t) => {
    const f = fixture(t);
    await waitForCondition(() => f.layer() && !f.layer().hidden && f.frameCallbacks.size === 1);
    f.setHidden(true);
    assert.equal(f.frameCallbacks.size, 0);
    assert.equal(f.cancelled.length, 1);
    f.setHidden(false);
    await waitForCondition(() => f.frameCallbacks.size === 1);

    f.setFullscreen(f.doc.querySelector(".pzp-pc"));
    await waitForCondition(() => f.layer().hidden);
    assert.equal(f.frameCallbacks.size, 0);
    f.setFullscreen(null);
    await waitForCondition(() => !f.layer().hidden && f.frameCallbacks.size === 1);
});

test("live multiview turns the glow off while its host is active and restores it afterwards", async (t) => {
    const f = fixture(t);
    await waitForCondition(() => f.layer() && !f.layer().hidden && f.frameCallbacks.size === 1);
    const host = f.doc.querySelector("main");
    f.doc.querySelector(".pzp-pc").setAttribute("data-bcmv-native", "1");
    // 2026-10-08 Chrome evidence: the active host shrinks the native player into a tile beside
    // secondary videos; only the host attribute flips when a single channel keeps the full size.
    host.setAttribute("data-bcmv-host", "active");
    await waitForCondition(() => f.layer().hidden);
    assert.equal(f.frameCallbacks.size, 0, "multiview is not sampled");
    host.setAttribute("data-bcmv-host", "idle");
    await waitForCondition(() => !f.layer().hidden && f.frameCallbacks.size === 1);
    host.setAttribute("data-bcmv-host", "active");
    await waitForCondition(() => f.layer().hidden);
    host.removeAttribute("data-bcmv-host");
    await waitForCondition(() => !f.layer().hidden && f.frameCallbacks.size === 1);
    assert.deepEqual(f.pixelReads, []);
});

test("the gear menu row keeps strength folded until its label is clicked and the switch toggles the glow", async (t) => {
    const f = fixture(t);
    await waitForCondition(() => f.row() && f.layer() && !f.layer().hidden && f.frameCallbacks.size === 1);
    const menu = f.doc.querySelector(".pzp-pc__settings");
    const row = f.row();
    const expand = f.expand();
    const toggle = f.toggle();
    assert.equal(row.parentElement, menu);
    assert.equal(row.nextElementSibling, f.strength(), "the slider sits directly under its row");
    assert.ok(row.contains(expand) && row.contains(toggle));
    assert.equal(expand.textContent, "앰비언트");
    assert.equal(expand.getAttribute("role"), "menuitem");
    assert.equal(expand.getAttribute("aria-controls"), f.strength().id);
    assert.equal(toggle.getAttribute("role"), "menuitemcheckbox");
    assert.equal(toggle.getAttribute("aria-label"), "앰비언트 켜기");
    assert.ok(toggle.querySelector(".pzp-ui-toggle__handle"));
    // Buttons center their text by default; the native track has no left, so it must be pinned
    // or it drifts right of its knob (seen in a 2026-10-08 render with the live player CSS).
    const css = f.doc.getElementById(STYLE_ID).textContent;
    assert.match(css, /#betterchzzk-ambient-toggle \.pzp-ui-toggle__handle:before\{left:0\}/);
    assert.match(css, /:is\(#betterchzzk-ambient-expand,#betterchzzk-ambient-toggle\)\{[^}]*text-align:start/);
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    assert.equal(expand.getAttribute("aria-expanded"), "false");
    assert.equal(f.strength().hidden, true, "strength starts folded");
    let playerClicks = 0;
    f.doc.querySelector(".pzp-pc").addEventListener("click", () => playerClicks++);

    // The label (or the row around it) unfolds the slider without touching on/off.
    expand.click();
    assert.equal(expand.getAttribute("aria-expanded"), "true");
    assert.equal(f.strength().hidden, false);
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    row.querySelector(".pzp-ui-setting-home-item__top").click();
    assert.equal(f.strength().hidden, true, "clicking the row again folds it");
    expand.click();

    // The switch alone turns the glow off and on and keeps the fold state.
    toggle.click();
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    assert.equal(f.strength().hidden, false, "the switch never folds the slider");
    assert.equal(f.layer()?.hidden ?? true, true);
    assert.equal(f.frameCallbacks.size, 0, "a switched-off glow is not sampled");
    await waitForCondition(() => f.chrome.testState.local[STATE_KEY] === true);
    assert.equal(f.chrome.testState.sync.ambientEnabled, true, "the switch never changes the option itself");

    toggle.querySelector(".pzp-ui-toggle__handle").click();
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    await waitForCondition(() => !f.layer().hidden && f.frameCallbacks.size === 1);
    await waitForCondition(() => f.chrome.testState.local[STATE_KEY] === false);
    assert.equal(playerClicks, 0, "menu clicks never reach the player");
    assert.deepEqual(f.pixelReads, []);

    f.change({ ambientEnabled: false });
    assert.equal(f.row(), null);
    assert.equal(f.strength(), null);
    assert.equal(menu.children.length, 1, "only the native rows remain");
});

test("a remembered off choice survives reloads and follows other tabs", async (t) => {
    const f = fixture(t, { ambientEnabled: true }, "/live/test-channel", { [STATE_KEY]: true });
    await waitForCondition(() => f.toggle()?.getAttribute("aria-checked") === "false");
    assert.equal(f.layer(), null, "no glow flashes before or after reading the off choice");
    assert.equal(f.contexts(), 0);
    f.changeLocal({ [STATE_KEY]: false });
    await waitForCondition(() => f.layer() && !f.layer().hidden && f.frameCallbacks.size === 1);
    assert.equal(f.toggle().getAttribute("aria-checked"), "true");
    f.changeLocal({ [STATE_KEY]: true });
    assert.equal(f.toggle().getAttribute("aria-checked"), "false");
    await waitForCondition(() => f.layer().hidden && f.frameCallbacks.size === 0);
});

test("the gear menu slider changes strength at once and saves the synced option after the drag", async (t) => {
    const f = fixture(t);
    await waitForCondition(() => f.strength() && f.layer() && !f.layer().hidden);
    f.expand().click();
    assert.equal(f.strength().hidden, false);
    const input = f.strength().querySelector('input[type="range"]');
    const value = f.strength().querySelector(".pzp-ui-setting-home-item__value");
    assert.equal(input.value, "60");
    assert.equal(value.textContent, "60%");
    assert.equal(input.getAttribute("aria-valuetext"), "60%");
    assert.equal(f.doc.querySelector(`label[for="${input.id}"]`).textContent, "세기");
    let playerKeys = 0;
    f.doc.querySelector(".pzp-pc").addEventListener("keydown", () => playerKeys++);

    input.value = "85";
    input.dispatchEvent(new f.w.Event("input", { bubbles: true }));
    assert.equal(f.layer().style.getPropertyValue("--bcam-strength"), "0.85");
    assert.equal(value.textContent, "85%");
    assert.equal(f.chrome.testState.sync.ambientIntensity, undefined, "the save waits for the drag to settle");
    await waitForCondition(() => f.chrome.testState.sync.ambientIntensity === 85);
    // The save callback (before any option echo) keeps the slider on the saved value.
    await waitForAsyncCallbacks();
    assert.equal(input.value, "85");
    assert.equal(f.layer().style.getPropertyValue("--bcam-strength"), "0.85");
    input.dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    assert.equal(playerKeys, 0, "slider keys do not reach player shortcuts");

    // The option echo keeps the value; another tab's later change is followed.
    f.change({ ambientIntensity: 85 });
    assert.equal(f.layer().style.getPropertyValue("--bcam-strength"), "0.85");
    f.change({ ambientIntensity: 30 });
    assert.equal(input.value, "30");
    assert.equal(value.textContent, "30%");
    assert.equal(f.layer().style.getPropertyValue("--bcam-strength"), "0.30");

    // Turning the option off mid-drag still keeps the chosen strength.
    input.value = "45";
    input.dispatchEvent(new f.w.Event("input", { bubbles: true }));
    f.change({ ambientEnabled: false });
    await waitForCondition(() => f.chrome.testState.sync.ambientIntensity === 45);
});

test("a re-rendered gear menu gets one row again and the keyboard reaches label and switch", async (t) => {
    const f = fixture(t);
    await waitForCondition(() => f.row());
    f.w.Element.prototype.getClientRects = function () {
        return [this.getBoundingClientRect()];
    };
    f.doc.querySelector(".pzp-pc__settings").outerHTML = MENU;
    await waitForCondition(() => f.row()?.parentElement === f.doc.querySelector(".pzp-pc__settings"));
    for (const id of ["row", "expand", "toggle", "strength"])
        assert.equal(f.doc.querySelectorAll(`#betterchzzk-ambient-${id}`).length, 1);
    assert.equal(f.row().nextElementSibling, f.strength());

    const key = (target, value) =>
        target.dispatchEvent(new f.w.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
    const native = f.doc.getElementById("native-quality");
    native.focus();
    key(native, "ArrowUp");
    assert.equal(f.doc.activeElement, f.expand(), "arrows enter the row on its label");
    key(f.expand(), " ");
    assert.equal(f.strength().hidden, false, "Space on the label unfolds the slider");
    key(f.expand(), "ArrowRight");
    assert.equal(f.doc.activeElement, f.toggle());
    key(f.toggle(), "Enter");
    assert.equal(f.toggle().getAttribute("aria-checked"), "false");
    key(f.toggle(), "ArrowLeft");
    assert.equal(f.doc.activeElement, f.expand());
    key(f.toggle(), "ArrowDown");
    assert.equal(f.doc.activeElement, native, "arrows leave the row from either control");
});

test("routes clear the previous broadcast and non-playback pages drop the effect", async (t) => {
    const f = fixture(t);
    await waitForCondition(() => f.layer()?.getAttribute("data-bcam-ready") === "1");
    await f.route("/lives");
    await waitForCondition(() => f.layer().hidden);
    assert.equal(f.layer().hasAttribute("data-bcam-ready"), false);
    assert.equal(f.frameCallbacks.size, 0);

    // A replaced player video is rebound; the old element's callbacks are not reused.
    const oldVideo = f.doc.querySelector("video");
    const nextVideo = f.doc.createElement("video");
    oldVideo.replaceWith(nextVideo);
    f.prepareVideo(nextVideo);
    nextVideo.setReadyState(0);
    await f.route("/video/123");
    await waitForCondition(() => !f.layer().hidden && f.frameCallbacks.size === 1);
    assert.equal([...f.frameCallbacks.values()][0].video, nextVideo);
    assert.equal(f.layer().hasAttribute("data-bcam-ready"), false, "no frame before the new video has data");
    nextVideo.setReadyState(4);
    f.advance(200);
    f.frame();
    assert.equal(f.draws.at(-1).source, nextVideo);
    assert.equal(f.draws.at(-1).alpha, 1);
    nextVideo.dispatchEvent(new f.w.Event("emptied"));
    assert.equal(f.layer().hasAttribute("data-bcam-ready"), false);
});

test("intensity applies live and turning the option off removes every owned resource", async (t) => {
    const f = fixture(t);
    await waitForCondition(() => f.layer() && !f.layer().hidden && f.frameCallbacks.size === 1);
    const layer = f.layer();
    assert.equal(layer.style.getPropertyValue("--bcam-strength"), "0.60");
    f.change({ ambientIntensity: 25 });
    assert.equal(f.layer(), layer);
    assert.equal(layer.style.getPropertyValue("--bcam-strength"), "0.25");

    const pending = [...f.frameCallbacks.values()][0];
    f.change({ ambientEnabled: false });
    assert.equal(f.layer(), null);
    assert.equal(f.doc.getElementById(STYLE_ID), null);
    assert.equal(f.frameCallbacks.size, 0);
    assert.equal(f.resizers.size, 0);
    const drawn = f.draws.length;
    pending.callback(0, {});
    f.doc.querySelector("video").dispatchEvent(new f.w.Event("seeked"));
    assert.equal(f.draws.length, drawn, "late callbacks and media events never redraw");
    assert.deepEqual(f.panels(), f.nativePanels);

    f.change({ ambientEnabled: true });
    await waitForCondition(() => f.layer() && !f.layer().hidden);
    assert.notEqual(f.layer(), layer);
    assert.equal(f.layer().style.getPropertyValue("--bcam-strength"), "0.25");
});

test("pagehide stops the glow and pageshow restores it in the same document", async (t) => {
    const f = fixture(t);
    await waitForCondition(() => f.layer() && !f.layer().hidden);
    f.w.dispatchEvent(new f.w.Event("pagehide"));
    assert.equal(f.layer(), null);
    assert.equal(f.frameCallbacks.size, 0);
    f.w.dispatchEvent(new f.w.Event("pageshow"));
    await waitForCondition(() => f.layer() && !f.layer().hidden && f.frameCallbacks.size === 1);
});

test("options expose a default-off ambient toggle with a labelled percent slider", async (t) => {
    const chrome = createFakeChrome();
    const dom = createDom("options.html", "options.html", chrome);
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();
    const { document } = dom.window;
    const toggle = queryOption(document, "ambientEnabled");
    const slider = queryOption(document, "ambientIntensity");
    const output = document.querySelector('output[for="ambientIntensity"]');
    assert.equal(toggle.checked, false);
    // Ambient settings live in their own player-tab group, separate from multiview.
    const group = toggle.closest(".option-group");
    assert.equal(group.dataset.optionGroup, "player-ambient");
    assert.equal(group.closest('[role="tabpanel"]').id, "tab-panel-player");
    assert.equal(slider.closest(".option-group"), group);
    assert.equal(group.querySelector('[data-option="liveMultiviewEnabled"]'), null);
    assert.equal(slider.type, "range");
    assert.equal(slider.value, "60");
    assert.equal(slider.disabled, true, "strength depends on the effect toggle");
    assert.equal(output.textContent, "60%");
    assert.equal(slider.getAttribute("aria-valuetext"), "60%");
    assert.equal(slider.closest("label").textContent.includes("효과 강도"), true);
    assert.ok(document.getElementById(toggle.getAttribute("aria-describedby")).textContent.includes("채팅창"));

    toggle.checked = true;
    dispatch(dom, toggle, "change");
    assert.equal(slider.disabled, false);
    slider.value = "85";
    dispatch(dom, slider, "input");
    assert.equal(output.textContent, "85%");
    assert.equal(slider.getAttribute("aria-valuetext"), "85%");
    document.getElementById("save").click();
    await waitForAsyncCallbacks();
    assert.equal(chrome.testState.sync.ambientEnabled, true);
    assert.equal(chrome.testState.sync.ambientIntensity, 85);

    document.getElementById("reset").click();
    await waitForAsyncCallbacks();
    assert.equal(slider.value, "60");
    assert.equal(output.textContent, "60%");
});

test("ambient glow runs in the isolated world after the shared content utilities", () => {
    const manifest = JSON.parse(readRepoFile("manifest.json"));
    const entry = manifest.content_scripts.find((item) => item.js.includes("features/ambientGlow.js"));
    assert.ok(entry);
    assert.equal(entry.world, undefined);
    assert.ok(entry.js.indexOf("content.js") < entry.js.indexOf("features/ambientGlow.js"));
    assert.doesNotMatch(readRepoFile("features", "ambientGlow.js"), /getImageData|toDataURL|toBlob|captureStream/);
});
