const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const {
    readRepoFile,
    createFakeChrome,
    createDom,
    evalRepoScript,
    dispatch,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

const ID = "betterchzzk-player-zoom";
const markup = `<div class="pzp-pc pzp-pc--controls" tabindex="0">
<div class="pzp-pc__video"><video style="object-fit:contain"></video></div>
<div class="pzp-pc__bottom"><div class="pzp-pc__bottom-buttons-right"><button id="native">설정</button></div>
<div class="pzp-pc__volume"><button>볼륨</button><input type="range"></div><div role="slider"></div></div>
<div role="menu"><button>메뉴</button></div><div id="betterchzzk-stream-info">정보</div></div>`;

function transform(video) {
    const match = video.style.transform.match(/^translate\(([-\d.e+]+)px, ([-\d.e+]+)px\) scale\(([-\d.e+]+)\)$/);
    return match ? { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) } : { x: 0, y: 0, scale: 1 };
}

function closeTo(actual, expected) {
    assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} should equal ${expected}`);
}

function fixture(t, options = { playerZoomEnabled: true, playerZoomMode: "always" }) {
    const dom = new JSDOM(`<!doctype html>${markup}<aside><video data-bcmv-video></video><input></aside>`, {
        url: "https://chzzk.naver.com/live/test",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    const doc = w.document;
    let apply;
    let mainLookups = 0;
    const resizers = new Set();
    const activeWheel = new Set();
    const activePointerUp = new Set();
    const nativeAdd = w.addEventListener.bind(w);
    const nativeRemove = w.removeEventListener.bind(w);
    w.addEventListener = (type, listener, extra) => {
        if (type === "wheel") activeWheel.add(listener);
        if (type === "pointerup") activePointerUp.add(listener);
        nativeAdd(type, listener, extra);
    };
    w.removeEventListener = (type, listener, extra) => {
        if (type === "wheel") activeWheel.delete(listener);
        if (type === "pointerup") activePointerUp.delete(listener);
        nativeRemove(type, listener, extra);
    };
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
    w.BetterChzzkSettings = {
        getOptions(fn) {
            fn(options);
        },
        addOptionsChangeListener(fn) {
            apply = fn;
            return () => {};
        },
    };
    let base = { left: 100, top: 60, width: 800, height: 450 };
    function setVideoBox(video) {
        Object.defineProperties(video, {
            videoWidth: { configurable: true, value: 1920 },
            videoHeight: { configurable: true, value: 1080 },
        });
        video.getBoundingClientRect = () => {
            const { x, y, scale } = transform(video);
            const left = base.left + x,
                top = base.top + y;
            const width = base.width * scale,
                height = base.height * scale;
            return { left, top, width, height, right: left + width, bottom: top + height };
        };
    }
    setVideoBox(doc.querySelector(".pzp-pc video"));
    doc.querySelector("aside video").getBoundingClientRect = () => ({ width: 1600, height: 900 });
    w.eval(readRepoFile("content.js"));
    const main = w.BetterChzzk.utils.getMainVideoElement;
    w.BetterChzzk.utils.getMainVideoElement = () => {
        mainLookups++;
        return main();
    };
    w.eval(readRepoFile("features/playerZoom.js"));
    const video = () => doc.querySelector(".pzp-pc video");
    const player = () => doc.querySelector(".pzp-pc");
    const wheel = (deltaY = -100, init = {}, target = video()) => {
        const event = new w.WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            clientX: 300,
            clientY: 160,
            deltaY,
            ...init,
        });
        target.dispatchEvent(event);
        return event;
    };
    const pointer = (type, init = {}, target = video()) => {
        const event = new w.MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: 300,
            clientY: 160,
            button: 0,
            buttons: 1,
            ...init,
        });
        Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true } });
        target.dispatchEvent(event);
        return event;
    };
    const route = (path) => {
        w.history.replaceState(null, "", path);
        w.dispatchEvent(new w.Event("betterchzzk:routechange"));
    };
    t.after(() => {
        apply({ playerZoomEnabled: false });
        dom.window.close();
    });
    return {
        w,
        doc,
        apply: (value) => apply(value),
        video,
        player,
        wheel,
        pointer,
        route,
        setVideoBox,
        toggle: () => doc.getElementById(`${ID}-toggle`),
        reset: () => doc.getElementById(`${ID}-reset`),
        panel: () => doc.getElementById(`${ID}-panel`),
        range: () => doc.getElementById(`${ID}-range`),
        value: () => doc.getElementById(`${ID}-value`),
        setPercent(percent) {
            const range = doc.getElementById(`${ID}-range`);
            range.value = String(percent);
            range.dispatchEvent(new w.Event("input", { bubbles: true }));
        },
        counts: () => ({
            mainLookups,
            wheels: activeWheel.size,
            resizers: resizers.size,
            pointerUps: activePointerUp.size,
        }),
        resize: (next) => {
            base = { ...base, ...next };
            for (const resize of resizers) resize.fn();
        },
    };
}

test("zoom defaults off; manual mode only consumes wheels after its player button is enabled", (t) => {
    const f = fixture(t, {});
    assert.equal(f.toggle(), null);
    assert.equal(f.wheel().defaultPrevented, false);
    assert.equal(f.counts().wheels, 0);
    f.apply({ playerZoomEnabled: true, playerZoomMode: "manual" });
    assert.equal(f.toggle().getAttribute("aria-pressed"), "false");
    assert.equal(f.wheel().defaultPrevented, false);
    f.toggle().click();
    assert.equal(f.toggle().getAttribute("aria-pressed"), "true");
    assert.equal(f.wheel().defaultPrevented, true);
    closeTo(transform(f.video()).scale, 1.2);
    f.toggle().click();
    assert.equal(transform(f.video()).scale, 1);
    assert.equal(f.panel().hidden, true);
    assert.equal(f.reset().disabled, true);
    assert.equal(f.wheel().defaultPrevented, false);
});

test("always mode anchors each zoom at the cursor, clamps scale, and restores the original video styles", (t) => {
    const f = fixture(t);
    const video = f.video(),
        parent = video.parentNode;
    video.style.setProperty("transform", "translateZ(0)", "important");
    video.style.setProperty("transform-origin", "center");
    video.style.setProperty("clip-path", "inset(0px)");
    video.style.setProperty("transition", "opacity 0.2s");
    const original = video.style.cssText;
    assert.equal(f.toggle().hidden, true);
    f.wheel();
    let next = transform(video);
    closeTo(next.x, -40);
    closeTo(next.y, -20);
    const oldPoint = (600 - 100 - next.x) / next.scale;
    f.wheel(-100, { clientX: 600, clientY: 300 });
    next = transform(video);
    closeTo((600 - 100 - next.x) / next.scale, oldPoint);
    assert.equal(video.parentNode, parent);
    assert.ok(video.style.clipPath.startsWith("inset("));
    assert.equal(f.value().textContent, "144%");
    assert.equal(f.reset().title, "되돌리기");
    assert.ok(f.reset().querySelector('svg[aria-hidden="true"]'));
    for (let i = 0; i < 30; i++) f.wheel();
    assert.equal(transform(video).scale, 5);
    f.reset().click();
    assert.equal(video.style.cssText, original);
    assert.equal(f.panel().hidden, true);
    assert.equal(f.wheel(100).defaultPrevented, true);
    assert.equal(transform(video).scale, 1);
    f.wheel(-100);
    f.wheel(100);
    assert.equal(transform(video).scale, 1);
});

test("zoom ignores player controls, overlays, previews, modifiers, and horizontal scrolling", (t) => {
    const f = fixture(t);
    for (const selector of [
        "#native",
        ".pzp-pc__bottom",
        ".pzp-pc__volume input",
        "[role=slider]",
        "[role=menu]",
        "#betterchzzk-stream-info",
        "aside video",
        "aside input",
    ]) {
        assert.equal(f.wheel(-100, {}, f.doc.querySelector(selector)).defaultPrevented, false, selector);
    }
    for (const extra of [
        { ctrlKey: true },
        { metaKey: true },
        { altKey: true },
        { shiftKey: true },
        { deltaX: 200 },
        { clientX: 99 },
        { clientY: 511 },
    ]) {
        assert.equal(f.wheel(-100, extra).defaultPrevented, false, JSON.stringify(extra));
    }
    assert.equal(f.wheel(0).defaultPrevented, false);
    assert.equal(f.wheel(-100, {}, f.doc.querySelector(".pzp-pc__video")).defaultPrevented, true);
    const wrapper = f.doc.createElement("div");
    f.video().before(wrapper);
    wrapper.append(f.video());
    assert.equal(f.wheel(-100, {}, wrapper).defaultPrevented, true);
    const overlay = f.doc.createElement("div");
    wrapper.append(overlay);
    assert.equal(f.wheel(-100, {}, overlay).defaultPrevented, false);
    assert.equal(f.doc.querySelector("aside video").style.transform, "");
});

test("pixel, line, page and fine trackpad wheels zoom without scanning all videos on every event", async (t) => {
    const f = fixture(t);
    // Flush the initial control insertions before measuring the gesture hot path.
    await new Promise((resolve) => f.w.queueMicrotask(resolve));
    const before = f.counts().mainLookups;
    for (const [deltaY, deltaMode] of [
        [-1, 0],
        [-3, 1],
        [-1, 2],
    ]) {
        const previous = transform(f.video()).scale;
        assert.equal(f.wheel(deltaY, { deltaMode }).defaultPrevented, true);
        assert.ok(transform(f.video()).scale > previous);
    }
    for (let i = 0; i < 50; i++) f.wheel(-1);
    await new Promise((resolve) => f.w.queueMicrotask(resolve));
    assert.equal(f.counts().mainLookups, before);
});

test("drag pans inside the video bounds and suppresses only its resulting playback click", (t) => {
    const f = fixture(t);
    let clicks = 0,
        multiviewStarts = 0;
    f.player().addEventListener("click", () => clicks++);
    f.player().addEventListener("pointerdown", () => multiviewStarts++, true);
    f.wheel();
    f.pointer("pointerdown");
    f.pointer("pointermove", { clientX: 325, clientY: 172 });
    closeTo(transform(f.video()).x, -15);
    closeTo(transform(f.video()).y, -8);
    f.pointer("pointerup", { clientX: 325, clientY: 172, buttons: 0 });
    f.video().dispatchEvent(new f.w.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    assert.equal(clicks, 0);
    assert.equal(multiviewStarts, 0);
    f.pointer("pointerdown");
    f.pointer("pointerup", { buttons: 0 });
    f.video().dispatchEvent(new f.w.MouseEvent("click", { bubbles: true, detail: 1 }));
    assert.equal(clicks, 1, "a regular click still reaches native playback");
    f.pointer("pointerdown");
    f.pointer("pointermove", { clientX: -5000, clientY: -5000 });
    closeTo(transform(f.video()).x, -160);
    closeTo(transform(f.video()).y, -90);
    f.pointer("pointermove", { clientX: 5000, clientY: 5000 });
    closeTo(transform(f.video()).x, 0);
    closeTo(transform(f.video()).y, 0);
    f.w.dispatchEvent(new f.w.Event("blur"));
    assert.equal(f.player().hasAttribute("data-bcz-dragging"), false);
    f.pointer("pointermove", { clientX: -5000 });
    closeTo(transform(f.video()).x, 0);
    f.pointer("pointerdown", { altKey: true });
    assert.equal(multiviewStarts, 1, "Alt drag remains available to multiview");
});

test("letterboxed portrait video stays centred on the short axis and scales across resize/fullscreen", (t) => {
    const f = fixture(t);
    Object.defineProperties(f.video(), { videoWidth: { value: 1080 }, videoHeight: { value: 1920 } });
    f.wheel();
    closeTo(transform(f.video()).x, -80);
    f.resize({ width: 1600, height: 900 });
    closeTo(transform(f.video()).scale, 1.2);
    closeTo(transform(f.video()).x, -160);
    closeTo(transform(f.video()).y, -40);
    f.doc.dispatchEvent(new f.w.Event("fullscreenchange"));
    closeTo(transform(f.video()).x, -160);
    f.reset().click();
    assert.equal(transform(f.video()).scale, 1);
});

test("mode changes, sources, SPA navigation, disable and page suspension clean up zoom", (t) => {
    const f = fixture(t);
    f.wheel();
    f.apply({ playerZoomEnabled: true, playerZoomMode: "manual" });
    assert.equal(transform(f.video()).scale, 1);
    assert.equal(f.wheel().defaultPrevented, false);
    f.toggle().click();
    for (const name of ["emptied", "loadstart", "loadedmetadata"]) {
        f.wheel();
        f.video().dispatchEvent(new f.w.Event(name));
        assert.equal(transform(f.video()).scale, 1, name);
    }
    f.wheel();
    f.route("/video/123");
    assert.equal(transform(f.video()).scale, 1);
    assert.equal(f.toggle().getAttribute("aria-pressed"), "false");
    f.route("/lives");
    assert.equal(f.toggle(), null);
    assert.equal(f.counts().wheels, 0);
    assert.equal(f.counts().resizers, 0);
    f.route("/live/another");
    assert.equal(f.counts().wheels, 1);
    f.apply({ playerZoomEnabled: true, playerZoomMode: "always" });
    f.wheel();
    f.w.dispatchEvent(new f.w.Event("pagehide"));
    assert.equal(transform(f.video()).scale, 1);
    assert.equal(f.counts().wheels, 0);
    f.w.dispatchEvent(new f.w.Event("pageshow"));
    assert.equal(f.counts().wheels, 1);
    f.wheel();
    f.apply({ playerZoomEnabled: false });
    assert.equal(transform(f.video()).scale, 1);
    assert.equal(f.doc.getElementById(`${ID}-style`), null);
    assert.equal(f.toggle(), null);
    assert.equal(f.counts().wheels, 0);
    assert.equal(f.counts().resizers, 0);
});

test("native control and video remounts keep one control set; detached controls become inert", async (t) => {
    const f = fixture(t);
    f.wheel();
    const oldToggle = f.toggle();
    f.doc.querySelector(".pzp-pc__bottom-buttons-right").outerHTML = '<div class="pzp-pc__bottom-buttons-right"></div>';
    await waitForCondition(() => f.toggle() !== oldToggle);
    assert.equal(transform(f.video()).scale > 1, true);
    const oldVideo = f.video();
    oldVideo.outerHTML = '<video style="object-fit:contain"></video>';
    f.setVideoBox(f.video());
    await waitForCondition(() => oldVideo.style.transform === "");
    assert.equal(transform(f.video()).scale, 1);
    f.apply({ playerZoomEnabled: true, playerZoomMode: "manual" });
    oldToggle.click();
    assert.equal(f.toggle().getAttribute("aria-pressed"), "false");
    f.w.eval(readRepoFile("features/playerZoom.js"));
    assert.equal(f.doc.querySelectorAll(`#${ID}-toggle`).length, 1);
    assert.equal(f.doc.querySelectorAll(`#${ID}-reset`).length, 1);
    assert.equal(f.counts().wheels, 1);
    assert.equal(f.counts().resizers, 1);
});

