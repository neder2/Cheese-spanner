const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const repo = path.join(__dirname, "..");
const A = "a".repeat(32),
    B = "b".repeat(32),
    C = "c".repeat(32);
const key = (id) => `betterChzzkMultiviewDelay:${id}`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 45));
const html =
    '<div id="sidebar"></div><div id="video-region"><div class="chzzk_player type_live"><div class="pzp-pc pzp-pc--controls"><video class="webplayer-internal-video"></video><div class="pzp-pc__bottom-buttons--right"><button class="pzp-pc__viewmode-button" aria-label="넓은 화면">넓은 화면</button></div></div></div></div><section id="native-info">원래 방송 제목과 상호작용</section><aside id="aside-chatting"><div class="chat-header"><h2>채팅</h2><div class="chat-fold"><button type="button" aria-label="채팅 접기">접기</button></div><div class="chat-menu"><button type="button" aria-haspopup="true" aria-label="더보기 메뉴">⋮</button></div></div><div id="native-chat" role="log">원래 채팅</div></aside>';

function setup(t, { local = {}, savedSession, readFailure = false, writeFailure = false, sourcePending = false } = {}) {
    const dom = new JSDOM(html, {
        url: `https://chzzk.naver.com/live/${A}`,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window,
        storage = structuredClone(local),
        writes = [],
        requests = [],
        instances = [];
    const listeners = new Set();
    const optionListeners = new Set();
    const routeListeners = new Set();
    let featureOptions, pendingResolve;
    const configure = (patch) => {
        featureOptions = w.BetterChzzkSettings.normalizeOptions({ ...featureOptions, ...patch });
        for (const listener of optionListeners) listener(featureOptions);
    };
    w.chrome = {
        runtime: {},
        storage: {
            onChanged: {
                addListener: (fn) => listeners.add(fn),
                removeListener: (fn) => listeners.delete(fn),
            },
            local: {
                get(keys, cb) {
                    queueMicrotask(() => {
                        if (readFailure) w.chrome.runtime.lastError = { message: "read failed" };
                        cb(
                            Object.fromEntries(
                                [keys]
                                    .flat()
                                    .filter((k) => k in storage)
                                    .map((k) => [k, storage[k]])
                            )
                        );
                        delete w.chrome.runtime.lastError;
                    });
                },
                set(value, cb) {
                    queueMicrotask(() => {
                        if (writeFailure) w.chrome.runtime.lastError = { message: "write failed" };
                        else {
                            Object.assign(storage, structuredClone(value));
                            writes.push(structuredClone(value));
                        }
                        cb();
                        delete w.chrome.runtime.lastError;
                    });
                },
            },
        },
    };
    const videoStates = new WeakMap();
    function media(video) {
        if (!videoStates.has(video))
            videoStates.set(video, {
                time: 100,
                ready: 4,
                duration: Infinity,
                start: 0,
                end: 120,
                src: "blob:original",
                paused: false,
                error: null,
            });
        return videoStates.get(video);
    }
    Object.defineProperties(w.HTMLMediaElement.prototype, {
        readyState: {
            get() {
                return media(this).ready;
            },
        },
        duration: {
            get() {
                return media(this).duration;
            },
        },
        paused: {
            get() {
                return media(this).paused;
            },
        },
        error: {
            get() {
                return media(this).error;
            },
        },
        seeking: {
            get() {
                return false;
            },
        },
        currentSrc: {
            get() {
                return media(this).src;
            },
        },
        seekable: {
            get() {
                const m = media(this);
                return { length: m.end > m.start ? 1 : 0, start: () => m.start, end: () => m.end };
            },
        },
        currentTime: {
            get() {
                return media(this).time;
            },
            set(value) {
                media(this).time = value;
                this.dispatchEvent(new w.Event("seeking"));
                queueMicrotask(() => this.dispatchEvent(new w.Event("seeked")));
            },
        },
    });
    w.HTMLMediaElement.prototype.play = function () {
        media(this).paused = false;
        return Promise.resolve();
    };
    w.HTMLMediaElement.prototype.pause = function () {
        media(this).paused = true;
    };
    w.HTMLMediaElement.prototype.load = function () {};
    const evalFile = (file) => w.eval(fs.readFileSync(path.join(repo, file), "utf8"));
    evalFile("shared/settings.js");
    evalFile("shared/data.js");
    evalFile("content.js");
    featureOptions = w.BetterChzzkSettings.normalizeOptions({ liveMultiviewEnabled: true });
    Object.assign(w.BetterChzzk.utils, {
        bindFeatureOptions(fn) {
            optionListeners.add(fn);
            fn(featureOptions);
        },
        startPageChangeDetection(fn) {
            routeListeners.add(fn);
            return () => routeListeners.delete(fn);
        },
        fetchJson(url, options) {
            const id = url.match(/channels\/([^/]+)/)[1];
            requests.push({ id, signal: options.signal });
            const response = {
                content: {
                    status: "OPEN",
                    liveId: 1,
                    liveTitle: "실측 형식 회귀 방송",
                    channel: { channelId: id, channelName: `채널 ${id[0]}` },
                    livePlaybackJson: JSON.stringify({
                        media: [{ mediaId: "LLHLS", path: "https://nvelop-livecloud.pstatic.net/test.m3u8" }],
                    }),
                },
            };
            if (sourcePending && id === B)
                return new Promise((resolve) => {
                    pendingResolve = () => resolve(response);
                });
            return Promise.resolve(response);
        },
    });
    class Hls {
        static Events = { MANIFEST_PARSED: "parsed", LEVEL_UPDATED: "level", ERROR: "error" };
        static isSupported() {
            return true;
        }
        constructor(config) {
            this.config = config;
            this.events = {};
            this.targetLatency = 3;
            this.liveSyncPosition = 117;
            this.latestLevelDetails = {
                live: true,
                edge: 120,
                age: 0,
                advancedDateTime: Date.now(),
                targetduration: 2,
            };
            instances.push(this);
        }
        on(event, fn) {
            this.events[event] = fn;
        }
        attachMedia(video) {
            this.video = video;
        }
        loadSource() {
            queueMicrotask(() => {
                this.events.parsed?.();
                this.events.level?.();
                this.video.dispatchEvent(new w.Event("loadedmetadata"));
            });
        }
        destroy() {
            this.destroyed = true;
        }
        stopLoad() {
            this.stopped = true;
        }
    }
    w.Hls = Hls;
    if (savedSession) w.sessionStorage.setItem("betterChzzkMultiviewSession", JSON.stringify(savedSession));
    evalFile("features/liveMultiview/model.js");
    evalFile("features/liveMultiview/runtime.js");
    t.after(() => {
        configure({
            liveMultiviewEnabled: false,
            volumeWheelEnabled: false,
            chatToolsModeratorBoxEnabled: false,
            chatToolsShowBlindEnabled: false,
        });
        dom.window.close();
    });
    const click = (action, id) => {
        const node = w.document.querySelector(`[data-action="${action}"]${id ? `[data-channel="${id}"]` : ""}`);
        assert.ok(node, `missing ${action}`);
        node.click();
    };
    async function start() {
        w.document.getElementById("betterchzzk-multiview-launcher")?.click();
        await tick();
    }
    async function add(id) {
        if (!w.document.querySelector('input[name="liveUrl"]')) {
            if (!w.document.querySelector('[data-action="add"]')) click("controls");
            click("add");
        }
        w.document.querySelector('input[name="liveUrl"]').value = `https://chzzk.naver.com/live/${id}`;
        w.document
            .querySelector(".bcmv-panel form")
            .dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
        await tick();
    }
    return {
        dom,
        w,
        storage,
        writes,
        requests,
        instances,
        media,
        start,
        add,
        click,
        evalFile,
        setOptions: configure,
        configure: (value) => configure({ liveMultiviewEnabled: value }),
        navigate(id) {
            w.history.pushState({}, "", `/live/${id}`);
            for (const listener of routeListeners) listener();
        },
        resolve: () => pendingResolve?.(),
        emitStorage: (id, value) => listeners.forEach((fn) => fn({ [key(id)]: { newValue: value } }, "local")),
    };
}

async function waitForChatUi(predicate) {
    for (let attempt = 0; attempt < 30; attempt++) {
        if (predicate()) return;
        await tick();
    }
    assert.ok(predicate(), "chat controls did not settle");
}

test("chat settings stays beside the native menu with collection off and replaces the channel-name opener", async (t) => {
    const h = setup(t);
    const d = h.w.document,
        menu = d.querySelector(".chat-menu button"),
        nativeParent = menu.parentElement;
    d.querySelector("#aside-chatting").getBoundingClientRect = () => ({
        left: 700,
        top: 60,
        right: 1024,
        bottom: 720,
        width: 324,
        height: 660,
    });
    d.querySelector(".chat-header").getBoundingClientRect = () => ({
        left: 700,
        top: 60,
        right: 1024,
        bottom: 104,
        width: 324,
        height: 44,
    });
    assert.equal(d.querySelector("#betterchzzk-multiview-chat-settings"), null);
    await h.start();
    await h.add(B);
    const settings = d.querySelector("#betterchzzk-multiview-chat-settings");
    const group = d.querySelector("[data-bcmv-chat-actions]");
    assert.ok(settings);
    assert.equal(group.parentElement, nativeParent);
    assert.deepEqual([...group.children], [settings, menu]);
    assert.equal(settings.getAttribute("aria-label"), "멀티뷰 설정");
    assert.equal(settings.getAttribute("aria-haspopup"), "dialog");
    const name = d.querySelector(".bcmv-name");
    assert.equal(name.tagName, "SPAN");
    assert.equal(name.hasAttribute("data-action"), false);
    name.click();
    assert.equal(d.querySelector(".bcmv-panel").hidden, true);
    settings.click();
    assert.equal(settings.getAttribute("aria-expanded"), "true");
    assert.equal(d.querySelector(".bcmv-panel").hidden, false);
    assert.equal(d.querySelector(".bcmv-panel").style.top, "112px", "the popup keeps its header opener exposed");
    settings.dispatchEvent(new h.w.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    assert.equal(d.querySelector(".bcmv-panel").hidden, false, "outside-close must not race the toggle click");
    settings.click();
    assert.equal(settings.getAttribute("aria-expanded"), "false");
    assert.equal(d.querySelector(".bcmv-panel").hidden, true);
    settings.click();
    h.click("close-panel");
    assert.equal(d.activeElement, settings);
    let nativeClicks = 0;
    menu.addEventListener("click", () => nativeClicks++);
    menu.click();
    assert.equal(nativeClicks, 1);
    d.querySelector("#betterchzzk-multiview-launcher").click();
    assert.equal(d.querySelector("#betterchzzk-multiview-chat-settings"), null);
    assert.equal(d.querySelector("[data-bcmv-chat-actions]"), null);
    assert.equal(menu.parentElement, nativeParent);
    settings.click();
    assert.equal(d.querySelector(".bcmv-panel"), null, "a removed opener cannot reopen settings");
});

test("chat settings cooperates with the real collection feature in either enable order", async (t) => {
    for (const collectionFirst of [false, true]) {
        const h = setup(t),
            d = h.w.document;
        h.setOptions({ chatToolsShowBlindEnabled: false, chatToolsModeratorBoxEnabled: true });
        if (collectionFirst) h.evalFile("features/chatTools.js");
        await h.start();
        await h.add(B);
        if (!collectionFirst) h.evalFile("features/chatTools.js");
        await waitForChatUi(() => d.querySelector("[data-bcct-moderator-trigger]"));
        await tick();
        const settings = d.querySelector("#betterchzzk-multiview-chat-settings");
        const group = d.querySelector("[data-bcmv-chat-actions]"),
            menu = d.querySelector('.chat-menu button[aria-label="더보기 메뉴"]');
        const collection = d.querySelector("[data-bcct-moderator-trigger]");
        assert.equal(settings.nextElementSibling, collection.parentElement);
        assert.equal(collection.nextElementSibling, menu);
        assert.equal(group.parentElement.className, "chat-menu");
        assert.equal(group.querySelectorAll("#betterchzzk-multiview-chat-settings").length, 1);
        collection.click();
        assert.equal(collection.getAttribute("aria-expanded"), "true");
        assert.equal(d.querySelector(".bcmv-panel").hidden, true);
        const requests = h.requests.length;
        for (let i = 0; i < 8; i++) collection.querySelector(".bcct-moderator-trigger__count").textContent = String(i);
        await tick();
        assert.equal(d.querySelector("[data-bcmv-chat-actions]"), group);
        assert.equal(h.requests.length, requests);
        h.setOptions({ chatToolsModeratorBoxEnabled: false });
        await waitForChatUi(() => !d.querySelector("[data-bcct-moderator-trigger]"));
        await tick();
        assert.deepEqual([...group.children], [settings, menu]);
        assert.equal(d.querySelector("[data-bcmv-chat-actions]"), group);
        settings.click();
        assert.equal(d.querySelector(".bcmv-panel").hidden, false);
        h.setOptions({ chatToolsModeratorBoxEnabled: true });
        await waitForChatUi(() => d.querySelector("[data-bcct-moderator-trigger]"));
        await tick();
        const restored = d.querySelector("[data-bcct-moderator-trigger]");
        assert.equal(settings.nextElementSibling, restored.parentElement);
        assert.equal(restored.nextElementSibling, menu);
        h.configure(false);
        assert.equal(d.querySelector("[data-bcmv-chat-actions]"), null);
        assert.equal(restored.parentElement.parentElement.className, "chat-menu");
        assert.equal(restored.nextElementSibling, menu);
        h.setOptions({ chatToolsModeratorBoxEnabled: false });
        await waitForChatUi(() => !d.querySelector("[data-bcct-moderator-trigger]"));
        assert.equal(menu.parentElement.className, "chat-menu");
    }
});

test("chat settings waits for the native header and repairs cloned headers without touching the log or streams", async (t) => {
    const h = setup(t),
        d = h.w.document;
    const chat = d.querySelector("#aside-chatting"),
        header = d.querySelector(".chat-header");
    header.remove();
    d.querySelector("#native-chat").insertAdjacentHTML(
        "beforeend",
        '<div class="pinned"><h2>공지</h2><button aria-label="더보기 메뉴">⋮</button></div>'
    );
    await h.start();
    await h.add(B);
    assert.equal(d.querySelector("#betterchzzk-multiview-chat-settings"), null);
    chat.prepend(header);
    await waitForChatUi(() => d.querySelector("#betterchzzk-multiview-chat-settings"));
    const oldButton = d.querySelector("#betterchzzk-multiview-chat-settings");
    const log = d.querySelector("#native-chat"),
        children = [...log.childNodes],
        videos = [...d.querySelectorAll("video")];
    oldButton.click();
    header.replaceWith(header.cloneNode(true));
    await waitForChatUi(
        () => d.querySelector("#betterchzzk-multiview-chat-settings") !== oldButton && oldButton.parentElement === null
    );
    assert.equal(d.querySelectorAll("#betterchzzk-multiview-chat-settings").length, 1);
    assert.equal(d.querySelectorAll("[data-bcmv-chat-actions]").length, 1);
    assert.equal(d.querySelector("#betterchzzk-multiview-chat-settings").getAttribute("aria-expanded"), "true");
    assert.deepEqual([...log.childNodes], children);
    assert.deepEqual([...d.querySelectorAll("video")], videos);
    h.click("close-panel");
    oldButton.click();
    assert.equal(d.querySelector(".bcmv-panel").hidden, true);
    h.navigate(C);
    await tick();
    assert.equal(d.querySelectorAll("#betterchzzk-multiview-chat-settings").length, 1);
    h.navigate("");
    assert.equal(d.querySelector("#betterchzzk-multiview-chat-settings"), null);
    assert.equal(d.querySelector("[data-bcmv-chat-actions]"), null);
});

test("multiview controls overlay videos without reserving toolbar or title space", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    const d = h.w.document,
        style = (selector) => h.w.getComputedStyle(d.querySelector(selector)),
        native = d.querySelector("[data-bcmv-native]"),
        video = d.querySelector("[data-bcmv-video]");
    assert.equal(d.querySelector(".bcmv-toolbar"), null);
    assert.equal(style(".bcmv-grid").inset, "0px");
    assert.equal(d.querySelector("[data-bcmv-host]").style.getPropertyValue("--bcmv-main-top"), "0%");
    assert.equal(style("[data-bcmv-video]").inset, "0px");
    assert.equal(style("[data-bcmv-video]").height, "100%");
    assert.equal(d.querySelector('.bcmv-cell[data-main="1"] .bcmv-head'), null);
    assert.equal(d.querySelector(`[data-action="controls"][data-channel="${A}"]`), null);
    h.click("controls");
    assert.equal(d.querySelector(".bcmv-panel").hidden, false);
    h.click("reset-layout");
    h.click("close-panel");
    assert.equal(d.querySelector("[data-bcmv-native]"), native);
    assert.equal(d.querySelector("[data-bcmv-video]"), video);
    h.click("toggle-multiview");
    assert.equal(d.querySelector("#betterchzzk-multiview"), null);
    assert.equal(d.querySelector('[data-bcmv-host="active"]'), null);
    assert.equal(native.parentElement.id, "video-region");
});

test("secondary bottom controls independently toggle playback, mute and volume", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    await h.add(C);
    const d = h.w.document,
        cell = d.querySelector(`[data-bcmv-channel="${B}"]`),
        video = cell.querySelector("video"),
        other = d.querySelector(`[data-bcmv-channel="${C}"] video`),
        controls = cell.querySelector(".bcmv-controls"),
        slider = controls.querySelector('input[type="range"]');
    assert.ok(cell.querySelector(".bcmv-head .bcmv-name"));
    assert.equal(cell.querySelector('.bcmv-head [data-action="controls"]'), null);
    assert.equal(d.querySelector('.bcmv-cell[data-main="1"] .bcmv-controls'), null);
    assert.equal(controls.querySelector('[data-action="controls"]'), null);
    const fastForward = controls.querySelector('[data-action="reset-delay"]');
    assert.equal(fastForward.previousElementSibling.dataset.action, "toggle-play");
    assert.equal(fastForward.nextElementSibling.dataset.action, "mute");
    assert.equal(fastForward.getAttribute("aria-label"), "빨리 감기");
    const before = h.storage[key(B)]?.delaySeconds ?? 0;
    controls.querySelector('[data-delta="0.1"]').click();
    await tick();
    assert.ok(h.storage[key(B)].delaySeconds > before);
    const selected = h.storage[key(B)].delaySeconds;
    controls.querySelector('[data-delta="-0.1"]').click();
    await tick();
    assert.equal(h.storage[key(B)].delaySeconds, Math.round((selected - 0.1) * 10) / 10);
    h.click("toggle-play", B);
    assert.equal(video.paused, true);
    assert.equal(other.paused, false);
    assert.equal(controls.querySelector('[data-action="toggle-play"]').getAttribute("aria-label"), "재생");
    h.click("toggle-play", B);
    await tick();
    assert.equal(video.paused, false);
    h.click("mute", B);
    assert.equal(video.muted, false);
    assert.equal(other.muted, true);
    const soundShape = () => controls.querySelector('[data-action="mute"] path').getAttribute("d");
    const lowVolumeIcon = soundShape();
    slider.value = "42";
    slider.dispatchEvent(new h.w.Event("input", { bubbles: true }));
    assert.equal(video.volume, 0.42);
    assert.equal(JSON.parse(h.w.sessionStorage.getItem("betterChzzkMultiviewSession")).channels[1].volume, 0.42);
    assert.equal(soundShape(), lowVolumeIcon);
    slider.value = "75";
    slider.dispatchEvent(new h.w.Event("input", { bubbles: true }));
    assert.notEqual(soundShape(), lowVolumeIcon, "higher volume displays the second native sound wave");
    slider.value = "42";
    slider.dispatchEvent(new h.w.Event("input", { bubbles: true }));
    assert.equal(soundShape(), lowVolumeIcon, "lowering volume restores the single-wave icon");
    slider.value = "0";
    slider.dispatchEvent(new h.w.Event("input", { bubbles: true }));
    assert.equal(controls.querySelector('[data-action="mute"]').getAttribute("aria-label"), "음소거 해제");
    h.click("mute", B);
    assert.equal(video.muted, false);
    assert.ok(video.volume > 0);
    h.click("controls");
    assert.equal(d.querySelectorAll('.bcmv-panel [data-action="delay"]').length, 4);
    assert.equal(d.querySelector('.bcmv-panel [data-action="main"]'), null);
    assert.equal(d.querySelectorAll(".bcmv-stream").length, 3);
});

test("secondary volume wheel follows the shared settings without also changing the main", async (t) => {
    const h = setup(t);
    h.evalFile("shared/volumeControls.js");
    h.evalFile("features/volumeWheelPage.js");
    h.evalFile("features/volumeWheel.js");
    await h.start();
    await h.add(B);
    await h.add(C);
    const d = h.w.document,
        cell = d.querySelector(`[data-bcmv-channel="${B}"]`);
    const video = cell.querySelector("video"),
        other = d.querySelector(`[data-bcmv-channel="${C}"] video`);
    const main = d.querySelector(".webplayer-internal-video"),
        mainVolume = d.createElement("button");
    main.getBoundingClientRect = () => ({ left: 0, right: 600, top: 0, bottom: 400, width: 600, height: 400 });
    mainVolume.className = "pzp-pc__volume-button";
    mainVolume.setAttribute("aria-label", "음소거");
    mainVolume.getBoundingClientRect = () => ({ left: 10, right: 46, top: 10, bottom: 46, width: 36, height: 36 });
    d.querySelector(".pzp-pc").append(mainVolume);
    const wheel = (node, deltaY, extra = {}) =>
        node.dispatchEvent(
            new h.w.WheelEvent("wheel", {
                bubbles: true,
                cancelable: true,
                deltaY,
                ...extra,
            })
        );
    const initialMain = [main.volume, main.muted],
        initialOther = [other.volume, other.muted];
    const mute = cell.querySelector('[data-action="mute"]'),
        slider = cell.querySelector('input[type="range"]');
    const requests = h.requests.length,
        instances = h.instances.length;
    assert.equal(wheel(mute.querySelector("path"), -120), false);
    await tick();
    assert.equal(video.volume, 0.05, "wheel up from mute starts at the default 5% step");
    assert.equal(video.muted, false);
    assert.deepEqual([main.volume, main.muted], initialMain);
    assert.deepEqual([other.volume, other.muted], initialOther);
    slider.focus();
    assert.equal(wheel(slider, -1, { deltaMode: 1 }), false);
    assert.equal(video.volume, 0.1);
    assert.equal(slider.value, "10", "a focused slider reflects wheel changes too");
    h.setOptions({ volumeWheelStep: 7 });
    wheel(mute, -120);
    assert.equal(video.volume, 0.17, "step changes apply without remounting");
    main.volume = 0.4;
    assert.equal(wheel(mainVolume, -120), false);
    await tick();
    assert.ok(
        Math.abs(main.volume - 0.47) < 1e-8,
        `the existing main handler follows the same setting (volume=${main.volume}, muted=${main.muted})`
    );
    wheel(mute, -120);
    await tick();
    assert.equal(video.volume, 0.24, "one event applies exactly once with MAIN world enabled");
    assert.ok(Math.abs(main.volume - 0.47) < 1e-8);
    assert.equal(wheel(mute, 0, { deltaX: -120 }), true);
    assert.equal(wheel(video, -120), true);
    assert.equal(wheel(cell.querySelector('[data-action="delay"]'), -120), true);
    assert.equal(video.volume, 0.24);
    h.setOptions({ volumeWheelEnabled: false });
    assert.equal(wheel(mute, -120), true);
    assert.equal(wheel(slider, -120), true);
    assert.equal(wheel(mainVolume, -120), true);
    assert.equal(video.volume, 0.24);
    h.setOptions({ volumeWheelEnabled: true, volumeWheelStep: 50 });
    wheel(mute, -120);
    wheel(mute, -120);
    assert.equal(video.volume, 1);
    wheel(slider, 120);
    wheel(slider, 120);
    assert.equal(video.volume, 0);
    assert.equal(video.muted, true);
    assert.equal(slider.value, "0");
    wheel(mute, -120);
    assert.equal(video.volume, 0.5);
    assert.equal(video.muted, false);
    assert.equal(slider.value, "50");
    const saved = JSON.parse(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"));
    assert.equal(saved.channels.find((entry) => entry.id === B).volume, 0.5);
    assert.equal(saved.channels.find((entry) => entry.id === B).muted, false);
    assert.deepEqual([other.volume, other.muted], initialOther);
    assert.equal(cell.querySelector("video"), video);
    assert.equal(h.requests.length, requests);
    assert.equal(h.instances.length, instances);
    assert.equal(h.writes.length, 0, "volume changes never write channel delays");
});

test("secondary wheel audio survives remount and restore while detached controls stay inactive", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    const d = h.w.document,
        video = d.querySelector("video[data-bcmv-video]");
    const oldMute = d.querySelector('.bcmv-controls [data-action="mute"]');
    const wheel = (node) =>
        node.dispatchEvent(new h.w.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 }));
    wheel(oldMute);
    const native = d.querySelector(".chzzk_player");
    native.replaceWith(native.cloneNode(true));
    await tick();
    assert.equal(d.querySelector("video[data-bcmv-video]"), video);
    assert.equal(wheel(oldMute), true);
    assert.equal(video.volume, 0.05);
    const mute = d.querySelector('.bcmv-controls [data-action="mute"]');
    assert.equal(wheel(mute), false);
    assert.equal(video.volume, 0.1);
    const savedSession = JSON.parse(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"));
    const restored = setup(t, { savedSession });
    await tick();
    const restoredVideo = restored.w.document.querySelector("video[data-bcmv-video]");
    assert.equal(restoredVideo.volume, 0.1);
    assert.equal(restoredVideo.muted, false);
    h.click("remove", B);
    assert.equal(wheel(mute), true);
    h.configure(false);
    assert.equal(wheel(mute), true);
    assert.equal(video.volume, 0.1);
});

