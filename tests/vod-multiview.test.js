const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const PANEL = "#cheese-spanner-vod-multiview";
const TOOLBAR = "#bcvm-toolbar";
const TIMELINE = `${TOOLBAR} .bcvm-timeline`;
const STATUS = `${TOOLBAR} .bcvm-entry-status`;
const QUALITY_STATE_ATTR = "data-cheese-spanner-auto-quality-state";
const QUALITY_STATE_EVENT = "cheese-spanner:auto-quality:state";
const START = "2026-11-09 20:00:00";
const flush = () => new Promise((resolve) => setImmediate(resolve));
const toggleTimeline = (node) =>
    new Promise((resolve) => {
        node.addEventListener("toggle", resolve, { once: true });
        node.querySelector("summary").click();
    });
const url = (no) => `https://chzzk.naver.com/video/${no}`;
const src = (id, key = "fixture_key", aes = false) =>
    `vod3://2099:${key}@${id}?env=real${aes ? "" : "&st=13"}#start-level=720&max-level=1080`;

function detail(no, overrides) {
    return {
        code: 200,
        content: {
            videoNo: no,
            videoId: `media_${no}`,
            inKey: `key_${no}`,
            channel: { channelId: "a".repeat(32) },
            videoTitle: `다시보기 ${no}`,
            videoType: "REPLAY",
            vodStatus: "ABR_HLS",
            encryptionType: "NONE",
            liveOpenDate: no === 1 ? START : "2026-11-09 20:00:30",
            duration: no === 1 ? 120 : 60,
            ...overrides,
        },
    };
}

function rewindDetail(
    no,
    playlist = "https://ex-nlive-slitvod-streaming.navercdn.com/chzzk/fixture/index.m3u8?token=fixture"
) {
    const response = detail(no, { vodStatus: "NONE", inKey: null });
    const { videoId, duration } = response.content;
    response.content.liveRewindPlaybackJson = JSON.stringify({
        meta: {
            videoId,
            duration,
            liveId: "12345",
            streamSeq: 1,
            liveRewind: true,
            paidLive: false,
            playbackAuthType: "NONE",
            cdnInfo: { cdnType: "GCDN" },
        },
        api: [],
        media: [
            {
                mediaId: "HLS",
                protocol: "HLS",
                path: playlist,
                encodingTrack: [{ encodingTrackId: "720p", videoWidth: 1280, videoHeight: 720 }],
            },
        ],
    });
    return response;
}

function fixture(t) {
    const dom = new JSDOM('<div id="player_layout" class="chzzk_player type_vod"></div>', {
        url: url(1),
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    w.Promise.allSettled = undefined;
    const { document } = w;
    const host = document.getElementById("player_layout");
    const files = (names) => {
        for (const name of names) w.eval(fs.readFileSync(path.join(ROOT, name), "utf8"));
    };
    const handlers = [];
    function apply(enabled, extra = {}) {
        for (const handler of handlers) handler({ vodMultiviewEnabled: enabled, ...extra });
    }
    const players = [];
    const requests = [];
    const responses = new Map();
    const pages = new Map();
    const following = { response: { code: 200, content: { followingList: [] } } };
    w.fetch = async (input, { signal, credentials }) => {
        const request = new URL(input);
        const no = Number(request.pathname.split("/").at(-1));
        const page = Number(request.searchParams.get("page"));
        requests.push({ no, signal, pathname: request.pathname, page, query: request.search, credentials });
        if (request.pathname.endsWith("/followings")) return { ok: true, json: async () => await following.response };
        if (request.pathname.endsWith("/search/channels"))
            return {
                ok: true,
                json: async () => ({
                    code: 200,
                    content: { data: [{ channel: { channelId: "b".repeat(32), channelName: "검색한 채널" } }] },
                }),
            };
        if (request.pathname.includes("/channels/"))
            return {
                ok: true,
                json: async () => ({
                    code: 200,
                    content: { data: pages.get(page) || [], page, totalPages: pages.size },
                }),
            };
        return { ok: true, json: async () => await (responses.get(no) ?? detail(no)) };
    };

    class Player extends w.EventTarget {
        static version = "1.16.3";
        static upgrade(layout) {
            assert.equal(layout.getAttribute("feature"), "replay");
            assert.ok(layout.querySelector("pzp-pc-vod-time"));
            assert.ok(layout.querySelector("pzp-pc-setting-intro-playbackrate"));
            return new Player();
        }

        constructor() {
            super();
            players.push(this);
            this.shadowRoot = document.createElement("div");
            this.shadowRoot.className = "pzp-pc";
            this.shadowRoot.innerHTML = `
                <video class="webplayer-internal-video"></video>
                <div class="pzp-pc__bottom-buttons">
                    <div class="pzp-pc__bottom-buttons-left">
                        <button class="pzp-pc__playback-switch"></button>
                        <button class="pzp-pc__volume-button"></button>
                    </div>
                    <div class="pzp-pc__bottom-buttons-right"><button class="pzp-pc__viewmode-button"></button></div>
                </div>
            `;
            this.video = this.shadowRoot.querySelector("video");
            this.state = {
                paused: true,
                readyState: 0,
                seeking: false,
                duration: NaN,
                currentTime: 0,
                playbackRate: 1,
            };
            for (const property of Object.keys(this.state)) {
                Object.defineProperty(this.video, property, {
                    get: () => this.state[property],
                    set: (value) => {
                        this.state[property] = value;
                    },
                });
            }
            Object.defineProperties(this.video, {
                played: { get: () => ({ length: this.state.played ? 1 : 0 }) },
                buffered: { get: () => ({ length: this.state.readyState ? 1 : 0 }) },
            });
            this.video.pause = () => this.pause();
            this.video.load = () => {
                if (!this.waitForEmptied) this.state.readyState = 0;
            };
            this.source = "";
            this._lastSrcObj = null;
            this.providers = [];
            this.seeks = [];
            this.playCalls = 0;
            this.coreAbortCalls = 0;
            this._corePlayer = Object.create({
                addEventListener: this.addEventListener.bind(this),
                removeEventListener: this.removeEventListener.bind(this),
                _loadSrcObject: (assignment) => {
                    assert.equal(assignment, this.srcObject);
                    return this.loadGate || Promise.resolve();
                },
                _handleAbort: () => {
                    this.coreAbortCalls++;
                    this.error = { code: 1 };
                    this.dispatchEvent(new w.Event("abort"));
                },
            });
        }

        querySelector(selector) {
            return this.shadowRoot.querySelector(selector);
        }
        emit(type) {
            this.video.dispatchEvent(new w.Event(type));
        }
        get src() {
            return this.source;
        }
        set src(value) {
            this.source = value;
            if (!value) {
                if (this.srcObject) {
                    this.srcObject.close();
                    if (this.loadGate) this._corePlayer._handleAbort();
                }
                this.srcObject = null;
                this.error = null;
                Object.assign(this.state, { seeking: false, currentTime: 0, playbackRate: 1 });
                if (!this.waitForEmptied) this.state.readyState = 0;
                return;
            }
            const protocol = value.startsWith("live:") ? "live:" : "vod3:";
            this.srcObject = {
                protocol,
                player: this._corePlayer,
                closed: false,
                close() {
                    this.closed = true;
                    this.monitoring = false;
                },
            };
            this._lastSrcObj = this.srcObject;
            this.providers.push(this.srcObject);
            if (protocol === "live:") {
                assert.equal(this.preload, "none");
                this.srcObject._injectPlaybackResponse = function (data) {
                    this.data = data;
                };
            } else this._corePlayer._loadSrcObject(this.srcObject);
        }
        get preload() {
            return this.preloadValue;
        }
        set preload(value) {
            this.preloadValue = value;
            if (value === "auto" && this.srcObject?.protocol === "live:") {
                assert.ok(this.srcObject.data?.meta.liveRewind);
                this._corePlayer._loadSrcObject(this.srcObject);
            }
        }
        get paused() {
            return this.state.paused;
        }
        set playbackRate(value) {
            this.state.playbackRate = value;
        }
        set currentTime(value) {
            this.seeks.push(value);
            this.state.seeking = true;
            this.emit("seeking");
        }
        seeked(value = this.seeks.at(-1)) {
            Object.assign(this.state, { seeking: false, currentTime: value });
            this.emit("seeked");
        }
        loaded(duration) {
            Object.assign(this.state, { readyState: 4, duration });
            this.emit("loadedmetadata");
        }
        play() {
            this.playCalls++;
            this.state.paused = false;
            this.emit("play");
            return this.playGate || Promise.resolve();
        }
        pause() {
            if (this.state.paused) return;
            this.state.paused = true;
            this.emit("pause");
        }
    }

    const main = new Player();
    main.src = src("media_1");
    main.loaded(120);
    Object.assign(main.state, { currentTime: 40, played: true, paused: false });
    host.append(main.shadowRoot);
    host.__reactFiber$fixture = { memoizedState: { memoizedState: { current: main } } };

    files(["shared/data.js", "content.js", "features/routeBridgePage.js"]);
    w.CheeseSpanner.utils.bindFeatureOptions = (handler) => handlers.push(handler);
    files([
        "features/liveMultiview/model.js",
        "features/liveMultiview/view.js",
        "features/vodMultiview/rewindSourcePage.js",
        "features/vodMultiview/nativePlayer.js",
        "features/vodMultiview/syncPage.js",
        "features/vodMultiview/rewindSource.js",
        "features/vodMultiview/metadata.js",
        "features/vodMultiview/runtime.js",
    ]);
    t.after(() => {
        if (document.documentElement.hasAttribute(QUALITY_STATE_ATTR)) {
            document.documentElement.setAttribute(QUALITY_STATE_ATTR, '{"enabled":false}');
            w.dispatchEvent(new w.Event(QUALITY_STATE_EVENT));
        }
        w.dispatchEvent(new w.PageTransitionEvent("pagehide"));
        dom.window.close();
    });

    const byText = (text) => [...document.querySelectorAll(`${TOOLBAR} button`)].find((el) => el.textContent === text);
    function open() {
        const launcher = document.querySelector(`${PANEL}-launcher`);
        if (launcher.getAttribute("aria-pressed") === "false") launcher.click();
    }
    function openAdd() {
        const toggle = document.querySelector(`${TOOLBAR} .bcvm-add-toggle`);
        if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
    }
    function submit(value) {
        openAdd();
        document.querySelector('[data-bcvm-add-tab="search"]').click();
        document.querySelector(`${TOOLBAR} input`).value = value;
        document
            .querySelector(`${TOOLBAR} form`)
            .dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
    }
    async function chooseChannel() {
        submit("검색한 채널");
        await flush();
        byText("검색한 채널").click();
        await flush();
    }
    function add(no) {
        submit(url(no));
    }
    function remove() {
        document.querySelector(`${TOOLBAR} .bcvm-remove`).click();
    }
    function status() {
        return document.querySelector(STATUS)?.textContent;
    }
    function move(time) {
        main.state.seeking = true;
        main.emit("seeking");
        main.seeked(time);
    }
    return {
        w,
        document,
        main,
        players,
        requests,
        responses,
        pages,
        following,
        files,
        apply,
        open,
        openAdd,
        add,
        chooseChannel,
        submit,
        remove,
        status,
        move,
        byText,
    };
}

test("validates canonical VOD links and rejects ambiguous time, restricted access and unrelated metadata", async (t) => {
    const f = fixture(t);
    const model = f.w.CheeseSpanner.vodMultiviewMetadata;
    assert.equal(model.videoNoFromUrl(url(2) + "?currentTime=130"), "2");
    for (const value of [
        "https://evil.test/video/2",
        url(2) + "/chat",
        url("002"),
        "https://a@chzzk.naver.com/video/2",
    ])
        assert.equal(model.videoNoFromUrl(value), "");
    async function read(overrides, status) {
        f.responses.set(2, detail(2, overrides));
        assert.equal(
            (await model.loadVideo("2", { signal: new f.w.AbortController().signal, needsKey: true })).status,
            status
        );
    }
    await read({ videoNo: 3 }, "lookup-error");
    await read({ adult: true }, "restricted");
    await read({ inKey: "a@b?c" }, "restricted");
    await read({ videoType: "UPLOAD" }, "unsupported");
    await read({ encryptionType: "DRM" }, "unsupported");
    await read({ vodStatus: "UPLOAD", liveRewindPlaybackJson: "", adult: true }, "restricted");
    await read({ vodStatus: "NONE", liveRewindPlaybackJson: "", encryptionType: "DRM" }, "unsupported");
    await read({ vodStatus: "NONE", liveRewindPlaybackJson: "" }, "preparing");
    await read({ vodStatus: "ABR_HLS", liveRewindPlaybackJson: "" }, "unsupported");
    await read({ liveOpenDate: null }, "unknown-time");
    await read({ duration: 17 * 3600 }, "unknown-time");
    await read({ nextVideo: { duration: 17 * 3600 } }, "unknown-time");
    await read({ liveEndDate: "2026-11-09 21:00:00" }, "unknown-time");
    await read({ encryptionType: "AES" }, "ok");
});

test("loads a public rewind into a reusable native slot and rejects other playlist origins", async (t) => {
    const f = fixture(t);
    f.main.constructor.version = "1.17.0";
    f.apply(true);
    f.open();

    const replay = rewindDetail(2);
    const foreign = JSON.parse(replay.content.liveRewindPlaybackJson);
    foreign.media[0].path = "https://other.example/chzzk/fixture/index.m3u8";
    f.responses.set(2, detail(2, { ...replay.content, liveRewindPlaybackJson: JSON.stringify(foreign) }));
    f.add(2);
    await flush();
    assert.match(f.status(), /재생 형식을 지원하지/);
    assert.equal(f.players.length, 1);
    f.remove();

    f.responses.set(2, replay);
    f.add(2);
    await flush();
    const [slot] = f.w.CheeseSpannerVodNative.getAuxiliaries();
    const sub = slot.player;
    const provider = sub.srcObject;
    assert.equal(provider.protocol, "live:");
    assert.equal(provider.data.meta.videoId, "media_2");
    sub.loaded(60);
    assert.deepEqual(sub.seeks, [10]);
    sub.seeked();
    await flush();
    assert.match(f.status(), /맞췄습니다/);

    f.remove();
    assert.equal(await slot.idle, true);
    assert.equal(provider.closed, true);
    assert.equal(sub._lastSrcObj, null);
    assert.equal(f.main.src, src("media_1"));
    assert.equal(f.main.paused, false);
    assert.deepEqual(f.main.seeks, []);

    let finishLoad;
    sub.loadGate = new Promise((resolve) => {
        finishLoad = resolve;
    });
    f.add(2);
    await flush();
    const loadingProvider = sub.srcObject;
    f.remove();
    loadingProvider.monitoring = true;
    finishLoad();
    assert.equal(await slot.idle, true);
    assert.equal(loadingProvider.monitoring, false);
    sub.loadGate = null;

    f.add(3);
    await flush();
    assert.equal(f.w.CheeseSpannerVodNative.getAuxiliaries()[0], slot);
    assert.equal(sub.srcObject.protocol, "vod3:");
    assert.equal(sub.src, src("media_3", "key_3"));
});

test("adds an Akamai rewind by channel or URL with its signed playlist intact", async (t) => {
    const f = fixture(t);
    const playlist = "https://light-slit.akamaized.net/chzzk/kr/live_rewind/c/fixture/vod_playlist.m3u8?hdnts=fixture";
    const replay = rewindDetail(2, playlist);
    replay.content.channel = { channelId: "b".repeat(32) };
    f.responses.set(2, replay);
    f.pages.set(0, [{ videoNo: 2, videoType: "REPLAY", publishDate: "2026-11-09 20:03:00" }]);
    f.apply(true);
    f.open();
    await f.chooseChannel();
    assert.equal(f.players.length, 2, "the overlapping rewind is added from channel search");
    const sub = f.players[1];
    assert.equal(sub.srcObject.data.media[0].path, playlist);
    f.remove();
    await flush();
    f.add(2);
    await flush();
    assert.equal(sub.srcObject.data.media[0].path, playlist);
    sub.loaded(60);
    assert.deepEqual(sub.seeks, [10]);
    sub.seeked();
    await flush();
    assert.match(f.status(), /맞췄습니다/);
    assert.deepEqual(f.main.seeks, []);
});

test("compares the precise rewind duration at the resolution of the catalogue's whole seconds", async (t) => {
    const f = fixture(t);
    const replay = rewindDetail(2);
    replay.content.duration = 7730;
    const playback = JSON.parse(replay.content.liveRewindPlaybackJson);
    playback.meta.duration = 7727.931;
    replay.content.liveRewindPlaybackJson = JSON.stringify(playback);
    f.responses.set(2, replay);
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    assert.equal(f.players.length, 2, "a two-second difference at catalogue precision is playable");
    const sub = f.players[1];
    assert.equal(sub.srcObject.data.meta.duration, 7727.931, "the provider receives its original duration");
    sub.loaded(7729.9);
    sub.seeked();
    await flush();
    assert.match(f.status(), /맞췄습니다/);

    for (const reader of [f.w.CheeseSpannerVodRewind, f.w.CheeseSpannerVodNative]) {
        const read = (length) => reader.readRewindSource(replay.content.liveRewindPlaybackJson, "media_2", length);
        assert.equal(read(7731), null, "three whole seconds still disagree");
        assert.equal(read(7730.01), null, "a fractional catalogue value keeps its precision");
    }
});

test("a newly uploaded replay without a source can be retried in the same row once its rewind is ready", async (t) => {
    const f = fixture(t);
    f.responses.set(2, detail(2, { vodStatus: "UPLOAD", videoId: null, inKey: null, liveRewindPlaybackJson: null }));
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    assert.match(f.status(), /보조 영상.*재생 준비 중/);
    const retry = f.document.querySelector(`${TOOLBAR} .bcvm-sync`);
    assert.equal(retry.dataset.retry, "true");
    assert.equal(f.players.length, 1);
    const ready = rewindDetail(2);
    ready.content.vodStatus = "UPLOAD";
    f.responses.set(2, ready);
    retry.click();
    await flush();
    assert.equal(f.document.querySelector(`${TOOLBAR} .bcvm-sync`), retry);
    assert.equal(f.players[1].srcObject.data.meta.videoId, "media_2");
    assert.deepEqual(f.main.seeks, []);
});

test("rewind playlist validation in both worlds stays scoped to the supported HTTPS media origins and paths", (t) => {
    const f = fixture(t);
    for (const playlist of [
        "http://light-slit.akamaized.net/chzzk/fixture/index.m3u8",
        "https://other.akamaized.net/chzzk/fixture/index.m3u8",
        "https://light-slit.akamaized.net.example.com/chzzk/fixture/index.m3u8",
        "https://light-slit.akamaized.net:8443/chzzk/fixture/index.m3u8",
        "https://user@light-slit.akamaized.net/chzzk/fixture/index.m3u8",
        "https://light-slit.akamaized.net/another-service/index.m3u8",
        "https://light-slit.akamaized.net/chzzk/fixture/index.mp4",
        "https://light-slit.akamaized.net/chzzk/fixture/index.m3u8#fragment",
    ]) {
        const { liveRewindPlaybackJson, videoId, duration } = rewindDetail(2, playlist).content;
        for (const reader of [f.w.CheeseSpannerVodRewind, f.w.CheeseSpannerVodNative]) {
            assert.equal(reader.readRewindSource(liveRewindPlaybackJson, videoId, duration), null, playlist);
        }
    }
});

test("uses the current native rewind as the broadcast clock when adding a standard replay", async (t) => {
    const f = fixture(t);
    const replay = rewindDetail(1);
    f.responses.set(1, replay);
    f.main.preload = "none";
    f.main.src = "live://12345";
    const provider = f.main.srcObject;
    provider._injectPlaybackResponse(JSON.parse(replay.content.liveRewindPlaybackJson));
    f.main.preload = "auto";
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const sub = f.players[1];
    assert.equal(sub.srcObject.protocol, "vod3:");
    sub.loaded(60);
    assert.deepEqual(sub.seeks, [10]);
    sub.seeked();
    await flush();
    assert.match(f.status(), /맞췄습니다/);
    assert.equal(f.main.srcObject, provider);
    assert.equal(f.main.paused, false);
    assert.deepEqual(f.main.seeks, []);
});

test("uses a half-open broadcast range, coalesces seeks and keeps a user's pause across range changes", async (t) => {
    const f = fixture(t);
    assert.equal(f.document.querySelector(PANEL), null);
    f.main.state.currentTime = 29.999;
    f.responses.set(2, detail(2, { encryptionType: "AES" }));
    f.apply(true);
    f.open();
    f.add(1);
    assert.equal(f.requests.length, 0);
    f.add(2);
    await flush();
    assert.match(f.status(), /해당 시각/);
    assert.equal(f.players.length, 1);
    f.move(30);
    await flush();
    const sub = f.players[1];
    assert.equal(sub.src, src("media_2", "key_2", true));
    assert.equal(sub.video.muted, true);
    assert.equal(f.w.CheeseSpanner.utils.getMainVideoElement(), f.main.video);
    sub.loaded(60);
    await flush();
    assert.match(f.status(), /맞췄습니다/);

    f.move(45);
    f.move(55);
    assert.deepEqual(sub.seeks, [15]);
    sub.seeked();
    assert.deepEqual(sub.seeks, [15, 25]);
    sub.seeked();
    await flush();
    f.main.state.playbackRate = 1.5;
    f.main.emit("ratechange");
    assert.equal(sub.video.playbackRate, 1.5);
    sub.querySelector(".pzp-pc__playback-switch").click();
    assert.equal(sub.paused, true);
    assert.equal(f.main.paused, false);
    assert.match(f.status(), /보조 영상만/);
    f.move(90);
    assert.match(f.status(), /해당 시각/);
    f.move(89.999);
    assert.match(f.status(), /보조 영상만/);
    assert.equal(sub.paused, true);
    const toggle = f.document.querySelector(`${TOOLBAR} .bcvm-sync`);
    toggle.click();
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    toggle.click();
    assert.equal(sub.seeks.at(-1), 59.999);
    sub.seeked();
    await flush();
    assert.equal(sub.paused, false);
    f.main.pause();
    assert.equal(sub.paused, true);
    f.move(90);
    assert.match(f.status(), /해당 시각/);
    assert.deepEqual(f.main.seeks, []);
});

test("switches one replay to independent playback and rejoins the current main without replacing either source", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    for (const no of [2, 3]) {
        f.add(no);
        await flush();
        const player = f.players[no - 1];
        player.loaded(60);
        player.seeked();
        await flush();
    }
    const [main, sub, other] = f.players;
    const providers = f.players.map((player) => player.srcObject);
    const toggle = f.document.querySelector(`${TOOLBAR} .bcvm-sync`);
    sub.video.muted = false;
    sub.video.volume = 0.37;
    const before = { ...sub.state };
    const playCalls = sub.playCalls;
    const seeks = [...sub.seeks];
    assert.equal(toggle.getAttribute("aria-disabled"), "false");
    toggle.click();
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    assert.deepEqual(sub.state, before, "turning sync off preserves playback at that instant");
    assert.equal(sub.playCalls, playCalls);
    assert.deepEqual(sub.seeks, seeks);

    sub.state.playbackRate = 1.25;
    f.move(75);
    main.state.playbackRate = 1.75;
    main.emit("ratechange");
    main.pause();
    other.seeked();
    await flush();
    assert.equal(sub.paused, false);
    assert.equal(sub.video.currentTime, 10);
    assert.equal(sub.video.playbackRate, 1.25);
    assert.deepEqual(sub.seeks, seeks);
    assert.equal(other.video.currentTime, 45);
    assert.equal(other.video.playbackRate, 1.75);
    assert.equal(other.paused, true);
    assert.match(f.status(), /동기화가 꺼져/);

    sub.currentTime = 7;
    sub.seeked();
    assert.equal(sub.video.currentTime, 7, "independent native seeking is retained");
    toggle.click();
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    assert.equal(sub.seeks.at(-1), 45);
    sub.seeked();
    await flush();
    assert.equal(sub.paused, true, "rejoining a paused main does not resume it");
    assert.equal(sub.video.playbackRate, 1.75);
    assert.equal(sub.video.muted, false);
    assert.equal(sub.video.volume, 0.37);
    assert.deepEqual(
        f.players.map((player) => player.srcObject),
        providers
    );
    assert.deepEqual(main.seeks, []);
    await main.play();
    main.emit("playing");
    await flush();
    assert.equal(sub.paused, false);
    assert.equal(other.paused, false);
});

test("independent native controls affect only their replay and remain independent outside the main overlap", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const sub = f.players[1];
    sub.loaded(60);
    sub.seeked();
    await flush();
    const toggle = f.document.querySelector(`${TOOLBAR} .bcvm-sync`);
    const key = (code) =>
        sub.shadowRoot.dispatchEvent(new f.w.KeyboardEvent("keydown", { code, bubbles: true, cancelable: true }));
    assert.equal(key("ArrowRight"), false, "synced replay blocks independent seeking shortcuts");
    toggle.click();
    assert.equal(key("ArrowRight"), true);
    assert.equal(key("BracketRight"), true);
    sub.querySelector(".pzp-pc__playback-switch").click();
    assert.equal(sub.paused, true);
    assert.equal(f.main.paused, false);
    assert.equal(key("Space"), false);
    await flush();
    assert.equal(sub.paused, false);
    const muted = sub.muted;
    key("KeyM");
    assert.equal(sub.muted, !muted);
    f.move(100);
    f.main.pause();
    assert.equal(sub.paused, false);
    assert.match(f.status(), /동기화가 꺼져/);
    toggle.click();
    assert.equal(sub.paused, true);
    assert.match(f.status(), /해당 시각/);
    assert.deepEqual(f.main.seeks, []);
});

