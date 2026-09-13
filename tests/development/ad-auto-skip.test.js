const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { waitForCondition } = require("../helpers/extension-page-fixture.js");

const contentSource = fs.readFileSync(path.join(__dirname, "../../content.js"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "../../features/adAutoSkip.js"), "utf8");
// 2026-09-08 실제 라이브에서 관측한 광고 DOM 구조. 광고 주소와 추적 요소는 제외한다.
const playerHtml = `<div class="chzzk_player"><div class="pzp-pc">
<video class="webplayer-internal-video"></video>
<div class="webplayer-internal-core-ad-ui"><div class="vod_player_wrap pc" data-role="videoAreaEl">
<div data-role="adVideoContainerEl"><video data-role="videoEl"></video></div>
<button type="button" class="btn_skip hide" aria-label="광고 SKIP" data-role="skipBtn">SKIP</button>
</div></div></div></div>`;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function createPage(t, { empty = false, pathname = "/live/channel" } = {}) {
    const dom = new JSDOM(
        `<!doctype html><html><head><style>.hide{display:none}</style></head><body>${empty ? "" : playerHtml}</body></html>`,
        {
            url: `https://chzzk.naver.com${pathname}`,
            runScripts: "outside-only",
        }
    );
    t.after(() => dom.window.close());
    const { window } = dom;
    const { document } = window;
    let optionsListener;
    const observed = new Set();
    const NativeObserver = window.MutationObserver;
    window.MutationObserver = class extends NativeObserver {
        observe(...args) {
            observed.add(this);
            super.observe(...args);
        }
        disconnect() {
            observed.delete(this);
            super.disconnect();
        }
    };
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 40 });
    window.BetterChzzkSettings = {
        getOptions(fn) {
            fn({ adAutoSkipEnabled: false });
        },
        addOptionsChangeListener(fn) {
            optionsListener = fn;
            return () => {};
        },
    };
    window.eval(contentSource);
    window.eval(source);
    return {
        window,
        document,
        observed,
        setEnabled(enabled) {
            optionsListener({ adAutoSkipEnabled: enabled });
        },
        player: () => document.querySelector(".pzp-pc"),
        button: () => document.querySelector('[data-role="skipBtn"]'),
    };
}

test("auto skip stays inactive by default and waits for an enabled visible ad button", async (t) => {
    const h = createPage(t);
    const button = h.button();
    let clicks = 0;
    button.addEventListener("click", () => clicks++);
    assert.equal(h.observed.size, 0);
    h.player().classList.add("pzp-pc--adbreak");
    await flush();
    assert.equal(clicks, 0);
    h.setEnabled(true);
    await flush();
    assert.equal(clicks, 0, "countdown hide state is not clicked");
    button.disabled = true;
    button.classList.remove("hide");
    await flush();
    assert.equal(clicks, 0, "disabled buttons are not clicked");
    button.disabled = false;
    button.setAttribute("aria-disabled", "true");
    await flush();
    assert.equal(clicks, 0);
    button.setAttribute("aria-disabled", "false");
    await flush();
    assert.equal(clicks, 1);
    button.style.color = "red";
    h.player().classList.add("pzp-pc--controls");
    await flush();
    assert.equal(clicks, 1, "unrelated mutations do not click the same active button again");
    h.setEnabled(false);
    assert.equal(h.observed.size, 0);
    button.classList.add("hide");
    await flush();
    button.classList.remove("hide");
    await flush();
    assert.equal(clicks, 1);
});

test("a reused button is eligible once per native hide/show cycle, including one mutation batch", async (t) => {
    const h = createPage(t);
    const button = h.button();
    let clicks = 0;
    button.addEventListener("click", () => clicks++);
    h.player().classList.add("pzp-pc--adbreak");
    button.classList.remove("hide");
    h.setEnabled(true);
    assert.equal(clicks, 1);
    button.classList.add("hide");
    button.classList.remove("hide");
    button.classList.add("hide");
    button.classList.remove("hide");
    await flush();
    assert.equal(clicks, 2);
    h.player().classList.remove("pzp-pc--adbreak");
    await flush();
    h.player().classList.add("pzp-pc--adbreak");
    await flush();
    assert.equal(clicks, 3);
});

test("non-ad loading, hidden containers, and unrelated skip buttons do not trigger clicks or playback changes", async (t) => {
    const h = createPage(t);
    const button = h.button();
    let clicks = 0;
    button.addEventListener("click", () => clicks++);
    const video = h.document.querySelector(".webplayer-internal-video");
    video.currentTime = 32;
    video.playbackRate = 1;
    video.play = video.pause = () => assert.fail("auto skip must not control content playback");
    button.classList.remove("hide");
    h.setEnabled(true);
    await flush();
    assert.equal(clicks, 0, "a visible button without an adbreak is not sufficient");
    button.parentElement.hidden = true;
    h.player().classList.add("pzp-pc--adbreak");
    await flush();
    assert.equal(clicks, 0);
    button.parentElement.hidden = false;
    button.parentElement.setAttribute("aria-hidden", "true");
    await flush();
    assert.equal(clicks, 0);
    button.parentElement.removeAttribute("aria-hidden");
    await flush();
    assert.equal(clicks, 1);
    assert.equal(video.currentTime, 32);
    assert.equal(video.playbackRate, 1);
    const unrelated = h.document.createElement("button");
    unrelated.textContent = "건너뛰기";
    unrelated.addEventListener("click", () => assert.fail("unrelated buttons must not be clicked"));
    h.player().append(unrelated);
    await flush();
});

