const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { waitForCondition } = require("./helpers/extension-page-fixture.js");

const STATE_ATTR = "data-cheese-spanner-live-playback-rate";
const STATE_EVENT = "cheese-spanner:live-playback-rate:state";
const MARKER = "data-cheese-spanner-live-rate-lock";
const RATE = "maxLiveSyncPlaybackRate";
const LEVEL = "hlsLevelLoaded";
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

function setup(t, { enabled = true, route = "/live/test", rate = 1.03, automatic = true } = {}) {
    const dom = new JSDOM(
        '<div class="chzzk_player type_live"><div class="pzp-pc"><video class="webplayer-internal-video"></video></div></div>',
        {
            url: "https://chzzk.naver.com" + route,
            runScripts: "outside-only",
        }
    );
    const w = dom.window;
    const host = w.document.querySelector(".chzzk_player");
    const video = host.querySelector("video");
    const state = { rate, automatic, writes: 0 };
    Object.defineProperties(video, {
        playbackRate: {
            get: () => state.rate,
            set: (value) => {
                state.rate = value;
                state.writes++;
            },
        },
        currentTime: {
            get: () => 100,
            set: () => {
                assert.fail("must not seek");
            },
        },
        paused: { get: () => true },
    });
    video.play = () => assert.fail("must not start playback");
    video.pause = () => assert.fail("must not pause playback");
    function native(media = video) {
        const listeners = new Set();
        const hls = {
            media,
            config: { [RATE]: 1.03 },
            userConfig: { [RATE]: 1.03 },
            on: (name, fn) => {
                assert.equal(name, LEVEL);
                listeners.add(fn);
            },
            off: (name, fn) => {
                assert.equal(name, LEVEL);
                listeners.delete(fn);
            },
        };
        const controller = { getHlsInstance: () => hls };
        const sourcePlayer = { _mediaController: controller };
        const core = { player: sourcePlayer };
        const provider = { player: core };
        const player = {
            shadowRoot: host,
            _corePlayer: core,
            srcObject: provider,
            getPreProcessorControl: () => ({ isCatchUpRateActive: state.automatic }),
        };
        return {
            hls,
            controller,
            sourcePlayer,
            core,
            provider,
            player,
            listeners,
            level(value = 1.03) {
                hls.config[RATE] = hls.userConfig[RATE] = value;
                for (const fn of [...listeners]) fn(LEVEL, {});
            },
        };
    }
    let active = native();
    const hook = { memoizedState: { current: active.player } };
    host.__reactFiber$test = { memoizedState: hook };
    const toggle = (value) => {
        w.document.documentElement.setAttribute(STATE_ATTR, value === true ? "1" : value === false ? "0" : value);
        w.dispatchEvent(new w.Event(STATE_EVENT));
    };
    w.eval(read("shared/volumeControlsPage.js"));
    if (enabled) w.document.documentElement.setAttribute(STATE_ATTR, "1");
    w.eval(read("features/livePlaybackRatePage.js"));
    t.after(() => {
        toggle(false);
        dom.window.close();
    });
    return {
        dom,
        w,
        host,
        video,
        state,
        toggle,
        native,
        get active() {
            return active;
        },
        replace(next = native()) {
            active = next;
            hook.memoizedState.current = next.player;
            video.dispatchEvent(new w.Event("loadedmetadata"));
            return next;
        },
        async settle() {
            await new Promise((resolve) => w.setTimeout(resolve, 10));
        },
    };
}

