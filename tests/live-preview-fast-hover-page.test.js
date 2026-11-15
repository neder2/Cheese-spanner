const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const scriptSource = fs.readFileSync(path.join(__dirname, "..", "features", "livePreviewFastHoverPage.js"), "utf8");

function createNativePreviewDom({ branch = 2, enabled = true, url = "https://chzzk.naver.com/lives" } = {}) {
    const dom = new JSDOM(
        [
            "<!doctype html><html><body><main><ul><li>",
            '<a id="thumbnail" href="/live/channel-123"><img src="https://example.com/live.jpg" alt=""></a>',
            "</li></ul></main></body></html>",
        ].join(""),
        { pretendToBeVisual: true, runScripts: "outside-only", url }
    );
    const { document } = dom.window;
    const anchor = document.getElementById("thumbnail");
    anchor.getBoundingClientRect = () => ({
        bottom: 229,
        height: 189,
        left: 40,
        right: 376,
        top: 40,
        width: 336,
    });
    document.documentElement.setAttribute(
        "data-cheese-spanner-live-preview-fast-hover-options",
        JSON.stringify({ enabled })
    );

    const scheduledDelays = [];
    const clearedTimerIds = [];
    dom.window.setTimeout = (_callback, delay) => {
        scheduledDelays.push(delay);
        return scheduledDelays.length;
    };
    dom.window.clearTimeout = (timerId) => clearedTimerIds.push(timerId);

    let enterCalls = 0;
    let timerId = 0;
    const showFirst = () => {};
    const showSecond = () => {};
    const showThird = () => {};
    const reactProps = {
        onMouseEnter: () => {
            enterCalls += 1;
            if (branch === 0)
                timerId = dom.window.setTimeout(async () => {
                    showFirst(!0);
                }, 300);
            else if (branch === 1)
                timerId = dom.window.setTimeout(async () => {
                    showSecond(!0);
                }, 300);
            else
                timerId = dom.window.setTimeout(async () => {
                    showThird(!0);
                }, 600);
        },
        onMouseLeave: () => dom.window.clearTimeout(timerId),
    };
    Object.defineProperty(anchor, "__reactProps$test", { configurable: true, value: reactProps });
    anchor.addEventListener("mouseover", reactProps.onMouseEnter);
    anchor.addEventListener("mouseout", reactProps.onMouseLeave);
    dom.window.eval(scriptSource);

    return { anchor, clearedTimerIds, dom, getEnterCalls: () => enterCalls, scheduledDelays };
}

test("native /lives hover keeps all measured CHZZK handler branches and removes only their wait", async () => {
    for (const [branch, nativeDelay] of [
        [0, 300],
        [1, 300],
        [2, 600],
    ]) {
        const { anchor, clearedTimerIds, dom, getEnterCalls, scheduledDelays } = createNativePreviewDom({ branch });

        anchor.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
        assert.equal(getEnterCalls(), 1);
        assert.deepEqual(scheduledDelays, [0]);

        anchor.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));
        assert.deepEqual(clearedTimerIds, [1]);

        await Promise.resolve();
        dom.window.setTimeout(() => {}, nativeDelay);
        assert.deepEqual(scheduledDelays, [0, nativeDelay]);
        dom.window.close();
    }
});

test("native hover acceleration restores before unrelated timers on the same event", () => {
    const { anchor, dom, scheduledDelays } = createNativePreviewDom();
    anchor.addEventListener("mouseover", () => dom.window.setTimeout(() => {}, 600));

    anchor.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
    assert.deepEqual(scheduledDelays, [0, 600]);
    dom.window.close();
});

test("native hover acceleration stays disabled with the preview option off", () => {
    const { anchor, dom, scheduledDelays } = createNativePreviewDom({ enabled: false });

    anchor.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    assert.deepEqual(scheduledDelays, [600]);
    anchor.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));

    dom.window.document.documentElement.setAttribute(
        "data-cheese-spanner-live-preview-fast-hover-options",
        JSON.stringify({ enabled: true })
    );
    dom.window.dispatchEvent(new dom.window.Event("cheese-spanner:live-preview-fast-hover-options"));
    anchor.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    assert.deepEqual(scheduledDelays, [600, 0], "the same native handler is accelerated once the option is on");
    dom.window.close();
});

