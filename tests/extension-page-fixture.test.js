const assert = require("node:assert/strict");
const test = require("node:test");
const { waitForCondition } = require("./helpers/extension-page-fixture.js");

function createPollingClock(t) {
    let now = 0;
    const pending = [];
    t.mock.method(Date, "now", () => now);
    const schedule = t.mock.method(globalThis, "setTimeout", (callback, delay) => {
        const timer = { callback, delay };
        pending.push(timer);
        return timer;
    });
    return {
        pending,
        schedule,
        runNext(time) {
            now = time;
            assert.equal(pending.length, 1);
            pending.shift().callback();
        },
    };
}

test("condition waits observe completed work after a delayed polling callback", async (t) => {
    const clock = createPollingClock(t);
    let ready = false;
    const predicate = t.mock.fn(() => ready);
    const waiting = waitForCondition(predicate, { timeoutMs: 100, intervalMs: 7 });
    assert.equal(clock.pending[0].delay, 7);
    // Work can finish while a busy event loop delays the next polling callback past the deadline.
    ready = true;
    clock.runNext(101);

    await waiting;
    assert.equal(predicate.mock.callCount(), 2);
    assert.equal(clock.schedule.mock.callCount(), 1);
    assert.equal(clock.pending.length, 0);
});

test("condition waits still time out when delayed work has not completed", async (t) => {
    const clock = createPollingClock(t);
    const predicate = t.mock.fn(() => false);
    const rejection = assert.rejects(
        waitForCondition(predicate, { timeoutMs: 100, intervalMs: 7 }),
        /Timed out waiting for condition/
    );
    clock.runNext(101);

    await rejection;
    assert.equal(predicate.mock.callCount(), 2);
    assert.equal(clock.schedule.mock.callCount(), 1);
    assert.equal(clock.pending.length, 0);
});

test("condition waits resolve immediately without scheduling when already ready", async (t) => {
    const clock = createPollingClock(t);
    const predicate = t.mock.fn(() => true);

    await waitForCondition(predicate, { timeoutMs: 0, intervalMs: 7 });

    assert.equal(predicate.mock.callCount(), 1);
    assert.equal(clock.schedule.mock.callCount(), 0);
    assert.equal(clock.pending.length, 0);
});

for (const delayed of [false, true]) {
    test(`condition waits preserve the original ${delayed ? "delayed" : "immediate"} predicate error`, async (t) => {
        const clock = createPollingClock(t);
        const error = new Error("predicate failed");
        let throwNow = !delayed;
        const predicate = t.mock.fn(() => {
            if (throwNow) throw error;
            return false;
        });
        const rejection = assert.rejects(
            waitForCondition(predicate, { timeoutMs: 100, intervalMs: 7 }),
            (actual) => actual === error
        );
        if (delayed) {
            throwNow = true;
            clock.runNext(101);
        }

        await rejection;
        assert.equal(predicate.mock.callCount(), delayed ? 2 : 1);
        assert.equal(clock.schedule.mock.callCount(), delayed ? 1 : 0);
        assert.equal(clock.pending.length, 0);
    });
}

test("condition waits preserve the default timeout and polling interval", async (t) => {
    const clock = createPollingClock(t);
    const predicate = t.mock.fn(() => false);
    const rejection = assert.rejects(waitForCondition(predicate), /Timed out waiting for condition/);
    assert.equal(clock.pending[0].delay, 20);

    clock.runNext(1000);
    await Promise.resolve();
    assert.equal(clock.pending[0].delay, 20);
    clock.runNext(1001);

    await rejection;
    assert.equal(predicate.mock.callCount(), 3);
    assert.equal(clock.schedule.mock.callCount(), 2);
    assert.equal(clock.pending.length, 0);
});