test("sync commands reject unready slots, pending playback, invalid payloads and stale ownership", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    let request;
    const panel = f.document.querySelector(PANEL);
    panel.addEventListener("cheese-spanner:vod-multiview:command", (event) => {
        if (event.detail.action === "start") request = event.detail.request;
    });
    const send = (enabled, target = panel, id = request) =>
        target.dispatchEvent(
            new f.w.CustomEvent("cheese-spanner:vod-multiview:command", {
                bubbles: true,
                detail: { action: "sync", request: id, enabled },
            })
        );
    f.add(2);
    await flush();
    const sub = f.players[1];
    const toggle = f.document.querySelector(`${TOOLBAR} .bcvm-sync`);
    assert.equal(toggle.getAttribute("aria-disabled"), "true");
    send(false);
    sub.loaded(60);
    send(false);
    let finishPlay;
    sub.playGate = new Promise((resolve) => {
        finishPlay = resolve;
    });
    sub.seeked();
    send(false);
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    assert.equal(toggle.getAttribute("aria-disabled"), "true");
    finishPlay();
    await flush();
    assert.equal(toggle.getAttribute("aria-disabled"), "false");
    for (const value of [null, undefined, 0, "false", {}]) send(value);
    send(false, panel, request + 1);
    const foreign = f.document.createElement("div");
    foreign.id = panel.id;
    panel.parentElement.append(foreign);
    send(false, foreign);
    foreign.remove();
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    send(false);
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    const plays = sub.playCalls;
    sub.source = src("foreign_media");
    sub.querySelector(".pzp-pc__playback-switch").click();
    assert.equal(sub.playCalls, plays, "a native click cannot resume a source that no longer belongs to this entry");
    assert.match(f.status(), /재생하지 못/);
    send(true);
    assert.equal(toggle.dataset.retry, "true");
    assert.deepEqual(f.main.seeks, []);
});

test("an independent replay releases its slot when the original main media can no longer be verified", async (t) => {
    const f = fixture(t);
    let now = 0;
    Object.defineProperty(f.w.performance, "now", { value: () => now });
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const sub = f.players[1];
    sub.loaded(60);
    sub.seeked();
    await flush();
    const toggle = f.document.querySelector(`${TOOLBAR} .bcvm-sync`);
    toggle.click();
    const provider = sub.srcObject;
    f.main.source = src("replacement_main");
    f.main.emit("timeupdate");
    assert.equal(sub.paused, true);
    assert.equal(toggle.getAttribute("aria-disabled"), "true");
    now = 16000;
    f.w.dispatchEvent(new f.w.Event("cheese-spanner:routechange"));
    assert.equal(sub.src, "");
    assert.equal(provider.closed, true);
    assert.match(f.status(), /지원하지 않습니다/);
    assert.equal(f.main.src, src("replacement_main"));
    assert.equal(f.main.paused, false);
    assert.deepEqual(f.main.seeks, []);
});

test("a canceled independent play cannot resume after pause, removal or route changes", async (t) => {
    for (const action of ["pause", "remove", "route"]) {
        await t.test(action, async (t) => {
            const f = fixture(t);
            f.apply(true);
            f.open();
            f.add(2);
            await flush();
            const sub = f.players[1];
            sub.loaded(60);
            sub.seeked();
            await flush();
            f.document.querySelector(`${TOOLBAR} .bcvm-sync`).click();
            const play = sub.querySelector(".pzp-pc__playback-switch");
            play.click();
            let finishPlay;
            sub.playGate = new Promise((resolve) => {
                finishPlay = resolve;
            });
            play.click();
            if (action === "pause") play.click();
            else if (action === "remove") f.remove();
            else {
                f.w.history.pushState({}, "", "/video/4");
                f.w.dispatchEvent(new f.w.Event("cheese-spanner:routechange"));
            }
            sub.state.paused = false;
            finishPlay();
            await flush();
            assert.equal(sub.paused, true);
            assert.equal(f.main.paused, false);
            assert.deepEqual(f.main.seeks, []);
            if (action !== "pause") assert.equal(sub.src, "");
        });
    }
});

test("shows only the current replay's page title for the main row before auxiliary metadata is needed", (t) => {
    const f = fixture(t);
    const { document } = f;
    document.head.insertAdjacentHTML(
        "beforeend",
        '<meta property="og:url" content="https://chzzk.naver.com/video/9"><meta property="og:title" content="이전 채널 - 이전 영상">'
    );
    f.apply(true);
    f.open();
    const row = document.querySelector(`${TOOLBAR} .bcvm-main-entry`);
    const channel = row.querySelector(".bcvm-channel");
    const title = row.querySelector(".bcvm-title");
    assert.equal(title.textContent, "다시보기 1");
    assert.equal(channel.hidden, true);
    document.querySelector(`${PANEL}-launcher`).click();
    document.head.querySelector('[property="og:url"]').content = url(1);
    document.head.querySelector('[property="og:title"]').content = "현재 채널 - 현재 영상";
    f.open();
    assert.equal(channel.textContent, "현재 채널");
    assert.equal(channel.hidden, false);
    assert.equal(title.textContent, "현재 영상");
    document.querySelector(`${PANEL}-launcher`).click();
    document.head.querySelector('[property="og:title"]').content = "A - B - C";
    f.open();
    assert.equal(title.textContent, "A - B - C");
    assert.equal(channel.hidden, true);
    assert.equal(f.requests.length, 0);
});

