const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const source = fs.readFileSync(
    path.join(__dirname, "../../docs/measurements/quality-choice-session-2026-09-14.js"),
    "utf8"
);

function fixture(t) {
    const dom = new JSDOM(
        '<div class="chzzk_player type_live"><video class="webplayer-internal-video"></video></div>',
        {
            url: "https://chzzk.naver.com/live/75cbf189b3bb8f9f687d2aca0d0a382b",
            runScripts: "outside-only",
        }
    );
    const window = dom.window;
    let now = 0;
    let timerId = 0;
    let width = 852;
    let height = 480;
    const timers = new Map();
    const output = [];
    const calls = [];
    const observers = [];
    let dispatchResult = (detail) => !detail?.track || detail.track.height <= 480;
    window.performance.now = () => now;
    window.setTimeout = (callback, delay) => {
        timers.set(++timerId, { at: now + delay, callback });
        return timerId;
    };
    window.clearTimeout = (id) => timers.delete(id);
    window.console.log = (value) => output.push(value);
    window.PerformanceObserver = class {
        constructor(callback) {
            this.callback = callback;
            this.connected = false;
            observers.push(this);
        }
        observe() {
            this.connected = true;
        }
        disconnect() {
            this.connected = false;
        }
        takeRecords() {
            return [];
        }
    };
    const host = window.document.querySelector(".chzzk_player");
    const video = host.querySelector("video");
    Object.defineProperties(video, {
        videoWidth: { get: () => width },
        videoHeight: { get: () => height },
        currentTime: { get: () => now / 1000 },
        paused: { get: () => false },
        readyState: { get: () => 4 },
    });
    video.getVideoPlaybackQuality = () => ({ totalVideoFrames: Math.floor(now * 0.06), droppedVideoFrames: 0 });
    const original = function nativeDispatch(...args) {
        calls.push({ receiver: this, args });
        return dispatchResult(args[1]);
    };
    const vm = Object.create({ $dispatch: original });
    const tracks = [480, 720, 1080].map((size) => ({
        label: `${size}p`,
        width: size === 480 ? 852 : (size * 16) / 9,
        height: size,
        kind: "low-latency",
        dataset: { encodingTrackId: `${size}p` },
        selected: size === 480,
    }));
    let selections = 0;
    vm.selectVideoTrack = (track) => {
        selections++;
        for (const candidate of tracks) candidate.selected = candidate === track;
        width = track.width;
        height = track.height;
    };
    const player = {
        getPreProcessorControl() {},
        querySelector() {
            return vm;
        },
        shadowRoot: host,
        videoTracks: tracks,
        srcObject: {},
    };
    host.__reactFiber$fixture = { memoizedState: { memoizedState: player } };
    const advance = (milliseconds) => {
        const until = now + milliseconds;
        let count = 0;
        while (true) {
            const due = [...timers.entries()]
                .filter(([, item]) => item.at <= until)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            assert.ok(++count < 100, "the probe must not reschedule endlessly");
            timers.delete(due[0]);
            now = due[1].at;
            due[1].callback();
        }
        now = until;
    };
    const run = () => window.eval(source);
    const choose = (size) => {
        const track = tracks.find((item) => item.height === size);
        const allowed = vm.$dispatch("change", { track });
        if (allowed) vm.selectVideoTrack(track);
        return allowed;
    };
    const report = () => {
        window.bcQualityTrial.report();
        return JSON.parse(output.at(-1));
    };
    t.after(() => {
        try {
            window.bcQualityTrial?.stop();
        } finally {
            timers.clear();
            dom.window.close();
        }
    });
    return {
        window,
        vm,
        player,
        host,
        video,
        original,
        tracks,
        timers,
        output,
        calls,
        observers,
        advance,
        run,
        choose,
        report,
        setResult: (callback) => {
            dispatchResult = callback;
        },
        selections: () => selections,
        setNow: (value) => {
            now = value;
        },
    };
}

