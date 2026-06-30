const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repoRoot = path.join(__dirname, "..");

function readRepoFile(...parts) {
    return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

function createStorageArea(initialData = {}) {
    const data = { ...initialData };

    return {
        data,
        get(keys, callback) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                if (Object.hasOwn(data, key)) result[key] = data[key];
            }
            setTimeout(() => callback(result), 0);
        },
        set(values, callback) {
            Object.assign(data, values || {});
            setTimeout(() => callback?.(), 0);
        },
    };
}

function createFakeChrome({ sync = {} } = {}) {
    const syncArea = createStorageArea(sync);
    const storageChangeListeners = [];

    return {
        runtime: {},
        storage: {
            sync: syncArea,
            onChanged: {
                addListener(listener) {
                    storageChangeListeners.push(listener);
                },
                removeListener(listener) {
                    const index = storageChangeListeners.indexOf(listener);
                    if (index >= 0) storageChangeListeners.splice(index, 1);
                },
            },
        },
        testState: {
            sync: syncArea.data,
            storageChangeListeners,
        },
    };
}

function createPageDom(html, url, chrome = createFakeChrome()) {
    const dom = new JSDOM(html, {
        url,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });

    dom.window.chrome = chrome;
    dom.window.fetch = async () => {
        throw new Error("Unexpected network request in following preview test");
    };

    return dom;
}

function evalRepoScript(dom, ...parts) {
    dom.window.eval(readRepoFile(...parts));
}

function waitForAsyncCallbacks() {
    return new Promise((resolve) => setTimeout(resolve, 20));
}

function waitForFollowingPreviewDelay() {
    return waitForAsyncCallbacks();
}

function waitForFollowingPreviewFetchDelay() {
    return new Promise((resolve) => setTimeout(resolve, 140));
}

function waitForFollowingPlayerSettle() {
    return new Promise((resolve) => setTimeout(resolve, 120));
}

function createFollowingPreviewPlayerDom({ play } = {}) {
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<script src="https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/player-vendor-test.js"></script>',
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/"
    );
    const { document } = dom.window;
    const state = {
        createdPlayers: [],
        fromJSONCalls: [],
        importUrls: [],
        playCalls: 0,
    };

    function CorePlayer() {
        const video = document.createElement("video");
        Object.defineProperty(video, "srcObject", { configurable: true, value: null, writable: true });
        video.play = () => {
            state.playCalls += 1;
            if (play) return play({ state, video });
            return Promise.resolve();
        };
        video.setMediaKeys = async () => {};
        state.createdPlayers.push(video);
        return video;
    }

    CorePlayer.requestMediaKeySystemAccess = async () => ({
        createMediaKeys: async () => ({
            createSession: () => ({
                addEventListener() {},
                generateRequest: async () => {},
                update: async () => {},
            }),
        }),
    });

    const runtime = {
        CorePlayer,
        LiveProvider: {
            fromJSON(playback, options) {
                const srcObject = { options, playback };
                state.fromJSONCalls.push(srcObject);
                return srcObject;
            },
        },
    };

    dom.window.__betterChzzkFollowingPreviewImport = async (url) => {
        state.importUrls.push(url);
        return runtime;
    };

    return { document, dom, state };
}

function installWebpackPlayerRuntime(dom, getRuntime) {
    dom.window.webpackChunkglive_fe_pc = [];
    dom.window.webpackChunkglive_fe_pc.push = (chunk) => {
        const modules = chunk[1] || {};
        const runtime = chunk[2];
        const playerRuntime = getRuntime();
        const cache = playerRuntime
            ? {
                  49588: { exports: playerRuntime },
              }
            : {};
        const require = (id) => {
            if (Object.hasOwn(modules, id)) {
                const module = { exports: {} };
                modules[id](module, module.exports, require);
                cache[id] = module;
                return module.exports;
            }
            return cache[id]?.exports;
        };
        require.c = cache;
        return runtime(require);
    };
}

function evalFollowingPreviewTooltipScripts(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "followingPreviewTooltip.js");
}

function createFollowingPreviewDom(chrome = createFakeChrome()) {
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div id="app">',
            '<nav class="sidebar">',
            '<section id="following">',
            "<header>",
            "<strong>\uD314\uB85C\uC789 \uCC44\uB110</strong>",
            '<a href="/following?tab=LIVE">\uC804\uCCB4\uBCF4\uAE30</a>',
            "</header>",
            "<ul>",
            '<li class="following_item" id="followingItem">',
            '<a id="liveLink" href="/live/channel-123" aria-label="\uD14C\uC2A4\uD2B8 \uCC44\uB110">',
            '<img class="live_thumbnail_image" src="https://example.com/dom-thumb.jpg" alt="">',
            '<span class="name_text">\uD14C\uC2A4\uD2B8 \uCC44\uB110</span>',
            '<span class="live_title">DOM \uBC29\uC1A1 \uC81C\uBAA9</span>',
            "</a>",
            "</li>",
            "</ul>",
            "</section>",
            "</nav>",
            '<main><article><a id="mainLiveLink" href="/live/main-channel">MAIN LIVE</a></article></main>',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/",
        chrome
    );
    const { document } = dom.window;
    const item = document.getElementById("followingItem");
    const link = document.getElementById("liveLink");

    item.getBoundingClientRect = () => ({
        left: 12,
        top: 80,
        right: 196,
        bottom: 132,
        width: 184,
        height: 52,
    });
    link.getBoundingClientRect = item.getBoundingClientRect;

    return { document, dom, item, link };
}

test("manifest loads following preview after following refresh", () => {
    const manifest = JSON.parse(readRepoFile("manifest.json"));
    const mainScript = manifest.content_scripts.find((entry) => entry.world === "MAIN");
    const isolatedScript = manifest.content_scripts.find((entry) =>
        entry.js?.includes("features/followingPreviewTooltip.js")
    );

    assert.equal(
        manifest.content_scripts.some((entry) => entry.js?.includes("features/followingPreviewFrame.js")),
        false
    );
    assert.ok(mainScript.js.includes("features/followingPreviewPage.js"));
    assert.ok(
        mainScript.js.indexOf("features/followingPreviewPage.js") > mainScript.js.indexOf("features/routeBridgePage.js")
    );
    assert.ok(
        mainScript.js.indexOf("features/followingPreviewPage.js") < mainScript.js.indexOf("features/autoQualityPage.js")
    );
    assert.ok(isolatedScript.js.includes("features/followingPreviewTooltip.js"));
    assert.ok(
        isolatedScript.js.indexOf("features/followingPreviewTooltip.js") >
            isolatedScript.js.indexOf("features/followingRefresh.js")
    );
    assert.ok(
        isolatedScript.js.indexOf("features/shortcutRescue.js") >
            isolatedScript.js.indexOf("features/followingPreviewTooltip.js")
    );
});

