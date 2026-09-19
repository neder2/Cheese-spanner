const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const source = fs.readFileSync(path.join(__dirname, "../features/adVideoPage.js"), "utf8");
const bridge = fs.readFileSync(path.join(__dirname, "../features/adVideo.js"), "utf8");
const measured = require("./fixtures/ad-seoraksan-live.json");

function createPage(t, pathname = "/live/measured-channel", initialState = "1") {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
        url: `https://chzzk.naver.com${pathname}`,
        runScripts: "outside-only",
    });
    t.after(() => dom.window.close());
    if (initialState !== null) {
        dom.window.document.documentElement.setAttribute("data-betterchzzk-ad-video-state", initialState);
    }
    return dom.window;
}

function setEnabled(window, enabled) {
    window.document.documentElement.setAttribute("data-betterchzzk-ad-video-state", enabled ? "1" : "0");
    window.document.dispatchEvent(new window.Event("betterchzzk:ad-video:state"));
}

function parse(window, value) {
    return JSON.parse(JSON.stringify(window.JSON.parse(JSON.stringify(value))));
}

function createAdController(window) {
    // 배포 AdsPlayer의 소스 setter 및 소스가 없을 때 initAd의 조기 반환 계약.
    const prototype = {
        _attachSourceObject(value) {
            this.attached = value;
        },
        initAd() {
            if (!this.attached) return;
            this.attached.prepare();
        },
        stopAd() {},
    };
    window.Object.defineProperty(prototype, "srcObject", {
        configurable: true,
        enumerable: true,
        get() {
            return this.attached;
        },
        set(value) {
            this._attachSourceObject(value);
        },
    });
    return Object.create(prototype);
}

function createVodAdSource(prepare = () => {}) {
    return {
        _videoScheduleInfo: {
            adScheduleParam: { adScheduleId: "CHZZK_NDP_SCH" },
            customParam: { svc: "chzzk_video" },
        },
        setVideoScheduleInfo() {},
        prepare,
    };
}

function createWrappedLiveSource(adScheduleId = "LIVE_CHZZK_NDP_SCH") {
    // 2026-09-14 배포 SDK의 계약 모델: 내부 요청이 없어도 바깥 클라이언트 초기화는 계속된다.
    const calls = [];
    const linearClient = { kind: "linear-ad-client" };
    const inner = {
        _videoScheduleInfo: { adScheduleParam: { adScheduleId }, customParam: { svc: "chzzk_live" } },
        setVideoScheduleInfo() {},
        async initAd(...args) {
            calls.push(args);
            return linearClient;
        },
    };
    class WrappedLiveRequest {
        static Constants = { NLIVECAST_ID: "ncast.advertisement" };
        constructor() {
            this._init = {
                playerType: "LIVE_PW",
                uiElements: ["uiClickThrough"],
                disableTrackingCors: false,
                linearAdRequest: inner,
            };
        }
        async handshakeVersion() {
            return "1";
        }
        async initAd(...args) {
            let client;
            try {
                client = await this._init.linearAdRequest?.initAd(...args);
            } catch (_) {
                // 원래 SDK도 내부 광고 요청 실패를 흡수하고 바깥 클라이언트를 만든다.
            }
            return {
                client,
                playerType: this._init.playerType,
                uiElements: this._init.uiElements,
                disableTrackingCors: this._init.disableTrackingCors,
            };
        }
    }
    return { wrapped: new WrappedLiveRequest(), inner, calls, linearClient };
}

function createWrappedLiveController(window) {
    const root = window.document.createElement("div");
    root.className = "chzzk_player";
    const video = root.appendChild(window.document.createElement("video"));
    window.document.body.append(root);
    const controller = createAdController(window);
    controller.videoSlot = video;
    return controller;
}

function wrapControllerVideoSlot(window, controller) {
    // 2026-09-19 CHZZK adapter: a plain object delegates to its own video inside shadowRoot (an Element).
    const video = controller.videoSlot;
    const root = window.document.createElement("div");
    video.replaceWith(root);
    root.append(video);
    const slot = {
        _videoElement: video,
        shadowRoot: root,
        get video() {
            return this._videoElement;
        },
        get isConnected() {
            return this._videoElement.isConnected;
        },
    };
    controller.videoSlot = slot;
    controller.contentVideoElement = slot;
    return { slot, video, root };
}

