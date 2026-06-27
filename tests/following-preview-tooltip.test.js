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
    return new Promise((resolve) => setTimeout(resolve, 320));
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
    const isolatedScript = manifest.content_scripts.find((entry) => !entry.world);

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

test("following preview tooltip renders a visual card from sidebar hover and reuses cache", async () => {
    const chrome = createFakeChrome();
    const { document, dom, item, link } = createFollowingPreviewDom(chrome);
    const calls = [];
    const now = Date.parse("2026-06-23T03:02:03Z");
    let resolveFetch;

    dom.window.Date.now = () => now;
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
    assert.match(tip.querySelector("img").getAttribute("src"), /dom-thumb\.jpg$/);
    assert.equal(item.getAttribute("data-bcfp-active"), "1");

    resolveFetch();
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();

    tip = document.getElementById("betterchzzk-following-preview");
    assert.equal(tip.dataset.state, "ready");
    assert.equal(tip.querySelector(".bcfp-channel").textContent, "API \uCC44\uB110");
    assert.equal(tip.querySelector(".bcfp-title").textContent, "API \uBC29\uC1A1 \uC81C\uBAA9");
    assert.match(tip.textContent, /\uAC8C\uC784/);
    assert.doesNotMatch(tip.textContent, /1,234\uBA85/);
    assert.doesNotMatch(tip.querySelector(".bcfp-meta").textContent, /\uBC29\uC1A1|\uBD84\uC9F8|\uBA85/);
    assert.deepEqual(
        Array.from(tip.querySelectorAll(".bcfp-meta span"), (span) => span.textContent),
        ["\uAC8C\uC784", "01:02:03"]
    );
    assert.match(tip.querySelector("img").getAttribute("src"), /live-480\.jpg$/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.chzzk.naver.com/service/v2/channels/channel-123/live-detail");
    assert.equal(calls[0].init.credentials, "include");

    link.dispatchEvent(new dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    assert.equal(tip.hasAttribute("data-show"), false);
    assert.equal(item.hasAttribute("data-bcfp-active"), false);

    link.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForFollowingPreviewDelay();
    await waitForAsyncCallbacks();

    tip = document.getElementById("betterchzzk-following-preview");
    assert.equal(tip.getAttribute("data-show"), "1");
    assert.equal(tip.dataset.state, "ready");
    assert.equal(calls.length, 1);
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