test("moving secondary broadcasts transfers each occupied slot's sound only on drop", async (t) => {
    const D = "d".repeat(32);
    const savedSession = {
        version: 1,
        layoutVersion: 3,
        active: true,
        customLayout: true,
        channels: [
            { id: A, volume: 0.7, muted: false },
            { id: B, volume: 0.2, muted: true },
            { id: C, volume: 0.6, muted: false },
            { id: D, volume: 0.9, muted: true },
        ],
        dockTree: {
            axis: "columns",
            ratio: 0.6,
            a: A,
            b: {
                axis: "rows",
                ratio: 1 / 3,
                a: B,
                b: { axis: "rows", ratio: 0.5, a: C, b: D },
            },
        },
    };
    const local = { [key(B)]: { version: 2, basis: "live-edge-clock", delaySeconds: 4 } };
    const h = setup(t, { savedSession, local });
    await tick();
    const d = h.w.document,
        videos = [...d.querySelectorAll("video")];
    const media = (id) =>
        id === A ? d.querySelector(".webplayer-internal-video") : d.querySelector(`[data-bcmv-channel="${id}"] video`);
    const audio = () => [A, B, C, D].map((id) => [media(id).volume, media(id).muted]);
    const initial = audio(),
        requests = h.requests.length,
        initialSession = h.w.sessionStorage.getItem("betterChzzkMultiviewSession");
    const pointer = (node, type, x) =>
        node.dispatchEvent(new h.w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x }));
    const target = d.querySelector(`[data-bcmv-channel="${D}"]`);
    pointer(media(B), "pointerdown", 0);
    pointer(target, "pointermove", 20);
    assert.deepEqual(audio(), initial, "preview leaves all sound unchanged");
    pointer(media(B), "pointercancel", 20);
    assert.deepEqual(audio(), initial);
    assert.equal(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"), initialSession);
    pointer(media(B), "pointerdown", 0);
    pointer(target, "pointermove", 20);
    pointer(target, "pointerup", 20);
    await tick();
    assert.deepEqual(audio(), [
        [0.7, false],
        [0.9, true],
        [0.2, true],
        [0.6, false],
    ]);
    assert.deepEqual([...d.querySelectorAll("video")], videos);
    assert.equal(h.requests.length, requests);
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.storage, local);
    assert.equal(media(B).currentTime, 116, "delay remains with the channel");
    const saved = JSON.parse(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"));
    const restored = setup(t, { savedSession: saved, local });
    await tick();
    const restoredVideo = restored.w.document.querySelector(`[data-bcmv-channel="${D}"] video`);
    assert.equal(restoredVideo.volume, 0.6);
    assert.equal(restoredVideo.muted, false);
    h.click("mute", D);
    assert.deepEqual([media(D).volume, media(D).muted], [0.6, true]);
});

test("edge drops exchange destination sound and a rejected main switch leaves sound alone", async (t) => {
    for (const side of ["left", "right", "top", "bottom"]) {
        const h = setup(t);
        await h.start();
        await h.add(B);
        await h.add(C);
        const d = h.w.document,
            host = d.querySelector("[data-bcmv-host]"),
            grid = d.querySelector(".bcmv-grid");
        const bounds = { left: 0, top: 0, width: 900, height: 506.25 };
        host.getBoundingClientRect = grid.getBoundingClientRect = () => bounds;
        const b = d.querySelector(`[data-bcmv-channel="${B}"] video`),
            c = d.querySelector(`[data-bcmv-channel="${C}"] video`);
        b.volume = 0.23;
        b.muted = true;
        c.volume = 0.61;
        c.muted = false;
        b.dispatchEvent(new h.w.Event("resize"));
        const point = (id, x, y) => {
            const cell = d.querySelector(`[data-bcmv-channel="${id}"]`);
            return [
                ((parseFloat(cell.style.left) + parseFloat(cell.style.width) * x) * bounds.width) / 100,
                ((parseFloat(cell.style.top) + parseFloat(cell.style.height) * y) * bounds.height) / 100,
            ];
        };
        const start = point(B, 0.5, 0.5),
            end = point(
                C,
                side === "left" ? 0.1 : side === "right" ? 0.9 : 0.5,
                side === "top" ? 0.1 : side === "bottom" ? 0.9 : 0.5
            );
        const pointer = (target, type, p) =>
            target.dispatchEvent(
                new h.w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: p[0], clientY: p[1] })
            );
        pointer(b, "pointerdown", start);
        pointer(h.w, "pointermove", end);
        assert.deepEqual([b.volume, b.muted, c.volume, c.muted], [0.23, true, 0.61, false]);
        pointer(h.w, "pointerup", end);
        assert.deepEqual([b.volume, b.muted, c.volume, c.muted], [0.61, false, 0.23, true], side);
        const main = d.querySelector(".webplayer-internal-video"),
            before = [main.volume, main.muted, b.volume, b.muted];
        const toMain = point(A, 0.5, 0.5);
        pointer(b, "pointerdown", point(B, 0.5, 0.5));
        pointer(h.w, "pointermove", toMain);
        pointer(h.w, "pointerup", toMain);
        assert.match(d.querySelector(".bcmv-banner").textContent, /페이지 내부 이동을 사용할 수 없어요/);
        assert.deepEqual([main.volume, main.muted, b.volume, b.muted], before);
    }
});

test("settings popup overlays chat with layout actions and independent secondary delay rows", async (t) => {
    const h = setup(t, {
        local: {
            [key(B)]: { version: 2, basis: "live-edge-clock", delaySeconds: 4 },
            [key(C)]: { version: 2, basis: "live-edge-clock", delaySeconds: 7 },
        },
    });
    await h.start();
    for (const id of [B, C, "d".repeat(32), "e".repeat(32), "f".repeat(32)]) await h.add(id);
    const d = h.w.document,
        chat = d.querySelector("#aside-chatting");
    chat.getBoundingClientRect = () => ({ left: 700, right: 1024, top: 60, bottom: 720, width: 324, height: 660 });
    const nativeChildren = [...chat.childNodes],
        videos = [...d.querySelectorAll("video")];
    h.click("controls");
    const panel = d.querySelector(".bcmv-panel");
    assert.equal(panel.parentElement, d.body, "the extension popup does not alter the native chat tree");
    assert.deepEqual([...chat.childNodes], nativeChildren);
    assert.equal(panel.getAttribute("role"), "dialog");
    assert.equal(panel.dataset.placement, "chat");
    assert.equal(panel.style.left, "736px");
    assert.equal(panel.style.top, "68px");
    assert.equal(panel.style.width, "280px", "the compact popup does not expand to fill a wide chat");
    assert.ok(parseFloat(panel.style.maxHeight) < 660, "the popup leaves the lower chat visible");
    assert.deepEqual(
        [...panel.querySelectorAll(".bcmv-actions button")].map((b) => b.textContent),
        ["기본 배치", "보조 방송 정렬"]
    );
    assert.equal(panel.querySelector("input, select, [data-action='main'], [data-action='reset-delay']"), null);
    assert.equal(panel.querySelectorAll(".bcmv-stream").length, 6);
    assert.equal(panel.querySelector(".bcmv-stream").dataset.channel, A);
    assert.equal(panel.querySelector('.bcmv-stream[data-main="1"] [data-action="remove"]'), null);
    assert.equal(panel.querySelector('.bcmv-stream[data-main="1"] [data-bcmv-delay]'), null);
    assert.equal(panel.querySelector('.bcmv-stream[data-main="1"] [data-delta]'), null);
    assert.equal(panel.querySelectorAll('[data-action="delay"]').length, 10);
    const row = (id) => panel.querySelector(`.bcmv-stream[data-channel="${id}"]`);
    assert.match(row(B).querySelector("[data-bcmv-delay]").textContent, /4.0s/);
    assert.match(row(C).querySelector("[data-bcmv-delay]").textContent, /7.0s/);
    const removeB = row(B).querySelector('[data-action="remove"]');
    removeB.focus();
    h.emitStorage(C, { version: 2, basis: "live-edge-clock", delaySeconds: 9 });
    await tick();
    assert.equal(d.activeElement, removeB, "timing updates do not replace focused list controls");
    assert.match(row(B).querySelector("[data-bcmv-delay]").textContent, /4.0s/);
    assert.match(row(C).querySelector("[data-bcmv-delay]").textContent, /9.0s/);
    const other = videos[2],
        requests = h.requests.length;
    removeB.click();
    assert.equal(d.querySelector(".bcmv-panel"), panel);
    assert.equal(panel.hidden, false);
    assert.equal(row(B), null);
    assert.equal(h.instances[0].destroyed, true);
    assert.equal(d.querySelector(`[data-bcmv-channel="${C}"] video`), other);
    assert.equal(h.requests.length, requests);
    assert.equal(h.storage[key(B)].delaySeconds, 4);
    while (panel.querySelector('[data-action="remove"]')) panel.querySelector('[data-action="remove"]').click();
    assert.equal(panel.hidden, false);
    assert.match(panel.textContent, /추가한 서브 방송이 없어요/);
    assert.equal(panel.querySelector('[data-action="equalize-layout"]').disabled, true);
    assert.equal(d.querySelectorAll("video").length, 1);
    assert.equal(d.activeElement.getAttribute("aria-label"), "닫기");
    h.click("close-panel");
    assert.equal(panel.hidden, true);
});