test("following preview page bridge mounts CorePlayer from live playback JSON", async () => {
    const { document, dom, state } = createFollowingPreviewPlayerDom();
    const playbackJson = JSON.stringify({
        media: [{ mediaId: "HLS", path: "https://example.com/live.m3u8" }],
    });

    evalRepoScript(dom, "features", "followingPreviewPage.js");

    const firstMount = document.createElement("div");
    firstMount.setAttribute("data-bcfp-player-mount", "first");
    document.body.appendChild(firstMount);
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:following-preview:play", {
            detail: JSON.stringify({
                mountId: "first",
                muted: false,
                playbackJson,
                requestId: "first",
                volume: 0.3,
            }),
        })
    );
    await waitForAsyncCallbacks();

    const video = firstMount.querySelector("video");
    assert.ok(video);
    assert.equal(firstMount.getAttribute("data-bcfp-player-state"), "loading");
    assert.equal(video.autoplay, true);
    assert.equal(video.muted, false);
    assert.equal(video.playsInline, true);
    assert.equal(video.controls, false);
    assert.equal(video.volume, 0.2);
    assert.deepEqual(state.importUrls, [
        "https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/player-vendor-test.js",
    ]);
    assert.equal(state.fromJSONCalls.length, 1);
    assert.equal(JSON.stringify(state.fromJSONCalls[0].playback), playbackJson);
    assert.equal(state.fromJSONCalls[0].options.countryCode, "kr");
    assert.equal(state.fromJSONCalls[0].options.devt, "HTML5_PC");
    assert.equal(state.fromJSONCalls[0].options.maxLevel, 480);
    assert.equal(state.fromJSONCalls[0].options.p2pDisabled, true);
    assert.equal(state.fromJSONCalls[0].options.serviceId, 2099);
    assert.equal(Object.hasOwn(state.fromJSONCalls[0].options, "mediaType"), false);
    assert.equal(Object.hasOwn(state.fromJSONCalls[0].options, "track"), false);

    video.dispatchEvent(new dom.window.Event("loadedmetadata"));
    await waitForAsyncCallbacks();

    assert.equal(firstMount.getAttribute("data-bcfp-player-state"), "ready");
    assert.equal(state.playCalls, 1);

    const secondMount = document.createElement("div");
    secondMount.setAttribute("data-bcfp-player-mount", "second");
    document.body.appendChild(secondMount);
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:following-preview:play", {
            detail: JSON.stringify({
                mountId: "second",
                muted: true,
                playbackJson,
                requestId: "second",
                volume: 0,
            }),
        })
    );
    await waitForAsyncCallbacks();

    assert.equal(firstMount.childElementCount, 0);
    assert.equal(firstMount.getAttribute("data-bcfp-player-state"), "idle");
    assert.equal(secondMount.getAttribute("data-bcfp-player-state"), "loading");
    assert.ok(secondMount.querySelector("video"));
    assert.equal(secondMount.querySelector("video").muted, false);
    assert.equal(secondMount.querySelector("video").volume, 0.2);

    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:following-preview:stop", {
            detail: JSON.stringify({ requestId: "second" }),
        })
    );
    await waitForAsyncCallbacks();

    assert.equal(secondMount.childElementCount, 0);
    assert.equal(secondMount.getAttribute("data-bcfp-player-state"), "idle");
});

test("following preview page bridge marks audio autoplay rejection without muted replay", async () => {
    const rejected = new Error("blocked");
    rejected.name = "NotAllowedError";
    const { document, dom, state } = createFollowingPreviewPlayerDom({ play: () => Promise.reject(rejected) });
    const playbackJson = JSON.stringify({
        media: [{ mediaId: "HLS", path: "https://example.com/live-audio.m3u8" }],
    });

    evalRepoScript(dom, "features", "followingPreviewPage.js");

    const mount = document.createElement("div");
    mount.setAttribute("data-bcfp-player-mount", "audio-blocked");
    document.body.appendChild(mount);
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:following-preview:play", {
            detail: JSON.stringify({
                mountId: "audio-blocked",
                muted: false,
                playbackJson,
                requestId: "audio-blocked",
                volume: 0.3,
            }),
        })
    );
    await waitForAsyncCallbacks();

    const video = mount.querySelector("video");
    assert.ok(video);
    video.dispatchEvent(new dom.window.Event("loadedmetadata"));
    await waitForAsyncCallbacks();

    assert.equal(state.playCalls, 1);
    assert.equal(video.muted, false);
    assert.equal(video.volume, 0.2);
    assert.equal(mount.getAttribute("data-bcfp-player-state"), "error");
});