test("zoom panel and slider have accessible names and theme-specific slider tokens", (t) => {
    const f = fixture(t, { playerZoomEnabled: true, playerZoomMode: "manual" });
    assert.equal(f.toggle().type, "button");
    assert.equal(f.toggle().getAttribute("aria-label"), "확대 모드 켜기");
    assert.ok(f.toggle().querySelector('svg[aria-hidden="true"]'));
    f.toggle().click();
    f.wheel();
    assert.equal(f.panel().getAttribute("role"), "group");
    assert.equal(f.panel().getAttribute("aria-label"), "화면 확대");
    assert.equal(f.range().type, "range");
    assert.equal(f.range().getAttribute("aria-label"), "화면 확대 배율");
    assert.equal(f.range().getAttribute("aria-valuetext"), "120%");
    const fills = [];
    for (const theme of ["theme_light", "theme_dark"]) {
        f.doc.documentElement.className = theme;
        assert.equal(f.reset().type, "button");
        assert.ok(f.reset().getAttribute("aria-label"));
        const style = f.w.getComputedStyle(f.panel());
        assert.notEqual(style.color, style.backgroundColor);
        assert.notEqual(style.display, "none");
        // JSDOM does not resolve background var() fallbacks; inspect the selected theme tokens.
        fills.push(style.getPropertyValue("--bcz-fill"));
    }
    assert.ok(fills.every((fill) => fill.includes("--Content-neutral-strong")));
    assert.notEqual(fills[0], fills[1]);
});