test("popup sync buttons adjust each secondary by 0.1s without starting a row drag or replacing focused controls", async (t) => {
    const local = {
        [key(B)]: { version: 2, basis: "live-edge-clock", delaySeconds: 5 },
        [key(C)]: { version: 2, basis: "live-edge-clock", delaySeconds: 7 },
    };
    const h = setup(t, { local });
    await h.start();
    await h.add(B);
    await h.add(C);
    h.click("controls");
    const d = h.w.document,
        g = panelGestures(h);
    const controls = g.row(B).querySelectorAll('[data-action="delay"]');
    assert.deepEqual(
        [...controls].map((button) => button.textContent),
        ["−0.1s", "+0.1s"]
    );
    const [minus, plus] = controls;
    assert.equal(plus.type, "button");
    assert.equal(plus.getAttribute("aria-label"), "싱크 늦추기 0.1s");
    const videos = [...d.querySelectorAll("video")],
        mainTime = videos[0].currentTime;
    const requests = h.requests.length,
        before = h.w.sessionStorage.getItem("betterChzzkMultiviewSession");
    g.pointer("pointerdown", B, plus);
    g.pointer("pointermove", A);
    assert.equal(g.panel.dataset.listDragging, undefined);
    g.pointer("pointerup", A);
    assert.equal(d.activeElement?.classList.contains("bcmv-stream-move"), false);
    plus.focus();
    plus.click();
    plus.click();
    await tick();
    assert.equal(h.storage[key(B)].delaySeconds, 5.2);
    assert.equal(d.querySelector(`[data-bcmv-channel="${B}"] video`).currentTime, 114.8);
    assert.match(g.row(B).querySelector("[data-bcmv-delay]").textContent, /5.2s/);
    assert.equal(d.activeElement, plus);
    assert.equal(g.panel.hidden, false);
    assert.equal(h.storage[key(C)].delaySeconds, 7);
    assert.equal(videos[0].currentTime, mainTime);
    assert.equal(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"), before);
    minus.click();
    await tick();
    assert.equal(h.storage[key(B)].delaySeconds, 5.1);
    d.querySelector(`[data-bcmv-channel="${B}"] [data-delta="-0.1"]`).click();
    await tick();
    assert.equal(h.storage[key(B)].delaySeconds, 5);
    assert.match(g.row(B).querySelector("[data-bcmv-delay]").textContent, /5.0s/);
    assert.deepEqual([...d.querySelectorAll("video")], videos);
    assert.equal(h.requests.length, requests);
    g.row(B).querySelector('[data-action="remove"]').click();
    plus.click();
    await tick();
    assert.equal(h.storage[key(B)].delaySeconds, 5, "a removed row cannot adjust a stale player");
});

test("secondary list follows screen rows rather than insertion or split traversal order", async (t) => {
    const D = "d".repeat(32),
        E = "e".repeat(32);
    const branch = (axis, ratio, a, b) => ({ axis, ratio, a, b });
    const savedSession = {
        version: 1,
        layoutVersion: 3,
        active: true,
        customLayout: true,
        channels: [A, B, C, D, E].map((id, i) => ({ id, volume: (i + 1) / 10, muted: i > 0 })),
        dockTree: branch("rows", 0.5, A, branch("columns", 0.5, branch("rows", 0.5, D, B), branch("rows", 0.5, C, E))),
    };
    const local = { [key(B)]: { version: 2, basis: "live-edge-clock", delaySeconds: 4 } };
    const h = setup(t, { savedSession, local });
    await tick();
    const d = h.w.document,
        host = d.querySelector("[data-bcmv-host]");
    host.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 });
    d.querySelector(".bcmv-grid").getBoundingClientRect = host.getBoundingClientRect;
    h.click("controls");
    const order = () => [...d.querySelectorAll(".bcmv-stream:not([data-main])")].map((row) => row.dataset.channel);
    assert.equal(d.querySelector(".bcmv-stream").dataset.channel, A);
    assert.deepEqual(order(), [D, C, B, E]);
    const videos = [...d.querySelectorAll("video")],
        audio = videos.map((v) => [v.volume, v.muted]);
    const requests = h.requests.length,
        writes = h.writes.length;
    const button = d.querySelector(`.bcmv-stream[data-channel="${B}"] [data-action="remove"]`);
    button.focus();
    const handle = d.querySelector('.bcmv-separator[data-path="rba"]');
    handle.dispatchEvent(new h.w.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    assert.deepEqual(order(), [D, C, E, B], "an independently resized lower row follows its new height");
    assert.equal(d.activeElement, button, "reordering retains the focused channel action");
    const pointer = (target, type, y) =>
        target.dispatchEvent(
            new h.w.MouseEvent(type, {
                button: 0,
                clientX: 100,
                clientY: y,
                bubbles: true,
                cancelable: true,
            })
        );
    const beforeResize = h.w.sessionStorage.getItem("betterChzzkMultiviewSession");
    pointer(handle, "pointerdown", 453);
    pointer(h.w, "pointermove", 360);
    assert.equal(d.querySelector(".bcmv-panel").hidden, true, "interacting outside closes the popup");
    assert.equal(
        h.w.sessionStorage.getItem("betterChzzkMultiviewSession"),
        beforeResize,
        "resize preview is not committed"
    );
    pointer(h.w, "pointercancel", 360);
    h.click("controls");
    assert.deepEqual(order(), [D, C, E, B], "cancel preserves the committed order");
    pointer(handle, "pointerdown", 453);
    pointer(h.w, "pointermove", 360);
    pointer(h.w, "pointerup", 360);
    h.click("controls");
    assert.deepEqual(order(), [D, C, B, E]);
    const saved = JSON.parse(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"));
    assert.deepEqual(
        saved.channels.map((entry) => entry.id),
        [A, B, C, D, E],
        "main identity and add order are not rewritten"
    );
    assert.deepEqual([...d.querySelectorAll("video")], videos);
    assert.deepEqual(
        videos.map((v) => [v.volume, v.muted]),
        audio
    );
    assert.equal(h.requests.length, requests);
    assert.equal(h.writes.length, writes);
    assert.deepEqual(h.storage, local);
    assert.match(d.querySelector(`.bcmv-stream[data-channel="${B}"] [data-bcmv-delay]`).textContent, /4.0s/);
    const restored = setup(t, { savedSession: saved, local });
    await tick();
    restored.click("controls");
    assert.deepEqual(
        [...restored.w.document.querySelectorAll(".bcmv-stream:not([data-main])")].map((row) => row.dataset.channel),
        [D, C, B, E]
    );
    d.querySelector(`.bcmv-stream[data-channel="${B}"] [data-action="remove"]`).click();
    assert.equal(d.querySelector(`[data-bcmv-channel="${B}"]`), null);
    assert.deepEqual(order(), [D, C, E]);
});

function panelGestures(h) {
    const d = h.w.document,
        panel = d.querySelector(".bcmv-panel");
    const rows = () => [...panel.querySelectorAll(".bcmv-stream")];
    panel.getBoundingClientRect = () => ({ left: 100, top: 40, right: 420, bottom: 650, width: 320, height: 610 });
    for (const row of rows())
        row.getBoundingClientRect = () => {
            const top = 100 + rows().indexOf(row) * 75;
            return { left: 110, top, right: 410, bottom: top + 75, width: 300, height: 75 };
        };
    const row = (id) => panel.querySelector(`.bcmv-stream[data-channel="${id}"]`);
    const pointer = (type, id, target = h.w, pointerId = 7) => {
        const bounds = row(id)?.getBoundingClientRect();
        const event = new h.w.MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: bounds ? bounds.left + 100 : 500,
            clientY: bounds ? bounds.top + 35 : 680,
        });
        Object.defineProperty(event, "pointerId", { value: pointerId });
        target.dispatchEvent(event);
        return event;
    };
    const start = (id) => pointer("pointerdown", id, row(id).querySelector(".bcmv-stream-name"));
    const key = (value) =>
        d.activeElement.dispatchEvent(
            new h.w.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })
        );
    return { panel, row, pointer, start, key, order: () => rows().map((row) => row.dataset.channel) };
}

