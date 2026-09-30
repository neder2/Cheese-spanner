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
    const controller = Object.create(prototype);
    const root = window.document.createElement("div");
    root.className = "chzzk_player";
    controller.videoSlot = root.appendChild(window.document.createElement("video"));
    controller.contentVideoElement = controller.videoSlot;
    window.document.body.append(root);
    return controller;
}

function createVodAdSource(prepare = () => {}) {
    return {
        _videoScheduleInfo: {
            adScheduleParam: { adScheduleId: "CHZZK_NDP_SCH" },
            customParam: { svc: "chzzk_video" },
        },
        setVideoScheduleInfo() {},
        handshakeVersion() {},
        initAd() {},
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
        handshakeVersion() {},
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
    return createAdController(window);
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
        ({ wrapped }) => (wrapped._init.uiElements = "invalid"),
        ({ wrapped }) => (wrapped.handshakeVersion = undefined),
        ({ inner }) => (inner._videoScheduleInfo.customParam.svc = "other"),
        ({ inner }) => (inner._videoScheduleInfo.adScheduleParam.adScheduleId = ""),
        ({ inner }) => (inner._videoScheduleInfo.adScheduleParam.adScheduleId = 123),
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
    unknown.inner._videoScheduleInfo.customParam.svc = "other";
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
    window.document.body.innerHTML =
        '<div id="midAdPlayerWrapper"><video></video><div id="midAdVideoContainer"></div></div>';
    const container = window.document.getElementById("midAdVideoContainer");
    bindScheduleOwner(window, container, window.document.querySelector("video"));
    const oldSet = window.WeakMap.prototype.set;
    window.eval(source);
    const schedules = [];
    const displayInfo = { adVideoContainer: container, contentVideo: window.document.querySelector("video") };
    // 모델링한 네이티브 계약: adSources가 비면 매체 준비 없이 SCHEDULE_COMPLETE로 끝난다.
    const manager = {
        loadWithAdSchedule(value) {
            schedules.push(value);
            return "native-result";
        },
        getAdDisplayContainerInfo() {
            return displayInfo;
        },
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
    const unknown = { adBreaks: [{ ...schedule.adBreaks[0], adUnitId: "" }] };
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

function bindScheduleOwner(window, container, video) {
    // 현재 입장/중간 컴포넌트의 첫 두 useRef와 동일한 DOM 소유 관계를 모델링한다.
    const videoRef = { current: video };
    const containerRef = { current: container };
    const owner = {
        memoizedProps: { channelId: window.location.pathname.split("/")[2] || "channel", liveId: 1 },
        memoizedState: { memoizedState: videoRef, next: { memoizedState: containerRef, next: null } },
        return: null,
    };
    const host = { stateNode: container.parentElement, return: owner };
    container.__reactFiber$ad = { stateNode: container, return: host };
    video.__reactFiber$ad = { stateNode: video, return: host };
    return { owner, videoRef, containerRef, host };
}

function createScheduleHarness(window) {
    const root = window.document.createElement("section");
    // SDK의 공개 소유 관계를 모델링한다. 페이지 컨테이너 ID에 의존하지 않는다.
    root.innerHTML = '<video></video><div class="ad-slot"></div>';
    window.document.body.append(root);
    const container = root.querySelector("div");
    const video = root.querySelector("video");
    const info = { adVideoContainer: container, contentVideo: video };
    const binding = bindScheduleOwner(window, container, video);
    const calls = [];
    const manager = {
        getAdDisplayContainerInfo: () => info,
        loadWithAdSchedule(schedule, ...rest) {
            calls.push({ schedule, rest, receiver: this });
            return "loaded";
        },
        // 실제 SDK는 빈 광고 항목을 정상 완료하며 페이지는 NO_ADS로 본방송에 진입한다.
        startAdSchedule() {
            return calls.at(-1).schedule.adBreaks.some((entry) => entry.adSources.length)
                ? "prepare"
                : "SCHEDULE_COMPLETE";
        },
    };
    return { root, container, video, info, manager, calls, ...binding };
}

function liveSchedule(adUnitId = "w_live_chzzk_naver_va") {
    // 2026-09-23 배포 페이지의 입장 광고 스케줄 생성 계약. 서버 응답 fixture가 아니다.
    return {
        adBreaks: [
            { id: "id", adUnitId, startDelay: 0, adSources: [{ id: "0", withRemindAd: 0, delay: 0 }], preFetch: 0 },
        ],
        head: { description: "", version: "" },
        requestId: "preserve-request",
        videoAdScheduleId: "",
    };
}

test("live pre-roll and mid-roll use SDK ownership and known units independently of DOM names", (t) => {
    const window = createPage(t);
    window.eval(source);
    const map = new window.WeakMap();
    for (const unit of [
        "w_live_chzzk_naver_va",
        "event_w_live_chzzk_naver_va",
        "w_live_chzzk_naver_va_mid",
        "event_w_live_chzzk_naver_va_mid",
    ]) {
        const h = createScheduleHarness(window);
        const schedule = liveSchedule(unit);
        Object.freeze(schedule.adBreaks[0].adSources);
        Object.freeze(schedule.adBreaks[0]);
        Object.freeze(schedule.adBreaks);
        Object.freeze(schedule);
        map.set(h.container, h.manager);
        const installed = h.manager.loadWithAdSchedule;
        map.set(h.container, h.manager);
        assert.equal(h.manager.loadWithAdSchedule, installed, "repeated registration does not stack wrappers");
        assert.equal(h.manager.loadWithAdSchedule(schedule, "extra"), "loaded");
        const { schedule: result, rest, receiver } = h.calls.at(-1);
        assert.equal(result.adBreaks[0].adSources.length, 0);
        assert.equal(result.head, schedule.head);
        assert.equal(result.requestId, schedule.requestId);
        assert.equal(result.adBreaks[0].preFetch, 0);
        assert.equal(schedule.adBreaks[0].adSources.length, 1);
        assert.deepEqual(rest, ["extra"]);
        assert.equal(receiver, h.manager);
        assert.equal(h.manager.startAdSchedule(), "SCHEDULE_COMPLETE");
        h.root.remove();
    }
    const status = JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status"));
    assert.equal(status.blockedLiveSchedules, 4);
    assert.equal(status.blockedLivePreRollSchedules, 2);
});

test("live schedule filtering rechecks routes, ownership, remounts and option lifetime", (t) => {
    const window = createPage(t, "/");
    window.eval(source);
    const h = createScheduleHarness(window);
    new window.WeakMap().set(h.container, h.manager);
    const schedule = liveSchedule();
    const assertPass = () => {
        h.manager.loadWithAdSchedule(schedule);
        assert.equal(h.calls.at(-1).schedule, schedule);
    };
    const assertBlock = () => {
        h.manager.loadWithAdSchedule(schedule);
        assert.equal(h.calls.at(-1).schedule.adBreaks[0].adSources.length, 0);
    };
    assertPass();
    window.history.replaceState(null, "", "/live/channel");
    assertBlock();
    h.container.id = "renamed-container";
    h.root.id = "renamed-wrapper";
    assertBlock();
    h.video.remove();
    assertPass();
    h.root.prepend(h.video);
    assertBlock();
    h.info.adVideoContainer = h.root;
    assertPass();
    h.info.adVideoContainer = h.container;
    h.root.remove();
    assertPass();
    window.document.body.append(h.root);
    assertBlock();
    const replacement = window.document.createElement("video");
    h.video.replaceWith(replacement);
    assertPass();
    h.info.contentVideo = replacement;
    h.videoRef.current = replacement;
    replacement.__reactFiber$ad = { stateNode: replacement, return: h.host };
    assertBlock();
    window.history.replaceState(null, "", "/video/123");
    assertPass();
    window.history.replaceState(null, "", "/live/next-channel");
    h.owner.memoizedProps.channelId = "next-channel";
    assertBlock();
    setEnabled(window, false);
    assertPass();
    setEnabled(window, true);
    assertPass();
    assert.equal(
        JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status")).reloadRequired,
        true
    );
});

test("live schedule filtering preserves unknown entries, mismatched managers and native failures", (t) => {
    const window = createPage(t);
    window.eval(source);
    const h = createScheduleHarness(window);
    const map = new window.WeakMap();
    map.set(h.container, h.manager);
    for (const input of [null, {}, { adBreaks: null }, liveSchedule(""), liveSchedule(123)]) {
        h.manager.loadWithAdSchedule(input);
        assert.equal(h.calls.at(-1).schedule, input);
    }
    const unknown = liveSchedule("").adBreaks[0];
    const empty = { ...liveSchedule().adBreaks[0], adSources: [] };
    const malformed = { ...liveSchedule().adBreaks[0], adSources: null };
    const input = { ...liveSchedule(), adBreaks: [unknown, empty, malformed, ...liveSchedule().adBreaks] };
    h.manager.loadWithAdSchedule(input);
    const output = h.calls.at(-1).schedule;
    assert.equal(output.adBreaks[0], unknown);
    assert.equal(output.adBreaks[1], empty);
    assert.equal(output.adBreaks[2], malformed);
    assert.equal(output.adBreaks[3].adSources.length, 0);
    h.manager.loadWithAdSchedule.call({}, input);
    assert.equal(h.calls.at(-1).schedule, input, "borrowed methods retain native receiver behavior");
    h.manager.getAdDisplayContainerInfo = () => {
        throw new Error("unknown SDK state");
    };
    h.manager.loadWithAdSchedule(input);
    assert.equal(h.calls.at(-1).schedule, input, "inspection failure must not stop native loading");

    const other = createScheduleHarness(window);
    const original = other.manager.loadWithAdSchedule;
    map.set(h.container, other.manager);
    assert.equal(other.manager.loadWithAdSchedule, original);
    Object.freeze(other.manager);
    assert.equal(map.set(other.container, other.manager), map);
    assert.equal(other.manager.loadWithAdSchedule, original);

    const failing = createScheduleHarness(window);
    const error = new Error("native load failure");
    failing.manager.loadWithAdSchedule = () => {
        throw error;
    };
    map.set(failing.container, failing.manager);
    assert.throws(
        () => failing.manager.loadWithAdSchedule(liveSchedule()),
        (value) => value === error
    );
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

test("schedule application preserves each native Promise, call and processing counter", (t) => {
    const window = createPage(t);
    window.eval(source);
    const h = createScheduleHarness(window);
    const result = Promise.resolve("native-load-result");
    const nativeError = new Error("native-load-error");
    let fail = false;
    h.manager.loadWithAdSchedule = function (schedule, ...rest) {
        h.calls.push({ schedule, rest, receiver: this });
        if (fail) throw nativeError;
        return result;
    };
    new window.WeakMap().set(h.container, h.manager);
    const status = () => JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status"));
    const schedule = liveSchedule();
    assert.equal(h.manager.loadWithAdSchedule(schedule, "extra"), result);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].receiver, h.manager);
    assert.deepEqual(h.calls[0].rest, ["extra"]);
    assert.equal(h.calls[0].schedule.adBreaks[0].adSources.length, 0);
    assert.equal(schedule.adBreaks[0].adSources.length, 1);
    assert.equal(status().blockedLiveSchedules, 1);
    assert.equal(status().blockedLivePreRollSchedules, 1);

    const alreadyEmpty = h.calls[0].schedule;
    assert.equal(h.manager.loadWithAdSchedule(alreadyEmpty), result);
    assert.equal(h.calls[1].schedule, alreadyEmpty);
    assert.equal(status().blockedLiveSchedules, 1);
    const otherReceiver = {};
    assert.equal(h.manager.loadWithAdSchedule.call(otherReceiver, schedule), result);
    assert.equal(h.calls[2].receiver, otherReceiver);
    assert.equal(h.calls[2].schedule, schedule);
    assert.equal(status().blockedLiveSchedules, 1);

    fail = true;
    assert.throws(
        () => h.manager.loadWithAdSchedule(schedule),
        (error) => error === nativeError
    );
    assert.equal(h.calls.length, 4);
    assert.equal(status().blockedLiveSchedules, 2, "the existing counter records processing before native loading");
    assert.equal(status().blockedLivePreRollSchedules, 2);
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
        { ...ad, _videoScheduleInfo: { ...ad._videoScheduleInfo, adScheduleParam: { adScheduleId: "" } } },
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

test("source application preserves setter return identity and counts only a returned native assignment", (t) => {
    const window = createPage(t, "/video/123");
    window.eval(source);
    const controller = createAdController(window);
    const result = Promise.resolve("native-setter-result");
    const nativeError = new Error("native-setter-error");
    const calls = [];
    let fail = false;
    window.Object.defineProperty(controller, "srcObject", {
        configurable: true,
        get() {
            return this.attached;
        },
        set(value) {
            calls.push({ value, receiver: this });
            if (fail) throw nativeError;
            this._attachSourceObject(value);
            return result;
        },
    });
    const setter = window.Object.getOwnPropertyDescriptor(controller, "srcObject").set;
    const ad = createVodAdSource();
    const status = () => JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status"));
    assert.equal(setter.call(controller, ad), result);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].receiver, controller);
    assert.equal(calls[0].value, null);
    assert.equal(status().blockedVodSources, 1);
    fail = true;
    assert.throws(
        () => setter.call(controller, ad),
        (error) => error === nativeError
    );
    assert.equal(calls.length, 2);
    assert.equal(status().blockedVodSources, 1, "a throwing native setter does not record a completed assignment");
    fail = false;
    setEnabled(window, false);
    assert.equal(setter.call(controller, ad), result);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].value, ad);
    assert.equal(status().blockedVodSources, 1);
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
        { ...input, content: { playerAdDisplayResponse: { preRoll: "true", midRoll: true } } },
        { ...input, content: { playerAdDisplayResponse: { preRoll: true } } },
        { ...input, content: { playerAdDisplayResponse: null } },
        { ...input, content: { playerAdDisplayResponse: [] } },
        { ...input, trace: "x".repeat(65536) },
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

test("explicit decisions accept additive fields and exact UTF-16 limits while legacy stays narrow", (t) => {
    const window = createPage(t);
    window.eval(source);
    const input = {
        code: 200,
        message: null,
        content: {
            playerAdDisplayResponse: { preRoll: true, midRoll: true, postRoll: true, extra: { keep: 1 } },
            livePlaybackJson: { liveId: true, chatChannelId: true },
            media: [{ source: "content" }],
        },
        trace: "x".repeat(3000),
    };
    const result = parse(window, input);
    assert.deepEqual(result, {
        ...input,
        content: {
            ...input.content,
            playerAdDisplayResponse: { ...input.content.playerAdDisplayResponse, preRoll: false, midRoll: false },
        },
    });
    const sized = (value, length) => {
        const text = JSON.stringify({ ...value, padding: "" });
        return JSON.stringify({ ...value, padding: "x".repeat(length - text.length) });
    };
    const explicit = {
        code: 200,
        message: null,
        content: { playerAdDisplayResponse: { preRoll: true, midRoll: true } },
    };
    assert.equal(window.JSON.parse(sized(explicit, 65536)).content.playerAdDisplayResponse.preRoll, false);
    assert.equal(window.JSON.parse(sized(explicit, 65537)).content.playerAdDisplayResponse.preRoll, true);
    assert.equal(window.JSON.parse(sized(measured, 2048)).content.livePlaybackJson.liveId, false);
    assert.equal(window.JSON.parse(sized(measured, 2049)).content.livePlaybackJson.liveId, true);
    for (const flags of [null, [], { preRoll: 1, midRoll: true }]) {
        const invalid = { ...measured, content: { ...measured.content, playerAdDisplayResponse: flags } };
        assert.deepEqual(parse(window, invalid), invalid, "invalid explicit data never falls back to legacy fields");
    }
});

test("new direct schedule IDs require ad APIs, matching service and connected CHZZK ownership", (t) => {
    for (const route of ["/live/channel", "/video/123"]) {
        const window = createPage(t, route);
        window.eval(source);
        const controller = createAdController(window);
        const adSource = createVodAdSource();
        adSource._videoScheduleInfo.adScheduleParam.adScheduleId = "NEW_SCHEDULE";
        adSource._videoScheduleInfo.customParam.svc = route.startsWith("/live/") ? "chzzk_live" : "chzzk_video";
        controller.srcObject = adSource;
        assert.equal(controller.srcObject, null);
        const variants = [
            (ad) => (ad._videoScheduleInfo.customParam.svc = "other"),
            (ad) => (ad._videoScheduleInfo.adScheduleParam.adScheduleId = ""),
            (ad) => (ad._videoScheduleInfo.adScheduleParam.adScheduleId = 5),
            (ad) => (ad.initAd = null),
            (ad) => (ad.handshakeVersion = null),
            (_ad, owner) => (owner.videoSlot.parentElement.className = "other-player"),
        ];
        for (const mutate of variants) {
            const owner = createAdController(window);
            const ad = {
                ...adSource,
                _videoScheduleInfo: {
                    adScheduleParam: { adScheduleId: "NEW" },
                    customParam: { ...adSource._videoScheduleInfo.customParam },
                },
            };
            mutate(ad, owner);
            owner.srcObject = ad;
            assert.equal(owner.srcObject, ad);
        }
    }
});

test("wrapped sources keep outer identity with additive fields and direct-source lookalikes", async (t) => {
    const window = createPage(t);
    window.eval(source);
    const controller = createAdController(window);
    const state = createWrappedLiveSource("NEW_LIVE_SCHEDULE");
    state.wrapped._init.metadata = { preserve: true };
    let extraReads = 0;
    Object.defineProperty(state.wrapped._init, "future", {
        get() {
            extraReads++;
            throw new Error("do not read");
        },
    });
    state.wrapped.setVideoScheduleInfo = state.inner.setVideoScheduleInfo;
    state.wrapped._videoScheduleInfo = state.inner._videoScheduleInfo;
    controller.srcObject = state.wrapped;
    assert.equal(controller.srcObject, state.wrapped);
    assert.equal((await state.wrapped.initAd()).client, undefined);
    assert.equal(extraReads, 0);
    assert.equal(state.wrapped._init.metadata.preserve, true);
    const status = JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status"));
    assert.equal(status.blockedLiveSources, 0);
    assert.equal(status.blockedWrappedLiveRequests, 1);
});

test("deferred sources are decided once before native init and retain Promise identity", (t) => {
    const window = createPage(t, "/video/123");
    window.eval(source);
    const controller = createAdController(window);
    const root = controller.videoSlot.parentElement;
    root.remove();
    const promise = Promise.resolve("native-result");
    const calls = [];
    controller.initAd = function (...args) {
        calls.push({ source: this.srcObject, receiver: this, args });
        return promise;
    };
    const ad = createVodAdSource();
    ad._videoScheduleInfo.adScheduleParam.adScheduleId = "NEW_DEFERRED";
    controller.srcObject = ad;
    assert.equal(controller.srcObject, ad);
    window.document.body.append(root);
    assert.equal(controller.initAd("arg"), promise);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].source, null);
    assert.equal(calls[0].receiver, controller);
    assert.deepEqual(calls[0].args, ["arg"]);
});

test("a deferred source that entered native init cannot be rearmed during or after initialization", async (t) => {
    const window = createPage(t, "/video/123");
    window.eval(source);
    const controller = createAdController(window);
    const root = controller.videoSlot.parentElement;
    root.remove();
    let resolve;
    const promise = new Promise((done) => (resolve = done));
    let entered = false;
    let stopped = 0;
    controller.initAd = () => {
        entered = true;
        return promise;
    };
    controller._attachSourceObject = function (value) {
        if (entered && value !== this.attached) stopped++;
        this.attached = value;
    };
    const ad = createVodAdSource();
    controller.srcObject = ad;
    assert.equal(controller.initAd(), promise);
    window.document.body.append(root);
    controller.srcObject = ad;
    assert.equal(controller.srcObject, ad);
    assert.equal(controller.initAd(), promise);
    resolve();
    await promise;
    controller.srcObject = ad;
    assert.equal(controller.srcObject, ad);
    assert.equal(stopped, 0, "late filtering must never stop an initializing or initialized client");
    const next = createVodAdSource();
    controller.srcObject = next;
    assert.equal(controller.srcObject, null, "a distinct source can still be blocked before initialization");
});

test("deferred guards preserve OFF, source replacement, native errors and later wrappers", (t) => {
    const window = createPage(t, "/video/123");
    window.eval(source);
    const controller = createAdController(window);
    const root = controller.videoSlot.parentElement;
    root.remove();
    const error = new Error("native-init-failure");
    let nativeCalls = 0;
    controller.initAd = () => {
        nativeCalls++;
        throw error;
    };
    const ad = createVodAdSource();
    controller.srcObject = ad;
    const installed = controller.initAd;
    let laterCalls = 0;
    const later = function (...args) {
        laterCalls++;
        return Reflect.apply(installed, this, args);
    };
    controller.initAd = later;
    setEnabled(window, false);
    window.document.body.append(root);
    assert.throws(
        () => controller.initAd(),
        (value) => value === error
    );
    assert.equal(controller.initAd, later);
    assert.equal(controller.srcObject, ad);
    assert.equal(nativeCalls, 1);
    assert.equal(laterCalls, 1);
});

test("new independent schedule IDs use native component refs instead of DOM names", (t) => {
    const window = createPage(t);
    window.eval(source);
    const h = createScheduleHarness(window);
    h.root.id = "arbitrary-owner";
    h.container.id = "arbitrary-container";
    new window.WeakMap().set(h.container, h.manager);
    const schedule = liveSchedule("NEW_UNIT");
    const untouched = { ...schedule.adBreaks[0], adUnitId: 12 };
    schedule.adBreaks.push(untouched);
    h.manager.loadWithAdSchedule(schedule);
    assert.equal(h.calls[0].schedule.adBreaks[0].adSources.length, 0);
    assert.equal(h.calls[0].schedule.adBreaks[1], untouched);
    assert.equal(schedule.adBreaks[0].adSources.length, 1);
    const status = JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status"));
    assert.equal(status.blockedLiveSchedules, 1);
    assert.equal(status.blockedLivePreRollSchedules, 0, "new IDs have no inferred pre-roll attribution");
});

test("schedule ownership rejects unrelated, cross-channel, stale and accessor-based refs", (t) => {
    const window = createPage(t);
    window.eval(source);
    const variants = [
        (h) => delete h.container.__reactFiber$ad,
        (h) => (h.container.__reactFiber$ad.stateNode = h.root),
        (h) => (h.owner.memoizedProps.channelId = "other"),
        (h) => (h.owner.memoizedProps.liveId = 0),
        (h) => (h.owner.memoizedProps.adParameter = { svc: "other" }),
        (h) => (h.videoRef.current = window.document.createElement("video")),
        (h) => (h.containerRef.current = h.root),
        (h) => Object.defineProperty(h.videoRef, "current", { get: () => h.video }),
        (h) => window.document.body.append(h.video),
    ];
    for (const mutate of variants) {
        const h = createScheduleHarness(window);
        mutate(h);
        new window.WeakMap().set(h.container, h.manager);
        const schedule = liveSchedule();
        h.manager.loadWithAdSchedule(schedule);
        assert.equal(h.calls[0].schedule, schedule);
    }
});

test("mid-roll sharing requires the observed manager and current content player ownership", (t) => {
    for (const adapter of [false, true]) {
        const window = createPage(t);
        window.eval(source);
        const controller = createAdController(window);
        if (adapter) wrapControllerVideoSlot(window, controller);
        const video = adapter ? controller.videoSlot.video : controller.videoSlot;
        controller.viewSlot = video.parentElement.appendChild(window.document.createElement("div"));
        const sharedInfo = { adVideoContainer: controller.viewSlot, contentVideo: controller.videoSlot };
        const sharedManager = {
            getAdDisplayContainerInfo: () => sharedInfo,
            loadWithAdSchedule() {},
            startAdSchedule() {},
        };
        const h = createScheduleHarness(window);
        h.owner.memoizedProps.player = { adsController: controller };
        const map = new window.WeakMap();
        map.set(controller.viewSlot, sharedManager);
        map.set(h.container, h.manager);
        h.manager.getAdDisplayContainerInfo = () => sharedInfo;
        const schedule = liveSchedule("NEW_MID_UNIT");
        h.manager.loadWithAdSchedule(schedule);
        assert.equal(h.calls.at(-1).schedule.adBreaks[0].adSources.length, 0);
        sharedManager.getAdDisplayContainerInfo = () => ({ ...sharedInfo });
        h.manager.loadWithAdSchedule(schedule);
        assert.equal(h.calls.at(-1).schedule, schedule);
        sharedManager.getAdDisplayContainerInfo = () => sharedInfo;
        map.set(controller.viewSlot, {});
        h.manager.loadWithAdSchedule(schedule);
        assert.equal(h.calls.at(-1).schedule, schedule, "replaced registrations cannot authorize shared ownership");
    }
});

test("a deferred decision that fails ownership inspection never retries an already entered source", (t) => {
    const window = createPage(t, "/video/123");
    window.eval(source);
    const controller = createAdController(window);
    const { slot, root } = wrapControllerVideoSlot(window, controller);
    const parent = root.parentElement;
    root.remove();
    let nativeCalls = 0;
    controller.initAd = () => nativeCalls++;
    const ad = createVodAdSource();
    controller.srcObject = ad;
    Object.defineProperty(slot, "video", {
        configurable: true,
        get() {
            throw new Error("ownership unavailable");
        },
    });
    parent.append(root);
    controller.initAd();
    Object.defineProperty(slot, "video", {
        configurable: true,
        get() {
            return this._videoElement;
        },
    });
    controller.srcObject = ad;
    controller.initAd();
    assert.equal(controller.srcObject, ad);
    assert.equal(nativeCalls, 2);
    assert.equal(
        JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status")).blockedVodSources,
        0
    );
});

test("deferred null assignment keeps native errors and a successfully blocked source stays uninitialized", (t) => {
    const window = createPage(t, "/video/123");
    window.eval(source);
    const controller = createAdController(window);
    const root = controller.videoSlot.parentElement;
    root.remove();
    const ad = createVodAdSource();
    controller.srcObject = ad;
    const error = new Error("native-detach-error");
    const attach = controller._attachSourceObject;
    controller._attachSourceObject = function (value) {
        if (value === null) throw error;
        return attach.call(this, value);
    };
    window.document.body.append(root);
    assert.throws(
        () => controller.initAd(),
        (value) => value === error
    );
    controller._attachSourceObject = attach;
    controller.srcObject = createVodAdSource();
    assert.equal(controller.srcObject, null);

    const next = createAdController(window);
    const nextRoot = next.videoSlot.parentElement;
    nextRoot.remove();
    const reusable = createVodAdSource();
    next.srcObject = reusable;
    window.document.body.append(nextRoot);
    next.initAd();
    next.srcObject = reusable;
    assert.equal(next.srcObject, null, "blocking before native initialization does not mark a source as entered");
});

test("replaced registrations and ambiguous component owners do not authorize schedules", (t) => {
    const window = createPage(t);
    window.eval(source);
    const h = createScheduleHarness(window);
    const map = new window.WeakMap();
    map.set(h.container, h.manager);
    const schedule = liveSchedule("NEW_UNIT");
    map.set(h.container, {});
    h.manager.loadWithAdSchedule(schedule);
    assert.equal(h.calls.at(-1).schedule, schedule);
    map.set(h.container, h.manager);
    h.owner.alternate = { ...h.owner, memoizedProps: { ...h.owner.memoizedProps, liveId: 2 } };
    h.manager.loadWithAdSchedule(schedule);
    assert.equal(h.calls.at(-1).schedule, schedule);
    h.owner.alternate = null;
    h.manager.loadWithAdSchedule(schedule);
    assert.equal(h.calls.at(-1).schedule.adBreaks[0].adSources.length, 0);
});

test("an outer request without an inner request coexists with independent entry and mid-roll managers", async (t) => {
    const window = createPage(t);
    window.eval(source);
    const map = new window.WeakMap();
    const entry = createScheduleHarness(window);
    const entrySchedule = liveSchedule("NEW_ENTRY_UNIT");
    map.set(entry.container, entry.manager);
    assert.equal(window.document.querySelector(".chzzk_player"), null);
    entry.manager.loadWithAdSchedule(entrySchedule);
    assert.equal(entry.manager.startAdSchedule(), "SCHEDULE_COMPLETE");

    const controller = createAdController(window);
    const state = createWrappedLiveSource();
    delete state.wrapped._init.linearAdRequest;
    state.wrapped._init.extra = { preserved: true };
    const init = state.wrapped.initAd;
    const configuration = state.wrapped._init;
    controller.srcObject = state.wrapped;
    const client = await state.wrapped.initAd("native-argument");
    assert.equal(controller.srcObject, state.wrapped);
    assert.equal(state.wrapped.initAd, init);
    assert.equal(state.wrapped._init, configuration);
    assert.equal(Object.hasOwn(configuration, "linearAdRequest"), false);
    assert.equal(client.playerType, "LIVE_PW");
    assert.equal(client.uiElements, configuration.uiElements);
    assert.equal(client.disableTrackingCors, false);
    assert.equal(client.client, undefined);
    assert.equal(state.calls.length, 0);

    const mid = createScheduleHarness(window);
    const midSchedule = liveSchedule("NEW_MID_UNIT");
    midSchedule.adBreaks.push({ ...midSchedule.adBreaks[0], id: "second", startDelay: 12000, extra: "keep" });
    for (const item of midSchedule.adBreaks) {
        Object.freeze(item.adSources);
        Object.freeze(item);
    }
    Object.freeze(midSchedule.adBreaks);
    Object.freeze(midSchedule);
    controller.videoSlot.currentTime = 321;
    controller.videoSlot.playbackRate = 1.25;
    map.set(mid.container, mid.manager);
    mid.manager.loadWithAdSchedule(midSchedule);
    assert.equal(mid.manager.startAdSchedule(), "SCHEDULE_COMPLETE");
    assert.equal(mid.calls[0].schedule.adBreaks.length, 2);
    assert.deepEqual(
        Array.from(mid.calls[0].schedule.adBreaks, (item) => ({ ...item, adSources: [] })),
        midSchedule.adBreaks.map((item) => ({ ...item, adSources: [] }))
    );
    assert.equal(
        mid.calls[0].schedule.adBreaks.every((item) => item.adSources.length === 0),
        true
    );
    assert.equal(
        midSchedule.adBreaks.every((item) => item.adSources.length === 1),
        true
    );
    assert.equal(entrySchedule.adBreaks[0].adSources.length, 1);
    assert.equal(mid.calls[0].schedule.head, midSchedule.head);
    assert.notEqual(entry.video, controller.videoSlot);
    assert.notEqual(mid.video, controller.videoSlot);
    assert.notEqual(entry.video, mid.video);
    assert.equal(controller.videoSlot.currentTime, 321);
    assert.equal(controller.videoSlot.playbackRate, 1.25);
    assert.deepEqual(JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status")), {
        active: true,
        changedParses: 0,
        blockedVodSources: 0,
        blockedLiveSources: 0,
        blockedLiveSchedules: 2,
        blockedLivePreRollSchedules: 0,
        blockedWrappedLiveRequests: 0,
        reloadRequired: false,
    });
});

