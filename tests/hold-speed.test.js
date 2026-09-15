const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");

function evalRepoScript(dom, ...parts) {
    const source = fs.readFileSync(path.join(ROOT, ...parts), "utf8");
    dom.window.eval(source);
}

function installFakeTimers(window) {
    let now = 1000;
    let nextId = 1;
    const tasks = new Map();

    Object.defineProperty(window.performance, "now", {
        configurable: true,
        value: () => now,
    });

    window.setTimeout = (callback, delay = 0, ...args) => {
        const id = nextId++;
        tasks.set(id, { callback: () => callback(...args), due: now + Math.max(0, Number(delay) || 0), repeat: 0 });
        return id;
    };
    window.clearTimeout = (id) => tasks.delete(id);
    window.setInterval = (callback, delay = 0, ...args) => {
        const id = nextId++;
        const repeat = Math.max(1, Number(delay) || 1);
        tasks.set(id, { callback: () => callback(...args), due: now + repeat, repeat });
        return id;
    };
    window.clearInterval = (id) => tasks.delete(id);

    function advance(ms) {
        const target = now + ms;
        let guard = 0;
        while (guard++ < 1000) {
            const next = Array.from(tasks.entries())
                .filter(([, task]) => task.due <= target)
                .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
            if (!next) break;

            const [id, task] = next;
            now = task.due;
            if (task.repeat) task.due += task.repeat;
            else tasks.delete(id);
            task.callback();
        }
        assert.ok(guard < 1000, "fake timer loop must stay bounded");
        now = target;
    }

    return { advance };
}

function configureVideo(dom, video, { paused = false, playbackRate = 1 } = {}) {
    const state = {
        paused,
        pauseCalls: 0,
        playCalls: 0,
    };

    Object.defineProperty(video, "paused", { configurable: true, get: () => state.paused });
    Object.defineProperty(video, "playbackRate", {
        configurable: true,
        get: () => playbackRate,
        set: (value) => {
            playbackRate = Number(value);
        },
    });
    video.play = () => {
        state.playCalls += 1;
        if (state.paused) {
            state.paused = false;
            video.dispatchEvent(new dom.window.Event("play"));
        }
        return Promise.resolve();
    };
    video.pause = () => {
        state.pauseCalls += 1;
        if (!state.paused) {
            state.paused = true;
            video.dispatchEvent(new dom.window.Event("pause"));
        }
    };
    video.getBoundingClientRect = () => ({ left: 10, top: 20, width: 960, height: 540, right: 970, bottom: 560 });
    return state;
}

function createFixture({
    url = "https://chzzk.naver.com/video/12345",
    options: initialOptions = {},
    paused = false,
    playbackRate = 1,
    beforeLoad,
} = {}) {
    const dom = new JSDOM(
        [
            "<!doctype html>",
            "<html><head></head><body>",
            '<main class="pzp pzp-pc"><video id="video"></video></main>',
            '<button id="outside-button" type="button">button</button>',
            '<input id="outside-input" />',
            '<summary id="outside-summary">summary</summary>',
            '<div id="editable" contenteditable="true">editable</div>',
            '<a id="outside-link" href="/video/999">link</a>',
            '<div id="outside-role" role="button" tabindex="0">role button</div>',
            '<div id="outside-textbox" role="textbox" tabindex="0">role textbox</div>',
            "</body></html>",
        ].join(""),
        { url, runScripts: "outside-only", pretendToBeVisual: true }
    );
    const { window } = dom;
    const { document } = window;
    const timers = installFakeTimers(window);
    const video = document.getElementById("video");
    const mediaState = configureVideo(dom, video, { paused, playbackRate });
    const options = {
        holdSpeedEnabled: true,
        playbackSpeedShortcutsEnabled: true,
        playbackSpeedHalfKeyCode: "BracketLeft",
        playbackSpeedDoubleKeyCode: "BracketRight",
        playbackSpeedResetKeyCode: "Backslash",
        ...initialOptions,
    };
    const optionListeners = [];
    const routeListeners = [];
    let playbackToggleIntentCalls = 0;
    let hidden = false;

    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (hidden ? "hidden" : "visible"),
    });

    window.BetterChzzkSettings = {
        normalizeOptions: () => ({ ...options }),
    };
    window.BetterChzzk = {
        skipControl: {
            markPlaybackToggleIntent() {
                playbackToggleIntentCalls += 1;
            },
        },
        utils: {
            bindFeatureOptions(callback) {
                optionListeners.push(callback);
                callback({ ...options });
                return () => {};
            },
            getMainVideoElement() {
                return (
                    Array.from(document.querySelectorAll("video")).find((candidate) => candidate.isConnected) || null
                );
            },
            getPlayerRoot: (video) => video.closest(".pzp-pc"),
            getVideoViewportRect: (video) => video.getBoundingClientRect(),
            injectStyleOnce(id, css) {
                if (document.getElementById(id)) return;
                const style = document.createElement("style");
                style.id = id;
                style.textContent = css;
                document.head.appendChild(style);
            },
            isLiveRoute: () => /^\/live(?:\/|$)/.test(window.location.pathname),
            isPlaybackRoute: () => /^\/(?:live|video)(?:\/|$)/.test(window.location.pathname),
            isVodRoute: () => /^\/video(?:\/|$)/.test(window.location.pathname),
            startPageChangeDetection(callback) {
                routeListeners.push(callback);
                return () => {};
            },
        },
    };

    beforeLoad?.({ dom, document, mediaState, video, window });
    evalRepoScript(dom, "features", "holdSpeed.js");

    return {
        dom,
        document,
        mediaState,
        options,
        timers,
        video,
        window,
        getPlaybackToggleIntentCalls() {
            return playbackToggleIntentCalls;
        },
        emitOptions(patch) {
            Object.assign(options, patch);
            optionListeners.forEach((listener) => listener({ ...options }));
        },
        emitRoute(pathname) {
            window.history.pushState({}, "", pathname);
            routeListeners.forEach((listener) => listener());
        },
        setHidden(value) {
            hidden = value;
            document.dispatchEvent(new window.Event("visibilitychange"));
        },
    };
}