test("native hover acceleration ignores non-list routes and small sidebar links", () => {
    const control = createNativePreviewDom();
    control.anchor.dispatchEvent(new control.dom.window.MouseEvent("mouseover", { bubbles: true }));
    assert.deepEqual(control.scheduledDelays, [0], "the same list fixture is accelerated");
    control.dom.window.close();

    const outside = createNativePreviewDom({ url: "https://chzzk.naver.com/" });
    outside.anchor.dispatchEvent(new outside.dom.window.MouseEvent("mouseover", { bubbles: true }));
    assert.deepEqual(outside.scheduledDelays, [600]);
    outside.dom.window.close();

    const sidebar = createNativePreviewDom();
    sidebar.anchor.getBoundingClientRect = () => ({ bottom: 90, height: 48, left: 10, right: 58, top: 42, width: 48 });
    sidebar.anchor.dispatchEvent(new sidebar.dom.window.MouseEvent("mouseover", { bubbles: true }));
    assert.deepEqual(sidebar.scheduledDelays, [600]);
    sidebar.dom.window.close();
});

test("native hover acceleration fails closed when the React handler shape changes", () => {
    const { anchor, dom, scheduledDelays } = createNativePreviewDom();
    const propsKey = Object.getOwnPropertyNames(anchor).find((name) => name.startsWith("__reactProps"));
    const props = anchor[propsKey];
    anchor.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
    anchor.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true }));
    assert.deepEqual(scheduledDelays, [0], "the measured handler shape is accelerated");

    anchor.removeEventListener("mouseover", props.onMouseEnter);
    props.onMouseEnter = () => {
        dom.window.setTimeout(async () => {}, 450);
    };
    anchor.addEventListener("mouseover", props.onMouseEnter);

    anchor.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
    assert.deepEqual(scheduledDelays, [0, 450]);
    dom.window.close();
});

// Models CHZZK's React 17+ root delegation: one bubble listener on the root container dispatches
// onMouseEnter from the previous element's mouseout, or from mouseover when entering from outside React.
// Trusted input also runs a microtask checkpoint after every listener; the window capture flusher
// registered after the script reproduces that checkpoint between the extension and React listeners.
// The fixture registers its window cleanup with the test context, so a failed assertion still closes it.
function createReactRootPreviewDom(t) {
    const dom = new JSDOM(
        [
            '<!doctype html><html><body><div id="outside"></div><main id="root"><ul><li>',
            '<span id="previousCard">prev</span>',
            '<a id="thumbnail" href="/live/channel-123"><img id="thumbImage" src="https://example.com/live.jpg" alt=""></a>',
            "</li></ul></main></body></html>",
        ].join(""),
        { pretendToBeVisual: true, runScripts: "outside-only", url: "https://chzzk.naver.com/lives" }
    );
    t.after(() => dom.window.close());
    const { document } = dom.window;
    const root = document.getElementById("root");
    const anchor = document.getElementById("thumbnail");
    anchor.getBoundingClientRect = () => ({ bottom: 229, height: 189, left: 40, right: 376, top: 40, width: 336 });
    document.documentElement.setAttribute(
        "data-cheese-spanner-live-preview-fast-hover-options",
        JSON.stringify({ enabled: true })
    );

    const scheduledDelays = [];
    dom.window.setTimeout = (_callback, delay) => {
        scheduledDelays.push(delay);
        return scheduledDelays.length;
    };
    dom.window.clearTimeout = () => {};
    const microtasks = [];
    dom.window.queueMicrotask = (callback) => microtasks.push(callback);
    const runCheckpoint = () => {
        while (microtasks.length) microtasks.shift()();
    };

    const branch = 2;
    const showFirst = () => {};
    const showSecond = () => {};
    const showThird = () => {};
    const reactProps = {
        onMouseEnter: () => {
            if (branch === 0)
                dom.window.setTimeout(async () => {
                    showFirst(!0);
                }, 300);
            else if (branch === 1)
                dom.window.setTimeout(async () => {
                    showSecond(!0);
                }, 300);
            else
                dom.window.setTimeout(async () => {
                    showThird(!0);
                }, 600);
        },
        onMouseLeave: () => {},
    };
    Object.defineProperty(anchor, "__reactProps$test", { configurable: true, value: reactProps });
    const isReactNode = (node) => node instanceof dom.window.Node && root.contains(node);
    root.addEventListener("mouseover", (event) => {
        runCheckpoint();
        if (isReactNode(event.relatedTarget)) return;
        if (anchor.contains(event.target)) reactProps.onMouseEnter();
    });
    root.addEventListener("mouseout", (event) => {
        runCheckpoint();
        const to = event.relatedTarget;
        if (anchor.contains(to) && !anchor.contains(event.target)) reactProps.onMouseEnter();
    });

    dom.window.eval(scriptSource);
    dom.window.addEventListener("mouseover", runCheckpoint, true);
    dom.window.addEventListener("mouseout", runCheckpoint, true);
    return { anchor, document, dom, runCheckpoint, scheduledDelays };
}

