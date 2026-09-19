const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const path = require("node:path");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t) {
    const dom = new JSDOM("<!doctype html><body></body>", {
        url: "https://chzzk.naver.com/live/test",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    const frames = new Map();
    let frameId = 0;
    w.requestAnimationFrame = (callback) => {
        frames.set(++frameId, callback);
        return frameId;
    };
    w.cancelAnimationFrame = (id) => frames.delete(id);
    const listeners = new Set();
    w.BetterChzzkSettings = {
        normalizeOptions: () => ({ adblockPopupEnabled: false }),
        getOptions(callback) {
            listeners.add(callback);
        },
        addOptionsChangeListener() {
            return () => {};
        },
    };
    w.eval(read("content.js"));
    w.eval(read("features/adblockPopup.js"));
    const options = (enabled) => listeners.forEach((callback) => callback({ adblockPopupEnabled: enabled }));
    t.after(() => {
        options(false);
        dom.window.close();
    });
    function popup({ close = true, text = "광고 차단 프로그램을 사용 중이신가요?" } = {}) {
        const el = w.document.createElement("div");
        el.setAttribute("role", "alertdialog");
        el.innerHTML = `<strong>${text}</strong><button type="button" aria-label="닫기">닫기</button>`;
        el.getBoundingClientRect = () => ({ width: 400, height: 200 });
        const button = el.querySelector("button");
        let clicks = 0;
        button.addEventListener("click", () => {
            clicks++;
            if (close) el.remove();
        });
        w.document.body.append(el);
        return { el, button, clicks: () => clicks };
    }
    const frame = () => {
        const callbacks = Array.from(frames.values());
        frames.clear();
        callbacks.forEach((callback) => callback());
    };
    return { w, options, popup, frame };
}

test("adblock notice closes through its handler so modal state releases native shortcuts", async (t) => {
    const f = fixture(t);
    const p = f.popup();
    let modalOpen = true;
    let toggles = 0;
    p.button.addEventListener("click", () => {
        modalOpen = false;
    });
    f.w.addEventListener("keydown", () => {
        if (!modalOpen) toggles++;
    });
    f.options(true);
    await flush();
    f.w.dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "m" }));
    assert.equal(p.clicks(), 1);
    assert.equal(p.el.isConnected, false);
    assert.equal(toggles, 1);
});

test("failed close stays visible and is not retried on unrelated mutations", async (t) => {
    const f = fixture(t);
    const p = f.popup({ close: false });
    f.w.document.body.style.cssText = "overflow:hidden;padding-right:17px;color:red";
    f.options(true);
    await flush();
    f.frame();
    p.el.className = "changed";
    await flush();
    assert.equal(p.clicks(), 1);
    assert.equal(f.w.getComputedStyle(p.el).display, "block");
    assert.equal(f.w.document.body.style.overflow, "hidden");
    assert.equal(f.w.document.body.style.paddingRight, "17px");
    f.options(false);
    assert.equal(f.w.document.body.style.color, "red");
});

test("missing, disabled, ambiguous and unrelated close controls remain untouched", async (t) => {
    const f = fixture(t);
    const missing = f.popup();
    missing.button.remove();
    const disabled = f.popup();
    disabled.button.disabled = true;
    const ambiguous = f.popup();
    ambiguous.el.append(ambiguous.button.cloneNode(true));
    const other = f.popup({ text: "확장 프로그램 설치 안내" });
    f.options(true);
    await flush();
    for (const p of [missing, disabled, ambiguous, other]) {
        assert.equal(p.clicks(), 0);
        assert.equal(f.w.getComputedStyle(p.el).display, "block");
    }
    disabled.button.disabled = false;
    await flush();
    assert.equal(disabled.clicks(), 1);
});

test("late buttons, popup reuse, remount and option changes respect popup identity", async (t) => {
    const f = fixture(t);
    const p = f.popup({ close: false });
    p.button.remove();
    f.options(true);
    await flush();
    p.el.append(p.button);
    await flush();
    f.frame();
    assert.equal(p.clicks(), 1);
    p.el.querySelector("strong").textContent = "다른 안내";
    await flush();
    p.el.querySelector("strong").textContent = "광고 차단 안내";
    await flush();
    f.frame();
    assert.equal(p.clicks(), 2);
    p.el.remove();
    f.w.document.body.append(p.el);
    await flush();
    assert.equal(p.clicks(), 3);
    f.options(false);
    const next = f.popup();
    await flush();
    assert.equal(next.clicks(), 0);
    f.options(true);
    await flush();
    assert.equal(next.clicks(), 1);
});