test("object video slots block the measured Asian Games pre-roll without replacing the content adapter", async (t) => {
    const window = createPage(t);
    window.eval(source);
    const controller = createWrappedLiveController(window);
    const { slot, video } = wrapControllerVideoSlot(window, controller);
    video.currentTime = 125;
    const state = createWrappedLiveSource("LIVE_CHZZK_NDP_SCH_EVENT");
    controller.srcObject = state.wrapped;
    controller.srcObject = state.wrapped;
    const client = await state.wrapped.initAd("native-argument");
    assert.equal(state.calls.length, 0);
    assert.equal(client.client, undefined);
    assert.equal(client.playerType, "LIVE_PW");
    assert.equal(controller.srcObject, state.wrapped);
    assert.equal(controller.videoSlot, slot);
    assert.equal(controller.contentVideoElement, slot);
    assert.equal(slot.video, video);
    assert.equal(video.currentTime, 125);
    const status = JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status"));
    assert.equal(status.blockedWrappedLiveRequests, 1);
    assert.equal(status.blockedLiveSources, 0);
});

test("object video slot ownership follows native video replacement, detachment, routes and options", async (t) => {
    const window = createPage(t);
    window.eval(source);
    const controller = createWrappedLiveController(window);
    const { slot, video, root } = wrapControllerVideoSlot(window, controller);
    const state = createWrappedLiveSource("LIVE_CHZZK_NDP_SCH_EVENT");
    controller.srcObject = state.wrapped;
    assert.equal((await state.wrapped.initAd()).client, undefined);
    const parent = root.parentElement;
    root.remove();
    assert.equal((await state.wrapped.initAd()).client, state.linearClient);
    parent.append(root);
    assert.equal((await state.wrapped.initAd()).client, undefined);
    const nextVideo = window.document.createElement("video");
    video.replaceWith(nextVideo);
    assert.equal((await state.wrapped.initAd()).client, state.linearClient, "the detached original video is stale");
    slot._videoElement = nextVideo;
    assert.equal((await state.wrapped.initAd()).client, undefined);
    window.history.pushState({}, "", "/video/123");
    assert.equal((await state.wrapped.initAd()).client, state.linearClient);
    window.history.pushState({}, "", "/live/next");
    assert.equal((await state.wrapped.initAd()).client, undefined);
    setEnabled(window, false);
    assert.equal((await state.wrapped.initAd()).client, state.linearClient);
    setEnabled(window, true);
    assert.equal(
        (await state.wrapped.initAd()).client,
        state.linearClient,
        "re-enabling still requires a new document"
    );
});

test("unmeasured or inconsistent object video slots keep their native ad request", async (t) => {
    const window = createPage(t);
    window.eval(source);
    const variants = [
        ({ slot }) => delete slot.video,
        ({ slot }) => Object.defineProperty(slot, "video", { value: window.document.createElement("video") }),
        ({ slot }) => (slot.shadowRoot = window.document.createElement("div")),
        ({ slot, root }) => (slot._videoElement = root),
        ({ slot }) =>
            Object.defineProperty(slot, "_videoElement", {
                get: () => {
                    throw new Error("not a data field");
                },
            }),
        ({ controller }) => (controller.contentVideoElement = {}),
        ({ root }) => root.parentElement.remove(),
    ];
    for (const mutate of variants) {
        const controller = createWrappedLiveController(window);
        const parts = wrapControllerVideoSlot(window, controller);
        mutate({ ...parts, controller });
        const state = createWrappedLiveSource("LIVE_CHZZK_NDP_SCH_EVENT");
        controller.srcObject = state.wrapped;
        assert.equal((await state.wrapped.initAd()).client, state.linearClient);
        assert.equal(state.calls.length, 1);
        assert.equal(controller.srcObject, state.wrapped);
        parts.root.parentElement?.remove();
    }
});