test("native hover acceleration survives the per-listener microtask checkpoint of trusted input", (t) => {
    const { document, dom, runCheckpoint, scheduledDelays } = createReactRootPreviewDom(t);
    const image = document.getElementById("thumbImage");

    image.dispatchEvent(
        new dom.window.MouseEvent("mouseover", { bubbles: true, relatedTarget: document.getElementById("outside") })
    );
    runCheckpoint();
    assert.deepEqual(scheduledDelays, [0]);

    dom.window.setTimeout(async () => {}, 600);
    assert.deepEqual(scheduledDelays, [0, 600], "the wrapper is gone after the event");
});

test("native hover acceleration covers React's onMouseEnter sent from the previous element's mouseout", (t) => {
    const { anchor, document, dom, runCheckpoint, scheduledDelays } = createReactRootPreviewDom(t);
    const previous = document.getElementById("previousCard");
    const image = document.getElementById("thumbImage");

    previous.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true, relatedTarget: image }));
    runCheckpoint();
    image.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true, relatedTarget: previous }));
    runCheckpoint();
    assert.deepEqual(scheduledDelays, [0], "React's enter from mouseout is accelerated and mouseover adds nothing");

    image.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true, relatedTarget: anchor }));
    image.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true, relatedTarget: previous }));
    dom.window.setTimeout(async () => {}, 600);
    assert.deepEqual(scheduledDelays, [0, 600], "leaving the thumbnail and later timers keep their native delay");
});

test("native hover acceleration is removed on the next frame when page code stops the event early", async (t) => {
    const { document, dom, scheduledDelays } = createReactRootPreviewDom(t);
    const image = document.getElementById("thumbImage");
    image.addEventListener("mouseover", (event) => event.stopPropagation());

    image.dispatchEvent(
        new dom.window.MouseEvent("mouseover", { bubbles: true, relatedTarget: document.getElementById("outside") })
    );
    assert.equal(dom.window.setTimeout.__cheeseSpannerFastHover, true, "React never saw the stopped event");
    await new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    assert.equal(dom.window.setTimeout.__cheeseSpannerFastHover, undefined);
    dom.window.setTimeout(async () => {}, 600);
    assert.deepEqual(scheduledDelays, [600]);
});

test("React root preview fixture closes its window through the test context even when an assertion fails", (t) => {
    const cleanups = [];
    const { dom } = createReactRootPreviewDom({ after: (cleanup) => cleanups.push(cleanup) });
    t.after(() => dom.window.close());
    assert.equal(cleanups.length, 1, "cleanup is registered before the test body can throw");
    assert.ok(dom.window.document, "the fixture is open until the test ends");

    for (const cleanup of cleanups) cleanup();
    assert.equal(dom.window.document, undefined, "the registered cleanup closes the JSDOM window");
});