test("following preview page bridge reuses the main-world CHZZK player from webpack cache", async () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/");
    const { document } = dom.window;
    const players = [];
    const fromJsonCalls = [];

    class FakeCorePlayer extends dom.window.EventTarget {
        constructor() {
            super();
            this.shadowRoot = document.createElement("div");
            this.shadowRoot.className = "fake-core-player";
            this.readyState = 1;
            this.playCalls = 0;
            players.push(this);
        }

        play() {
            this.playCalls += 1;
            return Promise.resolve();
        }
    }

    const fakePlayerRuntime = {
        CorePlayer: FakeCorePlayer,
        LiveProvider: {
            fromJSON(playback, options) {
                fromJsonCalls.push({ options, playback });
                return { options, playback };
            },
        },
    };
    installWebpackPlayerRuntime(dom, () => fakePlayerRuntime);
    evalRepoScript(dom, "features", "followingPreviewPage.js");

    const firstMount = document.createElement("div");
    firstMount.setAttribute("data-bcfp-player-mount", "first");
    document.body.appendChild(firstMount);
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:following-preview:play", {
            detail: JSON.stringify({
                mountId: "first",
                muted: false,
                playbackJson: JSON.stringify({ media: [{ mediaId: "HLS", path: "first.m3u8" }] }),
                requestId: "first",
                volume: 0.25,
            }),
        })
    );
    await waitForAsyncCallbacks();

    assert.equal(players.length, 1);
    assert.equal(firstMount.getAttribute("data-bcfp-player-state"), "ready");
    assert.equal(firstMount.firstElementChild.className, "fake-core-player");
    assert.equal(players[0].muted, false);
    assert.equal(players[0].volume, 0.2);
    assert.equal(fromJsonCalls.length, 1);
    assert.equal(fromJsonCalls[0].options.serviceId, 2099);
    assert.equal(fromJsonCalls[0].options.maxLevel, 480);
    assert.equal(Object.hasOwn(fromJsonCalls[0].options, "mediaType"), false);
    assert.equal(Object.hasOwn(fromJsonCalls[0].options, "track"), false);

    const secondMount = document.createElement("div");
    secondMount.setAttribute("data-bcfp-player-mount", "second");
    document.body.appendChild(secondMount);
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:following-preview:play", {
            detail: JSON.stringify({
                mountId: "second",
                muted: true,
                playbackJson: JSON.stringify({ media: [{ mediaId: "HLS", path: "second.m3u8" }] }),
                requestId: "second",
                volume: 0,
            }),
        })
    );
    await waitForAsyncCallbacks();

    assert.equal(players.length, 1);
    assert.equal(firstMount.childElementCount, 0);
    assert.equal(firstMount.getAttribute("data-bcfp-player-state"), "idle");
    assert.equal(secondMount.getAttribute("data-bcfp-player-state"), "ready");
    assert.equal(secondMount.firstElementChild.className, "fake-core-player");
    assert.equal(fromJsonCalls.length, 2);
    assert.equal(players[0].playCalls, 2);
});

test("following preview page bridge keeps the native CorePlayer host mounted", async () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/");
    const { document } = dom.window;
    const players = [];
    const fromJsonCalls = [];

    class FakeCorePlayer extends dom.window.HTMLElement {
        constructor() {
            super();
            this.attachShadow({ mode: "open" });
            this.shadowRoot.appendChild(document.createElement("video"));
            this.readyState = 1;
            this.playCalls = 0;
            players.push(this);
        }

        play() {
            this.playCalls += 1;
            return Promise.resolve();
        }
    }

    dom.window.customElements.define("better-chzzk-fake-player", FakeCorePlayer);

    const fakePlayerRuntime = {
        CorePlayer: FakeCorePlayer,
        LiveProvider: {
            fromJSON(playback, options) {
                fromJsonCalls.push({ options, playback });
                return { options, playback };
            },
        },
    };
    installWebpackPlayerRuntime(dom, () => fakePlayerRuntime);
    evalRepoScript(dom, "features", "followingPreviewPage.js");

    const mount = document.createElement("div");
    mount.setAttribute("data-bcfp-player-mount", "native-shadow");
    document.body.appendChild(mount);
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:following-preview:play", {
            detail: JSON.stringify({
                mountId: "native-shadow",
                playbackJson: JSON.stringify({ media: [{ mediaId: "HLS", path: "native-shadow.m3u8" }] }),
                requestId: "native-shadow",
            }),
        })
    );
    await waitForAsyncCallbacks();

    assert.equal(players.length, 1);
    assert.equal(mount.getAttribute("data-bcfp-player-state"), "ready");
    assert.equal(mount.firstElementChild, players[0]);
    assert.ok(players[0].shadowRoot.querySelector("video"));
    assert.equal(fromJsonCalls.length, 1);
    assert.equal(players[0].playCalls, 1);
});

test("following preview page bridge retries after the player runtime becomes available", async () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/");
    const { document } = dom.window;
    const players = [];
    const fromJsonCalls = [];
    let runtimeAvailable = false;

    class FakeCorePlayer extends dom.window.EventTarget {
        constructor() {
            super();
            this.shadowRoot = document.createElement("div");
            this.shadowRoot.className = "fake-core-player";
            this.readyState = 1;
            this.playCalls = 0;
            players.push(this);
        }

        play() {
            this.playCalls += 1;
            return Promise.resolve();
        }
    }

    const fakePlayerRuntime = {
        CorePlayer: FakeCorePlayer,
        LiveProvider: {
            fromJSON(playback, options) {
                fromJsonCalls.push({ options, playback });
                return { options, playback };
            },
        },
    };
    installWebpackPlayerRuntime(dom, () => (runtimeAvailable ? fakePlayerRuntime : null));
    evalRepoScript(dom, "features", "followingPreviewPage.js");

    const failedMount = document.createElement("div");
    failedMount.setAttribute("data-bcfp-player-mount", "runtime-missing");
    document.body.appendChild(failedMount);
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:following-preview:play", {
            detail: JSON.stringify({
                mountId: "runtime-missing",
                playbackJson: JSON.stringify({ media: [{ mediaId: "HLS", path: "missing.m3u8" }] }),
                requestId: "runtime-missing",
            }),
        })
    );
    await waitForAsyncCallbacks();

    assert.equal(failedMount.getAttribute("data-bcfp-player-state"), "error");
    assert.equal(players.length, 0);

    runtimeAvailable = true;
    const retryMount = document.createElement("div");
    retryMount.setAttribute("data-bcfp-player-mount", "runtime-ready");
    document.body.appendChild(retryMount);
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:following-preview:play", {
            detail: JSON.stringify({
                mountId: "runtime-ready",
                playbackJson: JSON.stringify({ media: [{ mediaId: "HLS", path: "ready.m3u8" }] }),
                requestId: "runtime-ready",
            }),
        })
    );
    await waitForAsyncCallbacks();

    assert.equal(players.length, 1);
    assert.equal(retryMount.getAttribute("data-bcfp-player-state"), "ready");
    assert.equal(retryMount.firstElementChild.className, "fake-core-player");
    assert.equal(fromJsonCalls.length, 1);
    assert.equal(players[0].playCalls, 1);
});