test("hidden notices and nested unrelated dialogs are not clicked", async (t) => {
    const f = fixture(t);
    const p = f.popup();
    const parent = f.w.document.createElement("div");
    parent.hidden = true;
    f.w.document.body.append(parent);
    parent.append(p.el);
    const outer = f.popup();
    const inner = f.popup({ text: "다른 확인 사항" });
    outer.el.append(inner.el);
    f.options(true);
    await flush();
    assert.equal(p.clicks(), 0);
    assert.equal(outer.clicks(), 0);
    assert.equal(inner.clicks(), 0);
    parent.hidden = false;
    await flush();
    assert.equal(p.clicks(), 1);
});

test("SPA changes and replaced buttons use current popup state without duplicate handlers", async (t) => {
    const f = fixture(t);
    const p = f.popup({ close: false });
    f.options(true);
    f.options(true);
    await flush();
    f.frame();
    assert.equal(p.clicks(), 1);
    f.w.history.pushState({}, "", "/video/123");
    f.w.dispatchEvent(new f.w.Event("betterchzzk:routechange"));
    await flush();
    f.frame();
    assert.equal(p.clicks(), 2);
    const replacement = p.button.cloneNode(true);
    let calls = 0;
    replacement.addEventListener("click", () => {
        calls++;
        p.el.remove();
    });
    p.button.replaceWith(replacement);
    await flush();
    assert.equal(calls, 1);
    assert.equal(p.clicks(), 2);
});

test("notice and its own backdrop are hidden before native close, then restored on failure", async (t) => {
    const f = fixture(t);
    const p = f.popup({ close: false });
    const backdrop = f.w.document.createElement("div");
    backdrop.className = "_dimmed_jao35_2";
    f.w.document.body.append(backdrop);
    backdrop.append(p.el);
    let duringClick;
    p.button.addEventListener("click", () => {
        duringClick = [f.w.getComputedStyle(p.el).visibility, f.w.getComputedStyle(backdrop).visibility];
    });
    f.options(true);
    assert.deepEqual(duringClick, ["hidden", "hidden"]);
    assert.equal(f.w.getComputedStyle(p.el).visibility, "hidden");
    await flush();
    assert.equal(p.clicks(), 1);
    f.frame();
    await flush();
    assert.equal(f.w.getComputedStyle(p.el).visibility, "visible");
    assert.equal(f.w.getComputedStyle(backdrop).visibility, "visible");
    assert.equal(p.clicks(), 1);
});

test("native async removal releases concealment and a thrown click restores immediately", async (t) => {
    const f = fixture(t);
    const p = f.popup({ close: false });
    p.button.addEventListener("click", () => f.w.queueMicrotask(() => p.el.remove()));
    f.options(true);
    assert.equal(f.w.getComputedStyle(p.el).visibility, "hidden");
    await flush();
    assert.equal(p.el.isConnected, false);
    assert.equal(p.el.hasAttribute("data-betterchzzk-adblock-popup-closing"), false);
    f.frame();
    const failing = f.popup({ close: false });
    let attempts = 0;
    failing.button.click = () => {
        attempts++;
        throw new Error("native close failed");
    };
    await flush();
    assert.equal(attempts, 1);
    assert.equal(f.w.getComputedStyle(failing.el).visibility, "visible");
    failing.el.className = "changed";
    await flush();
    f.frame();
    assert.equal(attempts, 1);
});

test("temporary concealment restores on disable and does not hide a shared backdrop", async (t) => {
    const f = fixture(t);
    const p = f.popup({ close: false });
    const other = f.popup({ text: "다른 안내" });
    const backdrop = f.w.document.createElement("div");
    backdrop.className = "_dimmed_jao35_2";
    f.w.document.body.append(backdrop);
    backdrop.append(p.el, other.el);
    f.options(true);
    assert.equal(f.w.getComputedStyle(p.el).visibility, "hidden");
    assert.equal(f.w.getComputedStyle(other.el).visibility, "visible");
    assert.equal(f.w.getComputedStyle(backdrop).visibility, "visible");
    f.options(false);
    assert.equal(f.w.getComputedStyle(p.el).visibility, "visible");
    f.frame();
    await flush();
    assert.equal(p.clicks(), 1);
});