function dispatchSpace(fixture, type, { target = fixture.document.body, repeat = false, ...modifiers } = {}) {
    const event = new fixture.window.KeyboardEvent(type, {
        code: "Space",
        key: " ",
        bubbles: true,
        cancelable: true,
        repeat,
        ...modifiers,
    });
    target.dispatchEvent(event);
    return event;
}

function dispatchKey(
    fixture,
    type,
    { code, key = code, target = fixture.document.body, repeat = false, ...modifiers }
) {
    const event = new fixture.window.KeyboardEvent(type, {
        code,
        key,
        bubbles: true,
        cancelable: true,
        repeat,
        ...modifiers,
    });
    target.dispatchEvent(event);
    return event;
}

function dispatchPointer(fixture, type, { target = fixture.video, ...init } = {}) {
    const event = new fixture.window.PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: 400,
        clientY: 250,
        detail: 1,
        ...init,
    });
    target.dispatchEvent(event);
    return event;
}

test("left-button holds share the Space option and restore speed without toggling live or VOD playback", (t) => {
    for (const route of ["live/channel", "video/12345"]) {
        for (const paused of [false, true]) {
            const fixture = createFixture({ url: `https://chzzk.naver.com/${route}`, paused, playbackRate: 1.25 });
            t.after(() => fixture.dom.window.close());
            let clicks = 0;
            fixture.video.addEventListener("click", () => clicks++);

            assert.equal(dispatchPointer(fixture, "pointerdown").defaultPrevented, false);
            fixture.timers.advance(349);
            assert.equal(fixture.video.playbackRate, 1.25);
            fixture.timers.advance(1);
            assert.equal(fixture.video.playbackRate, 2);
            assert.equal(fixture.document.getElementById("betterchzzk-hold-speed-overlay").textContent, "2배속");
            dispatchPointer(fixture, "pointerup");
            assert.equal(fixture.video.playbackRate, 1.25);
            assert.equal(fixture.document.getElementById("betterchzzk-hold-speed-overlay"), null);
            assert.equal(dispatchPointer(fixture, "click").defaultPrevented, true);
            assert.equal(clicks, 0, "releasing a hold must not become a native playback click");
            assert.equal(fixture.mediaState.paused, paused);
            assert.equal(fixture.mediaState.pauseCalls + fixture.mediaState.playCalls, 0);

            fixture.emitOptions({ holdSpeedEnabled: false });
            dispatchPointer(fixture, "pointerdown");
            fixture.timers.advance(350);
            dispatchPointer(fixture, "pointerup");
            assert.equal(fixture.video.playbackRate, 1.25);
            assert.equal(dispatchPointer(fixture, "click").defaultPrevented, false);
            assert.equal(dispatchSpace(fixture, "keydown").defaultPrevented, false);
            fixture.emitOptions({ holdSpeedEnabled: true });
            dispatchPointer(fixture, "pointerdown");
            fixture.timers.advance(350);
            assert.equal(fixture.video.playbackRate, 2);
            dispatchPointer(fixture, "pointerup");
        }
    }
});