test("JSON-bypassed inputs are handled only when they reach an owned source or schedule boundary", (t) => {
    for (const pathname of ["/live/measured-channel", "/video/123"]) {
        const window = createPage(t, pathname);
        const nativeParse = window.JSON.parse;
        window.eval(source);
        const decision = nativeParse(JSON.stringify(measured));
        assert.equal(decision.content.livePlaybackJson.liveId, true);
        let preparations = 0;
        const ad = createVodAdSource(() => preparations++);
        ad._videoScheduleInfo = nativeParse(
            JSON.stringify({
                adScheduleParam: { adScheduleId: "NEW_BYPASSED_SOURCE" },
                customParam: { svc: pathname.startsWith("/live/") ? "chzzk_live" : "chzzk_video" },
            })
        );
        const controller = createAdController(window);
        controller.srcObject = ad;
        controller.initAd();
        assert.equal(controller.srcObject, null);
        assert.equal(preparations, 0);
        const other = createAdController(window);
        other.videoSlot.parentElement.className = "unrelated-player";
        other.srcObject = ad;
        other.initAd();
        assert.equal(other.srcObject, ad);
        assert.equal(preparations, 1);
        if (pathname.startsWith("/live/")) {
            const h = createScheduleHarness(window);
            new window.WeakMap().set(h.container, h.manager);
            const schedule = nativeParse(JSON.stringify(liveSchedule("NEW_BYPASSED_UNIT")));
            h.manager.loadWithAdSchedule(schedule);
            assert.equal(h.manager.startAdSchedule(), "SCHEDULE_COMPLETE");
            assert.equal(schedule.adBreaks[0].adSources.length, 1);
            h.owner.memoizedProps.channelId = "other-channel";
            h.manager.loadWithAdSchedule(schedule);
            assert.equal(h.calls.at(-1).schedule, schedule);
            assert.equal(h.manager.startAdSchedule(), "prepare");
        }
        const status = JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status"));
        assert.equal(status.changedParses, 0);
        assert.equal(status.blockedLiveSources + status.blockedVodSources, 1);
        assert.equal(status.blockedLiveSchedules, pathname.startsWith("/live/") ? 1 : 0);
        assert.equal(status.blockedLivePreRollSchedules, 0);
    }
});