test("native glad URI filtering recognizes the same object video slot and preserves media URLs", (t) => {
    const window = createPage(t, "/video/123");
    window.eval(source);
    const controller = createWrappedLiveController(window);
    const { slot, root } = wrapControllerVideoSlot(window, controller);
    let factoryCalls = 0;
    window.Object.defineProperty(controller, "src", {
        configurable: true,
        get() {
            return this._srcUri;
        },
        set(value) {
            factoryCalls++;
            this._srcUri = value;
            this._attachSourceObject({ uri: value });
        },
    });
    controller.src = "glad://load";
    assert.equal(factoryCalls, 0);
    assert.equal(controller.srcObject, null);
    assert.equal(controller.videoSlot, slot);
    controller.src = "https://media.example/video.m3u8";
    assert.equal(factoryCalls, 1);
    assert.equal(controller.srcObject.uri, "https://media.example/video.m3u8");
    root.parentElement.remove();
    controller.src = "glad://load";
    assert.equal(factoryCalls, 2, "a detached player tree no longer owns a native ad slot");
});

test("wrapped live requests keep their outer client and only omit the identified inner ad request", async (t) => {
    const window = createPage(t);
    window.eval(source);
    const controller = createWrappedLiveController(window);
    controller.videoSlot.currentTime = 123;
    for (const id of ["LIVE_CHZZK_NDP_SCH", "LIVE_CHZZK_NDP_SCH_EVENT"]) {
        const { wrapped, inner, calls } = createWrappedLiveSource(id);
        const init = wrapped._init;
        const initAd = wrapped.initAd;
        const handshake = wrapped.handshakeVersion;
        controller.srcObject = wrapped;
        controller.srcObject = wrapped;
        assert.equal(controller.srcObject, wrapped);
        assert.equal(wrapped._init, init);
        assert.equal(wrapped.initAd, initAd);
        assert.equal(wrapped.handshakeVersion, handshake);
        assert.equal(await wrapped.handshakeVersion(), "1");
        assert.deepEqual(await wrapped.initAd("native-argument"), {
            client: undefined,
            playerType: "LIVE_PW",
            uiElements: init.uiElements,
            disableTrackingCors: false,
        });
        assert.equal(calls.length, 0);
        assert.equal(inner._videoScheduleInfo.adScheduleParam.adScheduleId, id);
        assert.equal(controller.videoSlot.currentTime, 123);
    }
    const status = JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status"));
    assert.equal(status.blockedWrappedLiveRequests, 2, "reassigning a source must not stack request guards");
    assert.equal(status.blockedLiveSources, 0, "the outer source stays attached");
});

test("wrapped live filtering passes through unmeasured wrappers, sources, containers and property shapes", async (t) => {
    const window = createPage(t);
    window.eval(source);
    const variants = [
        ({ wrapped }) => (wrapped.constructor.Constants.NLIVECAST_ID = "other"),
        ({ wrapped }) => (wrapped._init.playerType = "LIVE_MW"),
        ({ wrapped }) => (wrapped._init.extra = true),
        ({ wrapped }) => (wrapped.handshakeVersion = undefined),
        ({ inner }) => (inner._videoScheduleInfo.customParam.svc = "other"),
        ({ inner }) => (inner._videoScheduleInfo.adScheduleParam.adScheduleId = "unknown"),
        ({ inner }) => (inner._videoScheduleInfo.adScheduleParam.adScheduleId = "CHZZK_NDP_SCH"),
        ({ wrapped }) => Object.freeze(wrapped._init),
        ({ wrapped }) => Object.defineProperty(wrapped._init, "linearAdRequest", { writable: false }),
        ({ wrapped, inner }) =>
            Object.defineProperty(wrapped._init, "linearAdRequest", { get: () => inner, configurable: true }),
        (_state, controller) => controller.videoSlot.parentElement.remove(),
        (_state, controller) => (controller.videoSlot.parentElement.className = "other-player"),
        (_state, controller) => (controller.stopAd = undefined),
    ];
    for (const change of variants) {
        const controller = createWrappedLiveController(window);
        const state = createWrappedLiveSource();
        change(state, controller);
        const before = Object.getOwnPropertyDescriptor(state.wrapped._init, "linearAdRequest");
        controller.srcObject = state.wrapped;
        const result = await state.wrapped.initAd("unchanged");
        assert.equal(result.client, state.linearClient);
        assert.deepEqual(state.calls, [["unchanged"]]);
        assert.equal(controller.srcObject, state.wrapped);
        assert.deepEqual(Object.getOwnPropertyDescriptor(state.wrapped._init, "linearAdRequest"), before);
    }
    const status = JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status"));
    assert.equal(status.blockedWrappedLiveRequests, 0);
});

