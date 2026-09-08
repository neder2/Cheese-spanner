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