test("settings list reorders spatial slots on drop while keeping geometry, audio positions and channel delays", async (t) => {
    const D = "d".repeat(32),
        E = "e".repeat(32);
    const branch = (axis, ratio, a, b) => ({ axis, ratio, a, b });
    const savedSession = {
        version: 1,
        layoutVersion: 3,
        active: true,
        customLayout: true,
        channels: [A, B, C, D, E].map((id, i) => ({ id, volume: (i + 1) / 10, muted: i !== 3 })),
        dockTree: branch("rows", 0.5, A, branch("columns", 0.5, branch("rows", 0.5, D, B), branch("rows", 0.5, C, E))),
    };
    const local = { [key(B)]: { version: 2, basis: "live-edge-clock", delaySeconds: 4 } };
    const h = setup(t, { savedSession, local });
    await tick();
    h.click("controls");
    const g = panelGestures(h),
        d = h.w.document;
    assert.deepEqual(g.order(), [A, D, C, B, E]);
    const videos = [...d.querySelectorAll("video")],
        audio = videos.map((v) => [v.volume, v.muted]);
    const before = h.w.sessionStorage.getItem("betterChzzkMultiviewSession"),
        requests = h.requests.length;
    g.start(B);
    g.pointer("pointermove", D);
    assert.equal(g.row(D).dataset.drop, "before");
    assert.equal(g.row(B).dataset.moving, "1");
    assert.deepEqual(g.order(), [A, D, C, B, E], "preview does not mutate the committed list");
    assert.equal(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"), before);
    assert.deepEqual(
        videos.map((v) => [v.volume, v.muted]),
        audio
    );
    g.pointer("pointerup", D);
    assert.deepEqual(g.order(), [A, B, D, C, E]);
    const saved = JSON.parse(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"));
    const tree = h.w.BetterChzzk.multiviewModel.treeLayout;
    assert.deepEqual(
        tree(saved.dockTree).cells.map((c) => c.rect),
        tree(savedSession.dockTree).cells.map((c) => c.rect)
    );
    assert.deepEqual([...d.querySelectorAll("video")], videos);
    assert.equal(h.requests.length, requests);
    assert.deepEqual(h.storage, local);
    assert.equal(h.writes.length, 0);
    const sound = (id) => {
        const v = d.querySelector(`[data-bcmv-channel="${id}"] video`);
        return [v.volume, v.muted];
    };
    assert.deepEqual(sound(B), [0.4, false]);
    assert.deepEqual(sound(D), [0.3, true]);
    assert.deepEqual(sound(C), [0.2, true]);
    assert.match(g.row(B).querySelector("[data-bcmv-delay]").textContent, /4.0s/);
    assert.equal(d.activeElement, g.row(B).querySelector(".bcmv-stream-move"));
    assert.equal(g.panel.hidden, false);
    g.start(B);
    g.pointer("pointermove", E);
    assert.equal(g.row(E).dataset.drop, "after");
    g.pointer("pointerup", E);
    assert.deepEqual(g.order(), [A, D, C, E, B]);
    const restored = setup(t, {
        savedSession: JSON.parse(h.w.sessionStorage.getItem("betterChzzkMultiviewSession")),
        local,
    });
    await tick();
    restored.click("controls");
    assert.deepEqual(panelGestures(restored).order(), g.order());
});

test("settings list promotes a secondary through the native router, restores its popup and rejects unavailable navigation", async (t) => {
    const h = setup(t, { local: { [key(B)]: { version: 1, delaySeconds: 9 } } });
    await h.start();
    await h.add(B);
    await h.add(C);
    const d = h.w.document,
        main = d.querySelector(".webplayer-internal-video"),
        sub = d.querySelector(`[data-bcmv-channel="${B}"] video`);
    main.volume = 0.8;
    main.muted = false;
    sub.volume = 0.15;
    sub.muted = true;
    h.click("controls");
    let g = panelGestures(h);
    const before = h.w.sessionStorage.getItem("betterChzzkMultiviewSession"),
        time = main.currentTime;
    g.start(B);
    g.pointer("pointermove", A);
    assert.equal(g.row(A).dataset.drop, "swap");
    g.pointer("pointerup", A);
    assert.deepEqual(g.order(), [A, B, C]);
    assert.match(g.panel.textContent, /페이지 내부 이동을 사용할 수 없어요/);
    assert.equal(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"), before);
    assert.deepEqual([main.volume, main.muted, sub.volume, sub.muted], [0.8, false, 0.15, true]);
    const navigations = [];
    h.evalFile("features/routeBridgePage.js");
    d.querySelector("#sidebar").__reactFiber$list = {
        memoizedProps: {
            value: {
                basename: "/",
                navigator: {
                    push(value) {
                        navigations.push(value.pathname);
                        h.navigate(value.pathname.split("/").pop());
                    },
                    replace() {},
                    go() {},
                    createHref() {},
                },
            },
        },
    };
    g.start(B);
    g.pointer("pointermove", A);
    g.pointer("pointerup", A);
    await tick();
    g = panelGestures(h);
    assert.deepEqual(navigations, [`/live/${B}`]);
    assert.equal(g.panel.hidden, false);
    assert.equal(g.order()[0], B);
    assert.equal(g.row(A).dataset.main, undefined);
    assert.equal(d.activeElement, g.row(B).querySelector(".bcmv-stream-move"));
    assert.equal(main.currentTime, time, "B delay cannot touch the old main source");
    h.media(main).src = "blob:b";
    main.dispatchEvent(new h.w.Event("loadedmetadata"));
    await tick();
    assert.equal(main.currentTime, 111);
    assert.deepEqual([main.volume, main.muted], [0.8, false]);
    const demoted = d.querySelector(`[data-bcmv-channel="${A}"] video`);
    assert.deepEqual([demoted.volume, demoted.muted], [0.15, true]);
    assert.equal(h.storage[key(B)].delaySeconds, 9);
    // Dragging the main row to a secondary also exchanges main ownership.
    g.start(B);
    g.pointer("pointermove", A);
    g.pointer("pointerup", A);
    await tick();
    assert.deepEqual(navigations, [`/live/${B}`, `/live/${A}`]);
    assert.equal(panelGestures(h).order()[0], A);
});

test("settings list supports keyboard moves and cancels pointer gestures without committing", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    await h.add(C);
    const d = h.w.document;
    h.click("controls");
    let g = panelGestures(h);
    g.row(C).querySelector(".bcmv-stream-move").focus();
    g.key(" ");
    g.key("ArrowUp");
    assert.equal(g.row(B).dataset.drop, "before");
    g.key("Enter");
    assert.deepEqual(g.order(), [A, C, B]);
    const before = h.w.sessionStorage.getItem("betterChzzkMultiviewSession");
    for (const cancel of ["pointercancel", "blur", "Escape", "outside", "contextmenu", "Tab"]) {
        g.start(B);
        g.pointer("pointermove", C);
        if (cancel === "pointercancel") g.pointer("pointercancel", C);
        else if (cancel === "blur") h.w.dispatchEvent(new h.w.Event("blur"));
        else if (cancel === "outside") g.pointer("pointermove", "missing");
        else if (cancel === "contextmenu")
            g.row(C).dispatchEvent(new h.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        else g.key(cancel);
        g.pointer("pointerup", cancel === "outside" ? "missing" : C);
        assert.deepEqual(g.order(), [A, C, B], cancel);
        assert.equal(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"), before, cancel);
        assert.equal(g.panel.querySelector("[data-moving],[data-drop]"), null, cancel);
        assert.equal(g.panel.hidden, false, cancel);
    }
    g.start(B);
    g.pointer("pointermove", C, h.w, 99);
    g.pointer("pointerup", C, h.w, 99);
    assert.equal(g.panel.querySelector("[data-moving]"), null, "another pointer cannot start the preview");
    g.pointer("pointercancel", B);
    const remove = g.row(B).querySelector('[data-action="remove"]');
    g.pointer("pointerdown", B, remove);
    assert.equal(g.panel.dataset.listDragging, undefined);
    g.start(B);
    g.pointer("pointermove", C);
    h.configure(false);
    g.pointer("pointerup", C);
    assert.equal(d.querySelector(".bcmv-panel"), null);
    h.configure(true);
    await tick();
    h.click("controls");
    g = panelGestures(h);
    assert.deepEqual(g.order(), [A, C, B]);
    g.start(B);
    g.pointer("pointermove", C);
    const native = d.querySelector(".chzzk_player");
    native.replaceWith(native.cloneNode(true));
    await tick();
    g.pointer("pointerup", C);
    g = panelGestures(h);
    assert.deepEqual(g.order(), [A, C, B]);
    assert.equal(g.panel.querySelector("[data-moving]"), null);
    g.start(B);
    g.pointer("pointermove", C);
    h.navigate("not-a-channel");
    g.pointer("pointerup", C);
    assert.equal(d.querySelector(".bcmv-panel"), null);
});

test("settings list scrolls only during an active edge drag and cancels its animation on close", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    await h.add(C);
    h.click("controls");
    const g = panelGestures(h),
        frames = new Map();
    let frameId = 0;
    h.w.requestAnimationFrame = (callback) => {
        frames.set(++frameId, callback);
        return frameId;
    };
    h.w.cancelAnimationFrame = (id) => frames.delete(id);
    g.panel.getBoundingClientRect = () => ({ left: 100, top: 40, right: 420, bottom: 260, width: 320, height: 220 });
    Object.defineProperties(g.panel, { clientHeight: { value: 220 }, scrollHeight: { value: 450 } });
    for (const [index, id] of [A, B, C].entries())
        g.row(id).getBoundingClientRect = () => {
            const top = 100 + index * 75 - g.panel.scrollTop;
            return { left: 110, top, right: 410, bottom: top + 75, width: 300, height: 75 };
        };
    g.panel.scrollTop = 100;
    const before = h.w.sessionStorage.getItem("betterChzzkMultiviewSession");
    g.start(B);
    const move = new h.w.MouseEvent("pointermove", { clientX: 200, clientY: 50, bubbles: true, cancelable: true });
    Object.defineProperty(move, "pointerId", { value: 7 });
    h.w.dispatchEvent(move);
    for (let step = 0; step < 3; step++) {
        const [id, callback] = frames.entries().next().value;
        frames.delete(id);
        callback(step * 16);
    }
    assert.equal(g.panel.scrollTop, 82);
    assert.equal(g.row(A).dataset.drop, "swap");
    assert.equal(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"), before);
    assert.equal(frames.size, 1);
    h.click("close-panel");
    assert.equal(frames.size, 0);
    assert.equal(g.panel.hidden, true);
    g.pointer("pointerup", A);
    assert.equal(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"), before);
});

test("chat popup follows resize and remounts, closes accessibly, and cleans its observers", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    const d = h.w.document,
        host = d.querySelector("[data-bcmv-host]");
    host.getBoundingClientRect = () => ({ left: 0, right: 700, top: 60, bottom: 600, width: 700, height: 540 });
    const observers = [];
    h.w.ResizeObserver = class {
        targets = new Set();
        constructor(callback) {
            this.callback = callback;
            observers.push(this);
        }
        observe(target) {
            this.targets.add(target);
        }
        disconnect() {
            this.targets.clear();
        }
    };
    let chat = d.querySelector("#aside-chatting");
    const initialBounds = () => ({ left: 700, right: 1024, top: 60, bottom: 720, width: 324, height: 660 });
    chat.getBoundingClientRect = initialBounds;
    h.click("controls");
    let panel = d.querySelector(".bcmv-panel");
    assert.equal(d.activeElement.getAttribute("aria-label"), "닫기");
    assert.ok(observers.some((o) => o.targets.has(chat)));
    chat.getBoundingClientRect = () => ({ left: 760, right: 1024, top: 96, bottom: 720, width: 264, height: 624 });
    h.w.dispatchEvent(new h.w.Event("resize"));
    assert.equal(panel.style.left, "768px");
    assert.equal(panel.style.top, "104px");
    const oldChat = chat,
        replacement = chat.cloneNode(true);
    replacement.getBoundingClientRect = initialBounds;
    chat.replaceWith(replacement);
    chat = replacement;
    await tick();
    assert.equal(panel.style.top, "68px");
    assert.ok(observers.every((o) => !o.targets.has(oldChat)));
    assert.ok(observers.some((o) => o.targets.has(chat)));
    chat.remove();
    await tick();
    assert.equal(panel.dataset.placement, "player");
    assert.equal(panel.style.left, "412px");
    const native = d.querySelector(".chzzk_player"),
        video = d.querySelector("[data-bcmv-video]");
    native.replaceWith(native.cloneNode(true));
    await tick();
    assert.equal(d.querySelectorAll(".bcmv-panel").length, 1);
    panel = d.querySelector(".bcmv-panel");
    assert.equal(panel.hidden, false);
    assert.equal(d.querySelector("[data-bcmv-video]"), video);
    panel.dispatchEvent(new h.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(panel.hidden, true);
    assert.equal(
        d.activeElement,
        d.querySelector("#betterchzzk-multiview-launcher"),
        "closing without chat returns focus to the player toggle"
    );
    assert.ok(observers.every((o) => [...o.targets].every((target) => target === host)));
    d.body.append(chat);
    await waitForChatUi(() => d.querySelector("#betterchzzk-multiview-chat-settings"));
    h.click("controls");
    d.body.dispatchEvent(new h.w.MouseEvent("pointerdown", { bubbles: true }));
    assert.equal(panel.hidden, true);
    h.click("controls");
    h.navigate("");
    assert.equal(d.querySelector(".bcmv-panel"), null);
    assert.ok(observers.every((o) => o.targets.size === 0));
    h.configure(false);
    h.w.dispatchEvent(new h.w.Event("resize"));
    assert.equal(d.querySelector(".bcmv-panel"), null);
});

test("video context menu toggles its audio and video drag swaps slots without replacing streams", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    await h.add(C);
    const d = h.w.document,
        b = d.querySelector(`[data-bcmv-channel="${B}"] video`),
        c = d.querySelector(`[data-bcmv-channel="${C}"] video`),
        main = d.querySelector(".webplayer-internal-video");
    const context = () => new h.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    assert.equal(b.dispatchEvent(context()), false);
    const panel = d.querySelector(".bcmv-panel");
    assert.equal(panel.hidden, true);
    assert.equal(b.muted, false);
    assert.equal(c.muted, true);
    assert.equal(c.dispatchEvent(context()), false);
    assert.equal(c.muted, false);
    assert.equal(b.muted, false);
    assert.equal(main.dispatchEvent(context()), true, "native context menu remains available");
    const slider = d.querySelector(`[data-bcmv-channel="${B}"] input`);
    assert.equal(slider.dispatchEvent(context()), false);
    assert.equal(b.muted, true, "controls over the video belong to the same secondary audio");
    assert.equal(panel.hidden, true);
    const drag = (node, type) => {
        const event = new h.w.MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: type === "pointerdown" ? 0 : 10,
        });
        return node.dispatchEvent(event);
    };
    assert.equal(b.draggable, false, "moving video does not rely on native HTML drag events");
    assert.equal(drag(slider, "pointerdown"), true, "volume interaction cannot start a stream drag");
    assert.equal(d.querySelector("[data-dragging]"), null);
    drag(b, "pointerdown");
    drag(b, "pointermove");
    assert.ok(d.querySelector("[data-dragging]"));
    assert.equal(drag(c, "pointermove"), false);
    drag(c, "pointerup");
    assert.equal(d.querySelector("[data-dragging]"), null);
    assert.deepEqual(
        Array.from(
            h.w.BetterChzzk.multiviewModel.treeLayout(
                JSON.parse(h.w.sessionStorage.getItem("betterChzzkMultiviewSession")).dockTree
            ).cells,
            (x) => x.id
        ).filter(Boolean),
        [A, C, B]
    );
    assert.equal(d.querySelector(`[data-bcmv-channel="${B}"] video`), b);
    assert.equal(d.querySelector(`[data-bcmv-channel="${C}"] video`), c);
    assert.equal(h.instances.length, 2);
    drag(b, "pointerdown");
    drag(b, "pointercancel");
    assert.equal(d.querySelector("[data-dragging]"), null);
    drag(b, "pointerdown");
    h.configure(false);
    assert.equal(d.querySelector("[data-dragging]"), null);
});

test("secondary right-click audio survives a document capture blocker and leaves other context menus alone", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    const d = h.w.document,
        video = d.querySelector("video[data-bcmv-video]"),
        main = d.querySelector(".webplayer-internal-video");
    let blocked = 0;
    // The installed DragFree 10.1 releaseDrag.js stops contextmenu at document capture.
    const blocker = (event) => {
        blocked++;
        event.stopPropagation();
    };
    d.addEventListener("contextmenu", blocker, true);
    t.after(() => d.removeEventListener("contextmenu", blocker, true));
    const context = () => new h.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    const original = JSON.parse(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"));
    assert.equal(video.dispatchEvent(context()), false, "cancel the browser video menu before document interception");
    assert.equal(blocked, 0);
    assert.equal(d.querySelector(".bcmv-panel").hidden, true);
    assert.equal(video.muted, false);
    original.channels[1].muted = false;
    assert.deepEqual(JSON.parse(h.w.sessionStorage.getItem("betterChzzkMultiviewSession")), original);
    assert.equal(video.dispatchEvent(context()), false);
    assert.equal(video.muted, true);
    h.click("controls");
    h.click("add");
    const input = d.querySelector('.bcmv-panel input[type="url"]');
    assert.equal(input.dispatchEvent(context()), true);
    assert.equal(main.dispatchEvent(context()), true);
    assert.equal(blocked, 2, "settings inputs and native main keep their original event flow");
    h.click("close-panel");
    video.dispatchEvent(new h.w.MouseEvent("pointerdown", { button: 0, bubbles: true, clientX: 10, clientY: 10 }));
    h.w.dispatchEvent(new h.w.MouseEvent("pointermove", { button: 0, clientX: 30, clientY: 30 }));
    assert.ok(d.querySelector(".bcmv-drop-preview"));
    assert.equal(video.dispatchEvent(context()), false);
    assert.equal(d.querySelector(".bcmv-drop-preview"), null);
    assert.equal(
        d.querySelector(".bcmv-panel").hidden,
        true,
        "window capture still cancels a drag instead of opening settings"
    );
    h.configure(false);
    assert.equal(video.dispatchEvent(context()), true, "detached old videos no longer have an active handler");
    assert.equal(main.dispatchEvent(context()), true);
});

test("drag preview makes room by insertion, uses stable slots, and saves only on drop", async (t) => {
    const h = setup(t);
    await h.start();
    const D = "d".repeat(32),
        E = "e".repeat(32);
    for (const id of [B, C, D, E]) await h.add(id);
    const d = h.w.document,
        grid = d.querySelector(".bcmv-grid");
    grid.getBoundingClientRect = () => ({ left: 0, top: 0, right: 900, bottom: 600, width: 900, height: 600 });
    const cell = (id) => d.querySelector(`[data-bcmv-channel="${id}"]`);
    const videos = [B, C, D, E].map((id) => cell(id).querySelector("video"));
    const saved = () => h.w.sessionStorage.getItem("betterChzzkMultiviewSession");
    const before = saved(),
        original = cell(C).style.top;
    const event = (node, type, x = 0, y = 0) =>
        node.dispatchEvent(
            new h.w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })
        );
    event(videos[0], "pointerdown", 750, 100);
    event(videos[3], "pointermove", 450, 500);
    const guide = d.querySelector(".bcmv-drop-preview");
    assert.equal(guide.hidden, false);
    assert.equal(guide.style.top, cell(B).style.top);
    assert.equal(cell(D).style.top, original, "the intervening stream takes the preceding slot");
    assert.equal(cell(C).style.top, "0%");
    assert.equal(saved(), before, "hovering does not save a speculative order");
    event(videos[1], "pointermove", 450, 500);
    assert.equal(guide.style.top, cell(B).style.top, "a moved DOM target does not change the original hit slot");
    event(grid, "pointermove", 901, 500);
    assert.equal(guide.hidden, true);
    assert.equal(cell(C).style.top, original);
    event(videos[3], "pointermove", 450, 500);
    event(videos[0], "pointercancel");
    assert.equal(saved(), before);
    assert.equal(d.querySelector(".bcmv-drop-preview"), null);
    event(videos[0], "pointerdown", 750, 100);
    event(videos[3], "pointermove", 450, 500);
    event(videos[1], "pointerup", 450, 500);
    assert.deepEqual(
        Array.from(
            h.w.BetterChzzk.multiviewModel.treeLayout(JSON.parse(saved()).dockTree).cells,
            (entry) => entry.id
        ).filter(Boolean),
        [A, C, D, E, B]
    );
    [B, C, D, E].forEach((id, index) => assert.equal(cell(id).querySelector("video"), videos[index]));
    assert.equal(h.instances.length, 4);
    h.click("controls");
    assert.deepEqual(
        [...d.querySelectorAll(".bcmv-stream:not([data-main])")].map((row) => row.dataset.channel),
        [C, D, E, B]
    );
});

test("right click toggles secondary audio and settings open only from the chat header", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    const d = h.w.document,
        cell = d.querySelector(`[data-bcmv-channel="${B}"]`),
        video = cell.querySelector("video"),
        panel = d.querySelector(".bcmv-panel");
    const original = [video.volume, video.muted, video.paused],
        requests = h.requests.length;
    h.instances[0].events.error(null, { fatal: true });
    const error = cell.querySelector(".bcmv-error");
    assert.ok(error.textContent.length > 0);
    for (const target of [
        cell,
        video,
        cell.querySelector(".bcmv-name"),
        error,
        cell.querySelector(".bcmv-controls svg path"),
    ]) {
        const muted = video.muted;
        const event = new h.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
        assert.equal(target.dispatchEvent(event), false);
        assert.equal(video.muted, !muted);
        assert.equal(panel.hidden, true);
    }
    assert.equal(video.volume, original[0]);
    assert.equal(video.paused, original[2]);
    assert.equal(h.requests.length, requests);
    assert.equal(h.writes.length, 0);
    h.click("mute", B);
    assert.equal(video.muted, original[1], "the speaker button toggles the same audio state");
    h.click("controls");
    assert.equal(panel.hidden, false, "the chat button is the keyboard-accessible settings opener");
    assert.ok(panel.querySelector(`.bcmv-stream[data-channel="${B}"]`));
    const row = panel.querySelector(".bcmv-stream");
    assert.equal(
        row.dispatchEvent(new h.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })),
        true
    );
    assert.equal(video.muted, original[1], "popup list context menus cannot toggle audio");
    h.configure(false);
    assert.equal(
        video.dispatchEvent(new h.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })),
        true
    );
    assert.equal(d.querySelector(".bcmv-panel"), null);
});

test("video surface starts moving after a small motion and suppresses the release click", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    await h.add(C);
    const d = h.w.document,
        video = d.querySelector(`[data-bcmv-channel="${B}"] video`);
    assert.equal(d.querySelector(".bcmv-grip"), null);
    const pointer = (target, type, x) =>
        target.dispatchEvent(new h.w.MouseEvent(type, { button: 0, clientX: x, bubbles: true, cancelable: true }));
    const blockedDrag = new h.w.Event("dragstart", { bubbles: true, cancelable: true });
    assert.equal(video.dispatchEvent(blockedDrag), false);
    pointer(video, "pointerdown", 0);
    pointer(video, "pointermove", 4);
    assert.equal(d.querySelector(".bcmv-drop-preview"), null);
    pointer(video, "pointermove", 6);
    assert.ok(d.querySelector(".bcmv-drop-preview"));
    pointer(video, "pointerup", 6);
    const releaseClick = new h.w.MouseEvent("click", { detail: 1, bubbles: true, cancelable: true });
    assert.equal(video.dispatchEvent(releaseClick), false);
    assert.equal(d.querySelector(".bcmv-panel").hidden, true);
    h.click("controls");
    assert.equal(d.querySelector(".bcmv-panel").hidden, false, "keyboard activation can still open position settings");
    h.click("close-panel");
    pointer(video, "pointerdown", 0);
    pointer(video, "pointermove", 6);
    video.dispatchEvent(new h.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(d.querySelector(".bcmv-drop-preview"), null);
});

test("shared divider snaps magnetically, releases with distance, and cancels without saving", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    await h.add(C);
    const d = h.w.document;
    d.querySelector(".bcmv-grid").getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 600 });
    const handle = d.querySelector('.bcmv-separator[data-path="ra"]');
    const event = (target, type, x, y = 0) => {
        const e = new h.w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
        Object.defineProperty(e, "pointerId", { value: 1 });
        target.dispatchEvent(e);
    };
    const saved = () => h.w.sessionStorage.getItem("betterChzzkMultiviewSession");
    const original = saved();
    event(handle, "pointerdown", 600);
    event(h.w, "pointermove", 454);
    const main = d.querySelector('.bcmv-cell[data-main="1"]'),
        sub = d.querySelector(`[data-bcmv-channel="${B}"]`);
    assert.equal(main.style.width, "50%");
    assert.equal(sub.style.left, "50%", "adjacent panes share the resized boundary");
    assert.equal(d.querySelector(".bcmv-snap-guide").hidden, false);
    event(h.w, "pointermove", 462);
    assert.equal(main.style.width, "50%", "small movements stay attached");
    event(h.w, "pointermove", 475);
    assert.ok(parseFloat(main.style.width) > 52);
    assert.equal(d.querySelector(".bcmv-snap-guide").hidden, true);
    event(h.w, "pointercancel", 475);
    assert.equal(saved(), original);
    assert.equal(d.querySelector(".bcmv-snap-guide"), null);
    event(handle, "pointerdown", 600);
    event(h.w, "pointermove", 454);
    event(h.w, "pointerup", 454);
    assert.equal(JSON.parse(saved()).dockTree.a.ratio, 0.5);
    event(handle, "pointerdown", 450);
    event(h.w, "pointermove", 590);
    handle.dispatchEvent(new h.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(main.style.width, "50%");
    assert.equal(JSON.parse(saved()).dockTree.a.ratio, 0.5);
    assert.equal(d.querySelector(".bcmv-snap-guide"), null);
});