test("compact replay actions retain accessible status and retry without a permanent status row", async (t) => {
    const f = fixture(t);
    f.responses.set(1, detail(1, { channel: { channelId: "a".repeat(32), channelName: "메인 채널" } }));
    f.responses.set(2, { code: 500 });
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const row = f.document.querySelector(`${TOOLBAR} .bcvm-entry`);
    const toggle = row.querySelector(".bcvm-sync");
    const remove = row.querySelector(".bcvm-remove");
    const status = row.querySelector('[role="status"]');
    const mainRow = row.parentElement.firstElementChild;
    assert.equal(mainRow.querySelector(".bcvm-role").textContent, "메인");
    assert.equal(mainRow.querySelector(".bcvm-channel").textContent, "메인 채널");
    assert.equal(mainRow.querySelector(".bcvm-title").textContent, "다시보기 1");
    assert.equal(mainRow.querySelector("button"), null);
    assert.equal(row.querySelector(".bcvm-role").textContent, "서브 1");
    assert.equal(toggle.nextElementSibling, remove);
    assert.equal(remove.textContent, "");
    assert.equal(remove.firstElementChild.outerHTML, f.w.CheeseSpanner.multiviewView.panelIcon("remove").outerHTML);
    assert.match(remove.getAttribute("aria-label"), /빼기/);
    assert.equal(toggle.getAttribute("aria-describedby"), status.id);
    assert.equal(row.querySelector(".bcvm-entry-state"), null);
    assert.equal(f.document.querySelector(`${TOOLBAR} > .bcvm-help`), null);
    assert.equal(toggle.dataset.retry, "true");
    assert.equal(toggle.getAttribute("role"), "button");
    assert.match(toggle.getAttribute("aria-label"), /다시 시도/);
    assert.match(status.textContent, /불러오지 못/);
    assert.equal(f.w.getComputedStyle(status).position, "absolute");

    const title = "한 줄에서 줄여 표시할 긴 다시보기 제목";
    f.responses.set(
        2,
        detail(2, { videoTitle: title, channel: { channelId: "a".repeat(32), channelName: "스트리머" } })
    );
    toggle.focus();
    toggle.click();
    await flush();
    const sub = f.players[1];
    sub.loaded(60);
    sub.seeked();
    await flush();
    assert.equal(f.document.querySelector(`${TOOLBAR} .bcvm-entry`), row, "retry keeps the focused row");
    assert.equal(f.document.activeElement, toggle);
    assert.equal(toggle.getAttribute("role"), "switch");
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    assert.equal(toggle.getAttribute("aria-disabled"), "false");
    assert.equal(row.querySelector(".bcvm-title").title, title);
    assert.equal(row.querySelector(".bcvm-title").previousElementSibling.textContent, "스트리머");
    f.add(3);
    await flush();
    const next = row.nextElementSibling;
    assert.equal(next.querySelector(".bcvm-role").textContent, "서브 2");
    const other = f.players[2];
    const source = other.srcObject;
    remove.click();
    assert.equal(row.isConnected, false);
    assert.equal(mainRow.nextElementSibling, next);
    assert.equal(next.querySelector(".bcvm-role").textContent, "서브 1");
    assert.equal(sub.src, "");
    assert.equal(other.srcObject, source);
    assert.equal(f.document.querySelectorAll(`${TOOLBAR} .bcvm-entry`).length, 1);
    assert.equal(f.main.paused, false);
});

test("a failed native replay retries in place and a removed retry cannot recreate its player", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const sub = f.players[1];
    sub.loaded(60);
    sub.seeked();
    await flush();
    const row = f.document.querySelector(`${TOOLBAR} .bcvm-entry`);
    const toggle = row.querySelector(".bcvm-sync");
    const provider = sub.srcObject;
    sub.error = { code: 4 };
    sub.dispatchEvent(new f.w.Event("error"));
    assert.equal(toggle.dataset.retry, "true");
    assert.equal(provider.closed, true);
    toggle.click();
    await flush();
    assert.equal(f.players.length, 2);
    assert.equal(f.document.querySelector(`${TOOLBAR} .bcvm-entry`), row);
    assert.notEqual(sub.srcObject, provider);
    sub.loaded(60);
    sub.seeked();
    await flush();
    assert.equal(toggle.getAttribute("aria-disabled"), "false");
    assert.match(f.status(), /맞췄습니다/);

    sub.error = { code: 4 };
    sub.dispatchEvent(new f.w.Event("error"));
    let finishLookup;
    f.responses.set(
        2,
        new Promise((resolve) => {
            finishLookup = resolve;
        })
    );
    toggle.click();
    await flush();
    const request = f.requests.at(-1);
    f.remove();
    assert.equal(request.signal.aborted, true);
    finishLookup(detail(2));
    await flush();
    assert.equal(row.isConnected, false);
    assert.equal(sub.src, "");
    assert.equal(f.document.querySelectorAll(`${TOOLBAR} .bcvm-entry`).length, 0);
    assert.equal(f.main.paused, false);
});

test("waits for a moving main after a slow but accurate auxiliary seek", async (t) => {
    const f = fixture(t);
    let now = 100;
    Object.defineProperty(f.w.performance, "now", { value: () => now });
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const sub = f.players[1];
    sub.loaded(60);
    assert.deepEqual(sub.seeks, [10]);
    now += 1400;
    f.main.state.currentTime = 41.4;
    sub.seeked(10);
    assert.ok(Math.abs(sub.seeks.at(-1) - 12.8) < 0.001);
    now += 200;
    f.main.state.currentTime = 41.6;
    sub.seeked(12.8);
    assert.equal(sub.seeks.length, 2, "a prepared position ahead of main is held instead of seeking back");
    assert.equal(sub.paused, true);
    now += 1000;
    f.main.state.currentTime = 42.6;
    f.main.emit("timeupdate");
    await flush();
    assert.equal(sub.paused, false);
    assert.equal(sub.seeks.length, 2);
    assert.deepEqual(f.main.seeks, []);
});

test("late metadata, native loading and play completion cannot revive an old assignment", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    let finishMetadata;
    f.responses.set(
        2,
        new Promise((resolve) => {
            finishMetadata = resolve;
        })
    );
    f.add(2);
    f.remove();
    assert.equal(f.requests.at(-1).signal.aborted, true);
    finishMetadata(detail(2));
    await flush();
    assert.equal(f.players.length, 1);

    f.add(2);
    await flush();
    const sub = f.players[1];
    f.remove();
    let finishLoad;
    sub.loadGate = new Promise((resolve) => {
        finishLoad = () => {
            sub.video.setAttribute("src", "blob:fixture/old-source");
            resolve();
        };
    });
    f.add(2);
    await flush();
    const closing = sub.srcObject;
    sub.state.readyState = 1;
    sub.waitForEmptied = true;
    f.remove();
    assert.equal(closing.closed, true);
    assert.equal(sub.shadowRoot.isConnected, false);
    f.add(3);
    await flush();
    assert.equal(sub.src, "", "the replacement waits for the old SDK request");
    finishLoad();
    await flush();
    assert.equal(sub.src, "", "the replacement also waits for the native media reset");
    assert.equal(sub.video.hasAttribute("src"), false, "a late native load cannot keep the old media attached");
    assert.equal(sub._lastSrcObj, closing, "the cached reference is cleared only after the media resets");
    sub.waitForEmptied = false;
    sub.state.readyState = 0;
    sub.emit("emptied");
    await flush();
    assert.equal(sub.src, src("media_3", "key_3"));

    let finishPlay;
    sub.playGate = new Promise((resolve) => {
        finishPlay = resolve;
    });
    sub.loaded(60);
    sub.seeked();
    assert.equal(sub.paused, false);
    f.main.pause();
    sub.state.paused = false; // Model a play that takes effect late, even after the stop command.
    finishPlay();
    await flush();
    assert.equal(sub.paused, true);
    assert.match(f.status(), /메인이 일시정지/);
    f.w.history.pushState({}, "", "/video/4");
    await flush();
    assert.equal(sub.srcObject, null);
    assert.equal(sub._lastSrcObj, null);
    assert.equal(sub.shadowRoot.isConnected, false);
    assert.equal(f.players.length, 2);
});

test("closing clears only the owned slot's cached provider", async (t) => {
    const f = fixture(t);
    const mainProvider = f.main.srcObject;
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const sub = f.players[1];
    const subProvider = sub.srcObject;
    assert.equal(sub._lastSrcObj, subProvider);
    sub.loaded(60);
    sub.seeked();
    await flush();
    f.remove();
    await flush();
    assert.equal(subProvider.closed, true);
    assert.equal(sub._lastSrcObj, null);
    assert.equal(f.main.srcObject, mainProvider);
    assert.equal(f.main._lastSrcObj, mainProvider);
    assert.equal(mainProvider.closed, false);
    assert.equal(f.main.coreAbortCalls, 0);
    assert.equal(sub.coreAbortCalls, 0, "a completed load needs no late cancellation");
    assert.equal(f.main.paused, false);
    assert.equal(f.main.video.currentTime, 40);

    f.add(3);
    await flush();
    assert.notEqual(sub.srcObject, subProvider);
    sub._lastSrcObj = mainProvider;
    f.remove();
    await flush();
    assert.equal(sub._lastSrcObj, mainProvider, "an unexpected cached reference is left alone");
});

test("cancels native subscriptions installed after a loading sub was closed", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const sub = f.players[1];
    f.remove();
    await flush();

    let finishLoad;
    sub.loadGate = new Promise((resolve) => {
        finishLoad = resolve;
    });
    f.add(2);
    await flush();
    const closedSource = sub.srcObject;
    f.remove();
    assert.equal(sub.coreAbortCalls, 1, "the initial close notifies existing subscriptions");
    assert.equal(sub.video.readyState, 0);
    const lateSubscriptions = new Set([closedSource]);
    sub.addEventListener("abort", () => lateSubscriptions.delete(closedSource), { once: true });
    finishLoad();
    await flush();
    assert.equal(lateSubscriptions.size, 0);
    assert.equal(sub.coreAbortCalls, 2);
    assert.equal(sub.error, null, "clears the native abort state before reuse");
    assert.equal(sub._lastSrcObj, null);
    assert.equal(f.main.coreAbortCalls, 0);
    assert.equal(f.main.paused, false);
    assert.equal(f.main.video.currentTime, 40);
});

test("cancels native play that resumes after the sub source is cleared", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const sub = f.players[1];
    let resumePlay;
    sub.playGate = new Promise((resolve) => {
        resumePlay = () => {
            const event = new f.w.Event("play", { cancelable: true });
            if (!sub.dispatchEvent(event)) resolve();
            return event;
        };
    });
    sub.loaded(60);
    sub.seeked();
    assert.equal(sub.playCalls, 1);
    f.remove();
    assert.equal(sub.srcObject, null);
    assert.equal(resumePlay().defaultPrevented, true);
    await flush();
    assert.equal(sub._lastSrcObj, null);
    assert.equal(sub.dispatchEvent(new f.w.Event("play", { cancelable: true })), true);
    assert.equal(f.main.paused, false);
    assert.equal(f.main.video.currentTime, 40);

    f.add(3);
    await flush();
    assert.equal(sub.src, src("media_3", "key_3"));
});

test("uses the live multiview limit and resizes a split with independently reusable slots", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    const launcher = f.document.querySelector(`${PANEL}-launcher`);
    assert.equal(launcher.nextElementSibling.className, "pzp-pc__viewmode-button");
    assert.equal(f.document.querySelector(TOOLBAR).previousElementSibling, f.document.getElementById("player_layout"));
    for (let no = 2; no <= 6; no++) f.add(no);
    await flush();
    assert.equal(f.players.length, f.w.CheeseSpanner.multiviewModel.MAX_VIEWS);
    assert.equal(f.document.querySelectorAll(`${PANEL} .bcvm-screen`).length, 5);
    const divider = f.document.querySelector(`${PANEL} .bcvm-divider`);
    const previous = divider.getAttribute("aria-valuenow");
    const key = divider.getAttribute("aria-orientation") === "vertical" ? "ArrowLeft" : "ArrowUp";
    divider.dispatchEvent(new f.w.KeyboardEvent("keydown", { key, bubbles: true }));
    assert.notEqual(divider.getAttribute("aria-valuenow"), previous);
    f.add(7);
    await flush();
    assert.ok(!f.requests.some(({ no }) => no === 7));
    const other = f.players[1].srcObject;
    const removed = f.players[2];
    f.document.querySelector('[aria-label="다시보기 3 빼기"]').click();
    f.add(7);
    await flush();
    assert.equal(f.players.length, 6);
    assert.equal(removed.src, src("media_7", "key_7"));
    assert.equal(f.players[1].srcObject, other);
    assert.equal(f.main.video.currentTime, 40);
    f.document.querySelector(`${PANEL}-launcher`).click();
    await flush();
    assert.ok(f.players.slice(1).every((player) => !player.srcObject && !player._lastSrcObj));
});

