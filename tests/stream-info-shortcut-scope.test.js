const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const {
    createFakeChrome,
    evalRepoScript,
    waitForAsyncCallbacks,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

// The stream info panel stops bubbling, but skipControl and screenShortcuts listen on window in the capture
// phase and run first. This loads the real utilities and features together (manifest order) so the panel's
// focused close button is checked against the shortcut owners that actually see the key first.
const PLAYER_HTML = [
    "<!doctype html><body>",
    '<div class="pzp pzp-pc" id="playerRoot" tabindex="0">',
    '<video id="video"></video>',
    '<button class="pzp-pc__playback-switch" id="play" type="button">재생</button>',
    '<div class="pzp-pc__bottom-buttons-right">',
    '<button class="pzp-setting-button pzp-pc__setting-button" aria-label="설정" aria-haspopup="true" aria-expanded="false"></button>',
    "</div>",
    '<div role="menu" class="pzp-settings pzp-pc-settings pzp-pc__settings">',
    '<div role="menuitem" tabindex="0" class="pzp-ui-setting-home-item pzp-setting-intro-quality">해상도</div>',
    "</div>",
    "</div>",
    "</body>",
].join("");

function range(items) {
    return { length: items.length, start: (i) => items[i][0], end: (i) => items[i][1] };
}

async function openVodPage(t, sync) {
    const chrome = createFakeChrome({
        sync: {
            skipControlEnabled: true,
            skipKeyboardEnabled: true,
            skipSeconds: 10,
            streamInfoEnabled: true,
            ...sync,
        },
    });
    const dom = new JSDOM(PLAYER_HTML, {
        url: "https://chzzk.naver.com/video/123",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    w.chrome = chrome;
    w.fetch = async () => {
        throw new Error("Unexpected network request in stream info shortcut test");
    };
    w.HTMLCanvasElement.prototype.getContext = () => null;
    const observers = new Set();
    const NativeObserver = w.MutationObserver;
    w.MutationObserver = class extends NativeObserver {
        constructor(callback) {
            super(callback);
            observers.add(this);
        }
    };
    t.after(() => {
        for (const observer of observers) observer.disconnect();
        w.close();
    });
    const doc = w.document;
    const video = doc.getElementById("video");
    // Paused at 60 s so comma/period frame steps are live outside the panel (they only run while paused).
    const state = { currentTime: 60, paused: true, writes: [] };
    Object.defineProperty(video, "currentTime", {
        configurable: true,
        get: () => state.currentTime,
        set: (value) => {
            state.writes.push(Number(value));
            state.currentTime = Number(value);
        },
    });
    Object.defineProperty(video, "paused", { configurable: true, get: () => state.paused });
    for (const [key, value] of Object.entries({
        duration: 3600,
        videoWidth: 1920,
        videoHeight: 1080,
        readyState: 4,
        buffered: range([[0, 3600]]),
        seekable: range([[0, 3600]]),
    }))
        Object.defineProperty(video, key, { configurable: true, value });
    video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 });
    video.getVideoPlaybackQuality = () => ({ totalVideoFrames: 100, droppedVideoFrames: 0 });
    // Native play switch: each click toggles playback once.
    let playClicks = 0;
    doc.getElementById("play").addEventListener("click", () => {
        playClicks++;
        state.paused = !state.paused;
    });
    // Observed settings toggle (stream-info.test.js) without the feature writing native classes.
    doc.addEventListener("click", (event) => {
        const button = event.target.closest?.(".pzp-setting-button");
        if (!button) return;
        const open = button.getAttribute("aria-expanded") !== "true";
        button.setAttribute("aria-expanded", String(open));
        button.closest(".pzp-pc").classList.toggle("pzp-pc--setting-home", open);
    });

    for (const file of [
        ["shared", "settings.js"],
        ["shared", "data.js"],
        ["content.js"],
        ["shared", "uiTheme.js"],
        ["shared", "vodTimeline.js"],
        ["shared", "liveTiming.js"],
        ["features", "skipControl.js"],
        ["features", "streamInfoModel.js"],
        ["features", "streamInfo.js"],
        ["features", "holdSpeed.js"],
        ["features", "screenShortcuts.js"],
    ])
        evalRepoScript(dom, ...file);
    doc.dispatchEvent(new w.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();
    await waitForCondition(() => doc.getElementById("cheese-spanner-stream-info-settings-item"));

    const key = (target, init) => {
        const down = new w.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
        target.dispatchEvent(down);
        target.dispatchEvent(new w.KeyboardEvent("keyup", { bubbles: true, cancelable: true, ...init }));
        return down;
    };
    return {
        doc,
        state,
        key,
        playClicks: () => playClicks,
        panel: () => doc.getElementById("cheese-spanner-stream-info"),
        open() {
            doc.querySelector(".pzp-setting-button").click();
            doc.getElementById("cheese-spanner-stream-info-settings-item").click();
            const close = doc.querySelector('#cheese-spanner-stream-info button[aria-label="스트림 정보 닫기"]');
            assert.ok(close, "the panel opened with its close button");
            close.focus();
            assert.equal(doc.activeElement, close);
            return close;
        },
    };
}

const ARROWS = [
    { key: "ArrowRight", code: "ArrowRight" },
    { key: "ArrowLeft", code: "ArrowLeft" },
];
const FRAME_STEPS = [
    { key: ".", code: "Period" },
    { key: ",", code: "Comma" },
];

test("skip arrows and paused frame steps stay out of the focused stream info panel but work outside it", async (t) => {
    const page = await openVodPage(t, {});
    const close = page.open();
    assert.equal(page.state.paused, true, "frame steps are only meaningful while paused");
    for (const init of [...ARROWS, ...FRAME_STEPS]) {
        assert.equal(page.key(close, init).defaultPrevented, false, `${init.key} keeps its default inside the panel`);
        assert.equal(page.state.currentTime, 60, `${init.key} inside the panel does not move playback`);
    }
    assert.deepEqual(page.state.writes, []);
    assert.equal(page.state.paused, true);
    assert.ok(page.panel(), "panel stays open for non-closing keys");

    // Contrast: the same keys on the player itself keep the configured skip and frame-step behaviour.
    const player = page.doc.getElementById("playerRoot");
    player.focus();
    assert.equal(page.key(player, ARROWS[0]).defaultPrevented, true);
    assert.equal(page.state.currentTime, 70);
    assert.equal(page.key(player, ARROWS[1]).defaultPrevented, true);
    assert.equal(page.state.currentTime, 60);
    assert.equal(page.state.paused, true);
    assert.equal(page.key(player, FRAME_STEPS[0]).defaultPrevented, true);
    assert.ok(Math.abs(page.state.currentTime - (60 + 1 / 60)) < 1e-9, `frame step: ${page.state.currentTime}`);
    assert.equal(page.playClicks(), 0);
});

test("Space on the panel close button closes it instead of toggling playback through screen shortcuts", async (t) => {
    const page = await openVodPage(t, { screenShortcutsEnabled: true, holdSpeedEnabled: false });
    const close = page.open();
    assert.equal(page.key(close, { key: " ", code: "Space" }).defaultPrevented, true);
    assert.equal(page.panel(), null, "Space closed the panel");
    assert.equal(page.playClicks(), 0, "Space inside the panel never clicks the native play switch");
    assert.equal(page.state.paused, true);
    assert.equal(page.state.currentTime, 60);

    // Contrast: outside the panel the screen shortcut still owns Space exactly once.
    const player = page.doc.getElementById("playerRoot");
    player.focus();
    assert.equal(page.key(player, { key: " ", code: "Space" }).defaultPrevented, true);
    assert.equal(page.playClicks(), 1);
    assert.equal(page.state.paused, false);
});

test("Space on the panel close button with hold-speed on still closes only the panel", async (t) => {
    const page = await openVodPage(t, { screenShortcutsEnabled: true, holdSpeedEnabled: true });
    const close = page.open();
    page.key(close, { key: " ", code: "Space" });
    assert.equal(page.panel(), null);
    assert.equal(page.playClicks(), 0);
    assert.equal(page.state.paused, true);
});