test("manual mode exposes the slider at 100% and adjusts by one percent around the visible centre", (t) => {
    const f = fixture(t, { playerZoomEnabled: true, playerZoomMode: "manual" });
    assert.equal(f.panel().hidden, true);
    f.toggle().click();
    assert.equal(f.panel().hidden, false);
    assert.equal(f.range().min, "100");
    assert.equal(f.range().max, "500");
    assert.equal(f.range().step, "1");
    assert.equal(f.range().value, "100");
    assert.equal(f.reset().disabled, true);
    f.wheel();
    const previous = transform(f.video());
    const centreX = (400 - previous.x) / previous.scale;
    const centreY = (225 - previous.y) / previous.scale;
    f.setPercent(137);
    const enlarged = transform(f.video());
    closeTo(enlarged.scale, 1.37);
    closeTo((400 - enlarged.x) / enlarged.scale, centreX);
    closeTo((225 - enlarged.y) / enlarged.scale, centreY);
    assert.equal(f.value().textContent, "137%");
    assert.equal(f.range().getAttribute("aria-valuetext"), "137%");
    assert.equal(f.reset().disabled, false);
    f.setPercent(300);
    assert.equal(f.range().style.getPropertyValue("--bcz-progress"), "50%");
    f.setPercent(500);
    closeTo(transform(f.video()).scale, 5);
    f.reset().click();
    assert.equal(f.range().value, "100");
    assert.equal(f.value().textContent, "100%");
    assert.equal(f.panel().hidden, false, "manual mode stays available for the next slider adjustment");
    f.toggle().click();
    assert.equal(f.panel().hidden, true);
});