function layoutFixture(f) {
    const host = f.document.getElementById("player_layout");
    let popped = false;
    let viewport = [1200, 800];
    let dock = new f.w.DOMRect(240, 60, 920, 520);
    host.getBoundingClientRect = () => (popped ? new f.w.DOMRect(0, 0, ...viewport) : dock);
    host.togglePopover = (open) => (popped = open);
    host.hidePopover = () => {
        popped = false;
    };
    const pane = (id) => f.document.querySelector(`${PANEL} [data-bcvm-tile="${id}"]`);
    const rect = (id) => {
        const { left, top, width, height } = pane(id).style;
        const bounds = host.getBoundingClientRect();
        return {
            x: bounds.left + (parseFloat(left) * bounds.width) / 100,
            y: bounds.top + (parseFloat(top) * bounds.height) / 100,
            width: (parseFloat(width) * bounds.width) / 100,
            height: (parseFloat(height) * bounds.height) / 100,
        };
    };
    const center = (id) => {
        const r = rect(id);
        return { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    };
    const pointer = (target, type, point, extra) =>
        target.dispatchEvent(
            new f.w.PointerEvent(type, {
                pointerId: 1,
                pointerType: "mouse",
                isPrimary: true,
                button: 0,
                buttons: type === "pointerup" ? 0 : 1,
                bubbles: true,
                cancelable: true,
                ...point,
                ...extra,
            })
        );
    function drag(target, from, to, extra) {
        pointer(target, "pointerdown", from, extra);
        pointer(f.document.body, "pointermove", to, extra);
        pointer(f.document.body, "pointerup", to, extra);
    }
    return {
        host,
        pane,
        rect,
        center,
        pointer,
        drag,
        opened: () => popped,
        setDock(width, height) {
            dock = new f.w.DOMRect(240, 60, width, height);
            f.w.dispatchEvent(new f.w.Event("resize"));
        },
        setViewport(width, height) {
            viewport = [width, height];
            f.w.dispatchEvent(new f.w.Event("resize"));
        },
    };
}

test("uses the live default slots at both widths and resets after docking into a specific empty slot", async (t) => {
    const f = fixture(t);
    const layout = layoutFixture(f);
    f.apply(true);
    f.open();
    for (const [width, height] of [
        [920, 520],
        [600, 340],
    ]) {
        layout.setDock(width, height);
        if (!layout.pane(2)) {
            f.add(2);
            await flush();
        }
        const r = layout.host.getBoundingClientRect();
        const main = layout.rect(1),
            sub = layout.rect(2);
        assert.equal(main.x, r.left);
        assert.equal(main.y, r.top);
        assert.ok(Math.abs(main.width - (r.width * 2) / 3) < 0.01 && Math.abs(main.height - (r.height * 2) / 3) < 0.01);
        assert.ok(Math.abs(sub.x - (r.left + main.width)) < 0.01 && sub.y === r.top);
        assert.ok(Math.abs(sub.width - r.width / 3) < 0.01 && Math.abs(sub.height - r.height / 3) < 0.01);
    }
    const initial = [1, 2].map(layout.rect);
    const sources = f.players.map((player) => player.srcObject);
    const r = layout.host.getBoundingClientRect();
    const bottom = (x) => ({ clientX: r.left + r.width * x, clientY: r.top + (r.height * 5) / 6 });
    layout.pointer(layout.pane(1).querySelector(".bcvm-grip"), "pointerdown", layout.center(1));
    layout.pointer(f.document.body, "pointermove", bottom(1 / 6));
    layout.pointer(f.document.body, "pointermove", bottom(5 / 6));
    layout.pointer(f.document.body, "pointerup", bottom(5 / 6));
    assert.deepEqual(layout.center(1), bottom(5 / 6));
    layout.setDock(920, 520);
    layout.setDock(600, 340);
    assert.deepEqual(layout.center(1), bottom(5 / 6), "crossing the old breakpoint preserves a custom layout");
    f.byText("기본 배치").click();
    assert.deepEqual([1, 2].map(layout.rect), initial);
    assert.deepEqual(
        f.players.map((player) => player.srcObject),
        sources
    );
    f.remove();
    assert.equal(layout.host.hasAttribute("data-bcvm-split"), false, "the main alone fills the native player again");
});

test("folding the empty bottom replay row keeps playback, fits the media and resets the default slots", async (t) => {
    const f = fixture(t);
    const layout = layoutFixture(f);
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const rootDivider = () => f.document.querySelector(`${PANEL} [data-bcvm-divider="r"]`);
    const bounds = layout.host.getBoundingClientRect();
    const point = (y) => ({ clientX: bounds.left + 200, clientY: bounds.top + bounds.height * y });
    const sources = f.players.map((player) => player.srcObject);
    layout.pointer(rootDivider(), "pointerdown", point(2 / 3));
    layout.pointer(f.document.body, "pointermove", point(1));
    layout.pointer(f.document.body, "pointercancel", point(1));
    assert.equal(rootDivider().getAttribute("aria-valuenow"), "67");
    layout.drag(rootDivider(), point(2 / 3), point(1));
    assert.equal(rootDivider().getAttribute("aria-orientation"), "vertical");
    assert.equal(f.document.querySelectorAll(`${PANEL} .bcvm-divider:not([hidden])`).length, 1);
    assert.equal(layout.pane(1).style.height, "100%");
    assert.equal(layout.pane(2).style.height, "100%");
    assert.ok(Math.abs(parseFloat(layout.host.style.getPropertyValue("--bcmv-packed-aspect")) - 8 / 3) < 1e-6);
    assert.deepEqual(
        f.players.map((player) => player.srcObject),
        sources
    );
    assert.equal(f.main.video.currentTime, 40);
    f.byText("기본 배치").click();
    assert.equal(rootDivider().getAttribute("aria-valuenow"), "67");
    assert.equal(layout.host.hasAttribute("data-bcmv-packed"), false);
    rootDivider().dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    assert.equal(layout.host.dataset.bcmvPacked, "host");
    f.byText("기본 배치").click();
    f.add(3);
    f.add(4);
    await flush();
    layout.drag(rootDivider(), point(2 / 3), point(1));
    assert.equal(rootDivider().getAttribute("aria-orientation"), "horizontal");
    assert.ok(layout.rect(4).height > 0);
    assert.deepEqual(
        f.players.slice(0, 2).map((player) => player.srcObject),
        sources
    );
    f.document.querySelector(`${PANEL}-launcher`).click();
    assert.equal(layout.host.hasAttribute("data-bcmv-packed"), false);
});

test("dragging the native replay to the folded bottom edge opens three targets and leaves playback in place", async (t) => {
    const f = fixture(t);
    const layout = layoutFixture(f);
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const { host, pane, pointer } = layout;
    host.getBoundingClientRect = () => new f.w.DOMRect(100, 30, 960, host.dataset.bcmvPacked ? 360 : 540);
    const point = (x, y) => ({ clientX: 100 + x, clientY: 30 + y });
    const preview = f.document.querySelector(`${PANEL} .bcvm-drop-preview`);
    const root = f.document.querySelector('[data-bcvm-divider="r"]');
    root.dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    const packed = layout.rect(1);
    const sources = f.players.map((player) => player.srcObject);
    const start = () => pointer(f.main.video, "pointerdown", layout.center(1));
    const move = (x, y) => pointer(f.document.body, "pointermove", point(x, y));
    start();
    move(240, 220);
    assert.equal(preview.hidden, true, "a drag inside the same replay leaves the row folded");
    move(160, 359);
    assert.equal(preview.hidden, false);
    assert.equal(preview.textContent, "하단에 배치");
    assert.equal(host.getBoundingClientRect().height, 540);
    move(800, 500);
    assert.ok(Math.abs(parseFloat(pane(1).style.left) - 200 / 3) < 1e-6);
    pointer(f.document.body, "pointercancel", point(800, 500));
    assert.deepEqual(layout.rect(1), packed);

    start();
    move(160, 359);
    move(480, 460);
    move(160, 150);
    assert.equal(preview.hidden, true);
    assert.deepEqual(layout.rect(1), packed);
    move(800, 362);
    pointer(f.document.body, "pointerup", point(480, 495));
    assert.equal(root.getAttribute("aria-orientation"), "horizontal");
    assert.ok(Math.abs(parseFloat(pane(1).style.left) - 100 / 3) < 1e-6);
    assert.ok(Math.abs(parseFloat(pane(1).style.top) - 200 / 3) < 1e-6);
    assert.equal(pane(2).style.top, "0%");
    assert.deepEqual(
        f.players.map((player) => player.srcObject),
        sources
    );
    assert.equal(f.main.video.currentTime, 40);
    assert.equal(f.w.location.pathname, "/video/1");
});

test("equalizes both secondary regions while preserving the main, playback and timeline", async (t) => {
    const f = fixture(t);
    const layout = layoutFixture(f);
    f.apply(true);
    f.open();
    const align = f.byText("보조 방송 정렬");
    assert.equal(align.disabled, true);
    f.add(2);
    await flush();
    assert.equal(align.disabled, true);
    for (const no of [3, 4, 5, 6]) f.add(no);
    await flush();
    assert.equal(align.disabled, false);
    const sources = f.players.map((player) => player.srcObject);
    const requests = f.requests.length;
    const main = layout.rect(1);
    const key = (path, key) =>
        f.document
            .querySelector(`[data-bcvm-divider="${path}"]`)
            .dispatchEvent(new f.w.KeyboardEvent("keydown", { key, bubbles: true }));
    key("rab", "ArrowDown");
    key("rba", "ArrowRight");
    assert.ok(Math.abs(layout.rect(2).height - layout.rect(3).height) > 1);
    assert.ok(Math.abs(layout.rect(4).width - layout.rect(5).width) > 1);
    const free = f.byText("자유 배치");
    free.click();
    assert.equal(align.disabled, true);
    const from = layout.center(2);
    layout.drag(layout.pane(2).querySelector(".bcvm-grip"), from, { ...from, clientY: 775 });
    const firstSub = () => f.document.querySelector(`${TOOLBAR} .bcvm-entry .bcvm-title`).href;
    assert.equal(firstSub(), url(3), "the free windows are numbered in their current visual order");
    free.click();
    assert.equal(align.disabled, false);
    assert.equal(firstSub(), url(2), "returning to the split restores its own row order");
    Object.defineProperty(f.document, "fullscreenElement", { configurable: true, value: f.main.shadowRoot });
    f.document.dispatchEvent(new f.w.Event("fullscreenchange"));
    assert.equal(align.disabled, true);
    delete f.document.fullscreenElement;
    f.document.dispatchEvent(new f.w.Event("fullscreenchange"));
    align.click();
    assert.deepEqual(layout.rect(1), main);
    assert.ok(Math.abs(layout.rect(2).height - layout.rect(3).height) < 0.01);
    for (const no of [5, 6]) assert.ok(Math.abs(layout.rect(4).width - layout.rect(no).width) < 0.01);
    assert.deepEqual(
        f.players.map((player) => player.srcObject),
        sources
    );
    assert.equal(f.requests.length, requests);
    assert.equal(f.main.video.currentTime, 40);
    assert.equal(f.main.paused, false);
    assert.equal(f.document.querySelector(`${TIMELINE} .bcvm-timeline-jump`).textContent, "공통 구간으로 이동");
});

test("drags and docks the existing players while the main replay keeps its identity", async (t) => {
    const f = fixture(t);
    const layout = layoutFixture(f);
    f.apply(true);
    f.open();
    f.add(2);
    f.add(3);
    await flush();
    const [main, first, second] = f.players;
    const providers = f.players.map((player) => player.srcObject);
    const requests = f.requests.length;
    const before = [1, 2, 3].map(layout.rect);
    const preview = f.document.querySelector(".bcvm-drop-preview");
    layout.pointer(first.video, "pointerdown", layout.center(2));
    layout.pointer(second.video, "pointermove", layout.center(3));
    assert.equal(preview.hidden, false);
    f.w.dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    assert.deepEqual([1, 2, 3].map(layout.rect), before);
    assert.equal(preview.hidden, true);

    const volume = first.querySelector(".pzp-pc__volume-button");
    layout.drag(volume, layout.center(2), layout.center(3));
    assert.deepEqual([1, 2, 3].map(layout.rect), before);
    layout.drag(first.video, layout.center(2), layout.center(3));
    assert.deepEqual([layout.rect(2), layout.rect(3)], [before[2], before[1]]);
    assert.equal(f.document.querySelector(`${TOOLBAR} .bcvm-entry .bcvm-title`).textContent, "다시보기 3");
    const reordered = [...f.document.querySelectorAll(`${TOOLBAR} .bcvm-entry`)];
    assert.deepEqual(
        reordered.map((row) => row.querySelector(".bcvm-role").textContent),
        ["서브 1", "서브 2"]
    );
    assert.deepEqual(
        reordered.map((row) => row.querySelector(".bcvm-title").href),
        [url(3), url(2)]
    );

    main.shadowRoot.setAttribute("data-bcz-pannable", "");
    const nextMain = layout.rect(3);
    layout.drag(main.video, layout.center(1), layout.center(3));
    assert.deepEqual(layout.rect(1), before[0], "the zoomed surface keeps ordinary dragging for panning");
    layout.drag(main.video, layout.center(1), layout.center(3), { altKey: true });
    assert.deepEqual(layout.rect(1), nextMain);
    const click = (type, detail) =>
        main.video.dispatchEvent(new f.w.MouseEvent(type, { bubbles: true, cancelable: true, detail }));
    assert.equal(click("click", 1), false, "a completed drag consumes its trailing click");
    assert.equal(click("dblclick", 2), false, "a completed drag also consumes its trailing double click");
    layout.drag(main.video, layout.center(1), layout.center(1));
    assert.equal(click("click", 1), true, "the next ordinary press still reaches the video");
    const mainRect = layout.rect(1);
    layout.drag(second.video, layout.center(3), { clientX: mainRect.x + 2, clientY: mainRect.y + mainRect.height / 2 });
    assert.ok(layout.rect(3).x < layout.rect(1).x);
    assert.deepEqual(
        f.players.map((player) => player.srcObject),
        providers
    );
    assert.equal(f.requests.length, requests);
    assert.equal(main.shadowRoot.parentElement, layout.host);
    assert.equal(main.video.currentTime, 40);
    assert.equal(main.paused, false);
    assert.equal(f.w.location.pathname, "/video/1");
});

test("links auxiliary channel names and list titles to their own replay without navigating after a drag", async (t) => {
    const f = fixture(t);
    const layout = layoutFixture(f);
    f.responses.set(2, detail(2, { channel: { channelId: "b".repeat(32), channelName: "서브 채널" } }));
    f.apply(true);
    f.open();
    f.add(2);
    f.add(3);
    await flush();
    const grip = layout.pane(2).querySelector("a.bcvm-grip");
    const title = f.document.querySelector(`${TOOLBAR} .bcvm-entry a.bcvm-title`);
    assert.ok(grip);
    assert.ok(title);
    assert.equal(grip.textContent, "서브 채널");
    assert.equal(title.textContent, "다시보기 2");
    assert.equal(title.previousElementSibling.textContent, "서브 채널");
    assert.equal(title.previousElementSibling.hidden, false);
    assert.equal(f.document.querySelectorAll(`${TOOLBAR} .bcvm-entry .bcvm-channel`)[1].hidden, true);
    assert.equal(grip.href, url(2));
    assert.equal(title.href, url(2));
    assert.equal(grip.draggable, false, "link dragging must keep the existing layout gesture");
    assert.equal(grip.target, "", "ordinary activation opens the replay in the same tab");
    assert.equal(title.target, "");
    assert.equal(layout.pane(1).querySelector("a.bcvm-grip"), null);

    const followed = [];
    for (const link of [grip, title]) {
        link.addEventListener("click", (event) => {
            if (!event.defaultPrevented) followed.push(link.href);
            event.preventDefault(); // JSDOM cannot follow navigation; record allowed link activations.
        });
    }
    const click = (link, detail = 1) =>
        link.dispatchEvent(new f.w.MouseEvent("click", { bubbles: true, cancelable: true, detail }));
    layout.drag(grip, layout.center(2), layout.center(2));
    click(grip);
    click(title);
    assert.deepEqual(followed, [url(2), url(2)]);

    const destination = layout.rect(3);
    layout.drag(grip, layout.center(2), layout.center(3));
    click(grip);
    assert.deepEqual(layout.rect(2), destination);
    assert.equal(followed.length, 2, "the trailing click after moving a channel must not navigate");
    assert.equal(f.document.querySelector(`${TOOLBAR} .bcvm-entry a`).href, url(3));
    click(grip, 0);
    assert.equal(followed.length, 3, "keyboard activation still works after a layout gesture");
    layout.drag(grip, layout.center(2), layout.center(2));
    click(grip);
    assert.equal(followed.length, 4, "the next ordinary click works after a drag");
    assert.equal(grip.href, url(2), "reordering never switches a channel's replay destination");
    assert.equal(title.href, url(2));
});

test("removes only the selected replay from its tile X while the controls are hidden and forgets it on restart", async (t) => {
    const f = fixture(t);
    const layout = layoutFixture(f);
    f.apply(true);
    f.open();
    f.add(2);
    f.add(3);
    await flush();
    const [main, first, second] = f.players;
    for (const sub of [first, second]) {
        sub.loaded(60);
        sub.seeked();
    }
    await flush();
    const sources = f.players.map((player) => player.srcObject);
    const close = layout.pane(2).querySelector(".bcvm-tile-close");
    assert.ok(close.querySelector("svg"));
    assert.equal(close.title, "영상 빼기");
    assert.equal(close.getAttribute("aria-label"), "다시보기 2 빼기");
    assert.equal(layout.pane(1).querySelector(".bcvm-tile-close"), null);
    f.document.querySelector(`${TOOLBAR} [aria-label="멀티뷰 패널 닫기"]`).click();
    const before = [1, 2, 3].map(layout.rect);
    layout.drag(close, layout.center(2), layout.center(3));
    assert.deepEqual([1, 2, 3].map(layout.rect), before, "the X must not start a layout drag");
    close.click();
    await flush();
    assert.equal(layout.pane(2), null);
    assert.equal(f.document.querySelector(`${TOOLBAR} [aria-label="다시보기 2 빼기"]`), null);
    assert.equal(first.srcObject, null);
    assert.equal(first._lastSrcObj, null);
    assert.equal(sources[1].closed, true);
    assert.equal(second.srcObject, sources[2]);
    assert.equal(second.paused, false);
    assert.equal(main.srcObject, sources[0]);
    assert.equal(main.video.currentTime, 40);
    assert.equal(f.document.querySelector(TOOLBAR).hidden, true);
    const launcher = f.document.querySelector(`${PANEL}-launcher`);
    assert.equal(f.document.activeElement, launcher);
    launcher.click();
    launcher.click();
    await flush();
    assert.equal(layout.pane(2), null, "an explicitly removed replay must not return after toggling on");
    assert.ok(layout.pane(3));
});

test("moves, resizes and restores free replay windows across mode changes", async (t) => {
    const f = fixture(t);
    const layout = layoutFixture(f);
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const sub = f.players[1];
    const provider = sub.srcObject;
    const split = layout.rect(2);
    const toggle = f.byText("자유 배치");
    toggle.click();
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    assert.equal(layout.host.getAttribute("popover"), "manual");
    assert.equal(layout.opened(), true);
    const start = layout.center(2);
    layout.drag(sub.video, start, { clientX: -300, clientY: start.clientY });
    assert.equal(layout.rect(2).x, 0);
    const before = layout.rect(2);
    const corner = layout.pane(2).querySelector('[data-bcvm-corner="se"]');
    assert.equal(corner.hidden, false);
    const edge = { clientX: before.x + before.width, clientY: before.y + before.height };
    layout.drag(corner, edge, { clientX: edge.clientX + 180, clientY: edge.clientY + 102 });
    const grown = layout.rect(2);
    assert.ok(grown.width > before.width);
    assert.ok(Math.abs(grown.width / grown.height - before.width / before.height) < 0.00001);
    assert.ok(grown.x + grown.width <= 1200 && grown.y + grown.height <= 800);
    const grip = layout.pane(2).querySelector(".bcvm-grip");
    grip.dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    const saved = layout.rect(2);
    assert.ok(saved.x > grown.x);
    layout.setViewport(800, 680);
    assert.ok(layout.rect(2).x + layout.rect(2).width <= 800);
    layout.setViewport(1200, 800);
    assert.deepEqual(layout.rect(2), saved);

    toggle.click();
    assert.equal(layout.opened(), false);
    assert.equal(layout.host.hasAttribute("popover"), false);
    assert.deepEqual(layout.rect(2), split);
    toggle.click();
    assert.deepEqual(layout.rect(2), saved);
    Object.defineProperty(f.document, "fullscreenElement", { configurable: true, value: sub.shadowRoot });
    f.document.dispatchEvent(new f.w.Event("fullscreenchange"));
    assert.equal(layout.opened(), false);
    assert.equal(corner.hidden, true);
    Object.defineProperty(f.document, "fullscreenElement", { value: null });
    f.document.dispatchEvent(new f.w.Event("fullscreenchange"));
    assert.equal(layout.opened(), true);
    assert.deepEqual(layout.rect(2), saved);
    assert.equal(sub.srcObject, provider);

    f.apply(false);
    await flush();
    assert.equal(layout.opened(), false);
    assert.equal(layout.host.hasAttribute("data-bcvm-viewport"), false);
    assert.equal(layout.host.hasAttribute("popover"), false);
    assert.equal(layout.host.hasAttribute("data-bcvm-split"), false);
    assert.equal(sub.srcObject, null);
    assert.equal(f.main.video.currentTime, 40);
});

test("timeline metadata keeps only trusted profile images", async (t) => {
    const f = fixture(t);
    const load = () => f.w.CheeseSpanner.vodMultiviewMetadata.loadVideo("2", {});
    f.responses.set(
        2,
        detail(2, {
            channel: {
                channelId: "b".repeat(32),
                channelName: "보조",
                channelImageUrl: "https://nng-phinf.pstatic.net/profile.png",
            },
        })
    );
    assert.equal((await load()).channelImageUrl, "https://nng-phinf.pstatic.net/profile.png");
    f.responses.get(2).content.channel.channelImageUrl = "https://other.example/profile.png";
    assert.ok(!(await load()).channelImageUrl);
});

test("timeline uses one bar with profile markers at every broadcast start and end", async (t) => {
    const f = fixture(t);
    for (const [no, name] of [
        [1, "메인 방송인"],
        [2, "보조 방송인"],
    ])
        f.responses.set(
            no,
            detail(no, {
                channel: {
                    channelId: (no === 1 ? "a" : "b").repeat(32),
                    channelName: name,
                    channelImageUrl: `https://nng-phinf.pstatic.net/${no}.png`,
                },
            })
        );
    f.apply(true);
    f.open();
    const timeline = f.document.querySelector(TIMELINE);
    assert.equal(timeline.open, false);
    assert.equal(timeline.nextElementSibling.getAttribute("aria-label"), "추가한 영상");
    assert.equal(f.requests.length, 0);
    f.add(2);
    await flush();
    assert.equal(
        timeline.querySelector(".bcvm-timeline-point"),
        null,
        "collapsed timeline does not create image markers"
    );
    await toggleTimeline(timeline);
    const points = timeline.querySelectorAll(".bcvm-timeline-point");
    const subStart = timeline.querySelector('[data-video-no="2"][data-boundary="start"]');
    const subEnd = timeline.querySelector('[data-video-no="2"][data-boundary="end"]');
    assert.equal(points.length, 4);
    assert.equal(timeline.querySelectorAll(".bcvm-timeline-track").length, 1);
    assert.equal(timeline.querySelectorAll(".bcvm-timeline-marker").length, 1);
    assert.equal(timeline.querySelectorAll(".bcvm-timeline-overlap").length, 1);
    assert.match(points[0].getAttribute("aria-label"), /메인 · 메인 방송인.*시작.*2026\.11\.09 20:00:00/);
    assert.equal(subStart.querySelector("img").src, "https://nng-phinf.pstatic.net/2.png");
    assert.equal(subEnd.querySelector("img").src, subStart.querySelector("img").src);
    assert.match(subEnd.querySelector("time").textContent, /종료.*20:01:30/);
    assert.equal(subStart.style.getPropertyValue("--bcvm-position"), "25%");
    assert.equal(subEnd.style.getPropertyValue("--bcvm-position"), "75%");
    assert.equal(timeline.querySelector(".bcvm-timeline-overlap").style.left, "25%");
    assert.equal(timeline.querySelector(".bcvm-timeline-overlap").style.width, "50%");
    assert.equal(timeline.querySelector(".bcvm-timeline-now").textContent, "현재 20:00:40");
    assert.equal(f.requests.length, 2, "the chart reuses the two playback metadata responses");
    assert.deepEqual(f.main.seeks, [], "opening the chart does not move playback");
    f.main.state.currentTime = 42;
    f.main.emit("timeupdate");
    assert.equal(timeline.querySelector(".bcvm-timeline-now").textContent, "현재 20:00:42");
    assert.equal(timeline.querySelector(".bcvm-timeline-list").style.getPropertyValue("--bcvm-current"), "35%");
    subStart.querySelector("img").dispatchEvent(new f.w.Event("error"));
    assert.equal(subStart.querySelector("img"), null);
    assert.equal(subStart.querySelector(".bcvm-timeline-avatar").textContent, "보");
});

test("common interval jump seeks the owned main once and preserves pause, rate and volume", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const timeline = f.document.querySelector(TIMELINE);
    await toggleTimeline(timeline);
    Object.assign(f.main.state, { paused: true, playbackRate: 1.5 });
    f.main.volume = 0.35;
    f.main.muted = false;
    const button = timeline.querySelector(".bcvm-timeline-jump");
    assert.equal(button.disabled, false);
    button.click();
    assert.deepEqual(f.main.seeks, [30]);
    assert.equal(f.main.paused, true);
    assert.equal(f.main.state.playbackRate, 1.5);
    assert.equal(f.main.volume, 0.35);
    assert.equal(f.main.muted, false);
    assert.equal(button.disabled, true, "a pending native seek disables another jump");
    f.main.seeked();
    assert.equal(timeline.querySelector(".bcvm-timeline-now").textContent, "현재 20:00:30");
    assert.equal(button.disabled, false);
    assert.equal(f.main.playCalls, 0);
});

