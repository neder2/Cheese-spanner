const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const source = fs.readFileSync(path.join(__dirname, "../features/autoQualityPage.js"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, initialPlayback = {}) {
    const dom = new JSDOM("<!doctype html><body></body>", {
        url: "https://chzzk.naver.com/live/measured-a",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    const timers = new Map();
    const timerStats = { scheduled: 0, cancelled: 0 };
    let timerId = 0;
    w.setTimeout = (callback) => {
        timerStats.scheduled++;
        timers.set(++timerId, callback);
        return timerId;
    };
    w.clearTimeout = (id) => {
        if (timers.delete(id)) timerStats.cancelled++;
    };
    const runNextTimer = async () => {
        const next = timers.entries().next().value;
        assert.ok(next, "expected scheduled work");
        timers.delete(next[0]);
        next[1]();
        await flush();
    };
    const state = (enabled, quality = "1080p") => {
        w.document.documentElement.setAttribute(
            "data-betterchzzk-auto-quality-state",
            JSON.stringify({ enabled, quality })
        );
        w.dispatchEvent(new w.Event("betterchzzk:auto-quality:state"));
    };
    const mount = ({ started = true, paused = false, readyState = 4 } = {}) => {
        const host = w.document.createElement("div");
        host.className = "chzzk_player type_live";
        const video = w.document.createElement("video");
        video.className = "webplayer-internal-video";
        const playback = { started, paused, readyState, playCalls: 0 };
        Object.defineProperties(video, {
            played: { get: () => ({ length: playback.started ? 1 : 0 }) },
            paused: { get: () => playback.paused },
            readyState: { get: () => playback.readyState },
        });
        video.play = () => {
            playback.playCalls++;
            playback.paused = false;
            return Promise.resolve();
        };
        host.append(video);
        w.document.body.append(host);
        video.getBoundingClientRect = host.getBoundingClientRect = () => ({
            width: 1280,
            height: 720,
            left: 0,
            top: 0,
            right: 1280,
            bottom: 720,
        });
        const tracks = [480, 720, 1080].map((height) => ({
            id: `muxed-${height}`,
            label: `${height}p`,
            height,
            width: height === 480 ? 852 : (height * 16) / 9,
            kind: "low-latency",
            dataset: { encodingTrackId: `${height}p` },
            selected: height === 480,
        }));
        const calls = [];
        const selections = [];
        let dispatchResult = (track) => track.height <= 480;
        let select = (id) => {
            for (const track of tracks) track.selected = track.id === id;
            return Promise.resolve();
        };
        const original = function (...args) {
            calls.push({ receiver: this, args });
            return dispatchResult(args[1]?.track);
        };
        const pane = Object.create({ $dispatch: original });
        pane.selectVideoTrack = (id) => {
            selections.push(id);
            return select(id);
        };
        const player = {
            shadowRoot: host,
            srcObject: {},
            getPreProcessorControl() {},
            querySelector() {
                return pane;
            },
            videoTracks: tracks,
        };
        host.__reactFiber$measured = { memoizedState: { memoizedState: player } };
        return {
            host,
            video,
            tracks,
            pane,
            player,
            original,
            calls,
            selections,
            playback,
            startPlayback() {
                playback.started = true;
                playback.paused = false;
                playback.readyState = 4;
                video.dispatchEvent(new w.Event("playing"));
            },
            setSelect(fn) {
                select = fn;
            },
            setDispatch(fn) {
                dispatchResult = fn;
            },
        };
    };
    const initial = mount(initialPlayback);
    state(true);
    const originalParse = w.JSON.parse;
    w.eval(source);
    const request = (quality = "1080p") => {
        w.document.documentElement.setAttribute(
            "data-betterchzzk-auto-quality-request",
            JSON.stringify({ requestId: `${Date.now()}:${Math.random()}`, quality })
        );
        w.dispatchEvent(new w.Event("betterchzzk:auto-quality:apply"));
        return JSON.parse(w.document.documentElement.getAttribute("data-betterchzzk-auto-quality-result"));
    };
    let disableIsolated = null;
    const loadIsolated = async () => {
        await flush();
        let preferences = { autoQualityEnabled: true, autoQualityPreferred: "1080p", adblockPopupEnabled: false };
        const listeners = new Set();
        w.BetterChzzkSettings = {
            DEFAULT_QUALITY: "1080p",
            normalizeOptions: () => ({ ...preferences }),
            getOptions: (callback) => callback({ ...preferences }),
            addOptionsChangeListener(callback) {
                listeners.add(callback);
                return () => listeners.delete(callback);
            },
        };
        for (const file of ["content.js", "features/autoQuality.js"])
            w.eval(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
        const setOptions = (changes) => {
            preferences = { ...preferences, ...changes };
            for (const callback of listeners) callback({ ...preferences });
        };
        disableIsolated = () => setOptions({ autoQualityEnabled: false });
        return setOptions;
    };
    t.after(() => {
        disableIsolated?.();
        state(false);
        timers.clear();
        dom.window.close();
    });
    return { w, state, request, mount, initial, timers, timerStats, runNextTimer, loadIsolated, originalParse };
}

test("both worlds coalesce saved option changes and stop polling while the native player owns the wait", async (t) => {
    const f = fixture(t, { started: false, paused: true, readyState: 0 });
    const setOptions = await f.loadIsolated();
    const queued = [...f.timers.keys()];
    assert.equal(queued.length, 2, "one scheduled application per world");
    for (let index = 0; index < 40; index++) setOptions({ autoQualityPreferred: "720p" });
    assert.deepEqual([...f.timers.keys()], queued, "both existing tasks retain their earlier scheduling time");
    await f.runNextTimer();
    await f.runNextTimer();
    assert.equal(f.timers.size, 0, "neither world polls for playing");
    const result = JSON.parse(f.w.document.documentElement.getAttribute("data-betterchzzk-auto-quality-result"));
    assert.equal(result.waitForEvent, true);
    f.initial.startPlayback();
    await f.runNextTimer();
    await f.runNextTimer();
    assert.deepEqual(f.initial.selections, ["muxed-720"]);
    assert.equal(f.timers.size, 0);
    setOptions({ autoQualityEnabled: false });
    assert.equal(f.timers.size, 0);
    assert.equal(f.initial.pane.$dispatch, f.initial.original);
});

test("quality scheduling keeps the earliest queued application during a burst of option updates", async (t) => {
    const f = fixture(t);
    const firstTimer = f.timers.keys().next().value;
    const scheduledBefore = f.timerStats.scheduled;
    for (let index = 0; index < 40; index++) f.state(true, "720p");
    assert.equal(f.timers.keys().next().value, firstTimer, "new requests must not postpone existing immediate work");
    assert.equal(f.timerStats.scheduled, scheduledBefore, "one task handles the latest option value");
    await f.runNextTimer();
    assert.deepEqual(f.initial.selections, ["muxed-720"]);
});

test("native first playback waits on its event without a polling timer and then applies the latest quality", async (t) => {
    const f = fixture(t, { started: false, paused: true, readyState: 0 });
    await f.runNextTimer();
    assert.equal(f.timers.size, 0, "there is no timer polling while the native playing event is pending");
    assert.equal(f.request().waitForEvent, true);
    f.state(true, "720p");
    await f.runNextTimer();
    assert.equal(f.timers.size, 0);
    f.initial.startPlayback();
    assert.equal(f.timers.size, 1, "playing schedules the existing safe next-task boundary immediately");
    await f.runNextTimer();
    await f.runNextTimer();
    assert.deepEqual(f.initial.selections, ["muxed-720"]);
    assert.equal(f.timers.size, 0);
});

test("native selection in flight stays pending without polling even when its selected flags change early", async (t) => {
    const f = fixture(t),
        p = f.initial;
    let finish;
    p.setSelect((id) => {
        for (const track of p.tracks) track.selected = track.id === id;
        return new Promise((resolve) => {
            finish = resolve;
        });
    });
    await f.runNextTimer();
    assert.equal(f.timers.size, 0);
    const pending = f.request();
    assert.equal(pending.status, "pending");
    assert.equal(pending.waitForEvent, true);
    assert.equal(p.selections.length, 1);
    finish();
    await flush();
    await f.runNextTimer();
    assert.equal(f.request().status, "already");
    assert.equal(f.timers.size, 0);
});

test("a known native player's track list is read once without exploring unrelated player internals", (t) => {
    const f = fixture(t),
        p = f.initial;
    let trackReads = 0,
        nestedReads = 0;
    f.w.Object.defineProperty(p.player, "videoTracks", {
        configurable: true,
        get() {
            trackReads++;
            return p.tracks;
        },
    });
    f.w.Object.defineProperty(p.player, "_corePlayer", {
        configurable: true,
        get() {
            nestedReads++;
            return {};
        },
    });
    f.request();
    assert.equal(nestedReads, 0, "a valid direct track list does not require an eager graph traversal");
    assert.equal(trackReads, 1, "listener binding and selection share the same track-list snapshot");
});

test("observed live player uses native choice events for repeated configured quality changes", async (t) => {
    const f = fixture(t);
    const p = f.initial;
    for (const quality of ["720p", "1080p", "480p", "720p", "1080p"]) {
        f.state(true, quality);
        assert.equal(f.request(quality).status, "pending");
        await flush();
        assert.equal(f.request(quality).status, "already");
        assert.equal(p.tracks.find((track) => track.selected).label, quality);
    }
    assert.deepEqual(p.selections, ["muxed-720", "muxed-1080", "muxed-480", "muxed-720", "muxed-1080"]);
    assert.equal(p.calls.length, 5);
    assert.ok(p.calls.every((call) => call.receiver === p.pane && call.args[0] === "change"));
    assert.equal(f.w.JSON.parse, f.originalParse);
    f.state(false);
    assert.equal(p.pane.$dispatch, p.original);
    assert.equal(Object.hasOwn(p.pane, "$dispatch"), false);
    assert.equal(p.pane.$dispatch("change", { track: p.tracks[2] }), false);
});

test("manual configured HD choices retain native side effects while unrelated cancellation remains unchanged", (t) => {
    const f = fixture(t),
        p = f.initial;
    f.request();
    const detail = { track: p.tracks[2] };
    assert.equal(p.pane.$dispatch("change", detail), true);
    assert.equal(p.calls.at(-1).args[1], detail);
    assert.equal(p.pane.$dispatch("other", detail), false);
    assert.equal(p.pane.$dispatch("change", { track: p.tracks[1] }), false);
    assert.equal(p.pane.$dispatch("change", { track: { ...p.tracks[2], kind: "normal" } }), false);
    for (const result of [null, undefined, 0, "native", true]) {
        p.setDispatch(() => result);
        assert.equal(p.pane.$dispatch("change", detail), result);
    }
    p.setDispatch(() => false);
    f.state(true, "480p");
    assert.equal(p.pane.$dispatch("change", detail), false);
    f.state(true, "720p");
    assert.equal(p.pane.$dispatch("change", { track: p.tracks[1] }), true);
    assert.equal(p.pane.$dispatch("change", detail), false, "720p setting does not permit a cancelled 1080p request");
    for (const track of [
        { ...p.tracks[1], kind: "normal" },
        { ...p.tracks[1], width: 960 },
        { ...p.tracks[1], dataset: { encodingTrackId: "unobserved" } },
    ])
        assert.equal(p.pane.$dispatch("change", { track }), false);
});

test("unobserved native cancellation is reported once instead of repeated popup dispatch", (t) => {
    const f = fixture(t),
        p = f.initial;
    f.state(true, "720p");
    p.tracks[1].kind = "unobserved";
    for (let index = 0; index < 8; index++) {
        p.tracks[1] = { ...p.tracks[1] };
        const result = f.request("720p");
        assert.equal(result.status, "blocked");
        assert.equal(result.reason, "native-quality-cancelled");
    }
    assert.equal(p.calls.length, 1);
    assert.equal(p.selections.length, 0);
    assert.equal(p.tracks.find((track) => track.selected).height, 480);
});

test("a missing 1080p track falls back to the measured 720p track through the native menu", async (t) => {
    const f = fixture(t),
        p = f.initial;
    p.tracks.pop();
    assert.equal(f.request().status, "pending");
    await flush();
    const result = f.request();
    assert.equal(result.status, "already");
    assert.equal(result.selected.height, 720);
    assert.deepEqual(p.selections, ["muxed-720"]);
});

test("initial quality selection waits for native playback to start instead of interrupting its play request", async (t) => {
    const f = fixture(t, { started: false, paused: false, readyState: 1 }),
        p = f.initial;
    for (const readyState of [1, 4]) {
        p.playback.readyState = readyState;
        const result = f.request();
        assert.equal(result.status, "pending");
        assert.equal(result.reason, "native-playback-start");
        assert.equal(p.calls.length, 0, "no installation guide is requested before the first playing event");
        assert.equal(p.selections.length, 0, "a pending native play request is not interrupted by a track switch");
    }
    p.startPlayback();
    assert.equal(f.request().status, "pending");
    await flush();
    assert.equal(f.request().status, "already");
    assert.equal(p.playback.paused, false);
    assert.equal(p.playback.playCalls, 0, "the native player owns playback; the extension only changes quality");
    assert.deepEqual(p.selections, ["muxed-1080"]);
});

test("a user-paused video that already played keeps its pause state during quality selection", async (t) => {
    const f = fixture(t, { started: true, paused: true }),
        p = f.initial;
    f.state(true, "720p");
    assert.equal(f.request("720p").status, "pending");
    await flush();
    assert.equal(f.request("720p").status, "already");
    assert.equal(p.playback.paused, true);
    assert.equal(p.playback.playCalls, 0);
});

test("disabling or replacing the startup player removes the waiting playback listener", (t) => {
    const f = fixture(t, { started: false, paused: true, readyState: 0 }),
        p = f.initial;
    f.request();
    f.state(false);
    const timersAfterDisable = f.timers.size;
    p.startPlayback();
    assert.equal(f.timers.size, timersAfterDisable);
    assert.equal(p.selections.length, 0);
    assert.equal(p.pane.$dispatch, p.original);
});

test("a rejected native selection is not declared successful just because selection flags changed", async (t) => {
    const f = fixture(t),
        p = f.initial;
    p.setSelect((id) => {
        for (const track of p.tracks) track.selected = track.id === id;
        return Promise.reject(Error("native player rejected after setting flags"));
    });
    f.request();
    await flush();
    assert.equal(f.request().status, "blocked");
    assert.equal(p.selections.length, 1);
});

test("pending selection is shared and rejects without falsely reporting successful selection", async (t) => {
    const f = fixture(t),
        p = f.initial;
    let reject;
    p.setSelect(
        () =>
            new Promise((_, fail) => {
                reject = fail;
            })
    );
    assert.equal(f.request().status, "pending");
    assert.equal(f.request().status, "pending");
    assert.equal(p.selections.length, 1);
    reject(Error("native failure"));
    await flush();
    assert.equal(f.request().status, "blocked");
    assert.equal(p.selections.length, 1);
    assert.equal(p.tracks.find((track) => track.selected).height, 480);
});

test("route and DOM replacement detach old menu hooks; late completion cannot control the next player", async (t) => {
    const f = fixture(t),
        p = f.initial;
    let resolve;
    p.setSelect(
        () =>
            new Promise((done) => {
                resolve = done;
            })
    );
    f.request();
    f.w.history.pushState({}, "", "/live/measured-b");
    f.w.dispatchEvent(new f.w.Event("betterchzzk:routechange"));
    assert.equal(p.pane.$dispatch, p.original);
    p.host.remove();
    const next = f.mount();
    f.state(true);
    f.request();
    await flush();
    assert.equal(f.request().status, "already");
    resolve();
    await flush();
    assert.equal(next.selections.length, 1);
    next.host.remove();
    await flush();
    assert.equal(next.pane.$dispatch, next.original);
});

test("provider replacement and disabling release wrappers without overwriting later code", async (t) => {
    const f = fixture(t),
        p = f.initial;
    f.request();
    await flush();
    p.player.srcObject = {};
    assert.equal(p.pane.$dispatch("change", { track: p.tracks[2] }), false);
    assert.equal(p.pane.$dispatch, p.original);
    f.request();
    const replacement = () => "replacement";
    p.pane.$dispatch = replacement;
    f.state(false);
    assert.equal(p.pane.$dispatch, replacement);
});

test("an ambiguous native player does not fall through to an unrelated tracked track list", (t) => {
    const f = fixture(t),
        p = f.initial;
    const otherPane = { $dispatch: p.original, selectVideoTrack() {} };
    const otherPlayer = {
        ...p.player,
        querySelector() {
            return otherPane;
        },
    };
    p.host.__reactFiber$measured.alternate = { memoizedState: { memoizedState: otherPlayer } };
    const tracked = {};
    f.w.Object.defineProperty(tracked, "videoTracks", {
        configurable: true,
        get() {
            return p.tracks;
        },
    });
    void tracked.videoTracks;
    assert.equal(f.request().status, "pending");
    assert.equal(p.tracks.find((track) => track.selected).height, 480);
    assert.equal(p.selections.length, 0);
});

test("removing a discovered native video cannot restart selection through a stale tracked object", async (t) => {
    const f = fixture(t),
        p = f.initial;
    f.request();
    await flush();
    const tracked = {};
    f.w.Object.defineProperty(tracked, "videoTracks", {
        configurable: true,
        get() {
            return p.tracks;
        },
    });
    void tracked.videoTracks;
    for (const track of p.tracks) track.selected = track.height === 480;
    p.host.remove();
    await flush();
    assert.equal(f.request().status, "pending");
    assert.equal(p.tracks.find((track) => track.selected).height, 480);
    assert.equal(p.selections.length, 1);
});