test("following preview page bridge uses the current CHZZK ESM player vendor", async () => {
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<html>",
            "<head>",
            '<script type="module" src="https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-test.js"></script>',
            "</head>",
            "<body></body>",
            "</html>",
        ].join(""),
        "https://chzzk.naver.com/"
    );
    const { document } = dom.window;
    const players = [];
    const fromJsonCalls = [];
    const fetchCalls = [];
    const importCalls = [];

    class FakeCorePlayer extends dom.window.EventTarget {
        constructor() {
            super();
            this.shadowRoot = document.createElement("div");
            this.shadowRoot.className = "fake-esm-player";
            this.readyState = 1;
            this.playCalls = 0;
            players.push(this);
        }

        play() {
            this.playCalls += 1;
            return Promise.resolve();
        }
    }

    const fakePlayerRuntime = {
        CorePlayer: FakeCorePlayer,
        LiveProvider: {
            fromJSON(playback, options) {
                fromJsonCalls.push({ options, playback });
                return { options, playback };
            },
        },
    };

    dom.window.fetch = async (url, init) => {
        fetchCalls.push({ init, url });
        return {
            ok: true,
            text: async () => 'import{x as playerFactory}from"./player-vendor-test.js";',
        };
    };
    dom.window.__betterChzzkFollowingPreviewImport = async (url) => {
        importCalls.push(url);
        return { x: () => fakePlayerRuntime };
    };

    evalRepoScript(dom, "features", "followingPreviewPage.js");

    const mount = document.createElement("div");
    mount.setAttribute("data-bcfp-player-mount", "esm-runtime");
    document.body.appendChild(mount);
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:following-preview:play", {
            detail: JSON.stringify({
                mountId: "esm-runtime",
                playbackJson: JSON.stringify({ media: [{ mediaId: "HLS", path: "esm.m3u8" }] }),
                requestId: "esm-runtime",
            }),
        })
    );
    await waitForAsyncCallbacks();

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-test.js");
    assert.equal(fetchCalls[0].init.credentials, "omit");
    assert.deepEqual(importCalls, [
        "https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/player-vendor-test.js",
    ]);
    assert.equal(players.length, 1);
    assert.equal(mount.getAttribute("data-bcfp-player-state"), "ready");
    assert.equal(mount.firstElementChild.className, "fake-esm-player");
    assert.equal(fromJsonCalls.length, 1);
    assert.equal(Object.hasOwn(fromJsonCalls[0].options, "mediaType"), false);
    assert.equal(Object.hasOwn(fromJsonCalls[0].options, "track"), false);
    assert.equal(players[0].playCalls, 1);
});

test("following preview page bridge handles AES HLS license requests", async () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/");
    const { document } = dom.window;
    const players = [];
    const keySystemCalls = [];
    const setMediaKeysCalls = [];
    const sessionTypes = [];
    const generateRequests = [];
    const licenseFetches = [];
    const licenseUpdates = [];

    dom.window.TextDecoder = TextDecoder;
    dom.window.TextEncoder = TextEncoder;
    dom.window.fetch = async (url, init) => {
        licenseFetches.push({ init, url });
        return {
            arrayBuffer: async () => new ArrayBuffer(4),
        };
    };

    const fakeSession = new dom.window.EventTarget();
    fakeSession.generateRequest = async (initDataType, initData) => {
        generateRequests.push({ initData, initDataType });
        const messageEvent = new dom.window.Event("message");
        Object.defineProperties(messageEvent, {
            message: {
                value: new TextEncoder().encode(JSON.stringify({ method: "POST", url: "https://license.example/key" })),
            },
            messageType: { value: "license-request" },
        });
        fakeSession.dispatchEvent(messageEvent);
    };
    fakeSession.update = async (buffer) => {
        licenseUpdates.push(buffer.byteLength);
    };

    const fakeMediaKeys = {
        createSession(type) {
            sessionTypes.push(type);
            return fakeSession;
        },
    };

    class FakeCorePlayer extends dom.window.EventTarget {
        static async requestMediaKeySystemAccess(keySystem, supportedConfigurations) {
            keySystemCalls.push({ keySystem, supportedConfigurations });
            return {
                createMediaKeys: async () => fakeMediaKeys,
            };
        }

        constructor() {
            super();
            this.shadowRoot = document.createElement("div");
            this.shadowRoot.className = "fake-core-player";
            this.readyState = 1;
            this.playCalls = 0;
            players.push(this);
        }

        setMediaKeys(mediaKeys) {
            setMediaKeysCalls.push(mediaKeys);
            return Promise.resolve();
        }

        play() {
            this.playCalls += 1;
            return Promise.resolve();
        }
    }

    const fakePlayerRuntime = {
        CorePlayer: FakeCorePlayer,
        LiveProvider: {
            fromJSON(playback, options) {
                return { options, playback };
            },
        },
    };
    installWebpackPlayerRuntime(dom, () => fakePlayerRuntime);
    evalRepoScript(dom, "features", "followingPreviewPage.js");

    const mount = document.createElement("div");
    mount.setAttribute("data-bcfp-player-mount", "encrypted");
    document.body.appendChild(mount);
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:following-preview:play", {
            detail: JSON.stringify({
                mountId: "encrypted",
                playbackJson: JSON.stringify({ media: [{ mediaId: "HLS", path: "encrypted.m3u8" }] }),
                requestId: "encrypted",
            }),
        })
    );
    await waitForAsyncCallbacks();

    const encryptedEvent = new dom.window.Event("encrypted");
    const initData = new Uint8Array([1, 2, 3]).buffer;
    Object.defineProperties(encryptedEvent, {
        initData: { value: initData },
        initDataType: { value: "aes-encrypted-hls" },
    });
    players[0].dispatchEvent(encryptedEvent);
    await waitForAsyncCallbacks();

    assert.equal(keySystemCalls.length, 1);
    assert.equal(keySystemCalls[0].keySystem, "com.naver.hlsaes");
    assert.deepEqual(Array.from(keySystemCalls[0].supportedConfigurations[0].initDataTypes), ["aes-encrypted-hls"]);
    assert.equal(
        keySystemCalls[0].supportedConfigurations[0].videoCapabilities[0].contentType,
        "application/x-mpegURL"
    );
    assert.equal(setMediaKeysCalls[0], fakeMediaKeys);
    assert.deepEqual(sessionTypes, ["temporary"]);
    assert.equal(generateRequests[0].initDataType, "aes-encrypted-hls");
    assert.deepEqual([...new Uint8Array(generateRequests[0].initData)], [1, 2, 3]);
    assert.equal(licenseFetches[0].url, "https://license.example/key");
    assert.equal(licenseFetches[0].init.method, "POST");
    assert.equal(licenseFetches[0].init.credentials, "include");
    assert.deepEqual(licenseUpdates, [4]);
});