test("short left clicks and double clicks keep native behavior on the video and its wrapper", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dom.window.close());
    const player = fixture.video.parentElement;
    let clicks = 0;
    let doubles = 0;
    player.addEventListener("click", () => clicks++);
    player.addEventListener("dblclick", () => doubles++);
    for (const target of [fixture.video, player]) {
        for (const detail of [1, 2]) {
            dispatchPointer(fixture, "pointerdown", { target, detail });
            fixture.timers.advance(100);
            dispatchPointer(fixture, "pointerup", { target, detail });
            assert.equal(dispatchPointer(fixture, "click", { target, detail }).defaultPrevented, false);
        }
        assert.equal(dispatchPointer(fixture, "dblclick", { target, detail: 2 }).defaultPrevented, false);
    }
    assert.equal(clicks, 4);
    assert.equal(doubles, 2);
    assert.equal(fixture.video.playbackRate, 1);
    assert.equal(fixture.mediaState.pauseCalls + fixture.mediaState.playCalls, 0);
    dispatchPointer(fixture, "pointerdown", { target: player });
    fixture.timers.advance(350);
    assert.equal(fixture.video.playbackRate, 2, "the visible native wrapper is also a hold surface");
    dispatchPointer(fixture, "pointerup", { target: player });
});

test("mouse holds ignore controls, other videos, off-screen points, modifiers and non-mouse input", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dom.window.close());
    const player = fixture.video.parentElement;
    const control = fixture.document.createElement("button");
    const overlay = fixture.document.createElement("div");
    const otherVideo = fixture.document.createElement("video");
    player.append(control, overlay, otherVideo);
    const ignored = [
        { target: control },
        { target: overlay },
        { target: otherVideo },
        { target: fixture.document.body },
        { target: fixture.document.getElementById("outside-input") },
        { clientX: 5 },
        { clientY: 600 },
        { button: 1, buttons: 4 },
        { button: 2, buttons: 2 },
        { pointerType: "touch" },
        { pointerType: "pen" },
        { isPrimary: false },
        { ctrlKey: true },
        { shiftKey: true },
        { altKey: true },
        { metaKey: true },
    ];
    for (const init of ignored) {
        assert.equal(dispatchPointer(fixture, "pointerdown", init).defaultPrevented, false);
        fixture.timers.advance(350);
        assert.equal(fixture.video.playbackRate, 1);
        dispatchPointer(fixture, "pointerup", init);
    }
    fixture.emitRoute("/home");
    dispatchPointer(fixture, "pointerdown");
    fixture.timers.advance(350);
    assert.equal(fixture.video.playbackRate, 1);
});

test("dragging cancels pending and active mouse holds without consuming pan events", (t) => {
    for (const elapsed of [100, 350]) {
        const fixture = createFixture({ playbackRate: 1.5 });
        t.after(() => fixture.dom.window.close());
        dispatchPointer(fixture, "pointerdown");
        fixture.timers.advance(elapsed);
        assert.equal(fixture.video.playbackRate, elapsed === 350 ? 2 : 1.5);
        const move = dispatchPointer(fixture, "pointermove", { clientX: 405 });
        assert.equal(move.defaultPrevented, false);
        fixture.timers.advance(400);
        assert.equal(fixture.video.playbackRate, 1.5);
        dispatchPointer(fixture, "pointerup");
        assert.equal(dispatchPointer(fixture, "click").defaultPrevented, elapsed === 350);
        dispatchPointer(fixture, "pointerdown");
        dispatchPointer(fixture, "pointerup");
        assert.equal(dispatchPointer(fixture, "click").defaultPrevented, false, "the next click remains native");
    }
});

