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

function waitForFollowingPlayerSettle() {
    return new Promise((resolve) => setTimeout(resolve, 120));
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
            '<img src="https://example.com/dom-thumb.jpg" alt="">',
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
    assert.ok(mainScript.js.indexOf("features/followingPreviewPage.js") > mainScript.js.indexOf("features/routeBridgePage.js"));
    assert.ok(mainScript.js.indexOf("features/followingPreviewPage.js") < mainScript.js.indexOf("features/autoQualityPage.js"));
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

test("following preview page bridge reuses the main-world CHZZK player", async () => {
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

    dom.window.webpackChunkglive_fe_pc = [];
    dom.window.webpackChunkglive_fe_pc.push = (chunk) => {
        const modules = chunk[1] || {};
        const runtime = chunk[2];
        const cache = {
            49588: { exports: fakePlayerRuntime },
        };
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

    evalRepoScript(dom, "features", "followingPreviewPage.js");

    const firstMount = document.createElement("div");
    firstMount.setAttribute("data-bcfp-player-mount", "first");
    document.body.appendChild(firstMount);
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:following-preview:play", {
            detail: JSON.stringify({
                mountId: "first",
                playbackJson: JSON.stringify({ media: [{ mediaId: "HLS", path: "first.m3u8" }] }),
                requestId: "first",
            }),
        })
    );
    await waitForAsyncCallbacks();

    assert.equal(players.length, 1);
    assert.equal(firstMount.getAttribute("data-bcfp-player-state"), "ready");
    assert.equal(firstMount.firstElementChild.className, "fake-core-player");
    assert.equal(fromJsonCalls.length, 1);
    assert.equal(fromJsonCalls[0].options.serviceId, 2099);
    assert.equal(fromJsonCalls[0].options.maxLevel, 480);
    assert.equal(fromJsonCalls[0].options.mediaType, "PREVIEW");

    const secondMount = document.createElement("div");
    secondMount.setAttribute("data-bcfp-player-mount", "second");
    document.body.appendChild(secondMount);
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:following-preview:play", {
            detail: JSON.stringify({
                mountId: "second",
                playbackJson: JSON.stringify({ media: [{ mediaId: "HLS", path: "second.m3u8" }] }),
                requestId: "second",
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

    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:following-preview:stop", {
            detail: JSON.stringify({ requestId: "second" }),
        })
    );
    await waitForAsyncCallbacks();

    assert.equal(secondMount.childElementCount, 0);
    assert.equal(secondMount.getAttribute("data-bcfp-player-state"), "idle");
    assert.equal(players[0].src, "");
    assert.equal(players[0].srcObject, null);
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
            resolveFetch = () => resolve({
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
    assert.match(source, /previewPlaybackJson/);
    assert.match(source, /HOVER_OPEN_DELAY_MS = 0/);
    assert.match(source, /PLAYER_START_SETTLE_MS = 90/);
    assert.match(source, /betterchzzk:following-preview:play/);
    assert.match(source, /font-family:system-ui/);
    assert.doesNotMatch(source, /font-family:inherit/);
    assert.doesNotMatch(source, /srcdoc/);
    assert.doesNotMatch(source, /bcfp-live/);
    assert.match(pageSource, /LiveProvider\.fromJSON/);
    assert.match(pageSource, /webpackChunkglive_fe_pc/);
    assert.match(pageSource, /serviceId: 2099/);
    assert.doesNotMatch(source, /betterchzzkPreview/);
    assert.equal(item.getAttribute("data-bcfp-active"), "1");

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
    assert.equal(playerEvents.length, 0);

    await waitForFollowingPlayerSettle();

    assert.equal(playerEvents.length, 1);
    assert.equal(playerEvents[0].type, "betterchzzk:following-preview:play");
    assert.equal(playerEvents[0].detail.mountId, playerMount.getAttribute("data-bcfp-player-mount"));
    assert.equal(playerEvents[0].detail.playbackJson, playbackJson);
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
    await waitForFollowingPreviewDelay();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, false);
    assert.match(calls[0].url, /channel-123/);

    link.dispatchEvent(new dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: secondLink }));
    secondLink.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();

    assert.equal(calls.length, 2);
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls[1].signal.aborted, false);
    assert.match(calls[1].url, /channel-456/);
    assert.equal(document.querySelector("#betterchzzk-following-preview[data-show='1'] .bcfp-title").textContent, "\uB450 \uBC88\uC9F8 \uBC29\uC1A1");

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