test("slider interaction keeps the 100% panel usable and preserves native keyboard actions", async (t) => {
    const f = fixture(t);
    f.wheel();
    f.range().focus();
    let nativeKeys = 0,
        nativeClicks = 0;
    f.player().addEventListener("keydown", () => nativeKeys++);
    f.player().addEventListener("click", () => nativeClicks++);
    f.player().addEventListener("dblclick", () => nativeClicks++);
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "Tab"]) {
        const event = new f.w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        f.range().dispatchEvent(event);
        assert.equal(event.defaultPrevented, false, "the range retains its native keyboard behaviour");
    }
    f.range().dispatchEvent(new f.w.MouseEvent("click", { bubbles: true }));
    f.panel().dispatchEvent(new f.w.MouseEvent("dblclick", { bubbles: true }));
    assert.equal(nativeKeys, 0);
    assert.equal(nativeClicks, 0);
    const volume = f.video().volume;
    const scale = transform(f.video()).scale;
    assert.equal(f.wheel(-100, {}, f.range()).defaultPrevented, false);
    closeTo(transform(f.video()).scale, scale);
    assert.equal(f.video().volume, volume);
    f.setPercent(100);
    assert.equal(f.doc.activeElement, f.range());
    assert.equal(f.panel().hidden, false);
    assert.equal(f.reset().disabled, true);
    f.setPercent(101);
    closeTo(transform(f.video()).scale, 1.01);
    f.setPercent(100);
    f.doc.querySelector("aside input").focus();
    await new Promise((resolve) => f.w.queueMicrotask(resolve));
    assert.equal(f.panel().hidden, true);
});