test("wrapped live request guards recheck routes, ownership, remounts and replaced inner requests", async (t) => {
    const window = createPage(t);
    window.eval(source);
    let controller = createWrappedLiveController(window);
    const state = createWrappedLiveSource();
    controller.srcObject = state.wrapped;
    window.history.replaceState(null, "", "/video/123");
    assert.equal((await state.wrapped.initAd()).client, state.linearClient);
    window.history.replaceState(null, "", "/live/next");
    controller.videoSlot.remove();
    assert.equal((await state.wrapped.initAd()).client, state.linearClient);
    controller = createWrappedLiveController(window);
    controller.srcObject = state.wrapped;
    assert.equal((await state.wrapped.initAd()).client, undefined);
    const unknown = createWrappedLiveSource("unmeasured");
    state.wrapped._init.linearAdRequest = unknown.inner;
    assert.equal((await state.wrapped.initAd()).client, unknown.linearClient);
    state.wrapped._init.linearAdRequest = state.inner;
    controller.srcObject = null;
    assert.equal((await state.wrapped.initAd()).client, state.linearClient);
    controller.srcObject = state.wrapped;
    state.wrapped._init.playerType = "other";
    assert.equal((await state.wrapped.initAd()).client, state.linearClient);
    state.wrapped._init.playerType = "LIVE_PW";
    assert.equal((await state.wrapped.initAd()).client, undefined);
    setEnabled(window, false);
    assert.equal(state.wrapped._init.linearAdRequest, state.inner);
    const inheritedInit = Object.create(state.wrapped._init);
    inheritedInit.linearAdRequest = unknown.inner;
    assert.equal(inheritedInit.linearAdRequest, unknown.inner);
    assert.equal(
        state.wrapped._init.linearAdRequest,
        state.inner,
        "inherited writes cannot replace the owner's request"
    );
    assert.equal((await state.wrapped.initAd()).client, state.linearClient);
    setEnabled(window, true);
    assert.equal((await state.wrapped.initAd()).client, state.linearClient, "reactivation still requires a reload");
    const status = JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status"));
    assert.equal(status.blockedWrappedLiveRequests, 2);
    assert.equal(status.reloadRequired, true);
});

test("wrapped live requests preserve outer error handling and stay untouched until settings are confirmed", async (t) => {
    const window = createPage(t, "/live/channel", null);
    window.eval(source);
    const controller = createWrappedLiveController(window);
    const state = createWrappedLiveSource();
    const original = Object.getOwnPropertyDescriptor(state.wrapped._init, "linearAdRequest");
    controller.srcObject = state.wrapped;
    assert.equal((await state.wrapped.initAd()).client, state.linearClient);
    assert.deepEqual(Object.getOwnPropertyDescriptor(state.wrapped._init, "linearAdRequest"), original);
    setEnabled(window, true);
    controller.srcObject = state.wrapped;
    assert.equal((await state.wrapped.initAd()).client, undefined);
    setEnabled(window, false);
    const failure = new Error("native request failure");
    let failedCalls = 0;
    state.inner.initAd = async () => {
        failedCalls++;
        throw failure;
    };
    assert.equal((await state.wrapped.initAd()).client, undefined);
    assert.equal(failedCalls, 1, "the original outer method still handles a failed inner request");
});

test("known live schedules are blocked independently of VOD schedules", (t) => {
    const window = createPage(t);
    window.eval(source);
    const controller = createAdController(window);
    for (const adScheduleId of ["LIVE_CHZZK_NDP_SCH", "LIVE_CHZZK_NDP_SCH_EVENT"]) {
        const live = createVodAdSource();
        live._videoScheduleInfo = { adScheduleParam: { adScheduleId }, customParam: { svc: "chzzk_live" } };
        controller.srcObject = live;
        assert.equal(controller.srcObject, null);
    }
    assert.equal(
        JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status")).blockedLiveSources,
        2
    );
});