test("mouse hold cancellation restores speed on lost input, option changes, SPA navigation and remount", async (t) => {
    const cases = [
        (f) => f.window.dispatchEvent(new f.window.Event("blur")),
        (f) => f.setHidden(true),
        (f) => f.emitOptions({ holdSpeedEnabled: false }),
        (f) => f.emitRoute("/video/54321"),
        (f) => dispatchPointer(f, "pointercancel"),
        (f) => dispatchPointer(f, "lostpointercapture"),
        (f) => dispatchPointer(f, "pointermove", { buttons: 0 }),
        (f) => f.video.dispatchEvent(new f.window.Event("dragstart", { bubbles: true })),
        (f) => f.video.dispatchEvent(new f.window.Event("emptied")),
        (f) => f.video.dispatchEvent(new f.window.Event("loadstart")),
        (f) => f.video.replaceWith(f.document.createElement("video")),
    ];
    for (const cancel of cases) {
        for (const elapsed of [100, 350]) {
            const fixture = createFixture({ playbackRate: 1.5 });
            t.after(() => fixture.dom.window.close());
            dispatchPointer(fixture, "pointerdown");
            fixture.timers.advance(elapsed);
            assert.equal(fixture.video.playbackRate, elapsed === 350 ? 2 : 1.5);
            cancel(fixture);
            await Promise.resolve();
            fixture.timers.advance(400);
            assert.equal(fixture.video.playbackRate, 1.5);
            assert.equal(fixture.document.getElementById("betterchzzk-hold-speed-overlay"), null);
            assert.equal(fixture.mediaState.pauseCalls + fixture.mediaState.playCalls, 0);
        }
    }
});

test("only the input that started a hold can release it and explicit speed changes survive release", (t) => {
    const fixture = createFixture({ playbackRate: 1.25 });
    t.after(() => fixture.dom.window.close());
    dispatchPointer(fixture, "pointerdown");
    fixture.timers.advance(100);
    assert.equal(dispatchSpace(fixture, "keydown").defaultPrevented, true);
    dispatchSpace(fixture, "keydown", { repeat: true });
    assert.equal(fixture.video.playbackRate, 1.25, "Space repeats must not activate a mouse hold early");
    assert.equal(dispatchSpace(fixture, "keyup").defaultPrevented, true);
    fixture.timers.advance(250);
    assert.equal(fixture.video.playbackRate, 2);
    dispatchPointer(fixture, "pointerup", { pointerId: 2 });
    assert.equal(fixture.video.playbackRate, 2);
    dispatchKey(fixture, "keydown", { code: "BracketRight" });
    dispatchPointer(fixture, "pointerup");
    assert.equal(fixture.video.playbackRate, 1.5);
    assert.equal(dispatchPointer(fixture, "click").defaultPrevented, true);

    dispatchSpace(fixture, "keydown");
    fixture.timers.advance(350);
    dispatchPointer(fixture, "pointerdown");
    dispatchPointer(fixture, "pointerup");
    assert.equal(fixture.video.playbackRate, 2);
    dispatchSpace(fixture, "keyup");
    assert.equal(fixture.video.playbackRate, 1.5);
    assert.equal(fixture.mediaState.pauseCalls + fixture.mediaState.playCalls, 0);
});

test("a held second click does not enter fullscreen and unrelated keyboard or button clicks pass through", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dom.window.close());
    dispatchPointer(fixture, "pointerdown", { detail: 2 });
    fixture.timers.advance(350);
    dispatchPointer(fixture, "pointerup", { detail: 2 });
    assert.equal(dispatchPointer(fixture, "click", { detail: 0 }).defaultPrevented, false);
    assert.equal(
        dispatchPointer(fixture, "click", { target: fixture.document.getElementById("outside-button") })
            .defaultPrevented,
        false
    );
    assert.equal(dispatchPointer(fixture, "click", { detail: 2 }).defaultPrevented, true);
    assert.equal(dispatchPointer(fixture, "dblclick", { detail: 2 }).defaultPrevented, true);
    dispatchPointer(fixture, "pointerdown");
    dispatchPointer(fixture, "pointerup");
    assert.equal(dispatchPointer(fixture, "click").defaultPrevented, false);
});

test("mouse holds use the visible viewport for hit testing and speed feedback after zoom", (t) => {
    const fixture = createFixture({
        beforeLoad({ video, window }) {
            const viewport = video.getBoundingClientRect();
            window.BetterChzzk.utils.getVideoViewportRect = () => viewport;
            video.getBoundingClientRect = () => ({ left: -950, top: -520, width: 2880, height: 1620 });
        },
    });
    t.after(() => fixture.dom.window.close());
    dispatchPointer(fixture, "pointerdown", { clientX: 1200 });
    fixture.timers.advance(350);
    assert.equal(fixture.video.playbackRate, 1, "the clipped enlarged video is not an extra click surface");
    dispatchPointer(fixture, "pointerdown");
    fixture.timers.advance(350);
    assert.equal(fixture.video.playbackRate, 2);
    const overlay = fixture.document.getElementById("betterchzzk-hold-speed-overlay");
    assert.equal(overlay.style.left, "490px");
    assert.ok(Math.abs(Number.parseFloat(overlay.style.top) - 95.6) < 0.000001);
    dispatchPointer(fixture, "pointerup", { target: fixture.document.body });
    assert.equal(fixture.video.playbackRate, 1, "release outside the player still restores playback speed");
});

