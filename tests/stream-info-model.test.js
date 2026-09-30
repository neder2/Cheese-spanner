const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function setup(options) {
    // No DOM, storage, network, timer or wall-clock globals exist in this fixture.
    const context = vm.createContext({});
    for (const file of ["shared/liveTiming.js", "features/streamInfoModel.js"])
        vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
    return context.BetterChzzk.streamInfoModel.create(options);
}

function sample(now, patch = {}) {
    return {
        now,
        sourceToken: "source-a",
        currentTime: 100 + now / 1000,
        seekable: [{ start: 0, end: 103 + Math.floor(now / 1000) }],
        buffered: [{ start: 0, end: 110 + now / 1000 }],
        readyState: 4,
        paused: false,
        seeking: false,
        playbackRate: 1,
        framesSupported: true,
        frames: { totalVideoFrames: 1000 + now / 10, droppedVideoFrames: 100 },
        mode: "standard",
        onLive: true,
        ...patch,
    };
}

function start(model) {
    model.sample(sample(0));
    model.sample(sample(1000));
}

test("initial loading is not observed playback and missing delay is not zero", () => {
    const model = setup();
    let result = model.sample(sample(0, { readyState: 0 }));
    assert.equal(result.current.delay, null);
    assert.equal(result.current.buffer, null);
    assert.equal(result.observedSeconds, 0);
    model.event("waiting", sample(500, { readyState: 1, currentTime: 100 }));
    result = model.sample(sample(1500, { currentTime: 100 }));
    assert.equal(result.stalls.count, 0);
    assert.equal(result.observedSeconds, 0);
    assert.equal(result.frames.percent, null);
});

test("delay, continuous buffer, current mode and catch-up speed use only the injected snapshot", () => {
    const model = setup();
    model.sample(sample(0));
    let result = model.sample(sample(1000, { currentTime: 101.03, playbackRate: 1.03, mode: "low-latency" }));
    assert.ok(Math.abs(result.current.delay - 2.97) < 1e-9);
    assert.equal(result.current.mode, "low-latency");
    assert.equal(result.current.playbackRate, 1.03);
    assert.equal(result.observedSeconds, 1);
    result = model.sample(sample(2000, { currentTime: 105, onLive: false, buffered: [] }));
    assert.equal(result.current.delay, 0);
    assert.equal(result.current.buffer, 0);
    assert.equal(result.current.onLive, false);
    assert.equal(result.samples.length, 3);
    assert.equal(result.samples.at(-1).delay, 0);
    result.samples.length = 0;
    assert.equal(model.read(2000).samples.length, 3, "a renderer cannot mutate retained history");
});

test("missing or malformed seekable ranges reset delay while an observed empty buffer stays zero", () => {
    const model = setup();
    start(model);
    let result = model.sample(sample(2000, { seekable: [{ start: 999, end: 105 }], buffered: [] }));
    assert.equal(result.current.delay, null);
    assert.equal(result.current.buffer, 0);
    result = model.sample(sample(3000));
    assert.equal(result.current.delay, null, "the repaired range must establish a new clock");
    assert.equal(model.sample(sample(4000)).current.delay, 3);
    result = model.sample(sample(5000, { seekable: null, buffered: null }));
    assert.equal(result.current.delay, null);
    assert.equal(result.current.buffer, null);
});

test("waiting needs a stationary confirmation, threshold and real progress to recover", () => {
    const model = setup();
    start(model);
    const stationary = (now) => sample(now, { currentTime: 101 });
    model.event("waiting", stationary(1100));
    model.event("waiting", stationary(1300));
    assert.equal(model.sample(stationary(1590)).stalls.count, 0);
    let result = model.sample(stationary(1600));
    assert.equal(result.stalls.count, 1);
    assert.equal(result.stalls.seconds, 0.5);
    model.event("playing", stationary(1700));
    result = model.sample(stationary(2000));
    assert.equal(result.stalls.ongoing, true, "playing alone does not prove recovery");
    assert.equal(result.stalls.seconds, 0.9);
    result = model.sample(sample(2200));
    assert.equal(result.stalls.count, 1);
    assert.equal(result.stalls.ongoing, false);
    assert.equal(result.stalls.seconds, 1.1);
});

test("short waits, stalled alone and moving media never create stalls", () => {
    const model = setup();
    start(model);
    model.event("waiting", sample(1100, { currentTime: 101 }));
    model.sample(sample(1400));
    model.event("stalled", sample(1500));
    assert.equal(model.sample(sample(2500, { currentTime: 101.5 })).stalls.count, 0);
    model.event("waiting", sample(2600));
    assert.equal(model.sample(sample(3600)).stalls.count, 0);
});

