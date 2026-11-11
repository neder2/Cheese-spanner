const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const PANEL = "#cheese-spanner-vod-multiview";
const TOOLBAR = "#bcvm-toolbar";
const STATUS = `${TOOLBAR} .bcvm-row [role="status"]`;
const START = "2026-11-09 20:00:00";
const flush = () => new Promise((resolve) => setImmediate(resolve));
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
    w.fetch = async (input, { signal }) => {
        const request = new URL(input);
        const no = Number(request.pathname.split("/").at(-1));
        const page = Number(request.searchParams.get("page"));
        requests.push({ no, signal, pathname: request.pathname, page });
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
            return new Player();
        }

        constructor() {
            super();
            players.push(this);
            this.shadowRoot = document.createElement("div");
            this.shadowRoot.className = "pzp-pc";
            this.shadowRoot.innerHTML =
                '<video class="webplayer-internal-video"></video><button class="pzp-pc__playback-switch"></button><button class="pzp-pc__volume-button"></button><button class="pzp-pc__viewmode-button"></button>';
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
                _loadSrcObject: () => this.loadGate || Promise.resolve(),
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
                    this.srcObject.closed = true;
                    if (this.loadGate) this._corePlayer._handleAbort();
                }
                this.srcObject = null;
                this.error = null;
                Object.assign(this.state, { seeking: false, currentTime: 0, playbackRate: 1 });
                if (!this.waitForEmptied) this.state.readyState = 0;
                return;
            }
            this.srcObject = { protocol: "vod3:", player: this._corePlayer, closed: false };
            this._lastSrcObj = this.srcObject;
            this.providers.push(this.srcObject);
            this._corePlayer._loadSrcObject();
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
        "features/vodMultiview/nativePlayer.js",
        "features/vodMultiview/syncPage.js",
        "features/vodMultiview/metadata.js",
        "features/vodMultiview/runtime.js",
    ]);
    t.after(() => {
        w.dispatchEvent(new w.PageTransitionEvent("pagehide"));
        dom.window.close();
    });

    const byText = (text) => [...document.querySelectorAll(`${TOOLBAR} button`)].find((el) => el.textContent === text);
    function open() {
        const launcher = document.querySelector(`${PANEL}-launcher`);
        if (launcher.getAttribute("aria-expanded") === "false") launcher.click();
    }
    function submit(value) {
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
        byText("영상 빼기").click();
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
        files,
        apply,
        open,
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
    await read({ liveOpenDate: null }, "unknown-time");
    await read({ duration: 17 * 3600 }, "unknown-time");
    await read({ nextVideo: { duration: 17 * 3600 } }, "unknown-time");
    await read({ liveEndDate: "2026-11-09 21:00:00" }, "unknown-time");
    await read({ encryptionType: "AES" }, "ok");
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
    f.byText("다시 동기화").click();
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
    assert.equal(f.document.querySelector(TOOLBAR).parentElement, f.main.shadowRoot);
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
    f.byText("멀티뷰 닫기").click();
    await flush();
    assert.ok(f.players.slice(1).every((player) => !player.srcObject && !player._lastSrcObj));
});

function layoutFixture(f) {
    const host = f.document.getElementById("player_layout");
    let popped = false;
    let viewport = [1200, 800];
    const dock = new f.w.DOMRect(240, 60, 920, 520);
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
        setViewport(width, height) {
            viewport = [width, height];
            f.w.dispatchEvent(new f.w.Event("resize"));
        },
    };
}

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
    assert.equal(f.document.querySelector(`${TOOLBAR} .bcvm-entry strong`).textContent, "다시보기 3");

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

test("reuses one native slot across 100 additions, removals, option changes and SPA round trips", async (t) => {
    const f = fixture(t);
    f.apply(true);
    let sub;
    for (let cycle = 0; cycle < 100; cycle++) {
        if (cycle % 10 === 0) f.open();
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