test("native glad URI assignments are stopped before the source factory and do not affect media URLs", (t) => {
    const window = createPage(t, "/video/123");
    window.document.body.innerHTML = '<div class="chzzk_player"><video></video></div>';
    window.eval(source);
    const controller = createAdController(window);
    controller.videoSlot = window.document.querySelector("video");
    let factoryCalls = 0;
    window.Object.defineProperty(controller, "src", {
        configurable: true,
        get() {
            return this._srcUri;
        },
        set(value) {
            factoryCalls++;
            this._srcUri = value;
            this._attachSourceObject({ uri: value });
        },
    });
    controller.src = "glad://load";
    assert.equal(factoryCalls, 0);
    assert.equal(controller.src, "");
    assert.equal(controller.srcObject, null);
    controller.src = "https://media.example/video.m3u8";
    assert.equal(factoryCalls, 1);
    assert.equal(controller.src, "https://media.example/video.m3u8");
    controller.videoSlot.remove();
    controller.src = "glad://load";
    assert.equal(factoryCalls, 2, "detached or unrelated players must keep native behavior");
    setEnabled(window, false);
    controller.src = "glad://load";
    assert.equal(factoryCalls, 3);
});

test("live mid-roll keeps native schedule completion with no creative preparation", (t) => {
    const window = createPage(t);
    window.document.body.innerHTML = '<div id="midAdPlayerWrapper"><div id="midAdVideoContainer"></div></div>';
    const container = window.document.getElementById("midAdVideoContainer");
    const oldSet = window.WeakMap.prototype.set;
    window.eval(source);
    const schedules = [];
    // 모델링한 네이티브 계약: adSources가 비면 매체 준비 없이 SCHEDULE_COMPLETE로 끝난다.
    const manager = {
        loadWithAdSchedule(value) {
            schedules.push(value);
            return "native-result";
        },
        getAdDisplayContainerInfo() {},
        startAdSchedule() {
            return schedules.at(-1).adBreaks.flatMap((entry) => entry.adSources).length === 0
                ? "SCHEDULE_COMPLETE"
                : "prepare";
        },
    };
    const map = new window.WeakMap();
    assert.equal(map.set(container, manager), map);
    assert.equal(map.get(container), manager);
    const schedule = {
        requestId: "preserve",
        adBreaks: [
            { id: "id", adUnitId: "w_live_chzzk_naver_va_mid", startDelay: 0, adSources: [{ id: "0", delay: 5000 }] },
        ],
    };
    assert.equal(manager.loadWithAdSchedule(schedule), "native-result");
    assert.deepEqual(Array.from(schedules[0].adBreaks[0].adSources), []);
    assert.equal(schedules[0].requestId, "preserve");
    assert.equal(schedule.adBreaks[0].adSources.length, 1, "caller-owned input is never mutated");
    assert.equal(manager.startAdSchedule(), "SCHEDULE_COMPLETE");
    const unknown = { adBreaks: [{ ...schedule.adBreaks[0], adUnitId: "other-service" }] };
    manager.loadWithAdSchedule(unknown);
    assert.equal(schedules.at(-1), unknown);
    container.remove();
    manager.loadWithAdSchedule(schedule);
    assert.equal(schedules.at(-1), schedule);
    window.document.getElementById("midAdPlayerWrapper").append(container);
    window.history.replaceState(null, "", "/video/123");
    manager.loadWithAdSchedule(schedule);
    assert.equal(schedules.at(-1), schedule);
    window.history.replaceState(null, "", "/live/channel");
    setEnabled(window, false);
    assert.equal(window.WeakMap.prototype.set, oldSet);
    manager.loadWithAdSchedule(schedule);
    assert.equal(schedules.at(-1), schedule);
});