test("the last frame of the main replay still permits a jump to the shared interval", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const timeline = f.document.querySelector(TIMELINE);
    await toggleTimeline(timeline);
    Object.defineProperty(f.main.video, "ended", { configurable: true, value: true });
    f.main.state.paused = true;
    f.move(120);
    f.main.emit("ended");
    const jump = timeline.querySelector(".bcvm-timeline-jump");
    assert.equal(jump.disabled, false);
    assert.match(timeline.querySelector(".bcvm-timeline-now").textContent, /20:02:00/);
    jump.click();
    assert.deepEqual(f.main.seeks, [30]);
    assert.equal(f.main.playCalls, 0);
});

test("six coincident broadcasts keep one portrait row with less than half overlap when the panel narrows", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    for (let no = 2; no <= 6; no++) {
        f.responses.set(no, detail(no, { liveOpenDate: START, duration: 120 }));
        f.add(no);
        await flush();
    }
    const timeline = f.document.querySelector(TIMELINE);
    await toggleTimeline(timeline);
    const points = timeline.querySelector(".bcvm-timeline-points");
    let width = 295;
    Object.defineProperty(points, "clientWidth", { get: () => width });
    f.w.dispatchEvent(new f.w.Event("resize"));
    assert.equal(timeline.querySelectorAll(".bcvm-timeline-track").length, 1);
    assert.equal(points.children.length, 12);
    const starts = [...points.querySelectorAll('[data-boundary="start"]')];
    const ends = [...points.querySelectorAll('[data-boundary="end"]')];
    const checkSpacing = () => {
        const markers = [...points.children];
        const centers = markers.map((point) => parseFloat(point.style.left) + 10);
        assert.equal(new Set(markers.map((point) => f.w.getComputedStyle(point).top)).size, 1);
        for (const [index, point] of markers.entries()) {
            assert.equal(point.tabIndex, 0, "every partially covered portrait can receive keyboard focus");
            if (index) assert.ok(centers[index] - centers[index - 1] >= 11);
            assert.ok(centers[index] >= 10 && centers[index] <= width - 10);
            const anchor = 22 + (parseFloat(point.style.getPropertyValue("--bcvm-position")) / 100) * (width - 44);
            const stemAngle = parseFloat(point.style.getPropertyValue("--bcvm-stem-angle"));
            assert.ok(Math.abs(centers[index] + Math.tan(stemAngle) * 36 - anchor) < 0.001);
        }
        for (const group of [starts, ends]) {
            assert.ok(group.every((point) => point.dataset.crowded === "true"));
            for (let index = 1; index < group.length; index++)
                assert.equal(parseFloat(group[index].style.left) - parseFloat(group[index - 1].style.left), 11);
        }
    };
    checkSpacing();
    const oldLeft = parseFloat(ends[0].style.left);
    width = 195;
    f.w.dispatchEvent(new f.w.Event("resize"));
    assert.ok(parseFloat(ends[0].style.left) < oldLeft);
    checkSpacing();
    width = parseFloat(timeline.querySelector(".bcvm-timeline-plot").style.minWidth);
    f.w.dispatchEvent(new f.w.Event("resize"));
    checkSpacing();
    const positions = [...points.children].map((point) => point.style.cssText);
    await toggleTimeline(timeline);
    width = 150;
    f.w.dispatchEvent(new f.w.Event("resize"));
    assert.deepEqual(
        [...points.children].map((point) => point.style.cssText),
        positions
    );
    assert.equal(f.requests.length, 6);
    assert.deepEqual(f.main.seeks, []);
});

test("timeline nudges portraits only after their overlap reaches half and keeps true time anchors", async (t) => {
    const f = fixture(t);
    f.responses.set(2, detail(2, { liveOpenDate: "2026-11-09 20:00:40", duration: 60 }));
    f.responses.set(3, detail(3, { liveOpenDate: "2026-11-09 20:00:44", duration: 40 }));
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    f.add(3);
    await flush();
    const timeline = f.document.querySelector(TIMELINE);
    await toggleTimeline(timeline);
    const points = timeline.querySelector(".bcvm-timeline-points");
    let width = 404;
    Object.defineProperty(points, "clientWidth", { get: () => width });
    const near = [2, 3].map((no) => points.querySelector(`[data-video-no="${no}"][data-boundary="start"]`));
    for (const [available, expectedShift] of [
        [404, 0],
        [374, 0],
        [344, 0.5],
        [284, 1.5],
    ]) {
        width = available;
        f.w.dispatchEvent(new f.w.Event("resize"));
        const anchors = [40, 44].map((seconds) => 22 + (seconds / 120) * (width - 44));
        const centers = near.map((point) => parseFloat(point.style.left) + 10);
        assert.ok(Math.abs(centers[0] - (anchors[0] - expectedShift)) < 0.001);
        assert.ok(Math.abs(centers[1] - (anchors[1] + expectedShift)) < 0.001);
        assert.ok(centers[1] - centers[0] >= 11);
        assert.ok(centers[1] - centers[0] < 20, "partial portrait overlap remains visible");
    }
    f.w.dispatchEvent(new f.w.Event("resize"));
    assert.equal(f.requests.length, 3, "layout changes do not reload metadata");
    assert.deepEqual(f.main.seeks, [], "moving the portraits never changes playback time");
});

test("timeline distinguishes disjoint and unverified ranges and updates after removal", async (t) => {
    const f = fixture(t);
    f.responses.set(2, detail(2, { liveOpenDate: START, duration: 20 }));
    f.responses.set(3, detail(3, { liveOpenDate: "2026-11-09 20:01:00", duration: 30 }));
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    f.add(3);
    await flush();
    const timeline = f.document.querySelector(TIMELINE);
    await toggleTimeline(timeline);
    assert.match(timeline.textContent, /함께 겹치는 구간은 없습니다/);
    assert.equal(timeline.querySelector(".bcvm-timeline-jump").disabled, true);
    assert.equal(timeline.querySelectorAll(".bcvm-timeline-overlap").length, 0);
    f.remove();
    assert.equal(timeline.querySelectorAll(".bcvm-timeline-point").length, 4);
    assert.equal(timeline.querySelectorAll(".bcvm-timeline-track").length, 1);
    assert.equal(timeline.querySelector(".bcvm-timeline-jump").disabled, false);
    f.responses.set(4, detail(4, { liveOpenDate: null }));
    f.add(4);
    await flush();
    assert.equal(timeline.querySelectorAll(".bcvm-timeline-point").length, 4);
    assert.equal(timeline.querySelector('[data-video-no="4"]'), null);
    assert.equal(timeline.querySelector(".bcvm-timeline-jump").disabled, true);
    assert.match(timeline.textContent, /방송 시각이 확인된 영상부터/);
    assert.ok(!timeline.innerHTML.includes("NaN"));
    assert.deepEqual(f.main.seeks, []);
});

test("timeline endpoints and common seek retain the KST date across midnight", async (t) => {
    const f = fixture(t);
    f.responses.set(1, detail(1, { liveOpenDate: "2026-11-09 23:59:30" }));
    f.responses.set(2, detail(2, { liveOpenDate: "2026-11-10 00:00:00" }));
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const timeline = f.document.querySelector(TIMELINE);
    await toggleTimeline(timeline);
    const mainStart = timeline.querySelector('[data-main="true"][data-boundary="start"]');
    const mainEnd = timeline.querySelector('[data-main="true"][data-boundary="end"]');
    assert.match(mainStart.getAttribute("aria-label"), /11\.09.*23:59:30/);
    assert.match(mainEnd.getAttribute("aria-label"), /11\.10.*00:01:30/);
    assert.equal(mainEnd.querySelector("time").dateTime, "2026-11-09T15:01:30.000Z");
    assert.match(timeline.querySelector(".bcvm-timeline-axis").textContent, /11\.09 23:59.*11\.10 00:01/);
    assert.match(timeline.querySelector(".bcvm-help").textContent, /11\.10 00:00 ~ 11\.10 00:01/);
    timeline.querySelector(".bcvm-timeline-jump").click();
    assert.deepEqual(f.main.seeks, [30]);
});

test("timeline stops reading playback when collapsed, hidden, closed or disabled", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const timeline = f.document.querySelector(TIMELINE);
    let reads = 0;
    f.document.addEventListener("cheese-spanner:vod-multiview:command", (event) => {
        if (event.detail?.action === "reference") reads++;
    });
    await toggleTimeline(timeline);
    reads = 0;
    f.main.emit("timeupdate");
    assert.equal(reads, 1);
    await toggleTimeline(timeline);
    reads = 0;
    f.main.emit("timeupdate");
    assert.equal(reads, 0);
    await toggleTimeline(timeline);
    Object.defineProperty(f.document, "hidden", { configurable: true, value: true });
    f.document.dispatchEvent(new f.w.Event("visibilitychange"));
    reads = 0;
    f.main.emit("timeupdate");
    assert.equal(reads, 0);
    Object.defineProperty(f.document, "hidden", { configurable: true, value: false });
    f.document.dispatchEvent(new f.w.Event("visibilitychange"));
    reads = 0;
    f.main.emit("timeupdate");
    assert.equal(reads, 1);
    f.document.querySelector(`${TOOLBAR} .bcvm-close`).click();
    reads = 0;
    f.main.emit("timeupdate");
    assert.equal(reads, 0);
    f.apply(false);
    f.main.emit("timeupdate");
    assert.equal(reads, 0);
    assert.equal(f.document.querySelector(TIMELINE), null);
});

test("native timeline seeks reject invalid times, stale media, advertising and foreign main identities", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    const { media } = await f.w.CheeseSpanner.vodMultiviewMetadata.loadVideo("1", {});
    const panel = f.document.querySelector(PANEL);
    const seek = (at, main = media) =>
        panel.dispatchEvent(
            new f.w.CustomEvent("cheese-spanner:vod-multiview:command", {
                bubbles: true,
                detail: { action: "seek", main, at },
            })
        );
    let coercions = 0;
    const invalidTime = {
        valueOf() {
            coercions++;
            throw new Error("Do not coerce page input");
        },
    };
    for (const at of [NaN, Infinity, "1", Symbol("time"), invalidTime, media.startMs - 1, media.endMs]) seek(at);
    assert.equal(coercions, 0);
    f.main.state.duration = media.duration - 1;
    seek(media.endMs - 1000);
    f.main.state.duration = media.duration;
    seek(media.startMs, { ...media, videoNo: "2" });
    seek(media.startMs, { ...media, id: "other_media" });
    f.main.shadowRoot.classList.add("pzp-pc--adbreak");
    seek(media.startMs);
    f.main.shadowRoot.classList.remove("pzp-pc--adbreak");
    f.main.src = src("changed_media");
    seek(media.startMs);
    assert.deepEqual(f.main.seeks, []);
    assert.equal(f.main.paused, false);
    f.main.src = src("media_1");
    seek(media.startMs + 20000);
    assert.deepEqual(f.main.seeks, [20]);
});

