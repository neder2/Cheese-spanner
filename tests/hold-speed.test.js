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

test("playback speed shortcuts apply fixed 0.5x and 2x on live and VOD without changing pause state", (t) => {
    const fixture = createFixture({ url: "https://chzzk.naver.com/live/test-channel", paused: true });
    t.after(() => fixture.dom.window.close());

    const half = dispatchKey(fixture, "keydown", { code: "BracketLeft", key: "[" });
    assert.equal(half.defaultPrevented, true);
    assert.equal(fixture.video.playbackRate, 0.5);
    assert.equal(fixture.mediaState.paused, true);
    assert.equal(fixture.mediaState.pauseCalls, 0);
    assert.equal(fixture.mediaState.playCalls, 0);
    assert.equal(fixture.document.getElementById("betterchzzk-hold-speed-overlay")?.textContent, "0.5배속");

    fixture.timers.advance(900);
    assert.equal(fixture.document.getElementById("betterchzzk-hold-speed-overlay"), null);

    fixture.emitRoute("/video/12345");
    const double = dispatchKey(fixture, "keydown", { code: "BracketRight", key: "]" });
    assert.equal(double.defaultPrevented, true);
    assert.equal(fixture.video.playbackRate, 2);
    assert.equal(fixture.mediaState.paused, true);
});

test("pressing the selected speed shortcut again resets playback to 1x", (t) => {
    const fixture = createFixture({ playbackRate: 1 });
    t.after(() => fixture.dom.window.close());

    dispatchKey(fixture, "keydown", { code: "BracketLeft", key: "[" });
    assert.equal(fixture.video.playbackRate, 0.5);
    dispatchKey(fixture, "keydown", { code: "BracketLeft", key: "[" });
    assert.equal(fixture.video.playbackRate, 1);
    assert.equal(fixture.document.getElementById("betterchzzk-hold-speed-overlay")?.textContent, "1배속");

    dispatchKey(fixture, "keydown", { code: "BracketRight", key: "]" });
    assert.equal(fixture.video.playbackRate, 2);
    dispatchKey(fixture, "keydown", { code: "BracketRight", key: "]" });
    assert.equal(fixture.video.playbackRate, 1);
    assert.equal(fixture.mediaState.pauseCalls, 0);
    assert.equal(fixture.mediaState.playCalls, 0);
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
        code: "BracketLeft",
        key: "[",
        repeat: true,
    });
    assert.equal(repeated.defaultPrevented, true, "a matched repeat must not leak to the native player");
    assert.equal(fixture.video.playbackRate, 1, "repeat alone must not apply a new rate");
});

test("the 2x shortcut cancels an active Space hold to 1x and keyup keeps the cancellation", (t) => {
    const fixture = createFixture({ playbackRate: 1.25 });
    t.after(() => fixture.dom.window.close());

    dispatchSpace(fixture, "keydown");
    fixture.timers.advance(350);
    assert.equal(fixture.video.playbackRate, 2);

    dispatchKey(fixture, "keydown", { code: "BracketRight", key: "]" });
    assert.equal(fixture.video.playbackRate, 1);
    assert.equal(dispatchSpace(fixture, "keyup").defaultPrevented, true);
    assert.equal(fixture.video.playbackRate, 1, "Space keyup must not undo the explicit cancellation");
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
    assert.equal(fixture.video.playbackRate, 0.5, "disabling shortcuts must not overwrite the selected rate");
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
