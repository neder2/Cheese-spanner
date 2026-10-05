const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { evalRepoScript } = require("./helpers/extension-page-fixture.js");

function fixture(
    t,
    {
        version = "1.4.1",
        options = { updateGuideEnabled: true },
        deferred = false,
        toastHeight = 156,
        reducedMotion = false,
        animationError = false,
    } = {}
) {
    const dom = new JSDOM('<body><button id="outside">원래 초점</button><textarea></textarea></body>', {
        url: "https://chzzk.naver.com/live/test",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const win = dom.window,
        doc = win.document,
        timers = new Map(),
        animations = [],
        messages = [],
        listeners = new Set(),
        pending = [];
    let now = 0,
        nextId = 0,
        focused = true,
        hidden = false,
        full = null,
        optionsListener,
        routeListener;
    win.setTimeout = (fn, delay = 0) => {
        const id = ++nextId;
        timers.set(id, { fn, at: now + delay });
        return id;
    };
    win.clearTimeout = (id) => timers.delete(id);
    win.requestAnimationFrame = (fn) => win.setTimeout(fn, 16);
    win.cancelAnimationFrame = win.clearTimeout;
    win.matchMedia = () => ({ matches: reducedMotion });
    win.HTMLElement.prototype.animate = function (keyframes, timing) {
        if (animationError) throw new Error("Animation unavailable");
        let heldTime = 0,
            runningSince = now,
            state = "running";
        const animation = {
            target: this,
            keyframes,
            timing,
            get currentTime() {
                if (state === "idle") return null;
                return Math.min(timing.duration, heldTime + (state === "running" ? now - runningSince : 0));
            },
            set currentTime(value) {
                heldTime = value;
                runningSince = now;
            },
            get playState() {
                return state;
            },
            pause() {
                heldTime = this.currentTime;
                state = "paused";
            },
            play() {
                runningSince = now;
                state = "running";
            },
            cancel() {
                state = "idle";
            },
        };
        animations.push(animation);
        return animation;
    };
    Object.defineProperty(win.performance, "now", { value: () => now });
    Object.defineProperty(doc, "visibilityState", { get: () => (hidden ? "hidden" : "visible") });
    Object.defineProperty(doc, "fullscreenElement", { get: () => full });
    doc.hasFocus = () => focused;
    const getRect = win.HTMLElement.prototype.getBoundingClientRect;
    win.HTMLElement.prototype.getBoundingClientRect = function () {
        if (!this.hasAttribute("data-bcug-toast")) return getRect.call(this);
        const width = Number.parseFloat(this.style.width) || 0;
        return { left: 0, top: 0, right: width, bottom: toastHeight, width, height: toastHeight };
    };
    const runtime = {
        id: "test-extension",
        getManifest: () => ({ version }),
        getURL: (path) => `chrome-extension://test-extension/${path}`,
        sendMessage(message, callback) {
            messages.push(message);
            const response =
                message.action === "claim" ? { ok: true, show: false, token: "test-token" } : { ok: true, show: true };
            if (deferred) pending.push({ message, callback, response });
            else callback(response);
        },
        onMessage: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    };
    win.chrome = { runtime };
    win.BetterChzzk = {
        utils: {
            getMainVideoElement: () => doc.querySelector("video"),
            startPageChangeDetection: (fn) => {
                routeListener = fn;
                return () => {
                    routeListener = null;
                };
            },
        },
    };
    win.BetterChzzkSettings = {
        getOptions: (fn) => fn(options),
        addOptionsChangeListener: (fn) => {
            optionsListener = fn;
            return () => {
                optionsListener = null;
            };
        },
    };
    evalRepoScript(dom, "shared/updateGuide.js");
    evalRepoScript(dom, "shared/updateGuideView.js");
    const inject = () => evalRepoScript(dom, "features/updateGuide.js");
    inject();
    t.after(() => {
        win.BetterChzzk.updateGuide?.stop();
        win.close();
    });
    const flush = async () => {
        for (let i = 0; i < 8; i++) await Promise.resolve();
    };
    async function advance(ms) {
        const target = now + ms;
        while (true) {
            const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            now = due[1].at;
            timers.delete(due[0]);
            due[1].fn();
            await flush();
        }
        now = target;
        await flush();
    }
    function replay({
        sender = { id: runtime.id, url: runtime.getURL("options.html#update-guide-panels") },
        guideVersion = version,
    } = {}) {
        let response;
        for (const fn of listeners)
            fn({ type: "betterchzzk:update-guide", protocol: 1, action: "replay", guideVersion }, sender, (value) => {
                response = value;
            });
        return response;
    }
    return {
        win,
        doc,
        timers,
        animations,
        messages,
        pending,
        listeners,
        runtime,
        inject,
        advance,
        flush,
        replay,
        options: (value) => {
            options = value;
            optionsListener?.(value);
        },
        route: () => routeListener?.(),
        hide: (value) => {
            hidden = value;
            doc.dispatchEvent(new win.Event("visibilitychange"));
        },
        focus: (value) => {
            focused = value;
            win.dispatchEvent(new win.Event(value ? "focus" : "blur"));
        },
        fullscreen: (value) => {
            full = value ? doc.body : null;
            doc.dispatchEvent(new win.Event("fullscreenchange"));
        },
        toast: () => doc.querySelector("[data-bcug-toast]"),
    };
}

test("automatic and manual notices show the same two introductions with only one close control", async (t) => {
    const f = fixture(t);
    const outside = f.doc.getElementById("outside");
    outside.focus();
    await f.advance(2000);
    const toast = f.toast();
    assert.ok(toast);
    assert.deepEqual(
        [...toast.querySelectorAll("h3")].map((node) => node.textContent),
        ["채팅창·사이드바 크기 조절", "시청기록 백업 및 불러오기"]
    );
    assert.match(toast.textContent, /더블클릭으로 초기화/);
    assert.match(toast.textContent, /1\.4\.1 새 기능/);
    assert.doesNotMatch(toast.textContent, /스트림|살펴보세요|JSON|설정 보기|이전|다음/);
    assert.equal(toast.querySelectorAll("button").length, 1);
    assert.equal(toast.querySelector("button").getAttribute("aria-label"), "닫기");
    assert.equal(f.doc.activeElement, outside);
    const contents = toast.textContent;
    assert.equal(f.replay()?.ok, true);
    assert.equal(f.toast(), null);
    const manual = f.doc.querySelector("[data-bcug-view]");
    assert.equal(manual.textContent, contents);
    assert.equal(manual.querySelectorAll("button").length, 1);
    assert.equal(f.messages.filter((message) => message.action === "open-settings").length, 0);
});

test("compact notice fits available height without reserving the former larger panel", async (t) => {
    const f = fixture(t, { toastHeight: 156 });
    Object.defineProperty(f.win, "innerHeight", { configurable: true, value: 260 });
    await f.advance(2000);
    assert.ok(f.toast());
    assert.ok(Number.parseFloat(f.toast().style.width) <= 300);
    assert.deepEqual(
        f.messages.map((message) => message.action),
        ["claim", "commit"]
    );
});

test("unmeasurable or oversized notices cannot consume the once-per-version reservation", async (t) => {
    for (const height of [0, 700]) {
        const f = fixture(t, { toastHeight: height });
        await f.advance(2000);
        assert.equal(f.toast(), null);
        assert.equal(f.messages.length, 0);
    }
});

test("countdown starts after approval and manual replay starts its own full countdown", async (t) => {
    const f = fixture(t, { deferred: true });
    await f.advance(2000);
    const claim = f.pending.shift();
    assert.equal(f.animations.length, 0);
    claim.callback(claim.response);
    await f.flush();
    const commit = f.pending.shift();
    assert.equal(f.animations.length, 0);
    commit.callback(commit.response);
    await f.flush();
    const progress = f.toast().querySelector("[data-bcug-progress]");
    const animation = f.animations[0];
    assert.equal(progress.getAttribute("aria-hidden"), "true");
    assert.equal(progress, f.toast().firstElementChild);
    assert.equal(animation.target, progress.firstElementChild);
    assert.deepEqual(
        Array.from(animation.keyframes, (frame) => frame.transform),
        ["scaleX(1)", "scaleX(0)"]
    );
    assert.equal(animation.timing.duration, 20000);
    assert.equal(animation.timing.easing, "linear");
    assert.equal(animation.currentTime, 0);
    assert.equal(f.timers.size, 1, "the visual countdown adds no timer or RAF loop");
    await f.advance(10000);
    assert.equal(animation.currentTime, 10000);
    assert.equal(f.replay()?.ok, true);
    assert.equal(animation.playState, "idle");
    const replayAnimation = f.animations[1];
    assert.equal(replayAnimation.currentTime, 0);
    assert.ok(f.doc.querySelector("[data-bcug-view] [data-bcug-progress]"));
    await f.advance(19999);
    assert.ok(f.doc.querySelector("[data-bcug-view]"));
    assert.equal(replayAnimation.currentTime, 19999);
    await f.advance(1);
    assert.equal(f.doc.querySelector("[data-bcug-view]"), null);
    assert.equal(replayAnimation.playState, "idle");
    assert.equal(f.timers.size, 0);
});

test("replay countdown starts when popup focus returns without focusing its own heading", async (t) => {
    const f = fixture(t, { options: { updateGuideEnabled: false } });
    const outside = f.doc.getElementById("outside");
    outside.focus();
    f.focus(false);
    assert.equal(f.replay()?.ok, true);
    const root = f.doc.querySelector("[data-bcug-view]");
    const animation = f.animations[0];
    assert.equal(f.doc.activeElement, outside);
    await f.advance(60000);
    assert.equal(animation.currentTime, 0);
    assert.equal(animation.playState, "paused");
    f.focus(true);
    await f.advance(5000);
    root.dispatchEvent(new f.win.MouseEvent("mouseenter"));
    await f.advance(60000);
    assert.equal(animation.currentTime, 5000);
    root.dispatchEvent(new f.win.MouseEvent("mouseleave"));
    root.querySelector("button").focus();
    await f.advance(60000);
    assert.equal(animation.currentTime, 5000);
    outside.focus();
    await f.advance(14999);
    assert.equal(animation.currentTime, 19999);
    assert.equal(f.doc.querySelector("[data-bcug-view]"), root);
    await f.advance(1);
    assert.equal(f.doc.querySelector("[data-bcug-view]"), null);
    assert.equal(animation.playState, "idle");
    assert.equal(f.timers.size, 0);
    assert.equal(f.messages.length, 0);
});

test("a late automatic claim cannot cancel the manual replay countdown", async (t) => {
    const f = fixture(t, { deferred: true });
    await f.advance(2000);
    const claim = f.pending.shift();
    assert.equal(f.replay()?.ok, true);
    const root = f.doc.querySelector("[data-bcug-view]");
    const animation = f.animations[0];
    await f.advance(5000);
    claim.callback(claim.response);
    await f.flush();
    const release = f.pending.shift();
    assert.equal(release.message.action, "release");
    release.callback({ ok: true, show: false });
    await f.flush();
    assert.equal(f.doc.querySelector("[data-bcug-view]"), root);
    assert.equal(animation.currentTime, 5000);
    assert.equal(animation.playState, "running");
    await f.advance(15000);
    assert.equal(f.doc.querySelector("[data-bcug-view]"), null);
    assert.equal(f.timers.size, 0);
});

test("animation setup failure cannot prevent automatic or replay expiry", async (t) => {
    for (const manual of [false, true]) {
        const f = fixture(t, { animationError: true });
        if (manual) assert.equal(f.replay()?.ok, true);
        else await f.advance(2000);
        const selector = manual ? "[data-bcug-view]" : "[data-bcug-toast]";
        assert.ok(f.doc.querySelector(selector));
        assert.equal(f.doc.querySelector("[data-bcug-progress]"), null);
        await f.advance(19999);
        assert.ok(f.doc.querySelector(selector));
        await f.advance(1);
        assert.equal(f.doc.querySelector(selector), null);
        assert.equal(f.timers.size, 0);
    }
});

test("reduced motion uses discrete countdown steps with the same paused lifetime", async (t) => {
    const f = fixture(t, { reducedMotion: true });
    await f.advance(2000);
    const animation = f.animations[0];
    assert.equal(animation.timing.easing, "steps(20, end)");
    await f.advance(5000);
    f.focus(false);
    await f.advance(60000);
    assert.equal(animation.currentTime, 5000);
    assert.equal(animation.playState, "paused");
    f.focus(true);
    await f.advance(14999);
    assert.equal(animation.currentTime, 19999);
    assert.ok(f.toast());
    await f.advance(1);
    assert.equal(f.toast(), null);
    assert.equal(animation.playState, "idle");
    assert.equal(f.timers.size, 0);
});

test("20 seconds are accumulated only outside hover and keyboard focus, with no automatic focus", async (t) => {
    const f = fixture(t);
    const outside = f.doc.getElementById("outside");
    outside.focus();
    await f.advance(1999);
    assert.equal(f.toast(), null);
    await f.advance(1);
    assert.ok(f.toast());
    assert.equal(f.doc.activeElement, outside);
    assert.deepEqual(
        f.messages.map((m) => m.action),
        ["claim", "commit"]
    );
    assert.equal(f.messages[0].clientId, f.messages[1].clientId);
    const animation = f.animations[0];
    await f.advance(10000);
    f.toast().dispatchEvent(new f.win.MouseEvent("mouseenter"));
    await f.advance(60000);
    assert.ok(f.toast());
    assert.equal(animation.currentTime, 10000);
    assert.equal(animation.playState, "paused");
    f.toast().dispatchEvent(new f.win.MouseEvent("mouseleave"));
    await f.advance(5000);
    f.toast().querySelector("button").focus();
    await f.advance(60000);
    assert.ok(f.toast());
    assert.equal(animation.currentTime, 15000);
    assert.equal(animation.playState, "paused");
    outside.focus();
    await f.advance(4999);
    assert.ok(f.toast());
    assert.equal(animation.currentTime, 19999);
    await f.advance(1);
    assert.equal(f.toast(), null);
    assert.equal(animation.playState, "idle");
    f.focus(false);
    f.focus(true);
    await f.advance(30000);
    assert.equal(f.messages.length, 2);
});

test("switching windows preserves the notice and pauses only its remaining display time", async (t) => {
    const f = fixture(t);
    await f.advance(2000);
    const toast = f.toast();
    const animation = f.animations[0];
    await f.advance(5000);
    f.focus(false);
    f.doc.getElementById("outside").focus();
    toast.dispatchEvent(new f.win.MouseEvent("mouseenter"));
    toast.dispatchEvent(new f.win.MouseEvent("mouseleave"));
    await f.advance(60000);
    assert.equal(f.toast(), toast);
    assert.equal(animation.currentTime, 5000);
    assert.equal(animation.playState, "paused");
    f.hide(true);
    f.focus(true);
    await f.advance(60000);
    assert.equal(f.toast(), toast, "focus alone cannot resume a hidden document");
    assert.equal(animation.currentTime, 5000);
    f.hide(false);
    await f.advance(14999);
    assert.equal(f.toast(), toast);
    assert.equal(animation.currentTime, 19999);
    await f.advance(1);
    assert.equal(f.toast(), null);
    assert.equal(animation.playState, "idle");
    f.focus(false);
    f.focus(true);
    await f.advance(30000);
    assert.deepEqual(
        f.messages.map((message) => message.action),
        ["claim", "commit"]
    );
});

test("temporary tab hiding preserves the notice without counting hidden time", async (t) => {
    const f = fixture(t);
    await f.advance(2000);
    const toast = f.toast();
    assert.ok(toast, "the notice must be visible before the tab is hidden");
    await f.advance(7000);
    f.hide(true);
    await f.advance(60000);
    assert.equal(f.toast(), toast);
    assert.equal(f.timers.size, 0);
    f.hide(false);
    await f.advance(12999);
    assert.equal(f.toast(), toast);
    await f.advance(1);
    assert.equal(f.toast(), null);
});

test("losing window focus during commit cancels the staged notice and ignores late approval", async (t) => {
    const f = fixture(t, { deferred: true });
    await f.advance(2000);
    const claim = f.pending.shift();
    claim.callback(claim.response);
    await f.flush();
    const commit = f.pending.shift();
    assert.equal(commit.message.action, "commit");
    assert.ok(f.toast().hasAttribute("inert"));
    f.focus(false);
    assert.equal(f.toast(), null);
    commit.callback(commit.response);
    await f.flush();
    f.focus(true);
    await f.advance(30000);
    assert.equal(f.toast(), null);
    assert.deepEqual(
        f.messages.map((message) => message.action),
        ["claim", "commit"]
    );
});

test("hidden, inactive, fullscreen and editable focus delay the initial claim", async (t) => {
    const f = fixture(t);
    f.hide(true);
    await f.advance(30000);
    assert.equal(f.messages.length, 0);
    f.hide(false);
    f.focus(false);
    await f.advance(30000);
    assert.equal(f.messages.length, 0);
    f.focus(true);
    f.fullscreen(true);
    await f.advance(30000);
    assert.equal(f.messages.length, 0);
    f.fullscreen(false);
    f.doc.querySelector("textarea").focus();
    await f.advance(30000);
    assert.equal(f.messages.length, 0);
    f.doc.getElementById("outside").focus();
    await f.advance(2000);
    assert.ok(f.toast());
});

test("cancelled claims release their token and a late commit never remounts after SPA", async (t) => {
    const f = fixture(t, { deferred: true });
    await f.advance(2000);
    f.hide(true);
    const claim = f.pending.shift();
    claim.callback(claim.response);
    await f.flush();
    assert.equal(f.pending[0].message.action, "release");
    f.pending.shift().callback({ ok: true, show: false });
    await f.flush();
    assert.equal(f.toast(), null);
    f.hide(false);
    await f.advance(2000);
    const nextClaim = f.pending.shift();
    nextClaim.callback(nextClaim.response);
    await f.flush();
    assert.equal(f.pending[0].message.action, "commit");
    f.route();
    f.pending.shift().callback({ ok: true, show: true });
    await f.flush();
    await f.advance(30000);
    assert.equal(f.toast(), null);
});

test("denied and uncertain responses do not retry in a busy loop", async (t) => {
    const f = fixture(t, { deferred: true });
    await f.advance(2000);
    f.pending.shift().callback({ ok: true, show: false });
    await f.flush();
    for (let i = 0; i < 4; i++) {
        f.focus(false);
        f.focus(true);
        f.route();
        await f.advance(30000);
    }
    assert.equal(f.messages.length, 1);
});

test("OFF cancels automatic UI but trusted manual replay remains available and validates sender/version", async (t) => {
    const f = fixture(t);
    await f.advance(2000);
    assert.ok(f.toast());
    f.options({ updateGuideEnabled: false });
    assert.equal(f.toast(), null);
    assert.equal(f.replay({ sender: { id: "other", url: "chrome-extension://other/options.html" } })?.ok, false);
    assert.equal(f.replay({ sender: { id: f.runtime.id, url: "https://chzzk.naver.com/options.html" } })?.ok, false);
    assert.equal(f.replay({ guideVersion: "1.3.7" })?.ok, false);
    assert.equal(f.replay()?.ok, true);
    assert.ok(f.doc.querySelector("[data-bcug-view]"));
    f.options({ updateGuideEnabled: false });
    assert.ok(f.doc.querySelector("[data-bcug-view]"));
    f.fullscreen(true);
    assert.equal(f.doc.querySelector("[data-bcug-view]"), null);
});

test("repeated injection keeps one listener and unsupported versions never borrow newer cards", async (t) => {
    const f = fixture(t);
    f.inject();
    f.inject();
    assert.equal(f.listeners.size, 1);
    await f.advance(2000);
    assert.equal(f.doc.querySelectorAll("[data-bcug-toast]").length, 1);
    const toast = f.toast();
    f.hide(true);
    assert.equal(f.toast(), toast);
    assert.equal(f.timers.size, 0);
    f.hide(false);
    f.fullscreen(true);
    assert.equal(f.toast(), null);
    assert.equal(f.timers.size, 0);
    const unsupported = fixture(t, { version: "1.4.0" });
    await unsupported.advance(30000);
    assert.equal(unsupported.messages.length, 0);
    assert.equal(unsupported.toast(), null);
    assert.notEqual(unsupported.replay()?.ok, true);
});

test("manual replay stays open across window and tab switches until explicitly closed", async (t) => {
    const f = fixture(t, { options: { updateGuideEnabled: false } });
    f.focus(false);
    assert.equal(f.replay()?.ok, true);
    assert.equal(f.doc.querySelector('[data-bcug-action="settings"]'), null);
    assert.equal(f.messages.filter((message) => message.action === "open-settings").length, 0);
    f.focus(true);
    const view = f.doc.querySelector("[data-bcug-view]");
    assert.ok(view);
    f.focus(false);
    f.hide(true);
    await f.advance(60000);
    assert.equal(f.doc.querySelector("[data-bcug-view]"), view);
    f.hide(false);
    f.focus(true);
    assert.equal(f.doc.querySelector("[data-bcug-view]"), view);
    view.querySelector("button").click();
    assert.equal(f.doc.querySelector("[data-bcug-view]"), null);
});

test("initial OFF is not replayed automatically when enabled later", async (t) => {
    const f = fixture(t, { options: { updateGuideEnabled: false } });
    await f.advance(30000);
    f.options({ updateGuideEnabled: true });
    await f.advance(30000);
    assert.equal(f.messages.length, 0);
    assert.equal(f.toast(), null);
    assert.equal(f.replay()?.ok, true);
});

test("automatic notice waits for room before consuming a claim at 320px and respects visible input", async (t) => {
    const f = fixture(t);
    Object.defineProperty(f.win, "innerWidth", { configurable: true, value: 320 });
    const video = f.doc.createElement("video");
    video.getBoundingClientRect = () => ({ left: 0, right: 320, top: 60, bottom: 360, width: 320, height: 300 });
    f.doc.body.append(video);
    await f.advance(2000);
    assert.equal(f.toast(), null);
    assert.equal(f.messages.length, 0);
    await f.advance(30000);
    assert.equal(f.messages.length, 0, "no unbounded layout retry");
    video.remove();
    const input = f.doc.querySelector("textarea");
    input.getBoundingClientRect = () => ({ left: 12, right: 308, top: 100, bottom: 200, width: 296, height: 100 });
    f.win.dispatchEvent(new f.win.Event("resize"));
    await f.advance(2000);
    assert.equal(f.messages.length, 0);
    input.remove();
    f.win.dispatchEvent(new f.win.Event("resize"));
    await f.advance(2000);
    assert.ok(f.toast());
    assert.equal(f.toast().style.width, "296px");
    assert.equal(f.toast().style.left, "12px");
    assert.deepEqual(
        f.messages.map((message) => message.action),
        ["claim", "commit"]
    );
});

test("an uncertain commit response never reveals the staged notice or retries", async (t) => {
    const f = fixture(t, { deferred: true });
    await f.advance(2000);
    assert.equal(f.toast().style.visibility, "hidden");
    f.pending.shift().callback({ ok: true, show: false, token: "a-token" });
    await f.flush();
    assert.equal(f.toast().style.visibility, "hidden");
    f.pending.shift().callback(undefined);
    await f.flush();
    assert.equal(f.toast(), null);
    f.route();
    await f.advance(30000);
    assert.equal(f.messages.length, 2);
});

test("OFF while claim is pending releases its reservation and manual replay still expires", async (t) => {
    const f = fixture(t, { deferred: true });
    await f.advance(2000);
    f.options({ updateGuideEnabled: false });
    f.pending.shift().callback({ ok: true, show: false, token: "pending-token" });
    await f.flush();
    assert.equal(f.pending[0].message.action, "release");
    assert.equal(f.pending[0].message.token, "pending-token");
    f.pending.shift().callback({ ok: true, show: false });
    await f.flush();
    assert.equal(f.toast(), null);
    f.options({ updateGuideEnabled: true });
    await f.advance(30000);
    assert.equal(f.messages.length, 2);
    assert.equal(f.replay()?.ok, true);
    f.options({ updateGuideEnabled: false });
    await f.advance(19999);
    assert.ok(f.doc.querySelector("[data-bcug-view]"));
    await f.advance(1);
    assert.equal(f.doc.querySelector("[data-bcug-view]"), null);
    f.route();
    assert.equal(f.doc.querySelector("[data-bcug-view]"), null);
    assert.equal(f.timers.size, 0);
});

test("geometry becoming obstructed during claim releases before consumption", async (t) => {
    const f = fixture(t, { deferred: true });
    await f.advance(2000);
    // A narrower notice can fit beside the video; this visible input covers every candidate position.
    const input = f.doc.querySelector("textarea");
    input.getBoundingClientRect = () => ({ left: 0, right: 1024, top: 64, bottom: 300, width: 1024, height: 236 });
    const claim = f.pending.shift();
    claim.callback(claim.response);
    await f.flush();
    assert.equal(f.pending[0].message.action, "release");
    f.pending.shift().callback({ ok: true, show: false });
    await f.flush();
    await f.advance(30000);
    assert.equal(
        f.messages.some((message) => message.action === "commit"),
        false
    );
    assert.equal(f.toast(), null);
});

test("real worker protocol consumes an upgrade once and a second document cannot display it", async (t) => {
    const first = fixture(t),
        second = fixture(t),
        local = {};
    const chrome = {
        runtime: first.runtime,
        storage: {
            local: {
                get: (key, cb) => cb(Object.hasOwn(local, key) ? { [key]: local[key] } : {}),
                set: (value, cb) => {
                    Object.assign(local, value);
                    cb();
                },
            },
            sync: { get: (_key, cb) => cb({ updateGuideEnabled: true }) },
        },
    };
    evalRepoScript({ window: first.win }, "shared/updateGuideController.js");
    const catalog = first.win.BetterChzzkUpdateGuide;
    const controller = first.win.BetterChzzkUpdateGuideController.createController({ chrome, catalog });
    await controller.onInstalled({ reason: "update", previousVersion: "1.4.0" });
    assert.equal(local[catalog.STORAGE_KEY].status, "pending");
    for (const [index, f] of [first, second].entries()) {
        f.runtime.sendMessage = (message, callback) => {
            f.messages.push(message);
            void controller
                .handleMessage(message, {
                    id: first.runtime.id,
                    tab: { id: index + 1, active: true },
                    frameId: 0,
                    documentId: `document-${index}`,
                    documentLifecycle: "active",
                    url: f.win.location.href,
                })
                .then(callback);
        };
    }
    await first.advance(2000);
    for (let i = 0; i < 10 && first.toast()?.style.visibility !== ""; i++) await first.flush();
    assert.equal(local[catalog.STORAGE_KEY].status, "seen");
    assert.ok(first.toast());
    assert.equal(first.toast().style.visibility, "");
    await second.advance(2000);
    for (let i = 0; i < 10 && second.toast(); i++) await second.flush();
    assert.equal(second.toast(), null);
    await first.advance(19999);
    assert.ok(first.toast());
    await first.advance(1);
    assert.equal(first.toast(), null);
});

test("BFCache restores pending automatic preparation once and preserves the replay receiver", async (t) => {
    const f = fixture(t);
    await f.advance(1000);
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pagehide", { persisted: true }));
    assert.equal(f.listeners.size, 1);
    assert.equal(f.replay()?.ok, false, "a cached document must not open UI");
    f.focus(true);
    f.route();
    await f.advance(30000);
    assert.equal(f.messages.length, 0);
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pageshow", { persisted: true }));
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pageshow", { persisted: true }));
    f.inject();
    assert.equal(f.listeners.size, 1);
    assert.equal(f.timers.size, 1);
    await f.advance(2000);
    assert.deepEqual(
        f.messages.map((message) => message.action),
        ["claim", "commit"]
    );
    assert.ok(f.toast());
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pagehide", { persisted: true }));
    assert.equal(f.toast(), null);
    assert.equal(f.timers.size, 0);
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pageshow", { persisted: true }));
    await f.advance(30000);
    assert.equal(f.messages.length, 2, "consumed automatic UI is not restored");
    assert.equal(f.replay()?.ok, true);
    assert.ok(f.doc.querySelector("[data-bcug-view]"));
});

test("OFF during BFCache survives restoration while manual replay stays usable", async (t) => {
    const f = fixture(t);
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pagehide", { persisted: true }));
    f.options({ updateGuideEnabled: false });
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pageshow", { persisted: true }));
    f.options({ updateGuideEnabled: true });
    await f.advance(30000);
    assert.equal(f.messages.length, 0);
    assert.equal(f.replay()?.ok, true);
    f.options({ updateGuideEnabled: false });
    assert.ok(f.doc.querySelector("[data-bcug-view]"), "the preserved option listener does not close manual UI");
    f.route();
    assert.equal(f.doc.querySelector("[data-bcug-view]"), null);
});

test("BFCache releases late unconsumed claims and resumes with a fresh reservation", async (t) => {
    const f = fixture(t, { deferred: true });
    await f.advance(2000);
    const oldClaim = f.pending.shift();
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pagehide", { persisted: true }));
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pageshow", { persisted: true }));
    oldClaim.callback(oldClaim.response);
    await f.flush();
    assert.equal(f.pending[0].message.action, "release");
    f.pending.shift().callback({ ok: true, show: false });
    await f.flush();
    assert.equal(f.toast(), null);
    await f.advance(2000);
    const nextClaim = f.pending.shift();
    assert.equal(nextClaim.message.action, "claim");
    nextClaim.callback({ ok: true, show: false, token: "fresh-reservation" });
    await f.flush();
    assert.equal(f.pending[0].message.token, "fresh-reservation");
    f.pending.shift().callback({ ok: true, show: true });
    await f.flush();
    assert.ok(f.toast());
    assert.equal(f.toast().style.visibility, "");
});

test("a late commit after BFCache stays consumed and normal unload or explicit stop never resumes", async (t) => {
    const f = fixture(t, { deferred: true });
    await f.advance(2000);
    const claim = f.pending.shift();
    claim.callback(claim.response);
    await f.flush();
    const commit = f.pending.shift();
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pagehide", { persisted: true }));
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pageshow", { persisted: true }));
    commit.callback({ ok: true, show: true });
    await f.flush();
    await f.advance(30000);
    assert.equal(f.toast(), null);
    assert.equal(f.messages.length, 2);
    assert.equal(f.replay()?.ok, true);
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pagehide", { persisted: false }));
    assert.equal(f.listeners.size, 0);
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pageshow", { persisted: true }));
    assert.equal(f.replay(), undefined);
    assert.equal(f.timers.size, 0);

    const stopped = fixture(t);
    stopped.win.dispatchEvent(new stopped.win.PageTransitionEvent("pagehide", { persisted: true }));
    stopped.win.BetterChzzk.updateGuide.stop();
    stopped.win.dispatchEvent(new stopped.win.PageTransitionEvent("pageshow", { persisted: true }));
    await stopped.advance(30000);
    assert.equal(stopped.listeners.size, 0);
    assert.equal(stopped.messages.length, 0);
});