test("closed timeline metadata cannot recreate rows after navigation", async (t) => {
    const f = fixture(t);
    let finish;
    f.responses.set(2, new Promise((resolve) => (finish = resolve)));
    f.apply(true);
    f.open();
    f.add(2);
    const timeline = f.document.querySelector(TIMELINE);
    await toggleTimeline(timeline);
    assert.equal(timeline.querySelector(".bcvm-timeline-jump").disabled, true);
    assert.ok(!timeline.innerHTML.includes("NaN"));
    f.w.history.pushState({}, "", "/");
    await flush();
    finish(detail(2));
    await flush();
    assert.equal(f.document.querySelector(TIMELINE), null);
    assert.equal(f.players.length, 1);
    assert.deepEqual(f.main.seeks, []);
});

test("loads a bounded, validated following list with the existing authenticated request helper", async (t) => {
    const f = fixture(t);
    const channel = { channelId: "b".repeat(32), channelName: "  팔로잉 채널  " };
    f.following.response = {
        code: 200,
        content: {
            followingList: [
                { channel: { ...channel, channelImageUrl: "https://evil.example/avatar.png" } },
                { channel },
                { channel: { channelId: "../other", channelName: "잘못된 채널" } },
                { channel: { channelId: "c".repeat(32), channelName: " " } },
                null,
                ...Array.from({ length: 500 }, () => ({ channel })),
                { channel: { channelId: "d".repeat(32), channelName: "범위 밖 채널" } },
            ],
        },
    };
    const result = await f.w.CheeseSpanner.vodMultiviewMetadata.loadFollowing({});
    assert.equal(result.status, "ok");
    assert.equal(result.channels.length, 1);
    assert.equal(result.channels[0].id, channel.channelId);
    assert.equal(result.channels[0].name, "팔로잉 채널");
    assert.ok(!result.channels[0].image);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].pathname, "/service/v1/channels/followings");
    assert.equal(f.requests[0].query, "?page=0&size=505&sortType=FOLLOW");
    assert.equal(f.requests[0].credentials, "include");
});

test("distinguishes signed-out, empty and failed following responses", async (t) => {
    const f = fixture(t);
    const load = () => f.w.CheeseSpanner.vodMultiviewMetadata.loadFollowing({});
    f.following.response = { code: 401 };
    assert.equal((await load()).status, "login-required");
    f.following.response = { code: 200, content: null };
    assert.equal((await load()).status, "lookup-error");
    f.following.response = { code: 200, content: { followingList: [] } };
    assert.equal((await load()).channels.length, 0);
    f.w.fetch = async () => ({ ok: false, status: 401 });
    assert.equal((await load()).status, "login-required");
    f.w.fetch = async () => ({ ok: false, status: 503 });
    assert.equal((await load()).status, "lookup-error");
    f.w.fetch = async () => {
        throw new f.w.DOMException("Internal timeout", "AbortError");
    };
    assert.equal((await load()).status, "lookup-error", "a timeout remains retryable");
    const controller = new f.w.AbortController();
    controller.abort();
    await assert.rejects(f.w.CheeseSpanner.vodMultiviewMetadata.loadFollowing({ signal: controller.signal }));
});

test("replay panel opens with addition collapsed and keeps playback while adding and closing the section", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    const toolbar = f.document.querySelector(TOOLBAR);
    const toggle = toolbar.querySelector(".bcvm-add-toggle");
    const add = f.document.getElementById(toggle.getAttribute("aria-controls"));
    assert.equal(add.hidden, true);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(f.document.activeElement, toggle);
    assert.equal(f.requests.length, 0);
    assert.equal(toolbar.querySelector(".bcvm-timeline").open, false);
    f.openAdd();
    assert.equal(add.hidden, false);
    assert.equal(toolbar.querySelector('[aria-label="추가한 영상"]').hidden, false);
    assert.equal(toolbar.querySelector('[aria-label="화면 배치"]').hidden, false);
    const input = toolbar.querySelector('input[type="search"]');
    input.value = url(2);
    input.dispatchEvent(new f.w.Event("input", { bubbles: true }));
    assert.equal(toolbar.querySelector('button[type="submit"]').textContent, "영상 추가");
    f.add(2);
    await flush();
    assert.equal(toolbar.hidden, false);
    assert.equal(add.hidden, true);
    assert.equal(f.document.activeElement, toggle);
    assert.equal(toolbar.querySelectorAll(".bcvm-entry").length, 1);
    const source = f.players[1].srcObject;
    f.openAdd();
    assert.equal(input.value, "");
    assert.equal(toolbar.querySelector('button[type="submit"]').textContent, "검색");
    toolbar.dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(add.hidden, true);
    assert.equal(toolbar.hidden, false, "first Escape only collapses addition");
    assert.equal(f.document.activeElement, toggle);
    toolbar.dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(toolbar.hidden, true);
    assert.equal(f.players[1].srcObject, source);
    assert.equal(f.main.video.currentTime, 40);
    assert.deepEqual(f.main.seeks, []);
});

test("following subtab filters channels locally and adds the overlapping replay without changing the main", async (t) => {
    const f = fixture(t);
    const channel = { channelId: "b".repeat(32), channelName: "팔로잉 Alpha" };
    f.following.response = {
        code: 200,
        content: {
            followingList: [{ channel }, { channel: { channelId: "c".repeat(32), channelName: "다른 채널" } }],
        },
    };
    f.pages.set(0, [{ videoNo: 2, videoType: "REPLAY", publishDate: "2026-11-09 20:03:00" }]);
    f.responses.set(2, detail(2, { channel }));
    f.apply(true);
    f.open();
    f.openAdd();
    assert.equal(f.requests.length, 0, "opening the default search tab does not fetch followings");
    const search = f.byText("검색·주소");
    const following = f.byText("팔로잉");
    assert.equal(search.getAttribute("aria-selected"), "true");
    following.click();
    await flush();
    assert.equal(search.tabIndex, -1);
    assert.equal(following.tabIndex, 0);
    assert.equal(f.document.getElementById(search.getAttribute("aria-controls")).hidden, true);
    assert.equal(f.document.getElementById(following.getAttribute("aria-controls")).hidden, false);
    assert.equal(f.document.querySelectorAll(`${TOOLBAR} .bcvm-following-list button`).length, 2);
    const filter = f.document.querySelector('input[aria-label="팔로잉 채널 찾기"]');
    filter.value = "ALPHA";
    filter.dispatchEvent(new f.w.Event("input", { bubbles: true }));
    assert.equal(f.document.querySelectorAll(`${TOOLBAR} .bcvm-following-list button`).length, 1);
    assert.equal(f.requests.length, 1, "filtering does not repeat the list request");
    f.byText(channel.channelName).click();
    await flush();
    assert.equal(f.players[1].src, src("media_2", "key_2"));
    assert.equal(f.main.video.currentTime, 40);
    assert.deepEqual(f.main.seeks, []);
    assert.equal(f.main.paused, false);
    assert.equal(f.document.querySelector(`${TOOLBAR} .bcvm-add-toggle`).getAttribute("aria-expanded"), "false");
    f.openAdd();
    await flush();
    filter.value = "없는 채널";
    filter.dispatchEvent(new f.w.Event("input", { bubbles: true }));
    assert.match(
        f.document.querySelector(`${TOOLBAR} .bcvm-add-pane:not([hidden]) [role="status"]`).textContent,
        /일치하는.*없습니다/
    );
    search.click();
    f.add(3);
    await flush();
    assert.ok(f.document.querySelector(`${PANEL} [data-bcvm-tile="3"]`), "URL entry still works after switching back");
});

test("following subtab shows login, failure and empty states with an explicit refresh", async (t) => {
    const f = fixture(t);
    f.following.response = { code: 401 };
    f.apply(true);
    f.open();
    f.openAdd();
    f.byText("팔로잉").click();
    await flush();
    const pane = f.document.querySelector(`${TOOLBAR} [role="tabpanel"]:not([hidden])`);
    const status = pane.querySelector('[role="status"]');
    const refresh = f.byText("새로고침");
    assert.match(status.textContent, /로그인/);
    assert.equal(refresh.disabled, false);
    f.following.response = { code: 500 };
    refresh.click();
    await flush();
    assert.match(status.textContent, /불러오지 못/);
    f.following.response = { code: 200, content: { followingList: [] } };
    refresh.click();
    await flush();
    assert.match(status.textContent, /팔로잉한 채널이 없습니다/);
    f.following.response.content.followingList = [{ channel: { channelId: "b".repeat(32), channelName: "새 팔로잉" } }];
    refresh.click();
    await flush();
    assert.ok(f.byText("새 팔로잉"));
    f.byText("새 팔로잉").click();
    await flush();
    assert.match(f.document.querySelector(`${TOOLBAR} .bcvm-notice`).textContent, /겹치는 공개 다시보기 없음/);
    assert.equal(f.players.length, 1);
});

test("add subtabs provide roving keyboard focus without reloading the selected tab", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    f.openAdd();
    const search = f.byText("검색·주소");
    const following = f.byText("팔로잉");
    const key = (node, value) =>
        node.dispatchEvent(new f.w.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
    search.focus();
    key(search, "ArrowRight");
    await flush();
    assert.equal(f.document.activeElement, following);
    assert.equal(following.getAttribute("aria-selected"), "true");
    key(following, "End");
    following.click();
    assert.equal(f.requests.length, 1);
    key(following, "Home");
    assert.equal(f.document.activeElement, search);
    assert.equal(search.getAttribute("aria-selected"), "true");
    key(search, "ArrowLeft");
    await flush();
    assert.equal(f.document.activeElement, following);
    assert.equal(f.requests.length, 2, "returning to followings reads the current account list");
    f.document.querySelector(`${PANEL}-launcher`).click();
    f.open();
    await flush();
    assert.equal(f.requests.length, 2, "reopening the panel keeps addition collapsed without a list request");
    assert.equal(f.document.activeElement, f.document.querySelector(`${TOOLBAR} .bcvm-add-toggle`));
    f.openAdd();
    await flush();
    assert.equal(f.requests.length, 3);
    assert.equal(f.document.activeElement.getAttribute("aria-label"), "팔로잉 채널 찾기");
});

test("leaving a following subtab cancels its request and discards late results", async (t) => {
    for (const action of ["search", "collapse", "close", "off", "route"]) {
        await t.test(action, async (t) => {
            const f = fixture(t);
            let finish;
            f.following.response = new Promise((resolve) => (finish = resolve));
            f.apply(true);
            f.open();
            f.openAdd();
            f.byText("팔로잉").click();
            const request = f.requests[0];
            assert.equal(request.signal.aborted, false);
            if (action === "search") f.byText("검색·주소").click();
            if (action === "collapse") f.document.querySelector(`${TOOLBAR} .bcvm-add-toggle`).click();
            if (action === "close") f.document.querySelector(`${TOOLBAR} .bcvm-close`).click();
            if (action === "off") f.apply(false);
            if (action === "route") f.w.history.pushState({}, "", url(9));
            await flush();
            assert.equal(request.signal.aborted, true);
            finish({
                code: 200,
                content: { followingList: [{ channel: { channelId: "b".repeat(32), channelName: "늦은 채널" } }] },
            });
            await flush();
            assert.equal(f.byText("늦은 채널"), undefined);
            assert.equal(f.players.length, 1);
        });
    }
});

test("a cancelled following response cannot replace a newer list or its loading state", async (t) => {
    const f = fixture(t);
    let finishOld;
    let finishNew;
    f.following.response = new Promise((resolve) => (finishOld = resolve));
    f.apply(true);
    f.open();
    f.openAdd();
    f.byText("팔로잉").click();
    await flush();
    f.byText("검색·주소").click();
    f.following.response = new Promise((resolve) => (finishNew = resolve));
    f.byText("팔로잉").click();
    await flush();
    finishOld({ code: 401 });
    await flush();
    assert.equal(f.byText("새로고침").disabled, true);
    const pane = f.document.querySelector(`${TOOLBAR} [role="tabpanel"]:not([hidden])`);
    assert.equal(pane.getAttribute("aria-busy"), "true");
    assert.match(pane.textContent, /불러오고 있습니다/);
    finishNew({
        code: 200,
        content: { followingList: [{ channel: { channelId: "c".repeat(32), channelName: "현재 채널" } }] },
    });
    await flush();
    assert.equal(f.byText("새로고침").disabled, false);
    assert.ok(f.byText("현재 채널"));
});

test("switching away from a selected following channel cancels its pending replay addition", async (t) => {
    const f = fixture(t);
    const channel = { channelId: "b".repeat(32), channelName: "선택한 팔로잉" };
    f.following.response = { code: 200, content: { followingList: [{ channel }] } };
    f.pages.set(0, [{ videoNo: 2, videoType: "REPLAY", publishDate: "2026-11-09 20:03:00" }]);
    let finish;
    f.responses.set(2, new Promise((resolve) => (finish = resolve)));
    f.apply(true);
    f.open();
    f.openAdd();
    f.byText("팔로잉").click();
    await flush();
    f.byText(channel.channelName).click();
    await flush();
    const request = f.requests.find(({ no }) => no === 2);
    assert.ok(request);
    f.byText("검색·주소").click();
    assert.equal(request.signal.aborted, true);
    finish(detail(2, { channel }));
    await flush();
    assert.equal(f.document.querySelector(`${PANEL} .bcvm-screen`), null);
    assert.equal(f.players.length, 1);
});

test("prefers a channel replay covering the current position across paginated publication dates", async (t) => {
    const f = fixture(t);
    const at = Date.parse("2026-11-09T20:00:40+09:00");
    const row = (videoNo, offset) => ({ videoNo, videoType: "REPLAY", publishDateAt: at + offset });
    f.pages.set(0, [row(8, 3600000)]);
    f.pages.set(1, [row(5, 120000), row(3, 60000), row(4, -40001)]);
    f.pages.set(2, [row(9, -60000)]);
    const channel = { channelId: "b".repeat(32), channelName: "검색한 채널" };
    f.responses.set(3, detail(3, { channel, liveOpenDate: "2026-11-09 20:00:41" }));
    f.responses.set(5, detail(5, { channel, liveOpenDate: "2026-11-09 19:59:42", duration: 90 }));
    f.apply(true);
    f.open();
    await f.chooseChannel();
    assert.equal(f.players[1].src, src("media_5", "key_5"));
    assert.deepEqual(
        f.requests.filter((item) => item.pathname.includes("/channels/")).map(({ page }) => page),
        [0, 1, 2]
    );
    assert.ok(!f.requests.some(({ no }) => no === 4 || no === 8 || no === 9));
    assert.equal(f.main.video.currentTime, 40);
});

test("selects a channel replay that ended and was published before the current main position", async (t) => {
    const f = fixture(t);
    const channel = { channelId: "b".repeat(32) };
    f.pages.set(0, [{ videoNo: 2, videoType: "REPLAY", publishDate: "2026-11-09 20:00:24" }]);
    f.responses.set(2, detail(2, { channel, liveOpenDate: "2026-11-09 19:59:50", duration: 30 }));
    f.main.state.currentTime = 100;
    f.apply(true);
    f.open();
    await f.chooseChannel();

    assert.ok(f.document.querySelector(`${PANEL} [data-bcvm-tile="2"]`));
    assert.match(f.status(), /해당 시각/);
    assert.equal(f.players.length, 1, "the selected replay waits for the overlapping part");
    assert.equal(f.main.video.currentTime, 100);
    f.move(10);
    await flush();
    const sub = f.players[1];
    assert.equal(sub.src, src("media_2", "key_2"));
    sub.loaded(30);
    assert.deepEqual(sub.seeks, [20]);
    sub.seeked();
    await flush();
    assert.equal(sub.paused, false);
    assert.deepEqual(f.main.seeks, []);
});

