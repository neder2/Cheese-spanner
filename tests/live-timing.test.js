const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function setup() {
    const context = vm.createContext({ BetterChzzk: { utils: { existing: 7 } } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../shared/liveTiming.js"), "utf8"), context);
    return context.BetterChzzk.utils;
}

test("shared native timing preserves the observed staircase clock and merges utilities", () => {
    const utils = setup();
    assert.equal(utils.existing, 7);
    const m = utils.liveTiming;
    const input = { edge: 100, currentTime: 97, source: "source-a" };
    let result = m.nativeTiming(input, null, 0);
    assert.equal(result.timing, null);
    input.edge = 101;
    input.currentTime = 98;
    result = m.nativeTiming(input, result.clock, 1000);
    assert.equal(result.timing.latency, 3);
    input.currentTime = 98.5;
    result = m.nativeTiming(input, result.clock, 1500);
    assert.equal(result.timing.latency, 3);
    result = m.nativeTiming(input, result.clock, 2000);
    assert.equal(result.timing.latency, 3.5, "a paused playhead retains the original multiview estimate");
    input.currentTime = 102;
    assert.equal(m.nativeTiming(input, result.clock, 2000).timing.latency, 0);
});

test("native timing resets stale, reversed, changed and discontinuous timelines", () => {
    const { nativeTiming } = setup().liveTiming;
    const input = { edge: 100, currentTime: 97, source: "source-a" };
    const first = nativeTiming(input, null, 0);
    const stable = nativeTiming({ ...input, edge: 101 }, first.clock, 1000).clock;
    for (const [patch, now] of [
        [{}, 4001],
        [{ source: "source-b" }, 1500],
        [{ edge: 99 }, 1500],
        [{ edge: 900 }, 1500],
        [{}, 900],
        [{ edge: NaN }, 1500],
        [{ source: "" }, 1500],
        [{}, NaN],
    ]) {
        assert.equal(nativeTiming({ ...input, edge: 101, ...patch }, stable, now).timing, null);
    }
    assert.equal(nativeTiming({ ...input, currentTime: NaN }, stable, 1500).timing, null);
    assert.equal(nativeTiming({ ...input, currentTime: -1e100 }, stable, 1500).timing, null);
    assert.deepEqual(Array.from(stable.intervals), [1], "updates do not mutate a previous clock");
});

test("buffer measures only the containing continuous range and distinguishes missing from zero", () => {
    const { bufferedSeconds } = setup().liveTiming;
    const ranges = [
        { start: 0, end: 10 },
        { start: 20, end: 40 },
    ];
    assert.equal(bufferedSeconds(8, ranges, 4), 2);
    assert.equal(bufferedSeconds(10, ranges, 4), 0);
    assert.equal(bufferedSeconds(12, ranges, 4), 0);
    assert.equal(bufferedSeconds(22, ranges, 4), 18);
    assert.equal(bufferedSeconds(0, [], 1), 0);
    assert.equal(bufferedSeconds(0, [], 0), null);
    assert.equal(bufferedSeconds(NaN, ranges, 4), null);
    assert.equal(bufferedSeconds(8, null, 4), null);
    assert.equal(bufferedSeconds(8, [{ start: 0, end: NaN }], 4), null);
});
