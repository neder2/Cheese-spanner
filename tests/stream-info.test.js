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
    content: { status: "OPEN", livePlaybackJson: JSON.stringify({ media: [{ encodingTrack: items }] }) },
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
            getMainVideoElement: () => {
                videoReads++;
                return doc.querySelector("video");
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
    assert.match(f.text(), /4\.00초/);
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

test("statistics survive toolbar replacement and close when the player or source is replaced", (t) => {
    const f = fixture(t);
    f.open();
    const old = f.doc.querySelector(".pzp-pc__bottom-buttons-right");
    const next = old.cloneNode(true);
    old.replaceWith(next);
    f.mutate([next], [old]);
    f.mutate([next], []);
    assert.match(f.text(), /1920 × 1080/);
    assert.equal(f.timers.size, 1);
    f.video.dispatchEvent(new f.w.Event("emptied"));
    assert.equal(f.text(), undefined);
    assert.equal(f.timers.size, 0);
    f.open();
    const oldPlayer = f.doc.querySelector(".pzp-pc");
    const nextPlayer = f.doc.createElement("div");
    nextPlayer.className = "pzp-pc";
    nextPlayer.tabIndex = 0;
    const staleItem = settingsItem(f);
    nextPlayer.innerHTML = `<video></video>${nativeControls}${nativeSettings}`;
    oldPlayer.replaceWith(nextPlayer);
    f.mutate([nextPlayer], [oldPlayer]);
    assert.equal(f.text(), undefined);
    assert.equal(f.timers.size, 0);
    staleItem.click();
    assert.equal(f.text(), undefined);
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
    assert.match(f.text(), /현재 위치에 버퍼 없음/);
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