test("panel stays fixed when hovering reveals native controls and while adjusting", async (t) => {
    const f = fixture(t);
    f.wheel();
    const position = () => {
        const style = f.w.getComputedStyle(f.panel());
        return [style.right, style.bottom, style.transform];
    };
    f.player().classList.remove("pzp-pc--controls");
    const fixed = position();
    // The native player reveals its controls as the pointer approaches, before pointerdown.
    f.player().addEventListener("mouseover", () => f.player().classList.add("pzp-pc--controls"));
    f.reset().dispatchEvent(new f.w.MouseEvent("mouseover", { bubbles: true }));
    assert.deepEqual(position(), fixed, "the reset target must not move before the user can click it");
    assert.equal(f.w.getComputedStyle(f.panel()).transition, "none");
    f.pointer("pointerdown", {}, f.range());
    f.range().focus();
    f.player().classList.remove("pzp-pc--controls");
    assert.deepEqual(position(), fixed);
    f.setPercent(151);
    assert.deepEqual(position(), fixed);
    assert.equal(f.counts().pointerUps, 1);
    f.pointer("pointerup", { buttons: 0 }, f.doc.body);
    assert.equal(f.counts().pointerUps, 0);
    assert.deepEqual(position(), fixed);
    f.range().dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    f.player().classList.add("pzp-pc--controls");
    assert.deepEqual(position(), fixed);
    f.doc.querySelector("aside input").focus();
    await new Promise((resolve) => f.w.queueMicrotask(resolve));
    assert.deepEqual(position(), fixed);
    const media = Array.from(f.doc.getElementById(`${ID}-style`).sheet.cssRules).find((rule) =>
        rule.conditionText?.includes("prefers-reduced-motion")
    );
    assert.ok(media, "reduced motion has a dedicated override");
    assert.ok(
        Array.from(media.cssRules).some(
            (rule) => rule.selectorText.includes(`#${ID}-reset`) && rule.style.transition === "none"
        )
    );
});