test("inputs outside every supported boundary and account, waterfall, network and byte APIs stay native", (t) => {
    const window = createPage(t);
    const nativeParse = window.JSON.parse;
    const nativeSet = window.WeakMap.prototype.set;
    const untouched = () => [
        window.fetch,
        window.XMLHttpRequest,
        window.XMLHttpRequest.prototype.open,
        window.XMLHttpRequest.prototype.send,
        window.crypto,
        window.crypto.subtle,
        window.crypto.getRandomValues,
        window.Uint8Array,
        window.Uint8Array.prototype.set,
        window.getComputedStyle,
    ];
    const apis = untouched();
    let preparations = 0;
    const controller = createAdController(window);
    const ad = createVodAdSource(() => preparations++);
    ad._videoScheduleInfo.customParam.svc = "chzzk_live";
    ad._videoScheduleInfo.adScheduleParam.adScheduleId = "NEW_UNOBSERVED_SOURCE";
    const h = createScheduleHarness(window);
    const nativeLoad = h.manager.loadWithAdSchedule;
    window.eval(source);
    controller.srcObject = ad;
    controller.initAd();
    const schedule = nativeParse(JSON.stringify(liveSchedule("NEW_UNOBSERVED_UNIT")));
    Reflect.apply(nativeSet, new window.WeakMap(), [h.container, h.manager]);
    h.manager.loadWithAdSchedule(schedule);
    assert.equal(controller.srcObject, ad, "a setter defined before interception is not replaced retroactively");
    assert.equal(preparations, 1);
    assert.equal(h.manager.loadWithAdSchedule, nativeLoad);
    assert.equal(h.calls[0].schedule, schedule);
    assert.equal(h.manager.startAdSchedule(), "prepare");
    assert.equal(nativeParse(JSON.stringify(measured)).content.livePlaybackJson.liveId, true);
    for (const value of [
        { code: 200, message: null, content: { adFree: false, subscription: { active: true }, loggedIn: true } },
        { ads: [{ adUnitId: "NEW_UNIT", adSources: [{ creative: "raw-waterfall" }] }], waterfall: [1, 2] },
        { liveId: 123, chatChannelId: "chat", media: [{ path: "https://media.example/content.m3u8" }] },
    ])
        assert.deepEqual(parse(window, value), value);
    assert.deepEqual(untouched(), apis);
    const status = JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status"));
    for (const [key, value] of Object.entries(status)) {
        if (key !== "active" && key !== "reloadRequired") assert.equal(value, 0, key);
    }
    setEnabled(window, false);
    assert.deepEqual(untouched(), apis);
});