test("limits native catch-up on every playlist refresh, without seeking or resuming", (t) => {
    const f = setup(t);
    assert.equal(f.video.playbackRate, 1);
    assert.equal(f.video.paused, true);
    assert.equal(f.video.currentTime, 100);
    assert.equal(f.active.hls.config[RATE], 1);
    assert.equal(f.video.getAttribute(MARKER), "active");
    for (let i = 0; i < 20; i++) f.active.level();
    assert.equal(f.active.hls.config[RATE], 1);
    assert.equal(f.active.hls.userConfig[RATE], 1);
    assert.equal(f.active.listeners.size, 1);
    assert.equal(f.state.writes, 1, "refreshes do not repeatedly set media speed");
    f.toggle(false);
    assert.equal(f.active.hls.config[RATE], 1.03);
    assert.equal(f.active.hls.userConfig[RATE], 1.03);
    assert.equal(f.active.listeners.size, 0);
    assert.equal(f.video.hasAttribute(MARKER), false);
});

test("manual speed and temporary holds survive refreshes and disabling", async (t) => {
    const f = setup(t, { rate: 1.5, automatic: false });
    for (const rate of [1.5, 2, 0.75, 0, 1]) {
        f.state.rate = rate;
        f.active.level();
        f.video.dispatchEvent(new f.w.Event("ratechange"));
        await f.settle();
        assert.equal(f.video.playbackRate, rate);
    }
    assert.equal(f.state.writes, 0);
    f.state.rate = 2;
    f.toggle(false);
    assert.equal(f.video.playbackRate, 2);
});

test("changing options only changes catch-up once, and invalid bridge values fail closed", (t) => {
    const f = setup(t, { enabled: false });
    assert.equal(f.active.listeners.size, 0);
    for (const value of ["true", '{"enabled":true}', "", "2"]) {
        f.toggle(value);
        assert.equal(f.active.listeners.size, 0);
    }
    for (let i = 0; i < 5; i++) f.toggle(true);
    assert.equal(f.active.listeners.size, 1);
    f.active.level(1.02);
    f.toggle(false);
    assert.equal(f.active.hls.config[RATE], 1.02, "restores the latest native policy");
});

test("restoration preserves absent keys, replaced config objects, and outside changes", (t) => {
    const f = setup(t, { enabled: false, rate: 1, automatic: false });
    delete f.active.hls.userConfig[RATE];
    const old = f.active.hls.config;
    f.toggle(true);
    f.active.hls.config = { [RATE]: 1.04 };
    for (const fn of f.active.listeners) fn();
    assert.equal(old[RATE], 1.03);
    assert.equal(f.active.hls.config[RATE], 1);
    f.active.hls.config[RATE] = 1.06;
    f.toggle(false);
    assert.equal(f.active.hls.config[RATE], 1.06);
    assert.equal(Object.hasOwn(f.active.hls.userConfig, RATE), false);
});

test("source and HLS replacements release old listeners and reject late callbacks", async (t) => {
    const f = setup(t);
    const old = f.active;
    const late = [...old.listeners][0];
    const next = f.replace();
    await waitForCondition(() => next.listeners.size === 1);
    assert.equal(old.listeners.size, 0);
    assert.equal(old.hls.config[RATE], 1.03);
    old.hls.config[RATE] = 1.08;
    late();
    assert.equal(old.hls.config[RATE], 1.08);
    assert.equal(next.hls.config[RATE], 1);
    const replacement = f.native().hls;
    next.controller.getHlsInstance = () => replacement;
    f.video.dispatchEvent(new f.w.Event("canplay"));
    await waitForCondition(() => replacement.config[RATE] === 1);
    assert.equal(next.listeners.size, 0);
    assert.equal(next.hls.config[RATE], 1.03);
});

test("route exit, same-DOM channel change and page cache lifecycle restore native settings", async (t) => {
    const f = setup(t);
    f.w.dispatchEvent(new f.w.Event("pagehide"));
    assert.equal(f.active.listeners.size, 0);
    assert.equal(f.active.hls.config[RATE], 1.03);
    f.w.dispatchEvent(new f.w.Event("pageshow"));
    assert.equal(f.active.listeners.size, 1);
    f.w.history.pushState({}, "", "/live/next");
    f.w.dispatchEvent(new f.w.Event("cheese-spanner:routechange"));
    assert.equal(f.active.listeners.size, 1);
    f.w.history.pushState({}, "", "/video/123");
    f.w.dispatchEvent(new f.w.Event("cheese-spanner:routechange"));
    assert.equal(f.active.listeners.size, 0);
    f.video.dispatchEvent(new f.w.Event("playing"));
    await f.settle();
    assert.equal(f.active.hls.config[RATE], 1.03);
});

