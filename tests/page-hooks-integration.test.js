const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const read = (name) => fs.readFileSync(path.join(__dirname, "../features", name), "utf8");
const quality = read("autoQualityPage.js");
const ad = read("adVideoPage.js");

function qualityState(window, enabled) {
    window.document.documentElement.setAttribute(
        "data-betterchzzk-auto-quality-state",
        JSON.stringify({ enabled, quality: "1080p" })
    );
    window.dispatchEvent(new window.Event("betterchzzk:auto-quality:state"));
}

function defineTracks(window) {
    const tracks = [
        { id: "480", height: 480, kind: "main" },
        { id: "1080", height: 1080, kind: "main" },
    ];
    tracks.selectedIndex = 0;
    const target = {};
    const get = () => tracks;
    window.Object.defineProperty(target, "videoTracks", { configurable: true, get });
    void target.videoTracks;
    return { tracks, wrapped: window.Object.getOwnPropertyDescriptor(target, "videoTracks").get !== get };
}

function assignAdSource(window) {
    const controller = {
        _attachSourceObject(value) {
            this.value = value;
        },
        initAd() {},
        stopAd() {},
    };
    window.Object.defineProperty(controller, "srcObject", {
        get() {
            return this.value;
        },
        set(value) {
            this._attachSourceObject(value);
        },
        configurable: true,
    });
    controller.srcObject = {
        setVideoScheduleInfo() {},
        _videoScheduleInfo: { adScheduleParam: { adScheduleId: "CHZZK_NDP_SCH" }, customParam: { svc: "chzzk_video" } },
    };
    return controller.value;
}

for (const order of ["quality-first", "ad-first"]) {
    for (const initiallyEnabled of [false, true]) {
        test(`ad and quality hooks preserve both behaviors: ${order}, quality initially ${initiallyEnabled}`, (t) => {
            const dom = new JSDOM("<!doctype html><video></video>", {
                url: "https://chzzk.naver.com/video/123",
                runScripts: "outside-only",
            });
            t.after(() => dom.window.close());
            const w = dom.window;
            const root = w.document.documentElement;
            root.setAttribute("data-betterchzzk-ad-video-state", "1");
            qualityState(w, initiallyEnabled);
            for (const source of order === "quality-first" ? [quality, ad] : [ad, quality]) w.eval(source);
            qualityState(w, true);
            assert.equal(defineTracks(w).wrapped, true);
            assert.equal(assignAdSource(w), null);
            for (let i = 0; i < 3; i++) {
                qualityState(w, false);
                assert.equal(defineTracks(w).wrapped, false);
                assert.equal(assignAdSource(w), null);
                qualityState(w, true);
                assert.equal(defineTracks(w).wrapped, true);
                assert.equal(assignAdSource(w), null);
            }
            w.history.replaceState(null, "", "/");
            w.dispatchEvent(new w.Event("betterchzzk:routechange"));
            assert.equal(defineTracks(w).wrapped, false);
            assert.notEqual(assignAdSource(w), null);
            w.history.replaceState(null, "", "/video/456");
            w.dispatchEvent(new w.Event("betterchzzk:routechange"));
            assert.equal(defineTracks(w).wrapped, true);
            assert.equal(assignAdSource(w), null);
            root.setAttribute("data-betterchzzk-ad-video-state", "0");
            w.document.dispatchEvent(new w.Event("betterchzzk:ad-video:state"));
            assert.notEqual(assignAdSource(w), null);
            assert.equal(defineTracks(w).wrapped, true);
        });
    }
}