test("shared schedules recheck the current adapter video while entry ownership remains independent", (t) => {
    const window = createPage(t);
    window.eval(source);
    const controller = createAdController(window);
    const { slot, video, root } = wrapControllerVideoSlot(window, controller);
    controller.viewSlot = root.appendChild(window.document.createElement("div"));
    const info = { adVideoContainer: controller.viewSlot, contentVideo: slot };
    const shared = { getAdDisplayContainerInfo: () => info, loadWithAdSchedule() {}, startAdSchedule() {} };
    const entry = createScheduleHarness(window);
    const mid = createScheduleHarness(window);
    mid.owner.memoizedProps.player = { adsController: controller };
    const map = new window.WeakMap();
    map.set(controller.viewSlot, shared);
    map.set(entry.container, entry.manager);
    map.set(mid.container, mid.manager);
    mid.manager.getAdDisplayContainerInfo = () => info;
    const schedule = liveSchedule("NEW_SHARED_UNIT");
    mid.manager.loadWithAdSchedule(schedule);
    assert.equal(mid.manager.startAdSchedule(), "SCHEDULE_COMPLETE");
    const replacement = window.document.createElement("video");
    video.replaceWith(replacement);
    mid.manager.loadWithAdSchedule(schedule);
    assert.equal(mid.calls.at(-1).schedule, schedule);
    entry.manager.loadWithAdSchedule(schedule);
    assert.equal(entry.manager.startAdSchedule(), "SCHEDULE_COMPLETE");
    slot._videoElement = replacement;
    mid.manager.loadWithAdSchedule(schedule);
    assert.equal(mid.manager.startAdSchedule(), "SCHEDULE_COMPLETE");
    assert.equal(controller.videoSlot, slot);
    assert.equal(controller.contentVideoElement, slot);
    assert.equal(info.contentVideo, slot);
    assert.equal(schedule.adBreaks[0].adSources.length, 1);
});

