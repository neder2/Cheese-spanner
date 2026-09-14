const assert = require("node:assert/strict");
const test = require("node:test");
const { waitForCondition } = require("./helpers/extension-page-fixture.js");

test("condition waits observe completed work after a delayed polling callback", async (t) => {
    let now = 0;
    let ready = false;
    t.mock.method(Date, "now", () => now);
    const waiting = waitForCondition(() => ready, { timeoutMs: 100, intervalMs: 1 });

    // Work can finish while a busy event loop delays the next polling callback past the deadline.
    queueMicrotask(() => {
        ready = true;
        now = 101;
    });

    await waiting;
});

test("condition waits still time out when delayed work has not completed", async (t) => {
    let now = 0;
    t.mock.method(Date, "now", () => now);
    const rejection = assert.rejects(
        waitForCondition(() => false, { timeoutMs: 100, intervalMs: 1 }),
        /Timed out waiting for condition/
    );
    queueMicrotask(() => {
        now = 101;
    });

    await rejection;
});