test("a stationary-confirmed wait can reach the threshold on the actual recovery observation", () => {
    const model = setup();
    start(model);
    model.event("waiting", sample(1100, { currentTime: 101 }));
    assert.equal(model.sample(sample(1200, { currentTime: 101 })).stalls.count, 0);
    const recovered = model.sample(sample(1800, { currentTime: 101.01 }));
    assert.equal(recovered.stalls.count, 1);
    assert.equal(recovered.stalls.seconds, 0.7);
    assert.equal(recovered.stalls.ongoing, false);

    const excluded = setup();
    start(excluded);
    excluded.event("waiting", sample(1100, { currentTime: 101 }));
    excluded.sample(sample(1200, { currentTime: 101 }));
    assert.equal(excluded.event("pause", sample(1800, { currentTime: 101 })).stalls.count, 0);
});

for (const patch of [
    { paused: true },
    { seeking: true },
    { ad: true },
    { transitioning: true },
    { playbackRate: 0 },
    { playbackRate: NaN },
    { ended: true },
    { error: true },
]) {
    test(`excluded playback ${JSON.stringify(patch)} ends recognized waits and resets baselines`, () => {
        const model = setup();
        start(model);
        model.event("waiting", sample(1100, { currentTime: 101 }));
        model.sample(sample(1600, { currentTime: 101 }));
        let result = model.sample(sample(2000, { currentTime: 101, ...patch }));
        assert.equal(result.stalls.seconds, 0.9);
        assert.equal(result.stalls.ongoing, false);
        assert.equal(result.current.delay, null);
        const observed = result.observedSeconds;
        model.sample(sample(3000, patch));
        result = model.sample(sample(4000));
        assert.equal(result.observedSeconds, observed, "the excluded interval is never counted");
        assert.equal(result.current.delay, null);
        assert.equal(result.frames.fps, null);
        model.event("waiting", sample(4100, { currentTime: 104 }));
        assert.equal(model.sample(sample(5000, { currentTime: 104 })).stalls.count, 1);
    });
}

test("exclusion discards an unrecognized candidate even when the next event arrives late", () => {
    const model = setup();
    start(model);
    model.event("waiting", sample(1100, { currentTime: 101 }));
    assert.equal(model.sample(sample(1900, { paused: true, currentTime: 101 })).stalls.count, 0);
});

test("hidden time and long sample or event gaps cannot inflate observed waits or frames", () => {
    for (const end of ["hidden", "sample", "waiting"]) {
        const model = setup();
        start(model);
        model.event("waiting", sample(1100, { currentTime: 101 }));
        model.sample(sample(1600, { currentTime: 101 }));
        if (end === "hidden") model.suspend(2000);
        const before = model.read(end === "hidden" ? 2000 : 1600);
        let result;
        if (end === "waiting") result = model.event("waiting", sample(10000, { currentTime: 101 }));
        else result = model.sample(sample(10000, { currentTime: 101 }));
        assert.equal(result.stalls.seconds, before.stalls.seconds, end);
        assert.equal(result.observedSeconds, before.observedSeconds, end);
        assert.equal(result.current.delay, null);
        assert.equal(result.frames.fps, null);
        if (end !== "waiting") assert.equal(result.samples.at(-1).gap, true);
    }
});

test("rolling stalls count overlapping episodes once and clip time including ongoing waits", () => {
    const model = setup();
    start(model);
    model.event("waiting", sample(1100, { currentTime: 101 }));
    for (let now = 2000; now <= 65000; now += 1000) model.sample(sample(now, { currentTime: 101 }));
    let result = model.read(65000);
    assert.equal(result.stalls.count, 1);
    assert.equal(result.stalls.seconds, 60);
    assert.equal(result.stalls.ongoing, true);
    assert.equal(result.observedSeconds, 60);
    model.sample(sample(66000));
    model.suspend(66000);
    result = model.read(125000);
    assert.equal(result.stalls.count, 1);
    assert.equal(result.stalls.seconds, 1);
    result = model.read(126000);
    assert.equal(result.stalls.count, 0);
    assert.equal(result.observedSeconds, 0);
    assert.equal(result.samples.length, 1, "only the exact left-boundary sample remains");
});