test("unconfirmed settings and late OFF calls preserve all later wrappers and native source initialization", (t) => {
    const window = createPage(t, "/live/measured-channel", null);
    window.eval(source);
    const controller = createAdController(window);
    let preparations = 0;
    const ad = createVodAdSource(() => preparations++);
    ad._videoScheduleInfo.customParam.svc = "chzzk_live";
    controller.srcObject = ad;
    controller.initAd();
    const h = createScheduleHarness(window);
    const map = new window.WeakMap();
    map.set(h.container, h.manager);
    const schedule = liveSchedule("NEW_LATE_UNIT");
    h.manager.loadWithAdSchedule(schedule);
    assert.equal(h.calls.at(-1).schedule, schedule);
    assert.deepEqual(parse(window, measured), measured);
    setEnabled(window, true);
    controller.srcObject = ad;
    assert.equal(controller.srcObject, ad, "initialization before settings confirmation cannot be rearmed");
    const root = controller.videoSlot.parentElement;
    root.remove();
    const pending = { ...ad };
    controller.srcObject = pending;
    map.set(h.container, h.manager);
    const methods = [
        [window.JSON, "parse"],
        [window.Object, "defineProperty"],
        [window.WeakMap.prototype, "set"],
        [controller, "initAd"],
        [h.manager, "loadWithAdSchedule"],
    ].map(([target, key]) => {
        const current = target[key];
        const state = { target, key, calls: 0 };
        state.later = function (...args) {
            state.calls++;
            return Reflect.apply(current, this, args);
        };
        target[key] = state.later;
        return state;
    });
    setEnabled(window, false);
    window.document.body.append(root);
    controller.initAd();
    h.manager.loadWithAdSchedule(schedule);
    assert.deepEqual(parse(window, measured), measured);
    const unrelated = {};
    assert.equal(window.Object.defineProperty(unrelated, "value", { value: 7 }), unrelated);
    assert.equal(map.set({}, unrelated), map);
    for (const { target, key, later, calls } of methods) {
        assert.equal(target[key], later);
        assert.ok(calls >= 1, key);
    }
    assert.equal(controller.srcObject, pending);
    assert.equal(h.calls.at(-1).schedule, schedule);
    assert.equal(preparations, 2);
    setEnabled(window, true);
    controller.srcObject = pending;
    controller.initAd();
    h.manager.loadWithAdSchedule(schedule);
    assert.equal(controller.srcObject, pending);
    assert.equal(h.calls.at(-1).schedule, schedule);
    assert.equal(preparations, 3);
});