test("detached media and incompatible or ambiguous native ownership are left alone", async (t) => {
    const f = setup(t, { enabled: false });
    f.active.hls.media = f.w.document.createElement("video");
    f.toggle(true);
    assert.equal(f.active.listeners.size, 0);
    f.active.hls.media = f.video;
    f.host.__reactFiber$test.memoizedState.next = { memoizedState: f.native().player };
    f.toggle(true);
    assert.equal(f.active.listeners.size, 0);
    f.host.__reactFiber$test.memoizedState.next = null;
    f.toggle(true);
    assert.equal(f.active.listeners.size, 1);
    f.video.remove();
    await waitForCondition(() => f.active.listeners.size === 0);
    assert.equal(f.active.hls.config[RATE], 1.03);
});

test("ads suspend the limit, restore when removed, and never change ad speed", async (t) => {
    const f = setup(t);
    const ad = f.w.document.createElement("div");
    ad.id = "preAdPlayerWrapper";
    ad.innerHTML = '<video class="webplayer-internal-video"></video>';
    const adVideo = ad.querySelector("video");
    adVideo.playbackRate = 1.5;
    f.w.document.body.append(ad);
    await waitForCondition(() => f.active.listeners.size === 0);
    assert.equal(adVideo.playbackRate, 1.5);
    ad.remove();
    await waitForCondition(() => f.active.listeners.size === 1);
    const mid = f.w.document.createElement("div");
    mid.id = "midAdPlayerWrapper";
    mid.style.display = "none";
    f.w.document.body.append(mid);
    await f.settle();
    mid.style.display = "block";
    await waitForCondition(() => f.active.listeners.size === 0);
    mid.style.display = "none";
    await waitForCondition(() => f.active.listeners.size === 1);
});

test("VOD, popup chat and multiview auxiliary video never receive this policy", (t) => {
    for (const route of ["/video/123", "/live/test/chat", "/"]) {
        const f = setup(t, { route });
        assert.equal(f.active.listeners.size, 0);
        assert.equal(f.video.playbackRate, 1.03);
    }
    const f = setup(t, { enabled: false });
    f.video.setAttribute("data-bcmv-video", "1");
    f.toggle(true);
    assert.equal(f.active.listeners.size, 0);
});

test("unwritable or disposed native config fails without leaving listeners or a marker", (t) => {
    const f = setup(t, { enabled: false });
    Object.freeze(f.active.hls.userConfig);
    f.toggle(true);
    assert.equal(f.active.listeners.size, 0);
    assert.equal(f.active.hls.config[RATE], 1.03);
    assert.equal(f.video.hasAttribute(MARKER), false);
});

test("isolated bridge waits for settings, publishes changes, and does not repeat identical state", (t) => {
    const f = setup(t, { enabled: false });
    let apply, ready;
    f.w.CheeseSpanner = {
        utils: {
            bindFeatureOptions: (fn) => {
                apply = fn;
            },
            onReady: (fn) => {
                ready = fn;
            },
        },
    };
    let events = 0;
    f.w.addEventListener(STATE_EVENT, () => events++);
    f.w.eval(read("features/livePlaybackRate.js"));
    ready();
    assert.equal(events, 0);
    apply({ livePlaybackRateLockEnabled: true });
    assert.equal(f.active.listeners.size, 1);
    apply({ livePlaybackRateLockEnabled: true });
    ready();
    assert.equal(events, 1);
    apply({ livePlaybackRateLockEnabled: false });
    assert.equal(events, 2);
    assert.equal(f.active.listeners.size, 0);
});