test("range drags and detached panel events are cleaned up on disable and remount", async (t) => {
    const f = fixture(t);
    f.wheel();
    f.pointer("pointerdown", {}, f.range());
    assert.equal(f.counts().pointerUps, 1);
    const oldRange = f.range();
    f.panel().remove();
    await waitForCondition(() => f.range() && f.range() !== oldRange);
    assert.equal(f.counts().pointerUps, 0);
    assert.equal(f.doc.querySelectorAll(`#${ID}-panel`).length, 1);
    assert.equal(f.doc.querySelectorAll(`#${ID}-range`).length, 1);
    oldRange.value = "300";
    oldRange.dispatchEvent(new f.w.Event("input", { bubbles: true }));
    closeTo(transform(f.video()).scale, 1.2);
    f.setPercent(175);
    closeTo(transform(f.video()).scale, 1.75);
    f.pointer("pointerdown", {}, f.range());
    f.w.dispatchEvent(new f.w.Event("blur"));
    assert.equal(f.counts().pointerUps, 0);
    assert.equal(f.panel().style.transform, "");
    f.pointer("pointerdown", {}, f.range());
    const detached = f.range();
    f.apply({ playerZoomEnabled: false });
    assert.equal(f.panel(), null);
    assert.equal(f.range(), null);
    assert.equal(f.counts().pointerUps, 0);
    detached.value = "400";
    detached.dispatchEvent(new f.w.Event("input", { bubbles: true }));
    closeTo(transform(f.video()).scale, 1);
});