test("schedule ownership rejects conflicting or unreadable alternate candidates in either order", (t) => {
    const window = createPage(t);
    window.eval(source);
    let getterCalls = 0;
    const variants = [
        (props) => (props.adParameter = { svc: "other" }),
        (props) => (props.channelId = "other-channel"),
        (props) => (props.liveId = 0),
        (props) => (props.liveId = "1"),
        (props) =>
            Object.defineProperty(props, "adParameter", {
                get() {
                    getterCalls++;
                    return { svc: "chzzk_live" };
                },
            }),
        (props) => {
            props.adParameter = {};
            Object.defineProperty(props.adParameter, "svc", {
                get() {
                    getterCalls++;
                    return "chzzk_live";
                },
            });
        },
        (props) =>
            Object.defineProperty(props, "player", {
                get() {
                    getterCalls++;
                    return undefined;
                },
            }),
    ];
    for (const change of variants) {
        for (const invalidPrimary of [false, true]) {
            const h = createScheduleHarness(window);
            h.owner.alternate = { ...h.owner, memoizedProps: { ...h.owner.memoizedProps } };
            const invalid = invalidPrimary ? h.owner : h.owner.alternate;
            change(invalid.memoizedProps);
            new window.WeakMap().set(h.container, h.manager);
            const input = liveSchedule("NEW_UNIT");
            h.manager.loadWithAdSchedule(input);
            assert.equal(h.calls.at(-1).schedule, input, "one valid candidate cannot authorize conflicting ownership");
        }
    }
    assert.equal(getterCalls, 0, "accessor metadata is rejected without invoking it");
    const status = JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status"));
    assert.equal(status.blockedLiveSchedules, 0);
});