test("session accepts repeated observed 1080p choices and records playback progress before restoring on expiry", (t) => {
    const f = fixture(t);
    f.run();
    for (const size of [1080, 480, 1080]) {
        assert.equal(f.choose(size), true);
        f.advance(10000);
    }
    const report = f.report();
    const choices = report.rows.filter((row) => row.phase === "choice");
    assert.deepEqual(
        choices.map((row) => row.changed),
        [true, false, true]
    );
    assert.deepEqual(
        report.rows.filter((row) => row.phase === "after-choice-10s").map((row) => row.state.video.height),
        [1080, 480, 1080]
    );
    assert.equal(f.selections(), 3);
    assert.equal(f.calls.length, 3);
    f.advance(150000);
    const ended = f.report();
    assert.equal(ended.active, false);
    assert.equal(ended.endReason, "time-limit");
    assert.equal(ended.rows.at(-1).methodRestored, true);
    assert.equal(ended.rows.at(-1).state.video.currentTime, 180);
    assert.equal(ended.rows.at(-1).state.video.totalVideoFrames, 10800);
    assert.equal(f.vm.$dispatch, f.original);
    assert.equal(Object.hasOwn(f.vm, "$dispatch"), false);
    assert.equal(f.timers.size, 0);
    assert.equal(f.observers[0].connected, false);
    assert.equal(f.video.videoHeight, 1080, "restoring the hook must not silently change the selected quality");
    assert.equal(f.choose(1080), false);
});

test("duplicate execution leaves one session; rapid choices do not misattribute delayed samples", (t) => {
    const f = fixture(t);
    f.run();
    const wrapper = f.vm.$dispatch;
    f.run();
    assert.equal(f.vm.$dispatch, wrapper);
    assert.equal(f.observers.length, 1);
    assert.equal(f.choose(1080), true);
    f.advance(5000);
    assert.equal(f.choose(480), true);
    f.advance(10000);
    const settled = f.report().rows.filter((row) => row.phase === "after-choice-10s");
    assert.equal(settled.length, 1);
    assert.equal(settled[0].choice, 2);
    assert.equal(settled[0].state.video.height, 480);
    f.window.bcQualityTrial.stop();
    f.run();
    assert.equal(f.vm.$dispatch, f.original);
    assert.equal(f.observers.length, 1);
});

test("unobserved tracks, other events, nonboolean returns and another receiver preserve native behavior", (t) => {
    const f = fixture(t);
    f.run();
    assert.equal(f.choose(720), false);
    const alternative = { ...f.tracks[2], kind: "normal" };
    assert.equal(f.vm.$dispatch("change", { track: alternative }), false);
    const detail = { track: f.tracks[2] };
    f.setResult(() => false);
    assert.equal(f.vm.$dispatch("other", detail), false);
    const receiver = {};
    assert.equal(f.vm.$dispatch.call(receiver, "change", detail), false);
    assert.equal(f.calls.at(-1).receiver, receiver);
    assert.equal(f.calls.at(-1).args[1], detail);
    for (const result of [undefined, null, 0, "native", true]) {
        f.setResult(() => result);
        assert.equal(f.vm.$dispatch("change", detail), result);
    }
    assert.equal(f.selections(), 0, "the probe never selects tracks directly");
});

test("route changes, detached players, replaced providers and delayed expiry stop before further intervention", async (t) => {
    for (const change of ["route", "detach", "provider", "late-clock", "navigation-event"]) {
        await t.test(change, (t) => {
            const f = fixture(t);
            f.run();
            if (change === "route") f.window.history.pushState({}, "", "/live/another");
            if (change === "detach") f.host.remove();
            if (change === "provider") f.player.srcObject = {};
            if (change === "late-clock") f.setNow(180001);
            if (change === "navigation-event") f.window.dispatchEvent(new f.window.Event("popstate"));
            assert.equal(f.choose(1080), false);
            assert.equal(f.vm.$dispatch, f.original);
            assert.equal(f.timers.size, 0);
            assert.equal(f.report().active, false);
        });
    }
});