test("selecting a channel captures the current replay and time before the first main lookup resolves", async (t) => {
    const f = fixture(t);
    const channel = { channelId: "b".repeat(32) };
    f.pages.set(0, [
        { videoNo: 2, videoType: "REPLAY", publishDate: "2026-11-09 20:03:00" },
        { videoNo: 3, videoType: "REPLAY", publishDate: "2026-11-09 20:02:00" },
    ]);
    f.responses.set(2, detail(2, { channel, liveOpenDate: START, duration: 60 }));
    f.responses.set(3, detail(3, { channel, liveOpenDate: "2026-11-09 20:01:00", duration: 60 }));
    let finishMain;
    f.responses.set(1, new Promise((resolve) => (finishMain = resolve)));
    f.apply(true);
    f.open();
    await f.chooseChannel();
    assert.ok(f.requests.some(({ no }) => no === 1));
    f.move(80);
    finishMain(detail(1));
    await flush();
    assert.ok(f.document.querySelector(`${PANEL} [data-bcvm-tile="2"]`));
    assert.equal(f.document.querySelector(`${PANEL} [data-bcvm-tile="3"]`), null);
    assert.equal(f.main.video.currentTime, 80);
    assert.deepEqual(f.main.seeks, []);
});

test("keeps a channel match when main seeks outside the overlap during the lookup", async (t) => {
    const f = fixture(t);
    const channel = { channelId: "b".repeat(32) };
    f.pages.set(0, [{ videoNo: 2, videoType: "REPLAY", publishDate: "2026-11-09 20:03:00" }]);
    let finish;
    f.responses.set(2, new Promise((resolve) => (finish = resolve)));
    f.apply(true);
    f.open();
    await f.chooseChannel();
    assert.ok(f.requests.some(({ no }) => no === 2));
    f.move(100);
    finish(detail(2, { channel }));
    await flush();

    assert.ok(f.document.querySelector(`${PANEL} [data-bcvm-tile="2"]`));
    assert.match(f.status(), /해당 시각/);
    assert.equal(f.main.video.currentTime, 100);
    assert.equal(f.main.paused, false);
    assert.equal(f.players.length, 1);
});

test("rejects channel replays that only touch either end of the main broadcast", async (t) => {
    const f = fixture(t);
    const channel = { channelId: "b".repeat(32) };
    f.pages.set(0, [
        { videoNo: 2, videoType: "REPLAY", publishDate: "2026-11-09 20:04:00" },
        { videoNo: 3, videoType: "REPLAY", publishDate: "2026-11-09 20:01:00" },
    ]);
    f.responses.set(2, detail(2, { channel, liveOpenDate: "2026-11-09 20:02:00" }));
    f.responses.set(3, detail(3, { channel, liveOpenDate: "2026-11-09 19:59:00" }));
    f.apply(true);
    f.open();
    await f.chooseChannel();

    assert.deepEqual(
        f.requests.filter(({ no }) => no > 1).map(({ no }) => no),
        [3, 2]
    );
    assert.equal(f.document.querySelector(`${PANEL} .bcvm-screen`), null);
    assert.equal(f.players.length, 1);
});

test("matches auxiliary quality on entry and preference changes while respecting later manual selection", async (t) => {
    const f = fixture(t);
    function preferences(quality) {
        f.document.documentElement.setAttribute(QUALITY_STATE_ATTR, JSON.stringify({ enabled: true, quality }));
        f.w.dispatchEvent(new f.w.Event(QUALITY_STATE_EVENT));
    }
    preferences("720p");
    f.files(["features/autoQualityPage.js"]);
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const sub = f.players[1];
    const tracks = (sub.videoTracks = [
        { id: "0", label: "ABR", selected: true },
        { id: "hd", label: "720p", height: 720, selected: false },
        { id: "fhd", label: "1080p", height: 1080, selected: false },
    ]);
    tracks.selectedIndex = 0;
    sub.loaded(60);
    sub.seeked();
    await flush();
    assert.equal(tracks.selectedIndex, 1);
    assert.equal(tracks[1].selected, true);

    tracks[1].selected = false;
    tracks[0].selected = true;
    tracks.selectedIndex = 0;
    sub.emit("canplay");
    preferences("720p");
    assert.equal(tracks.selectedIndex, 0);
    preferences("1080p");
    assert.equal(tracks.selectedIndex, 2);
    assert.equal(tracks[2].selected, true);
    assert.equal(f.main.video.currentTime, 40);
    assert.deepEqual(f.main.seeks, []);
});

test("places the auxiliary broadcast clock beside the right controls and follows that replay's time", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const sub = f.players[1];
    const clock = sub.querySelector(".bcvm-clock");
    assert.equal(clock.hidden, true);
    assert.equal(clock.nextElementSibling.className, "pzp-pc__bottom-buttons-right");
    sub.loaded(60);
    sub.seeked();
    sub.emit("timeupdate");
    assert.equal(clock.hidden, false);
    assert.equal(clock.dateTime, "20:00:40");
    assert.equal(clock.querySelector(".bcvm-clock-label").textContent, "방송시각");
    f.apply(true, { vodBroadcastClockEnabled: false });
    assert.equal(clock.isConnected, false);
});

test("separates the player toggle from the panel X and hides the toggle with native playback controls", (t) => {
    const f = fixture(t);
    f.apply(true);
    const launcher = f.document.querySelector(`${PANEL}-launcher`);
    const toolbar = f.document.querySelector(TOOLBAR);
    const close = toolbar.querySelector('[aria-label="멀티뷰 패널 닫기"]');
    assert.ok(close.querySelector("svg"));
    assert.equal(close.textContent, "");
    assert.equal(launcher.getAttribute("aria-pressed"), "false");
    assert.equal(launcher.getAttribute("aria-label"), "다시보기 멀티뷰 켜기");
    launcher.click();
    assert.equal(toolbar.hidden, false);
    assert.equal(launcher.getAttribute("aria-pressed"), "true", "an empty multiview can still be switched on and off");
    assert.equal(launcher.getAttribute("aria-label"), "다시보기 멀티뷰 끄기");
    assert.equal(launcher.hasAttribute("aria-expanded"), false);
    f.main.shadowRoot.classList.remove("pzp-pc--controls");
    assert.equal(f.w.getComputedStyle(launcher).opacity, "0", "an open panel must not pin the player button");
    assert.equal(f.w.getComputedStyle(launcher).pointerEvents, "none");
    f.main.shadowRoot.classList.add("pzp-pc--controls");
    assert.notEqual(f.w.getComputedStyle(launcher).opacity, "0");
    close.click();
    assert.equal(toolbar.hidden, true);
    assert.equal(launcher.getAttribute("aria-pressed"), "true");
    assert.equal(f.document.activeElement, launcher);
    launcher.click();
    assert.equal(launcher.getAttribute("aria-pressed"), "false");
    assert.equal(launcher.getAttribute("aria-label"), "다시보기 멀티뷰 켜기");
    assert.equal(toolbar.hidden, true);
});

test("toggles the controls beside the video and falls back below it when the sidebar is unavailable", async (t) => {
    const f = fixture(t);
    f.w.innerWidth = 1600;
    const { host } = layoutFixture(f);
    const row = f.document.createElement("div");
    row.className = "_player_fixture_1";
    row.getBoundingClientRect = () => new f.w.DOMRect(240, 60, 1220, 520);
    host.before(row);
    row.append(host);
    function sidebar(id, left, width = 300) {
        const aside = f.document.createElement("aside");
        aside.id = id;
        aside.style.position = "relative";
        const header = f.document.createElement("div");
        header.dataset.bcvcHeader = "1";
        header.innerHTML = '<button aria-label="더보기 메뉴"></button>';
        aside.append(header);
        aside.getBoundingClientRect = () => new f.w.DOMRect(left, 60, width, 520);
        header.getBoundingClientRect = () => new f.w.DOMRect(left, 60, width, 44);
        row.append(aside);
        return aside;
    }
    const chat = sidebar("vod-aside", 1160);
    f.apply(true);
    f.open();
    const toolbar = f.document.querySelector(TOOLBAR);
    const launcher = f.document.querySelector(`${PANEL}-launcher`);
    assert.equal(toolbar.parentElement, chat);
    assert.equal(toolbar.dataset.placement, "sidebar");
    assert.equal(toolbar.style.getPropertyValue("--bcvm-toolbar-top"), "52px");
    f.add(2);
    await flush();
    const sub = f.players[1];
    sub.loaded(60);
    sub.seeked();
    await flush();
    const source = sub.srcObject;
    const mainSource = f.main.srcObject;
    assert.equal(sub.paused, false);

    f.w.innerWidth = 900;
    f.w.dispatchEvent(new f.w.Event("resize"));
    assert.equal(toolbar.dataset.placement, "below", "an off-screen sidebar cannot hide the controls at browser zoom");
    assert.ok(
        240 +
            parseFloat(toolbar.style.getPropertyValue("--bcvm-toolbar-left")) +
            parseFloat(toolbar.style.getPropertyValue("--bcvm-toolbar-width")) <=
            f.w.innerWidth
    );
    assert.equal(sub.srcObject, source);
    f.w.innerWidth = 1600;
    f.w.dispatchEvent(new f.w.Event("resize"));
    assert.equal(toolbar.parentElement, chat);

    f.document.querySelector(`${TOOLBAR} [aria-label="멀티뷰 패널 닫기"]`).click();
    assert.equal(toolbar.hidden, true);
    assert.equal(launcher.getAttribute("aria-pressed"), "true");
    assert.equal(sub.srcObject, source);
    assert.equal(sub.paused, false);
    f.document.querySelector(`${PANEL}-chat-settings`).click();
    assert.equal(toolbar.parentElement, chat);
    assert.equal(toolbar.hidden, false);
    assert.equal(launcher.getAttribute("aria-pressed"), "true");

    chat.getBoundingClientRect = () => new f.w.DOMRect(420, 60, 300, 520);
    f.w.dispatchEvent(new f.w.Event("resize"));
    assert.equal(toolbar.previousElementSibling, row);
    assert.equal(toolbar.dataset.placement, "below");
    assert.equal(toolbar.style.getPropertyValue("--bcvm-toolbar-left"), "552px");
    assert.equal(toolbar.hidden, false);
    assert.equal(sub.srcObject, source);

    chat.remove();
    const comments = sidebar("cheese-spanner-vod-comment-aside", 0, 240);
    await flush();
    assert.equal(toolbar.parentElement, comments);
    comments.getBoundingClientRect = () => new f.w.DOMRect(420, 60, 300, 520);
    f.w.dispatchEvent(new f.w.Event("resize"));
    assert.equal(toolbar.previousElementSibling, row, "an overlapping sidebar leaves the video area clear");
    assert.equal(sub.srcObject, source);
    assert.equal(f.main.srcObject, mainSource);
    assert.equal(f.main.video.currentTime, 40);

    Object.defineProperty(f.document, "fullscreenElement", { configurable: true, value: sub.shadowRoot });
    f.document.dispatchEvent(new f.w.Event("fullscreenchange"));
    assert.equal(toolbar.hidden, true);
    assert.equal(launcher.disabled, true);
    assert.equal(sub.srcObject, source);
});

test("closing or hiding native chat dismisses replay settings without relocating it or stopping playback", async (t) => {
    for (const action of ["remove", "hide", "native-close"]) {
        await t.test(action, async (t) => {
            const f = fixture(t);
            f.w.innerWidth = 1600;
            layoutFixture(f);
            const aside = f.document.createElement("aside");
            aside.id = "vod-aside";
            aside.style.position = "relative";
            aside.innerHTML =
                '<div class="_header_fixture_1"><button aria-label="더보기 메뉴"></button><button class="_close_button_fixture_1"><span class="blind">라이브 채팅 다시보기 닫기</span></button></div>';
            aside.getBoundingClientRect = () => new f.w.DOMRect(1160, 60, 300, 520);
            aside.firstElementChild.getBoundingClientRect = () => new f.w.DOMRect(1160, 60, 300, 44);
            f.document.body.append(aside);
            f.apply(true);
            f.open();
            const trigger = f.document.querySelector(`${PANEL}-chat-settings`);
            f.document.querySelector(`${TOOLBAR} .bcvm-close`).click();
            trigger.click();
            const toolbar = f.document.querySelector(TOOLBAR);
            const launcher = f.document.querySelector(`${PANEL}-launcher`);
            f.add(2);
            await flush();
            const sub = f.players[1];
            sub.loaded(60);
            sub.seeked();
            await flush();
            const source = sub.srcObject;
            const mainSource = f.main.srcObject;
            let nativeClicks = 0;
            const close = aside.querySelector('button[class^="_close_button_"]');
            close.addEventListener("click", () => {
                nativeClicks++;
            });

            if (action === "remove") aside.remove();
            else if (action === "hide") {
                aside.style.display = "none";
                f.w.dispatchEvent(new f.w.Event("resize"));
            } else {
                const popup = f.document.createElement("div");
                popup.className = "_header_popup_1";
                popup.innerHTML = '<button class="_close_button_popup_1">프로필 닫기</button>';
                aside.append(popup);
                popup.firstElementChild.click();
                assert.equal(toolbar.hidden, false, "closing a nested popup is not closing native chat");
                popup.remove();
                close.querySelector("span").click();
            }
            await flush();

            assert.equal(toolbar.hidden, true);
            assert.equal(toolbar.parentElement, aside, "closing chat must not move settings below the video");
            assert.equal(trigger.getAttribute("aria-expanded"), "false");
            assert.equal(launcher.getAttribute("aria-pressed"), "true");
            assert.equal(f.document.activeElement, launcher);
            assert.equal(sub.srcObject, source);
            assert.equal(sub.paused, false);
            assert.equal(f.main.srcObject, mainSource);
            assert.equal(f.main.video.currentTime, 40);
            assert.equal(nativeClicks, action === "native-close" ? 1 : 0, "native close receives its own click");

            aside.style.removeProperty("display");
            if (!aside.isConnected) f.document.body.append(aside);
            f.w.dispatchEvent(new f.w.Event("resize"));
            await flush();
            assert.equal(toolbar.hidden, true, "reopening chat must not reopen settings automatically");
            trigger.click();
            assert.equal(toolbar.hidden, false);
            assert.equal(toolbar.parentElement, aside);
            assert.equal(sub.srcObject, source);
        });
    }
});

test("opens the existing replay controls from the chat header and restores focus without stopping playback", async (t) => {
    const f = fixture(t);
    f.w.innerWidth = 1600;
    layoutFixture(f);
    const aside = f.document.createElement("aside");
    aside.id = "vod-aside";
    aside.style.position = "relative";
    aside.innerHTML =
        '<div class="_header_tdctj_9"><h2>라이브 채팅 다시보기</h2><div class="_buttons_tdctj_29"><button type="button" class="_menu_button_tdctj_36" aria-haspopup="true" aria-expanded="false"><span class="blind">더보기 메뉴</span></button><button type="button" class="_close_button_tdctj_57"><span class="blind">라이브 채팅 다시보기 닫기</span></button></div></div>';
    aside.getBoundingClientRect = () => new f.w.DOMRect(1160, 60, 300, 520);
    const header = aside.firstElementChild;
    header.getBoundingClientRect = () => new f.w.DOMRect(1160, 60, 300, 44);
    f.document.body.append(aside);
    const menu = header.querySelector("button");
    const actions = menu.parentElement;
    let menuClicks = 0;
    menu.addEventListener("click", () => menuClicks++);
    f.apply(false);
    assert.equal(f.document.querySelector(`${PANEL}-chat-settings`), null);
    f.apply(true);
    assert.equal(f.document.querySelector(`${PANEL}-chat-settings`), null, "the page multiview is still off");
    f.open();
    const trigger = f.document.querySelector(`${PANEL}-chat-settings`);
    const launcher = f.document.querySelector(`${PANEL}-launcher`);
    const toolbar = f.document.querySelector(TOOLBAR);
    assert.ok(trigger, "the native VOD menu uses a blind label, without aria-label");
    assert.equal(trigger.nextElementSibling, menu);
    assert.equal(menu.parentElement, actions, "native menu nodes must keep their original parent");
    assert.equal(trigger.getAttribute("aria-controls"), toolbar.id);
    assert.equal(trigger.querySelector("svg").outerHTML, f.w.CheeseSpanner.multiviewView.multiviewIcon().outerHTML);
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    toolbar.querySelector(".bcvm-close").click();
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    trigger.click();
    assert.equal(toolbar.parentElement, aside);
    assert.equal(toolbar.hidden, false);
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.equal(launcher.getAttribute("aria-pressed"), "true");
    assert.equal(f.document.activeElement, toolbar.querySelector(".bcvm-add-toggle"));
    assert.equal(menuClicks, 0);
    f.add(2);
    await flush();
    const sub = f.players[1];
    sub.loaded(60);
    sub.seeked();
    await flush();
    const source = sub.srcObject;
    toolbar.querySelector("input").dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(toolbar.hidden, true);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(launcher.getAttribute("aria-pressed"), "true", "hiding settings keeps multiview on");
    assert.equal(f.document.activeElement, trigger);
    assert.equal(sub.srcObject, source);
    assert.equal(sub.paused, false);
    trigger.click();
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    trigger.click();
    assert.equal(toolbar.hidden, true);
    assert.equal(f.document.activeElement, trigger);
    Object.defineProperty(f.document, "fullscreenElement", { configurable: true, value: sub.shadowRoot });
    f.document.dispatchEvent(new f.w.Event("fullscreenchange"));
    assert.equal(trigger.disabled, true);
    trigger.click();
    assert.equal(toolbar.hidden, true);
    f.apply(false);
    assert.equal(f.document.querySelector(`${PANEL}-chat-settings`), null);
    assert.equal(menu.parentElement, actions);
    menu.click();
    assert.equal(menuClicks, 1);
});