test("following preview page bridge uses CHZZK player runtime instead of a live page frame", () => {
    const source = readRepoFile("features", "followingPreviewPage.js");

    assert.match(source, /LiveProvider\.fromJSON/);
    assert.match(source, /CorePlayer/);
    assert.match(source, /requestMediaKeySystemAccess/);
    assert.match(source, /player-vendor/i);
    assert.doesNotMatch(source, /\/live\/\$\{encodeURIComponent\(channelId\)\}\/simple/);
    assert.doesNotMatch(source, /createElement\("iframe"\)/);
    assert.doesNotMatch(source, /playMutedPreview/);
    assert.doesNotMatch(source, new RegExp(`src${"doc"}`));
    assert.doesNotMatch(source, /\beval\s*\(/);
    assert.doesNotMatch(source, new RegExp(`\\bnew\\s+${"Function"}\\b`));
    assert.doesNotMatch(source, /mediaType:\s*["']PREVIEW["']/);
    assert.doesNotMatch(source, /track:\s*360/);
});

test("following preview page bridge ignores stale stop requests", async () => {
    const { document, dom } = createFollowingPreviewPlayerDom();
    const playbackJson = JSON.stringify({
        media: [{ mediaId: "HLS", path: "https://example.com/live.m3u8" }],
    });

    evalRepoScript(dom, "features", "followingPreviewPage.js");

    const mount = document.createElement("div");
    mount.setAttribute("data-bcfp-player-mount", "active");
    document.body.appendChild(mount);
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:following-preview:play", {
            detail: JSON.stringify({
                mountId: "active",
                playbackJson,
                requestId: "active",
            }),
        })
    );
    await waitForAsyncCallbacks();

    assert.ok(mount.querySelector("video"));
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:following-preview:stop", {
            detail: JSON.stringify({ requestId: "stale" }),
        })
    );
    await waitForAsyncCallbacks();

    assert.ok(mount.querySelector("video"));
    assert.equal(mount.getAttribute("data-bcfp-player-state"), "loading");

    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:following-preview:stop", {
            detail: JSON.stringify({ requestId: "active" }),
        })
    );
    await waitForAsyncCallbacks();

    assert.equal(mount.childElementCount, 0);
    assert.equal(mount.getAttribute("data-bcfp-player-state"), "idle");
});

test("following preview delays live-detail fetches while opening the DOM fallback immediately", async () => {
    const chrome = createFakeChrome();
    const { document, dom, item, link } = createFollowingPreviewDom(chrome);
    const calls = [];

    dom.window.fetch = (url, init) => {
        calls.push({ init, url });
        return new Promise(() => {});
    };

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));

    let tip = document.getElementById("betterchzzk-following-preview");
    assert.ok(tip);
    assert.equal(tip.getAttribute("data-show"), "1");
    assert.equal(tip.dataset.state, "loading");
    assert.equal(tip.querySelector(".bcfp-title").textContent, "DOM \uBC29\uC1A1 \uC81C\uBAA9");
    assert.equal(item.getAttribute("data-bcfp-active"), "1");
    assert.equal(calls.length, 0);

    link.dispatchEvent(new dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    await waitForFollowingPreviewFetchDelay();
    await waitForAsyncCallbacks();

    assert.equal(calls.length, 0);
    assert.equal(tip.hasAttribute("data-show"), false);
    assert.equal(item.hasAttribute("data-bcfp-active"), false);

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    tip = document.getElementById("betterchzzk-following-preview");
    assert.ok(tip);
    assert.equal(calls.length, 0);

    await waitForFollowingPreviewFetchDelay();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.chzzk.naver.com/service/v2/channels/channel-123/live-detail");
    assert.equal(calls[0].init.signal.aborted, false);
});

test("following preview loading card prefers live thumbnails over channel profile images", async () => {
    const chrome = createFakeChrome();
    const { document, dom, link } = createFollowingPreviewDom(chrome);
    const profileImage = link.querySelector("img");
    const liveThumbnail = document.createElement("img");

    profileImage.className = "channel_profile_image";
    profileImage.src = "https://example.com/channel-profile.jpg";
    liveThumbnail.className = "live_thumbnail_image";
    liveThumbnail.src = "https://example.com/live-thumbnail.jpg";
    link.insertBefore(liveThumbnail, link.querySelector(".name_text"));
    dom.window.fetch = () => new Promise(() => {});

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForAsyncCallbacks();

    const tip = document.getElementById("betterchzzk-following-preview");
    assert.ok(tip);
    assert.equal(tip.dataset.state, "loading");
    assert.match(tip.querySelector(".bcfp-media img").getAttribute("src"), /live-thumbnail\.jpg/);
    assert.doesNotMatch(tip.querySelector(".bcfp-media img").getAttribute("src"), /channel-profile\.jpg/);
});

