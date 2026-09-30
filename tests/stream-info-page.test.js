const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const source = fs.readFileSync(path.join(__dirname, "../features/autoQualityPage.js"), "utf8");

function fixture(t) {
    const dom = new JSDOM("<!doctype html><body></body>", {
        url: "https://chzzk.naver.com/live/measured-a",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    const calls = [];
    const timers = new Map();
    let timerId = 0;
    w.setTimeout = (fn) => {
        timers.set(++timerId, fn);
        return timerId;
    };
    w.clearTimeout = (id) => timers.delete(id);
    w.setInterval = () => calls.push("interval");
    w.fetch = () => calls.push("fetch");
    w.Storage.prototype.setItem = () => calls.push("storage");
    const state = (enabled = false) => {
        w.document.documentElement.setAttribute(
            "data-betterchzzk-auto-quality-state",
            JSON.stringify({ enabled, quality: "1080p" })
        );
        w.dispatchEvent(new w.Event("betterchzzk:auto-quality:state"));
    };
    const mount = () => {
        const host = w.document.createElement("div");
        host.className = "chzzk_player type_live";
        const video = w.document.createElement("video");
        video.className = "webplayer-internal-video";
        const playback = { source: "blob:private-media-source", onLive: true };
        Object.defineProperties(video, {
            currentSrc: { get: () => playback.source },
            currentTime: {
                get: () => 100,
                set: () => {
                    calls.push("seek");
                },
            },
            playbackRate: {
                get: () => 1,
                set: () => {
                    calls.push("rate");
                },
            },
            played: { get: () => ({ length: 1 }) },
            paused: { get: () => false },
            seeking: { get: () => false },
            readyState: { get: () => 4 },
        });
        video.play = () => calls.push("play");
        video.pause = () => calls.push("pause");
        video.getBoundingClientRect = () => ({ width: 1280, height: 720, left: 0, top: 0, right: 1280, bottom: 720 });
        host.append(video);
        w.document.body.append(host);
        const tracks = ["main", "low-latency"].map((kind) => ({
            id: `${kind}-720`,
            kind,
            width: 1280,
            height: 720,
            selected: kind === "main",
        }));
        const original = () => {
            calls.push("dispatch");
            return true;
        };
        const pane = Object.create({ $dispatch: original });
        pane.selectVideoTrack = () => {
            calls.push("select");
            return Promise.resolve();
        };
        pane.$store = {
            getters: {
                get onLive() {
                    return playback.onLive;
                },
            },
        };
        const player = {
            shadowRoot: host,
            srcObject: {},
            videoTracks: tracks,
            getPreProcessorControl() {
                calls.push("processor");
            },
            querySelector() {
                return pane;
            },
        };
        const hook = { memoizedState: player };
        host.__reactFiber$measured = { memoizedState: hook };
        return { host, video, playback, tracks, player, pane, hook, original };
    };
    const p = mount();
    state();
    const defineProperty = w.Object.defineProperty;
    w.eval(source);
    const read = (video = p.video, payload = { version: 1, requestId: "read-current" }) => {
        video.removeAttribute("data-bcsi-result");
        video.setAttribute("data-bcsi-request", typeof payload === "string" ? payload : JSON.stringify(payload));
        video.dispatchEvent(new w.Event("betterchzzk:stream-info:read"));
        return JSON.parse(video.getAttribute("data-bcsi-result"));
    };
    t.after(() => {
        state();
        timers.clear();
        dom.window.close();
    });
    return { w, p, calls, timers, state, mount, read, defineProperty };
}

function unavailable(result, reason) {
    assert.deepEqual(result, {
        version: 1,
        requestId: "read-current",
        route: "/live/measured-a",
        status: "unavailable",
        reason,
        mode: "unknown",
        trackId: null,
        sourceToken: null,
        trackWidth: null,
        trackHeight: null,
        onLive: null,
    });
}

test("automatic quality OFF still reads the current track synchronously without native or descriptor changes", (t) => {
    const f = fixture(t),
        p = f.p;
    const paneDescriptors = Object.getOwnPropertyDescriptors(p.pane);
    const playerDescriptors = Object.getOwnPropertyDescriptors(p.player);
    f.w.document.documentElement.setAttribute(
        "data-betterchzzk-low-latency-result",
        JSON.stringify({ status: "applied", selectedTrackId: "low-latency-720" })
    );
    const result = f.read();
    assert.ok(result, "the request must receive a synchronous snapshot even when both controls are OFF");
    assert.deepEqual(result, {
        version: 1,
        requestId: "read-current",
        route: "/live/measured-a",
        status: "ready",
        reason: "ok",
        mode: "standard",
        trackId: "main-720",
        sourceToken: result.sourceToken,
        trackWidth: 1280,
        trackHeight: 720,
        onLive: true,
    });
    assert.equal(typeof result.sourceToken, "string");
    assert.ok(result.sourceToken.length > 0);
    assert.doesNotMatch(JSON.stringify(result), /blob:|private-media-source/);
    p.tracks[0].selected = false;
    p.tracks[1].selected = true;
    assert.equal(f.read(p.video, { version: 1, requestId: "next-read" }).mode, "low-latency");
    assert.equal(f.read(p.video, { version: 1, requestId: "next-read" }).requestId, "next-read");
    assert.deepEqual(Object.getOwnPropertyDescriptors(p.pane), paneDescriptors);
    assert.deepEqual(Object.getOwnPropertyDescriptors(p.player), playerDescriptors);
    assert.equal(f.w.Object.defineProperty, f.defineProperty);
    assert.deepEqual(f.calls, []);
    assert.equal(f.timers.size, 0);
});

test("read-only mode classifies only measured kinds and preserves automatic track policy", (t) => {
    const f = fixture(t),
        track = f.p.tracks[0];
    track.label = "ABR";
    for (const [kind, mode] of [
        ["main", "standard"],
        ["p2p", "standard"],
        ["low-latency", "low-latency"],
        ["low-latency-p2p", "low-latency"],
        ["future-kind", "unknown"],
    ]) {
        track.kind = kind;
        assert.equal(f.read()?.mode, mode);
    }
    assert.deepEqual(f.calls, []);
});

test("missing or ambiguous selected tracks and missing or ambiguous owners remain unavailable", (t) => {
    const f = fixture(t),
        p = f.p;
    p.tracks[0].selected = false;
    unavailable(f.read(), "track-missing");
    p.tracks[0].selected = p.tracks[1].selected = true;
    p.tracks.selectedIndex = 0;
    unavailable(f.read(), "track-missing");
    p.tracks[1].selected = false;
    const fiber = p.host.__reactFiber$measured;
    delete p.host.__reactFiber$measured;
    unavailable(f.read(), "player-missing");
    p.host.__reactFiber$measured = fiber;
    p.hook.next = { memoizedState: { ...p.player, querySelector: () => ({ $dispatch() {}, selectVideoTrack() {} }) } };
    unavailable(f.read(), "ambiguous-player");
});

test("distinct players sharing the current video and pane remain ambiguous for diagnostics", (t) => {
    const f = fixture(t),
        p = f.p;
    const nextPlayer = {
        ...p.player,
        srcObject: {},
        videoTracks: [{ id: "low-latency-720", kind: "low-latency", width: 1280, height: 720, selected: true }],
    };
    p.hook.next = { memoizedState: nextPlayer };
    unavailable(f.read(), "ambiguous-player");
    assert.equal(p.pane.$dispatch, p.original);
    assert.deepEqual(f.calls, []);
    assert.equal(f.timers.size, 0);
});

test("repeated hooks and alternate fibers referring to the same player do not create ambiguity", (t) => {
    const f = fixture(t),
        p = f.p;
    p.hook.next = { memoizedState: p.player, next: { memoizedState: { current: p.player } } };
    p.host.__reactFiber$measured.alternate = { memoizedState: { memoizedState: p.player } };
    const result = f.read();
    assert.equal(result.status, "ready");
    assert.equal(result.mode, "standard");
    assert.equal(result.trackId, "main-720");
    assert.deepEqual(f.calls, []);
});

test("malformed requests and non-main, preview or advertisement videos receive no result", (t) => {
    const f = fixture(t);
    for (const payload of [
        "{",
        "null",
        "[]",
        {},
        { version: 2, requestId: "id" },
        { version: 1, requestId: "" },
        { version: 1, requestId: 1 },
        { version: 1, requestId: "a".repeat(129) },
        { version: 1, requestId: "id", command: "play" },
    ])
        assert.equal(f.read(f.p.video, payload), null);
    const extra = f.mount();
    assert.equal(f.read(extra.video), null);
    for (const marker of ["data-bcmv-video", "data-bcfp-player-mount", "data-role"]) {
        extra.host.setAttribute(marker, marker === "data-role" ? "imaAdContainerEl" : "");
        extra.video.getBoundingClientRect = () => ({ width: 3000, height: 2000 });
        assert.equal(f.read(extra.video), null);
        extra.host.removeAttribute(marker);
    }
    assert.equal(f.read(f.w.document.body), null);
    extra.host.remove();
    assert.equal(f.read(f.p.video, { version: 1, requestId: "x".repeat(128) })?.status, "ready");
});

test("unsupported routes report unavailable only for a valid current main target", (t) => {
    const f = fixture(t);
    f.w.history.replaceState({}, "", "/video/123");
    const result = f.read();
    assert.ok(result);
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "unsupported-route");
    assert.equal(result.route, "/video/123");
    assert.equal(result.mode, "unknown");
    assert.equal(result.sourceToken, null);
});

test("source tokens remain stable for track changes but change with the provider, source or main video", (t) => {
    const f = fixture(t),
        p = f.p;
    const first = f.read()?.sourceToken;
    assert.equal(typeof first, "string");
    assert.equal(f.read().sourceToken, first);
    p.tracks[0].kind = "low-latency";
    assert.equal(f.read().sourceToken, first);
    p.playback.source = "blob:new-private-source";
    const second = f.read().sourceToken;
    assert.notEqual(second, first);
    p.player.srcObject = {};
    const third = f.read().sourceToken;
    assert.notEqual(third, second);
    p.playback.source = "blob:private-media-source";
    assert.notEqual(f.read().sourceToken, first);
    const beforeGap = f.read().sourceToken;
    p.tracks[0].selected = false;
    unavailable(f.read(), "track-missing");
    p.tracks[0].selected = true;
    assert.notEqual(f.read().sourceToken, beforeGap, "unavailable observations break the source continuity");
    p.host.remove();
    const next = f.mount();
    assert.notEqual(f.read(next.video).sourceToken, first);
});

test("optional native values do not coerce missing dimensions or live state into observations", (t) => {
    const f = fixture(t),
        p = f.p;
    for (const value of [undefined, null, "1280", NaN, 0, -1, Infinity]) {
        p.tracks[0].width = p.tracks[0].height = value;
        p.playback.onLive = value;
        const result = f.read();
        assert.ok(result);
        assert.equal(result.trackWidth, null);
        assert.equal(result.trackHeight, null);
        assert.equal(result.onLive, null);
    }
    p.playback.onLive = false;
    assert.equal(f.read().onLive, false);
    Object.defineProperty(p.pane.$store.getters, "onLive", {
        get() {
            throw new Error("unsupported getter");
        },
    });
    assert.equal(f.read().onLive, null);
});

test("ownership or source changes while reading never return a mixed snapshot", (t) => {
    for (const change of [
        (p) => {
            p.player.srcObject = {};
        },
        (p) => {
            p.playback.source = "blob:replaced";
        },
        (p) => {
            p.host.__reactFiber$measured = { memoizedState: { memoizedState: p.player } };
        },
        (p) => {
            p.hook.memoizedState = { ...p.player };
        },
        (p) => {
            p.player.querySelector = () => null;
        },
        (p) => {
            p.player.shadowRoot = p.host.parentElement;
        },
        (p) => {
            p.hook.next = {
                memoizedState: { ...p.player, querySelector: () => ({ $dispatch() {}, selectVideoTrack() {} }) },
            };
        },
        (p) => {
            p.tracks[0].selected = false;
            p.tracks[1].selected = true;
        },
        (p) => {
            p.video.replaceWith(p.video.cloneNode());
        },
    ]) {
        const f = fixture(t),
            p = f.p;
        Object.defineProperty(p.pane.$store.getters, "onLive", {
            get() {
                change(p);
                return true;
            },
        });
        unavailable(f.read(), "player-changed");
        assert.deepEqual(f.calls, []);
    }
});

test("a native pane that forbids control wrapping can still be observed without redefining it", (t) => {
    const f = fixture(t),
        p = f.p;
    Object.defineProperty(p.pane, "$dispatch", { configurable: false, writable: false, value: p.original });
    const descriptor = Object.getOwnPropertyDescriptor(p.pane, "$dispatch");
    assert.equal(f.read()?.status, "ready");
    assert.deepEqual(Object.getOwnPropertyDescriptor(p.pane, "$dispatch"), descriptor);
    assert.deepEqual(f.calls, []);
});

test("discovery detects replacement caused by a native ownership getter", (t) => {
    const f = fixture(t),
        p = f.p;
    p.player.querySelector = () => {
        p.host.__reactFiber$measured = { memoizedState: { memoizedState: p.player } };
        return p.pane;
    };
    unavailable(f.read(), "player-changed");
});

test("diagnostic reads preserve an active automatic quality wrapper without scheduling control", async (t) => {
    const f = fixture(t),
        p = f.p;
    f.state(true);
    const first = f.timers.entries().next().value;
    f.timers.delete(first[0]);
    first[1]();
    await new Promise((resolve) => setImmediate(resolve));
    const wrapper = p.pane.$dispatch;
    assert.notEqual(wrapper, p.original);
    p.pane.$dispatch("change", { track: p.tracks[0] });
    const count = f.calls.length;
    const scheduled = [...f.timers.keys()];
    for (let index = 0; index < 4; index++) assert.equal(f.read()?.mode, "standard");
    assert.equal(p.pane.$dispatch, wrapper);
    assert.equal(f.calls.length, count);
    assert.deepEqual([...f.timers.keys()], scheduled);
    f.state();
    assert.equal(p.pane.$dispatch, p.original);
    assert.equal(f.read()?.mode, "standard");
    assert.equal(f.calls.length, count);
});
