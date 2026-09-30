const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { waitForCondition } = require("./helpers/extension-page-fixture.js");
const source = fs.readFileSync(path.join(__dirname, "../features/streamInfo.js"), "utf8");
// Native home-menu structure observed on live and VOD pages on 2026-09-15.
const nativeSettings = `<div role="menu" class="pzp-settings pzp-pc-settings pzp-pc__settings">
    <div role="menuitem" tabindex="0" class="pzp-ui-setting-home-item pzp-setting-intro-quality">
        <span class="pzp-ui-setting-home-item__top"><span class="pzp-ui-setting-home-item__left"><span class="pzp-ui-setting-home-item__label">해상도</span></span></span>
    </div>
    <div role="menuitem" tabindex="0" class="pzp-ui-setting-home-item pzp-setting-intro-filter">선명한 화면</div>
</div>`;
const nativeControls = `<div class="pzp-pc__bottom-buttons-right"><button class="pzp-setting-button pzp-pc__setting-button" aria-label="설정" aria-haspopup="true" aria-expanded="false"></button></div>`;
const settingsItem = (f) => f.doc.getElementById("betterchzzk-stream-info-settings-item");
const tracks = [{ videoWidth: 1920, videoHeight: 1080, videoBitRate: 8192000 }];
const response = (items = tracks) => ({
    code: 200,
    content: {
        status: "OPEN",
        liveId: 1,
        channel: { channelId: "test" },
        livePlaybackJson: JSON.stringify({ media: [{ encodingTrack: items }] }),
    },
});