test("the real volume wheel handler and video zoom consume only their own surface", async (t) => {
    const f = fixture(t);
    const volume = f.doc.querySelector(".pzp-pc__volume");
    volume.getBoundingClientRect = () => ({ left: 150, top: 470, right: 220, bottom: 510, width: 70, height: 40 });
    f.video().volume = 0.5;
    f.doc.documentElement.setAttribute(
        "data-betterchzzk-volume-wheel-options",
        JSON.stringify({ enabled: true, step: 5 })
    );
    f.w.eval(readRepoFile("shared/volumeControlsPage.js"));
    f.w.eval(readRepoFile("features/volumeWheelPage.js"));
    assert.equal(f.wheel(-100, {}, volume).defaultPrevented, true);
    closeTo(f.video().volume, 0.55);
    assert.equal(transform(f.video()).scale, 1);
    f.wheel();
    closeTo(transform(f.video()).scale, 1.2);
    closeTo(f.video().volume, 0.55);
    f.wheel(100, {}, volume);
    closeTo(f.video().volume, 0.5);
    closeTo(transform(f.video()).scale, 1.2);
    // Let the volume feature's existing commit callbacks finish before closing the fixture.
    await new Promise((resolve) => f.w.requestAnimationFrame(resolve));
});

test("late player mounting and control removal do not rescan for unrelated chat updates", async (t) => {
    const f = fixture(t);
    f.player().remove();
    await waitForCondition(() => f.counts().resizers === 0);
    const root = f.doc.createElement("section");
    root.innerHTML = markup;
    f.doc.body.append(root);
    f.setVideoBox(f.video());
    await waitForCondition(() => f.toggle());
    assert.equal(f.counts().wheels, 1);
    f.doc.querySelector(".pzp-pc__bottom-buttons-right").remove();
    await new Promise((resolve) => f.w.queueMicrotask(resolve));
    assert.equal(f.toggle(), null);
    const before = f.counts().mainLookups;
    for (let i = 0; i < 20; i++) f.doc.querySelector("aside").append(f.doc.createElement("p"));
    await new Promise((resolve) => f.w.queueMicrotask(resolve));
    assert.equal(f.counts().mainLookups, before);
    const controls = f.doc.createElement("div");
    controls.className = "pzp-pc__bottom-buttons-right";
    f.player().append(controls);
    await waitForCondition(() => f.toggle());
    f.wheel();
    assert.ok(transform(f.video()).scale > 1);
});

test("settings expose and persist the two activation modes with dependency and safe defaults", async (t) => {
    const chrome = createFakeChrome();
    const dom = createDom("options.html", "options.html", chrome);
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared/settings.js");
    evalRepoScript(dom, "options.js");
    const { document: doc, BetterChzzkSettings: settings } = dom.window;
    const enabled = doc.querySelector('[data-option="playerZoomEnabled"]');
    const mode = doc.querySelector('[data-option="playerZoomMode"]');
    await waitForCondition(() => doc.getElementById("notice").dataset.state === "saved");
    assert.equal(enabled.checked, false);
    assert.equal(mode.value, "manual");
    assert.equal(mode.disabled, true);
    assert.deepEqual(
        Array.from(mode.options, (option) => option.value),
        ["manual", "always"]
    );
    assert.ok(mode.closest("label").textContent.includes("확대 적용 방식"));
    for (const value of [undefined, null, "invalid", true, 1])
        assert.equal(settings.normalizeOptions({ playerZoomMode: value }).playerZoomMode, "manual");
    enabled.checked = true;
    dispatch(dom, enabled, "change");
    assert.equal(mode.disabled, false);
    mode.value = "always";
    dispatch(dom, mode, "change");
    doc.getElementById("save").click();
    await waitForCondition(
        () =>
            chrome.testState.sync.playerZoomMode === "always" && doc.getElementById("notice").dataset.state === "saved"
    );
    assert.equal(chrome.testState.sync.playerZoomEnabled, true);
    const manifest = JSON.parse(readRepoFile("manifest.json"));
    const entry = manifest.content_scripts.find((item) => item.js.includes("features/playerZoom.js"));
    assert.notEqual(entry.world, "MAIN");
    assert.ok(entry.js.indexOf("content.js") < entry.js.indexOf("features/playerZoom.js"));
});