test("mouse hold listeners yield to the actual zoom feature when panning begins", async (t) => {
    for (const elapsed of [100, 350]) {
        const fixture = createFixture({
            playbackRate: 1.25,
            options: { playerZoomEnabled: true, playerZoomMode: "always" },
            beforeLoad({ dom, document, video, window }) {
                const { bindFeatureOptions, startPageChangeDetection } = window.BetterChzzk.utils;
                evalRepoScript(dom, "content.js");
                Object.assign(window.BetterChzzk.utils, { bindFeatureOptions, startPageChangeDetection });
                const controls = document.createElement("div");
                controls.className = "pzp-pc__bottom-buttons-right";
                video.parentElement.append(controls);
                video.getBoundingClientRect = () => {
                    const values = video.style.transform.match(
                        /translate\(([-\d.e+]+)px, ([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/
                    );
                    const left = 10 + Number(values?.[1] || 0);
                    const top = 20 + Number(values?.[2] || 0);
                    const scale = Number(values?.[3] || 1);
                    return {
                        left,
                        top,
                        width: 960 * scale,
                        height: 540 * scale,
                        right: left + 960 * scale,
                        bottom: top + 540 * scale,
                    };
                };
            },
        });
        t.after(() => {
            fixture.emitOptions({ playerZoomEnabled: false, holdSpeedEnabled: false });
            fixture.dom.window.close();
        });
        evalRepoScript(fixture.dom, "features", "playerZoom.js");
        fixture.video.dispatchEvent(
            new fixture.window.WheelEvent("wheel", {
                bubbles: true,
                cancelable: true,
                deltaY: -100,
                clientX: 400,
                clientY: 250,
            })
        );
        assert.equal(fixture.video.hasAttribute("data-bcz-zoomed"), true);
        const zoomed = fixture.video.style.transform;
        dispatchPointer(fixture, "pointerdown");
        fixture.timers.advance(elapsed);
        assert.equal(fixture.video.playbackRate, elapsed === 350 ? 2 : 1.25);
        dispatchPointer(fixture, "pointermove", { clientX: 450 });
        assert.equal(fixture.video.playbackRate, 1.25);
        assert.notEqual(fixture.video.style.transform, zoomed, "the zoom feature still pans the video");
        dispatchPointer(fixture, "pointerup", { clientX: 450 });
        assert.equal(dispatchPointer(fixture, "click", { clientX: 450 }).defaultPrevented, true);
        await Promise.resolve();
        fixture.timers.advance(400);
        assert.equal(fixture.video.playbackRate, 1.25);
    }
});

test("hold speed turns a short playback Space press into exactly one keyup toggle", (t) => {
    const fixture = createFixture({ paused: false });
    t.after(() => fixture.dom.window.close());

    const down = dispatchSpace(fixture, "keydown");
    assert.equal(down.defaultPrevented, true);
    assert.equal(fixture.mediaState.paused, false);

    fixture.timers.advance(200);
    const up = dispatchSpace(fixture, "keyup");
    assert.equal(up.defaultPrevented, true);
    assert.equal(fixture.mediaState.paused, true);
    assert.equal(fixture.mediaState.pauseCalls, 1);
    assert.equal(fixture.mediaState.playCalls, 0);
    assert.equal(fixture.video.playbackRate, 1);
    assert.equal(fixture.document.getElementById("betterchzzk-hold-speed-overlay"), null);
});

test("hold speed applies fixed 2x without changing playback state and restores the previous rate", (t) => {
    const fixture = createFixture({ paused: false, playbackRate: 1.5 });
    t.after(() => fixture.dom.window.close());

    dispatchSpace(fixture, "keydown");
    fixture.timers.advance(350);

    assert.equal(fixture.video.playbackRate, 2);
    assert.equal(fixture.mediaState.paused, false);
    assert.equal(fixture.document.getElementById("betterchzzk-hold-speed-overlay")?.textContent, "2배속");

    dispatchSpace(fixture, "keyup");
    assert.equal(fixture.video.playbackRate, 1.5);
    assert.equal(fixture.mediaState.paused, false);
    assert.equal(fixture.mediaState.pauseCalls, 0);
    assert.equal(fixture.mediaState.playCalls, 0);
});

test("hold speed yields native and role-based Space consumers", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dom.window.close());

    for (const id of [
        "outside-button",
        "outside-input",
        "outside-summary",
        "editable",
        "outside-link",
        "outside-role",
        "outside-textbox",
    ]) {
        const event = dispatchSpace(fixture, "keydown", { target: fixture.document.getElementById(id) });
        assert.equal(event.defaultPrevented, false, `${id} should keep its native Space behavior`);
    }

    assert.equal(dispatchSpace(fixture, "keydown", { ctrlKey: true }).defaultPrevented, false);
    fixture.emitRoute("/home");
    assert.equal(dispatchSpace(fixture, "keydown").defaultPrevented, false);
    fixture.emitRoute("/video/12345");
    fixture.emitOptions({ holdSpeedEnabled: false });
    assert.equal(dispatchSpace(fixture, "keydown").defaultPrevented, false);
});

test("playback speed shortcuts step by 0.25 on live and VOD without changing pause state", (t) => {
    const fixture = createFixture({ url: "https://chzzk.naver.com/live/test-channel", paused: true });
    t.after(() => fixture.dom.window.close());

    const half = dispatchKey(fixture, "keydown", { code: "BracketLeft", key: "[" });
    assert.equal(half.defaultPrevented, true);
    assert.equal(fixture.video.playbackRate, 0.75);
    assert.equal(fixture.mediaState.paused, true);
    assert.equal(fixture.mediaState.pauseCalls, 0);
    assert.equal(fixture.mediaState.playCalls, 0);
    assert.equal(fixture.document.getElementById("betterchzzk-hold-speed-overlay")?.textContent, "0.75배속");

    fixture.timers.advance(900);
    assert.equal(fixture.document.getElementById("betterchzzk-hold-speed-overlay"), null);

    fixture.emitRoute("/video/12345");
    const double = dispatchKey(fixture, "keydown", { code: "BracketRight", key: "]" });
    assert.equal(double.defaultPrevented, true);
    assert.equal(fixture.video.playbackRate, 1);
    assert.equal(fixture.mediaState.paused, true);
});

test("speed keys repeatedly step within 0.25 to 4 and reset explicitly to 1x", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dom.window.close());
    for (const expected of [0.75, 0.5, 0.25, 0.25]) {
        dispatchKey(fixture, "keydown", { code: "BracketLeft" });
        assert.equal(fixture.video.playbackRate, expected);
    }
    for (let i = 1; i <= 17; i++) {
        dispatchKey(fixture, "keydown", { code: "BracketRight" });
        assert.equal(fixture.video.playbackRate, Math.min(4, 0.25 + i * 0.25));
    }
    for (const rate of [0.25, 1, 1.75, 4]) {
        fixture.video.playbackRate = rate;
        assert.equal(dispatchKey(fixture, "keydown", { code: "Backslash" }).defaultPrevented, true);
        assert.equal(fixture.video.playbackRate, 1);
        assert.equal(fixture.document.getElementById("betterchzzk-hold-speed-overlay")?.textContent, "1배속");
    }
    assert.equal(fixture.mediaState.pauseCalls, 0);
    assert.equal(fixture.mediaState.playCalls, 0);
});