function fixture(t, fetcher = async () => response()) {
    const dom = new JSDOM(
        `<div class="pzp-pc" tabindex="0"><video></video>${nativeControls}${nativeSettings}
        <div class="pzp-pc__setting-quality-pane"><ul role="menu"><li role="menuitem">1080p</li></ul></div></div>`,
        {
            url: "https://chzzk.naver.com/live/test",
            runScripts: "outside-only",
            pretendToBeVisual: true,
        }
    );
    const w = dom.window;
    const doc = w.document;
    let apply, route, mutations;
    let videoReads = 0;
    // Model the observed settings toggle without writing native classes from the feature.
    doc.addEventListener("click", (event) => {
        const button = event.target.closest(".pzp-setting-button");
        if (!button) return;
        const open = button.getAttribute("aria-expanded") !== "true";
        button.setAttribute("aria-expanded", String(open));
        button.closest(".pzp-pc").classList.toggle("pzp-pc--setting-home", open);
    });
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
        currentSrc: "blob:initial-stream",
        buffered: range([[90, 99]]),
        seekable: range([[80, 100]]),
    }))
        Object.defineProperty(video, key, { configurable: true, value, writable: true });
    video.getVideoPlaybackQuality = () => ({ totalVideoFrames: total, droppedVideoFrames: dropped });
    const controlCalls = [];
    const mountNative = (target = video) => {
        const host = target.closest(".pzp-pc");
        host.classList.add("chzzk_player", "type_live");
        target.classList.add("webplayer-internal-video");
        target.getBoundingClientRect = () => ({ width: 1280, height: 720 });
        const selected = { id: "main-1080", kind: "main", selected: true, width: 1920, height: 1080 };
        const pane = {
            $dispatch: () => controlCalls.push("dispatch"),
            selectVideoTrack: () => controlCalls.push("select"),
            $store: { getters: { onLive: true } },
        };
        const native = {
            srcObject: {},
            shadowRoot: host,
            videoTracks: [selected],
            querySelector: () => pane,
            getPreProcessorControl() {
                controlCalls.push("processor");
            },
        };
        host.__reactFiber$stream = { memoizedState: { memoizedState: native } };
        target.play = () => controlCalls.push("play");
        target.pause = () => controlCalls.push("pause");
        return { native, pane, selected };
    };
    const native = mountNative();
    w.BetterChzzk = {
        utils: {
            bindFeatureOptions(fn) {
                apply = fn;
                fn({ streamInfoEnabled: true });
            },
            getMainVideoElement: () => {
                videoReads++;
                return (
                    Array.from(doc.querySelectorAll("video")).find(
                        (v) => !v.closest('[data-bcmv-video], [data-bcfp-player-mount], [data-role="imaAdContainerEl"]')
                    ) || null
                );
            },
            getPlayerRoot: (v) => v?.closest(".pzp-pc"),
            isPlaybackRoute: () => /^\/(live|video)\//.test(w.location.pathname),
            startPageChangeDetection(fn) {
                route = fn;
                return () => {
                    route = null;
                };
            },
            createMutationObserverSync({ onMutations }) {
                mutations = onMutations;
                const observer = new w.MutationObserver(onMutations);
                observer.observe(doc.body, { childList: true, subtree: true });
                return {
                    disconnectAll() {
                        observer.disconnect();
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
    doc.documentElement.setAttribute("data-betterchzzk-auto-quality-state", JSON.stringify({ enabled: false }));
    for (const file of ["features/autoQualityPage.js", "shared/liveTiming.js", "features/streamInfoModel.js"])
        w.eval(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
    const createModel = w.BetterChzzk.streamInfoModel.create;
    const samples = [];
    const events = [];
    w.BetterChzzk.streamInfoModel = {
        create: (...args) => {
            const model = createModel(...args);
            return {
                ...model,
                sample(input) {
                    const view = model.sample(input);
                    samples.push(view);
                    return view;
                },
                event(type, input) {
                    events.push(type);
                    return model.event(type, input);
                },
            };
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
        native,
        mountNative,
        controlCalls,
        samples,
        events,
        range,
        advance: (ms) => {
            now += ms;
        },
        get videoReads() {
            return videoReads;
        },
        apply: (on) => apply({ streamInfoEnabled: on }),
        context: (target = doc.querySelector("video"), init = {}) => {
            const event = new w.MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                button: 2,
                clientX: 200,
                clientY: 100,
                ...init,
            });
            target.dispatchEvent(event);
            return event;
        },
        open: () => {
            doc.querySelector(".pzp-setting-button").click();
            doc.getElementById("betterchzzk-stream-info-settings-item").click();
        },
        text: () => doc.getElementById("betterchzzk-stream-info")?.textContent,
        route: (url) => {
            w.history.replaceState(null, "", url);
            route?.();
        },
        mutate: (addedNodes = [], removedNodes = []) => mutations?.([{ addedNodes, removedNodes }]),
        tick: (frames = 60, drops = 0, progress = true) => {
            now += 1000;
            total += frames;
            dropped += drops;
            if (progress) video.currentTime += 1;
            video.seekable = range([[80, 100 + now / 1000]]);
            video.buffered = range([[90, video.currentTime + 4]]);
            for (const fn of timers) fn();
        },
        hide: (hidden) => {
            Object.defineProperty(doc, "hidden", { configurable: true, value: hidden });
            doc.dispatchEvent(new w.Event("visibilitychange"));
        },
    };
}

test("native settings open and close stream information without changing existing menu items or background sampling", (t) => {
    const f = fixture(t);
    const container = f.doc.querySelector(".pzp-pc__settings");
    const quality = container.querySelector(".pzp-setting-intro-quality");
    const qualityMarkup = quality.outerHTML;
    const gear = f.doc.querySelector(".pzp-setting-button");
    assert.equal(f.doc.getElementById("betterchzzk-stream-info-button"), null);
    assert.equal(f.doc.getElementById("betterchzzk-stream-info-menu"), null);
    assert.equal(settingsItem(f).parentElement, container);
    assert.equal(f.doc.querySelector(".pzp-pc__setting-quality-pane button"), null);
    for (const theme of ["", "theme_dark"]) {
        f.doc.documentElement.className = theme;
        const item = settingsItem(f);
        assert.equal(item.textContent, "스트림 정보 열기");
        assert.equal(item.type, "button");
        assert.equal(item.getAttribute("role"), "menuitem");
        assert.equal(item.getAttribute("aria-controls"), "betterchzzk-stream-info");
        assert.equal(item.getAttribute("aria-expanded"), "false");
        const before = f.requests.length;
        gear.click();
        assert.equal(f.requests.length, before);
        assert.equal(f.timers.size, 0);
        item.click();
        assert.equal(gear.getAttribute("aria-expanded"), "false");
        assert.equal(item.getAttribute("aria-expanded"), "true");
        assert.equal(item.textContent, "스트림 정보 닫기");
        assert.equal(f.doc.activeElement.getAttribute("aria-label"), "스트림 정보 닫기");
        assert.equal(f.requests.length, before + 1);
        f.open();
        assert.equal(f.text(), undefined);
        assert.equal(f.doc.activeElement, gear);
        assert.equal(f.timers.size, 0);
        assert.equal(container.querySelector(".pzp-setting-intro-quality"), quality);
        assert.equal(quality.outerHTML, qualityMarkup);
    }
});

test("panel is on-demand and shows measured dimensions, declared bitrate, buffer and frame load", async (t) => {
    const f = fixture(t);
    assert.equal(f.requests.length, 0);
    assert.equal(f.timers.size, 0);
    f.open();
    await new Promise(setImmediate);
    assert.match(f.text(), /1920 × 1080/);
    assert.match(f.text(), /8,192 kbps/);
    assert.match(f.text(), /4\.0초/);
    f.tick(60, 3);
    assert.match(f.text(), /57\.0 FPS/);
    const labels = Array.from(f.doc.querySelectorAll("#betterchzzk-stream-info dt"), (element) => element.textContent);
    assert.ok(labels.includes("FPS"));
    assert.doesNotMatch(f.text(), /누적|드롭|출력 프레임|Mbps|라이브 끝과의 차이/);
    assert.match(f.text(), /하드웨어 가속확인 불가/);
    assert.equal(f.requests.length, 1);
    assert.equal(f.timers.size, 1);
    f.doc
        .getElementById("betterchzzk-stream-info")
        .dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(f.text(), undefined);
    assert.equal(f.timers.size, 0);
    assert.equal(f.doc.activeElement, f.doc.querySelector(".pzp-setting-button"));
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
    assert.match(f.text(), /1920 × 1080/);
    assert.match(f.text(), /남은 재생 버퍼4\.00초/);
    assert.equal(f.requests.length, 2);
    f.apply(false);
    assert.equal(f.doc.querySelector("[id^='betterchzzk-stream-info']"), null);
    assert.equal(f.timers.size, 0);
    f.apply(true);
    f.apply(true);
    assert.equal(f.doc.querySelectorAll("#betterchzzk-stream-info-settings-item").length, 1);
    f.route("/following");
    assert.equal(settingsItem(f), null);
    assert.equal(f.context().defaultPrevented, false);
    f.route("/live/next");
    assert.ok(settingsItem(f));
    assert.equal(f.timers.size, 0);
    assert.equal(f.video.currentTime, 95);
    assert.equal(f.video.paused, false);
});

test("live panel survives toolbar, source and player replacement while stale handlers are removed", (t) => {
    const f = fixture(t);
    f.open();
    const old = f.doc.querySelector(".pzp-pc__bottom-buttons-right");
    const next = old.cloneNode(true);
    old.replaceWith(next);
    f.mutate([next], [old]);
    f.mutate([next], []);
    assert.match(f.text(), /1920 × 1080/);
    assert.equal(f.timers.size, 1);
    const panel = f.doc.getElementById("betterchzzk-stream-info");
    f.video.dispatchEvent(new f.w.Event("emptied"));
    assert.equal(f.doc.getElementById("betterchzzk-stream-info"), panel);
    assert.equal(f.timers.size, 1);
    const oldPlayer = f.doc.querySelector(".pzp-pc");
    const nextPlayer = f.doc.createElement("div");
    nextPlayer.className = "pzp-pc";
    nextPlayer.tabIndex = 0;
    const staleItem = settingsItem(f);
    nextPlayer.innerHTML = `<video></video>${nativeControls}${nativeSettings}`;
    oldPlayer.replaceWith(nextPlayer);
    f.mutate([nextPlayer], [oldPlayer]);
    assert.equal(f.doc.getElementById("betterchzzk-stream-info"), panel);
    assert.equal(f.timers.size, 1);
    staleItem.click();
    assert.equal(f.doc.getElementById("betterchzzk-stream-info"), panel);
    const count = f.requests.length;
    f.video.dispatchEvent(new f.w.Event("emptied"));
    assert.equal(f.requests.length, count, "the detached video no longer owns media events");
    assert.equal(settingsItem(f).closest(".pzp-pc"), nextPlayer);
    assert.equal(f.context(f.video).defaultPrevented, false);
    assert.equal(f.context(nextPlayer.querySelector("video")).defaultPrevented, false);
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
    assert.match(f.text(), /남은 재생 버퍼0\.0초/);
    f.w.dispatchEvent(new f.w.Event("pagehide"));
    assert.equal(f.timers.size, 0);
    f.w.dispatchEvent(new f.w.Event("pageshow"));
    assert.ok(settingsItem(f));
    assert.equal(f.doc.querySelectorAll("#betterchzzk-stream-info-settings-item").length, 1);
});

test("settings activation handles Enter and Space once and leaves native Escape and Tab alone", (t) => {
    const f = fixture(t);
    const item = settingsItem(f);
    let bubbled = 0;
    item.parentElement.addEventListener("keydown", () => bubbled++);
    for (const key of ["Enter", " "]) {
        const before = f.requests.length;
        f.doc.querySelector(".pzp-setting-button").click();
        const event = new f.w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        item.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
        assert.equal(bubbled, 0);
        assert.match(f.text(), /1920 × 1080/);
        assert.equal(f.requests.length, before + 1);
        item.dispatchEvent(new f.w.KeyboardEvent("keydown", { key, repeat: true, bubbles: true, cancelable: true }));
        assert.match(f.text(), /1920 × 1080/);
        assert.equal(f.requests.length, before + 1);
        f.doc.querySelector('#betterchzzk-stream-info button[aria-label="스트림 정보 닫기"]').click();
        assert.equal(f.doc.activeElement, f.doc.querySelector(".pzp-setting-button"));
        assert.equal(item.textContent, "스트림 정보 열기");
    }
    for (const key of ["Escape", "Tab"]) {
        const event = new f.w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        item.dispatchEvent(event);
        assert.equal(event.defaultPrevented, false);
    }
    assert.equal(bubbled, 2);
});

test("keyboard navigation bridges the native menu and stream entry while skipping hidden rows", (t) => {
    const f = fixture(t);
    const container = f.doc.querySelector(".pzp-pc__settings");
    const first = container.firstElementChild;
    const last = container.children[1];
    const item = settingsItem(f);
    const hidden = first.cloneNode(true);
    hidden.hidden = true;
    container.insertBefore(hidden, item);
    for (const row of container.children) row.getClientRects = () => (row.hidden ? [] : [{ height: 42 }]);
    const press = (target, key, init = {}) => {
        target.focus();
        const event = new f.w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
        target.dispatchEvent(event);
        return event;
    };
    for (const [from, key, to] of [
        [last, "ArrowDown", item],
        [first, "ArrowUp", item],
        [item, "ArrowUp", last],
        [item, "ArrowDown", first],
        [first, "End", item],
        [item, "Home", first],
    ]) {
        assert.equal(press(from, key).defaultPrevented, true);
        assert.equal(f.doc.activeElement, to);
    }
    assert.equal(press(first, "ArrowDown").defaultPrevented, false);
    assert.equal(press(last, "ArrowUp").defaultPrevented, false);
    assert.equal(press(last, "ArrowDown", { ctrlKey: true }).defaultPrevented, false);
    assert.equal(f.requests.length, 0);
    assert.equal(f.timers.size, 0);
    f.apply(false);
    assert.equal(press(last, "ArrowDown").defaultPrevented, false);
});

test("right clicks and context-menu shortcuts pass through without creating stream information UI", (t) => {
    const f = fixture(t);
    const player = f.doc.querySelector(".pzp-pc");
    for (const html of [
        "<button>재생</button>",
        '<a href="/">링크</a>',
        "<input>",
        '<div contenteditable="true">입력</div>',
        '<div role="slider"></div>',
        '<div class="pzp-pc"><video></video></div>',
    ]) {
        const host = f.doc.createElement("div");
        host.innerHTML = html;
        player.append(host);
        assert.equal(f.context(host.querySelector("video") || host.firstElementChild).defaultPrevented, false);
    }
    assert.equal(f.context(f.video).defaultPrevented, false);
    assert.equal(f.context(f.doc.body).defaultPrevented, false);
    assert.equal(f.context(f.video, { shiftKey: true }).defaultPrevented, false);
    f.open();
    assert.equal(f.context(f.doc.getElementById("betterchzzk-stream-info")).defaultPrevented, false);
    f.open();
    for (const init of [{ key: "ContextMenu" }, { key: "F10", shiftKey: true }]) {
        const event = new f.w.KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
        player.dispatchEvent(event);
        assert.equal(event.defaultPrevented, false);
    }
    assert.equal(f.doc.getElementById("betterchzzk-stream-info-menu"), null);
    assert.equal(f.text(), undefined);
    assert.equal(f.timers.size, 0);
});

test("settings remount without duplicate rows, stale handlers, extra sampling or mutation loops", async (t) => {
    const f = fixture(t);
    f.open();
    const panel = f.doc.getElementById("betterchzzk-stream-info");
    const oldContainer = f.doc.querySelector(".pzp-pc__settings");
    const oldItem = settingsItem(f);
    const replacement = f.doc.createElement("div");
    replacement.innerHTML = nativeSettings;
    const nextContainer = replacement.firstElementChild;
    oldContainer.replaceWith(nextContainer);
    await waitForCondition(() => settingsItem(f)?.parentElement === nextContainer);
    assert.equal(f.doc.getElementById("betterchzzk-stream-info"), panel);
    assert.equal(settingsItem(f).textContent, "스트림 정보 닫기");
    assert.equal(f.requests.length, 1);
    assert.equal(f.timers.size, 1);
    oldItem.click();
    assert.equal(f.doc.getElementById("betterchzzk-stream-info"), panel);
    const removedItem = settingsItem(f);
    removedItem.remove();
    await waitForCondition(() => settingsItem(f) && settingsItem(f) !== removedItem);
    removedItem.click();
    assert.equal(f.doc.getElementById("betterchzzk-stream-info"), panel);
    const secondary = f.doc.createElement("div");
    secondary.className = "pzp-pc";
    secondary.innerHTML = `<video></video>${nativeSettings}`;
    f.doc.querySelector(".pzp-pc").append(secondary);
    await new Promise(setImmediate);
    assert.equal(secondary.querySelector("#betterchzzk-stream-info-settings-item"), null);
    assert.equal(f.doc.querySelectorAll("#betterchzzk-stream-info-settings-item").length, 1);
    const reads = f.videoReads;
    const changes = [];
    const observer = new f.w.MutationObserver((records) => changes.push(...records));
    observer.observe(nextContainer, { subtree: true, attributes: true, childList: true });
    t.after(() => observer.disconnect());
    for (let i = 0; i < 3; i++) {
        f.tick();
        const chat = f.doc.createElement("p");
        chat.textContent = `message ${i}`;
        f.doc.body.append(chat);
        await new Promise(setImmediate);
    }
    assert.equal(changes.length, 0, "sampling and unrelated mutations must not rewrite the settings menu");
    assert.equal(f.videoReads, reads, "sampling and unrelated mutations must not rescan the player");
    assert.equal(f.requests.length, 1);
    f.apply(false);
    assert.equal(settingsItem(f), null);
    nextContainer.replaceChildren();
    await new Promise(setImmediate);
    assert.equal(settingsItem(f), null);
    assert.equal(f.timers.size, 0);
});

test("a settings menu added after player initialization receives one entry", async (t) => {
    const f = fixture(t);
    const container = f.doc.querySelector(".pzp-pc__settings");
    container.remove();
    await waitForCondition(() => !settingsItem(f));
    const secondary = f.doc.createElement("div");
    secondary.className = "pzp-pc";
    secondary.innerHTML = `<video></video>${nativeSettings}`;
    f.doc.querySelector(".pzp-pc").append(secondary);
    await new Promise(setImmediate);
    assert.equal(settingsItem(f), null);
    f.doc.querySelector(".pzp-pc").append(container);
    await waitForCondition(() => settingsItem(f)?.parentElement === container);
    assert.equal(f.doc.querySelectorAll("#betterchzzk-stream-info-settings-item").length, 1);
    assert.equal(f.requests.length, 0);
    assert.equal(f.timers.size, 0);
});

test("live diagnostics use the actual MAIN snapshot and model with one sample per second and accessible graph", async (t) => {
    const f = fixture(t);
    f.doc.documentElement.setAttribute(
        "data-betterchzzk-low-latency-result",
        JSON.stringify({ status: "applied", selectedTrackId: "low-latency-1080" })
    );
    f.open();
    await new Promise(setImmediate);
    assert.match(f.text(), /현재 재생 방식일반/);
    assert.match(f.text(), /라이브 지연\(추정\)측정 대기/);
    assert.equal(f.samples.length, 1, "metadata completion must only redraw");
    f.tick(60, 3);
    assert.match(f.text(), /라이브 지연\(추정\)5\.0초/);
    assert.match(f.text(), /프레임 누락3개 · 5\.0%/);
    assert.match(f.text(), /1\.0초 관측/);
    assert.equal(f.samples.length, 2);
    assert.equal(f.doc.querySelectorAll("#betterchzzk-stream-info svg path[data-series]").length, 2);
    assert.ok(f.doc.querySelector('#betterchzzk-stream-info svg[role="img"][aria-describedby]'));
    assert.equal(f.doc.querySelector("#betterchzzk-stream-info [aria-live]"), null);
    assert.equal(f.video.hasAttribute("data-bcsi-request"), false);
    assert.equal(f.video.hasAttribute("data-bcsi-result"), false);
    f.native.selected.kind = "low-latency";
    f.native.selected.id = "low-latency-1080";
    f.tick();
    assert.match(f.text(), /현재 재생 방식저지연/);
    assert.ok(f.doc.querySelector("#betterchzzk-stream-info [data-mode-change]"));
    assert.equal(f.requests.length, 1);
    assert.equal(f.timers.size, 1);
    assert.deepEqual(f.controlCalls, []);
});

test("live source emptying keeps the panel and hides sampling gaps while VOD still closes", async (t) => {
    const f = fixture(t);
    f.open();
    await new Promise(setImmediate);
    f.tick();
    const panel = f.doc.getElementById("betterchzzk-stream-info");
    f.video.dispatchEvent(new f.w.Event("emptied"));
    assert.equal(f.doc.getElementById("betterchzzk-stream-info"), panel);
    await new Promise(setImmediate);
    f.tick();
    assert.ok(f.samples.at(-1).samples.some((point) => point.gap));
    f.route("/video/123");
    f.open();
    f.video.dispatchEvent(new f.w.Event("emptied"));
    assert.equal(f.text(), undefined);
    assert.equal(f.timers.size, 0);
});

test("hidden time stops collection and requests, expires history, and resumes with an explicit graph gap", async (t) => {
    const f = fixture(t);
    f.open();
    await new Promise(setImmediate);
    f.tick();
    f.tick();
    const count = f.samples.length;
    const observed = f.samples.at(-1).observedSeconds;
    f.hide(true);
    f.advance(7000);
    f.tick();
    assert.equal(f.samples.length, count);
    assert.equal(f.requests.length, 1);
    assert.equal(f.timers.size, 0);
    f.hide(false);
    assert.equal(f.samples.at(-1).observedSeconds, observed);
    assert.equal(f.samples.at(-1).samples.at(-1).gap, true);
    f.tick();
    assert.equal(f.samples.at(-1).observedSeconds, observed + 1);
    assert.equal(f.doc.querySelector('[data-series="buffer"]').getAttribute("d").match(/M/g).length, 2);
    assert.equal(f.requests.length, 1, "completed metadata need not be fetched again on visibility changes");
    f.hide(true);
    f.advance(61000);
    f.hide(false);
    assert.equal(f.samples.at(-1).observedSeconds, 0);
    assert.equal(f.samples.at(-1).samples.length, 1);
    assert.equal(f.timers.size, 1);
});

test("media events confirm observed waits and exclude pauses, seeks, advertisements and invalid rates", async (t) => {
    const f = fixture(t);
    f.open();
    await new Promise(setImmediate);
    f.tick();
    const emit = (type) => f.video.dispatchEvent(new f.w.Event(type));
    emit("waiting");
    emit("waiting");
    f.tick(0, 0, false);
    assert.equal(f.samples.at(-1).stalls.count, 1);
    assert.equal(f.samples.at(-1).stalls.seconds, 1);
    f.video.paused = true;
    emit("pause");
    f.tick(0, 0, false);
    assert.equal(f.samples.at(-1).stalls.seconds, 1);
    assert.equal(f.samples.at(-1).current.delay, null);
    f.video.paused = false;
    emit("playing");
    f.tick();
    Object.defineProperty(f.video, "seeking", { configurable: true, value: true });
    emit("seeking");
    f.tick();
    assert.equal(f.samples.at(-1).current.state, "seeking");
    Object.defineProperty(f.video, "seeking", { configurable: true, value: false });
    emit("seeked");
    f.doc.querySelector(".pzp-pc").classList.add("pzp-pc--adbreak");
    f.tick();
    assert.equal(f.samples.at(-1).current.state, "ad");
    assert.match(f.text(), /현재 재생 방식확인 불가/);
    f.doc.querySelector(".pzp-pc").classList.remove("pzp-pc--adbreak");
    f.video.playbackRate = 0;
    emit("ratechange");
    f.tick();
    assert.equal(f.samples.at(-1).current.state, "invalid-rate");
    f.video.playbackRate = 1.03;
    emit("ratechange");
    f.tick();
    assert.match(f.text(), /재생 속도1\.03배/);
    f.native.pane.$store.getters.onLive = false;
    f.tick();
    assert.match(f.text(), /되감기 시청 중/);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.controlCalls, []);
    assert.ok(f.events.includes("waiting"));
});

test("fresh matching broadcast identity preserves source history, while new, closed or unverified broadcasts reset it", async (t) => {
    let data = response();
    const f = fixture(t, async () => data);
    f.open();
    await new Promise(setImmediate);
    f.tick();
    f.tick();
    const firstAt = f.samples.at(-1).samples[0].at;
    f.video.currentSrc = "blob:same-broadcast";
    f.video.dispatchEvent(new f.w.Event("emptied"));
    await new Promise(setImmediate);
    f.tick();
    assert.equal(f.samples.at(-1).samples[0].at, firstAt);
    assert.equal(f.samples.at(-1).current.state, "waiting");
    for (const content of [
        { ...response().content, liveId: 2 },
        { ...response().content, liveId: 2, channel: { channelId: "another-channel" } },
        { ...response().content, channel: undefined },
        { ...response().content, status: "CLOSE" },
    ]) {
        f.tick();
        data = { ...response(), content };
        f.video.currentSrc += "-next";
        f.video.dispatchEvent(new f.w.Event("emptied"));
        await new Promise(setImmediate);
        f.tick();
        assert.equal(f.samples.at(-1).samples.length, 1);
        assert.equal(f.samples.at(-1).observedSeconds, 0);
    }
    assert.doesNotMatch(f.text(), /8,192 kbps/);
});

test("metadata that goes stale before a source event resumes exactly once for the current source", async (t) => {
    const resolves = [];
    const f = fixture(t, () => new Promise((resolve) => resolves.push(resolve)));
    f.open();
    resolves.shift()(response());
    await new Promise(setImmediate);
    f.tick();
    f.video.dispatchEvent(new f.w.Event("emptied"));
    assert.equal(f.requests.length, 2);
    f.video.currentSrc = "blob:new-source-without-event";
    resolves.shift()(response());
    await new Promise(setImmediate);
    assert.equal(f.requests.length, 2);
    f.tick();
    assert.equal(f.requests.length, 3);
    resolves.shift()(response());
    await new Promise(setImmediate);
    f.tick();
    f.tick();
    assert.equal(f.requests.length, 3);
    assert.equal(f.samples.at(-1).current.state, "measuring");
    assert.equal(f.timers.size, 1);
});

test("unavailable MAIN reads between provider identities cannot bypass fresh broadcast verification", async (t) => {
    let data = response();
    const f = fixture(t, async () => data);
    f.open();
    await new Promise(setImmediate);
    f.tick();
    f.tick();
    const host = f.video.parentElement;
    const fiber = host.__reactFiber$stream;
    delete host.__reactFiber$stream;
    f.tick();
    assert.match(f.text(), /현재 재생 방식확인 불가/);
    assert.equal(f.requests.length, 1);
    host.__reactFiber$stream = fiber;
    f.native.native.srcObject = {};
    data = { ...response(), content: { ...response().content, liveId: 2 } };
    f.tick();
    assert.equal(f.requests.length, 2);
    await new Promise(setImmediate);
    f.tick();
    assert.equal(f.samples.at(-1).samples.length, 1);
    assert.equal(f.samples.at(-1).observedSeconds, 0);
});

test("invalid and stale bridge responses stay unknown and are removed without losing video observations", async (t) => {
    const f = fixture(t);
    let change = (value) => value;
    f.doc.addEventListener(
        "betterchzzk:stream-info:read",
        (event) => {
            const raw = event.target.getAttribute("data-bcsi-result");
            event.target.setAttribute("data-bcsi-result", JSON.stringify(change(JSON.parse(raw))));
        },
        true
    );
    f.open();
    await new Promise(setImmediate);
    for (const patch of [
        { requestId: "stale" },
        { version: 0 },
        { route: "/live/other" },
        { status: "other" },
        { mode: "<img src=x>" },
        { onLive: "true" },
        { trackWidth: 0 },
    ]) {
        change = (value) => ({ ...value, ...patch });
        f.tick();
        assert.match(f.text(), /현재 재생 방식확인 불가/);
        assert.match(f.text(), /남은 재생 버퍼4\.0초/);
        assert.equal(f.video.hasAttribute("data-bcsi-request"), false);
        assert.equal(f.video.hasAttribute("data-bcsi-result"), false);
    }
    assert.equal(f.requests.length, 1);
});

test("live panel rebinds a new main only after fresh identity, retaining same-broadcast history and dropping unknown history", async (t) => {
    let data = response();
    const f = fixture(t, async () => data);
    f.open();
    await new Promise(setImmediate);
    f.tick();
    f.tick();
    const panel = f.doc.getElementById("betterchzzk-stream-info");
    const replace = () => {
        const old = f.doc.querySelector(".pzp-pc");
        const next = f.doc.createElement("div");
        next.className = "pzp-pc";
        next.innerHTML = `<video></video>${nativeControls}${nativeSettings}`;
        const nextVideo = next.querySelector("video");
        for (const key of [
            "currentTime",
            "currentSrc",
            "videoWidth",
            "videoHeight",
            "paused",
            "readyState",
            "buffered",
            "seekable",
        ])
            Object.defineProperty(nextVideo, key, Object.getOwnPropertyDescriptor(f.video, key));
        nextVideo.getVideoPlaybackQuality = f.video.getVideoPlaybackQuality;
        nextVideo.className = "";
        old.replaceWith(next);
        f.mountNative(nextVideo);
        f.mutate([next], [old]);
        return nextVideo;
    };
    const before = f.samples.at(-1).samples.length;
    replace();
    await new Promise(setImmediate);
    f.tick();
    assert.equal(f.doc.getElementById("betterchzzk-stream-info"), panel);
    assert.equal(f.samples.at(-1).samples.length, before + 1);
    data = { ...response(), content: { ...response().content, liveId: null } };
    replace();
    await new Promise(setImmediate);
    f.tick();
    assert.equal(f.doc.getElementById("betterchzzk-stream-info"), panel);
    assert.equal(f.samples.at(-1).samples.length, 1);
    assert.equal(f.timers.size, 1);
    assert.equal(f.requests.length, 3);
});

test("an advertisement taking over the main node is a gap and never becomes the measured video", async (t) => {
    const f = fixture(t);
    f.open();
    await new Promise(setImmediate);
    f.tick();
    const host = f.video.parentElement;
    const wrapper = f.doc.createElement("div");
    wrapper.setAttribute("data-role", "imaAdContainerEl");
    host.classList.add("pzp-pc--adbreak");
    host.append(wrapper);
    wrapper.append(f.video);
    f.mutate([wrapper], []);
    f.tick();
    assert.ok(f.doc.getElementById("betterchzzk-stream-info"));
    assert.equal(f.samples.at(-1).current.state, "ad");
    assert.equal(f.samples.at(-1).current.buffer, null);
    assert.equal(f.requests.length, 1);
    host.append(f.video);
    wrapper.remove();
    host.classList.remove("pzp-pc--adbreak");
    f.mutate([f.video], [wrapper]);
    await new Promise(setImmediate);
    f.tick();
    assert.equal(f.requests.length, 2);
    assert.equal(f.timers.size, 1);
    assert.deepEqual(f.controlCalls, []);
});

test("sampling has bounded history and no media writes, and closed panels start a new observation", async (t) => {
    const f = fixture(t);
    let time = 95;
    const writes = [];
    Object.defineProperties(f.video, {
        currentTime: {
            configurable: true,
            get: () => time,
            set: () => {
                writes.push("seek");
            },
        },
        playbackRate: {
            configurable: true,
            get: () => 1.03,
            set: () => {
                writes.push("rate");
            },
        },
    });
    let frameReads = 0;
    const readFrames = f.video.getVideoPlaybackQuality;
    f.video.getVideoPlaybackQuality = () => {
        frameReads++;
        return readFrames();
    };
    f.open();
    await new Promise(setImmediate);
    assert.equal(frameReads, 1, "metadata rendering does not read another frame sample");
    for (let index = 0; index < 130; index++) {
        time++;
        f.w.Date.now = () => 500000 - index * 10000;
        f.tick(60, 1, false);
    }
    assert.ok(f.samples.at(-1).samples.length <= 120);
    assert.equal(frameReads, 131);
    assert.equal(f.samples.at(-1).observedSeconds, 60);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(writes, []);
    assert.deepEqual(f.controlCalls, []);
    f.open();
    assert.equal(f.timers.size, 0);
    f.open();
    assert.equal(f.samples.at(-1).samples.length, 1);
    assert.equal(f.samples.at(-1).observedSeconds, 0);
});

test("layout exposes current values first, readable chart legends and a sticky close action in both themes", (t) => {
    const f = fixture(t);
    f.open();
    const panel = f.doc.getElementById("betterchzzk-stream-info");
    assert.deepEqual(
        Array.from(panel.querySelectorAll("dt"))
            .slice(0, 2)
            .map((node) => node.textContent),
        ["현재 재생 방식", "라이브 지연(추정)"]
    );
    assert.match(f.text(), /세로 점선: 재생 방식 변경/);
    const css = f.doc.getElementById("betterchzzk-stream-info-style").textContent;
    assert.match(css, /position:sticky/);
    assert.match(css, /max-inline-size:calc\(100% - 16px\)/);
    assert.match(css, /minmax\(0,1fr\) minmax\(0,1fr\)/);
    assert.match(css, /html\.theme_dark/);
    assert.match(css, /stroke-dasharray:5 4/);
    assert.match(css, /font-variant-numeric:tabular-nums/);
    assert.equal(panel.querySelector("header button").getAttribute("aria-label"), "스트림 정보 닫기");
});

test("VOD keeps its existing metrics and closes on replacement without querying live metadata", (t) => {
    const f = fixture(t);
    f.route("/video/123");
    f.open();
    assert.doesNotMatch(f.text(), /현재 재생 방식|라이브 지연|관측 끊김/);
    assert.match(f.text(), /남은 재생 버퍼4\.00초/);
    assert.equal(f.requests.length, 0);
    const old = f.doc.querySelector(".pzp-pc");
    const next = old.cloneNode(false);
    next.innerHTML = `<video></video>${nativeControls}${nativeSettings}`;
    old.replaceWith(next);
    f.mutate([next], [old]);
    assert.equal(f.text(), undefined);
    assert.equal(f.timers.size, 0);
});

test("manifest loads pure timing and stream models before their isolated consumers", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
    const entry = manifest.content_scripts.find((row) => row.js.includes("features/streamInfo.js"));
    assert.notEqual(entry.world, "MAIN");
    for (const consumer of ["features/streamInfoModel.js", "features/liveMultiview/model.js"])
        assert.ok(
            entry.js.indexOf("shared/liveTiming.js") >= 0 &&
                entry.js.indexOf("shared/liveTiming.js") < entry.js.indexOf(consumer)
        );
    assert.ok(entry.js.indexOf("features/streamInfoModel.js") < entry.js.indexOf("features/streamInfo.js"));
});

test("malformed broadcast IDs cannot join observations across source replacements", async (t) => {
    for (const liveId of ["arbitrary", " ", "1", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const f = fixture(t, async () => ({ ...response(), content: { ...response().content, liveId } }));
        f.open();
        await new Promise(setImmediate);
        f.tick();
        f.tick();
        f.video.currentSrc = "blob:replacement";
        f.video.dispatchEvent(new f.w.Event("emptied"));
        await new Promise(setImmediate);
        f.tick();
        assert.equal(f.samples.at(-1).samples.length, 1, `invalid ID ${String(liveId)} must not establish identity`);
    }
});

test("an unrelated nested player's advertisement does not exclude the current main", async (t) => {
    const f = fixture(t);
    const secondary = f.doc.createElement("div");
    secondary.className = "pzp-pc pzp-pc--adbreak";
    secondary.setAttribute("data-bcmv-video", "");
    f.video.parentElement.append(secondary);
    f.open();
    await new Promise(setImmediate);
    f.tick();
    assert.equal(f.samples.at(-1).current.state, "measuring");
    assert.match(f.text(), /현재 재생 방식일반/);
});

test("source events and main removal invalidate the current mode until a fresh MAIN read", async (t) => {
    const f = fixture(t);
    f.native.selected.kind = "low-latency";
    f.open();
    await new Promise(setImmediate);
    f.tick();
    assert.match(f.text(), /현재 재생 방식저지연/);
    const historyPath = f.doc.querySelector('[data-series="buffer"]').getAttribute("d");
    f.video.currentSrc = "blob:changed-before-event";
    f.video.dispatchEvent(new f.w.Event("loadedmetadata"));
    assert.match(f.text(), /현재 재생 방식확인 불가/);
    assert.equal(f.doc.querySelector('[data-series="buffer"]').getAttribute("d"), historyPath);
    await new Promise(setImmediate);
    assert.match(f.text(), /현재 재생 방식확인 불가/, "metadata completion does not confirm a native mode");
    f.tick();
    assert.match(f.text(), /현재 재생 방식저지연/);
    f.video.dispatchEvent(new f.w.Event("emptied"));
    assert.match(f.text(), /현재 재생 방식확인 불가/);
    await new Promise(setImmediate);
    f.tick();
    assert.match(f.text(), /현재 재생 방식저지연/);
    f.video.remove();
    f.mutate([], [f.video]);
    assert.match(f.text(), /현재 재생 방식확인 불가/);
    assert.ok(f.doc.getElementById("betterchzzk-stream-info"));
});
