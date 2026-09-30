const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, initial = {}) {
    const dom = new JSDOM("<!doctype html><body></body>", {
        url: "https://chzzk.naver.com/live/measured-a",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    const timers = new Map();
    let timerId = 0;
    w.setTimeout = (fn) => {
        timers.set(++timerId, fn);
        return timerId;
    };
    w.clearTimeout = (id) => timers.delete(id);
    const state = (lowLatencyEnabled, enabled = false, quality = "1080p") => {
        w.document.documentElement.setAttribute(
            "data-betterchzzk-auto-quality-state",
            JSON.stringify({ enabled, quality, lowLatencyEnabled })
        );
        w.dispatchEvent(new w.Event("betterchzzk:auto-quality:state"));
    };
    const mount = (options = {}) => {
        const host = w.document.createElement("div");
        host.className = "chzzk_player type_live";
        const video = w.document.createElement("video");
        video.className = "webplayer-internal-video";
        host.append(video);
        w.document.body.append(host);
        const playback = {
            started: true,
            paused: false,
            seeking: false,
            readyState: 4,
            onLive: true,
            time: 120,
            rate: 1,
            src: "blob:measured-source",
            ...options,
        };
        const writes = [];
        Object.defineProperties(video, {
            played: { get: () => ({ length: playback.started ? 1 : 0 }) },
            paused: { get: () => playback.paused },
            seeking: { get: () => playback.seeking },
            readyState: { get: () => playback.readyState },
            currentSrc: { get: () => playback.src },
            currentTime: {
                get: () => playback.time,
                set: (value) => {
                    writes.push(["time", value]);
                },
            },
            playbackRate: {
                get: () => playback.rate,
                set: (value) => {
                    writes.push(["rate", value]);
                },
            },
        });
        video.play = () => {
            writes.push(["play"]);
            return Promise.resolve();
        };
        video.getBoundingClientRect = host.getBoundingClientRect = () => ({
            width: 1280,
            height: 720,
            left: 0,
            top: 0,
            right: 1280,
            bottom: 720,
        });
        const tracks = [480, 720, 1080].flatMap((height) =>
            ["main", "low-latency"].map((kind) => ({
                id: `${kind}-${height}`,
                label: `${height}p`,
                height,
                width: (height * 16) / 9,
                kind,
                selected: kind === "main" && height === (options.height || 720),
                dataset: { encodingTrackId: `${height}p` },
            }))
        );
        const events = new w.EventTarget();
        tracks.addEventListener = events.addEventListener.bind(events);
        tracks.removeEventListener = events.removeEventListener.bind(events);
        const selections = [];
        const dispatches = [];
        let select = (id) => {
            for (const track of tracks) track.selected = track.id === id;
            events.dispatchEvent(new w.Event("change"));
            return Promise.resolve();
        };
        let allowed = true;
        const original = function (type, detail) {
            dispatches.push([type, detail]);
            return allowed;
        };
        const pane = Object.create({ $dispatch: original });
        pane.$store = {
            getters: {
                get onLive() {
                    return playback.onLive;
                },
            },
        };
        pane.selectVideoTrack = (id) => {
            selections.push(id);
            return select(id);
        };
        const player = {
            shadowRoot: host,
            srcObject: {},
            videoTracks: tracks,
            getPreProcessorControl() {},
            querySelector() {
                return pane;
            },
        };
        host.__reactFiber$measured = { memoizedState: { memoizedState: player } };
        return {
            host,
            video,
            playback,
            tracks,
            pane,
            player,
            selections,
            dispatches,
            writes,
            original,
            emit(type = "timeupdate") {
                video.dispatchEvent(new w.Event(type));
            },
            change() {
                events.dispatchEvent(new w.Event("change"));
            },
            setSelect(fn) {
                select = fn;
            },
            cancel() {
                allowed = false;
            },
            choose(id) {
                pane.$dispatch("change", { track: tracks.find((track) => track.id === id) });
                for (const track of tracks) track.selected = track.id === id;
                events.dispatchEvent(new w.Event("change"));
            },
        };
    };
    const p = mount(initial);
    state(true, initial.auto === true);
    w.eval(read("features/autoQualityPage.js"));
    const drain = async () => {
        await flush();
        for (let count = 0; timers.size && count < 30; count++) {
            const [id, callback] = timers.entries().next().value;
            timers.delete(id);
            callback();
            await flush();
        }
        assert.equal(timers.size, 0, "waiting or completed requests must not poll");
    };
    const result = () => JSON.parse(w.document.documentElement.getAttribute("data-betterchzzk-low-latency-result"));
    t.after(() => {
        state(false);
        timers.clear();
        dom.window.close();
    });
    return { w, p, state, mount, drain, result, timers };
}

// The independent preference was removed by user request. Its old saved/bridge
// values must remain inert; native low-latency tracks and diagnostics still exist.
test("retired low latency preference is absent from settings and the options page", (t) => {
    const f = fixture(t);
    f.w.eval(read("shared/settings.js"));
    const settings = f.w.BetterChzzkSettings;
    for (const keys of [settings.OPTION_KEYS, settings.FEATURE_KEYS, settings.STORAGE_OPTION_KEYS])
        assert.equal(keys.includes("liveLowLatencyEnabled"), false);
    const normalized = settings.normalizeOptions({ autoQualityEnabled: false, liveLowLatencyEnabled: true });
    assert.equal(Object.hasOwn(normalized, "liveLowLatencyEnabled"), false);
    assert.equal(normalized.autoQualityEnabled, false);
    const options = new JSDOM(read("options.html"));
    t.after(() => options.window.close());
    assert.equal(options.window.document.querySelector('[data-option="liveLowLatencyEnabled"]'), null);
});

test("an old enabled bridge cannot select tracks after fresh load, media events or navigation", async (t) => {
    for (let reload = 0; reload < 2; reload++) {
        const f = fixture(t);
        await f.drain();
        assert.deepEqual(f.p.selections, []);
        assert.deepEqual(f.p.writes, []);
        assert.equal(f.p.pane.$dispatch, f.p.original);
        assert.equal(f.result(), null);
        for (const type of ["playing", "seeked", "timeupdate", "emptied", "canplay"]) f.p.emit(type);
        f.state(false);
        f.state(true);
        await f.drain();
        assert.deepEqual(f.p.selections, []);
        f.w.history.pushState({}, "", "/live/measured-b");
        f.w.dispatchEvent(new f.w.Event("betterchzzk:routechange"));
        f.p.host.remove();
        const next = f.mount();
        next.emit("playing");
        await f.drain();
        assert.deepEqual(next.selections, []);
        assert.deepEqual(next.writes, []);
        assert.equal(next.pane.$dispatch, next.original);
        assert.equal(f.result(), null);
    }
});

test("removing the preference preserves native tracks and read-only stream diagnostics", async (t) => {
    const f = fixture(t);
    for (const mode of ["standard", "low-latency", "standard"]) {
        for (const track of f.p.tracks)
            track.selected = track.id === (mode === "standard" ? "main-720" : "low-latency-720");
        await f.drain();
        f.p.video.setAttribute("data-bcsi-request", JSON.stringify({ version: 1, requestId: mode }));
        f.p.video.dispatchEvent(new f.w.Event("betterchzzk:stream-info:read"));
        const result = JSON.parse(f.p.video.getAttribute("data-bcsi-result"));
        assert.equal(result.mode, mode);
        assert.equal(result.status, "ready");
        assert.deepEqual(f.p.selections, []);
        assert.deepEqual(f.p.writes, []);
        assert.equal(f.p.pane.$dispatch, f.p.original);
    }
});

test("legacy preference values cannot add a second selection to ordinary automatic quality", async (t) => {
    const f = fixture(t, { auto: true });
    await f.drain();
    assert.deepEqual(f.p.selections, ["main-1080"]);
    assert.equal(f.result(), null);
    f.state(false, true);
    f.state(true, true);
    await f.drain();
    assert.deepEqual(f.p.selections, ["main-1080"]);
    assert.deepEqual(f.p.writes, []);
});

test("the isolated bridge ignores even unnormalized retired saved values", async (t) => {
    const f = fixture(t);
    f.state(false);
    const preferences = { autoQualityEnabled: false, autoQualityPreferred: "1080p", liveLowLatencyEnabled: true };
    const listeners = new Set();
    f.w.BetterChzzkSettings = {
        DEFAULT_QUALITY: "1080p",
        normalizeOptions: () => ({ ...preferences }),
        getOptions(callback) {
            callback({ ...preferences });
        },
        addOptionsChangeListener(callback) {
            listeners.add(callback);
            return () => listeners.delete(callback);
        },
    };
    f.w.eval(read("content.js"));
    f.w.eval(read("features/autoQuality.js"));
    await f.drain();
    const bridge = () => JSON.parse(f.w.document.documentElement.getAttribute("data-betterchzzk-auto-quality-state"));
    assert.deepEqual(bridge(), { enabled: false, quality: "1080p" });
    for (const callback of listeners) callback({ ...preferences, liveLowLatencyEnabled: false });
    await f.drain();
    assert.deepEqual(bridge(), { enabled: false, quality: "1080p" });
    assert.deepEqual(f.p.selections, []);
    assert.equal(f.result(), null);
});