test("frame percentage is weighted by valid interval totals and skips unsupported or invalid counters", () => {
    const model = setup();
    const f = (now, total, dropped) =>
        sample(now, { frames: { totalVideoFrames: total, droppedVideoFrames: dropped } });
    model.sample(f(0, 5000, 500));
    model.sample(f(1000, 5010, 505));
    let result = model.sample(f(2000, 5100, 505));
    assert.equal(result.frames.total, 100);
    assert.equal(result.frames.dropped, 5);
    assert.equal(result.frames.percent, 5, "5/100, not the mean of 50% and 0%");
    assert.equal(result.frames.fps, 90);
    result = model.sample(f(3000, 3, 1));
    assert.equal(result.frames.total, 100, "counter reset is only a baseline");
    assert.equal(result.frames.fps, null);
    result = model.sample(f(4000, 20, 19));
    assert.equal(result.frames.total, 100, "dropped delta cannot exceed total delta");
    result = model.sample(f(5000, 21, 30));
    assert.equal(result.frames.total, 100);
    model.sample(f(6000, 25, 20));
    result = model.sample(f(7000, 35, 21));
    assert.equal(result.frames.total, 110);
    assert.equal(result.frames.dropped, 6);
    result = model.sample(sample(8000, { framesSupported: false, frames: null }));
    assert.equal(result.frames.state, "unsupported");
    assert.equal(result.frames.percent, null);
});

test("zero frame denominator remains waiting and windows include only complete frame intervals", () => {
    const empty = setup();
    empty.sample(sample(0));
    let result = empty.sample(sample(1000, { frames: sample(0).frames }));
    assert.equal(result.frames.state, "waiting");
    assert.equal(result.frames.percent, null);
    const model = setup();
    for (let now = 0; now <= 62000; now += 2000) model.sample(sample(now));
    result = model.read(63000);
    assert.equal(result.frames.total, 5800, "the 2000→4000 interval straddles the left boundary");
    assert.equal(result.frames.percent, 0);
    assert.equal(result.observedSeconds, 59, "observed time clips partial intervals");
});

test("event snapshots with missing or reset frame counters invalidate the next sample difference", () => {
    for (const patch of [
        { framesSupported: false, frames: null },
        { frames: null },
        { frames: { totalVideoFrames: 1, droppedVideoFrames: 0 } },
        { frames: { totalVideoFrames: 1200, droppedVideoFrames: 350 } },
    ]) {
        const model = setup();
        start(model);
        model.event("stalled", sample(1500, patch));
        const result = model.sample(sample(2000));
        assert.equal(result.frames.total, 100, "an invalid intermediate counter cannot bridge two valid samples");
        assert.equal(result.frames.fps, null);
    }
});

test("frame differences are independent of a same-timestamp media event before sampling", () => {
    for (const event of [null, "playing", "stalled", "waiting"]) {
        const model = setup();
        start(model);
        if (event) model.event(event, sample(2000));
        const result = model.sample(sample(2000));
        assert.equal(result.frames.total, 200, event || "sample only");
        assert.equal(result.frames.fps, 100);
        assert.equal(result.observedSeconds, 2);
    }
});

test("regular sample gaps break graph and frame continuity despite complete intervening media events", () => {
    const model = setup();
    start(model);
    for (let now = 2000; now <= 9000; now += 1000) model.event("playing", sample(now));
    const result = model.sample(sample(10000));
    assert.equal(result.samples.at(-1).gap, true);
    assert.notEqual(result.samples.at(-1).segment, result.samples[1].segment);
    assert.equal(result.current.delay, null, "the periodic edge clock also restarts after its own gap");
    assert.equal(result.frames.total, 100, "1000→10000 is not a valid regular frame interval");
    assert.equal(result.frames.fps, null);
    assert.equal(result.observedSeconds, 10, "complete event observations preserve actual observed time");
    const next = model.sample(sample(11000));
    assert.equal(next.samples.at(-1).gap, false);
    assert.equal(next.samples.at(-1).segment, result.samples.at(-1).segment);
    assert.equal(next.frames.total, 200);
    assert.equal(next.frames.fps, 100);
    assert.equal(next.current.delay, 3);
});

test("regular sample gaps use the configured strict three-interval boundary", () => {
    for (const [sampleIntervalMs, duration, gap] of [
        [1000, 3000, false],
        [1000, 3001, true],
        [500, 1500, false],
        [500, 1501, true],
    ]) {
        const model = setup({ sampleIntervalMs });
        start(model);
        for (let now = 1250; now < 1000 + duration; now += 250) model.event("playing", sample(now));
        const result = model.sample(sample(1000 + duration));
        assert.equal(result.samples.at(-1).gap, gap, `${sampleIntervalMs} ms interval, ${duration} ms gap`);
        assert.equal(result.observedSeconds, (1000 + duration) / 1000);
    }
});

