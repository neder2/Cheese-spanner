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
        "data-betterchzzk-live-preview-fast-hover-options",
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
    dom.window.close();
});

test("native hover acceleration ignores non-list routes and small sidebar links", () => {
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
    anchor.removeEventListener("mouseover", props.onMouseEnter);
    props.onMouseEnter = () => {
        dom.window.setTimeout(async () => {}, 450);
    };
    anchor.addEventListener("mouseover", props.onMouseEnter);

    anchor.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
    assert.deepEqual(scheduledDelays, [450]);
    dom.window.close();
});