test("docking at each edge changes the split geometry and preserves valid channel identities", (t) => {
    const h = setup(t),
        m = h.w.BetterChzzk.multiviewModel;
    const channels = [A, B, C, "d".repeat(32), "e".repeat(32), "f".repeat(32)].map((id) => ({ id }));
    for (let count = 2; count <= 6; count += 1) {
        const tree = m.defaultTree(channels.slice(0, count)),
            view = m.treeLayout(tree);
        assert.equal(m.validTree(tree, channels.slice(0, count)), true);
        for (const cell of view.cells.filter((item) => item.id && item.id !== A)) {
            assert.ok(Math.abs(cell.rect[2] - 1 / 3) < 1e-9);
            assert.ok(Math.abs(cell.rect[3] - 1 / 3) < 1e-9, "default secondary size is one ninth");
        }
        for (const side of ["left", "right", "top", "bottom"]) {
            const changed = m.dockTree(tree, B, A, side, A);
            assert.equal(m.validTree(changed, channels.slice(0, count)), true);
            const cells = m.treeLayout(changed).cells;
            let area = 0;
            cells.forEach(({ rect: [x, y, w, hh] }, index) => {
                area += w * hh;
                assert.ok(w > 0 && hh > 0 && x >= 0 && y >= 0 && x + w <= 1 + 1e-9 && y + hh <= 1 + 1e-9);
                for (const {
                    rect: [xx, yy, ww, h2],
                } of cells.slice(index + 1))
                    assert.ok(
                        Math.min(x + w, xx + ww) - Math.max(x, xx) < 1e-9 ||
                            Math.min(y + hh, yy + h2) - Math.max(y, yy) < 1e-9
                    );
            });
            assert.ok(Math.abs(area - 1) < 1e-9);
            const a = cells.find((item) => item.id === A).rect,
                b = cells.find((item) => item.id === B).rect;
            assert.ok(
                side === "left"
                    ? b[0] < a[0]
                    : side === "right"
                      ? b[0] > a[0]
                      : side === "top"
                        ? b[1] < a[1]
                        : b[1] > a[1]
            );
        }
        assert.equal(m.validTree({ axis: "columns", ratio: Infinity, a: A, b: B }, channels.slice(0, count)), false);
        assert.equal(m.validTree({ axis: "columns", ratio: 0.5, a: A, b: A }, channels.slice(0, count)), false);
    }
});

test("equal alignment divides a secondary region evenly without changing the main or other regions", (t) => {
    const m = setup(t).w.BetterChzzk.multiviewModel;
    const branch = (axis, ratio, a, b) => ({ axis, ratio, a, b });
    const ids = [B, C, "d".repeat(32), "e".repeat(32), "f".repeat(32)];
    for (let count = 2; count <= 5; count++) {
        const entries = [A, ...ids.slice(0, count)].map((id) => ({ id }));
        const uneven = ids
            .slice(0, count)
            .reduceRight(
                (tail, id, index) => (tail ? branch(index % 2 ? "columns" : "rows", 0.3, id, tail) : id),
                null
            );
        for (const [tree, expectedAxis] of [
            [branch("columns", 2 / 3, A, uneven), "rows"],
            [branch("rows", 2 / 3, A, uneven), "columns"],
            [branch("columns", 1 / 3, uneven, A), "rows"],
        ]) {
            const before = JSON.stringify(tree),
                main = m.treeLayout(tree).cells.find((cell) => cell.id === A).rect;
            const result = m.equalizeTree(tree, B, A, 16 / 9);
            assert.equal(JSON.stringify(tree), before, "alignment does not mutate the input layout");
            assert.equal(result.axis, expectedAxis);
            assert.equal(m.validTree(result.tree, entries), true);
            const layout = m.treeLayout(result.tree);
            assert.deepEqual(layout.cells.find((cell) => cell.id === A).rect, main);
            const subs = layout.cells.filter((cell) => cell.id !== A);
            for (const [index, cell] of subs.entries()) {
                assert.ok(Math.abs(cell.rect[2] - subs[0].rect[2]) < 1e-9);
                assert.ok(Math.abs(cell.rect[3] - subs[0].rect[3]) < 1e-9);
                if (index) {
                    const coordinate = expectedAxis === "rows" ? 1 : 0;
                    assert.ok(
                        Math.abs(
                            subs[index - 1].rect[coordinate] +
                                subs[index - 1].rect[coordinate + 2] -
                                cell.rect[coordinate]
                        ) < 1e-9
                    );
                }
            }
            assert.deepEqual(
                m.equalizeTree(result.tree, B, A, 16 / 9).tree,
                result.tree,
                "a second alignment keeps the result"
            );
        }
    }
    const separate = branch(
        "rows",
        0.7,
        branch("columns", 0.65, A, branch("rows", 0.2, B, C)),
        branch("columns", 0.4, ids[2], ids[3])
    );
    const aligned = m.equalizeTree(separate, C, A);
    assert.equal(aligned.tree.b, separate.b, "another secondary region is left untouched");
    assert.deepEqual(Array.from(aligned.ids), [B, C]);
    const withEmpty = branch("columns", 0.65, A, branch("rows", 0.3, B, branch("columns", 0.4, null, C)));
    assert.equal(
        m.treeLayout(m.equalizeTree(withEmpty, B, A).tree).cells.some((cell) => cell.id === null),
        false
    );
    assert.equal(m.equalizeTree(separate, A, A), null);
    assert.equal(m.equalizeTree(separate, "f".repeat(32), A), null);
    assert.equal(m.equalizeTree(branch("columns", 0.7, A, B), B, A), null);
});

test("equal alignment button fixes uneven secondary videos while preserving playback and restoring the result", async (t) => {
    const D = "d".repeat(32),
        E = "e".repeat(32);
    const branch = (axis, ratio, a, b) => ({ axis, ratio, a, b });
    const savedSession = {
        version: 1,
        layoutVersion: 3,
        active: true,
        customLayout: true,
        channels: [A, B, C, D, E].map((id, index) => ({
            id,
            volume: (index + 1) / 10,
            muted: index !== 2,
            position: [index % 2, 1],
        })),
        dockTree: branch(
            "columns",
            2 / 3,
            A,
            branch("rows", 0.35, B, branch("rows", 0.25, C, branch("columns", 0.3, D, E)))
        ),
    };
    const local = { [key(B)]: { version: 2, basis: "live-edge-clock", delaySeconds: 4 } };
    const h = setup(t, { savedSession, local });
    await tick();
    const d = h.w.document,
        host = d.querySelector("[data-bcmv-host]");
    const bounds = () => ({ left: 0, top: 0, width: 900, height: 506.25 });
    host.getBoundingClientRect = bounds;
    d.querySelector("video[data-bcmv-video]").dispatchEvent(new h.w.Event("resize"));
    const nativeStyle = host.style.cssText,
        videos = Array.from(d.querySelectorAll("video")),
        audio = videos.map((video) => [video.volume, video.muted, video.paused]),
        requests = h.requests.length,
        instances = h.instances.length,
        writes = h.writes.length;
    const panel = d.querySelector(".bcmv-panel");
    h.click("controls");
    assert.equal(d.querySelector('[data-action="equalize-layout"]').disabled, false);
    h.click("equalize-layout", B);
    assert.equal(panel.hidden, false, "keep the chat popup open after alignment");
    const cells = Array.from(d.querySelectorAll('.bcmv-cell:not([data-main="1"])'));
    for (const cell of cells) {
        assert.ok(Math.abs(parseFloat(cell.style.width) - 25) < 1e-8);
        assert.ok(Math.abs(parseFloat(cell.style.height) - 25) < 1e-8);
        assert.ok(Math.abs(parseFloat(cell.style.left) - 70.83333333333333) < 1e-8);
    }
    assert.equal(host.style.cssText, nativeStyle);
    assert.deepEqual(Array.from(d.querySelectorAll("video")), videos);
    assert.deepEqual(
        videos.map((video) => [video.volume, video.muted, video.paused]),
        audio
    );
    assert.equal(h.requests.length, requests);
    assert.equal(h.instances.length, instances);
    assert.equal(h.writes.length, writes);
    assert.deepEqual(h.storage, local);
    const saved = JSON.parse(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"));
    assert.deepEqual(saved.channels[0], savedSession.channels[0]);
    assert.ok(saved.channels.slice(1).every((entry) => entry.position.every((value) => value === 0.5)));
    const restored = setup(t, { savedSession: saved, local });
    await tick();
    restored.w.document.querySelector("[data-bcmv-host]").getBoundingClientRect = bounds;
    restored.w.document.querySelector("video[data-bcmv-video]").dispatchEvent(new restored.w.Event("resize"));
    assert.deepEqual(
        Array.from(
            restored.w.document.querySelectorAll('.bcmv-cell:not([data-main="1"])'),
            (cell) => cell.style.cssText
        ),
        cells.map((cell) => cell.style.cssText)
    );
    const divider = d.querySelector('[data-path="rb"]');
    divider.dispatchEvent(new h.w.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    assert.notEqual(cells[0].style.height, cells[1].style.height, "manual resizing remains available after alignment");
    const single = setup(t);
    await single.start();
    await single.add(B);
    single.click("controls");
    assert.equal(single.w.document.querySelector('[data-action="equalize-layout"]').disabled, true);
});

test("moving the main exchanges intact sibling groups without changing any video dimensions", (t) => {
    const m = setup(t).w.BetterChzzk.multiviewModel;
    const branch = (axis, ratio, a, b) => ({ axis, ratio, a, b });
    const ids = [B, C, "d".repeat(32), "e".repeat(32), "f".repeat(32)];
    for (let count = 1; count <= 5; count++) {
        const group = ids
            .slice(0, count)
            .reduceRight(
                (tail, id, index) => (tail ? branch(index % 2 ? "rows" : "columns", 0.3, id, tail) : id),
                null
            );
        const channels = [A, ...ids.slice(0, count)].map((id) => ({ id }));
        for (const axis of ["rows", "columns"]) {
            const tree = branch(axis, 0.7, A, group),
                before = m.treeLayout(tree).cells;
            const result = m.moveMainTree(tree, A, B);
            assert.equal(result.side, axis === "rows" ? "bottom" : "right");
            assert.equal(result.tree.a, group);
            assert.equal(result.tree.b, A);
            assert.equal(m.validTree(result.tree, channels), true);
            const after = m.treeLayout(result.tree).cells;
            const coordinate = axis === "rows" ? 1 : 0;
            for (const cell of before) {
                const moved = after.find((item) => item.id === cell.id);
                assert.ok(Math.abs(cell.rect[2] - moved.rect[2]) < 1e-9);
                assert.ok(Math.abs(cell.rect[3] - moved.rect[3]) < 1e-9);
                assert.ok(
                    Math.abs(moved.rect[coordinate] - cell.rect[coordinate] - (cell.id === A ? 0.3 : -0.7)) < 1e-9
                );
            }
            const returned = m.moveMainTree(result.tree, A, B);
            assert.equal(returned.side, axis === "rows" ? "top" : "left");
            assert.equal(returned.tree.b, group);
            assert.ok(Math.abs(returned.tree.ratio - tree.ratio) < 1e-9);
        }
    }
    const group = branch("columns", 0.4, B, C);
    const nested = branch("columns", 0.8, branch("rows", 0.7, A, group), ids[2]);
    const moved = m.moveMainTree(nested, A, B);
    assert.equal(moved.path, "ra");
    assert.equal(moved.tree.b, nested.b);
    assert.equal(moved.tree.a.a, group);
    const empty = branch("rows", 0.7, A, null);
    assert.equal(m.moveMainTree(empty, A, null, "rb").tree.a, null);
    assert.equal(m.moveMainTree(empty, A, null, "wrong"), null);
    assert.equal(m.moveMainTree(A, A, A), null);
    assert.equal(m.moveMainTree(nested, A, A), null);
});

test("dragging the native main below a secondary row previews, cancels and persists without navigating", async (t) => {
    const D = "d".repeat(32);
    const group = { axis: "columns", ratio: 1 / 3, a: B, b: { axis: "columns", ratio: 0.5, a: C, b: D } };
    const savedSession = {
        version: 1,
        layoutVersion: 3,
        active: true,
        customLayout: true,
        channels: [A, B, C, D].map((id, i) => ({ id, volume: 0.2 + i / 10, muted: i !== 0, position: [0.5, 0.5] })),
        dockTree: { axis: "rows", ratio: 0.7, a: A, b: group },
    };
    const h = setup(t, { savedSession });
    await tick();
    const d = h.w.document,
        host = d.querySelector("[data-bcmv-host]"),
        native = d.querySelector("[data-bcmv-native]"),
        video = native.querySelector("video"),
        grid = d.querySelector(".bcmv-grid");
    const bounds = () => ({ left: 0, top: 0, width: 900, height: 506.25 });
    host.getBoundingClientRect = grid.getBoundingClientRect = bounds;
    video.dispatchEvent(new h.w.Event("resize"));
    const initialStyle = host.style.cssText,
        cells = Array.from(grid.querySelectorAll(".bcmv-cell"));
    const sizes = cells.map((cell) => [cell.style.width, cell.style.height]);
    const videos = Array.from(d.querySelectorAll("video")),
        audio = videos.map((node) => [node.volume, node.muted, node.paused]);
    const requests = h.requests.length,
        instances = h.instances.length;
    const saved = () => h.w.sessionStorage.getItem("betterChzzkMultiviewSession");
    const original = saved();
    let navigation = 0,
        clicks = 0;
    d.addEventListener("betterchzzk:multiview-navigate", () => navigation++);
    native.addEventListener("click", () => clicks++);
    const pointer = (target, type, x, y) =>
        target.dispatchEvent(
            new h.w.MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true })
        );
    for (const cancel of ["Escape", "contextmenu", "pointercancel"]) {
        pointer(video, "pointerdown", 450, 170);
        pointer(h.w, "pointermove", 450, 480);
        assert.match(d.querySelector(".bcmv-drop-preview").textContent, /메인 아래에 배치/);
        assert.ok(Math.abs(parseFloat(host.style.getPropertyValue("--bcmv-main-top")) - 30) < 1e-8);
        assert.equal(saved(), original);
        const guide = d.querySelector(".bcmv-drop-preview").style.cssText;
        pointer(h.w, "pointermove", 850, 480);
        assert.equal(
            d.querySelector(".bcmv-drop-preview").style.cssText,
            guide,
            "all members of the row target the same group"
        );
        if (cancel === "Escape")
            h.w.dispatchEvent(new h.w.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
        else
            h.w.dispatchEvent(
                new h.w.MouseEvent(cancel, { button: cancel === "contextmenu" ? 2 : 0, cancelable: true })
            );
        pointer(h.w, "pointerup", 850, 480);
        assert.equal(host.style.cssText, initialStyle);
        assert.equal(saved(), original);
    }
    pointer(video, "pointerdown", 450, 170);
    const htmlDrag = new h.w.Event("dragstart", { bubbles: true, cancelable: true });
    assert.equal(video.dispatchEvent(htmlDrag), false);
    pointer(h.w, "pointermove", 450, 480);
    pointer(h.w, "pointerup", 450, 480);
    native.dispatchEvent(new h.w.MouseEvent("click", { bubbles: true, detail: 1 }));
    assert.equal(clicks, 0, "drag release must not toggle native playback");
    const result = JSON.parse(saved());
    assert.deepEqual(result.dockTree.a, group);
    assert.equal(result.dockTree.b, A);
    const expectedChannels = structuredClone(savedSession.channels);
    [expectedChannels[0].volume, expectedChannels[2].volume] = [expectedChannels[2].volume, expectedChannels[0].volume];
    [expectedChannels[0].muted, expectedChannels[2].muted] = [expectedChannels[2].muted, expectedChannels[0].muted];
    assert.deepEqual(result.channels, expectedChannels);
    assert.equal(navigation, 0);
    assert.equal(h.w.location.pathname, `/live/${A}`);
    assert.equal(d.querySelector("#native-chat").textContent, "원래 채팅");
    assert.equal(d.querySelector("#native-info").textContent, "원래 방송 제목과 상호작용");
    assert.equal(native.parentElement, host);
    assert.deepEqual(Array.from(d.querySelectorAll("video")), videos);
    assert.deepEqual(
        videos.map((node) => [node.volume, node.muted, node.paused]),
        [audio[2], audio[1], audio[0], audio[3]]
    );
    assert.equal(h.requests.length, requests);
    assert.equal(h.instances.length, instances);
    cells.forEach((cell, i) =>
        sizes[i].forEach((value, axis) =>
            assert.ok(Math.abs(parseFloat(value) - parseFloat(cell.style[axis ? "height" : "width"])) < 1e-8)
        )
    );
    const restored = setup(t, { savedSession: result });
    await tick();
    restored.w.document.querySelector("[data-bcmv-host]").getBoundingClientRect = bounds;
    restored.w.document.querySelector(".webplayer-internal-video").dispatchEvent(new restored.w.Event("resize"));
    assert.equal(restored.w.document.querySelector("[data-bcmv-host]").style.cssText, host.style.cssText);
    pointer(video, "pointerdown", 450, 400);
    pointer(h.w, "pointermove", 450, 404);
    pointer(h.w, "pointerup", 450, 404);
    video.dispatchEvent(new h.w.MouseEvent("click", { bubbles: true, detail: 1 }));
    assert.equal(clicks, 1, "an ordinary click still reaches the native player");
});

test("main drag leaves native controls alone and cancels when its player is replaced", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    const d = h.w.document,
        native = d.querySelector("[data-bcmv-native]"),
        video = native.querySelector("video");
    const host = native.parentElement;
    host.getBoundingClientRect = d.querySelector(".bcmv-grid").getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        width: 900,
        height: 600,
    });
    const pointer = (target, type) =>
        target.dispatchEvent(
            new h.w.MouseEvent(type, {
                button: 0,
                bubbles: true,
                cancelable: true,
                clientX: type === "pointerdown" ? 200 : 750,
                clientY: 100,
            })
        );
    for (const [tag, role, className] of [
        ["button", "", ""],
        ["div", "slider", "pzp-pc__progress-slider"],
        ["div", "menu", "pzp-pc__settings"],
        ["div", "", "pzp-pc__bottom"],
    ]) {
        const control = d.createElement(tag);
        if (role) control.setAttribute("role", role);
        control.className = className;
        native.append(control);
        pointer(control, "pointerdown");
        pointer(h.w, "pointermove");
        assert.equal(d.querySelector(".bcmv-drop-preview"), null);
        pointer(h.w, "pointerup");
        control.remove();
    }
    const saved = h.w.sessionStorage.getItem("betterChzzkMultiviewSession");
    pointer(video, "pointerdown");
    pointer(h.w, "pointermove");
    assert.ok(d.querySelector(".bcmv-drop-preview"));
    const replacement = native.cloneNode(true);
    native.replaceWith(replacement);
    await tick();
    pointer(h.w, "pointerup");
    assert.equal(d.querySelector(".bcmv-drop-preview"), null);
    assert.equal(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"), saved);
    assert.equal(replacement.getAttribute("data-bcmv-native"), "1");
    const replacementVideo = replacement.querySelector("video");
    pointer(replacementVideo, "pointerdown");
    pointer(h.w, "pointermove");
    assert.ok(d.querySelector(".bcmv-drop-preview"));
    h.configure(false);
    pointer(h.w, "pointerup");
    assert.equal(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"), saved);
    assert.equal(native.hasAttribute("data-bcmv-native"), false);
    assert.equal(replacement.hasAttribute("data-bcmv-native"), false);
    assert.equal(host.style.getPropertyValue("--bcmv-main-top"), "");
    assert.equal(video.dispatchEvent(new h.w.Event("dragstart", { bubbles: true, cancelable: true })), true);
});

