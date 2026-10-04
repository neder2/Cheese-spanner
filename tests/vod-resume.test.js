const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const readFeature = (name) => fs.readFileSync(path.join(__dirname, "../features", name), "utf8");
const RESUME_KEY = "betterchzzk:vod-chat-resume";

function fixture(
    t,
    {
        url = "https://chzzk.naver.com/video/123",
        time = 0,
        ready = 4,
        quality = true,
        resetOnQuality = false,
        clockOffset = 0,
    } = {}
) {
    const dom = new JSDOM("<!doctype html><body><main><video></video></main></body>", {
        url,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    const video = w.document.querySelector("video");
    const timers = new Map();
    const writes = [];
    const trace = [];
    t.after(() => {
        setQualityState(false);
        timers.clear();
        dom.window.close();
    });
    const epoch = Date.parse("2026-10-01T12:00:00+09:00");
    let now = 1 + clockOffset;
    let nextTimer = 1;
    let position = time;
    let readyState = ready;
    let paused = false;
    w.setTimeout = (callback, delay = 0) => {
        const id = nextTimer++;
        timers.set(id, { callback, at: now + delay });
        return id;
    };
    w.clearTimeout = (id) => timers.delete(id);
    Object.defineProperty(w.performance, "now", { value: () => now });
    w.Date.now = () => epoch + now;
    Object.defineProperties(video, {
        currentTime: {
            configurable: true,
            get: () => position,
            set: (value) => {
                position = Number(value);
                writes.push(position);
                trace.push({ type: "extension-seek", position, at: now });
            },
        },
        readyState: { get: () => readyState },
        duration: { get: () => 10000 },
        paused: { get: () => paused },
        seeking: { get: () => false },
    });
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    video.play = () => {
        paused = false;
        return Promise.resolve();
    };
    const tracks = [480, 1080].map((height) => ({ id: String(height), height, label: `${height}p`, kind: "main" }));
    let trackIndex = 1;
    tracks.forEach((track, index) =>
        Object.defineProperty(track, "selected", {
            get: () => trackIndex === index,
            set: (value) => {
                if (value) tracks.selectedIndex = index;
            },
        })
    );
    Object.defineProperty(tracks, "selectedIndex", {
        get: () => trackIndex,
        set: (value) => {
            if (trackIndex === value) return;
            trackIndex = value;
            trace.push({ type: "quality-change", position, at: now });
            if (resetOnQuality) position = 0;
        },
    });
    Object.defineProperty(video, "videoTracks", { configurable: true, get: () => tracks });
    const root = w.document.documentElement;
    const setQualityState = (enabled) => {
        root.setAttribute("data-betterchzzk-auto-quality-state", JSON.stringify({ enabled, quality: "1080p" }));
        w.dispatchEvent(new w.Event("betterchzzk:auto-quality:state"));
    };
    setQualityState(quality);

    async function flush() {
        await Promise.resolve();
        await Promise.resolve();
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

    function media(type, value = position) {
        position = value;
        trace.push({ type, position, at: now });
        video.dispatchEvent(new w.Event(type));
    }

    function navigate(href) {
        w.history.pushState({ native: "preserved" }, "", href);
        w.dispatchEvent(new w.Event("betterchzzk:routechange"));
    }

    function loadQuality() {
        w.eval(readFeature("autoQualityPage.js"));
    }

    function requestQuality() {
        root.setAttribute(
            "data-betterchzzk-auto-quality-request",
            JSON.stringify({ requestId: String(now), quality: "1080p" })
        );
        w.dispatchEvent(new w.Event("betterchzzk:auto-quality:apply"));
    }

    return {
        w,
        dom,
        video,
        writes,
        trace,
        advance,
        flush,
        navigate,
        media,
        loadQuality,
        requestQuality,
        setQualityState,
        setReady: (value) => {
            readyState = value;
        },
        resetTrack: () => {
            trackIndex = 0;
        },
    };
}

for (const query of ["", "?currentTime=0", "?currentTime=12", "?currentTime=600"]) {
    test(`ordinary URL preserves native ownership and the intended link: ${query || "no timecode"}`, async (t) => {
        const f = fixture(t, {
            url: `https://chzzk.naver.com/video/123${query}`,
            time: query ? Number(query.split("=")[1]) : 900,
        });
        f.loadQuality();
        f.media("play");
        f.media("playing");
        await f.advance(2000);
        const target = f.video.currentTime;
        f.media("timeupdate", target + 100);
        f.w.dispatchEvent(new f.w.PageTransitionEvent("pageshow", { persisted: true }));
        f.requestQuality();
        await f.advance(12000);
        assert.equal(f.video.currentTime, target + 100);
        assert.equal(f.w.location.href, `https://chzzk.naver.com/video/123${query}`);
    });
}

test("URL restoration does not rearm after a user seek and a saved quality change", async (t) => {
    const f = fixture(t, { url: "https://chzzk.naver.com/video/123?currentTime=12", time: 12 });
    f.loadQuality();
    f.w.dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    f.media("seeked", 300);
    f.requestQuality();
    await f.advance(12000);
    assert.equal(f.video.currentTime, 300);
    assert.deepEqual(f.writes, []);
    assert.equal(f.w.location.search, "?currentTime=12");
});

test("a comment timecode overrides a pending URL seek without rewriting the link", async (t) => {
    const f = fixture(t, { url: "https://chzzk.naver.com/video/123?currentTime=12", time: 12 });
    f.w.document.body.insertAdjacentHTML("beforeend", '<button id="timecode">5:00</button>');
    f.loadQuality();
    f.w.document.getElementById("timecode").click();
    f.media("seeked", 300);
    await f.advance(12000);
    assert.equal(f.video.currentTime, 300);
    assert.equal(f.w.location.search, "?currentTime=12");
    assert.equal(f.writes.includes(12), false);
});

test("a settled URL intent allows a later quality reset to restore the current position", async (t) => {
    const f = fixture(t, { url: "https://chzzk.naver.com/video/123?currentTime=12", time: 12, resetOnQuality: true });
    f.loadQuality();
    await f.advance(2000);
    f.media("timeupdate", 300);
    f.resetTrack();
    f.requestQuality();
    assert.equal(f.video.currentTime, 0);
    await f.advance(800);
    assert.equal(f.video.currentTime, 300);
    assert.equal(f.trace.filter((row) => row.type === "quality-change").length, 1);
    assert.equal(f.writes.includes(12), false);
});

test("a late native resume wins over an older quality snapshot", async (t) => {
    const f = fixture(t, { time: 2, resetOnQuality: true });
    f.loadQuality();
    f.resetTrack();
    f.requestQuality();
    f.media("seeking", 600);
    f.media("seeked");
    await f.advance(3000);
    assert.equal(f.video.currentTime, 600);
    assert.deepEqual(f.writes, []);
});

test("hash and unrelated query changes do not turn the same timecode into a new seek", async (t) => {
    const f = fixture(t, { url: "https://chzzk.naver.com/video/123?currentTime=12", time: 12 });
    f.loadQuality();
    await f.advance(2000);
    f.media("timeupdate", 300);
    f.navigate("/video/123?currentTime=12&from=chat#comment");
    f.requestQuality();
    await f.advance(12000);
    assert.equal(f.video.currentTime, 300);
    assert.deepEqual(f.writes, []);
});

for (const quality of [false, true]) {
    test(`retired chat resume state cannot override native playback, auto quality ${quality}`, async (t) => {
        const f = fixture(t, { time: 900, quality });
        const legacy = JSON.stringify({ href: f.w.location.href, seconds: 12, at: f.w.Date.now() });
        f.w.sessionStorage.setItem(RESUME_KEY, legacy);
        f.loadQuality();
        f.media("play");
        f.media("playing");
        await f.advance(23000);
        assert.equal(f.video.currentTime, 900);
        assert.deepEqual(f.writes, []);
        f.navigate("/video/456");
        f.media("playing", 600);
        f.requestQuality();
        await f.advance(23000);
        assert.equal(f.video.currentTime, 600);
        assert.deepEqual(f.writes, []);
        assert.equal(f.w.sessionStorage.getItem(RESUME_KEY), legacy);
        assert.equal(f.w.location.href, "https://chzzk.naver.com/video/456");
    });
}