test("custom speed keys update immediately and disable, route, and video changes keep their boundaries", (t) => {
    const fixture = createFixture({
        options: {
            playbackSpeedHalfKeyCode: "KeyQ",
            playbackSpeedDoubleKeyCode: "KeyW",
            playbackSpeedResetKeyCode: "KeyE",
        },
    });
    t.after(() => fixture.dom.window.close());
    for (const code of ["BracketLeft", "BracketRight", "Backslash"]) {
        assert.equal(dispatchKey(fixture, "keydown", { code }).defaultPrevented, false);
    }
    dispatchKey(fixture, "keydown", { code: "KeyQ" });
    assert.equal(fixture.video.playbackRate, 0.75);
    dispatchKey(fixture, "keydown", { code: "KeyW" });
    assert.equal(fixture.video.playbackRate, 1);
    fixture.video.playbackRate = 3;
    dispatchKey(fixture, "keydown", { code: "KeyE" });
    assert.equal(fixture.video.playbackRate, 1);
    fixture.emitOptions({ playbackSpeedResetKeyCode: "KeyR" });
    assert.equal(dispatchKey(fixture, "keydown", { code: "KeyE" }).defaultPrevented, false);
    fixture.video.playbackRate = 2.5;
    dispatchKey(fixture, "keydown", { code: "KeyR" });
    assert.equal(fixture.video.playbackRate, 1);
    fixture.emitOptions({ playbackSpeedShortcutsEnabled: false });
    for (const code of ["KeyQ", "KeyW", "KeyR"]) {
        assert.equal(dispatchKey(fixture, "keydown", { code }).defaultPrevented, false);
    }
    fixture.emitOptions({ playbackSpeedShortcutsEnabled: true });
    fixture.emitRoute("/home");
    assert.equal(dispatchKey(fixture, "keydown", { code: "KeyW" }).defaultPrevented, false);
    fixture.emitRoute("/live/another-channel");
    const replacement = fixture.document.createElement("video");
    configureVideo(fixture.dom, replacement, { playbackRate: 1.5 });
    fixture.video.replaceWith(replacement);
    dispatchKey(fixture, "keydown", { code: "KeyW" });
    assert.equal(replacement.playbackRate, 1.75);
    assert.equal(fixture.video.playbackRate, 1);
});