test("WeakMap guard preserves unrelated registrations, native errors and later wrappers", (t) => {
    const window = createPage(t);
    window.eval(source);
    const key = {},
        manager = { loadWithAdSchedule() {} },
        method = manager.loadWithAdSchedule;
    const map = new window.WeakMap();
    map.set(key, manager);
    assert.equal(manager.loadWithAdSchedule, method);
    assert.throws(() => map.set(1, manager), { name: "TypeError" });
    const current = window.WeakMap.prototype.set;
    const later = function (...args) {
        return Reflect.apply(current, this, args);
    };
    window.WeakMap.prototype.set = later;
    setEnabled(window, false);
    assert.equal(window.WeakMap.prototype.set, later);
    assert.equal(map.set(key, manager), map);
});

test("source descriptors retain inherited metadata and native invalid-descriptor errors", (t) => {
    const window = createPage(t);
    window.eval(source);
    const target = {};
    const descriptor = Object.create({
        enumerable: true,
        configurable: true,
        get() {
            return this.value;
        },
        set(value) {
            this.value = value;
        },
    });
    window.Object.defineProperty(target, "src", descriptor);
    target.src = "content";
    assert.equal(target.src, "content");
    assert.equal(Object.getOwnPropertyDescriptor(target, "src").enumerable, true);
    assert.throws(() => window.Object.defineProperty({}, "src", { value: 1, set() {} }), { name: "TypeError" });
});

test("VOD ad sources never reach preparation while main video setters remain untouched", (t) => {
    const window = createPage(t, "/video/15131992");
    window.eval(source);
    const controller = createAdController(window);
    let preparations = 0;
    const ad = createVodAdSource(() => preparations++);
    controller.srcObject = ad;
    controller.initAd();
    assert.equal(controller.srcObject, null);
    assert.equal(preparations, 0);
    assert.equal(ad._videoScheduleInfo.adScheduleParam.adScheduleId, "CHZZK_NDP_SCH");
    const mainVideo = {};
    window.Object.defineProperty(mainVideo, "srcObject", {
        get() {
            return this.media;
        },
        set(value) {
            this.media = value;
        },
    });
    mainVideo.srcObject = ad;
    assert.equal(mainVideo.srcObject, ad);
    assert.equal(
        JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status")).blockedVodSources,
        1
    );
});

test("source guard follows settings, SPA routes and newly created controllers without changing unknown sources", (t) => {
    const window = createPage(t, "/", null);
    const originalDefine = window.Object.defineProperty;
    window.eval(source);
    const controller = createAdController(window);
    const ad = createVodAdSource();
    controller.srcObject = ad;
    assert.equal(controller.srcObject, ad);
    setEnabled(window, true);
    controller.srcObject = ad;
    assert.equal(controller.srcObject, ad);
    window.history.replaceState(null, "", "/video/15131992");
    controller.srcObject = ad;
    assert.equal(controller.srcObject, null);
    const remounted = createAdController(window);
    remounted.srcObject = ad;
    assert.equal(remounted.srcObject, null);
    for (const value of [
        null,
        {},
        { ...ad, _videoScheduleInfo: {} },
        { ...ad, _videoScheduleInfo: { ...ad._videoScheduleInfo, customParam: { svc: "other" } } },
        { ...ad, _videoScheduleInfo: { ...ad._videoScheduleInfo, adScheduleParam: { adScheduleId: "unknown" } } },
    ]) {
        controller.srcObject = value;
        assert.equal(controller.srcObject, value);
    }
    window.history.replaceState(null, "", "/live/channel");
    controller.srcObject = ad;
    assert.equal(controller.srcObject, ad);
    window.history.replaceState(null, "", "/video/other");
    setEnabled(window, false);
    assert.equal(window.Object.defineProperty, originalDefine);
    controller.srcObject = ad;
    assert.equal(controller.srcObject, ad);
    assert.equal(
        JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status")).reloadRequired,
        true
    );
});

test("source interceptor keeps later property wrappers and native setter exceptions", (t) => {
    const window = createPage(t, "/video/15131992");
    window.eval(source);
    const installed = window.Object.defineProperty;
    const later = (...args) => installed(...args);
    window.Object.defineProperty = later;
    const target = {};
    window.Object.defineProperty(target, "srcObject", {
        get() {},
        set() {
            throw new Error("native failure");
        },
    });
    assert.throws(() => {
        target.srcObject = createVodAdSource();
    }, /native failure/);
    setEnabled(window, false);
    assert.equal(window.Object.defineProperty, later);
    const controller = createAdController(window);
    const ad = createVodAdSource();
    controller.srcObject = ad;
    assert.equal(controller.srcObject, ad);
});