test("following preview waits for stored options before handling hover", async () => {
    const chrome = createFakeChrome();
    const { document, dom, link } = createFollowingPreviewDom(chrome);

    dom.window.fetch = () => new Promise(() => {});

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    assert.equal(document.getElementById("betterchzzk-following-preview"), null);

    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();

    const tip = document.getElementById("betterchzzk-following-preview");
    assert.ok(tip);
    assert.equal(tip.getAttribute("data-show"), "1");

    link.dispatchEvent(new dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
});

test("following preview loading card does not enlarge channel profile images as thumbnails", async () => {
    const chrome = createFakeChrome();
    const { document, dom, link } = createFollowingPreviewDom(chrome);
    const profileImage = link.querySelector("img");

    profileImage.className = "channel_profile_image";
    profileImage.src = "https://example.com/channel-profile.jpg";
    dom.window.fetch = () => new Promise(() => {});

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForAsyncCallbacks();

    const tip = document.getElementById("betterchzzk-following-preview");
    assert.ok(tip);
    assert.equal(tip.dataset.state, "loading");
    assert.equal(tip.querySelector(".bcfp-media img"), null);
    assert.equal(tip.querySelector(".bcfp-media-fallback").textContent, "LIVE");
});

test("following preview loading card does not use verified badges as thumbnails", async () => {
    const chrome = createFakeChrome();
    const { document, dom, link } = createFollowingPreviewDom(chrome);
    const profileImage = link.querySelector("img");
    const verifiedBadge = document.createElement("img");

    profileImage.className = "channel_profile_image";
    profileImage.src = "https://example.com/channel-profile.jpg";
    verifiedBadge.className = "verified_mark_image";
    verifiedBadge.alt = "\uCE58\uC9C0\uC9C1 \uC778\uC99D";
    verifiedBadge.src = "https://example.com/verified-badge.svg";
    link.insertBefore(verifiedBadge, link.querySelector(".live_title"));
    dom.window.fetch = () => new Promise(() => {});

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForAsyncCallbacks();

    const tip = document.getElementById("betterchzzk-following-preview");
    assert.ok(tip);
    assert.equal(tip.dataset.state, "loading");
    assert.equal(tip.querySelector(".bcfp-media img"), null);
    assert.equal(tip.querySelector(".bcfp-media-fallback").textContent, "LIVE");
    assert.doesNotMatch(tip.textContent, /verified-badge/);
});

test("following preview tooltip plays live in the hover card and reuses cache", async () => {
    const chrome = createFakeChrome();
    const { document, dom, item, link } = createFollowingPreviewDom(chrome);
    const calls = [];
    let now = Date.parse("2026-06-23T03:02:03Z");
    let resolveFetch;
    const playbackJson = JSON.stringify({
        media: [{ mediaId: "HLS", path: "https://example.com/live.m3u8" }],
    });
    const playerEvents = [];

    dom.window.Date.now = () => now;
    dom.window.addEventListener("betterchzzk:following-preview:play", (event) => {
        playerEvents.push({ detail: JSON.parse(event.detail), type: event.type });
    });
    dom.window.addEventListener("betterchzzk:following-preview:stop", (event) => {
        playerEvents.push({ detail: JSON.parse(event.detail), type: event.type });
    });
    dom.window.fetch = (url, init) => {
        calls.push({ init, url });
        return new Promise((resolve) => {
            resolveFetch = () =>
                resolve({
                    ok: true,
                    json: async () => ({
                        content: {
                            liveTitle: "API \uBC29\uC1A1 \uC81C\uBAA9",
                            liveImageUrl: "https://example.com/live-{type}.jpg",
                            liveCategoryValue: "\uAC8C\uC784",
                            concurrentUserCount: 1234,
                            openDate: new Date(now - (3600 + 120 + 3) * 1000).toISOString(),
                            livePlaybackJson: playbackJson,
                            channel: {
                                channelName: "API \uCC44\uB110",
                            },
                        },
                    }),
                });
        });
    };

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForAsyncCallbacks();

    let tip = document.getElementById("betterchzzk-following-preview");
    assert.ok(tip);
    assert.equal(tip.getAttribute("data-show"), "1");
    assert.equal(tip.dataset.state, "loading");
    assert.equal(tip.querySelector(".bcfp-title").textContent, "DOM \uBC29\uC1A1 \uC81C\uBAA9");
    assert.equal(tip.querySelector("iframe.bcfp-player"), null);
    assert.equal(tip.querySelector(".bcfp-live"), null);
    assert.match(tip.querySelector(".bcfp-media img").getAttribute("src"), /dom-thumb\.jpg/);
    const source = readRepoFile("features", "followingPreviewTooltip.js");
    const pageSource = readRepoFile("features", "followingPreviewPage.js");
    assert.match(source, /livePlaybackJson/);
    assert.doesNotMatch(source, /previewPlaybackJson/);
    assert.match(source, /HOVER_OPEN_DELAY_MS = 0/);
    assert.match(source, /PLAYER_START_SETTLE_MS = 90/);
    assert.match(source, /betterchzzk:following-preview:play/);
    assert.match(source, /font-family:system-ui/);
    assert.doesNotMatch(source, /font-family:inherit/);
    assert.doesNotMatch(source, new RegExp(`src${"doc"}`));
    assert.doesNotMatch(source, /bcfp-live/);
    assert.match(source, /PREVIEW_FETCH_DELAY_MS = 100/);
    assert.match(pageSource, /LiveProvider\.fromJSON/);
    assert.match(pageSource, /CorePlayer/);
    assert.match(pageSource, /requestMediaKeySystemAccess/);
    assert.match(pageSource, /player-vendor/i);
    assert.match(pageSource, /\bimport\s*\(/);
    assert.doesNotMatch(pageSource, /\/live\/\$\{encodeURIComponent\(channelId\)\}\/simple/);
    assert.doesNotMatch(pageSource, /createElement\("iframe"\)/);
    assert.doesNotMatch(pageSource, /playMutedPreview/);
    assert.doesNotMatch(pageSource, /mediaType:\s*["']PREVIEW["']/);
    assert.doesNotMatch(pageSource, /track:\s*360/);
    assert.doesNotMatch(pageSource, /ssl\.pstatic\.net/);
    assert.doesNotMatch(pageSource, new RegExp(`src${"doc"}`));
    assert.doesNotMatch(pageSource, /\beval\s*\(/);
    assert.doesNotMatch(pageSource, new RegExp(`\\bnew\\s+${"Function"}\\b`));
    assert.doesNotMatch(source, /betterchzzkPreview/);
    assert.equal(item.getAttribute("data-bcfp-active"), "1");
    assert.equal(calls.length, 0);

    await waitForFollowingPreviewFetchDelay();
    assert.equal(calls.length, 1);
    resolveFetch();
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();

    tip = document.getElementById("betterchzzk-following-preview");
    assert.equal(tip.dataset.state, "ready");
    assert.equal(tip.querySelector(".bcfp-channel").textContent, "API \uCC44\uB110");
    assert.equal(tip.querySelector(".bcfp-title").textContent, "API \uBC29\uC1A1 \uC81C\uBAA9");
    assert.equal(tip.querySelector(".bcfp-live"), null);
    assert.match(tip.textContent, /\uAC8C\uC784/);
    assert.doesNotMatch(tip.textContent, /1,234\uBA85/);
    assert.doesNotMatch(tip.querySelector(".bcfp-meta").textContent, /\uBC29\uC1A1|\uBD84\uC9F8|\uBA85/);
    assert.deepEqual(
        Array.from(tip.querySelectorAll(".bcfp-meta span"), (span) => span.textContent),
        ["\uAC8C\uC784", "01:02:03"]
    );
    assert.match(tip.querySelector("[data-bcfp-elapsed='1']").textContent, /^\d{2}:\d{2}:\d{2}$/);
    const playerMount = tip.querySelector(".bcfp-player");
    assert.ok(playerMount);
    assert.equal(playerMount.tagName, "DIV");
    assert.match(playerMount.getAttribute("data-bcfp-player-mount"), /^bcfp/);
    assert.equal(playerMount.getAttribute("data-bcfp-player-state"), "loading");
    assert.equal(tip.querySelector("iframe.bcfp-player"), null);
    assert.equal(tip.querySelector(".bcfp-sound"), null);
    assert.equal(playerEvents.length, 0);

    await waitForFollowingPlayerSettle();

    assert.equal(playerEvents.length, 1);
    assert.equal(playerEvents[0].type, "betterchzzk:following-preview:play");
    assert.equal(playerEvents[0].detail.channelId, "channel-123");
    assert.equal(playerEvents[0].detail.mountId, playerMount.getAttribute("data-bcfp-player-mount"));
    assert.equal(playerEvents[0].detail.muted, false);
    assert.equal(playerEvents[0].detail.playbackJson, playbackJson);
    assert.equal(playerEvents[0].detail.volume, 0.2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.chzzk.naver.com/service/v2/channels/channel-123/live-detail");
    assert.equal(calls[0].init.credentials, "include");

    now += 2000;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(tip.querySelector("[data-bcfp-elapsed='1']").textContent, "01:02:05");

    link.dispatchEvent(new dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: playerMount }));
    assert.equal(tip.getAttribute("data-show"), "1");

    tip.dispatchEvent(new dom.window.MouseEvent("pointerleave", { bubbles: false, relatedTarget: document.body }));
    assert.equal(tip.hasAttribute("data-show"), false);
    assert.equal(tip.querySelector("iframe.bcfp-player"), null);
    assert.equal(item.hasAttribute("data-bcfp-active"), false);
    assert.equal(playerEvents.at(-1).type, "betterchzzk:following-preview:stop");

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForAsyncCallbacks();

    tip = document.getElementById("betterchzzk-following-preview");
    assert.equal(tip.getAttribute("data-show"), "1");
    assert.equal(tip.dataset.state, "ready");
    assert.equal(calls.length, 1);
    await waitForFollowingPlayerSettle();
    assert.equal(playerEvents.filter((event) => event.type === "betterchzzk:following-preview:play").length, 2);

    link.dispatchEvent(new dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    assert.equal(tip.hasAttribute("data-show"), false);
    assert.equal(tip.querySelector("iframe.bcfp-player"), null);
    assert.equal(item.hasAttribute("data-bcfp-active"), false);
});

test("following preview tooltip requests audible playback", async () => {
    const chrome = createFakeChrome();
    const { document, dom, link } = createFollowingPreviewDom(chrome);
    const playbackJson = JSON.stringify({
        media: [{ mediaId: "HLS", path: "https://example.com/live-audio.m3u8" }],
    });
    const playerEvents = [];

    dom.window.addEventListener("betterchzzk:following-preview:play", (event) => {
        playerEvents.push({ detail: JSON.parse(event.detail), type: event.type });
    });
    dom.window.fetch = async () => ({
        ok: true,
        json: async () => ({
            content: {
                liveTitle: "API \uBC29\uC1A1 \uC81C\uBAA9",
                liveImageUrl: "https://example.com/live-{type}.jpg",
                liveCategoryValue: "\uAC8C\uC784",
                openDate: new Date(Date.now() - 60 * 1000).toISOString(),
                livePlaybackJson: playbackJson,
                channel: {
                    channelName: "API \uCC44\uB110",
                },
            },
        }),
    });

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForFollowingPreviewFetchDelay();
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();

    const tip = document.getElementById("betterchzzk-following-preview");
    const playerMount = tip.querySelector(".bcfp-player");

    assert.equal(tip.querySelector(".bcfp-sound"), null);
    assert.ok(playerMount);
    assert.doesNotMatch(playerMount.title, /\//);
    await waitForFollowingPlayerSettle();

    const playEvent = playerEvents.find((event) => event.type === "betterchzzk:following-preview:play");
    assert.ok(playEvent);
    assert.equal(playEvent.detail.channelId, "channel-123");
    assert.equal(playEvent.detail.mountId, playerMount.getAttribute("data-bcfp-player-mount"));
    assert.equal(playEvent.detail.muted, false);
    assert.equal(playEvent.detail.playbackJson, playbackJson);
    assert.equal(playEvent.detail.volume, 0.2);

    tip.dispatchEvent(new dom.window.MouseEvent("pointerleave", { bubbles: false, relatedTarget: document.body }));
});

test("following preview tooltip ignores stale stored audio off", async () => {
    const chrome = createFakeChrome({
        sync: {
            followingPreviewAudioEnabled: false,
            followingPreviewAudioVolume: 30,
        },
    });
    const { document, dom, link } = createFollowingPreviewDom(chrome);
    const playbackJson = JSON.stringify({
        media: [{ mediaId: "HLS", path: "https://example.com/live-muted.m3u8" }],
    });
    const playerEvents = [];

    dom.window.addEventListener("betterchzzk:following-preview:play", (event) => {
        playerEvents.push({ detail: JSON.parse(event.detail), type: event.type });
    });
    dom.window.fetch = async () => ({
        ok: true,
        json: async () => ({
            content: {
                liveTitle: "API \uBC29\uC1A1 \uC81C\uBAA9",
                liveImageUrl: "https://example.com/live-{type}.jpg",
                liveCategoryValue: "\uAC8C\uC784",
                openDate: new Date(Date.now() - 60 * 1000).toISOString(),
                livePlaybackJson: playbackJson,
                channel: {
                    channelName: "API \uCC44\uB110",
                },
            },
        }),
    });

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForFollowingPreviewFetchDelay();
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();
    await waitForFollowingPlayerSettle();

    const playEvent = playerEvents.find((event) => event.type === "betterchzzk:following-preview:play");
    assert.ok(playEvent);
    assert.equal(playEvent.detail.muted, false);
    assert.equal(playEvent.detail.volume, 0.2);

    document
        .getElementById("betterchzzk-following-preview")
        ?.dispatchEvent(new dom.window.MouseEvent("pointerleave", { bubbles: false, relatedTarget: document.body }));
});

test("following preview tooltip does not create a player without live playback json", async () => {
    const chrome = createFakeChrome();
    const { document, dom, link } = createFollowingPreviewDom(chrome);
    const playerEvents = [];

    dom.window.addEventListener("betterchzzk:following-preview:play", (event) => {
        playerEvents.push({ detail: JSON.parse(event.detail), type: event.type });
    });
    dom.window.fetch = async () => ({
        ok: true,
        json: async () => ({
            content: {
                liveId: "live-123",
                liveTitle: "API \uBC29\uC1A1 \uC81C\uBAA9",
                liveImageUrl: "https://example.com/live-{type}.jpg",
                liveCategoryValue: "\uAC8C\uC784",
                openDate: new Date(Date.now() - 60 * 1000).toISOString(),
                channel: {
                    channelName: "API \uCC44\uB110",
                },
            },
        }),
    });

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForFollowingPreviewFetchDelay();
    await waitForAsyncCallbacks();
    await waitForFollowingPlayerSettle();

    const tip = document.getElementById("betterchzzk-following-preview");
    const playerMount = tip.querySelector(".bcfp-player");
    const playEvent = playerEvents.find((event) => event.type === "betterchzzk:following-preview:play");

    tip.dispatchEvent(new dom.window.MouseEvent("pointerleave", { bubbles: false, relatedTarget: document.body }));

    assert.equal(playerMount, null);
    assert.equal(playEvent, undefined);
});

test("following preview aborts stale live-detail requests during rapid hover", async () => {
    const chrome = createFakeChrome();
    const { document, dom, link } = createFollowingPreviewDom(chrome);
    const ul = document.querySelector("#following ul");
    const secondItem = document.createElement("li");
    secondItem.className = "following_item";
    secondItem.innerHTML = [
        '<a id="secondLiveLink" href="/live/channel-456" aria-label="\uB450 \uBC88\uC9F8 \uCC44\uB110">',
        '<img src="https://example.com/second-thumb.jpg" alt="">',
        '<span class="name_text">\uB450 \uBC88\uC9F8 \uCC44\uB110</span>',
        '<span class="live_title">\uB450 \uBC88\uC9F8 \uBC29\uC1A1</span>',
        "</a>",
    ].join("");
    ul.appendChild(secondItem);

    const secondLink = document.getElementById("secondLiveLink");
    secondItem.getBoundingClientRect = () => ({
        left: 12,
        top: 136,
        right: 196,
        bottom: 188,
        width: 184,
        height: 52,
    });
    secondLink.getBoundingClientRect = secondItem.getBoundingClientRect;

    const calls = [];
    dom.window.fetch = (url, init) => {
        calls.push({ signal: init.signal, url });
        return new Promise((resolve, reject) => {
            init.signal.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
            });
        });
    };

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewFetchDelay();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, false);
    assert.match(calls[0].url, /channel-123/);

    link.dispatchEvent(new dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: secondLink }));
    secondLink.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewFetchDelay();

    assert.equal(calls.length, 2);
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls[1].signal.aborted, false);
    assert.match(calls[1].url, /channel-456/);
    assert.equal(
        document.querySelector("#betterchzzk-following-preview[data-show='1'] .bcfp-title").textContent,
        "\uB450 \uBC88\uC9F8 \uBC29\uC1A1"
    );

    secondLink.dispatchEvent(new dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    await waitForAsyncCallbacks();
    assert.equal(calls[1].signal.aborted, true);
});

test("following preview tooltip ignores live links outside the following sidebar", async () => {
    const chrome = createFakeChrome();
    const { document, dom } = createFollowingPreviewDom(chrome);
    const mainLiveLink = document.getElementById("mainLiveLink");
    let fetchCount = 0;

    dom.window.fetch = async () => {
        fetchCount += 1;
        throw new Error("main live cards should not request following preview data");
    };

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    mainLiveLink.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForAsyncCallbacks();

    assert.equal(fetchCount, 0);
    assert.equal(document.getElementById("betterchzzk-following-preview"), null);
});

test("following preview tooltip removes listeners and UI when the option is disabled", async () => {
    const chrome = createFakeChrome();
    const { document, dom, item, link } = createFollowingPreviewDom(chrome);

    dom.window.fetch = async () => ({
        ok: true,
        json: async () => ({
            content: {
                liveTitle: "\uC635\uC158 \uD14C\uC2A4\uD2B8 \uC81C\uBAA9",
                channel: { channelName: "\uC635\uC158 \uD14C\uC2A4\uD2B8" },
            },
        }),
    });

    evalFollowingPreviewTooltipScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForAsyncCallbacks();

    assert.ok(document.querySelector("#betterchzzk-following-preview[data-show='1']"));
    assert.equal(item.getAttribute("data-bcfp-active"), "1");

    for (const listener of [...chrome.testState.storageChangeListeners]) {
        listener({ followingPreviewTooltipEnabled: { newValue: false } }, "sync");
    }
    await waitForAsyncCallbacks();

    assert.equal(document.getElementById("betterchzzk-following-preview"), null);
    assert.equal(document.getElementById("betterchzzk-following-preview-style"), null);
    assert.equal(item.hasAttribute("data-bcfp-active"), false);

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForAsyncCallbacks();

    assert.equal(document.getElementById("betterchzzk-following-preview"), null);
});