test("playback speed shortcuts yield editable targets, modifiers, composition, and unrelated keys", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dom.window.close());

    for (const id of [
        "outside-button",
        "outside-input",
        "outside-summary",
        "editable",
        "outside-link",
        "outside-role",
        "outside-textbox",
    ]) {
        const event = dispatchKey(fixture, "keydown", {
            code: "BracketLeft",
            key: "[",
            target: fixture.document.getElementById(id),
        });
        assert.equal(event.defaultPrevented, false, `${id} should keep its keyboard input`);
    }

    assert.equal(
        dispatchKey(fixture, "keydown", { code: "BracketLeft", key: "[", ctrlKey: true }).defaultPrevented,
        false
    );
    assert.equal(
        dispatchKey(fixture, "keydown", { code: "BracketLeft", key: "[", shiftKey: true }).defaultPrevented,
        false
    );
    assert.equal(
        dispatchKey(fixture, "keydown", { code: "BracketLeft", key: "[", isComposing: true }).defaultPrevented,
        false
    );
    assert.equal(dispatchKey(fixture, "keydown", { code: "KeyA", key: "a" }).defaultPrevented, false);

    const repeated = dispatchKey(fixture, "keydown", {
        code: "Backslash",
        key: "\\",
        repeat: true,
    });
    assert.equal(repeated.defaultPrevented, true, "a matched repeat must not leak to the native player");
    assert.equal(fixture.video.playbackRate, 1, "reset repeats must not apply a new rate");
});

test("holding default and custom speed keys repeats 0.25 steps, respects limits, and stops on release", (t) => {
    for (const [decrease, increase] of [
        ["BracketLeft", "BracketRight"],
        ["KeyQ", "KeyW"],
    ]) {
        const fixture = createFixture({
            options: { playbackSpeedHalfKeyCode: decrease, playbackSpeedDoubleKeyCode: increase },
        });
        t.after(() => fixture.dom.window.close());
        for (let i = 0; i < 20; i++) {
            assert.equal(dispatchKey(fixture, "keydown", { code: increase, repeat: i > 0 }).defaultPrevented, true);
            assert.equal(fixture.video.playbackRate, Math.min(4, 1 + (i + 1) * 0.25));
        }
        for (let i = 0; i < 20; i++) {
            assert.equal(dispatchKey(fixture, "keydown", { code: decrease, repeat: i > 0 }).defaultPrevented, true);
            assert.equal(fixture.video.playbackRate, Math.max(0.25, 4 - (i + 1) * 0.25));
        }
        dispatchKey(fixture, "keydown", { code: increase });
        dispatchKey(fixture, "keyup", { code: increase });
        fixture.timers.advance(1000);
        assert.equal(fixture.video.playbackRate, 0.5, "no autonomous repetition after release");
        assert.equal(fixture.document.getElementById("betterchzzk-hold-speed-overlay"), null);
        fixture.emitOptions({ playbackSpeedShortcutsEnabled: false });
        assert.equal(dispatchKey(fixture, "keydown", { code: increase, repeat: true }).defaultPrevented, false);
        assert.equal(fixture.video.playbackRate, 0.5);
        assert.equal(fixture.mediaState.pauseCalls, 0);
        assert.equal(fixture.mediaState.playCalls, 0);
    }
});