test("native exceptions and synchronous provider replacement do not leave the hook active", async (t) => {
    await t.test("exception", (t) => {
        const f = fixture(t);
        const error = Error("native failure");
        f.setResult(() => {
            throw error;
        });
        f.run();
        assert.throws(
            () => f.choose(1080),
            (thrown) => thrown === error
        );
        assert.equal(f.vm.$dispatch, f.original);
        assert.equal(f.timers.size, 0);
        assert.equal(f.report().endReason, "dispatch-error");
    });
    await t.test("provider replacement", (t) => {
        const f = fixture(t);
        f.setResult(() => {
            f.player.srcObject = {};
            return false;
        });
        f.run();
        assert.equal(f.choose(1080), false);
        assert.equal(f.report().endReason, "context-changed");
        assert.equal(f.vm.$dispatch, f.original);
    });
});

test("resource summary redacts URLs and rejects lookalike domains; excessive selections end the session", (t) => {
    const f = fixture(t);
    f.run();
    f.observers[0].callback({
        getEntries: () => [
            { name: "https://nvelop-livecloud.pstatic.net/private/file.m3u8?token=SECRET" },
            { name: "http://127.0.0.1:17080/private/file.m4s?token=SECRET" },
            { name: "https://nvelop-livecloud.pstatic.net.attacker.example/file.ts" },
            { name: "https://unrelated.example/private/profile" },
        ],
    });
    const resourceReport = f.report();
    assert.deepEqual(
        resourceReport.observedResources.map((item) => item.host),
        ["nvelop-livecloud.pstatic.net", "127.0.0.1:17080"]
    );
    assert.equal(JSON.stringify(resourceReport).includes("SECRET"), false);
    assert.equal(JSON.stringify(resourceReport).includes("/private"), false);
    for (let count = 0; count < 12; count++) assert.equal(f.choose(1080), true);
    assert.equal(f.choose(1080), false);
    assert.equal(f.report().endReason, "choice-limit");
    assert.equal(f.vm.$dispatch, f.original);
    assert.equal(f.timers.size, 0);
});

test("manual cleanup preserves own descriptors and avoids overwriting another party's replacement", async (t) => {
    await t.test("own descriptor", (t) => {
        const f = fixture(t);
        const descriptor = { value: f.original, configurable: true, enumerable: true, writable: false };
        Object.defineProperty(f.vm, "$dispatch", descriptor);
        f.run();
        f.window.bcQualityTrial.stop();
        assert.deepEqual(Object.getOwnPropertyDescriptor(f.vm, "$dispatch"), descriptor);
    });
    await t.test("foreign replacement", (t) => {
        const f = fixture(t);
        f.run();
        const replacement = () => "foreign";
        f.vm.$dispatch = replacement;
        f.window.bcQualityTrial.stop();
        assert.equal(f.vm.$dispatch, replacement);
        assert.equal(f.report().rows.at(-1).methodRestored, false);
        assert.equal(f.timers.size, 0);
    });
});

test("known previous hooks and the wrong broadcast refuse installation", async (t) => {
    for (const conflict of ["once", "parse", "marker", "route"]) {
        await t.test(conflict, (t) => {
            const f = fixture(t);
            if (conflict === "once") f.vm.$dispatch = function qualityChoiceOnce() {};
            if (conflict === "parse") f.window.JSON.parse.__betterChzzkGridBypassParseWrapped = true;
            if (conflict === "marker")
                f.window.document.documentElement.setAttribute("data-betterchzzk-grid-bypass-state", "1");
            if (conflict === "route") f.window.history.pushState({}, "", "/live/another");
            const before = f.vm.$dispatch;
            f.run();
            assert.equal(f.vm.$dispatch, before);
            assert.equal(f.window.bcQualityTrial, undefined);
            assert.equal(f.timers.size, 0);
        });
    }
});