test("schedule ownership accepts equivalent alternates but rechecks every candidate before applying", (t) => {
    const window = createPage(t);
    window.eval(source);
    const h = createScheduleHarness(window);
    h.owner.alternate = { ...h.owner, memoizedProps: { ...h.owner.memoizedProps, adParameter: { svc: "chzzk_live" } } };
    new window.WeakMap().set(h.container, h.manager);
    const input = liveSchedule("NEW_UNIT");
    h.manager.loadWithAdSchedule(input);
    assert.equal(h.calls.at(-1).schedule.adBreaks[0].adSources.length, 0);

    for (const mutate of [
        (state) => (state.owner.alternate.memoizedProps.adParameter = { svc: "other" }),
        (state) => (state.owner.memoizedProps.channelId = "other"),
        (state) => (state.owner.alternate.memoizedState = null),
        (state) =>
            (state.owner.alternate = { ...state.owner, memoizedProps: { ...state.owner.memoizedProps, liveId: 0 } }),
    ]) {
        const state = createScheduleHarness(window);
        state.owner.alternate = { ...state.owner, memoizedProps: { ...state.owner.memoizedProps } };
        new window.WeakMap().set(state.container, state.manager);
        let changed = false;
        state.manager.getAdDisplayContainerInfo = () => {
            if (!changed) {
                changed = true;
                mutate(state);
            }
            return state.info;
        };
        state.manager.loadWithAdSchedule(input);
        assert.equal(state.calls.at(-1).schedule, input, "metadata may change after candidate collection");
    }
});

test("schedule registration follows its original WeakMap and ignores unrelated map writes", (t) => {
    const window = createPage(t);
    window.eval(source);
    const h = createScheduleHarness(window);
    const registry = new window.WeakMap();
    const unrelated = new window.WeakMap();
    const input = liveSchedule("NEW_UNIT");
    assert.equal(registry.set(h.container, h.manager), registry);
    assert.equal(unrelated.set(h.container, {}), unrelated);
    h.manager.loadWithAdSchedule(input);
    assert.equal(h.calls.at(-1).schedule.adBreaks[0].adSources.length, 0);
    const unrelatedManager = { ...h.manager, loadWithAdSchedule() {}, getAdDisplayContainerInfo: () => h.info };
    unrelated.set(h.container, unrelatedManager);
    h.manager.loadWithAdSchedule(input);
    assert.equal(h.calls.at(-1).schedule.adBreaks[0].adSources.length, 0);
    registry.set(h.container, {});
    h.manager.loadWithAdSchedule(input);
    assert.equal(h.calls.at(-1).schedule, input);
    registry.set(h.container, h.manager);
    registry.delete(h.container);
    h.manager.loadWithAdSchedule(input);
    assert.equal(h.calls.at(-1).schedule, input, "native manager destroy removes authority with the map entry");
    registry.set(h.container, h.manager);
    h.manager.loadWithAdSchedule(input);
    assert.equal(h.calls.at(-1).schedule.adBreaks[0].adSources.length, 0);
});

test("shared display ownership expires when its original registry is deleted or replaced", (t) => {
    const window = createPage(t);
    window.eval(source);
    const controller = createAdController(window);
    controller.viewSlot = controller.videoSlot.parentElement.appendChild(window.document.createElement("div"));
    const info = { adVideoContainer: controller.viewSlot, contentVideo: controller.videoSlot };
    const shared = { getAdDisplayContainerInfo: () => info, loadWithAdSchedule() {}, startAdSchedule() {} };
    const h = createScheduleHarness(window);
    h.owner.memoizedProps.player = { adsController: controller };
    const registry = new window.WeakMap();
    registry.set(controller.viewSlot, shared);
    registry.set(h.container, h.manager);
    h.manager.getAdDisplayContainerInfo = () => info;
    const input = liveSchedule("NEW_MID_UNIT");
    h.manager.loadWithAdSchedule(input);
    assert.equal(h.calls.at(-1).schedule.adBreaks[0].adSources.length, 0);
    new window.WeakMap().set(controller.viewSlot, {});
    h.manager.loadWithAdSchedule(input);
    assert.equal(h.calls.at(-1).schedule.adBreaks[0].adSources.length, 0);
    registry.delete(controller.viewSlot);
    h.manager.loadWithAdSchedule(input);
    assert.equal(h.calls.at(-1).schedule, input);
    registry.set(controller.viewSlot, shared);
    registry.set(controller.viewSlot, {});
    h.manager.loadWithAdSchedule(input);
    assert.equal(h.calls.at(-1).schedule, input);
});