test("reattaches one replay header button after delayed chat, native clones and menu replacement", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    f.document.querySelector(`${TOOLBAR} .bcvm-close`).click();
    assert.equal(f.document.querySelector(`${PANEL}-chat-settings`), null);
    const aside = f.document.createElement("aside");
    aside.id = "vod-aside";
    aside.innerHTML =
        '<div class="_header_fixture_1"><h2>라이브 채팅 다시보기</h2><div><button aria-label="더보기 메뉴"></button><button aria-label="라이브 채팅 다시보기 닫기"></button></div></div>';
    f.document.body.append(aside);
    await flush();
    const trigger = f.document.querySelector(`${PANEL}-chat-settings`);
    assert.ok(trigger);
    const clone = aside.cloneNode(true);
    aside.replaceWith(clone);
    await flush();
    let menu = clone.querySelector('[aria-label="더보기 메뉴"]');
    assert.equal(f.document.querySelectorAll(`${PANEL}-chat-settings`).length, 1);
    assert.equal(f.document.querySelector(`${PANEL}-chat-settings`), trigger);
    assert.equal(trigger.nextElementSibling, menu);
    trigger.remove();
    await flush();
    assert.equal(trigger.nextElementSibling, menu, "native header renders restore the working button");
    menu.remove();
    await flush();
    assert.equal(trigger.isConnected, false);
    const group = f.document.createElement("span");
    group.dataset.bcctModeratorActions = "1";
    menu = f.document.createElement("button");
    menu.className = "native-action _menu_button_replaced_1";
    menu.setAttribute("aria-haspopup", "true");
    menu.innerHTML = '<span class="blind">더보기 메뉴</span>';
    group.append(menu);
    clone.querySelector("h2").after(group);
    await flush();
    assert.equal(trigger.nextElementSibling, group);
    assert.equal(menu.parentElement, group, "existing chat-tools wrappers stay intact");
    trigger.click();
    const toolbar = f.document.querySelector(TOOLBAR);
    assert.equal(toolbar.hidden, false);
    clone.remove();
    await flush();
    toolbar.dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(f.document.activeElement, f.document.querySelector(`${PANEL}-launcher`));
    f.document.body.append(clone);
    await flush();
    assert.equal(f.document.querySelectorAll(`${PANEL}-chat-settings`).length, 1);
    f.w.history.pushState({}, "", "/lives");
    await flush();
    assert.equal(f.document.querySelector(`${PANEL}-chat-settings`), null);
    assert.equal(menu.parentElement, group);
});

test("restores the same main replay's auxiliary list after toggling off and disabling, with empty native slots in between", async (t) => {
    const f = fixture(t);
    const tiles = () => [...f.document.querySelectorAll(`${PANEL} .bcvm-screen`)].map((node) => node.dataset.bcvmTile);
    const aside = f.document.createElement("aside");
    aside.id = "vod-aside";
    aside.innerHTML = '<div class="_header_fixture_1"><button aria-label="더보기 메뉴"></button></div>';
    f.document.body.append(aside);
    f.apply(true);
    f.open();
    f.add(2);
    f.add(3);
    await flush();
    const [main, first, second] = f.players;
    const mainProvider = main.srcObject;
    const providers = [first.srcObject, second.srcObject];
    assert.ok(providers.every(Boolean));
    const oldTrigger = f.document.querySelector(`${PANEL}-chat-settings`);
    f.document.querySelector(`${PANEL}-launcher`).click();
    await flush();
    assert.deepEqual(tiles(), []);
    assert.ok(providers.every((provider) => provider.closed));
    assert.ok([first, second].every((player) => player.srcObject === null && player._lastSrcObj === null));
    assert.equal(f.document.querySelector(`${PANEL}-chat-settings`), null);
    oldTrigger.click();
    await flush();
    assert.equal(f.document.querySelector(TOOLBAR).hidden, true);
    assert.equal(f.document.querySelector(`${PANEL}-launcher`).getAttribute("aria-pressed"), "false");
    assert.deepEqual(tiles(), [], "a detached settings button must not restart remembered replays");
    f.open();
    await flush();
    assert.deepEqual(tiles(), ["2", "3"]);
    assert.equal(f.players.length, 3);
    assert.notEqual(first.srcObject, providers[0]);
    assert.notEqual(second.srcObject, providers[1]);

    f.apply(false);
    f.apply(true);
    const before = f.requests.length;
    f.open();
    await flush();
    assert.deepEqual(tiles(), ["2", "3"]);
    assert.equal(f.requests.slice(before).filter(({ no }) => no === 1).length, 1);
    f.document.querySelector(`${TOOLBAR} [aria-label="다시보기 2 빼기"]`).click();
    f.w.history.pushState({}, "", "/video/9");
    await flush();
    f.open();
    assert.deepEqual(tiles(), []);
    f.w.history.pushState({}, "", "/video/1");
    await flush();
    f.open();
    await flush();
    assert.deepEqual(tiles(), ["3"]);
    assert.equal(main.srcObject, mainProvider);
    assert.equal(main.video.currentTime, 40);
    assert.deepEqual(main.seeks, []);
});

test("keeps the active replay selection through a same-route player gap without seeking the main", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const root = f.main.shadowRoot;
    const host = root.parentElement;
    const sub = f.players[1];
    const provider = sub.srcObject;
    sub.loaded(60);
    sub.seeked();
    await flush();
    f.document.querySelector(`${TOOLBAR} .bcvm-sync`).click();
    sub.video.volume = 0.37;
    sub.video.muted = false;
    sub.currentTime = 7;
    sub.seeked();
    root.remove();
    await flush();
    assert.equal(f.document.querySelector(`${PANEL} .bcvm-screen`).dataset.bcvmTile, "2");
    host.prepend(root);
    await flush();
    assert.equal(f.document.querySelector(`${PANEL}-launcher`).getAttribute("aria-pressed"), "true");
    assert.match(f.document.querySelector(`${TOOLBAR} .bcvm-entry .bcvm-title`).href, /\/video\/2$/);
    assert.equal(f.document.querySelector(`${PANEL} .bcvm-screen`).dataset.bcvmTile, "2");
    assert.equal(f.document.querySelector(`${TOOLBAR} .bcvm-sync`).getAttribute("aria-checked"), "false");
    assert.equal(sub.srcObject, provider);
    assert.equal(sub.video.currentTime, 7);
    assert.equal(sub.video.volume, 0.37);
    assert.equal(sub.video.muted, false);
    assert.deepEqual(f.main.seeks, []);
    f.w.history.pushState({}, "", "/video/9");
    await flush();
    assert.equal(f.document.querySelector(`${PANEL}-launcher`).getAttribute("aria-pressed"), "false");
    assert.equal(f.document.querySelector(`${PANEL} .bcvm-screen`), null);
});

test("duplicate media removes its temporary slot for sequential and simultaneous adds", async (t) => {
    const f = fixture(t);
    f.responses.set(3, detail(3, { videoId: "media_2" }));
    f.responses.set(4, detail(4, { videoId: "media_2" }));
    f.apply(true);
    f.open();
    f.add(2);
    f.add(3);
    await flush();
    assert.equal(f.document.querySelectorAll(`${PANEL} .bcvm-screen`).length, 1);
    assert.equal(f.document.querySelectorAll(`${TOOLBAR} .bcvm-entry`).length, 1);
    assert.match(f.document.querySelector(`${TOOLBAR} .bcvm-notice`).textContent, /이미 화면/);
    f.add(4);
    await flush();
    assert.equal(f.document.querySelectorAll(`${PANEL} .bcvm-screen`).length, 1);
    f.add(5);
    await flush();
    assert.equal(f.document.querySelectorAll(`${PANEL} .bcvm-screen`).length, 2);
    assert.deepEqual(f.main.seeks, []);
});

test("leaving the mini player resumes only independently playing auxiliaries that it paused", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    for (const no of [2, 3]) {
        f.add(no);
        await flush();
        f.players[no - 1].loaded(60);
        f.players[no - 1].seeked();
        await flush();
    }
    for (const control of f.document.querySelectorAll(`${TOOLBAR} .bcvm-sync`)) control.click();
    const [main, playing, paused] = f.players;
    paused.pause();
    const playingTime = playing.video.currentTime;
    const stoppedPlays = paused.playCalls;
    const host = main.shadowRoot.parentElement;
    for (const mode of ["pip_mode", "miniplayer"]) {
        host.classList.add(mode);
        await flush();
        assert.equal(playing.paused, true);
        host.classList.remove(mode);
        await flush();
        assert.equal(playing.paused, false);
    }
    assert.equal(playing.video.currentTime, playingTime);
    assert.equal(paused.paused, true);
    assert.equal(paused.playCalls, stoppedPlays);
    assert.deepEqual(main.seeks, []);
});

test("resync retries only the auxiliary after three failed seeks", async (t) => {
    const f = fixture(t);
    f.apply(true);
    f.open();
    f.add(2);
    await flush();
    const sub = f.players[1];
    sub.loaded(60);
    for (let i = 0; i < 3; i++) sub.seeked(0);
    const control = f.document.querySelector(`${TOOLBAR} .bcvm-resync`);
    const toggle = f.document.querySelector(`${TOOLBAR} .bcvm-sync`);
    assert.equal(control.hidden, false);
    assert.match(control.getAttribute("aria-label"), /다시 맞추기/);
    assert.equal(toggle.getAttribute("role"), "switch");
    assert.equal(toggle.getAttribute("aria-disabled"), "false");
    const seeks = sub.seeks.length;
    control.focus();
    control.click();
    assert.equal(sub.seeks.length, seeks + 1);
    sub.seeked();
    await flush();
    assert.equal(control.hidden, true);
    assert.equal(f.document.activeElement, toggle);
    assert.equal(sub.video.currentTime, 10);
    f.move(45);
    for (let i = 0; i < 3; i++) sub.seeked(0);
    assert.equal(control.hidden, false);
    const failedSeeks = sub.seeks.length;
    toggle.click();
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    assert.equal(control.hidden, true);
    assert.equal(sub.seeks.length, failedSeeks);
    assert.deepEqual(f.main.seeks, []);
});

test("channel lookup reports an overlapping unsupported replay and prefers a playable one", async (t) => {
    const f = fixture(t);
    const channelId = "b".repeat(32);
    const main = (await f.w.CheeseSpanner.vodMultiviewMetadata.loadVideo("1", {})).media;
    const published = main.startMs + 120_000;
    const row = (videoNo) => ({ videoNo, videoType: "REPLAY", publishDateAt: published });
    f.pages.set(0, [row(2)]);
    f.responses.set(2, detail(2, { channel: { channelId }, vodStatus: "OTHER" }));
    const find = () => f.w.CheeseSpanner.vodMultiviewMetadata.findReplay(channelId, main, {});
    assert.equal((await find()).status, "unsupported");
    f.pages.set(0, [row(3), row(2)]);
    f.responses.set(3, detail(3, { channel: { channelId } }));
    assert.equal((await find()).media.videoNo, "3");
});

test("channel lookup reports only overlapping pending replays and keeps looking for one that is ready", async (t) => {
    const f = fixture(t);
    const model = f.w.CheeseSpanner.vodMultiviewMetadata;
    const main = (await model.loadVideo("1", {})).media;
    const channel = { channelId: "b".repeat(32) };
    const row = (videoNo) => ({ videoNo, videoType: "REPLAY", publishDateAt: main.endMs });
    const find = () => model.findReplay(channel.channelId, main, {});
    f.pages.set(0, [row(2)]);
    const pending = detail(2, { channel, vodStatus: "NONE", inKey: null, liveOpenDate: "2026-11-09 20:02:00" });
    f.responses.set(2, pending);
    assert.equal((await find()).status, "no-replay");
    pending.content.liveOpenDate = START;
    assert.equal((await find()).status, "preparing");
    f.responses.set(3, detail(3, { channel, vodStatus: "OTHER" }));
    f.pages.set(0, [row(3), row(2)]);
    assert.equal((await find()).status, "preparing");
    f.responses.set(3, detail(3, { channel }));
    assert.equal((await find()).media.videoNo, "3");
});

test("channel lookup skips a rewind with no playable tracks and continues to a supported overlap", async (t) => {
    const f = fixture(t);
    const model = f.w.CheeseSpanner.vodMultiviewMetadata;
    const main = (await model.loadVideo("1", {})).media;
    const channelId = "b".repeat(32);
    const row = (videoNo) => ({ videoNo, videoType: "REPLAY", publishDateAt: main.endMs });
    const rewind = rewindDetail(2);
    rewind.content.channel = { channelId };
    const playback = JSON.parse(rewind.content.liveRewindPlaybackJson);
    playback.media[0].encodingTrack = [];
    rewind.content.liveRewindPlaybackJson = JSON.stringify(playback);
    f.responses.set(2, rewind);
    f.pages.set(0, [row(2)]);
    const find = () => model.findReplay(channelId, main, { at: main.startMs + 40_000 });
    assert.equal((await find()).status, "unsupported");
    f.responses.set(3, detail(3, { channel: { channelId } }));
    f.pages.set(0, [row(3), row(2)]);
    assert.equal((await find()).media.videoNo, "3");
});

test("reuses one native slot across 100 additions, removals, option changes and SPA round trips", async (t) => {
    const f = fixture(t);
    f.apply(true);
    let sub;
    for (let cycle = 0; cycle < 100; cycle++) {
        if (cycle % 10 === 0) {
            f.open();
            if (cycle > 0) f.remove();
        }
        f.add(cycle % 2 ? 2 : 3);
        await flush();
        sub = f.players[1];
        assert.equal(f.players.length, 2);
        assert.equal(sub.shadowRoot.isConnected, true);
        sub.loaded(60);
        sub.seeked();
        await flush();
        assert.equal(sub.paused, false);
        if (cycle % 10 === 9) {
            if (cycle % 20 === 9) {
                f.apply(false);
                f.apply(true);
            } else {
                f.w.history.pushState({}, "", "/lives");
                await flush();
                assert.equal(f.document.querySelector(PANEL), null);
                f.w.history.pushState({}, "", "/video/1");
                await flush();
            }
        } else f.remove();
        assert.equal(sub.srcObject, null);
        assert.equal(sub.paused, true);
        assert.equal(sub.shadowRoot.isConnected, false);
        assert.equal(sub.video.readyState, 0);
        assert.equal(f.main.src, src("media_1"));
        assert.equal(f.main.paused, false);
        assert.equal(f.main.video.currentTime, 40);
    }
    assert.equal(sub.providers.length, 100);
    assert.ok(sub.providers.every((provider) => provider.closed));
});