test("edge docking changes divider direction and keeps the playback nodes", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    await h.add(C);
    const d = h.w.document,
        grid = d.querySelector(".bcmv-grid");
    grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 600 });
    const b = d.querySelector(`[data-bcmv-channel="${B}"] video`),
        c = d.querySelector(`[data-bcmv-channel="${C}"] video`);
    const pointer = (node, type, x, y) =>
        node.dispatchEvent(
            new h.w.MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true })
        );
    assert.equal(d.querySelector('[data-path="rab"]').dataset.axis, "rows");
    pointer(c, "pointerdown", 750, 300);
    pointer(b, "pointermove", 610, 100);
    assert.match(d.querySelector(".bcmv-drop-preview").textContent, /왼쪽에 배치/);
    pointer(b, "pointerup", 610, 100);
    assert.equal(d.querySelector('[data-path="rab"]').dataset.axis, "columns");
    assert.equal(d.querySelector('[data-path="rab"]').style.width, "", "the old row width must not cover the video");
    assert.equal(d.querySelector(`[data-bcmv-channel="${B}"] video`), b);
    assert.equal(d.querySelector(`[data-bcmv-channel="${C}"] video`), c);
    const saved = JSON.parse(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"));
    assert.equal(h.w.BetterChzzk.multiviewModel.validTree(saved.dockTree, saved.channels), true);
});

test("diagonal corner resize keeps the visible video aspect and persists its individual layout", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    await h.add(C);
    const d = h.w.document,
        host = d.querySelector("[data-bcmv-host]"),
        grid = d.querySelector(".bcmv-grid");
    const bounds = () => ({ left: 0, top: 0, right: 900, bottom: 506.25, width: 900, height: 506.25 });
    host.getBoundingClientRect = bounds;
    grid.getBoundingClientRect = bounds;
    const cell = d.querySelector(`[data-bcmv-channel="${B}"]`),
        video = cell.querySelector("video");
    Object.defineProperties(video, { videoWidth: { value: 1280 }, videoHeight: { value: 720 } });
    video.dispatchEvent(new h.w.Event("resize"));
    const initial = parseFloat(cell.style.width);
    const pointer = (node, type, x, y) =>
        node.dispatchEvent(
            new h.w.MouseEvent(type, { button: 0, bubbles: true, cancelable: true, clientX: x, clientY: y })
        );
    pointer(cell.querySelector('[data-corner="sw"]'), "pointerdown", 600, 168.75);
    pointer(h.w, "pointermove", 540, 202.5);
    assert.ok(parseFloat(cell.style.width) > initial);
    const aspect = (parseFloat(cell.style.width) * 900) / (parseFloat(cell.style.height) * 506.25);
    assert.ok(Math.abs(aspect - 16 / 9) < 1e-8, "the box fits the video instead of cropping or letterboxing it");
    pointer(h.w, "pointerup", 540, 202.5);
    const saved = JSON.parse(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"));
    assert.equal(saved.customLayout, true);
    assert.equal(h.w.BetterChzzk.multiviewModel.validTree(saved.dockTree, saved.channels), true);
    const reopened = setup(t, { savedSession: saved });
    await tick();
    assert.deepEqual(
        JSON.parse(reopened.w.sessionStorage.getItem("betterChzzkMultiviewSession")).dockTree,
        saved.dockTree
    );
    assert.equal(cell.querySelector("video"), video);
});

test("Alt dragging positions main and secondary videos within their unchanged boxes and restores channel positions", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    const d = h.w.document,
        host = d.querySelector("[data-bcmv-host]");
    const bounds = () => ({ left: 0, top: 0, width: 900, height: 900 });
    host.getBoundingClientRect = bounds;
    const main = d.querySelector(".webplayer-internal-video"),
        video = d.querySelector(`[data-bcmv-channel="${B}"] video`),
        cell = video.parentElement;
    video.dispatchEvent(new h.w.Event("resize"));
    const saved = () => JSON.parse(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"));
    const initial = saved(),
        initialSize = [cell.style.width, cell.style.height],
        volume = video.volume;
    const pointer = (target, type, x, y) =>
        target.dispatchEvent(
            new h.w.MouseEvent(type, {
                button: 0,
                altKey: true,
                clientX: x,
                clientY: y,
                bubbles: true,
                cancelable: true,
            })
        );
    let nativeClicks = 0;
    main.parentElement.addEventListener("click", () => nativeClicks++);
    pointer(video, "pointerdown", 750, 150);
    pointer(h.w, "pointermove", 750, -300);
    assert.equal(cell.style.top, "0%");
    assert.ok(d.querySelector(".bcmv-position-guide"));
    assert.equal(d.querySelector(".bcmv-drop-preview"), null);
    assert.deepEqual(saved(), initial, "preview must not save an unfinished position");
    pointer(h.w, "pointerup", 750, -300);
    assert.deepEqual(saved().channels[1].position, [0.5, 0]);
    assert.deepEqual(saved().dockTree, initial.dockTree);
    assert.deepEqual([cell.style.width, cell.style.height], initialSize);
    assert.equal(video.volume, volume);
    assert.equal(cell.querySelector("video"), video);
    assert.equal(d.querySelector(".bcmv-position-guide"), null);
    pointer(main, "pointerdown", 300, 300);
    pointer(h.w, "pointermove", 300, 1000);
    pointer(h.w, "pointerup", 300, 1000);
    main.dispatchEvent(new h.w.MouseEvent("click", { bubbles: true, detail: 1 }));
    assert.equal(nativeClicks, 0, "releasing a position drag must not pause the native player");
    assert.deepEqual(saved().channels[0].position, [0.5, 1]);
    assert.ok(Math.abs(parseFloat(host.style.getPropertyValue("--bcmv-main-top")) - 29.16666666666667) < 1e-8);
    const restored = setup(t, { savedSession: saved() });
    await tick();
    const restoredHost = restored.w.document.querySelector("[data-bcmv-host]");
    restoredHost.getBoundingClientRect = bounds;
    restored.w.document.querySelector(".webplayer-internal-video").dispatchEvent(new restored.w.Event("resize"));
    assert.equal(
        restoredHost.style.getPropertyValue("--bcmv-main-top"),
        host.style.getPropertyValue("--bcmv-main-top")
    );
    assert.equal(restored.w.document.querySelector(`[data-bcmv-channel="${B}"]`).style.top, "0%");
    // Reflow keeps relative alignment when the available margin changes.
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 900 });
    video.dispatchEvent(new h.w.Event("resize"));
    assert.equal(cell.style.top, "0%");
    assert.deepEqual(saved().channels[1].position, [0.5, 0]);
    h.navigate(B);
    await tick();
    assert.deepEqual(saved().channels.find((entry) => entry.id === B).position, [0.5, 0]);
    assert.deepEqual(saved().channels.find((entry) => entry.id === A).position, [0.5, 1]);
});

test("inner video positioning clamps and snaps horizontally, cancels on lifecycle changes, and resets independently", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    const d = h.w.document,
        host = d.querySelector("[data-bcmv-host]"),
        video = d.querySelector(`[data-bcmv-channel="${B}"] video`),
        cell = video.parentElement;
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 506.25 });
    Object.defineProperties(video, { videoWidth: { value: 720 }, videoHeight: { value: 1280 } });
    video.dispatchEvent(new h.w.Event("resize"));
    const initialLeft = cell.style.left,
        initialSize = [cell.style.width, cell.style.height];
    const saved = () => JSON.parse(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"));
    const pointer = (target, type, x) =>
        target.dispatchEvent(
            new h.w.MouseEvent(type, {
                button: 0,
                altKey: true,
                clientX: x,
                clientY: 84,
                bubbles: true,
                cancelable: true,
            })
        );
    for (const cancel of ["Escape", "pointercancel", "blur"]) {
        const initial = saved();
        pointer(video, "pointerdown", 750);
        pointer(h.w, "pointermove", 2000);
        assert.notEqual(cell.style.left, initialLeft);
        if (cancel === "Escape")
            h.w.dispatchEvent(new h.w.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
        else if (cancel === "blur") h.w.dispatchEvent(new h.w.Event("blur"));
        else pointer(h.w, cancel, 2000);
        assert.equal(cell.style.left, initialLeft);
        assert.deepEqual(saved(), initial);
        assert.equal(d.querySelector(".bcmv-position-guide"), null);
    }
    pointer(video, "pointerdown", 750);
    pointer(h.w, "pointermove", 950);
    pointer(h.w, "pointermove", 756);
    assert.equal(cell.style.left, initialLeft, "the center attracts a nearby position");
    pointer(h.w, "pointerup", 2000);
    assert.deepEqual(saved().channels[1].position, [1, 0.5]);
    assert.deepEqual([cell.style.width, cell.style.height], initialSize);
    h.click("controls");
    const volume = video.volume;
    assert.equal(d.querySelector('.bcmv-panel input[type="range"]'), null);
    h.click("reset-layout");
    assert.equal(cell.style.left, initialLeft);
    assert.deepEqual(saved().channels[1].position, [0.5, 0.5]);
    assert.equal(video.volume, volume, "restoring layout cannot change volume");
    h.click("close-panel");
    pointer(video, "pointerdown", 750);
    pointer(h.w, "pointermove", 2000);
    h.configure(false);
    pointer(h.w, "pointerup", 2000);
    assert.deepEqual(saved().channels[1].position, [0.5, 0.5]);
    assert.equal(d.querySelector("[data-bcmv-positioning]"), null);
    assert.equal(d.querySelector(".bcmv-position-guide"), null);
});

test("right click cancels main and secondary drags without muting or saving the preview", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    await h.add(C);
    const d = h.w.document,
        host = d.querySelector("[data-bcmv-host]"),
        grid = d.querySelector(".bcmv-grid"),
        main = d.querySelector(".webplayer-internal-video"),
        sub = d.querySelector(`[data-bcmv-channel="${B}"] video`);
    const bounds = () => ({ left: 0, top: 0, width: 900, height: 900 });
    host.getBoundingClientRect = grid.getBoundingClientRect = bounds;
    sub.dispatchEvent(new h.w.Event("resize"));
    const saved = () => h.w.sessionStorage.getItem("betterChzzkMultiviewSession");
    const pointer = (target, type, altKey, x, y) =>
        target.dispatchEvent(
            new h.w.MouseEvent(type, {
                button: 0,
                buttons: type === "pointerup" ? 0 : 1,
                altKey,
                clientX: x,
                clientY: y,
                bubbles: true,
                cancelable: true,
            })
        );
    const context = (target, altKey) =>
        target.dispatchEvent(
            new h.w.MouseEvent("contextmenu", {
                button: 2,
                buttons: 1,
                altKey,
                bubbles: true,
                cancelable: true,
            })
        );
    for (const [video, altKey, x, y, xx, yy] of [
        [main, true, 300, 300, 300, 550],
        [sub, true, 750, 150, 750, 0],
        [sub, false, 750, 150, 750, 450],
    ]) {
        const original = saved(),
            muted = video.muted;
        const cell = d.querySelector(`[data-bcmv-channel="${video === main ? A : B}"]`),
            before = cell.style.cssText;
        pointer(video, "pointerdown", altKey, x, y);
        pointer(h.w, "pointermove", altKey, xx, yy);
        assert.ok(d.querySelector(".bcmv-position-guide, .bcmv-drop-preview"));
        assert.equal(context(video, altKey), false, "the cancellation consumes the context menu");
        assert.equal(d.querySelector(".bcmv-position-guide, .bcmv-drop-preview"), null);
        assert.equal(d.querySelector(".bcmv-panel").hidden, true, "cancelling a drag must not open settings");
        assert.equal(cell.style.cssText, before);
        pointer(h.w, "pointerup", altKey, xx, yy);
        assert.equal(saved(), original, "releasing the left button after cancellation must not commit");
        assert.equal(video.muted, muted);
    }
    const muted = sub.muted;
    context(sub, false);
    assert.equal(sub.muted, !muted, "ordinary right click toggles secondary audio");
    assert.equal(d.querySelector(".bcmv-panel").hidden, true);
    assert.equal(context(main, false), true, "the temporary context menu listener is removed");
    pointer(sub, "pointerdown", true, 750, 150);
    pointer(h.w, "pointermove", true, 750, 0);
    h.configure(false);
    assert.equal(context(main, true), true, "disabling the feature removes the cancellation listener");
});

test("invalid or old session positions default to centered without invalidating the layout", (t) => {
    const m = setup(t).w.BetterChzzk.multiviewModel;
    for (const position of [undefined, null, [NaN, Infinity], [-0.1, 1.1], ["0", "1"]]) {
        const normalized = m.session({ version: 1, channels: [{ id: A, position }] });
        assert.deepEqual(Array.from(normalized.channels[0].position), [0.5, 0.5]);
        assert.equal(normalized.dockTree, A);
    }
    assert.deepEqual(
        Array.from(m.session({ version: 1, channels: [{ id: A, position: [0, 1] }] }).channels[0].position),
        [0, 1]
    );
});

