const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
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
    const reloads = [];
    const trace = [];
    const observers = [];
    t.after(() => {
        for (const observer of observers) observer.disconnect();
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

    function loadChatFix() {
        // Run the whole isolated script; only the browser navigation boundary is intercepted.
        vm.runInNewContext(readFeature("vodReplayChatFix.js"), {
            window: w,
            document: w.document,
            HTMLVideoElement: w.HTMLVideoElement,
            HTMLMediaElement: w.HTMLMediaElement,
            Element: w.Element,
            Date: w.Date,
            URL: w.URL,
            performance: w.performance,
            sessionStorage: w.sessionStorage,
            setTimeout: w.setTimeout,
            clearTimeout: w.clearTimeout,
            location: {
                get href() {
                    return w.location.href;
                },
                get pathname() {
                    return w.location.pathname;
                },
                replace(href) {
                    reloads.push(href);
                },
            },
            BetterChzzk: {
                utils: {
                    onReady: (callback) => callback(),
                    getMainVideoElement: () => video,
                    startPageChangeDetection(callback) {
                        w.addEventListener("betterchzzk:routechange", callback);
                        return () => w.removeEventListener("betterchzzk:routechange", callback);
                    },
                    createMutationObserverSync({ onMutations, onBodyReady }) {
                        const observer = new w.MutationObserver(onMutations);
                        observers.push(observer);
                        observer.observe(w.document.body, { childList: true, subtree: true });
                        onBodyReady();
                        return observer;
                    },
                },
            },
        });
    }

    function rememberResume(seconds = 12, href = w.location.href) {
        w.sessionStorage.setItem(RESUME_KEY, JSON.stringify({ href, seconds, at: w.Date.now() }));
    }

    return {
        w,
        dom,
        video,
        writes,
        reloads,
        trace,
        advance,
        flush,
        navigate,
        media,
        loadQuality,
        loadChatFix,
        requestQuality,
        setQualityState,
        rememberResume,
        setReady: (value) => {
            readyState = value;
        },
        resetTrack: () => {
            trackIndex = 0;
        },
    };
}

test("closed native replay chat is not a missing-chat reload condition", async (t) => {
    const f = fixture(t, { url: "https://chzzk.naver.com/channel/test", time: 12 });
    f.loadChatFix();
    f.navigate("/video/123");
    await f.advance(23000);
    assert.deepEqual(f.reloads, []);
    assert.equal(f.w.sessionStorage.getItem("betterchzzk:vod-chat-reload:/video/123"), null);
});

test("an unready video and missing heading cannot trigger replay chat reload", async (t) => {
    const f = fixture(t, { url: "https://chzzk.naver.com/channel/test", time: 12, ready: 0 });
    f.loadChatFix();
    f.navigate("/video/123");
    f.w.document.body.insertAdjacentHTML("beforeend", '<aside id="vod-aside"></aside>');
    await f.advance(23000);
    assert.deepEqual(f.reloads, []);
});

test("a verified open replay panel reload preserves the URL and records one disposable position", async (t) => {
    const f = fixture(t, { url: "https://chzzk.naver.com/channel/test", time: 12 });
    f.loadChatFix();
    f.navigate("/video/123?from=channel#chat");
    f.w.document.body.insertAdjacentHTML("beforeend", '<aside id="vod-aside"></aside>');
    await f.advance(23000);
    assert.deepEqual(f.reloads, ["https://chzzk.naver.com/video/123?from=channel#chat"]);
    const pending = JSON.parse(f.w.sessionStorage.getItem(RESUME_KEY));
    assert.equal(pending.seconds, 12);
    assert.equal(pending.href, f.reloads[0]);
    assert.equal(f.w.location.search.includes("currentTime"), false);
});

for (const quality of [false, true]) {
    test(`one-time replay restoration is consumed after success, auto quality ${quality}`, async (t) => {
        const f = fixture(t, { time: 900, quality });
        f.rememberResume();
        f.loadQuality();
        f.loadChatFix();
        f.media("play");
        f.media("playing");
        await f.advance(800);
        assert.equal(f.video.currentTime, 12);
        assert.equal(f.w.sessionStorage.getItem(RESUME_KEY), null);
        assert.equal(f.w.location.href, "https://chzzk.naver.com/video/123");
        f.media("timeupdate", 600);
        f.setQualityState(true);
        f.requestQuality();
        await f.advance(12000);
        assert.equal(f.video.currentTime, 600);
        assert.deepEqual(f.writes, [12]);
    });
}

test("repeat reload and reopening use the next native position after disposable state was consumed", async (t) => {
    const first = fixture(t, { time: 900 });
    first.rememberResume();
    first.loadChatFix();
    first.media("playing");
    await first.advance(800);
    assert.equal(first.w.sessionStorage.getItem(RESUME_KEY), null);
    for (const nativePosition of [600, 750, 900]) {
        const next = fixture(t, { time: nativePosition });
        next.loadQuality();
        next.loadChatFix();
        next.media("play");
        next.media("playing");
        await next.advance(12000);
        assert.equal(next.video.currentTime, nativePosition);
        assert.deepEqual(next.writes, []);
    }
});

test("late media initialization waits for playback before consuming a disposable position", async (t) => {
    const f = fixture(t, { ready: 0 });
    f.rememberResume(600);
    f.loadChatFix();
    await f.advance(4000);
    assert.deepEqual(f.writes, []);
    assert.ok(f.w.sessionStorage.getItem(RESUME_KEY));
    f.setReady(4);
    f.media("loadedmetadata");
    f.media("play", 900);
    f.media("playing");
    await f.advance(800);
    assert.equal(f.video.currentTime, 600);
    assert.equal(f.w.sessionStorage.getItem(RESUME_KEY), null);
});

test("user navigation while restoration is pending discards it", async (t) => {
    const f = fixture(t, { ready: 0 });
    f.rememberResume(600);
    f.loadChatFix();
    f.w.dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    f.setReady(4);
    f.media("playing", 300);
    await f.advance(12000);
    assert.equal(f.video.currentTime, 300);
    assert.deepEqual(f.writes, []);
    assert.equal(f.w.sessionStorage.getItem(RESUME_KEY), null);
});

test("disposable state cannot restore on another VOD or after backward/forward route changes", async (t) => {
    const f = fixture(t, { ready: 0 });
    f.rememberResume(600);
    f.loadChatFix();
    f.navigate("/video/456");
    f.navigate("/video/123");
    f.setReady(4);
    f.media("playing", 900);
    await f.advance(12000);
    assert.equal(f.video.currentTime, 900);
    assert.deepEqual(f.writes, []);
    assert.equal(f.w.sessionStorage.getItem(RESUME_KEY), null);
});

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

test("the actual replay reload handoff leaves subsequent native checkpoints free to advance", async (t) => {
    const source = fixture(t, { url: "https://chzzk.naver.com/channel/test", time: 12 });
    source.loadChatFix();
    source.navigate("/video/123");
    source.w.document.body.insertAdjacentHTML("beforeend", '<aside id="vod-aside"></aside>');
    await source.advance(23000);
    const reloaded = fixture(t, { url: source.reloads[0], time: 900, clockOffset: 23000 });
    reloaded.w.sessionStorage.setItem(RESUME_KEY, source.w.sessionStorage.getItem(RESUME_KEY));
    reloaded.loadQuality();
    reloaded.loadChatFix();
    reloaded.media("play");
    reloaded.media("playing");
    await reloaded.advance(800);
    assert.equal(reloaded.video.currentTime, 12);
    assert.equal(reloaded.w.sessionStorage.getItem(RESUME_KEY), null);
    reloaded.media("timeupdate", 600);
    const checkpoint = { positionAt: reloaded.video.currentTime };
    // This is an input/output model, not a captured authenticated watch-event request.
    const next = fixture(t, { url: reloaded.w.location.href, time: checkpoint.positionAt });
    next.loadQuality();
    next.media("play");
    next.media("playing");
    await next.advance(12000);
    assert.equal(next.video.currentTime, 600);
    assert.deepEqual(next.writes, []);
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

test("disposable restore tolerates a missed playing event and manual play", async (t) => {
    const f = fixture(t, { time: 900 });
    f.rememberResume(600);
    f.loadChatFix();
    f.video.dispatchEvent(new f.w.MouseEvent("mousedown", { bubbles: true }));
    f.media("timeupdate", 901);
    await f.advance(800);
    assert.equal(f.video.currentTime, 600);
    assert.equal(f.w.sessionStorage.getItem(RESUME_KEY), null);
});

for (const record of [
    { href: "https://chzzk.naver.com/video/456", seconds: 600, at: Date.parse("2026-10-01T12:00:00+09:00") },
    { href: "https://chzzk.naver.com/video/123", seconds: 600, at: 1 },
    { href: "https://chzzk.naver.com/video/123", seconds: 600, at: "1790823600001" },
    { href: "https://chzzk.naver.com/video/123", seconds: 20000, at: Date.parse("2026-10-01T12:00:00+09:00") },
]) {
    test(`invalid or expired disposable state never writes a position: ${JSON.stringify(record)}`, async (t) => {
        const f = fixture(t, { time: 900 });
        f.w.sessionStorage.setItem(RESUME_KEY, JSON.stringify(record));
        f.loadChatFix();
        f.media("playing");
        await f.advance(800);
        assert.equal(f.video.currentTime, 900);
        assert.deepEqual(f.writes, []);
        assert.equal(f.w.sessionStorage.getItem(RESUME_KEY), null);
    });
}

test("storage failure refuses a recovery reload instead of producing a sticky URL", async (t) => {
    const f = fixture(t, { url: "https://chzzk.naver.com/channel/test", time: 12 });
    f.w.Storage.prototype.setItem = () => {
        throw new Error("unavailable");
    };
    f.loadChatFix();
    f.navigate("/video/123");
    f.w.document.body.insertAdjacentHTML("beforeend", '<aside id="vod-aside"></aside>');
    await f.advance(23000);
    assert.deepEqual(f.reloads, []);
    assert.equal(f.w.location.search, "");
});

for (const seconds of [0, 12]) {
    test(`an explicit user timecode ${seconds} never becomes a disposable chat position`, async (t) => {
        const f = fixture(t, { url: "https://chzzk.naver.com/channel/test", time: 900 });
        f.loadChatFix();
        f.navigate(`/video/123?currentTime=${seconds}`);
        f.w.document.body.insertAdjacentHTML("beforeend", '<aside id="vod-aside"></aside>');
        await f.advance(23000);
        assert.deepEqual(f.reloads, [`https://chzzk.naver.com/video/123?currentTime=${seconds}`]);
        assert.equal(f.w.sessionStorage.getItem(RESUME_KEY), null);
    });
}