test("measured ad decision changes only the two boolean flags and preserves response metadata", (t) => {
    const window = createPage(t);
    window.eval(source);
    const result = parse(window, { ...measured, trace: "keep-response-metadata" });
    assert.deepEqual(result, {
        ...measured,
        trace: "keep-response-metadata",
        content: { livePlaybackJson: { liveId: false, chatChannelId: false } },
    });
    assert.equal(measured.content.livePlaybackJson.liveId, true);
    assert.equal(
        JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status")).changedParses,
        1
    );
});

// 2026-09-11 배포 클라이언트의 분기에서 확인한 형식. 캡처한 서버 응답은 아니다.
test("explicit player ad decisions disable pre-roll and mid-roll on live and VOD routes", (t) => {
    for (const pathname of ["/live/channel", "/video/15131992"]) {
        const window = createPage(t, pathname);
        window.eval(source);
        for (const preRoll of [false, true]) {
            for (const midRoll of [false, true]) {
                const input = {
                    code: 200,
                    message: null,
                    trace: "preserve",
                    content: { playerAdDisplayResponse: { preRoll, midRoll } },
                };
                assert.deepEqual(parse(window, input), {
                    ...input,
                    content: { playerAdDisplayResponse: { preRoll: false, midRoll: false } },
                });
            }
        }
        assert.equal(
            JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status")).changedParses,
            3
        );
        const input = {
            code: 200,
            message: null,
            content: { playerAdDisplayResponse: { preRoll: true, midRoll: true } },
        };
        window.history.replaceState(null, "", "/");
        assert.deepEqual(parse(window, input), input);
        window.history.replaceState(null, "", pathname);
        setEnabled(window, false);
        assert.deepEqual(parse(window, input), input);
    }
});

test("explicit ad decisions preserve unknown fields, invalid flags, and reviver behavior", (t) => {
    const window = createPage(t, "/video/15131992");
    window.eval(source);
    const input = { code: 200, message: null, content: { playerAdDisplayResponse: { preRoll: true, midRoll: true } } };
    for (const value of [
        { ...input, code: 403 },
        { ...input, message: "error" },
        { ...input, content: { ...input.content, media: [] } },
        { ...input, content: { playerAdDisplayResponse: { preRoll: true, midRoll: true, postRoll: true } } },
        { ...input, content: { playerAdDisplayResponse: { preRoll: "true", midRoll: true } } },
        { ...input, content: { playerAdDisplayResponse: { preRoll: true } } },
        { ...input, content: { playerAdDisplayResponse: null } },
        { ...input, content: { playerAdDisplayResponse: [] } },
        { ...input, trace: "x".repeat(2048) },
    ]) {
        assert.deepEqual(parse(window, value), value);
    }
    assert.equal(
        window.JSON.parse(JSON.stringify(input), (_key, value) => value).content.playerAdDisplayResponse.midRoll,
        true
    );
    assert.equal(
        JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status")).changedParses,
        0
    );
});

test("real playback data, unmeasured shapes, errors, revivers, and unrelated routes pass through", (t) => {
    const window = createPage(t);
    window.eval(source);
    const playback = {
        liveId: 123,
        chatChannelId: "chat-id",
        media: [{ path: "https://example.invalid/master.m3u8", encodingTrack: [{ videoHeight: 1080 }] }],
    };
    const values = [
        { ...measured, code: 403 },
        { ...measured, content: { livePlaybackJson: playback } },
        { ...measured, content: { livePlaybackJson: JSON.stringify(playback) } },
        { ...measured, content: { ...measured.content, auth: "preserve" } },
        { ...measured, content: { livePlaybackJson: { ...measured.content.livePlaybackJson, media: [] } } },
        { ...measured, content: { livePlaybackJson: { liveId: "true", chatChannelId: true } } },
        { ...measured, content: { livePlaybackJson: { liveId: false, chatChannelId: false } } },
        { content: { playerAdDisplayResponse: { preRoll: true, midRoll: true } } },
        null,
        [],
        { ads: [{ title: "unrelated" }] },
    ];
    for (const value of values) assert.deepEqual(parse(window, value), value);
    const serialized = JSON.stringify(measured);
    const withReviver = window.JSON.parse(serialized, (_key, value) => value);
    assert.equal(withReviver.content.livePlaybackJson.liveId, true);
    assert.throws(() => window.JSON.parse("{"), { name: "SyntaxError" });
    window.history.replaceState(null, "", "/");
    assert.deepEqual(parse(window, measured), measured);
    window.history.replaceState(null, "", "/video/123");
    assert.equal(parse(window, measured).content.livePlaybackJson.liveId, false);
});

