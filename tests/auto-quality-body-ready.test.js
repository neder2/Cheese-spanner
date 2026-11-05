const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

// The isolated world can receive saved options before the parser has created <body>; the DOM observer then
// reports the late body through onBodyReady(observer, body).
function lateBodyFixture(t, { adblockPopupEnabled = false } = {}) {
    const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
        url: "https://chzzk.naver.com/live/offline-channel",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    const timers = new Map();
    let now = 1;
    let nextTimer = 1;
    w.setTimeout = (callback, delay = 0) => {
        const id = nextTimer++;
        timers.set(id, { callback, at: now + Math.max(0, Number(delay) || 0) });
        return id;
    };
    w.clearTimeout = (id) => timers.delete(id);
    Object.defineProperty(w.performance, "now", { value: () => now });
    const applyRequests = [];
    w.addEventListener("cheese-spanner:auto-quality:apply", () => applyRequests.push(now));

    const preferences = { autoQualityEnabled: true, autoQualityPreferred: "1080p", adblockPopupEnabled };
    w.CheeseSpannerSettings = {
        DEFAULT_QUALITY: "1080p",
        normalizeOptions: () => ({ ...preferences }),
        getOptions: (callback) => callback({ ...preferences }),
        addOptionsChangeListener: () => () => {},
    };

    w.document.body.remove();
    for (const file of ["content.js", "features/autoQuality.js"]) w.eval(read(file));
    assert.equal(w.document.body, null, "the runtime is installed before <body> exists");

    t.after(() => {
        timers.clear();
        dom.window.close();
    });

    async function flush() {
        for (let index = 0; index < 4; index++) await Promise.resolve();
    }

    async function advance(ms) {
        const end = now + ms;
        for (let count = 0; count < 10000; count += 1) {
            const next = [...timers.entries()]
                .filter(([, timer]) => timer.at <= end)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) {
                now = end;
                await flush();
                return;
            }
            const [id, timer] = next;
            timers.delete(id);
            now = timer.at;
            timer.callback();
            await flush();
        }
        throw new Error("Unexpected unbounded timer loop");
    }

    async function attachBody() {
        w.document.documentElement.append(w.document.createElement("body"));
        await flush();
    }

    return { w, applyRequests, advance, attachBody, timers, now: () => now };
}

test("a late body does not turn the entry retry window into an endless request loop", async (t) => {
    const f = lateBodyFixture(t);
    await f.attachBody();
    await f.advance(60000);
    const lateRequests = f.applyRequests.filter((at) => at > 30000);
    assert.deepEqual(lateRequests, [], "the 6 second entry window still ends when the page stays pending");
    assert.ok(f.applyRequests.length > 0, "the entry window itself still asks the page world");
    assert.equal(f.timers.size, 0, "no retry stays scheduled after the window");
});

test("a late body keeps the entry request queued behind the adblock popup gate", async (t) => {
    const f = lateBodyFixture(t, { adblockPopupEnabled: true });
    assert.equal(f.applyRequests.length, 0, "the gate holds the entry request while the popup is not ready");
    await f.attachBody();
    await f.advance(1300);
    assert.ok(f.applyRequests.length >= 1, "the gate timeout still sends the queued entry request");
    await f.advance(60000);
    assert.deepEqual(
        f.applyRequests.filter((at) => at > 30000),
        [],
        "the released window is bounded as well"
    );
});