test("main keeps its four-cell size and user resizing survives stream additions and removals", async (t) => {
    const h = setup(t),
        m = h.w.BetterChzzk.multiviewModel;
    for (let count = 1; count <= 6; count += 1) {
        const defaults = m.autoSplits(count);
        for (const { columns, rows } of [defaults, { columns: [0.3, 0.65], rows: [0.4, 0.75] }]) {
            const entries = Array.from({ length: count }, (_, i) => ({ id: i.toString(16).repeat(32) }));
            const view = m.treeLayout(m.defaultTree(entries, columns, rows));
            assert.equal(view.cells.filter((item) => item.id).length, count);
            const cells = view.cells.map((item) => item.rect);
            let area = 0;
            for (const [i, [x, y, width, height]] of cells.entries()) {
                assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1 && y + height <= 1);
                area += width * height;
                for (const [xx, yy, ww, hh] of cells.slice(i + 1))
                    assert.ok(
                        Math.min(x + width, xx + ww) - Math.max(x, xx) < 1e-9 ||
                            Math.min(y + height, yy + hh) - Math.max(y, yy) < 1e-9
                    );
            }
            const expectedArea = 1;
            assert.ok(Math.abs(area - expectedArea) < 1e-9, "unused space must not enlarge the main video");
            if (count > 1) {
                assert.equal(cells[0][2], columns[1]);
                assert.equal(cells[0][3], rows[1]);
                assert.equal(defaults.columns[1], 2 / 3);
                assert.equal(defaults.rows[1], 2 / 3);
            }
        }
    }
    await h.start();
    const d = h.w.document;
    assert.equal(d.querySelectorAll(".bcmv-cell").length, 1);
    assert.equal(d.querySelector('.bcmv-cell[data-main="1"]').style.width, "100%");
    assert.equal(d.querySelectorAll(".bcmv-separator").length, 0);
    assert.equal(d.querySelector("#betterchzzk-multiview-add"), null);
    assert.ok(d.querySelector('.bcmv-panel input[name="liveUrl"]'));
    await h.add(B);
    h.click("controls");
    assert.ok(d.querySelector('.bcmv-panel-header [data-action="add"]'));
    const handle = d.querySelector('.bcmv-separator[data-path="ra"]');
    handle.dispatchEvent(new h.w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const mainWidth = d.querySelector('.bcmv-cell[data-main="1"]').style.width;
    for (const id of [C, "d".repeat(32), "e".repeat(32), "f".repeat(32)]) {
        await h.add(id);
        assert.equal(d.querySelectorAll(".bcmv-cell").length, h.instances.length + 1);
        assert.equal(d.querySelector(".bcmv-empty"), null);
        assert.equal(d.querySelector('.bcmv-cell[data-main="1"]').style.width, mainWidth);
    }
    const retained = d.querySelector(`[data-bcmv-channel="${B}"] video`);
    h.click("controls");
    h.click("remove", C);
    assert.equal(d.querySelectorAll(".bcmv-cell").length, 5);
    assert.equal(d.querySelector('.bcmv-cell[data-main="1"]').style.width, mainWidth);
    assert.equal(d.querySelector(`[data-bcmv-channel="${B}"] video`), retained);
    const saved = JSON.parse(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"));
    const resumed = setup(t, { savedSession: saved });
    await tick();
    assert.equal(resumed.w.document.querySelectorAll(".bcmv-cell").length, 5);
    assert.equal(saved.layoutVersion, 3);
    assert.equal(resumed.w.document.querySelector('.bcmv-cell[data-main="1"]').style.width, mainWidth);
    h.click("toggle-multiview");
    assert.equal(d.querySelector("#betterchzzk-multiview-add"), null);
});

test("multiview validates URLs, bounded session layout, stored delay and seekable gaps", (t) => {
    const { w } = setup(t);
    const m = w.BetterChzzk.multiviewModel;
    assert.equal(m.channelFromUrl(`https://chzzk.naver.com/live/${A}`), A);
    for (const url of [
        `https://evil.test/live/${A}`,
        `https://chzzk.naver.com@evil.test/live/${A}`,
        `http://chzzk.naver.com/live/${A}`,
    ])
        assert.equal(m.channelFromUrl(url), null);
    for (const delay of [-1, Infinity, "3", null]) assert.equal(m.readDelay({ version: 1, delaySeconds: delay }), 0);
    assert.equal(m.readDelay({ version: 2, delaySeconds: 3 }), 0);
    assert.equal(m.readDelay({ version: 1, delaySeconds: 3.2 }), 3.2);
    const normalized = m.session({
        version: 1,
        active: true,
        columns: [0, 1],
        channels: Array.from({ length: 12 }, (_, i) => ({ id: i.toString(16).repeat(32) })),
    });
    assert.equal(normalized.channels.length, 6);
    assert.equal(normalized.columns[0], 1 / 3);
    const v = {
        readyState: 4,
        duration: Infinity,
        seekable: { length: 2, start: (i) => [0, 90][i], end: (i) => [70, 100][i] },
    };
    assert.equal(m.seekTarget(v, 20).state, "range");
    assert.equal(m.seekTarget(v, 40).target, 60);
    assert.equal(m.seekTarget(v, 0, 97).target, 97);
    assert.equal(m.seekTarget({ ...v, duration: 100 }, 1).state, "unsupported");
});

test("six slots preserve native tree; additions reject duplicates and overflow; secondary videos are excluded", async (t) => {
    const h = setup(t);
    const { w } = h,
        original = w.document.querySelector(".chzzk_player"),
        parent = original.parentElement;
    await h.start();
    await h.add(B);
    await h.add(B);
    assert.match(w.document.querySelector(".bcmv-panel").textContent, /이미 추가/);
    for (const digit of ["c", "d", "e", "f"]) await h.add(digit.repeat(32));
    await h.add("1".repeat(32));
    assert.match(w.document.querySelector(".bcmv-panel").textContent, /최대 6개/);
    assert.equal(w.document.querySelectorAll("[data-bcmv-video]").length, 5);
    assert.equal(original.parentElement, parent);
    assert.equal(w.document.getElementById("native-info").textContent, "원래 방송 제목과 상호작용");
    assert.equal(w.BetterChzzk.utils.getMainVideoElement(), original.querySelector("video"));
    assert.equal(
        h.instances.every((hls) => !hls.config.enableWorker && hls.config.maxLiveSyncPlaybackRate === 1),
        true
    );
});

function linkTransfer(h, value, { type = "text/uri-list", files = false } = {}) {
    const data = {
        readable: false,
        reads: 0,
        types: files ? ["Files", type] : [type],
        effectAllowed: "copyLink",
        dropEffect: "none",
        getData(format) {
            this.reads++;
            assert.ok(this.readable, "dragover cannot read protected URL data");
            return format === type ? value : "";
        },
    };
    return {
        data,
        send(eventType, target, relatedTarget = null) {
            data.readable = eventType === "drop";
            const event = new h.w.MouseEvent(eventType, {
                bubbles: true,
                cancelable: true,
                clientX: 100,
                clientY: 100,
                relatedTarget,
            });
            Object.defineProperty(event, "dataTransfer", { value: data });
            target.dispatchEvent(event);
            return event;
        },
    };
}

test("dropping a live URL into multiview uses the normal add flow and never navigates the page", async (t) => {
    const h = setup(t, { local: { [key(B)]: { version: 2, basis: "live-edge-clock", delaySeconds: 5 } } });
    await h.start();
    const d = h.w.document,
        host = d.querySelector("[data-bcmv-host]"),
        main = d.querySelector(".webplayer-internal-video");
    const url = h.w.location.href,
        before = h.w.sessionStorage.getItem("betterChzzkMultiviewSession"),
        time = main.currentTime;
    const transfer = linkTransfer(h, `# dragged browser link\r\nhttps://chzzk.naver.com/live/${B}\r\n`);
    assert.equal(transfer.send("dragenter", main).defaultPrevented, true);
    assert.equal(transfer.send("dragover", host).defaultPrevented, true);
    assert.equal(transfer.data.reads, 0);
    assert.equal(transfer.data.dropEffect, "copy");
    assert.match(d.querySelector(".bcmv-add-drop").textContent, /방송 추가/);
    assert.equal(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"), before);
    assert.equal(h.requests.length, 1, "hover alone cannot fetch a stream");
    transfer.send("dragleave", main, host);
    assert.ok(d.querySelector(".bcmv-add-drop"), "moving within the video host keeps the guide");
    assert.equal(transfer.send("drop", main).defaultPrevented, true);
    await tick();
    assert.equal(d.querySelector(".bcmv-add-drop"), null);
    const sub = d.querySelector(`[data-bcmv-channel="${B}"] video`);
    assert.ok(sub);
    assert.equal(sub.muted, true);
    assert.equal(sub.currentTime, 115);
    assert.equal(main.currentTime, time);
    assert.equal(h.w.location.href, url);
    assert.equal(h.writes.length, 0);
    const count = h.requests.length;
    transfer.send("drop", sub);
    await tick();
    assert.equal(h.requests.length, count);
    assert.match(d.querySelector(".bcmv-banner").textContent, /이미 추가/);
    for (const id of [C, "d".repeat(32), "e".repeat(32), "f".repeat(32)]) {
        linkTransfer(h, `https://chzzk.naver.com/live/${id}`, { type: "text/plain" }).send("drop", main);
        await tick();
    }
    assert.equal(d.querySelectorAll(".bcmv-cell").length, 6);
    assert.equal(d.querySelector(`[data-bcmv-channel="${B}"] video`), sub);
    const full = linkTransfer(h, `https://chzzk.naver.com/live/${"1".repeat(32)}`);
    full.send("dragover", main);
    assert.equal(full.data.dropEffect, "none");
    assert.match(d.querySelector(".bcmv-add-drop").textContent, /최대 6개/);
    full.send("drop", main);
    await tick();
    assert.equal(d.querySelectorAll(".bcmv-cell").length, 6);
});

test("multiview URL drops reject invalid data and stale source identities and clean up on exit", async (t) => {
    const h = setup(t);
    await h.start();
    const d = h.w.document,
        host = d.querySelector("[data-bcmv-host]");
    const before = h.w.sessionStorage.getItem("betterChzzkMultiviewSession");
    for (const value of [
        "text only",
        `https://example.com/live/${B}`,
        `https://user@chzzk.naver.com/live/${B}`,
        `javascript:alert(1)`,
        `https://chzzk.naver.com/${B}`,
        `https://chzzk.naver.com/live/${B}\nhttps://chzzk.naver.com/live/${C}`,
        "x".repeat(4097),
    ]) {
        const transfer = linkTransfer(h, value);
        assert.equal(transfer.send("drop", host).defaultPrevented, true);
        assert.equal(h.w.sessionStorage.getItem("betterChzzkMultiviewSession"), before);
    }
    const files = linkTransfer(h, `https://chzzk.naver.com/live/${B}`, { files: true });
    assert.equal(files.send("dragover", host).defaultPrevented, false);
    assert.equal(files.send("drop", host).defaultPrevented, false);
    assert.equal(files.data.reads, 0);
    const valid = linkTransfer(h, `https://chzzk.naver.com/live/${B}`);
    assert.equal(valid.send("drop", d.body).defaultPrevented, false);
    valid.send("dragover", host);
    valid.send("dragleave", host, d.body);
    assert.equal(d.querySelector(".bcmv-add-drop"), null);
    const source = d.createElement("a");
    source.href = `https://chzzk.naver.com/live/${B}`;
    d.body.append(source);
    source.dispatchEvent(new h.w.Event("dragstart", { bubbles: true }));
    source.href = `https://chzzk.naver.com/live/${C}`;
    valid.send("drop", host);
    assert.equal(h.requests.length, 1);
    assert.match(d.querySelector("[data-bcmv-notice]").textContent, /다시 끌어/);
    source.href = `https://chzzk.naver.com/live/${B}`;
    source.dispatchEvent(new h.w.Event("dragstart", { bubbles: true }));
    h.navigate(C);
    await tick();
    valid.send("drop", d.querySelector("[data-bcmv-host]"));
    assert.equal(d.querySelector(`[data-bcmv-channel="${B}"]`), null);
    source.dispatchEvent(new h.w.Event("dragstart", { bubbles: true }));
    valid.send("dragover", d.querySelector("[data-bcmv-host]"));
    source.dispatchEvent(new h.w.Event("dragend", { bubbles: true }));
    assert.equal(d.querySelector(".bcmv-add-drop"), null);
    h.configure(false);
    assert.equal(valid.send("drop", host).defaultPrevented, false);
    assert.equal(d.querySelector("[data-bcmv-video]"), null);
});

test("channel delays restore independently, user edits persist, removal retains saved settings", async (t) => {
    const h = setup(t, {
        local: { [key(A)]: { version: 1, delaySeconds: 3.2 }, [key(B)]: { version: 1, delaySeconds: 8 } },
    });
    await h.start();
    await h.add(B);
    const main = h.w.document.querySelector(".webplayer-internal-video"),
        sub = h.w.document.querySelector("[data-bcmv-video]");
    assert.equal(main.currentTime, 116.8);
    assert.equal(sub.currentTime, 112);
    assert.equal(sub.muted, true);
    h.click("mute", B);
    assert.equal(sub.muted, false);
    assert.equal(main.muted, false);
    h.click("controls");
    h.w.document.querySelector('[data-delta="0.1"]').click();
    await tick();
    assert.equal(h.storage[key(B)].delaySeconds, 8.1);
    assert.equal(h.storage[key(A)].delaySeconds, 3.2);
    assert.match(h.w.document.querySelector("[data-bcmv-status]").textContent, /적용 완료/);
    const writeCount = h.writes.length;
    sub.currentTime = 90;
    sub.dispatchEvent(new h.w.Event("timeupdate"));
    await tick();
    assert.equal(h.writes.length, writeCount);
    h.click("remove", B);
    assert.equal(h.storage[key(B)].delaySeconds, 8.1);
    assert.equal(h.instances[0].destroyed, true);
});

test("refresh and new broadcast restore channel delays and tab composition; reset writes zero", async (t) => {
    const first = setup(t);
    await first.start();
    await first.add(B);
    first.click("controls");
    for (let step = 0; step < 10; step++) first.w.document.querySelector('[data-delta="0.1"]').click();
    await tick();
    const savedSession = JSON.parse(first.w.sessionStorage.getItem("betterChzzkMultiviewSession"));
    const second = setup(t, { local: first.storage, savedSession });
    await tick();
    assert.equal(second.w.document.querySelectorAll("[data-bcmv-video]").length, 1);
    assert.equal(second.w.document.querySelector("[data-bcmv-video]").currentTime, 116);
    const third = setup(t, { local: first.storage });
    await third.start();
    await third.add(B);
    assert.equal(third.w.document.querySelector("[data-bcmv-video]").currentTime, 116);
    third.click("controls");
    third.click("reset-delay", B);
    await tick();
    assert.equal(third.storage[key(B)].delaySeconds, 0);
    assert.equal(third.w.document.querySelector("[data-bcmv-video]").currentTime, 117);
});

test("insufficient ranges wait without truncating saved delay; readiness restores it, ads wait", async (t) => {
    const h = setup(t, { local: { [key(A)]: { version: 1, delaySeconds: 130 } } });
    const video = h.w.document.querySelector("video");
    await h.start();
    assert.equal(video.currentTime, 100);
    assert.equal(h.storage[key(A)].delaySeconds, 130);
    h.media(video).end = 200;
    video.dispatchEvent(new h.w.Event("progress"));
    await tick();
    assert.equal(video.currentTime, 70);
    h.w.document.querySelector(".pzp-pc").classList.add("pzp-pc--adbreak");
    h.emitStorage(A, { version: 1, delaySeconds: 131 });
    await tick();
    assert.equal(video.currentTime, 70);
    assert.equal(h.writes.length, 0, "advertisements must not overwrite the stored target");
    h.w.document.querySelector(".pzp-pc").classList.remove("pzp-pc--adbreak");
    await tick();
    assert.equal(video.currentTime, 69);
});

test("read and write failures are visible and never claim saved success", async (t) => {
    const read = setup(t, { readFailure: true });
    await read.start();
    await read.add(B);
    read.click("controls");
    assert.match(read.w.document.querySelector("[data-bcmv-status]").textContent, /읽지 못/);
    assert.equal(read.w.document.querySelector("[data-bcmv-delay]").textContent, "저장값 확인 불가");
    assert.equal(read.w.document.querySelector("[data-delta]").disabled, true);
    assert.ok([...read.w.document.querySelectorAll(".bcmv-panel [data-delta]")].every((button) => button.disabled));
    const write = setup(t, { writeFailure: true });
    await write.start();
    await write.add(B);
    write.click("controls");
    write.w.document.querySelector('[data-delta="0.1"]').click();
    await tick();
    assert.match(write.w.document.querySelector("[data-bcmv-status]").textContent, /저장 실패/);
    assert.match(write.w.document.querySelector("[data-bcmv-delay]").textContent, /0.0s/);
    assert.equal(write.w.document.querySelector("[data-bcmv-latency]").textContent, "현재 3.1s");
    assert.equal(write.storage[key(B)], undefined);
});

test("remount, mode changes, keyboard resize and disable preserve or clean the right resources", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    const sub = h.w.document.querySelector("[data-bcmv-video]");
    const handle = h.w.document.querySelector('.bcmv-separator[data-path="ra"]');
    handle.dispatchEvent(new h.w.KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    const layout = JSON.parse(h.w.sessionStorage.getItem("betterChzzkMultiviewSession")).dockTree.a.ratio;
    assert.ok(layout < 2 / 3);
    h.w.document.querySelector(".pzp-pc").classList.add("pzp-pc--viewmode");
    await tick();
    assert.equal(h.w.document.querySelector("[data-bcmv-video]"), sub);
    const previous = h.w.document.querySelector(".chzzk_player"),
        replacement = previous.cloneNode(true);
    previous.replaceWith(replacement);
    await tick();
    assert.equal(h.w.document.querySelector("[data-bcmv-video]"), sub);
    assert.equal(h.w.document.querySelectorAll("#betterchzzk-multiview").length, 1);
    h.configure(false);
    await tick();
    assert.equal(h.w.document.querySelector("[data-bcmv-host]"), null);
    assert.equal(h.w.document.getElementById("betterchzzk-multiview-style"), null);
    assert.equal(h.instances[0].destroyed, true);
    assert.equal(h.w.document.querySelector(".chzzk_player"), replacement);
});

test("late responses after removal are aborted and cannot mount a new player", async (t) => {
    const h = setup(t, { sourcePending: true });
    await h.start();
    await h.add(B);
    h.click("controls");
    h.click("remove", B);
    h.resolve();
    await tick();
    assert.equal(h.requests.find((request) => request.id === B).signal.aborted, true);
    assert.equal(h.instances.length, 0);
    assert.equal(h.w.document.querySelector("[data-bcmv-video]"), null);
});

test("main exchange uses the router and refuses old media until source replacement", async (t) => {
    const h = setup(t, { local: { [key(B)]: { version: 1, delaySeconds: 9 } } });
    h.evalFile("features/routeBridgePage.js");
    const navigations = [];
    h.w.document.getElementById("sidebar").__reactFiber$test = {
        memoizedProps: {
            value: {
                basename: "/",
                navigator: {
                    push(value) {
                        navigations.push(value.pathname);
                        h.navigate(value.pathname.split("/").pop());
                    },
                    replace() {},
                    go() {},
                    createHref() {},
                },
            },
        },
    };
    await h.start();
    await h.add(B);
    const video = h.w.document.querySelector(".webplayer-internal-video"),
        oldTime = video.currentTime;
    const sub = h.w.document.querySelector(`[data-bcmv-channel="${B}"] video`);
    video.volume = 0.8;
    video.muted = false;
    sub.volume = 0.15;
    sub.muted = true;
    sub.dispatchEvent(new h.w.MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0 }));
    const mainCell = h.w.document.querySelector('[data-main="1"]');
    mainCell.dispatchEvent(new h.w.MouseEvent("pointermove", { bubbles: true, button: 0, clientX: 20 }));
    mainCell.dispatchEvent(new h.w.MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 20 }));
    await tick();
    assert.deepEqual(navigations, [`/live/${B}`]);
    assert.equal(h.w.document.querySelector('[data-main="1"]').dataset.bcmvChannel, B);
    assert.equal(video.currentTime, oldTime, "old A stream must not receive B delay");
    const demoted = h.w.document.querySelector(`[data-bcmv-channel="${A}"] video`);
    assert.deepEqual([demoted.volume, demoted.muted], [0.15, true]);
    h.media(video).src = "blob:b";
    video.dispatchEvent(new h.w.Event("loadedmetadata"));
    await tick();
    assert.equal(video.currentTime, 111);
    assert.deepEqual([video.volume, video.muted], [0.8, false]);
    assert.equal(h.storage[key(B)].delaySeconds, 9);
    h.navigate(A);
    h.media(video).src = "blob:a";
    video.dispatchEvent(new h.w.Event("loadedmetadata"));
    await tick();
    assert.deepEqual([video.volume, video.muted], [0.8, false]);
    const demotedAgain = h.w.document.querySelector(`[data-bcmv-channel="${B}"] video`);
    assert.deepEqual([demotedAgain.volume, demotedAgain.muted], [0.15, true]);
});