test("retired grid settings leave P2P playback metadata unchanged with ads enabled or disabled", (t) => {
    for (const gridEnabled of [false, true]) {
        for (const adsEnabled of [false, true]) {
            const window = createPage(t);
            window.document.documentElement.setAttribute("data-betterchzzk-grid-bypass-state", gridEnabled ? "1" : "0");
            const originalParse = window.JSON.parse;
            if (adsEnabled) window.eval(source);
            const playback = {
                meta: { p2p: true },
                media: [
                    {
                        mediaId: "HLS",
                        protocol: "HLS",
                        path: "https://livecloud.pstatic.net/master.m3u8",
                        p2pPath: "nliveconnector://master",
                        encodingTrack: [{ videoHeight: 1080 }],
                    },
                ],
            };
            assert.equal(parse(window, measured).content.livePlaybackJson.liveId, !adsEnabled);
            const result = parse(window, playback);
            assert.equal(result.meta.p2p, true);
            assert.equal(result.media[0].path, playback.media[0].path);
            assert.deepEqual(result.media[0].encodingTrack, playback.media[0].encodingTrack);
            if (adsEnabled) {
                setEnabled(window, false);
                assert.equal(window.JSON.parse, originalParse);
                assert.deepEqual(parse(window, measured), measured);
                assert.equal(parse(window, playback).meta.p2p, true);
            }
        }
    }
});

test("disable preserves a later wrapper and requires reload before reactivation", (t) => {
    const window = createPage(t);
    window.eval(source);
    const adParse = window.JSON.parse;
    let laterCalls = 0;
    const laterParse = function (...args) {
        laterCalls += 1;
        return Reflect.apply(adParse, this, args);
    };
    window.JSON.parse = laterParse;
    setEnabled(window, false);
    assert.equal(window.JSON.parse, laterParse);
    assert.deepEqual(parse(window, measured), measured);
    assert.equal(laterCalls, 1);
    setEnabled(window, true);
    assert.deepEqual(parse(window, measured), measured);
    const state = JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status"));
    assert.equal(state.active, false);
    assert.equal(state.reloadRequired, true);
    window.eval(source);
    assert.equal(window.JSON.parse, laterParse);
});

test("isolated bridge waits for real settings and turns off the running hook", (t) => {
    const window = createPage(t, "/live/measured-channel", null);
    let optionsChanged;
    window.BetterChzzk = {
        utils: {
            bindFeatureOptions(fn) {
                optionsChanged = fn;
            },
            onReady(fn) {
                fn();
            },
        },
    };
    window.eval(bridge);
    assert.equal(window.document.documentElement.hasAttribute("data-betterchzzk-ad-video-state"), false);
    window.eval(source);
    optionsChanged({ adVideoEnabled: true });
    assert.equal(parse(window, measured).content.livePlaybackJson.liveId, false);
    optionsChanged({ adVideoEnabled: false });
    assert.deepEqual(parse(window, measured), measured);
});

test("a persisted hook never changes responses before settings are loaded or when the saved setting is off", (t) => {
    const window = createPage(t, "/live/measured-channel", null);
    window.eval(source);
    assert.deepEqual(parse(window, measured), measured);
    setEnabled(window, true);
    assert.equal(parse(window, measured).content.livePlaybackJson.liveId, false);
    const stale = createPage(t, "/live/measured-channel", "0");
    const previous = stale.JSON.parse;
    stale.eval(source);
    assert.equal(stale.JSON.parse, previous);
    assert.deepEqual(parse(stale, measured), measured);
});