function createPipScheduleHarness(window, adapter = false) {
    // 실제 PiP에서는 본영상과 중간 광고 wrapper가 같은 부모에 남는다.
    const controller = createAdController(window);
    const playerRoot = controller.videoSlot.parentElement;
    playerRoot.classList.add("type_live", "pip_mode");
    if (adapter) wrapControllerVideoSlot(window, controller);
    const h = createScheduleHarness(window);
    const wrapper = window.document.createElement("div");
    window.document.body.append(wrapper);
    wrapper.append(playerRoot, h.root);
    // 배포 코드의 miniMode는 스크롤 축소용이며 실제 PiP와 별도다.
    h.owner.memoizedProps.player = { adsController: controller };
    h.owner.memoizedProps.miniMode = false;
    return { ...h, controller, playerRoot, wrapper };
}

test("live PiP schedules created after leaving the live route keep native completion", (t) => {
    for (const pathname of ["/", "/lives"]) {
        for (const adapter of [false, true]) {
            const window = createPage(t);
            window.eval(source);
            const h = createPipScheduleHarness(window, adapter);
            const videoSlot = h.controller.videoSlot;
            window.history.replaceState(null, "", pathname);
            const map = new window.WeakMap();
            map.set(h.container, h.manager);
            const input = liveSchedule("NEW_PIP_MID_UNIT");
            Object.freeze(input.adBreaks[0].adSources);
            Object.freeze(input.adBreaks[0]);
            Object.freeze(input.adBreaks);
            Object.freeze(input);
            assert.equal(h.manager.loadWithAdSchedule(input, "native-argument"), "loaded");
            const call = h.calls.at(-1);
            assert.equal(call.schedule.adBreaks[0].adSources.length, 0);
            assert.equal(call.receiver, h.manager);
            assert.deepEqual(call.rest, ["native-argument"]);
            assert.equal(call.schedule.requestId, input.requestId);
            assert.equal(input.adBreaks[0].adSources.length, 1);
            assert.equal(h.manager.startAdSchedule(), "SCHEDULE_COMPLETE");
            assert.equal(h.controller.videoSlot, videoSlot);
            const status = JSON.parse(window.document.documentElement.getAttribute("data-betterchzzk-ad-video-status"));
            assert.equal(status.blockedLiveSchedules, 1);
            assert.equal(status.blockedLivePreRollSchedules, 0);
        }
    }
});

test("PiP schedule ownership does not authorize previews, other players or mismatched live routes", (t) => {
    for (const mutate of [
        (h) => h.playerRoot.classList.remove("pip_mode"),
        (h) => h.playerRoot.classList.replace("type_live", "type_vod"),
        (h) => delete h.owner.memoizedProps.player,
        (h, window) => (h.owner.memoizedProps.player = { adsController: createAdController(window) }),
        (h, window) => window.document.body.append(h.playerRoot),
        (h) => h.playerRoot.remove(),
        (h) => (h.owner.memoizedProps.channelId = ""),
        (h) => (h.owner.memoizedProps.liveId = 0),
        (h) => (h.owner.memoizedProps.adParameter = { svc: "other" }),
        (h, window) => window.history.replaceState(null, "", "/live/other-channel"),
        (h, window) => window.history.replaceState(null, "", "/live/other-channel/unknown"),
    ]) {
        const window = createPage(t);
        window.eval(source);
        const h = createPipScheduleHarness(window);
        window.history.replaceState(null, "", "/lives");
        mutate(h, window);
        new window.WeakMap().set(h.container, h.manager);
        const input = liveSchedule("NEW_PIP_MID_UNIT");
        h.manager.loadWithAdSchedule(input);
        assert.equal(h.calls.at(-1).schedule, input);
    }
});

test("PiP schedules recheck retained video ownership, settings and concurrent homepage media", (t) => {
    const window = createPage(t);
    window.eval(source);
    const h = createPipScheduleHarness(window, true);
    const preview = createAdController(window);
    const previewVideo = preview.videoSlot;
    const registry = new window.WeakMap();
    registry.set(h.container, h.manager);
    window.history.replaceState(null, "", "/");
    const input = liveSchedule("NEW_PIP_MID_UNIT");
    h.manager.loadWithAdSchedule(input);
    assert.equal(h.calls.at(-1).schedule.adBreaks[0].adSources.length, 0);
    assert.equal(preview.videoSlot, previewVideo);
    const flags = { code: 200, message: null, content: { playerAdDisplayResponse: { preRoll: true, midRoll: true } } };
    assert.deepEqual(parse(window, flags), flags, "the PiP exception does not widen homepage JSON filtering");

    h.manager.getAdDisplayContainerInfo = () => {
        h.playerRoot.classList.remove("pip_mode");
        return h.info;
    };
    h.manager.loadWithAdSchedule(input);
    assert.equal(h.calls.at(-1).schedule, input, "PiP can end while display information is inspected");
    h.manager.getAdDisplayContainerInfo = () => h.info;
    h.playerRoot.classList.add("pip_mode");
    const slot = h.controller.videoSlot;
    const replacement = window.document.createElement("video");
    let replaced = false;
    h.manager.getAdDisplayContainerInfo = () => {
        if (!replaced) {
            replaced = true;
            slot._videoElement.replaceWith(replacement);
            slot._videoElement = replacement;
        }
        return h.info;
    };
    h.manager.loadWithAdSchedule(input);
    assert.equal(
        h.calls.at(-1).schedule,
        input,
        "a video replacement during the decision must invalidate its snapshot"
    );
    h.manager.getAdDisplayContainerInfo = () => h.info;
    h.manager.loadWithAdSchedule(input);
    assert.equal(h.calls.at(-1).schedule.adBreaks[0].adSources.length, 0);
    registry.delete(h.container);
    h.manager.loadWithAdSchedule(input);
    assert.equal(h.calls.at(-1).schedule, input);
    registry.set(h.container, h.manager);
    setEnabled(window, false);
    h.manager.loadWithAdSchedule(input);
    assert.equal(h.calls.at(-1).schedule, input);
});

test("PiP mid-roll sharing still requires the current registered content manager", (t) => {
    const window = createPage(t);
    window.eval(source);
    const h = createPipScheduleHarness(window, true);
    h.controller.viewSlot = h.playerRoot.appendChild(window.document.createElement("div"));
    const info = { adVideoContainer: h.controller.viewSlot, contentVideo: h.controller.videoSlot };
    const shared = { getAdDisplayContainerInfo: () => info, loadWithAdSchedule() {}, startAdSchedule() {} };
    window.history.replaceState(null, "", "/lives");
    const registry = new window.WeakMap();
    registry.set(h.controller.viewSlot, shared);
    registry.set(h.container, h.manager);
    h.manager.getAdDisplayContainerInfo = () => info;
    const input = liveSchedule("NEW_PIP_MID_UNIT");
    h.manager.loadWithAdSchedule(input);
    assert.equal(h.calls.at(-1).schedule.adBreaks[0].adSources.length, 0);
    registry.delete(h.controller.viewSlot);
    h.manager.loadWithAdSchedule(input);
    assert.equal(h.calls.at(-1).schedule, input);
});