test("a muted main slot stays muted across promotion and a newly opened channel", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    const d = h.w.document,
        main = d.querySelector(".webplayer-internal-video"),
        oldSub = d.querySelector("[data-bcmv-video]");
    main.volume = 0.65;
    main.muted = true;
    oldSub.volume = 0.35;
    oldSub.muted = false;
    h.navigate(B);
    h.media(main).src = "blob:b";
    main.dispatchEvent(new h.w.Event("loadedmetadata"));
    await tick();
    assert.deepEqual([main.volume, main.muted], [0.65, true]);
    const demoted = d.querySelector(`[data-bcmv-channel="${A}"] video`);
    assert.deepEqual([demoted.volume, demoted.muted], [0.35, false]);
    oldSub.volume = 0.99;
    oldSub.muted = false;
    oldSub.dispatchEvent(new h.w.Event("volumechange"));
    assert.deepEqual([main.volume, main.muted], [0.65, true], "late events from the old player cannot rewrite a slot");
    h.navigate(C);
    h.media(main).src = "blob:c";
    main.dispatchEvent(new h.w.Event("loadedmetadata"));
    await tick();
    assert.deepEqual([main.volume, main.muted], [0.65, true]);
    const previousMain = d.querySelector(`[data-bcmv-channel="${B}"] video`);
    assert.deepEqual(
        [previousMain.volume, previousMain.muted],
        [0.3, true],
        "a former main added to a new side slot starts muted"
    );
});

test("external channel updates stay isolated and a fatal playback failure stops loading", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    h.emitStorage(B, { version: 1, delaySeconds: 4 });
    await tick();
    assert.equal(h.w.document.querySelector("[data-bcmv-video]").currentTime, 116);
    assert.equal(h.storage[key(C)], undefined);
    h.instances[0].events.error(null, { fatal: true });
    assert.equal(h.instances[0].stopped, true);
    assert.match(h.w.document.querySelector(".bcmv-error").textContent, /재생에 실패/);
    h.click("controls");
    assert.equal(h.w.document.querySelector('.bcmv-panel [data-action="retry"]'), null);
    const retry = h.w.document.querySelector('.bcmv-error [data-action="retry"]');
    assert.equal(retry.hidden, false);
    retry.click();
    await tick();
    assert.equal(h.instances[0].destroyed, true);
    assert.equal(h.instances.length, 2);
    assert.equal(h.w.document.querySelector(".bcmv-error").hidden, true);
    assert.equal(h.w.document.querySelector(".bcmv-panel").hidden, false);
});

test("the packaged Hls constructor accepts multiview configuration", async (t) => {
    const h = setup(t);
    await h.start();
    await h.add(B);
    h.evalFile("vendor/hls.light.min.js");
    const real = new h.w.Hls(h.instances[0].config);
    assert.equal(real.config.maxLiveSyncPlaybackRate, 1);
    assert.equal(real.config.liveMaxLatencyDurationCount, Infinity);
    real.destroy();
});

test("native multiview button toggles without triggering player clicks and survives control remounts", async (t) => {
    const h = setup(t),
        document = h.w.document;
    const viewmode = document.querySelector(".pzp-pc__viewmode-button");
    const controlBar = viewmode.parentElement;
    let playerClicks = 0;
    document.querySelector(".pzp-pc").addEventListener("click", () => {
        playerClicks += 1;
    });
    let toggle = document.getElementById("betterchzzk-multiview-launcher");
    assert.equal(toggle.parentElement, controlBar);
    assert.equal(toggle.nextElementSibling, viewmode);
    assert.equal(toggle.getAttribute("aria-label"), "멀티뷰 켜기");
    assert.equal(toggle.querySelector(".pzp-button__tooltip").textContent, "멀티뷰 켜기");
    assert.equal(toggle.hasAttribute("title"), false);
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    assert.ok(toggle.querySelector('svg[aria-hidden="true"]'));
    toggle.click();
    await tick();
    toggle = document.getElementById("betterchzzk-multiview-launcher");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    assert.equal(toggle.getAttribute("aria-label"), "멀티뷰 끄기");
    assert.equal(toggle.querySelector(".pzp-button__tooltip").textContent, "멀티뷰 끄기");
    assert.equal(document.activeElement, document.querySelector('input[name="liveUrl"]'));
    assert.equal(playerClicks, 0);
    await h.add(B);
    const sub = document.querySelector("[data-bcmv-video]");
    const clone = controlBar.cloneNode(true);
    controlBar.replaceWith(clone);
    await tick();
    assert.equal(document.querySelectorAll("#betterchzzk-multiview-launcher").length, 1);
    assert.equal(document.querySelector("[data-bcmv-video]"), sub);
    toggle = document.getElementById("betterchzzk-multiview-launcher");
    assert.equal(toggle.parentElement, clone);
    toggle.click();
    await tick();
    assert.equal(document.getElementById("betterchzzk-multiview"), null);
    assert.equal(document.getElementById("betterchzzk-multiview-launcher").getAttribute("aria-pressed"), "false");
    assert.equal(h.instances[0].destroyed, true);
    h.configure(false);
    assert.equal(document.getElementById("betterchzzk-multiview-launcher"), null);
});

test("multiview button waits for the native mode control instead of floating over the video", async (t) => {
    const h = setup(t),
        document = h.w.document;
    const viewmode = document.querySelector(".pzp-pc__viewmode-button"),
        parent = viewmode.parentElement;
    viewmode.remove();
    await tick();
    assert.equal(document.getElementById("betterchzzk-multiview-launcher"), null);
    parent.append(viewmode);
    await tick();
    assert.equal(document.getElementById("betterchzzk-multiview-launcher").parentElement, parent);
});

test("multiview button hides with native controls without stopping playback or leaving a focus target", async (t) => {
    const h = setup(t),
        document = h.w.document;
    await h.start();
    await h.add(B);
    const playerRoot = document.querySelector(".pzp-pc");
    const toggle = document.getElementById("betterchzzk-multiview-launcher");
    const sub = document.querySelector("[data-bcmv-video]");
    playerRoot.classList.remove("pzp-pc--controls");
    await tick();
    assert.equal(h.w.getComputedStyle(toggle).opacity, "0");
    assert.equal(h.w.getComputedStyle(toggle).pointerEvents, "none");
    assert.equal(toggle.tabIndex, -1);
    assert.equal(toggle.getAttribute("aria-hidden"), "true");
    assert.equal(document.querySelector("[data-bcmv-video]"), sub);
    assert.equal(h.instances[0].destroyed, undefined);
    playerRoot.classList.add("pzp-pc--controls");
    await tick();
    assert.equal(h.w.getComputedStyle(toggle).opacity, "1");
    assert.equal(h.w.getComputedStyle(toggle).pointerEvents, "auto");
    assert.equal(toggle.tabIndex, 0);
    assert.equal(toggle.getAttribute("aria-hidden"), "false");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    assert.equal(h.instances.length, 1);
});

test("live timing compensates playlist steps but exposes actual pauses and stale data", (t) => {
    const h = setup(t),
        m = h.w.BetterChzzk.multiviewModel;
    const details = { live: true, edge: 100, age: 0, advancedDateTime: 1000, targetduration: 2 };
    const v = { currentTime: 97 };
    assert.equal(m.hlsTiming(v, details).latency, 3);
    v.currentTime = 97.5;
    details.age = 0.5;
    assert.equal(m.hlsTiming(v, details).latency, 3, "advancing playback must not create a falling sawtooth");
    v.currentTime = 98;
    details.edge = 101;
    details.age = 0;
    assert.equal(m.hlsTiming(v, details).latency, 3, "playlist advance must not make the estimate jump");
    details.age = 0.5;
    assert.equal(m.hlsTiming(v, details).latency, 3.5, "a paused playhead must accumulate real delay");
    details.age = 7;
    assert.equal(m.hlsTiming(v, details), null, "do not extrapolate an unrefreshed playlist forever");
    assert.equal(m.hlsTiming(v, { ...details, age: 0, live: false }), null);
    assert.equal(m.hlsTiming(v, { ...details, age: 0, advancedDateTime: undefined }), null);
});

test("native clock learns observed cadence, preserves pauses and resets across stale or changed sources", (t) => {
    const h = setup(t),
        m = h.w.BetterChzzk.multiviewModel;
    const video = h.w.document.querySelector("video"),
        data = h.media(video);
    data.end = 100;
    data.time = 97;
    let observation = m.nativeTiming(video, null, 0);
    assert.equal(observation.timing, null);
    data.end = 101;
    data.time = 98;
    observation = m.nativeTiming(video, observation.clock, 1000);
    assert.equal(observation.timing.latency, 3);
    data.time = 98.5;
    observation = m.nativeTiming(video, observation.clock, 1500);
    assert.equal(observation.timing.latency, 3);
    data.end = 102;
    data.time = 99;
    observation = m.nativeTiming(video, observation.clock, 2000);
    assert.equal(observation.timing.latency, 3);
    observation = m.nativeTiming(video, observation.clock, 2500);
    assert.equal(observation.timing.latency, 3.5);
    const stable = observation.clock;
    assert.equal(m.nativeTiming(video, stable, 5100).timing, null);
    data.src = "blob:next";
    assert.equal(m.nativeTiming(video, stable, 2600).timing, null);
    data.src = stable.source;
    data.end = 90;
    assert.equal(m.nativeTiming(video, stable, 2600).timing, null);
    data.end = 800;
    assert.equal(m.nativeTiming(video, stable, 2600).timing, null);
});

test("settings show measured delay before the first sync adjustment without saving an observation", async (t) => {
    const local = { [key(C)]: { version: 2, basis: "live-edge-clock", delaySeconds: 5 } };
    const h = setup(t, { local });
    await h.start();
    await h.add(B);
    await h.add(C);
    h.click("controls");
    const d = h.w.document;
    const row = (id) => d.querySelector(`.bcmv-stream[data-channel="${id}"]`);
    const latency = (id) => row(id).querySelector("[data-bcmv-latency]")?.textContent;
    const saved = (id) => row(id).querySelector("[data-bcmv-delay]").textContent;
    assert.equal(latency(B), "현재 3.0s", "live mode must display the measured latency before any click");
    assert.equal(saved(B), "저장 0.0s");
    assert.equal(latency(C), "현재 5.0s");
    assert.equal(saved(C), "저장 5.0s");
    assert.deepEqual(h.storage, local);
    assert.equal(h.writes.length, 0);
    const video = d.querySelector(`[data-bcmv-channel="${B}"] video`),
        hls = h.instances[0];
    h.media(video).time = 117.5;
    hls.latestLevelDetails.age = 0.5;
    video.dispatchEvent(new h.w.Event("timeupdate"));
    assert.equal(latency(B), "현재 3.0s");
    hls.latestLevelDetails.edge = 121;
    hls.latestLevelDetails.age = 0;
    h.media(video).time = 118;
    h.media(video).end = 121;
    hls.events.level();
    assert.equal(latency(B), "현재 3.0s");
    assert.equal(saved(B), "저장 0.0s");
    assert.equal(h.writes.length, 0, "readiness and playback events never save observations");
    d.querySelector(`[data-action="delay"][data-channel="${B}"][data-delta="0.1"]`).click();
    await tick();
    assert.equal(latency(B), "현재 3.1s");
    assert.equal(saved(B), "저장 3.1s");
    assert.equal(h.storage[key(B)].delaySeconds, 3.1);
    assert.equal(latency(C), "현재 5.0s");
    assert.equal(saved(C), "저장 5.0s");
});

test("initial, stale and failed streams show a measurement wait state instead of a zero or saved delay", async (t) => {
    const local = { [key(B)]: { version: 2, basis: "live-edge-clock", delaySeconds: 5 } };
    const h = setup(t, { local, sourcePending: true });
    await h.start();
    await h.add(B);
    h.click("controls");
    const d = h.w.document;
    const latency = () => d.querySelector("[data-bcmv-latency]")?.textContent;
    assert.equal(latency(), "현재 측정 대기");
    assert.equal(d.querySelector("[data-bcmv-delay]").textContent, "저장 5.0s");
    h.resolve();
    await tick();
    assert.equal(latency(), "현재 5.0s", "source readiness must update an already open popup");
    const video = d.querySelector("[data-bcmv-video]"),
        hls = h.instances[0];
    const remove = d.querySelector('.bcmv-stream [data-action="remove"]');
    remove.focus();
    hls.latestLevelDetails.age = 7;
    video.dispatchEvent(new h.w.Event("timeupdate"));
    assert.equal(latency(), "현재 측정 대기");
    assert.equal(d.activeElement, remove);
    hls.latestLevelDetails.age = 0;
    hls.events.level();
    assert.equal(latency(), "현재 5.0s");
    hls.events.error(null, { fatal: true });
    assert.equal(latency(), "현재 측정 대기", "a failed stream cannot keep advertising a fresh measurement");
    assert.equal(d.querySelector("[data-bcmv-delay]").textContent, "저장 5.0s");
    assert.deepEqual(h.storage, local);
    assert.equal(h.writes.length, 0);
});

test("new delay writes and restores use the compensated edge while legacy settings remain readable", async (t) => {
    const h = setup(t, { local: { [key(B)]: { version: 1, delaySeconds: 8 } } });
    await h.start();
    await h.add(B);
    h.click("controls");
    const video = h.w.document.querySelector("[data-bcmv-video]"),
        hls = h.instances[0];
    assert.equal(video.currentTime, 112, "legacy restore must keep its previous time basis");
    hls.latestLevelDetails.age = 0.6;
    video.dispatchEvent(new h.w.Event("timeupdate"));
    assert.match(h.w.document.querySelector("[data-bcmv-delay]").title, /8.6초/);
    for (let step = 0; step < 10; step++) h.w.document.querySelector('[data-delta="0.1"]').click();
    await tick();
    assert.equal(video.currentTime, 111);
    assert.equal(h.storage[key(B)].version, 2);
    assert.equal(h.storage[key(B)].basis, "live-edge-clock");
    assert.equal(h.storage[key(B)].delaySeconds, 9.6);
    h.emitStorage(B, { version: 2, basis: "live-edge-clock", delaySeconds: 5 });
    await tick();
    assert.equal(video.currentTime, 115.6, "restore must include the same playlist age as display and save");
    hls.latestLevelDetails.age = 7;
    h.emitStorage(B, { version: 2, basis: "live-edge-clock", delaySeconds: 6 });
    await tick();
    assert.equal(video.currentTime, 115.6, "stale data must not seek");
    assert.match(h.w.document.querySelector("[data-bcmv-delay]").title, /측정 대기/);
    assert.match(h.w.document.querySelector("[data-bcmv-status]").textContent, /복원 대기/);
    hls.latestLevelDetails.edge = 121;
    hls.latestLevelDetails.age = 0.2;
    h.media(video).end = 121;
    hls.events.level();
    await tick();
    assert.equal(video.currentTime, 115.2);
});

test("delay buttons change the selected target without accumulating observation drift", async (t) => {
    const h = setup(t, { local: { [key(B)]: { version: 2, basis: "live-edge-clock", delaySeconds: 5 } } });
    await h.start();
    await h.add(B);
    h.click("controls");
    const video = h.w.document.querySelector("[data-bcmv-video]"),
        hls = h.instances[0];
    hls.latestLevelDetails.age = 0.6;
    video.dispatchEvent(new h.w.Event("timeupdate"));
    assert.match(h.w.document.querySelector("[data-bcmv-delay]").title, /5.6초/);
    h.w.document.querySelector('[data-delta="0.1"]').click();
    await tick();
    assert.equal(h.storage[key(B)].delaySeconds, 5.1);
    hls.latestLevelDetails.age = 0.9;
    video.dispatchEvent(new h.w.Event("timeupdate"));
    h.w.document.querySelector('[data-delta="-0.1"]').click();
    await tick();
    assert.equal(h.storage[key(B)].delaySeconds, 5, "opposite adjustments cancel despite measurement drift");
    for (let step = 0; step < 20; step++) h.w.document.querySelector('[data-delta="0.1"]').click();
    await tick();
    assert.equal(h.storage[key(B)].delaySeconds, 7, "pending seeks also accumulate only the requested steps");
});

test("native corrected restore waits for calibration and remains steady between boundary updates", async (t) => {
    const h = setup(t, { local: { [key(A)]: { version: 2, basis: "live-edge-clock", delaySeconds: 5 } } });
    let now = 0;
    Object.defineProperty(h.w.performance, "now", { value: () => now });
    await h.start();
    const video = h.w.document.querySelector(".webplayer-internal-video"),
        media = h.media(video);
    assert.equal(video.currentTime, 100, "a fresh native source must wait for a measured live clock");
    now = 1000;
    media.end = 121;
    media.time = 101;
    video.dispatchEvent(new h.w.Event("progress"));
    await tick();
    assert.equal(video.currentTime, 116);
    now = 1500;
    media.time = 116.5;
    video.dispatchEvent(new h.w.Event("timeupdate"));
    assert.equal(video.currentTime, 116.5, "observations do not seek after restoration");
    now = 2000;
    media.end = 122;
    media.time = 117;
    video.dispatchEvent(new h.w.Event("progress"));
    assert.equal(video.currentTime, 117);
    assert.equal(h.writes.length, 0, "observations never overwrite the saved target");
    now = 5100;
    video.dispatchEvent(new h.w.Event("timeupdate"));
    assert.equal(video.currentTime, 117, "stale observations do not seek");
});
