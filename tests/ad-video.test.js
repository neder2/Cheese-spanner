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
