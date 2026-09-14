const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const source = fs.readFileSync(path.join(__dirname, "../features/streamInfo.js"), "utf8");
const tracks = [{ videoWidth: 1920, videoHeight: 1080, videoBitRate: 8192000 }];
const response = (items = tracks) => ({
    content: { status: "OPEN", livePlaybackJson: JSON.stringify({ media: [{ encodingTrack: items }] }) },
});

function fixture(t, fetcher = async () => response()) {
    const dom = new JSDOM('<div class="pzp-pc"><video></video><div class="pzp-pc__bottom-buttons-right"></div></div>', {
        url: "https://chzzk.naver.com/live/test",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    const doc = w.document;
    let apply, route, mutations;
    let now = 0;
    let total = 100,
        dropped = 2;
    const timers = new Set();
    const requests = [];
    w.setInterval = (callback) => {
        timers.add(callback);
        return callback;
    };
    w.clearInterval = (callback) => timers.delete(callback);
    w.performance.now = () => now;
    const video = doc.querySelector("video");
    w.HTMLCanvasElement.prototype.getContext = () => null;
    const range = (items) => ({ length: items.length, start: (i) => items[i][0], end: (i) => items[i][1] });
    for (const [key, value] of Object.entries({
        videoWidth: 1920,
        videoHeight: 1080,
        paused: false,
        readyState: 4,
        currentTime: 95,
        buffered: range([[90, 99]]),
        seekable: range([[80, 100]]),
    }))
        Object.defineProperty(video, key, { configurable: true, value, writable: true });
    video.getVideoPlaybackQuality = () => ({ totalVideoFrames: total, droppedVideoFrames: dropped });
    w.BetterChzzk = {
        utils: {
            bindFeatureOptions(fn) {
                apply = fn;
                fn({ streamInfoEnabled: true });
            },
            getMainVideoElement: () => doc.querySelector("video"),
            getPlayerRoot: (v) => v?.closest(".pzp-pc"),
            isPlaybackRoute: () => /^\/(live|video)\//.test(w.location.pathname),
            isLiveRoute: () => w.location.pathname.startsWith("/live/"),
            startPageChangeDetection(fn) {
                route = fn;
                return () => {
                    route = null;
                };
            },
            createMutationObserverSync({ onMutations }) {
                mutations = onMutations;
                return {
                    disconnectAll() {
                        mutations = null;
                    },
                };
            },
            mutationMatchesSelector: (m, s) =>
                [...m.addedNodes, ...m.removedNodes].some((n) => n.matches?.(s) || n.querySelector?.(s)),
            injectStyleOnce(id, css) {
                if (doc.getElementById(id)) return;
                const style = doc.createElement("style");
                style.id = id;
                style.textContent = css;
                doc.head.append(style);
            },
            fetchJson(url, options) {
                requests.push({ url, ...options });
                return fetcher(url, options);
            },
        },
    };
    w.eval(source);
    t.after(() => {
        apply({ streamInfoEnabled: false });
        dom.window.close();
    });
    return {
        w,
        doc,
        video,
        timers,
        requests,
        apply: (on) => apply({ streamInfoEnabled: on }),
        open: () => doc.getElementById("betterchzzk-stream-info-button").click(),
        text: () => doc.getElementById("betterchzzk-stream-info")?.textContent,
        route: (url) => {
            w.history.replaceState(null, "", url);
            route?.();
        },
        mutate: (addedNodes = [], removedNodes = []) => mutations?.([{ addedNodes, removedNodes }]),
        tick: (frames = 60, drops = 0) => {
            now += 1000;
            total += frames;
            dropped += drops;
            for (const fn of timers) fn();
        },
        hide: (hidden) => {
            Object.defineProperty(doc, "hidden", { configurable: true, value: hidden });
            doc.dispatchEvent(new w.Event("visibilitychange"));
        },
    };
}

test("stream button follows native controls visibility and uses the native SVG icon container", (t) => {
    const f = fixture(t);
    const button = f.doc.getElementById("betterchzzk-stream-info-button");
    const player = f.doc.querySelector(".pzp-pc");
    const nativeStyle = f.doc.createElement("style");
    nativeStyle.textContent = ".pzp-button{transition:opacity .2s ease-in}";
    f.doc.head.prepend(nativeStyle);
    assert.equal(f.w.getComputedStyle(button).transition, "opacity .2s ease-in");
    assert.equal(button.querySelector(".pzp-ui-icon__svg").getAttribute("viewBox"), "0 0 36 36");
    assert.equal(button.querySelector("svg").getAttribute("aria-hidden"), "true");
    assert.equal(button.querySelector(".pzp-button__tooltip").textContent, "스트림 정보");
    assert.equal(f.w.getComputedStyle(button).opacity, "0");
    assert.equal(f.w.getComputedStyle(button).pointerEvents, "none");
    for (const theme of ["", "theme_dark"]) {
        f.doc.documentElement.className = theme;
        player.classList.add("pzp-pc--controls");
        assert.equal(f.w.getComputedStyle(button).opacity, "1");
        assert.equal(f.w.getComputedStyle(button).pointerEvents, "auto");
        player.classList.remove("pzp-pc--controls");
        assert.equal(f.w.getComputedStyle(button).opacity, "0");
        player.classList.add("pzp-pc--dialog");
        assert.equal(f.w.getComputedStyle(button).display, "none");
        player.classList.remove("pzp-pc--dialog");
    }
});

test("panel is on-demand and shows measured dimensions, declared bitrate, live lag, buffer and frame load", async (t) => {
    const f = fixture(t);
    assert.equal(f.requests.length, 0);
    assert.equal(f.timers.size, 0);
    f.open();
    await new Promise(setImmediate);
    assert.match(f.text(), /1920 × 1080/);
    assert.match(f.text(), /8,192 kbps/);
    assert.match(f.text(), /5\.00초/);
    assert.match(f.text(), /4\.00초/);
    f.tick(60, 3);
    assert.match(f.text(), /57\.0 FPS/);
    const labels = Array.from(f.doc.querySelectorAll("#betterchzzk-stream-info dt"), (element) => element.textContent);
    assert.ok(labels.includes("FPS"));
    assert.doesNotMatch(f.text(), /누적|드롭|출력 프레임|Mbps/);
    assert.match(f.text(), /하드웨어 가속확인 불가/);
    assert.equal(f.requests.length, 1);
    assert.equal(f.timers.size, 1);
    f.doc
        .getElementById("betterchzzk-stream-info")
        .dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(f.text(), undefined);
    assert.equal(f.timers.size, 0);
    assert.equal(f.doc.activeElement.id, "betterchzzk-stream-info-button");
});

test("ambiguous bitrate and unavailable frame APIs are not invented; quality switches update values", async (t) => {
    const f = fixture(t, async () => response([...tracks, { ...tracks[0], videoBitRate: 6000000 }]));
    f.video.getVideoPlaybackQuality = undefined;
    f.open();
    await new Promise(setImmediate);
    assert.doesNotMatch(f.text(), /kbps|\d+\.\d+ FPS/);
    assert.match(f.text(), /측정 불가/);
    f.video.videoWidth = 1280;
    f.video.videoHeight = 720;
    f.tick();
    assert.match(f.text(), /1280 × 720/);
    assert.doesNotMatch(f.text(), /kbps/);
});

test("closing, disabling, visibility, navigation and stale requests clean up without changing playback", async (t) => {
    let resolve;
    const f = fixture(
        t,
        () =>
            new Promise((done) => {
                resolve = done;
            })
    );
    f.open();
    f.hide(true);
    assert.equal(f.timers.size, 0);
    assert.equal(f.requests[0].signal.aborted, true);
    resolve(response());
    await new Promise(setImmediate);
    assert.doesNotMatch(f.text(), /8,192/);
    f.hide(false);
    assert.equal(f.timers.size, 1);
    assert.equal(f.requests.length, 2);
    f.route("/video/123");
    assert.equal(f.requests[1].signal.aborted, true);
    assert.equal(f.timers.size, 0);
    f.open();
    assert.match(f.text(), /다시보기 해당 없음/);
    assert.equal(f.requests.length, 2);
    f.apply(false);
    assert.equal(f.doc.querySelector("[id^='betterchzzk-stream-info']"), null);
    assert.equal(f.timers.size, 0);
    f.apply(true);
    f.apply(true);
    assert.equal(f.doc.querySelectorAll("#betterchzzk-stream-info-button").length, 1);
    f.route("/following");
    assert.equal(f.doc.getElementById("betterchzzk-stream-info-button"), null);
    assert.equal(f.video.currentTime, 95);
    assert.equal(f.video.paused, false);
});

test("player controls remount exactly once and source reset closes old statistics", (t) => {
    const f = fixture(t);
    f.open();
    const old = f.doc.querySelector(".pzp-pc__bottom-buttons-right");
    const next = old.cloneNode(false);
    old.replaceWith(next);
    f.mutate([next], [old]);
    f.mutate([next], []);
    assert.equal(f.text(), undefined);
    assert.equal(f.timers.size, 0);
    assert.equal(f.doc.querySelectorAll("#betterchzzk-stream-info-button").length, 1);
    f.open();
    f.video.dispatchEvent(new f.w.Event("emptied"));
    assert.equal(f.text(), undefined);
    assert.equal(f.timers.size, 0);
});

test("graphics diagnostics distinguish software, GPU inference and unavailable data and release each probe", (t) => {
    const f = fixture(t);
    let probes = 0;
    let releases = 0;
    let renderer = "ANGLE (NVIDIA GeForce, D3D11)";
    let unavailable = false;
    let throws = false;
    f.w.HTMLCanvasElement.prototype.getContext = () => {
        probes++;
        return {
            getExtension(name) {
                if (name === "WEBGL_lose_context")
                    return {
                        loseContext() {
                            releases++;
                        },
                    };
                return unavailable ? null : { UNMASKED_RENDERER_WEBGL: 37446 };
            },
            getParameter() {
                if (throws) throw new Error("restricted");
                return renderer;
            },
        };
    };
    assert.equal(probes, 0);
    for (const [name, expected] of [
        [renderer, "사용 중"],
        ["ANGLE (Google, Vulkan SwiftShader Device)", "미사용 (소프트웨어)"],
        ["llvmpipe (LLVM)", "미사용 (소프트웨어)"],
        ["Microsoft Basic Render Driver", "미사용 (소프트웨어)"],
        ["", "확인 불가"],
    ]) {
        renderer = name;
        f.open();
        const term = Array.from(f.doc.querySelectorAll("dt")).find(
            (element) => element.textContent === "하드웨어 가속"
        );
        assert.equal(term.nextElementSibling.textContent, expected);
        assert.match(term.nextElementSibling.title, /WebGL/);
        f.tick();
        assert.equal(probes, releases);
        f.open();
    }
    assert.equal(probes, 5);
    unavailable = true;
    f.open();
    assert.match(f.text(), /하드웨어 가속확인 불가/);
    f.open();
    unavailable = false;
    throws = true;
    f.open();
    assert.match(f.text(), /하드웨어 가속확인 불가/);
    assert.equal(probes, 7);
    assert.equal(releases, 7);
});

test("metadata failure preserves core metrics and buffering uses the current range", async (t) => {
    const f = fixture(t, async () => {
        throw new Error("offline");
    });
    f.video.buffered = { length: 2, start: (i) => [10, 100][i], end: (i) => [20, 110][i] };
    f.open();
    await new Promise(setImmediate);
    assert.match(f.text(), /정보 조회 실패/);
    assert.match(f.text(), /1920 × 1080/);
    assert.match(f.text(), /현재 위치에 버퍼 없음/);
    f.w.dispatchEvent(new f.w.Event("pagehide"));
    assert.equal(f.timers.size, 0);
    f.w.dispatchEvent(new f.w.Event("pageshow"));
    assert.equal(f.doc.querySelectorAll("#betterchzzk-stream-info-button").length, 1);
});