test("initial mount and player replacement reconnect while route exit and disabling clean up observers", async (t) => {
    const h = createPage(t, { empty: true });
    h.setEnabled(true);
    h.document.body.innerHTML = playerHtml;
    await flush();
    let clicks = 0;
    h.button().addEventListener("click", () => clicks++);
    h.player().classList.add("pzp-pc--adbreak");
    h.button().classList.remove("hide");
    await flush();
    assert.equal(clicks, 1);

    h.document.body.innerHTML = playerHtml;
    h.button().addEventListener("click", () => clicks++);
    h.player().classList.add("pzp-pc--adbreak");
    h.button().classList.remove("hide");
    await waitForCondition(() => clicks === 2);
    assert.equal(clicks, 2);
    h.window.history.replaceState(null, "", "/category");
    h.window.dispatchEvent(new h.window.Event("betterchzzk:routechange:detected"));
    assert.equal(h.observed.size, 0);
    h.window.history.replaceState(null, "", "/video/123");
    h.window.dispatchEvent(new h.window.Event("betterchzzk:routechange:detected"));
    assert.equal(clicks, 3);
    h.setEnabled(false);
    assert.equal(h.observed.size, 0);
});

test("disabling while waiting for mount or remount never reconnects or clicks later", async (t) => {
    for (const empty of [false, true]) {
        const h = createPage(t, { empty });
        h.setEnabled(true);
        if (!empty) {
            h.document.body.innerHTML = "";
            await flush();
        }
        h.setEnabled(false);
        let clicks = 0;
        h.document.body.innerHTML = playerHtml;
        h.button().classList.remove("hide");
        h.player().classList.add("pzp-pc--adbreak");
        h.button().addEventListener("click", () => clicks++);
        // Negative assertion: allow the shared observer reconnect window to elapse.
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(h.observed.size, 0);
        assert.equal(clicks, 0);
    }
});

test("a hidden old ad button does not mask the current button and ambiguous visible buttons are left alone", async (t) => {
    const h = createPage(t);
    let clicks = 0;
    const old = h.button();
    const nextArea = old.parentElement.cloneNode(true);
    const next = nextArea.querySelector("button");
    old.addEventListener("click", () => assert.fail("hidden stale button must be ignored"));
    next.addEventListener("click", () => clicks++);
    old.parentElement.after(nextArea);
    h.player().classList.add("pzp-pc--adbreak");
    h.setEnabled(true);
    next.classList.remove("hide");
    await flush();
    assert.equal(clicks, 1);
    h.setEnabled(false);
    old.classList.remove("hide");
    h.setEnabled(true);
    await flush();
    assert.equal(clicks, 1, "multiple visible native skip buttons are ambiguous");
});

test("native player host visibility changes trigger a narrow recheck", async (t) => {
    const h = createPage(t);
    const host = h.document.createElement("div");
    const native = h.document.querySelector(".chzzk_player");
    native.before(host);
    host.append(native);
    host.hidden = true;
    let clicks = 0;
    h.button().addEventListener("click", () => clicks++);
    h.player().classList.add("pzp-pc--adbreak");
    h.button().classList.remove("hide");
    h.setEnabled(true);
    assert.equal(clicks, 0);
    host.hidden = false;
    await flush();
    assert.equal(clicks, 1);
    h.setEnabled(false);
    assert.equal(h.observed.size, 0);
});

test("removing and reinserting the same native button creates a new activation opportunity", async (t) => {
    const h = createPage(t);
    const button = h.button();
    const parent = button.parentElement;
    let clicks = 0;
    button.addEventListener("click", () => clicks++);
    h.player().classList.add("pzp-pc--adbreak");
    button.classList.remove("hide");
    h.setEnabled(true);
    assert.equal(clicks, 1);
    button.remove();
    await flush();
    parent.append(button);
    await flush();
    assert.equal(clicks, 2);
});

test("batched native availability changes allow one new attempt without duplicate clicks", async (t) => {
    for (const attribute of ["hidden", "aria-hidden", "disabled", "aria-disabled", "style"]) {
        const h = createPage(t);
        const button = h.button();
        let clicks = 0;
        button.addEventListener("click", () => clicks++);
        h.player().classList.add("pzp-pc--adbreak");
        button.classList.remove("hide");
        h.setEnabled(true);
        button.setAttribute(attribute, attribute === "style" ? "display:none" : "true");
        button.removeAttribute(attribute);
        await flush();
        assert.equal(clicks, 2, attribute);
    }
});

test("a hidden player ancestor above the immediate host is observed without a subtree scan", async (t) => {
    const h = createPage(t);
    const host = h.document.createElement("div");
    const inner = h.document.createElement("div");
    const native = h.document.querySelector(".chzzk_player");
    native.before(host);
    host.append(inner);
    inner.append(native);
    host.hidden = true;
    let clicks = 0;
    h.button().addEventListener("click", () => clicks++);
    h.player().classList.add("pzp-pc--adbreak");
    h.button().classList.remove("hide");
    h.setEnabled(true);
    assert.equal(clicks, 0);
    host.hidden = false;
    await flush();
    assert.equal(clicks, 1);
});
