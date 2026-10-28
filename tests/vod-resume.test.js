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
    const setQualityState = (enabled, preferred = "1080p") => {
        root.setAttribute("data-cheese-spanner-auto-quality-state", JSON.stringify({ enabled, quality: preferred }));
        w.dispatchEvent(new w.Event("cheese-spanner:auto-quality:state"));
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
        w.dispatchEvent(new w.Event("cheese-spanner:routechange"));
    }

    function loadQuality() {
        w.eval(readFeature("autoQualityPage.js"));
    }

    function requestQuality(preferred = "1080p") {
        root.setAttribute(
            "data-cheese-spanner-auto-quality-request",
            JSON.stringify({ requestId: String(now), quality: preferred })
        );
        w.dispatchEvent(new w.Event("cheese-spanner:auto-quality:apply"));
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
    // The later switch comes from saving a different preferred quality; re-sending the same preference
    // after the entry apply is a no-op (see the manual-choice tests below).
    f.setQualityState(true, "480p");
    f.requestQuality("480p");
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

function restoreFixture(
    t,
    {
        url = "https://chzzk.naver.com/video/123",
        played = 1,
        paused = false,
        autoplay = false,
        time = 300,
        switchPausesAndResets = false,
    } = {}
) {
    const dom = new JSDOM('<!doctype html><body><div class="pzp-pc"><video></video></div></body>', {
        url,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    const root = w.document.documentElement;
    const timers = new Map();
    let now = 1;
    let nextTimer = 1;
    w.setTimeout = (callback, delay = 0) => {
        const id = nextTimer++;
        timers.set(id, { callback, at: now + delay });
        return id;
    };
    w.clearTimeout = (id) => timers.delete(id);
    Object.defineProperty(w.performance, "now", { value: () => now });
    let host = w.document.querySelector(".pzp-pc");
    let video = w.document.querySelector("video");
    const media = { paused, position: time, playCalls: 0, switches: 0 };
    const rect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    function defineMedia(target) {
        target.autoplay = autoplay;
        Object.defineProperties(target, {
            paused: { get: () => media.paused },
            readyState: { get: () => 4 },
            duration: { get: () => 3600 },
            played: { get: () => ({ length: played }) },
            seeking: { get: () => false },
            currentTime: {
                get: () => media.position,
                set: (value) => {
                    media.position = Number(value);
                },
            },
        });
        target.play = () => {
            media.playCalls += 1;
            media.paused = false;
            return Promise.resolve();
        };
        target.getBoundingClientRect = rect;
        return target;
    }
    defineMedia(video);
    host.getBoundingClientRect = rect;
    const tracks = [480, 720, 1080].map((height) => ({ id: String(height), height, kind: "main", selected: false }));
    let trackIndex = 0;
    const markSelected = () => tracks.forEach((track, index) => (track.selected = index === trackIndex));
    markSelected();
    Object.defineProperty(tracks, "selectedIndex", {
        get: () => trackIndex,
        set: (value) => {
            if (trackIndex === value) return;
            trackIndex = value;
            media.switches += 1;
            markSelected();
            if (!switchPausesAndResets) return;
            media.paused = true;
            media.position = 0;
        },
    });
    host._corePlayer = { videoTracks: tracks };
    const setQualityState = (enabled, quality = "1080p") => {
        root.setAttribute("data-cheese-spanner-auto-quality-state", JSON.stringify({ enabled, quality }));
        w.dispatchEvent(new w.Event("cheese-spanner:auto-quality:state"));
    };
    root.setAttribute("data-cheese-spanner-auto-quality-state", JSON.stringify({ enabled: true, quality: "1080p" }));
    t.after(() => {
        setQualityState(false);
        timers.clear();
        dom.window.close();
    });
    w.eval(readFeature("autoQualityPage.js"));

    async function advance(ms) {
        const end = now + ms;
        for (let count = 0; count < 10000; count += 1) {
            const next = [...timers.entries()]
                .filter(([, timer]) => timer.at <= end)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) {
                now = end;
                await Promise.resolve();
                return;
            }
            const [id, timer] = next;
            timers.delete(id);
            now = timer.at;
            timer.callback();
            await Promise.resolve();
        }
        throw new Error("Unexpected unbounded timer loop");
    }

    return {
        w,
        get video() {
            return video;
        },
        media,
        advance,
        setQualityState,
        selectedHeight: () => tracks[trackIndex].height,
        request(requestId = String(now), quality = "1080p") {
            root.setAttribute("data-cheese-spanner-auto-quality-request", JSON.stringify({ requestId, quality }));
            w.dispatchEvent(new w.Event("cheese-spanner:auto-quality:apply"));
            return JSON.parse(root.getAttribute("data-cheese-spanner-auto-quality-result"));
        },
        // The native menu changes the track without going through the extension's selection path.
        chooseManually(height) {
            trackIndex = tracks.findIndex((track) => track.height === height);
            markSelected();
        },
        replaceVideo() {
            const next = defineMedia(w.document.createElement("video"));
            video.replaceWith(next);
            video = next;
        },
        replacePlayer() {
            const next = w.document.createElement("div");
            next.className = "pzp-pc";
            next.getBoundingClientRect = rect;
            next._corePlayer = { videoTracks: tracks };
            next.append(video);
            host.replaceWith(next);
            host = next;
        },
        navigate(path) {
            w.history.pushState({}, "", path);
            w.dispatchEvent(new w.Event("cheese-spanner:routechange"));
        },
        userPause(intent) {
            if (intent === "key") w.dispatchEvent(new w.KeyboardEvent("keydown", { key: " ", bubbles: true }));
            else video.dispatchEvent(new w.Event("pointerdown", { bubbles: true }));
            media.paused = true;
            video.dispatchEvent(new w.Event("pause"));
        },
    };
}

for (const route of ["video/123", "live/fallback"]) {
    for (const intent of ["pointer", "key"]) {
        test(`a user pause after an automatic switch is not resumed late: ${route}, ${intent}`, async (t) => {
            const f = restoreFixture(t, { url: `https://chzzk.naver.com/${route}` });
            assert.equal(f.request("first").status, "selected");
            await f.advance(50);
            f.userPause(intent);
            await f.advance(250);
            assert.equal(f.media.playCalls, 0);
            assert.equal(f.media.paused, true);
            await f.advance(5000);
            assert.equal(f.media.playCalls, 0, "later restore retries do not resume the user's pause either");
            assert.equal(f.media.paused, true);
            assert.equal(f.selectedHeight(), 1080);
            assert.equal(f.media.position, 300);
        });
    }
}

test("the switch's own pause and position reset are still restored without a user intent", async (t) => {
    const f = restoreFixture(t, { switchPausesAndResets: true });
    assert.equal(f.request("first").status, "selected");
    assert.equal(f.media.position, 0);
    await f.advance(250);
    assert.equal(f.media.position, 300);
    assert.equal(f.media.playCalls, 1);
    assert.equal(f.media.paused, false);
    await f.advance(5000);
    assert.equal(f.media.playCalls, 1);
});

test("startup autoplay recovery still resumes a video that has not played yet", async (t) => {
    const f = restoreFixture(t, { played: 0, paused: true });
    assert.equal(f.request("first").status, "selected");
    await f.advance(250);
    assert.equal(f.media.playCalls, 1);
    assert.equal(f.media.paused, false);
    assert.equal(f.media.position, 300);
});

for (const autoplay of [false, true]) {
    test(`a saved quality change keeps a user-paused video paused: autoplay ${autoplay}`, async (t) => {
        const f = restoreFixture(t, { autoplay });
        await f.advance(2000);
        assert.equal(f.selectedHeight(), 1080, "the entry apply still runs");
        f.userPause("pointer");
        await f.advance(5000);
        f.setQualityState(true, "720p");
        await f.advance(5000);
        assert.equal(f.selectedHeight(), 720, "the saved quality is applied to the current video");
        assert.equal(f.media.playCalls, 0);
        assert.equal(f.media.paused, true);
    });
}

test("re-sending the same preference after the VOD entry apply keeps a manual choice", async (t) => {
    const f = restoreFixture(t);
    assert.equal(f.request("first").status, "selected");
    f.chooseManually(480);
    // An unrelated option save republishes the same state and re-sends the same preferred quality.
    f.setQualityState(true, "1080p");
    const result = f.request("unrelated-setting-save");
    assert.equal(result.status, "already");
    assert.equal(f.selectedHeight(), 480);
    await f.advance(10000);
    assert.equal(f.selectedHeight(), 480, "page retries and verification do not restore 1080p either");
    assert.equal(f.media.switches, 1);
});

for (const route of ["video/123", "live/fallback"]) {
    test(`the entry window re-selects a selection that did not stick, then keeps later manual choices: ${route}`, async (t) => {
        const f = restoreFixture(t, { url: `https://chzzk.naver.com/${route}` });
        await f.advance(10);
        assert.equal(f.selectedHeight(), 1080, "the page window selects the preferred quality");
        assert.equal(f.media.switches, 1);
        // The platform puts the old track back before the window's own verification pass.
        f.chooseManually(480);
        assert.equal(f.request("external-during-verify").status, "already", "external requests see the entry");
        assert.equal(f.selectedHeight(), 480);
        await f.advance(2000);
        assert.equal(f.selectedHeight(), 1080, "the same window's verification re-selects once");
        assert.equal(f.media.switches, 2);

        // After that window settled, a manual change survives the same preference re-sent from outside.
        f.chooseManually(480);
        f.setQualityState(true, "1080p");
        assert.equal(f.request("unrelated-setting-save").status, "already");
        await f.advance(10000);
        assert.equal(f.selectedHeight(), 480);
        assert.equal(f.media.switches, 2);
    });
}

test("the VOD entry apply still runs once after the startup readiness wait", async (t) => {
    const f = restoreFixture(t, { time: 0, played: 0 });
    await f.advance(1000);
    assert.equal(f.media.switches, 0, "the startup position is not settled yet");
    await f.advance(2000);
    assert.equal(f.selectedHeight(), 1080);
    assert.equal(f.media.switches, 1);
    f.chooseManually(720);
    for (const type of ["timeupdate", "playing", "seeked"]) f.video.dispatchEvent(new f.w.Event(type));
    assert.equal(f.request().status, "already");
    await f.advance(10000);
    assert.equal(f.selectedHeight(), 720);
    assert.equal(f.media.switches, 1);
});

test("a saved preference, a replaced video or player and a route change still apply on VOD", async (t) => {
    const f = restoreFixture(t);
    await f.advance(2000);
    assert.equal(f.selectedHeight(), 1080);
    assert.equal(f.media.switches, 1);
    const expectManualChoiceKept = async (preferred) => {
        f.chooseManually(480);
        assert.equal(f.request(undefined, preferred).status, "already");
        await f.advance(3000);
        assert.equal(f.selectedHeight(), 480);
    };
    await expectManualChoiceKept("1080p");

    f.setQualityState(true, "720p");
    await f.advance(1000);
    assert.equal(f.selectedHeight(), 720, "saving a different preference applies it to the current video");
    assert.equal(f.request(undefined, "720p").status, "already");
    assert.equal(f.media.switches, 2);
    await expectManualChoiceKept("720p");

    f.replaceVideo();
    assert.equal(f.request(undefined, "720p").status, "selected", "a new video is a new entry");
    assert.equal(f.media.switches, 3);
    await expectManualChoiceKept("720p");

    f.replacePlayer();
    assert.equal(f.request(undefined, "720p").status, "selected", "a new player is a new entry");
    assert.equal(f.media.switches, 4);
    await expectManualChoiceKept("720p");

    f.navigate("/video/456");
    assert.equal(f.request(undefined, "720p").status, "selected", "a new route is a new entry");
    assert.equal(f.selectedHeight(), 720);
    assert.equal(f.media.switches, 5);
});

test("re-enabling automatic quality on VOD applies again like live", async (t) => {
    const f = restoreFixture(t);
    await f.advance(2000);
    assert.equal(f.media.switches, 1);
    f.setQualityState(false);
    await f.advance(100);
    f.chooseManually(480);
    f.setQualityState(true);
    assert.equal(f.request("re-enabled").status, "selected");
    await f.advance(10000);
    assert.equal(f.selectedHeight(), 1080);
    assert.equal(f.media.switches, 2);
});

test("a VOD route change does not record the previous video's track left in the same element", async (t) => {
    const f = restoreFixture(t);
    await f.advance(2000);
    f.navigate("/video/456");
    assert.equal(f.request("route-change").status, "already", "the old VOD still shows 1080p");
    await f.advance(3000);
    // The next VOD loads into the same element at the platform default.
    f.media.position = 0;
    f.chooseManually(480);
    f.video.dispatchEvent(new f.w.Event("loadedmetadata"));
    f.media.position = 2;
    f.video.dispatchEvent(new f.w.Event("timeupdate"));
    assert.equal(f.request("after-load").status, "selected", "the next VOD still receives its entry apply");
    await f.advance(10000);
    assert.equal(f.selectedHeight(), 1080);
    assert.equal(f.media.switches, 2);
    f.chooseManually(720);
    assert.equal(f.request("same-preference").status, "already", "its own entry then protects manual choices");
    await f.advance(5000);
    assert.equal(f.selectedHeight(), 720);
    assert.equal(f.media.switches, 2);
});

for (const [suffix, position] of [
    ["?currentTime=42", 42],
    ["#comments", 300],
]) {
    test(`a query or hash change on the same VOD keeps a manual choice: ${suffix}`, async (t) => {
        const f = restoreFixture(t);
        await f.advance(2000);
        f.chooseManually(480);
        f.w.history.replaceState({}, "", `/video/123${suffix}`);
        f.w.dispatchEvent(new f.w.Event("cheese-spanner:routechange"));
        await f.advance(5000);
        assert.equal(f.request("same-preference").status, "already");
        await f.advance(5000);
        assert.equal(f.selectedHeight(), 480);
        assert.equal(f.media.switches, 1);
        assert.equal(f.media.position, position, "an explicit link time is still honored");
    });
}