test("the increase shortcut adjusts the original speed during a Space hold and survives keyup", (t) => {
    const fixture = createFixture({ playbackRate: 1.25 });
    t.after(() => fixture.dom.window.close());

    dispatchSpace(fixture, "keydown");
    fixture.timers.advance(350);
    assert.equal(fixture.video.playbackRate, 2);

    dispatchKey(fixture, "keydown", { code: "BracketRight", key: "]" });
    assert.equal(fixture.video.playbackRate, 1.5);
    assert.equal(dispatchSpace(fixture, "keyup").defaultPrevented, true);
    assert.equal(fixture.video.playbackRate, 1.5, "Space keyup must not undo the explicit cancellation");
});

test("playback speed shortcut feedback cleans up on route exit, visibility change, and option disable", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dom.window.close());

    dispatchKey(fixture, "keydown", { code: "BracketLeft", key: "[" });
    fixture.emitRoute("/home");
    assert.equal(fixture.document.getElementById("betterchzzk-hold-speed-overlay"), null);

    fixture.emitRoute("/video/12345");
    dispatchKey(fixture, "keydown", { code: "BracketRight", key: "]" });
    fixture.setHidden(true);
    assert.equal(fixture.document.getElementById("betterchzzk-hold-speed-overlay"), null);
    fixture.setHidden(false);

    dispatchKey(fixture, "keydown", { code: "BracketLeft", key: "[" });
    fixture.emitOptions({ playbackSpeedShortcutsEnabled: false });
    assert.equal(fixture.document.getElementById("betterchzzk-hold-speed-overlay"), null);
    assert.equal(fixture.video.playbackRate, 0.75, "disabling shortcuts must not overwrite the selected rate");
});

test("hold speed preserves a playback-state change made after hold activation", (t) => {
    const fixture = createFixture({ paused: false, playbackRate: 1.25 });
    t.after(() => fixture.dom.window.close());

    dispatchSpace(fixture, "keydown");
    fixture.timers.advance(350);
    assert.equal(fixture.video.playbackRate, 2);

    fixture.video.pause();
    assert.equal(fixture.mediaState.paused, true);
    dispatchSpace(fixture, "keyup");

    assert.equal(fixture.mediaState.paused, true, "a later user or ended pause must not be undone");
    assert.equal(fixture.mediaState.playCalls, 0);
    assert.equal(fixture.video.playbackRate, 1.25);
});

test("hold speed cleans up on blur, hidden documents, SPA exits, option disable, and video replacement", async (t) => {
    const fixture = createFixture({ playbackRate: 1.5 });
    t.after(() => fixture.dom.window.close());

    dispatchSpace(fixture, "keydown");
    fixture.timers.advance(350);
    fixture.window.dispatchEvent(new fixture.window.Event("blur"));
    assert.equal(fixture.video.playbackRate, 1.5);
    assert.equal(fixture.document.getElementById("betterchzzk-hold-speed-overlay"), null);
    assert.equal(dispatchSpace(fixture, "keyup").defaultPrevented, true);

    dispatchSpace(fixture, "keydown");
    fixture.timers.advance(350);
    fixture.setHidden(true);
    assert.equal(fixture.video.playbackRate, 1.5);
    dispatchSpace(fixture, "keyup");
    fixture.setHidden(false);

    dispatchSpace(fixture, "keydown");
    fixture.timers.advance(350);
    fixture.emitRoute("/live/test-channel");
    assert.equal(fixture.video.playbackRate, 1.5);
    dispatchSpace(fixture, "keyup");

    fixture.emitRoute("/video/54321");
    dispatchSpace(fixture, "keydown");
    fixture.timers.advance(350);
    fixture.emitOptions({ holdSpeedEnabled: false });
    assert.equal(fixture.video.playbackRate, 1.5);
    dispatchSpace(fixture, "keyup");

    fixture.emitOptions({ holdSpeedEnabled: true });
    dispatchSpace(fixture, "keydown");
    fixture.timers.advance(350);
    const replacement = fixture.document.createElement("video");
    configureVideo(fixture.dom, replacement, { paused: false, playbackRate: 1 });
    fixture.video.replaceWith(replacement);
    await Promise.resolve();
    fixture.timers.advance(0);

    assert.equal(fixture.video.playbackRate, 1.5, "the detached original video must recover its rate");
    assert.equal(fixture.document.getElementById("betterchzzk-hold-speed-overlay"), null);
});