test("regular sample gaps preserve waiting episodes actually observed through media events", () => {
    const model = setup();
    start(model);
    model.event("waiting", sample(2000, { currentTime: 101 }));
    for (let now = 3000; now <= 9000; now += 1000) model.event("stalled", sample(now, { currentTime: 101 }));
    const result = model.sample(sample(10000, { currentTime: 101 }));
    assert.equal(result.samples.at(-1).gap, true);
    assert.equal(result.stalls.count, 1);
    assert.equal(result.stalls.seconds, 8);
    assert.equal(result.stalls.ongoing, true);
    assert.equal(result.observedSeconds, 9);
    assert.equal(result.frames.total, 100);
    const recovered = model.sample(sample(11000));
    assert.equal(recovered.stalls.count, 1);
    assert.equal(recovered.stalls.seconds, 9);
    assert.equal(recovered.stalls.ongoing, false);
});

test("regular sample gaps preserve a short waiting candidate until a later stationary confirmation", () => {
    const model = setup();
    start(model);
    for (let now = 2000; now <= 9000; now += 1000) model.event("playing", sample(now));
    model.event("waiting", sample(9500, { currentTime: 109 }));
    const pending = model.sample(sample(9900, { currentTime: 109 }));
    assert.equal(pending.samples.at(-1).gap, true);
    assert.equal(pending.stalls.count, 0);
    const confirmed = model.sample(sample(10000, { currentTime: 109 }));
    assert.equal(confirmed.stalls.count, 1);
    assert.equal(confirmed.stalls.seconds, 0.5);
    assert.equal(confirmed.stalls.ongoing, true);
});

test("pause and seek events settle recognized waits at their actual boundary", () => {
    for (const type of ["pause", "seeking", "emptied"]) {
        const model = setup();
        start(model);
        model.event("waiting", sample(1200, { currentTime: 101 }));
        model.sample(sample(1800, { currentTime: 101 }));
        const result = model.event(type, sample(2000, { currentTime: 101 }));
        assert.equal(result.stalls.seconds, 0.8);
        assert.equal(result.stalls.ongoing, false);
        assert.equal(result.observedSeconds, 1.8);
        assert.equal(model.sample(sample(3000)).frames.total, 180, "resume adds no cross-boundary frames");
    }
});

test("source changes preserve history with a gap but never bridge frame, progress or delay baselines", () => {
    const model = setup();
    start(model);
    const before = model.read(1000);
    let result = model.sample(sample(2000, { sourceToken: "source-b", currentTime: 1, mode: "low-latency" }));
    assert.equal(result.samples.length, 3);
    assert.notEqual(result.samples[0].segment, result.samples[2].segment);
    assert.equal(result.samples[2].gap, true);
    assert.equal(result.current.delay, null);
    assert.equal(result.frames.total, before.frames.total);
    assert.equal(result.frames.fps, null);
    model.switchSource(2100, { preserveHistory: true });
    assert.equal(model.read(2100).samples.length, 3);
    model.switchSource(2200, { preserveHistory: false });
    assert.equal(model.read(2200).samples.length, 0);
    start(model);
    model.reset();
    result = model.read(1000);
    assert.equal(result.samples.length, 0);
    assert.equal(result.stalls.count, 0);
    assert.equal(result.observedSeconds, 0);
});

test("backward media time and invalid or reversed clocks cannot cross a measurement boundary", () => {
    const model = setup();
    start(model);
    let result = model.sample(sample(2000, { currentTime: 1 }));
    assert.equal(result.observedSeconds, 1);
    assert.equal(result.frames.total, 100);
    assert.equal(result.current.delay, null);
    assert.equal(result.samples.at(-1).gap, true);
    result = model.sample(sample(1500));
    assert.equal(result.observedSeconds, 0);
    assert.equal(result.samples.length, 1);
    assert.equal(model.sample(sample(NaN)).samples.length, 1);
});

test("high frequency observations and stalls retain bounded rolling memory", () => {
    const model = setup({ stallThresholdMs: 1 });
    start(model);
    for (let i = 0; i < 180; i++) {
        const now = 1100 + i * 20;
        const currentTime = 102 + i;
        model.sample(sample(now, { currentTime }));
        model.event("waiting", sample(now + 1, { currentTime }));
        model.sample(sample(now + 3, { currentTime }));
        model.sample(sample(now + 4, { currentTime: currentTime + 0.01 }));
    }
    const result = model.read(5000);
    assert.ok(result.samples.length <= 120);
    assert.equal(result.stalls.count, 128);
    assert.ok(result.frames.intervalCount <= 120);
    assert.ok(result.observedSeconds <= 60);
    model.event("waiting", sample(5010, { currentTime: 281.01 }));
    const ongoing = model.sample(sample(5020, { currentTime: 281.01 }));
    assert.equal(ongoing.stalls.ongoing, true);
    assert.equal(ongoing.stalls.count, 128, "the retained episode bound includes the ongoing stall");
    assert.equal(model.read(100000).samples.length, 0);
});
