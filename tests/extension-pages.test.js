const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

require("../shared/data.js");
require("../shared/watchHistoryStore.js");

const watchHistoryStore = globalThis.BetterChzzkWatchHistoryStore;

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
            if (Array.isArray(keys)) {
                for (const key of keys) {
                    if (Object.hasOwn(data, key)) result[key] = data[key];
                }
            } else if (typeof keys === "string") {
                if (Object.hasOwn(data, keys)) result[keys] = data[keys];
            } else if (keys && typeof keys === "object") {
                Object.assign(result, keys);
                for (const key of Object.keys(keys)) {
                    if (Object.hasOwn(data, key)) result[key] = data[key];
                }
            } else {
                Object.assign(result, data);
            }

            setTimeout(() => callback(result), 0);
        },
        set(values, callback) {
            Object.assign(data, values || {});
            setTimeout(() => callback?.(), 0);
        },
        remove(keys, callback) {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                delete data[key];
            }
            setTimeout(() => callback?.(), 0);
        },
    };
}

function createFakeChrome({ sync = {}, local = {}, permissionGranted = true } = {}) {
    const syncArea = createStorageArea(sync);
    const localArea = createStorageArea(local);
    const storageChangeListeners = [];
    const permissionRequests = [];
    const runtimeMessages = [];
    const runtime = {
        id: "better-chzzk",
        sendMessage(message, callback) {
            runtimeMessages.push(message);
            if (message?.type !== watchHistoryStore.MESSAGE_TYPE) {
                setTimeout(() => callback?.(), 0);
                return;
            }
            try {
                const current = localArea.data[watchHistoryStore.STORAGE_KEY];
                const outcome = watchHistoryStore.applyMutation(current, message.operation);
                if (outcome.changed) localArea.data[watchHistoryStore.STORAGE_KEY] = outcome.history;
                setTimeout(() => callback?.({ ok: true, result: outcome.result }), 0);
            } catch (error) {
                setTimeout(() => callback?.({ ok: false, error: error.message }), 0);
            }
        },
    };

    return {
        runtime,
        permissions: {
            request(spec, callback) {
                permissionRequests.push(spec);
                callback(permissionGranted);
            },
        },
        storage: {
            sync: syncArea,
            local: localArea,
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
            local: localArea.data,
            storageChangeListeners,
            permissionRequests,
            runtimeMessages,
        },
    };
}

function createDom(htmlFile, urlPath, chrome) {
    const dom = new JSDOM(readRepoFile(htmlFile), {
        url: `chrome-extension://better-chzzk/${urlPath}`,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });

    dom.window.chrome = chrome;
    dom.window.confirm = () => true;
    dom.window.fetch = async () => {
        throw new Error("Unexpected network request in page test");
    };

    return dom;
}

function createPageDom(html, url, chrome) {
    const dom = new JSDOM(html, {
        url,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });

    dom.window.chrome = chrome;
    dom.window.fetch = async () => {
        throw new Error("Unexpected network request in page test");
    };

    return dom;
}

function evalRepoScript(dom, ...parts) {
    dom.window.eval(readRepoFile(...parts));
}

function evalContentScripts(dom) {
    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "shared", "vodTimeline.js");
}

function dispatch(dom, element, type) {
    element.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
}

function queryOption(document, key) {
    return document.querySelector(`[data-option="${key}"]`);
}

function waitForAsyncCallbacks() {
    return new Promise((resolve) => setTimeout(resolve, 20));
}

function waitForTitleTooltipDelay() {
    return new Promise((resolve) => setTimeout(resolve, 190));
}

async function waitForCondition(predicate, { timeoutMs = 1000, intervalMs = 20 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    assert.fail("Timed out waiting for condition");
}

function captureIntervals(dom) {
    const intervals = [];

    dom.window.setInterval = (fn, ms) => {
        const id = intervals.length + 1;
        intervals.push({ id, fn, ms, cleared: false });
        return id;
    };
    dom.window.clearInterval = (id) => {
        const entry = intervals.find((interval) => interval.id === id);
        if (entry) entry.cleared = true;
    };

    return intervals;
}

function createTimeRanges(ranges) {
    return {
        length: ranges.length,
        start(index) {
            return ranges[index][0];
        },
        end(index) {
            return ranges[index][1];
        },
    };
}

function makeVisibleVideo(video) {
    video.getBoundingClientRect = () => ({
        width: 640,
        height: 360,
        left: 0,
        top: 0,
        right: 640,
        bottom: 360,
    });
}

function createAudioCompressorFixture({ withExternalCompressor = false } = {}) {
    const chrome = createFakeChrome({
        sync: {
            audioCompressorEnabled: true,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol">',
            '<button class="pzp-pc__volume-button" id="mute" type="button"></button>',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const volumeControl = document.getElementById("vol");
    const volumeButton = document.getElementById("mute");

    makeVisibleVideo(video);
    volumeControl.getBoundingClientRect = () => ({
        width: 96,
        height: 40,
        left: 20,
        top: 320,
        right: 116,
        bottom: 360,
    });
    volumeButton.getBoundingClientRect = () => ({
        width: 40,
        height: 40,
        left: 20,
        top: 320,
        right: 60,
        bottom: 360,
    });

    if (withExternalCompressor) {
        const external = document.createElement("div");
        external.className = "pzp-pc__volume-control knife-comp";
        volumeControl.insertAdjacentElement("afterend", external);
    }

    return { chrome, dom, document, volumeControl, volumeButton };
}

async function loadAudioCompressorFeature(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "volumeTooltip.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
}

function createVideoTrackList(tracks, selectedIndex = 0) {
    const trackList = {
        length: tracks.length,
        selectedIndex,
        item(index) {
            return this[index] || null;
        },
        addEventListener() {},
        removeEventListener() {},
    };

    tracks.forEach((track, index) => {
        track.selected = index === selectedIndex;
        trackList[index] = track;
    });

    return trackList;
}

function requestAutoQualityApply(dom, quality = "1080p") {
    const requestId = `test-${Date.now()}-${Math.random()}`;
    const { document } = dom.window;
    document.documentElement.setAttribute(
        "data-betterchzzk-auto-quality-request",
        JSON.stringify({ requestId, quality })
    );
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:auto-quality:apply"));
    return JSON.parse(document.documentElement.getAttribute("data-betterchzzk-auto-quality-result"));
}

function disableAutoQualityPage(dom) {
    dom.window.document.documentElement.setAttribute(
        "data-betterchzzk-auto-quality-state",
        JSON.stringify({ enabled: false, quality: "1080p" })
    );
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:auto-quality:state"));
}

function evalVolumeWheelScripts(dom) {
    evalRepoScript(dom, "features", "volumeWheelPage.js");
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "volumeWheel.js");
}

test("createMutationObserverSync observes a deferred target when it appears", async () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalContentScripts(dom);

    const { BetterChzzk, document } = dom.window;
    const events = [];
    let target = null;
    const observer = BetterChzzk.utils.createMutationObserverSync({
        target: () => target,
        schedule: () => events.push("scheduled"),
        onBodyReady: () => events.push("ready"),
    });

    target = document.createElement("div");
    document.body.appendChild(target);
    await waitForAsyncCallbacks();

    target.appendChild(document.createElement("span"));
    await waitForAsyncCallbacks();

    assert.deepEqual(events, ["ready", "scheduled"]);
    observer.disconnect();
});

test("createMutationObserverSync disconnects a pending deferred-target observer", async () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalContentScripts(dom);

    const { BetterChzzk, document } = dom.window;
    const events = [];
    let target = null;
    const observer = BetterChzzk.utils.createMutationObserverSync({
        target: () => target,
        schedule: () => events.push("scheduled"),
        onBodyReady: () => events.push("ready"),
    });

    observer.disconnect();
    target = document.createElement("div");
    document.body.appendChild(target);
    target.appendChild(document.createElement("span"));
    await waitForAsyncCallbacks();

    assert.deepEqual(events, []);
});

test("createMutationObserverSync disconnectAll prevents deferred callbacks after teardown", async () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalContentScripts(dom);

    const { BetterChzzk, document } = dom.window;
    const events = [];
    let target = null;
    const observer = BetterChzzk.utils.createMutationObserverSync({
        target: () => target,
        schedule: () => events.push("scheduled"),
        onBodyReady: () => events.push("ready"),
    });

    assert.equal(typeof observer.disconnectAll, "function");
    observer.disconnectAll();
    target = document.createElement("div");
    document.body.appendChild(target);
    target.appendChild(document.createElement("span"));
    await waitForAsyncCallbacks();

    assert.deepEqual(events, []);
});

test("createMutationObserverSync re-resolves a function target after it is detached and replaced", async () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalContentScripts(dom);

    const { BetterChzzk, document } = dom.window;
    const events = [];

    const firstTarget = document.createElement("div");
    document.body.appendChild(firstTarget);
    let target = firstTarget;

    const observer = BetterChzzk.utils.createMutationObserverSync({
        target: () => target,
        schedule: () => events.push("scheduled"),
        onBodyReady: (_obs, node) => events.push(node === target ? "ready:new" : "ready:other"),
    });

    // 최초 대상에서의 mutation은 정상적으로 스케줄된다.
    firstTarget.appendChild(document.createElement("span"));
    await waitForAsyncCallbacks();
    assert.deepEqual(events, ["scheduled"]);

    // 대상 노드가 통째로 교체(제거 후 새 노드로 대체)된다.
    firstTarget.remove();
    const secondTarget = document.createElement("div");
    document.body.appendChild(secondTarget);
    target = secondTarget;

    // 재연결 감시가 분리를 감지해 새 대상으로 옮겨 탄 뒤 onBodyReady로 알린다.
    await waitForCondition(() => events.includes("ready:new"));
    assert.deepEqual(events, ["scheduled", "ready:new"]);

    // 새 대상에서 발생한 mutation이 실제로 관찰된다(옛 분리 노드가 아니라 새 노드).
    secondTarget.appendChild(document.createElement("span"));
    await waitForCondition(() => events.length === 3);
    assert.deepEqual(events, ["scheduled", "ready:new", "scheduled"]);

    observer.disconnect();
});

test("createMutationObserverSync skips reconnect timers while the target stays connected", async () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/live/test", createFakeChrome());
    evalContentScripts(dom);

    const { BetterChzzk, document } = dom.window;
    const target = document.createElement("div");
    document.body.appendChild(target);
    const nativeSetTimeout = dom.window.setTimeout.bind(dom.window);
    let reconnectTimers = 0;
    dom.window.setTimeout = (callback, delay, ...args) => {
        if (delay === 160) reconnectTimers += 1;
        return nativeSetTimeout(callback, delay, ...args);
    };

    const observer = BetterChzzk.utils.createMutationObserverSync({
        target: () => target,
        schedule: () => {},
    });

    document.body.appendChild(document.createElement("section"));
    await waitForAsyncCallbacks();
    assert.equal(reconnectTimers, 0, "unrelated document mutations must not arm reconnect work");

    target.remove();
    await waitForAsyncCallbacks();
    assert.equal(reconnectTimers, 1, "detaching the observed target must still schedule reconnect work");
    observer.disconnectAll();
});

test("createMutationObserverSync does not watch for reconnect when the target is document.body", async () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalContentScripts(dom);

    const { BetterChzzk, document } = dom.window;
    const events = [];

    const observer = BetterChzzk.utils.createMutationObserverSync({
        target: () => document.body,
        schedule: () => events.push("scheduled"),
        onBodyReady: () => events.push("ready"),
    });

    // body 대상은 분리되지 않으므로 재연결 감시로 인한 중복 onBodyReady 없이
    // 일반 mutation만 스케줄되어야 한다.
    document.body.appendChild(document.createElement("span"));
    await waitForAsyncCallbacks();
    assert.deepEqual(events, ["scheduled"]);

    observer.disconnect();
});

test("createMutationObserverSync reconnect watch stops after disconnectAll", async () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalContentScripts(dom);

    const { BetterChzzk, document } = dom.window;
    const events = [];

    const firstTarget = document.createElement("div");
    document.body.appendChild(firstTarget);
    let target = firstTarget;

    const observer = BetterChzzk.utils.createMutationObserverSync({
        target: () => target,
        schedule: () => events.push("scheduled"),
        onBodyReady: () => events.push("ready"),
    });

    observer.disconnectAll();

    // teardown 이후에는 대상 교체를 감지해도 어떤 콜백도 발생하지 않아야 한다(누수 금지).
    firstTarget.remove();
    const secondTarget = document.createElement("div");
    document.body.appendChild(secondTarget);
    target = secondTarget;
    secondTarget.appendChild(document.createElement("span"));
    // 재연결 throttle 창(160ms)보다 넉넉히 기다려도 어떤 콜백도 발생하지 않아야 한다.
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.deepEqual(events, []);
});

test("startPageChangeDetection detects pushState without a DOM mutation through the page route bridge", async () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalRepoScript(dom, "features", "routeBridgePage.js");
    evalContentScripts(dom);

    const hrefs = [];
    const remove = dom.window.BetterChzzk.utils.startPageChangeDetection((event) => {
        hrefs.push(event?.detail?.href || dom.window.location.href);
    });

    dom.window.history.pushState({}, "", "/video/12345");
    await waitForCondition(() => hrefs.some((href) => href.endsWith("/video/12345")));

    remove();
    const countAfterRemove = hrefs.length;
    dom.window.history.pushState({}, "", "/video/67890");
    await waitForAsyncCallbacks();

    assert.equal(hrefs.length, countAfterRemove);
});

test("shared fetchJson keeps credentialed JSON requests and HTTP errors", async () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    const calls = [];
    dom.window.fetch = async (url, init) => {
        calls.push({ init, url });
        if (calls.length === 1) {
            return {
                ok: true,
                json: async () => ({ done: true }),
            };
        }
        return {
            ok: false,
            status: 503,
            json: async () => ({}),
        };
    };

    evalRepoScript(dom, "shared", "data.js");

    const result = await dom.window.BetterChzzk.utils.fetchJson("/ok", {
        headers: { Accept: "application/json" },
        timeoutMs: 50,
    });

    assert.deepEqual(result, { done: true });
    assert.equal(calls[0].url, "/ok");
    assert.equal(calls[0].init.credentials, "include");
    assert.equal(calls[0].init.headers.Accept, "application/json");
    assert.ok(calls[0].init.signal instanceof dom.window.AbortSignal);
    await assert.rejects(() => dom.window.BetterChzzk.utils.fetchJson("/fail", { timeoutMs: 50 }), /HTTP 503/);
});

test("shared storage helpers wrap chrome storage areas", async () => {
    const chrome = createFakeChrome({ local: { oldKey: "old value" } });
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", chrome);
    evalRepoScript(dom, "shared", "data.js");

    const { startStorageChangeListener, storageGet, storageRemove, storageSet } = dom.window.BetterChzzk.utils;

    assert.deepEqual(await storageGet(chrome.storage.local, "oldKey"), { oldKey: "old value" });

    await storageSet(chrome.storage.local, { nextKey: "next value" });
    assert.deepEqual(await storageGet(chrome.storage.local, "nextKey"), { nextKey: "next value" });

    await storageRemove(chrome.storage.local, "oldKey");
    assert.equal(Object.keys(await storageGet(chrome.storage.local, "oldKey")).length, 0);

    assert.equal(Object.keys(await storageGet(null, "missing")).length, 0);
    await storageSet(null, { ignored: true });
    await storageRemove(null, "ignored");

    const listener = () => {};
    const removeListener = startStorageChangeListener(listener);
    assert.equal(chrome.testState.storageChangeListeners.includes(listener), true);
    removeListener();
    assert.equal(chrome.testState.storageChangeListeners.includes(listener), false);
    assert.equal(startStorageChangeListener(null), null);
});

test("shared storage helpers reject chrome lastError", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", chrome);
    evalRepoScript(dom, "shared", "data.js");

    const failingArea = {
        get(_key, callback) {
            chrome.runtime.lastError = { message: "read failed" };
            callback({});
            chrome.runtime.lastError = null;
        },
        set(_value, callback) {
            chrome.runtime.lastError = { message: "write failed" };
            callback();
            chrome.runtime.lastError = null;
        },
        remove(_key, callback) {
            chrome.runtime.lastError = { message: "remove failed" };
            callback();
            chrome.runtime.lastError = null;
        },
    };
    const { storageGet, storageRemove, storageSet } = dom.window.BetterChzzk.utils;

    await assert.rejects(
        () => storageGet(failingArea, "key"),
        (error) => error.message === "read failed"
    );
    await assert.rejects(
        () => storageSet(failingArea, { key: "value" }),
        (error) => error.message === "write failed"
    );
    await assert.rejects(
        () => storageRemove(failingArea, "key"),
        (error) => error.message === "remove failed"
    );
});

test("shared map cache helpers trim oldest entries and refresh touched keys", () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalRepoScript(dom, "shared", "data.js");

    const { touchMapEntry } = dom.window.BetterChzzk.utils;
    const map = new Map([
        ["a", 1],
        ["b", 2],
        ["c", 3],
    ]);

    touchMapEntry(map, "c", 3, 2);
    assert.equal(
        JSON.stringify([...map.entries()]),
        JSON.stringify([
            ["b", 2],
            ["c", 3],
        ])
    );

    assert.equal(touchMapEntry(map, "b", 4, 2), 4);
    assert.equal(
        JSON.stringify([...map.entries()]),
        JSON.stringify([
            ["c", 3],
            ["b", 4],
        ])
    );

    touchMapEntry(map, "d", 5, 2);
    assert.equal(
        JSON.stringify([...map.entries()]),
        JSON.stringify([
            ["b", 4],
            ["d", 5],
        ])
    );
});

test("shared string and page helpers are reused by content utilities", () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalContentScripts(dom);

    const {
        compactSpaces,
        getLiveChannelIdFromPath,
        getVodVideoNoFromPath,
        isLastPage,
        isLiveRoute,
        isPlaybackRoute,
        isVodRoute,
        normSpace,
        normalizeCompact,
    } = dom.window.BetterChzzk.utils;

    assert.equal(compactSpaces(" a\n  b\tc "), "a b c");
    assert.equal(normSpace(" a\n  b\tc "), "a b c");
    assert.equal(normalizeCompact(" A\n  b\tC "), "abc");
    assert.equal(isLastPage({ content: { totalPages: 3, page: { number: 2 } } }, [], 30), true);
    assert.equal(isLastPage({ content: { totalPages: 3, page: { number: 1 } } }, [], 30), false);
    assert.equal(isLastPage({ content: { last: true } }, [], 30), true);
    assert.equal(isLastPage({}, [1, 2], 3), true);
    assert.equal(isLastPage({}, [1, 2, 3], 3), false);
    assert.equal(isPlaybackRoute("/live/abc"), true);
    assert.equal(isPlaybackRoute("/video/123"), true);
    assert.equal(isPlaybackRoute("/category/foo"), false);
    assert.equal(isLiveRoute("/live/abc"), true);
    assert.equal(isLiveRoute("/video/123"), false);
    assert.equal(getLiveChannelIdFromPath("/live/abc"), "abc");
    assert.equal(getLiveChannelIdFromPath("/live/%ED%85%8C%EC%8A%A4%ED%8A%B8"), "\uD14C\uC2A4\uD2B8");
    assert.equal(getLiveChannelIdFromPath("/live"), "");
    assert.equal(isVodRoute("/video"), true);
    assert.equal(isVodRoute("/video/123"), true);
    assert.equal(getVodVideoNoFromPath("/video/123"), "123");
    assert.equal(getVodVideoNoFromPath("/video/abc"), "abc");
    assert.equal(getVodVideoNoFromPath("/video"), "");
});

test("shared main video helper ignores following preview player videos", () => {
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div class="bcfp-player" data-bcfp-player-mount="preview"><video id="previewVideo"></video></div>',
            '<main><video id="mainVideo"></video></main>',
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test",
        createFakeChrome()
    );
    evalContentScripts(dom);

    const { BetterChzzk, document } = dom.window;
    const previewVideo = document.getElementById("previewVideo");
    const mainVideo = document.getElementById("mainVideo");

    previewVideo.getBoundingClientRect = () => ({
        width: 800,
        height: 450,
        left: 0,
        top: 0,
        right: 800,
        bottom: 450,
    });
    mainVideo.getBoundingClientRect = () => ({
        width: 320,
        height: 180,
        left: 0,
        top: 0,
        right: 320,
        bottom: 180,
    });

    assert.equal(BetterChzzk.utils.isExtensionPreviewVideo(previewVideo), true);
    assert.equal(BetterChzzk.utils.isExtensionPreviewVideo(mainVideo), false);
    assert.equal(BetterChzzk.utils.getMainVideoElement(), mainVideo);
});

test("shared CHZZK video field pickers keep API fallback order", () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalRepoScript(dom, "shared", "data.js");

    const { pickChzzkVideoNo, pickVideoEndDateText, pickVideoStartDateText } = dom.window.BetterChzzk.utils;

    assert.equal(pickChzzkVideoNo({ videoId: 123, id: 456 }), "123");
    assert.equal(pickChzzkVideoNo({ id: "  789  " }), "789");
    assert.equal(pickChzzkVideoNo({}), "");
    assert.equal(pickVideoStartDateText({ live: { openDate: "2026-06-22 10:00:00" } }), "2026-06-22 10:00:00");
    assert.equal(
        pickVideoStartDateText({ live: { liveOpenDate: "nested-live", openDate: "nested-open" } }),
        "nested-live"
    );
    assert.equal(
        pickVideoStartDateText({ openDate: "open", liveOpenDate: "live", broadcastOpenDate: "broadcast" }),
        "live"
    );
    assert.equal(pickVideoEndDateText({ createdDate: "created", publishDate: "published" }), "published");
    assert.equal(pickVideoEndDateText({ publishDateAt: "at", publishDate: "published" }), "at");
    assert.equal(pickVideoEndDateText({ liveCloseDate: "closed", publishDateAt: "at" }), "closed");
    assert.equal(pickVideoEndDateText({ live: { liveCloseDate: "nested-closed" } }), "nested-closed");
});

test("shared CHZZK comment helper reuses extension storage device id and page.next request shape", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/video/123", chrome);
    const requests = [];
    dom.window.fetch = async (url, init) => {
        requests.push({ init, url: String(url) });
        return {
            ok: true,
            json: async () => ({
                code: 200,
                content: { commentActive: true, comments: { data: [], page: { next: null } } },
            }),
        };
    };
    evalRepoScript(dom, "shared", "data.js");

    const { fetchChzzkCommentPage } = dom.window.BetterChzzk.utils;
    await fetchChzzkCommentPage({ limit: 10, objectId: "123", offset: 20, orderType: "DESC" });
    await fetchChzzkCommentPage({ limit: 10, objectId: "123", offset: 30, orderType: "DESC" });

    assert.equal(requests.length, 2);
    const firstUrl = new URL(requests[0].url);
    assert.equal(firstUrl.pathname, "/nng_main/nng_comment_api/v1/type/STREAMING_VIDEO/id/123/comments");
    assert.equal(firstUrl.searchParams.get("limit"), "10");
    assert.equal(firstUrl.searchParams.get("offset"), "20");
    assert.equal(firstUrl.searchParams.get("orderType"), "DESC");
    assert.equal(firstUrl.searchParams.has("pagingType"), false);
    assert.equal(requests[0].init.headers["Front-Client-Platform-Type"], "PC");
    assert.equal(requests[0].init.headers["Front-Client-Product-Type"], "web");
    assert.ok(requests[0].init.headers.deviceId);
    assert.equal(requests[1].init.headers.deviceId, requests[0].init.headers.deviceId);
    assert.equal(chrome.testState.local.betterchzzkCommentDeviceId, requests[0].init.headers.deviceId);
    assert.equal(dom.window.localStorage.getItem("betterchzzk-comment-device-id"), null);

    dom.window.close();
});

test("shared KST helpers keep date keys and day boundaries consistent", () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalRepoScript(dom, "shared", "data.js");

    const {
        formatKstDateKey,
        formatKstDateTime,
        formatKstMonthKey,
        formatKstTime,
        getKstDateKey,
        getKstDayStartMs,
        getKstMonthStartMs,
        getKstParts,
        getNextKstDayStartMs,
        isSameKstDate,
    } = dom.window.BetterChzzk.utils;
    const ms = Date.parse("2026-06-21T15:30:05Z");

    assert.equal(
        JSON.stringify(getKstParts(ms)),
        JSON.stringify({
            year: 2026,
            month: 6,
            day: 22,
            weekday: 1,
            hours: 0,
            minutes: 30,
            seconds: 5,
        })
    );
    assert.equal(formatKstDateKey(getKstParts(ms)), "2026-06-22");
    assert.equal(getKstDateKey(ms), "2026-06-22");
    assert.equal(formatKstMonthKey(2026, 6), "2026-06");
    assert.equal(getKstDayStartMs("2026-06-22"), Date.parse("2026-06-21T15:00:00Z"));
    assert.equal(getKstMonthStartMs(2026, 6), Date.parse("2026-05-31T15:00:00Z"));
    assert.equal(getNextKstDayStartMs(ms), Date.parse("2026-06-22T15:00:00Z"));
    assert.equal(isSameKstDate(ms, Date.parse("2026-06-22T14:59:59Z")), true);
    assert.equal(isSameKstDate(ms, Date.parse("2026-06-22T15:00:00Z")), false);
    assert.equal(formatKstDateTime(ms, { seconds: true }), "2026.06.22 00:30:05");
    assert.equal(formatKstTime(ms), "00:30");
    assert.equal(Number.isNaN(getKstDayStartMs("bad")), true);
});

test("shared watch-range helpers normalize, merge, and sum ranges", () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalRepoScript(dom, "shared", "data.js");

    const { mergeWatchRanges, sumWatchRanges } = dom.window.BetterChzzk.utils;
    const ranges = [
        { startAt: 5000, endAt: 7000 },
        { start: 1000.4, end: 2000.6 },
        { startAt: 3200, endAt: 4500 },
        { startAt: 9000, endAt: 8500 },
    ];

    assert.equal(
        JSON.stringify(mergeWatchRanges(ranges, 1000)),
        JSON.stringify([
            { startAt: 1000, endAt: 2001 },
            { startAt: 3200, endAt: 7000 },
        ])
    );
    assert.equal(JSON.stringify(mergeWatchRanges(ranges, 1500)), JSON.stringify([{ startAt: 1000, endAt: 7000 }]));
    assert.equal(sumWatchRanges(ranges, 1000), 4.801);
});

test("shared watch-session helpers derive fallback ranges and daily totals", () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalRepoScript(dom, "shared", "data.js");

    const {
        addWatchRangeToRangesByDate,
        collectWatchSessionRanges,
        getWatchSessionRanges,
        mergeDailySeconds,
        normalizeDailySeconds,
        sumWatchRangesByDate,
    } = dom.window.BetterChzzk.utils;
    const dayStart = Date.parse("2026-06-21T15:00:00Z");

    assert.equal(
        JSON.stringify(normalizeDailySeconds({ a: "10.5", b: -2, c: "bad", d: 0 })),
        JSON.stringify({ a: 10.5 })
    );
    assert.equal(JSON.stringify(mergeDailySeconds({ a: 2 }, { a: "1.5", b: 3 })), JSON.stringify({ a: 3.5, b: 3 }));
    assert.equal(JSON.stringify(mergeDailySeconds({}, { a: 1.6, b: 0.4 }, { round: true })), JSON.stringify({ a: 2 }));

    const direct = getWatchSessionRanges({
        watchedSeconds: 300,
        dailySeconds: { "2026-06-22": 120 },
        watchedRanges: [{ startAt: dayStart + 1000, endAt: dayStart + 6000 }],
    });
    assert.equal(JSON.stringify(direct), JSON.stringify([{ startAt: dayStart + 1000, endAt: dayStart + 6000 }]));

    const fallback = getWatchSessionRanges({
        enteredAt: dayStart + 60000,
        watchedSeconds: 120,
        dailySeconds: { "2026-06-22": 120 },
    });
    assert.equal(JSON.stringify(fallback), JSON.stringify([{ startAt: dayStart + 60000, endAt: dayStart + 180000 }]));

    const clipped = collectWatchSessionRanges([{ watchedRanges: [{ startAt: dayStart, endAt: dayStart + 10000 }] }], {
        scopeStartMs: dayStart + 3000,
        scopeEndMs: dayStart + 8000,
    });
    assert.equal(JSON.stringify(clipped), JSON.stringify([{ startAt: dayStart + 3000, endAt: dayStart + 8000 }]));

    const rangesByDate = {};
    addWatchRangeToRangesByDate(rangesByDate, {
        startAt: dayStart + 24 * 60 * 60 * 1000 - 30000,
        endAt: dayStart + 24 * 60 * 60 * 1000 + 90000,
    });
    assert.equal(
        JSON.stringify(sumWatchRangesByDate(rangesByDate)),
        JSON.stringify({
            "2026-06-22": 30,
            "2026-06-23": 90,
        })
    );
});

test("shared title-history helpers normalize channel-prefixed titles", () => {
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/", createFakeChrome());
    evalRepoScript(dom, "shared", "data.js");

    const { addTitleHistory, cleanEntryTitle, normalizeForMatch, normalizeTitleHistory, parseChzzkDate, pickString } =
        dom.window.BetterChzzk.utils;
    const channelName = "\uCC44\uB110";

    assert.equal(pickString("", null, "  value  "), "value");
    assert.equal(
        cleanEntryTitle("\uCC44\uB110 \u00B7 \uCCAB \uC81C\uBAA9 - CHZZK", channelName),
        "\uCCAB \uC81C\uBAA9"
    );
    assert.equal(normalizeForMatch("\uCCAB \uC81C\uBAA9! 123"), "\uCCAB\uC81C\uBAA9123");
    assert.equal(parseChzzkDate("2026-06-22 10:30:00").toISOString(), "2026-06-22T01:30:00.000Z");
    assert.equal(parseChzzkDate(1719000000).getTime(), 1719000000000);
    assert.equal(parseChzzkDate(" "), null);

    const rows = normalizeTitleHistory(
        [
            { title: "\uCC44\uB110 \u00B7 \uCCAB \uC81C\uBAA9", firstSeenAt: 20, lastSeenAt: 30 },
            { title: "\uCC44\uB110 - \uCCAB \uC81C\uBAA9", firstSeenAt: 10, lastSeenAt: 40 },
            { title: "\uC81C\uBAA9 \uC5C6\uB294 \uB77C\uC774\uBE0C", firstSeenAt: 1, lastSeenAt: 2 },
        ],
        channelName
    );

    assert.equal(
        JSON.stringify(rows),
        JSON.stringify([{ title: "\uCCAB \uC81C\uBAA9", firstSeenAt: 10, lastSeenAt: 40 }])
    );

    const target = { channelName, titleHistory: rows };
    addTitleHistory(target, "\uCC44\uB110: \uB2E4\uC74C \uC81C\uBAA9", 50, 60);

    assert.equal(
        JSON.stringify(target.titleHistory.map((row) => row.title)),
        JSON.stringify(["\uCCAB \uC81C\uBAA9", "\uB2E4\uC74C \uC81C\uBAA9"])
    );
});

const AD_SUPPRESS_ATTR = "data-betterchzzk-suppress-adblock-popup";
const ADBLOCK_POPUP_TITLE =
    "\uAD11\uACE0 \uCC28\uB2E8 \uD504\uB85C\uADF8\uB7A8\uC744 \uC0AC\uC6A9 \uC911\uC774\uC2E0\uAC00\uC694?";

function makeVisibleElement(el, width = 450, height = 260) {
    el.getBoundingClientRect = () => ({
        width,
        height,
        left: 0,
        top: 0,
        right: width,
        bottom: height,
    });
}

const MONTHLY_BROADCAST_WIDGET_ID = "betterchzzk-monthly-broadcast-time";
const MONTHLY_BROADCAST_CHANNEL_ID = "0123456789abcdef0123456789abcdef";

function createDeferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function createTestAbortError() {
    const error = new Error("Aborted");
    error.name = "AbortError";
    return error;
}

function waitForDeferredWithAbort(deferred, signal) {
    if (!deferred) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(createTestAbortError());

    return new Promise((resolve, reject) => {
        function cleanup() {
            signal?.removeEventListener("abort", abort);
        }

        function abort() {
            cleanup();
            reject(createTestAbortError());
        }

        signal?.addEventListener("abort", abort, { once: true });
        deferred.promise.then(
            () => {
                cleanup();
                resolve();
            },
            (error) => {
                cleanup();
                reject(error);
            }
        );
    });
}

async function createMonthlyBroadcastFixture({
    deferList = false,
    details = {},
    nowMs = Date.parse("2026-06-29T12:00:00+09:00"),
    videos = [],
    watchHistory = [],
    watchDisplay = true,
} = {}) {
    const chrome = createFakeChrome({
        local: {
            betterChzzkLiveWatchHistory: { entries: watchHistory },
        },
        sync: {
            monthlyBroadcastTimeEnabled: true,
            monthlyBroadcastTimeCalendarEnabled: true,
            monthlyBroadcastTimeWatchEnabled: watchDisplay,
            monthlyBroadcastTimeMaxCalendarPages: 5,
            monthlyBroadcastTimeMaxPages: 5,
            monthlyBroadcastTimeWindowDays: 30,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main id="channel">',
            '<section id="profile">',
            '<div id="actions"><button id="follow" type="button">팔로우</button></div>',
            "</section>",
            "</main>",
            "</body>",
        ].join(""),
        `https://chzzk.naver.com/${MONTHLY_BROADCAST_CHANNEL_ID}`,
        chrome
    );
    const { document } = dom.window;
    const listGate = deferList ? createDeferred() : null;
    const fetchCalls = [];
    const fetchInits = [];

    dom.window.Date.now = () => nowMs;
    document.getElementById("profile").getBoundingClientRect = () => ({
        width: 640,
        height: 80,
        left: 0,
        top: 0,
        right: 640,
        bottom: 80,
    });
    document.getElementById("actions").getBoundingClientRect = () => ({
        width: 280,
        height: 42,
        left: 260,
        top: 24,
        right: 540,
        bottom: 66,
    });
    document.getElementById("follow").getBoundingClientRect = () => ({
        width: 90,
        height: 34,
        left: 430,
        top: 28,
        right: 520,
        bottom: 62,
    });

    dom.window.fetch = async (url, init = {}) => {
        const href = String(url);
        fetchCalls.push(href);
        fetchInits.push({ href, init });

        if (href.includes("/service/v1/channels/")) {
            await waitForDeferredWithAbort(listGate, init.signal);
            return {
                ok: true,
                json: async () => ({
                    content: {
                        data: videos,
                        last: true,
                        page: { number: 0 },
                        totalPages: 1,
                    },
                }),
            };
        }

        if (href.includes("/service/v2/videos/")) {
            const videoNo = decodeURIComponent(href.split("/").pop());
            return {
                ok: true,
                json: async () => ({
                    content: {
                        videoNo,
                        ...(details[videoNo] || {}),
                    },
                }),
            };
        }

        throw new Error(`Unexpected monthly broadcast request: ${href}`);
    };

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "monthlyBroadcastTime.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));

    await waitForCondition(() => document.getElementById(MONTHLY_BROADCAST_WIDGET_ID));

    return {
        chrome,
        document,
        dom,
        fetchCalls,
        fetchInits,
        resolveList: () => listGate?.resolve(),
    };
}

function getMonthlyCalendarDay(document, dateKey) {
    return document.querySelector(`#${MONTHLY_BROADCAST_WIDGET_ID} .bcmb-day[data-date-key="${dateKey}"]`);
}

function createCappedWatchRanges(startMs, count = 200) {
    return Array.from({ length: count }, (_, index) => ({
        startAt: startMs + index * 15000,
        endAt: startMs + index * 15000 + 10000,
    }));
}

async function closeMonthlyBroadcastFixture(fixture) {
    for (const listener of fixture.chrome.testState.storageChangeListeners) {
        listener({ monthlyBroadcastTimeEnabled: { newValue: false } }, "sync");
    }
    await waitForAsyncCallbacks();
    fixture.dom.window.close();
}

test("monthly broadcast calendar colors KST days after async metadata load", async () => {
    const firstStartMs = Date.parse("2026-06-28T23:30:00+09:00");
    const secondStartMs = Date.parse("2026-06-28T00:30:00+09:00");
    const fixture = await createMonthlyBroadcastFixture({
        deferList: true,
        details: {
            detailStart: {
                duration: 30 * 60,
                liveCloseDate: new Date(secondStartMs + 30 * 60 * 1000).toISOString(),
                liveOpenDate: "2026-06-28T00:30:00+09:00",
                videoTitle: "Detail start fixture",
            },
        },
        videos: [
            {
                duration: 20 * 60,
                liveCloseDate: new Date(firstStartMs + 20 * 60 * 1000).toISOString(),
                liveOpenDate: "2026-06-28T23:30:00+09:00",
                videoNo: "lateStart",
                videoTitle: "Late start fixture",
                videoType: "REPLAY",
            },
            {
                duration: 30 * 60,
                videoNo: "detailStart",
                videoTitle: "Detail start fixture",
                videoType: "REPLAY",
            },
        ],
    });

    try {
        assert.equal(
            fixture.document.querySelector(`#${MONTHLY_BROADCAST_WIDGET_ID} .bcmb-day[data-has-broadcast="1"]`),
            null
        );

        fixture.resolveList();

        await waitForCondition(
            () => getMonthlyCalendarDay(fixture.document, "2026-06-28")?.getAttribute("data-has-broadcast") === "1",
            { timeoutMs: 3000 }
        );

        const day = getMonthlyCalendarDay(fixture.document, "2026-06-28");
        const tipText = day.querySelector(".bcmb-day-tip").textContent;

        assert.equal(day.getAttribute("data-date-key"), "2026-06-28");
        assert.equal(day.getAttribute("data-live"), "1");
        assert.equal(
            fixture.document.querySelector(`#${MONTHLY_BROADCAST_WIDGET_ID} .bcmb-calendar-count`).textContent,
            "총 방송 50분"
        );
        assert.ok(fixture.fetchCalls.some((href) => href.includes("/service/v2/videos/detailStart")));
        assert.equal(getMonthlyCalendarDay(fixture.document, "2026-06-27")?.getAttribute("data-has-broadcast"), null);
        assert.equal(day.querySelectorAll(".bcmb-day-tip-item").length, 2);
        assert.match(tipText, /00:30/);
        assert.match(tipText, /01:00/);
        assert.match(tipText, /23:30/);
        assert.match(tipText, /23:50/);
    } finally {
        await closeMonthlyBroadcastFixture(fixture);
    }
});

test("monthly broadcast aborts pending page fetches when disabled", async () => {
    const fixture = await createMonthlyBroadcastFixture({
        deferList: true,
        videos: [
            {
                duration: 20 * 60,
                liveCloseDate: "2026-06-28T09:20:00+09:00",
                liveOpenDate: "2026-06-28T09:00:00+09:00",
                videoNo: "abort-pending",
                videoTitle: "Abort pending fixture",
                videoType: "REPLAY",
            },
        ],
    });

    const pending = fixture.fetchInits.find((call) => call.href.includes("/service/v1/channels/"));
    assert.ok(pending?.init.signal instanceof fixture.dom.window.AbortSignal);

    await closeMonthlyBroadcastFixture(fixture);

    assert.equal(pending.init.signal.aborted, true);
});

test("monthly broadcast calendar combines split VODs into one continuous broadcast", async () => {
    const liveOpenDate = "2026-07-10 19:01:32";
    const fixture = await createMonthlyBroadcastFixture({
        nowMs: Date.parse("2026-07-13T12:00:00+09:00"),
        videos: [
            {
                duration: 7 * 60 * 60 + 55 * 60 + 56,
                liveOpenDate,
                publishDate: "2026-07-12 16:55:34",
                videoNo: "14154992",
                videoTitle: "Split segment three",
                videoType: "REPLAY",
            },
            {
                duration: 17 * 60 * 60 + 1,
                liveOpenDate,
                publishDate: "2026-07-12 14:28:21",
                videoNo: "14152282",
                videoTitle: "Split segment two",
                videoType: "REPLAY",
            },
            {
                duration: 17 * 60 * 60,
                liveOpenDate,
                publishDate: "2026-07-11 12:18:00",
                videoNo: "14137551",
                videoTitle: "Split segment one",
                videoType: "REPLAY",
            },
        ],
    });

    try {
        await waitForCondition(
            () => getMonthlyCalendarDay(fixture.document, "2026-07-10")?.getAttribute("data-has-broadcast") === "1",
            { timeoutMs: 3000 }
        );

        const day = getMonthlyCalendarDay(fixture.document, "2026-07-10");
        const items = day.querySelectorAll(".bcmb-day-tip-item");
        const broadcastText = day.querySelector(".bcmb-day-tip-row-broadcast .bcmb-day-tip-value").textContent;

        assert.equal(items.length, 1);
        assert.equal(day.getAttribute("data-video-no"), "14137551");
        assert.match(broadcastText, /19:01/);
        assert.match(broadcastText, /12:57 \(7\/12\)/);
        assert.match(broadcastText, /41시간 56분/);
        assert.equal(
            fixture.document.querySelector(`#${MONTHLY_BROADCAST_WIDGET_ID} .bcmb-calendar-count`).textContent,
            "총 방송 41시간 56분"
        );
    } finally {
        await closeMonthlyBroadcastFixture(fixture);
    }
});

test("monthly broadcast calendar separates stream and watch rows in dense day tips", async () => {
    const firstStartMs = Date.parse("2026-06-28T09:00:00+09:00");
    const secondStartMs = Date.parse("2026-06-28T15:10:00+09:00");
    const firstDuration = 20 * 60;
    const secondDuration = 40 * 60;
    const fixture = await createMonthlyBroadcastFixture({
        videos: [
            {
                duration: firstDuration,
                liveCloseDate: new Date(firstStartMs + firstDuration * 1000).toISOString(),
                liveOpenDate: "2026-06-28T09:00:00+09:00",
                videoNo: "morning",
                videoTitle: "Morning stream",
                videoType: "REPLAY",
            },
            {
                duration: secondDuration,
                liveCloseDate: new Date(secondStartMs + secondDuration * 1000).toISOString(),
                liveOpenDate: "2026-06-28T15:10:00+09:00",
                videoNo: "afternoon",
                videoTitle: "Afternoon stream",
                videoType: "REPLAY",
            },
        ],
        watchHistory: [
            {
                channelId: MONTHLY_BROADCAST_CHANNEL_ID,
                dailySeconds: { "2026-06-28": firstDuration },
                firstWatchedAt: firstStartMs,
                id: "watch-morning",
                lastWatchedAt: firstStartMs + firstDuration * 1000,
                liveId: "morning",
                liveOpenDate: "2026-06-28T09:00:00+09:00",
                title: "Morning stream",
                watchedSeconds: firstDuration,
            },
            {
                channelId: MONTHLY_BROADCAST_CHANNEL_ID,
                dailySeconds: { "2026-06-28": secondDuration },
                firstWatchedAt: secondStartMs,
                id: "watch-afternoon",
                lastWatchedAt: secondStartMs + secondDuration * 1000,
                liveId: "afternoon",
                liveOpenDate: "2026-06-28T15:10:00+09:00",
                title: "Afternoon stream",
                watchedSeconds: secondDuration,
            },
        ],
    });

    try {
        await waitForCondition(
            () => {
                const watchRows = getMonthlyCalendarDay(fixture.document, "2026-06-28")?.querySelectorAll(
                    ".bcmb-day-tip-row-watch .bcmb-day-tip-value"
                );
                return (
                    watchRows?.length === 2 && Array.from(watchRows).every((row) => row.textContent.includes("100%"))
                );
            },
            { timeoutMs: 3000 }
        );

        const day = getMonthlyCalendarDay(fixture.document, "2026-06-28");
        const items = Array.from(day.querySelectorAll(".bcmb-day-tip-item"));
        const firstBroadcast = items[0].querySelector('[data-tip-row="broadcast"] .bcmb-day-tip-value');
        const firstWatch = items[0].querySelector('[data-tip-row="watch"] .bcmb-day-tip-value');

        assert.equal(items.length, 2);
        assert.equal(
            fixture.document.querySelector(`#${MONTHLY_BROADCAST_WIDGET_ID} .bcmb-calendar-count`).textContent,
            "총 방송 1시간"
        );
        assert.equal(items[0].querySelectorAll(".bcmb-day-tip-row").length, 2);
        assert.equal(items[0].querySelector(".bcmb-day-tip-row-broadcast .bcmb-day-tip-label").textContent, "방송");
        assert.equal(items[0].querySelector(".bcmb-day-tip-row-watch .bcmb-day-tip-label").textContent, "내 시청");
        assert.match(firstBroadcast.textContent, /09:00/);
        assert.match(firstBroadcast.textContent, /09:20/);
        assert.match(firstBroadcast.textContent, /20분/);
        assert.equal(firstWatch.textContent, "20분 (100%)");
    } finally {
        await closeMonthlyBroadcastFixture(fixture);
    }
});

test("monthly broadcast keeps stored watch aggregates when exact ranges are capped", async () => {
    const startMs = Date.parse("2026-06-28T09:00:00+09:00");
    const duration = 60 * 60;
    const watchedSeconds = 2050;
    const dateKey = "2026-06-28";
    const fixture = await createMonthlyBroadcastFixture({
        videos: [
            {
                duration,
                liveCloseDate: new Date(startMs + duration * 1000).toISOString(),
                liveOpenDate: "2026-06-28T09:00:00+09:00",
                videoNo: "capped-watch",
                videoTitle: "Capped watch fixture",
                videoType: "REPLAY",
            },
        ],
        watchHistory: [
            {
                channelId: MONTHLY_BROADCAST_CHANNEL_ID,
                dailySeconds: { [dateKey]: watchedSeconds },
                firstWatchedAt: startMs,
                id: "watch-capped",
                lastWatchedAt: startMs + 50 * 60 * 1000,
                liveId: "capped-watch",
                liveOpenDate: "2026-06-28T09:00:00+09:00",
                sessionDetails: [
                    {
                        dailySeconds: { [dateKey]: watchedSeconds },
                        enteredAt: startMs,
                        id: "session-capped",
                        leftAt: startMs + 50 * 60 * 1000,
                        watchedRanges: createCappedWatchRanges(startMs),
                        watchedSeconds,
                    },
                ],
                title: "Capped watch fixture",
                watchedSeconds,
            },
        ],
    });

    try {
        await waitForCondition(() => {
            const value = getMonthlyCalendarDay(fixture.document, dateKey)?.querySelector(
                ".bcmb-day-tip-row-watch .bcmb-day-tip-value"
            );
            return value?.textContent === "34분 (57%)";
        });
    } finally {
        await closeMonthlyBroadcastFixture(fixture);
    }
});

test("monthly broadcast counts overlapping tab ranges only once", async () => {
    const startMs = Date.parse("2026-06-28T09:00:00+09:00");
    const duration = 20 * 60;
    const dateKey = "2026-06-28";
    const session = (id) => ({
        dailySeconds: { [dateKey]: duration },
        enteredAt: startMs,
        id,
        leftAt: startMs + duration * 1000,
        watchedRanges: [{ startAt: startMs, endAt: startMs + duration * 1000 }],
        watchedSeconds: duration,
    });
    const fixture = await createMonthlyBroadcastFixture({
        videos: [
            {
                duration,
                liveCloseDate: new Date(startMs + duration * 1000).toISOString(),
                liveOpenDate: "2026-06-28T09:00:00+09:00",
                videoNo: "overlapping-tabs",
                videoTitle: "Overlapping tabs fixture",
                videoType: "REPLAY",
            },
        ],
        watchHistory: [
            {
                channelId: MONTHLY_BROADCAST_CHANNEL_ID,
                dailySeconds: { [dateKey]: duration * 2 },
                firstWatchedAt: startMs,
                id: "watch-overlapping-tabs",
                lastWatchedAt: startMs + duration * 1000,
                liveId: "overlapping-tabs",
                liveOpenDate: "2026-06-28T09:00:00+09:00",
                sessionDetails: [session("tab-a"), session("tab-b")],
                title: "Overlapping tabs fixture",
                watchedSeconds: duration * 2,
            },
        ],
    });

    try {
        await waitForCondition(() => {
            const value = getMonthlyCalendarDay(fixture.document, dateKey)?.querySelector(
                ".bcmb-day-tip-row-watch .bcmb-day-tip-value"
            );
            return value?.textContent === "20분 (100%)";
        });
    } finally {
        await closeMonthlyBroadcastFixture(fixture);
    }
});

test("monthly broadcast calendar hides watch info when watch display is disabled", async () => {
    const startMs = Date.parse("2026-06-28T09:00:00+09:00");
    const duration = 20 * 60;
    const fixture = await createMonthlyBroadcastFixture({
        watchDisplay: false,
        videos: [
            {
                duration,
                liveCloseDate: new Date(startMs + duration * 1000).toISOString(),
                liveOpenDate: "2026-06-28T09:00:00+09:00",
                videoNo: "hiddenWatch",
                videoTitle: "Watch hidden fixture",
                videoType: "REPLAY",
            },
        ],
        watchHistory: [
            {
                channelId: MONTHLY_BROADCAST_CHANNEL_ID,
                dailySeconds: { "2026-06-28": duration },
                firstWatchedAt: startMs,
                id: "watch-hidden",
                lastWatchedAt: startMs + duration * 1000,
                liveId: "hiddenWatch",
                liveOpenDate: "2026-06-28T09:00:00+09:00",
                title: "Watch hidden fixture",
                watchedSeconds: duration,
            },
        ],
    });

    try {
        await waitForCondition(
            () => getMonthlyCalendarDay(fixture.document, "2026-06-28")?.getAttribute("data-has-broadcast") === "1",
            { timeoutMs: 3000 }
        );
        await waitForAsyncCallbacks();

        const day = getMonthlyCalendarDay(fixture.document, "2026-06-28");
        assert.equal(day.getAttribute("data-watch"), null);
        assert.ok(day.querySelector(".bcmb-day-tip-row-broadcast"));
        assert.equal(day.querySelector(".bcmb-day-tip-row-watch"), null);
        assert.doesNotMatch(day.getAttribute("aria-label"), /내 시청/);

        const foot = fixture.document.querySelector(`#${MONTHLY_BROADCAST_WIDGET_ID} .bcmb-calendar-foot`);
        assert.equal(foot.querySelector(".bcmb-calendar-watch-total"), null);
        assert.match(foot.textContent, /방송 시작일 기준/);
    } finally {
        await closeMonthlyBroadcastFixture(fixture);
    }
});

test("monthly broadcast calendar keeps colored days when returning to a cached month", async () => {
    const startMs = Date.parse("2026-06-28T23:30:00+09:00");
    const fixture = await createMonthlyBroadcastFixture({
        videos: [
            {
                duration: 20 * 60,
                liveCloseDate: new Date(startMs + 20 * 60 * 1000).toISOString(),
                liveOpenDate: "2026-06-28T23:30:00+09:00",
                videoNo: "cachedStart",
                videoTitle: "Cached start fixture",
                videoType: "REPLAY",
            },
        ],
    });

    try {
        await waitForCondition(
            () => getMonthlyCalendarDay(fixture.document, "2026-06-28")?.getAttribute("data-has-broadcast") === "1",
            { timeoutMs: 3000 }
        );

        const widget = fixture.document.getElementById(MONTHLY_BROADCAST_WIDGET_ID);
        widget.querySelector('[data-bcmb-nav="-1"]').click();
        await waitForCondition(
            () =>
                widget.querySelector(".bcmb-calendar-month")?.textContent === "2026.05" &&
                widget.querySelector(".bcmb-calendar")?.getAttribute("data-loading") === "0",
            { timeoutMs: 3000 }
        );

        widget.querySelector('[data-bcmb-nav="1"]').click();
        await waitForCondition(
            () =>
                widget.querySelector(".bcmb-calendar-month")?.textContent === "2026.06" &&
                getMonthlyCalendarDay(fixture.document, "2026-06-28")?.getAttribute("data-has-broadcast") === "1",
            { timeoutMs: 3000 }
        );

        assert.equal(getMonthlyCalendarDay(fixture.document, "2026-06-28").getAttribute("data-live"), "1");
    } finally {
        await closeMonthlyBroadcastFixture(fixture);
    }
});

test("monthly broadcast calendar day click opens the day's first replay", async () => {
    const firstOpen = "2026-06-28T09:00:00+09:00";
    const firstStartMs = Date.parse(firstOpen);
    const secondOpen = "2026-06-28T15:10:00+09:00";
    const secondStartMs = Date.parse(secondOpen);
    const fixture = await createMonthlyBroadcastFixture({
        videos: [
            // 같은 방송이 17시간 분할로 쪼개진 두 세그먼트: videoNo가 작은 쪽이 앞부분.
            {
                duration: 30 * 60,
                liveCloseDate: new Date(firstStartMs + 60 * 60 * 1000).toISOString(),
                liveOpenDate: firstOpen,
                videoNo: "7002",
                videoTitle: "Split segment two",
                videoType: "REPLAY",
            },
            {
                duration: 30 * 60,
                liveCloseDate: new Date(firstStartMs + 30 * 60 * 1000).toISOString(),
                liveOpenDate: firstOpen,
                videoNo: "7001",
                videoTitle: "Split segment one",
                videoType: "REPLAY",
            },
            {
                duration: 40 * 60,
                liveCloseDate: new Date(secondStartMs + 40 * 60 * 1000).toISOString(),
                liveOpenDate: secondOpen,
                videoNo: "8001",
                videoTitle: "Afternoon stream",
                videoType: "REPLAY",
            },
        ],
    });

    try {
        await waitForCondition(
            () => getMonthlyCalendarDay(fixture.document, "2026-06-28")?.getAttribute("data-has-broadcast") === "1",
            { timeoutMs: 3000 }
        );

        const widget = fixture.document.getElementById(MONTHLY_BROADCAST_WIDGET_ID);
        const day = getMonthlyCalendarDay(fixture.document, "2026-06-28");

        assert.equal(day.getAttribute("data-video-no"), "7001");
        assert.equal(day.getAttribute("role"), "link");
        assert.match(day.getAttribute("aria-label"), /클릭하면 다시보기로 이동/);

        const anchors = Array.from(day.querySelectorAll("a.bcmb-day-tip-item"));
        assert.deepEqual(
            anchors.map((anchor) => anchor.getAttribute("href")),
            ["/video/7001", "/video/8001"]
        );

        const opened = [];
        fixture.dom.window.open = (url, target) => {
            opened.push({ url, target });
            return null;
        };

        day.dispatchEvent(
            new fixture.dom.window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })
        );
        assert.deepEqual(opened, [{ url: "/video/7001", target: "_blank" }]);
        assert.notEqual(widget.getAttribute("data-open"), "1");

        day.dispatchEvent(
            new fixture.dom.window.MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })
        );
        assert.equal(opened.length, 2);
        assert.equal(opened[1].url, "/video/7001");

        day.dispatchEvent(
            new fixture.dom.window.KeyboardEvent("keydown", {
                bubbles: true,
                cancelable: true,
                ctrlKey: true,
                key: "Enter",
            })
        );
        assert.equal(opened.length, 3);
        assert.notEqual(widget.getAttribute("data-open"), "1");

        // 툴팁의 앵커 밖 영역(제목) 클릭은 이동으로 치지 않는다.
        day.querySelector(".bcmb-day-tip-title").dispatchEvent(
            new fixture.dom.window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })
        );
        assert.equal(opened.length, 3);
        assert.notEqual(widget.getAttribute("data-open"), "1");
    } finally {
        await closeMonthlyBroadcastFixture(fixture);
    }
});

function evalAdblockPopupScripts(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "adblockPopup.js");
}

function evalFollowingRefreshScripts(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "followingRefresh.js");
}

async function loadAdblockPopupPage(dom) {
    evalAdblockPopupScripts(dom);
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
}

function getAdblockSuppressAttr(el) {
    return el.getAttribute(AD_SUPPRESS_ATTR);
}

test("adblock popup runs an initial pass before DOMContentLoaded", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div class="_dimmed_10ysp_2" id="dimmed">',
            '<div class="_container_10ysp_20 _modal_10ysp_27" id="modal" role="alertdialog" aria-modal="true">',
            ADBLOCK_POPUP_TITLE,
            "</div>",
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const dimmed = document.getElementById("dimmed");
    const modal = document.getElementById("modal");
    makeVisibleElement(dimmed, 1000, 800);
    makeVisibleElement(modal);

    evalAdblockPopupScripts(dom);

    assert.equal(getAdblockSuppressAttr(modal), "1");
    assert.equal(getAdblockSuppressAttr(dimmed), "1");
});

test("adblock popup keeps suppressing the legacy chzzk popup classes", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div class="popup_dimmed__zs78t" id="dimmed">',
            '<div class="popup_container__Aqx-3" id="popup">',
            ADBLOCK_POPUP_TITLE,
            "</div>",
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const dimmed = document.getElementById("dimmed");
    const popup = document.getElementById("popup");
    document.body.style.overflow = "hidden";
    document.body.style.paddingRight = "15px";
    makeVisibleElement(dimmed, 1000, 800);
    makeVisibleElement(popup);

    await loadAdblockPopupPage(dom);
    await waitForAsyncCallbacks();

    assert.equal(getAdblockSuppressAttr(popup), "1");
    assert.equal(getAdblockSuppressAttr(dimmed), "1");
    assert.match(
        document.getElementById("betterchzzk-adblock-popup-style").textContent,
        /\[data-betterchzzk-suppress-adblock-popup="1"\]/
    );
    assert.equal(document.body.style.overflow, "");
    assert.equal(document.body.style.paddingRight, "");
});

test("adblock popup keeps suppressing legacy popup classes after css module hashes change", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div class="popup_dimmed__nextHash" id="dimmed">',
            '<div class="popup_container__nextHash" id="popup">',
            ADBLOCK_POPUP_TITLE,
            "</div>",
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const dimmed = document.getElementById("dimmed");
    const popup = document.getElementById("popup");
    makeVisibleElement(dimmed, 1000, 800);
    makeVisibleElement(popup);

    await loadAdblockPopupPage(dom);

    assert.equal(getAdblockSuppressAttr(popup), "1");
    assert.equal(getAdblockSuppressAttr(dimmed), "1");
});

test("adblock popup suppresses the current chzzk alertdialog modal after it appears", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/live/test-channel", chrome);
    const { document } = dom.window;
    document.body.style.overflow = "hidden";
    document.body.style.paddingRight = "15px";

    await loadAdblockPopupPage(dom);

    const dimmed = document.createElement("div");
    dimmed.id = "dimmed";
    dimmed.className = "_dimmed_10ysp_2";
    const modal = document.createElement("div");
    modal.id = "modal";
    modal.className = "_container_10ysp_20 _modal_10ysp_27";
    modal.setAttribute("role", "alertdialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = `<strong>${ADBLOCK_POPUP_TITLE}</strong><p>\uAD11\uACE0 \uCC28\uB2E8 \uD504\uB85C\uADF8\uB7A8 \uC0AC\uC6A9 \uC2DC \uC7AC\uC0DD \uD658\uACBD\uC5D0 \uC601\uD5A5\uC744 \uBBF8\uCE60 \uC218 \uC788\uC2B5\uB2C8\uB2E4.</p>`;
    dimmed.appendChild(modal);
    makeVisibleElement(dimmed, 1000, 800);
    makeVisibleElement(modal);
    document.body.appendChild(dimmed);

    await waitForAsyncCallbacks();

    assert.equal(getAdblockSuppressAttr(modal), "1");
    assert.equal(getAdblockSuppressAttr(dimmed), "1");
    assert.equal(document.body.style.overflow, "");
    assert.equal(document.body.style.paddingRight, "");
});

test("adblock popup does not suppress unrelated extension alertdialogs", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div class="_dimmed_10ysp_2" id="dimmed">',
            '<div class="_container_10ysp_20 _modal_10ysp_27" id="modal" role="alertdialog" aria-modal="true">',
            "\uD655\uC7A5 \uD504\uB85C\uADF8\uB7A8 \uC124\uCE58 \uC548\uB0B4",
            "</div>",
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const dimmed = document.getElementById("dimmed");
    const modal = document.getElementById("modal");
    makeVisibleElement(dimmed, 1000, 800);
    makeVisibleElement(modal);

    await loadAdblockPopupPage(dom);

    assert.equal(getAdblockSuppressAttr(modal), null);
    assert.equal(getAdblockSuppressAttr(dimmed), null);
});

test("options page renders defaults and dependency-disabled controls without extension storage", () => {
    const dom = createDom("options.html", "options.html");

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document, BetterChzzkSettings } = dom.window;
    const optionInputs = Array.from(document.querySelectorAll("[data-option]"));
    const notice = document.getElementById("notice");

    assert.equal(optionInputs.length, BetterChzzkSettings.OPTION_KEYS.length);
    assert.equal(queryOption(document, "skipSeconds").value, String(BetterChzzkSettings.DEFAULT_OPTIONS.skipSeconds));
    assert.equal(queryOption(document, "vodBroadcastClockEnabled").checked, false);
    assert.equal(document.getElementById("save").disabled, true, "변경 전에는 저장 버튼이 비활성화된다");
    assert.equal(notice.dataset.state, "saved");
    assert.match(notice.textContent, /기능 \d+개/);

    const skipControl = queryOption(document, "skipControlEnabled");
    const skipKeyboard = queryOption(document, "skipKeyboardEnabled");
    const skipSeconds = queryOption(document, "skipSeconds");

    skipControl.checked = false;
    dispatch(dom, skipControl, "change");

    assert.equal(skipKeyboard.disabled, true);
    assert.equal(skipSeconds.disabled, true);
    assert.equal(skipKeyboard.closest("[data-depends-on]").classList.contains("is-disabled"), true);
});

test("options compact tab switches align the new panel below the sticky toolbar", () => {
    const dom = createDom("options.html", "options.html");
    const scrollCalls = [];

    Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 400 });
    Object.defineProperty(dom.window, "scrollY", { configurable: true, value: 500 });
    dom.window.scrollTo = (options) => scrollCalls.push(options);

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document } = dom.window;
    const toolbar = document.querySelector(".settings-toolbar");
    const chatPanel = document.getElementById("tab-panel-2");
    toolbar.getBoundingClientRect = () => ({ height: 82 });
    chatPanel.getBoundingClientRect = () => ({ top: -300 });

    assert.equal(scrollCalls.length, 0, "initial tab restore must not move the popup");
    document.getElementById("tab-2").click();

    assert.equal(scrollCalls.length, 1);
    assert.equal(scrollCalls[0].top, 110);
    assert.equal(scrollCalls[0].behavior, "auto");
    assert.equal(chatPanel.classList.contains("is-active"), true);
});

test("options player controls merge playback defaults", () => {
    const dom = createDom("options.html", "options.html");

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document } = dom.window;
    const tabLabels = Array.from(document.querySelectorAll(".tab"), (tab) => tab.textContent.trim());
    const sectionLabels = Array.from(document.querySelectorAll(".settings-card h2"), (heading) =>
        heading.textContent.trim()
    );
    const section = queryOption(document, "skipControlEnabled").closest(".settings-card");
    const optionOrder = Array.from(section.querySelectorAll("[data-option]")).map((input) => input.dataset.option);
    const groupLabels = Array.from(section.querySelectorAll(".option-group > summary")).map((summary) =>
        summary.textContent.trim()
    );

    assert.deepEqual(tabLabels, ["플레이어", "시청 기록", "채팅", "팝업", "방송 시간", "검색", "탐색"]);
    assert.deepEqual(sectionLabels, [
        "플레이어",
        "시청 기록",
        "채팅 도구",
        "광고 차단 안내 팝업",
        "채널 방송 시간",
        "다시보기 검색",
        "방송 목록 필터",
    ]);
    assert.equal(section.querySelector("h2").textContent.trim(), "플레이어");
    assert.deepEqual(groupLabels, ["자동 처리", "시간 이동", "볼륨", "오디오 컴프레서", "다시보기·단축키"]);
    assert.deepEqual(optionOrder, [
        "autoQualityEnabled",
        "rewardAutoCollectEnabled",
        "skipControlEnabled",
        "skipKeyboardEnabled",
        "skipLivePauseResumeEnabled",
        "timeMachineLagLabelEnabled",
        "skipPillEnabled",
        "skipLivePillEnabled",
        "skipSeconds",
        "skipWheelStep",
        "skipWheelShiftStep",
        "skipWheelAltStep",
        "volumeWheelEnabled",
        "volumeWheelStep",
        "volumeTooltipEnabled",
        "audioCompressorEnabled",
        "audioCompressorThreshold",
        "audioCompressorKnee",
        "audioCompressorRatio",
        "audioCompressorAttack",
        "audioCompressorRelease",
        "audioCompressorMakeupGain",
        "vodBroadcastClockEnabled",
        "holdSpeedEnabled",
    ]);
});

test("options places chat tools controls in a dedicated section", () => {
    const dom = createDom("options.html", "options.html");

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document } = dom.window;
    const section = queryOption(document, "chatToolsShowBlindEnabled").closest(".settings-card");
    const optionOrder = Array.from(section.querySelectorAll("[data-option]")).map((input) => input.dataset.option);
    const showBlind = queryOption(document, "chatToolsShowBlindEnabled");
    const moderatorBox = queryOption(document, "chatToolsModeratorBoxEnabled");
    const maxMessages = queryOption(document, "chatToolsMaxModeratorMessages");
    const groupLabels = Array.from(section.querySelectorAll(".option-group > summary"), (summary) =>
        summary.textContent.trim()
    );

    assert.equal(section.querySelector("h2").textContent.trim(), "채팅 도구");
    assert.deepEqual(optionOrder, [
        "vodCommentTabsEnabled",
        "chatTimestampEnabled",
        "chatToolsShowBlindEnabled",
        "chatToolsModeratorBoxEnabled",
        "chatToolsMaxModeratorMessages",
    ]);
    assert.deepEqual(groupLabels, ["댓글·표시", "채팅 관리"]);
    assert.equal(showBlind.disabled, false);
    assert.equal(maxMessages.disabled, true);

    moderatorBox.checked = true;
    dispatch(dom, moderatorBox, "change");

    assert.equal(maxMessages.disabled, false);
});

test("options places following controls with exploration controls", () => {
    const dom = createDom("options.html", "options.html");

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document } = dom.window;
    const previewSection = queryOption(document, "followingPreviewTooltipEnabled").closest(".settings-card");
    const explorationSection = queryOption(document, "categoryToolsEnabled").closest(".settings-card");
    const followingRefreshSection = queryOption(document, "followingRefreshEnabled").closest(".settings-card");
    const optionOrder = Array.from(explorationSection.querySelectorAll("[data-option]")).map(
        (input) => input.dataset.option
    );

    assert.equal(previewSection, explorationSection);
    assert.equal(followingRefreshSection, explorationSection);
    assert.ok(optionOrder.indexOf("followingRefreshEnabled") < optionOrder.indexOf("followingRefreshSeconds"));
    assert.ok(optionOrder.indexOf("followingRefreshSeconds") < optionOrder.indexOf("categoryToolsEnabled"));
    assert.ok(optionOrder.indexOf("categoryToolsLiveElapsedEnabled") < optionOrder.indexOf("titleTooltipEnabled"));
    assert.ok(optionOrder.indexOf("titleTooltipEnabled") < optionOrder.indexOf("followingPreviewTooltipEnabled"));
    assert.ok(
        optionOrder.indexOf("followingPreviewTooltipEnabled") < optionOrder.indexOf("followingPreviewSoundEnabled")
    );
    assert.ok(
        optionOrder.indexOf("followingPreviewSoundEnabled") < optionOrder.indexOf("followingPreviewVolumePercent")
    );
    assert.ok(
        optionOrder.indexOf("followingPreviewVolumePercent") < optionOrder.indexOf("livePreviewRightClickSoundEnabled")
    );
    assert.deepEqual(
        Array.from(explorationSection.querySelectorAll(".option-group > summary"), (summary) =>
            summary.textContent.trim()
        ),
        [
            "목록 새로고침",
            "검색·목록 표시",
            "호버 미리보기",
            "팔로워 필터 기준값",
            "시청자·조회수 필터 기준값",
            "진행 시간 필터 기준값",
            "데이터 조회",
        ]
    );
});

test("options groups stay accessible and never disable their own master toggle", () => {
    const dom = createDom("options.html", "options.html");

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document } = dom.window;
    const groups = Array.from(document.querySelectorAll(".option-group"));
    const playerAuto = document.querySelector('[data-option-group="player-auto"]');
    const playerCompressor = document.querySelector('[data-option-group="player-compressor"]');

    assert.ok(groups.length >= 10);
    assert.equal(document.querySelector(".advanced-settings"), null);
    assert.equal(document.querySelector(".section-heading p"), null);
    assert.equal(document.querySelector(".toggle-row small"), null);
    assert.equal(document.querySelectorAll(".option-group[open]").length, 5);
    assert.equal(playerAuto.open, true);
    assert.equal(playerCompressor.open, false);

    for (const group of groups) {
        const summary = group.firstElementChild;
        const icon = summary.querySelector(".option-group-title > svg");
        assert.equal(summary?.tagName, "SUMMARY");
        assert.ok(summary.textContent.trim().length > 0);
        assert.equal(summary.querySelector("input, button, a[href]"), null);
        assert.equal(summary.querySelectorAll(".option-group-title").length, 1);
        if (group === playerAuto) assert.equal(icon, null);
        else assert.equal(icon?.getAttribute("aria-hidden"), "true");
        assert.equal(
            Array.from(group.children).filter((child) => child.classList.contains("option-group-body")).length,
            1
        );
    }

    const tabs = Array.from(document.querySelectorAll(".tab"));
    const panels = Array.from(document.querySelectorAll(".settings-form > .settings-card"));
    assert.equal(document.body.classList.contains("options-body"), true);
    assert.equal(tabs.length, 7);
    assert.equal(panels.length, tabs.length);
    assert.equal(document.querySelectorAll(".section-heading-icon[aria-hidden='true']").length, 7);
    assert.ok(tabs.every((tab) => tab.getAttribute("aria-label") && tab.getAttribute("title")));
    assert.equal(document.querySelector("#reset svg")?.getAttribute("aria-hidden"), "true");

    for (const dependencyGroup of document.querySelectorAll("[data-depends-on]")) {
        for (const optionKey of dependencyGroup.dataset.dependsOn.split(/\s+/).filter(Boolean)) {
            const masterInput = queryOption(document, optionKey);
            assert.ok(masterInput, `${optionKey} dependency must reference an existing option`);
            assert.equal(
                dependencyGroup.contains(masterInput),
                false,
                `${optionKey} must stay outside its own dependency group`
            );
        }
    }
});

test("options match the wide reference layout and keep a compact popup layout", () => {
    const styles = readRepoFile("styles.css");
    const readRule = (selector) => {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return styles.match(new RegExp(`(?:^|\\r?\\n)[ \\t]*${escaped}[ \\t]*\\{([^}]*)\\}`))?.[1] || "";
    };

    const pageRule = readRule(".options-body .options-page");
    const toggleRule = readRule(".options-body .options-page .toggle-row");
    const groupRule = readRule(".options-body .options-page .option-group");
    const summaryRule = readRule(".options-body .options-page .option-group > summary");
    const summaryFocusRule = readRule(".option-group > summary:focus-visible");
    const activeTabRule = readRule(".options-body .options-page .tab.is-active");
    const activeTabLineRule = readRule(".options-body .options-page .tab.is-active::after");
    const compactTabLabelRule = readRule(".options-body .options-page .tab span");
    const noteRule = readRule(".options-body .options-page .setting-note");
    const unitRule = readRule(".options-body .options-page .number-grid em");
    const responsiveStart = styles.lastIndexOf("@media (max-width: 860px)");
    const responsiveEnd = styles.indexOf("@media (max-width: 640px)", responsiveStart);
    const responsiveRules = styles.slice(responsiveStart, responsiveEnd);
    const compactStart = styles.lastIndexOf("@media (max-width: 640px)");
    const compactEnd = styles.indexOf("@media (max-width: 480px)", compactStart);
    const compactRules = styles.slice(compactStart, compactEnd);
    const popupStart = styles.lastIndexOf("@media (max-width: 480px)");
    const popupEnd = styles.indexOf("@media (max-width: 360px)", popupStart);
    const popupRules = styles.slice(popupStart, popupEnd);
    const referenceStart = styles.indexOf("/* Options page — reference layout");
    const referenceRules = styles.slice(referenceStart);

    assert.match(pageRule, /width:\s*min\(1344px, 100%\)/);
    assert.match(toggleRule, /min-height:\s*58px/);
    assert.match(groupRule, /border:\s*1px solid var\(--border\)/);
    assert.match(groupRule, /border-radius:\s*9px/);
    assert.match(summaryRule, /min-height:\s*54px/);
    assert.match(summaryRule, /padding:\s*0 22px/);
    assert.match(summaryFocusRule, /var\(--focus-ring\)/);
    assert.match(activeTabRule, /color:\s*var\(--accent-text\)/);
    assert.match(activeTabRule, /background:\s*transparent/);
    assert.match(activeTabLineRule, /height:\s*3px/);
    assert.match(activeTabLineRule, /background:\s*var\(--accent\)/);
    assert.match(compactTabLabelRule, /clip:\s*rect\(0, 0, 0, 0\)/);
    assert.match(popupRules, /grid-template-columns:\s*repeat\(7, minmax\(0, 1fr\)\)/);
    assert.match(
        compactRules,
        /\.options-body \.options-page \.option-group-body > \.number-grid\s*\{\s*grid-template-columns:\s*1fr/
    );
    assert.match(popupRules, /\.options-body \.options-page \.reset-row \.secondary-button\s*\{\s*width:\s*100%/);
    assert.match(popupRules, /grid-template-columns:\s*48px minmax\(0, 1fr\)/);
    assert.match(
        popupRules,
        /\.options-body \.options-page \.brand-mark\s*\{[^}]*grid-row:\s*1 \/ 3[^}]*width:\s*48px/s
    );
    assert.match(popupRules, /\.options-body \.options-page \.hero-actions\s*\{[^}]*grid-column:\s*2/s);
    assert.doesNotMatch(referenceRules, /(?:^|\n)\s*\.options-page(?:[\s,.#:[>+]|$)/);
    assert.match(noteRule, /color:\s*var\(--text-muted\)/);
    assert.match(noteRule, /font-size:\s*13px/);
    assert.match(responsiveRules, /\.options-body \.options-page \.setting-note\s*\{[^}]*font-size:\s*11px/s);
    assert.match(unitRule, /color:\s*var\(--text-muted\)/);
    assert.doesNotMatch(referenceRules, /padding-bottom:\s*(?:68|74)px|\.action-bar/);
});

test("extension pages keep explicit light and dark theme contrast with a responsive history action bar", () => {
    const styles = readRepoFile("styles.css");
    const mobileStart = styles.indexOf("@media (max-width: 480px)");
    const mobileEnd = styles.indexOf("@media (max-width: 360px)", mobileStart);
    const mobileRules = styles.slice(mobileStart, mobileEnd);

    assert.match(styles, /:root\[data-theme="light"\]\s*\{[^}]*--accent-text:\s*#007f50/s);
    assert.match(styles, /:root\[data-theme="dark"\]\s*\{[^}]*--history-level-3:/s);
    assert.match(styles, /\.history-day\[data-level="2"\]\s*\{\s*background:\s*var\(--history-level-2\)/);
    assert.match(styles, /\.primary-button:disabled,[^{]+\{[^}]*opacity:\s*0\.5/s);
    assert.match(styles, /\.options-body \.options-page \.save-button:disabled\s*\{[^}]*opacity:\s*0\.72/s);
    assert.match(
        styles,
        /\.history-page > \.action-bar\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s
    );
    assert.match(mobileRules, /\.history-page \.action-bar\s*\{[^}]*position:\s*fixed[^}]*backdrop-filter:\s*blur/s);
});

test("options search keeps dependency controls visible and restores previous group state", () => {
    const dom = createDom("options.html", "options.html");

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document } = dom.window;
    const search = document.getElementById("settingsSearch");
    const playerAuto = document.querySelector('[data-option-group="player-auto"]');
    const playerCompressor = document.querySelector('[data-option-group="player-compressor"]');
    const playerSeek = document.querySelector('[data-option-group="player-seek"]');
    const compressorToggle = queryOption(document, "audioCompressorEnabled");
    const makeupGain = queryOption(document, "audioCompressorMakeupGain");

    assert.equal(playerAuto.open, true);
    assert.equal(playerCompressor.open, false);

    search.value = "보정 게인";
    dispatch(dom, search, "input");

    assert.equal(playerCompressor.open, true);
    assert.equal(playerCompressor.classList.contains("search-miss"), false);
    assert.equal(playerAuto.classList.contains("search-miss"), true);
    assert.equal(compressorToggle.closest(".toggle-row").classList.contains("search-miss"), false);
    assert.equal(makeupGain.disabled, true);

    compressorToggle.checked = true;
    dispatch(dom, compressorToggle, "change");

    assert.equal(makeupGain.disabled, false);

    search.value = "왼쪽·오른쪽 방향키";
    dispatch(dom, search, "input");

    assert.equal(
        Array.from(playerSeek.querySelectorAll(".option-group-body > *")).every(
            (element) => !element.classList.contains("search-miss")
        ),
        true
    );

    search.value = "댓글 검색 지연";
    dispatch(dom, search, "input");

    const videoSearchToggle = queryOption(document, "videoSearchEnabled");
    const commentSearchToggle = queryOption(document, "videoSearchCommentEnabled");
    assert.equal(videoSearchToggle.closest(".toggle-row").classList.contains("search-miss"), false);
    assert.equal(commentSearchToggle.closest(".toggle-row").classList.contains("search-miss"), false);
    assert.equal(videoSearchToggle.closest(".option-group").open, true);
    assert.equal(commentSearchToggle.closest(".option-group").open, true);

    search.value = "라이브에도 스킵 버튼 표시";
    dispatch(dom, search, "input");

    for (const optionKey of ["skipControlEnabled", "skipPillEnabled", "skipLivePillEnabled"]) {
        assert.equal(queryOption(document, optionKey).closest(".toggle-row").classList.contains("search-miss"), false);
    }

    search.value = "";
    dispatch(dom, search, "input");

    assert.equal(playerAuto.open, true);
    assert.equal(playerCompressor.open, false);
    assert.equal(document.querySelector(".option-group.search-miss"), null);
});

test("shared selector registry preserves lookup priority and warns once per stale anchor", async () => {
    const dom = createPageDom(
        `
        <div id="generic-dimmed" class="overlay"></div>
        <div id="legacy-dimmed" class="popup_dimmed__zs78t"></div>
        <div id="popup-start" class="popup_container__newHash"></div>
        <div id="popup-second" class="other popup_container__newerHash"></div>
        `,
        "https://chzzk.naver.com/live/selector-test",
        createFakeChrome()
    );
    const warnings = [];
    dom.window.console.warn = (...args) => warnings.push(args.join(" "));

    evalRepoScript(dom, "shared", "selectors.js");

    const { CHZZK, queryChain, queryChainAll, watchSelector } = dom.window.BetterChzzk.selectors;
    assert.equal(queryChain(dom.window.document, CHZZK.popupDimmed)?.id, "legacy-dimmed");
    assert.deepEqual(
        Array.from(queryChainAll(dom.window.document, CHZZK.popupDimmed), (element) => element.id),
        ["legacy-dimmed"]
    );
    assert.equal(queryChain(dom.window.document, CHZZK.popupContainer)?.id, "popup-start");

    dom.window.document.querySelector("#popup-start").remove();
    assert.equal(queryChain(dom.window.document, CHZZK.popupContainer)?.id, "popup-second");

    watchSelector("playerRoot", dom.window.document, 0);
    watchSelector("playerRoot", dom.window.document, 0);
    await waitForAsyncCallbacks();

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /selector stale: playerRoot/);
    dom.window.close();
});

test("manifest loads shared and playback scripts in the expected worlds", () => {
    const manifest = JSON.parse(readRepoFile("manifest.json"));
    const packageJson = JSON.parse(readRepoFile("package.json"));
    const mainScript = manifest.content_scripts.find((entry) => entry.world === "MAIN");
    const isolatedScript = manifest.content_scripts.find((entry) => entry.js?.includes("features/volumeWheel.js"));
    const vodCommentModules = [
        "features/vodComments/model.js",
        "features/vodComments/repository.js",
        "features/vodComments/nativeAdapter.js",
        "features/vodComments/view.js",
    ];

    assert.ok(mainScript);
    assert.ok(isolatedScript);
    assert.equal(manifest.version, "1.2.4");
    assert.equal(packageJson.version, manifest.version);
    assert.deepEqual(manifest.permissions, ["storage"]);
    assert.deepEqual(manifest.host_permissions, ["https://api.chzzk.naver.com/*", "https://apis.naver.com/*"]);
    assert.deepEqual(manifest.optional_host_permissions, ["https://*.pstatic.net/*"]);
    assert.ok(mainScript.js.includes("features/routeBridgePage.js"));
    assert.equal(mainScript.js.includes("features/followingPreviewPage.js"), false);
    assert.ok(
        mainScript.js.indexOf("features/routeBridgePage.js") < mainScript.js.indexOf("features/autoQualityPage.js")
    );
    assert.ok(mainScript.js.includes("features/volumeWheelPage.js"));
    assert.ok(
        mainScript.js.indexOf("features/volumeWheelPage.js") > mainScript.js.indexOf("features/autoQualityPage.js")
    );
    assert.ok(isolatedScript.js.includes("features/volumeWheel.js"));
    assert.ok(isolatedScript.js.includes("vendor/hls.light.min.js"));
    assert.ok(isolatedScript.js.includes("features/followingPreviewTooltip.js"));
    assert.ok(isolatedScript.js.includes("shared/selectors.js"));
    assert.ok(isolatedScript.js.indexOf("shared/selectors.js") > isolatedScript.js.indexOf("shared/data.js"));
    assert.ok(isolatedScript.js.indexOf("shared/selectors.js") < isolatedScript.js.indexOf("content.js"));
    assert.ok(isolatedScript.js.includes("shared/vodTimeline.js"));
    assert.ok(isolatedScript.js.indexOf("shared/vodTimeline.js") > isolatedScript.js.indexOf("content.js"));
    assert.ok(
        isolatedScript.js.indexOf("shared/vodTimeline.js") < isolatedScript.js.indexOf("features/vodBroadcastClock.js")
    );
    assert.ok(
        isolatedScript.js.indexOf("shared/vodTimeline.js") <
            isolatedScript.js.indexOf("features/monthlyBroadcastTime.js")
    );
    assert.ok(isolatedScript.js.indexOf("features/volumeWheel.js") > isolatedScript.js.indexOf("content.js"));
    assert.ok(
        isolatedScript.js.indexOf("vendor/hls.light.min.js") <
            isolatedScript.js.indexOf("features/followingPreviewTooltip.js")
    );
    assert.ok(isolatedScript.js.includes("features/chatTools.js"));
    assert.ok(
        isolatedScript.js.indexOf("features/chatTools.js") > isolatedScript.js.indexOf("features/rewardAutoCollect.js")
    );
    assert.ok(
        isolatedScript.js.indexOf("features/chatTools.js") < isolatedScript.js.indexOf("features/videoSearch.js")
    );
    assert.ok(isolatedScript.js.includes("features/vodCommentTabs.js"));
    assert.ok(
        isolatedScript.js.indexOf("features/vodCommentTabs.js") >
            isolatedScript.js.indexOf("features/vodReplayChatFix.js")
    );
    for (const modulePath of vodCommentModules) {
        assert.ok(isolatedScript.js.includes(modulePath));
        assert.ok(isolatedScript.js.indexOf(modulePath) < isolatedScript.js.indexOf("features/vodCommentTabs.js"));
    }
    assert.deepEqual(
        vodCommentModules.map((modulePath) => isolatedScript.js.indexOf(modulePath)),
        [...vodCommentModules]
            .map((modulePath) => isolatedScript.js.indexOf(modulePath))
            .sort((left, right) => left - right)
    );
    assert.ok(isolatedScript.js.includes("features/holdSpeed.js"));
    assert.ok(isolatedScript.js.includes("features/shortcutRescue.js"));
    assert.ok(
        isolatedScript.js.indexOf("features/holdSpeed.js") < isolatedScript.js.indexOf("features/shortcutRescue.js")
    );
});

async function loadVideoSearchPage(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "videoSearch.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();
}

async function loadCategoryToolsPage(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "categoryTools.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();
}

function setElementRect(el, { left = 0, top = 0, width = 100, height = 40 } = {}) {
    el.getBoundingClientRect = () => ({
        x: left,
        y: top,
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
    });
}

function createCategoryToolsDom(chrome) {
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<nav id="tabs">',
            "<button>라이브</button>",
            "<button>동영상</button>",
            "<button>클립</button>",
            "</nav>",
            '<main id="grid">',
            '<article id="card-a"><a href="/live/channel-a"><strong>Alpha live</strong><span>LIVE 10명</span></a></article>',
            '<article id="card-b"><a href="/live/channel-b"><strong>Beta live</strong><span>LIVE 20명</span></a></article>',
            "</main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/category/game/test/lives",
        chrome
    );
    const { document } = dom.window;
    setElementRect(document.getElementById("tabs"), { left: 16, top: 20, width: 360, height: 40 });
    document.querySelectorAll("#tabs button").forEach((button, index) => {
        setElementRect(button, { left: 24 + index * 80, top: 24, width: 70, height: 32 });
    });
    setElementRect(document.getElementById("grid"), { left: 16, top: 100, width: 760, height: 560 });
    setElementRect(document.getElementById("card-a"), { left: 24, top: 120, width: 320, height: 180 });
    setElementRect(document.querySelector('#card-a a[href="/live/channel-a"]'), {
        left: 24,
        top: 120,
        width: 320,
        height: 180,
    });
    setElementRect(document.getElementById("card-b"), { left: 24, top: 5000, width: 320, height: 180 });
    setElementRect(document.querySelector('#card-b a[href="/live/channel-b"]'), {
        left: 24,
        top: 5000,
        width: 320,
        height: 180,
    });
    return dom;
}

function createGlobalLivesDom(chrome, { nestedScroll = false } = {}) {
    const scrollOpen = nestedScroll ? '<div id="scroll-shell" style="overflow-y:auto">' : "";
    const scrollClose = nestedScroll ? "</div>" : "";
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<section id="global-section">',
            '<nav id="global-tabs"><a href="/lives" aria-current="page">라이브</a><a href="/videos">동영상</a></nav>',
            '<div id="native-filter"><input type="search" placeholder="태그 검색" aria-label="태그 검색"></div>',
            '<div id="sort-row">',
            '<button aria-selected="true">인기</button>',
            "<button>최신</button>",
            "<button>추천</button>",
            "</div>",
            scrollOpen,
            '<main id="grid">',
            '<article id="live-card-a">' +
                '<a class="_thumbnail" href="/live/native-a">' +
                '<img src="https://example.com/a.jpg" width="320" height="180" alt=""></a>' +
                '<a class="_title" href="/live/native-a"><strong class="_live_title">Native A</strong></a>' +
                "<span>LIVE 10명</span>" +
                '<a class="_image" href="/live/native-a"><span class="_blind">Template Channel 채널로 이동</span></a>' +
                '<a class="_channel" href="/live/native-a" aria-label="Template Channel 채널로 이동" ' +
                'title="Template Channel"><span class="_ellipsis"><span class="_text">Template Channel</span></span>' +
                '<span class="_blind">Template Channel 채널로 이동</span>' +
                '<span data-bcgt-follower-wrap="1"><span data-bcgt-follower-badge="1">44.7만</span></span>' +
                "</a></article>",
            '<article id="live-card-b">' +
                '<a class="_thumbnail" href="/live/native-b">' +
                '<img src="https://example.com/b.jpg" width="320" height="180" alt=""></a>' +
                '<a class="_title" href="/live/native-b"><strong class="_live_title">Native B</strong></a>' +
                "<span>LIVE 20명</span>" +
                '<a class="_image" href="/live/native-b">' +
                '<span class="_blind">Second Template Channel 채널로 이동</span></a>' +
                '<a class="_channel" href="/live/native-b" aria-label="Second Template Channel 채널로 이동" ' +
                'title="Second Template Channel">' +
                '<span class="_ellipsis"><span class="_text">Second Template Channel</span></span>' +
                '<span class="_blind">Second Template Channel 채널로 이동</span>' +
                '<span data-bcgt-follower-wrap="1"><span data-bcgt-follower-badge="1">99.9만</span></span>' +
                "</a></article>",
            '<div id="native-sentinel">Loading</div>',
            "</main>",
            scrollClose,
            "</section>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/lives",
        chrome
    );
    const { document } = dom.window;
    setElementRect(document.getElementById("global-section"), { left: 16, top: 96, width: 1160, height: 1200 });
    setElementRect(document.getElementById("global-tabs"), { left: 32, top: 112, width: 1120, height: 48 });
    document.querySelectorAll("#global-tabs a").forEach((tab, index) => {
        setElementRect(tab, { left: 40 + index * 88, top: 120, width: 76, height: 32 });
    });
    setElementRect(document.getElementById("native-filter"), { left: 32, top: 168, width: 1120, height: 68 });
    setElementRect(document.querySelector("#native-filter input"), { left: 896, top: 184, width: 240, height: 36 });
    setElementRect(document.getElementById("sort-row"), { left: 32, top: 209, width: 1120, height: 44 });
    document.querySelectorAll("#sort-row button").forEach((button, index) => {
        setElementRect(button, { left: 40 + index * 70, top: 215, width: 60, height: 32 });
    });
    setElementRect(document.getElementById("grid"), { left: 32, top: 280, width: 1120, height: 900 });
    setElementRect(document.getElementById("live-card-a"), { left: 40, top: 300, width: 320, height: 240 });
    setElementRect(document.querySelector("#live-card-a a._thumbnail"), {
        left: 40,
        top: 300,
        width: 320,
        height: 180,
    });
    setElementRect(document.getElementById("live-card-b"), { left: 384, top: 300, width: 320, height: 240 });
    setElementRect(document.querySelector("#live-card-b a._thumbnail"), {
        left: 384,
        top: 300,
        width: 320,
        height: 180,
    });
    // global-lives 카드 판정은 링크 내부 미디어의 실제 rect(120x70 이상)를 요구한다.
    setElementRect(document.querySelector("#live-card-a img"), { left: 40, top: 300, width: 320, height: 180 });
    setElementRect(document.querySelector("#live-card-b img"), { left: 384, top: 300, width: 320, height: 180 });

    const getDefaultRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function getFixtureRect() {
        if (this.id === "betterchzzk-category-tools") {
            return {
                x: 300,
                y: 213,
                left: 300,
                top: 213,
                right: 820,
                bottom: 253,
                width: 520,
                height: 40,
            };
        }
        return getDefaultRect.call(this);
    };
    if (nestedScroll) {
        const shell = document.getElementById("scroll-shell");
        Object.defineProperties(shell, {
            clientHeight: { configurable: true, value: 600 },
            scrollHeight: { configurable: true, value: 2400 },
        });
    }
    return dom;
}

// 주입 카드가 경과 시간 배지 interval을 살려두므로, 기능을 꺼서 타이머를 정리하고 창을 닫는다.
async function closeCategoryToolsFixture(dom, chrome) {
    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ categoryToolsEnabled: { newValue: false } }, "sync");
    }
    await waitForAsyncCallbacks();
    dom.window.close();
}

const DEFAULT_GLOBAL_LIVES_FIXTURE = [
    {
        liveId: 500000,
        openDate: "2026-04-01 01:00:00",
        adult: false,
        channelId: "old-1",
        channelName: "Old Channel One",
        title: "Oldest live",
        views: 250,
    },
    {
        liveId: 500500,
        openDate: "2026-04-03 01:00:00",
        adult: false,
        channelId: "old-2",
        channelName: "Old Channel Two",
        title: "Second oldest",
        views: 50,
    },
    { liveId: 501000, openDate: "2026-04-05 01:00:00", adult: true, channelId: "old-adult", title: "Adult live" },
    ...Array.from({ length: 9 }, (_, index) => ({
        liveId: 999991 + index,
        openDate: `2026-07-06 0${index}:00:00`,
        adult: false,
        channelId: `new-${index}`,
        title: `Recent ${index}`,
    })),
];

// /v1/lives 목업: liveId가 openDate와 단조 증가하는 가상 라이브 목록.
// 커서(liveId) 미만을 내림차순으로 페이지네이션해 실제 API의 커서 점프 동작을 흉내 낸다.
function createGlobalLivesApiMock(lives = DEFAULT_GLOBAL_LIVES_FIXTURE) {
    return function livesResponse(href) {
        const url = new URL(href);
        const size = Number(url.searchParams.get("size")) || 50;
        const cursor = url.searchParams.get("liveId");
        let rows = lives.slice().sort((a, b) => b.liveId - a.liveId);
        if (cursor !== null) rows = rows.filter((row) => row.liveId < Number(cursor));
        const pageRows = rows.slice(0, size);
        const hasMore = rows.length > pageRows.length;
        return {
            content: {
                data: pageRows.map((row) => ({
                    liveId: row.liveId,
                    liveTitle: row.title,
                    liveImageUrl: `https://example.com/${row.channelId}_{type}.jpg`,
                    concurrentUserCount: row.views ?? 5,
                    openDate: row.openDate,
                    adult: row.adult,
                    tags: [],
                    liveCategoryValue: "테스트",
                    channel: { channelId: row.channelId, channelName: row.channelName || row.channelId },
                })),
                page: hasMore
                    ? { next: { concurrentUserCount: 0, liveId: pageRows[pageRows.length - 1].liveId } }
                    : { next: null },
            },
        };
    };
}

function createVideoSearchDom(chrome) {
    return createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main id="app">',
            '<section id="grid">',
            '<article><a href="/video/100"><strong>Existing 100</strong><span>1:00</span></a></article>',
            '<article><a href="/video/101"><strong>Existing 101</strong><span>1:00</span></a></article>',
            "</section>",
            "</main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/0123456789abcdef0123456789abcdef/videos",
        chrome
    );
}

function getVideoSearchInput(dom) {
    return dom.window.document.querySelector("#betterchzzk-video-search-bar input");
}

function searchVideoSearchInput(dom, value) {
    const input = getVideoSearchInput(dom);
    assert.ok(input);
    input.value = value;
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

test("video search input brightens the light theme text without changing the dark theme color", () => {
    const source = readRepoFile("features/videoSearch.js");

    assert.match(source, /--bcvs-text-strong:var\(--Content-Neutral-Cool-Strong, #C9CEDC\)/);
    assert.match(source, /--bcvs-input-text:color-mix\(in srgb, var\(--bcvs-text-strong\) 82%, #FFFFFF\)/);
    assert.match(source, /html\[dark\] #\$\{BAR_ID\},/);
    assert.match(source, /body\[theme="dark"\] #\$\{BAR_ID\},/);
    assert.match(source, /\.theme_dark #\$\{BAR_ID\}\{\s*--bcvs-input-text:var\(--bcvs-text-strong\);/);
    assert.match(source, /input\[type="search"\]\{[^}]*color:var\(--bcvs-input-text\)/);
    assert.doesNotMatch(source, /--bcvs-text-strong:var\(--Content-Neutral-Primary/);
});

test("category tools hydrates newly visible follower badges on scroll without a full apply pass", async () => {
    const chrome = createFakeChrome({
        sync: {
            categoryToolsFollowerFetchDelayMs: 0,
            categoryToolsFollowerFetchMaxPerPass: 10,
        },
    });
    const dom = createCategoryToolsDom(chrome);
    const clock = useFakePerformanceNow(dom);
    const { document } = dom.window;
    const requests = [];

    dom.window.fetch = async (url) => {
        const href = String(url);
        requests.push(href);

        if (href.includes("/v2/categories/")) {
            return {
                ok: true,
                json: async () => ({
                    content: {
                        data: [
                            {
                                liveTitle: "Alpha live",
                                concurrentUserCount: 10,
                                channel: { channelId: "channel-a", channelName: "Alpha" },
                            },
                            {
                                liveTitle: "Beta live",
                                concurrentUserCount: 20,
                                channel: { channelId: "channel-b", channelName: "Beta" },
                            },
                        ],
                        page: { next: null },
                    },
                }),
            };
        }

        const channelId = decodeURIComponent(href.match(/\/v1\/channels\/([^/?#]+)/)?.[1] || "");
        return {
            ok: true,
            json: async () => ({
                content: {
                    followerCount: channelId === "channel-a" ? 100 : 200,
                },
            }),
        };
    };

    await loadCategoryToolsPage(dom);

    await waitForCondition(() => requests.some((href) => href.includes("/v1/channels/channel-a")));
    assert.equal(requests.filter((href) => href.includes("/v2/categories/")).length, 1);
    assert.equal(
        requests.some((href) => href.includes("/v1/channels/channel-b")),
        false
    );

    clock.advance(1000);
    setElementRect(document.getElementById("card-b"), { left: 24, top: 220, width: 320, height: 180 });
    setElementRect(document.querySelector('#card-b a[href="/live/channel-b"]'), {
        left: 24,
        top: 220,
        width: 320,
        height: 180,
    });
    dom.window.dispatchEvent(new dom.window.Event("scroll"));

    await waitForCondition(() => requests.some((href) => href.includes("/v1/channels/channel-b")));
    assert.equal(requests.filter((href) => href.includes("/v2/categories/")).length, 1);
    assert.deepEqual(
        requests
            .filter((href) => href.includes("/v1/channels/"))
            .map((href) => decodeURIComponent(href.match(/\/v1\/channels\/([^/?#]+)/)?.[1] || "")),
        ["channel-a", "channel-b"]
    );
});

test("global lives duration filter uses openDate and keeps the native list path", async () => {
    const chrome = createFakeChrome({ sync: { categoryToolsFollowerBadgesEnabled: false } });
    const dom = createGlobalLivesDom(chrome);
    const now = Date.parse("2026-07-10T12:00:00Z");
    dom.window.Date.now = () => now;

    const { document } = dom.window;
    const grid = document.getElementById("grid");
    const sentinel = document.getElementById("native-sentinel");
    const addNativeCard = ({ cardId, channelId, title, top }) => {
        const card = document.getElementById("live-card-b").cloneNode(true);
        card.id = cardId;
        for (const anchor of card.querySelectorAll("a[href]")) {
            anchor.setAttribute("href", "/live/" + channelId);
        }
        card.querySelector("._live_title").textContent = title;
        grid.insertBefore(card, sentinel);
        setElementRect(card, { left: 40, top, width: 320, height: 240 });
        setElementRect(card.querySelector("a._thumbnail"), { left: 40, top, width: 320, height: 180 });
        setElementRect(card.querySelector("img"), { left: 40, top, width: 320, height: 180 });
        return card;
    };
    const missingDateCard = addNativeCard({
        cardId: "live-card-missing",
        channelId: "native-missing",
        title: "Missing open date",
        top: 560,
    });
    const futureDateCard = addNativeCard({
        cardId: "live-card-future",
        channelId: "native-future",
        title: "Future open date",
        top: 820,
    });

    const livesResponse = createGlobalLivesApiMock([
        {
            liveId: 500005,
            openDate: "2026-07-10T09:00:00Z",
            adult: false,
            channelId: "native-a",
            channelName: "Native Channel A",
            title: "Native A metadata",
            views: 250,
        },
        {
            liveId: 500004,
            openDate: "2026-07-10T11:30:00Z",
            adult: false,
            channelId: "native-b",
            channelName: "Native Channel B",
            title: "Native B metadata",
            views: 50,
        },
        {
            liveId: 500003,
            openDate: "",
            adult: false,
            channelId: "native-missing",
            channelName: "Missing Date Channel",
            title: "Missing date metadata",
            views: 30,
        },
        {
            liveId: 500002,
            openDate: "2026-07-10T13:00:00Z",
            adult: false,
            channelId: "native-future",
            channelName: "Future Date Channel",
            title: "Future date metadata",
            views: 20,
        },
        {
            liveId: 500001,
            openDate: "2026-07-10T08:30:00Z",
            adult: false,
            channelId: "injected-pass",
            channelName: "Duration Match Channel",
            title: "Injected duration match",
            views: 100,
        },
    ]);
    const requests = [];
    dom.window.fetch = async (url) => {
        const href = String(url);
        requests.push(href);
        if (href.includes("/v1/lives")) {
            return { ok: true, json: async () => livesResponse(href) };
        }
        return { ok: true, json: async () => ({ content: {} }) };
    };

    await loadCategoryToolsPage(dom);

    try {
        await waitForCondition(() => document.querySelector('[data-filter-options="duration"] .bcgt-option'));

        assert.equal(document.querySelector('[data-bcgt-time-chip="1"]'), null);
        assert.equal(
            requests.some((href) => href.includes("sortType=LATEST")),
            false
        );

        const toolbar = document.getElementById("betterchzzk-category-tools");
        const filterButton = toolbar.querySelector(".bcgt-filter");
        filterButton.click();

        const menu = document.getElementById("betterchzzk-category-filter-menu");
        const durationGroup = menu.querySelector('[data-filter-group="duration"]');
        assert.equal(durationGroup.hidden, false);
        assert.equal(menu.getAttribute("data-open"), "1");

        const durationRanges = Array.from(
            menu.querySelectorAll('[data-filter-kind="duration"]'),
            (button) => button.getAttribute("data-filter-min") + ":" + button.getAttribute("data-filter-max")
        );
        assert.deepEqual(durationRanges, [
            "0:0",
            "0:3600",
            "3600:7200",
            "7200:14400",
            "14400:21600",
            "21600:43200",
            "43200:86400",
            "86400:0",
        ]);

        const twoToFourHours = menu.querySelector(
            '[data-filter-kind="duration"][data-filter-min="7200"][data-filter-max="14400"]'
        );
        twoToFourHours.click();

        await waitForCondition(
            () =>
                document.getElementById("live-card-a").getAttribute("data-bcgt-hide") !== "1" &&
                document.getElementById("live-card-b").getAttribute("data-bcgt-hide") === "1" &&
                missingDateCard.getAttribute("data-bcgt-hide") === "1" &&
                futureDateCard.getAttribute("data-bcgt-hide") === "1" &&
                document.querySelector('[data-bcgt-injected="1"][data-bcgt-card-id="injected-pass"]'),
            { timeoutMs: 3000 }
        );

        assert.equal(toolbar.querySelector(".bcgt-filter-label").textContent, "필터 1");
        const injected = document.querySelector('[data-bcgt-injected="1"][data-bcgt-card-id="injected-pass"]');
        const injectedChannel = injected.querySelector("a._channel");
        const injectedPreviewHost = injected.querySelector('[data-bcgt-live-preview-host="1"]');
        assert.equal(injected.querySelector("a._title").textContent, "Injected duration match");
        assert.equal(injected.getAttribute("data-bcgt-live-id"), "500001");
        assert.equal(injected.getAttribute("data-bcgt-channel-id"), "injected-pass");
        assert.ok(injectedPreviewHost);
        assert.equal(injectedPreviewHost.getAttribute("href"), "/live/injected-pass");
        assert.equal(injectedChannel.querySelector("._text").textContent, "Duration Match Channel");
        assert.equal(injectedChannel.getAttribute("href"), "/live/injected-pass");
        assert.equal(injectedChannel.getAttribute("aria-label"), "Duration Match Channel 채널로 이동");
        assert.equal(injected.querySelector('[data-bcgt-follower-badge="1"]'), null);

        const durationMin = menu.querySelector('[data-filter-min-input="duration"]');
        const durationMax = menu.querySelector('[data-filter-max-input="duration"]');
        durationMin.value = "0.25";
        durationMin.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        durationMax.value = "1";
        durationMax.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

        await waitForCondition(
            () =>
                document.getElementById("live-card-a").getAttribute("data-bcgt-hide") === "1" &&
                document.getElementById("live-card-b").getAttribute("data-bcgt-hide") !== "1" &&
                missingDateCard.getAttribute("data-bcgt-hide") === "1" &&
                futureDateCard.getAttribute("data-bcgt-hide") === "1" &&
                injected.getAttribute("data-bcgt-hide") === "1",
            { timeoutMs: 3000 }
        );
        assert.equal(toolbar.querySelector(".bcgt-filter-label").textContent, "필터 1");

        menu.querySelector("[data-filter-reset]").click();
        await waitForCondition(
            () =>
                document.querySelector('[data-bcgt-injected="1"]') === null &&
                [
                    document.getElementById("live-card-a"),
                    document.getElementById("live-card-b"),
                    missingDateCard,
                    futureDateCard,
                ].every((card) => card.getAttribute("data-bcgt-hide") !== "1"),
            { timeoutMs: 3000 }
        );

        assert.equal(toolbar.querySelector(".bcgt-filter-label").textContent, "필터");
        assert.equal(toolbar.getAttribute("data-has-filter"), "0");
        assert.equal(document.querySelector('[data-bcgt-time-chip="1"]'), null);
        assert.equal(
            requests.some((href) => href.includes("sortType=LATEST")),
            false
        );
    } finally {
        await closeCategoryToolsFixture(dom, chrome);
    }
});

test("video search stores the comment device id in extension storage only", async () => {
    const chrome = createFakeChrome({ sync: { videoSearchCommentDelayMs: 0 } });
    const dom = createVideoSearchDom(chrome);
    const requests = [];

    dom.window.fetch = async (url, init = {}) => {
        requests.push({ url: String(url), init });
        if (String(url).includes("/videos?")) {
            return {
                ok: true,
                json: async () => ({
                    content: {
                        data: [{ videoNo: "200", videoTitle: "unmatched title" }],
                        last: true,
                    },
                }),
            };
        }
        return {
            ok: true,
            json: async () => ({
                content: {
                    comments: {
                        data: [{ comment: { content: "needle comment" } }],
                    },
                },
            }),
        };
    };

    await loadVideoSearchPage(dom);
    await waitForCondition(() => getVideoSearchInput(dom));

    searchVideoSearchInput(dom, "needle");
    await waitForCondition(() => requests.some((request) => request.init?.headers?.deviceId));

    const commentRequest = requests.find((request) => request.init?.headers?.deviceId);
    assert.ok(commentRequest.init.headers.deviceId);
    assert.equal(chrome.testState.local.betterchzzkCommentDeviceId, commentRequest.init.headers.deviceId);
    assert.equal(dom.window.localStorage.getItem("betterchzzk-comment-device-id"), null);
});

test("video search skips generic comment and progress fallbacks", async () => {
    const chrome = createFakeChrome({ sync: { videoSearchCommentDelayMs: 0 } });
    const dom = createVideoSearchDom(chrome);
    const { document } = dom.window;
    const requests = [];

    document
        .querySelector('a[href="/video/100"]')
        .insertAdjacentHTML("afterbegin", '<img src="https://example.com/template-thumb.jpg" alt="">');

    dom.window.fetch = async (url, init = {}) => {
        requests.push({ url: String(url), init });
        if (String(url).includes("/videos?")) {
            return {
                ok: true,
                json: async () => ({
                    content: {
                        data: [
                            {
                                videoNo: "100",
                                videoTitle: "Existing 100",
                                duration: 100,
                                thumbnailImageUrl: "https://example.com/index-thumb.jpg",
                                watchTimeline: { lastPlaybackSeconds: 50 },
                            },
                        ],
                        last: true,
                    },
                }),
            };
        }
        return {
            ok: true,
            json: async () => ({
                content: {
                    comments: {
                        data: [{ comment: { content: "alpha" } }, { comment: { content: "beta" } }],
                    },
                },
            }),
        };
    };

    await loadVideoSearchPage(dom);
    await waitForCondition(() => getVideoSearchInput(dom));

    searchVideoSearchInput(dom, "alphabeta");
    await waitForCondition(() => requests.some((request) => request.init?.headers?.deviceId));
    await waitForCondition(() => document.querySelector('[data-bcvs-injected="1"]'));

    const card = document.querySelector('[data-bcvs-injected="1"]');
    assert.ok(card);
    assert.equal(card.querySelector('[data-bcvs-comment-icon="1"]'), null);
    assert.equal(card.querySelector('[data-bcvs-watch-progress="1"]'), null);
});

test("video search retries after an index fetch failure instead of caching partial results as complete", async () => {
    const chrome = createFakeChrome({
        sync: {
            videoSearchCommentEnabled: false,
            videoSearchMaxPages: 2,
        },
    });
    const dom = createVideoSearchDom(chrome);
    const pageCalls = [];
    let failSecondPage = true;

    const makeVideos = (count, offset = 0) =>
        Array.from({ length: count }, (_, index) => ({
            videoNo: String(300 + offset + index),
            videoTitle: `needle indexed ${offset + index}`,
        }));

    dom.window.fetch = async (url) => {
        const parsed = new URL(String(url));
        const page = parsed.searchParams.get("page") || "0";
        pageCalls.push(page);

        if (page === "1" && failSecondPage) {
            failSecondPage = false;
            throw new Error("temporary index failure");
        }

        return {
            ok: true,
            json: async () => ({
                content: {
                    data: page === "0" ? makeVideos(30) : makeVideos(1, 30),
                    last: page === "1",
                },
            }),
        };
    };

    await loadVideoSearchPage(dom);
    await waitForCondition(() => getVideoSearchInput(dom));

    searchVideoSearchInput(dom, "needle");
    await waitForCondition(() => pageCalls.filter((page) => page === "1").length === 1);
    await waitForAsyncCallbacks();

    searchVideoSearchInput(dom, "needle");
    await waitForCondition(() => pageCalls.filter((page) => page === "1").length === 2);
});

test("following refresh clicks the native following sidebar refresh button", async () => {
    const chrome = createFakeChrome({ sync: { followingRefreshSeconds: 10 } });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div id="app">',
            "<nav>",
            '<section id="following">',
            "<header>",
            "<strong>\uD314\uB85C\uC789 \uCC44\uB110</strong>",
            '<button id="followingRefresh" type="button" aria-label="\uC0C8\uB85C\uACE0\uCE68"></button>',
            '<button type="button" aria-label="\uC811\uAE30"></button>',
            "</header>",
            '<a href="/following?tab=LIVE">\uC804\uCCB4\uBCF4\uAE30</a>',
            "</section>",
            '<section id="categories">',
            "<header>",
            "<strong>\uC778\uAE30 \uCE74\uD14C\uACE0\uB9AC</strong>",
            '<button id="categoryRefresh" type="button" aria-label="\uC0C8\uB85C\uACE0\uCE68"></button>',
            "</header>",
            "</section>",
            "</nav>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const { document } = dom.window;
    const clicks = { following: 0, categories: 0 };
    const originalQuerySelectorAll = document.querySelectorAll.bind(document);
    let refreshButtonQueries = 0;

    document.getElementById("followingRefresh").addEventListener("click", () => {
        clicks.following += 1;
    });
    document.getElementById("categoryRefresh").addEventListener("click", () => {
        clicks.categories += 1;
    });
    document.querySelectorAll = (selector) => {
        if (selector === 'button[aria-label], [role="button"][aria-label]') refreshButtonQueries += 1;
        return originalQuerySelectorAll(selector);
    };

    evalFollowingRefreshScripts(dom);
    await waitForAsyncCallbacks();

    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].ms, 10000);

    intervals[0].fn();

    assert.equal(clicks.following, 1);
    assert.equal(clicks.categories, 0);
    assert.equal(refreshButtonQueries, 1);

    intervals[0].fn();

    assert.equal(clicks.following, 2);
    assert.equal(clicks.categories, 0);
    assert.equal(refreshButtonQueries, 1, "캐시된 팔로잉 새로고침 버튼은 다시 탐색하지 않는다");
});

test("following refresh stays idle when the native following refresh button is unavailable", async () => {
    const chrome = createFakeChrome({ sync: { followingRefreshSeconds: 10 } });
    const dom = createPageDom("<!doctype html><body><main></main></body>", "https://chzzk.naver.com/", chrome);
    const intervals = captureIntervals(dom);
    const events = { visibility: 0, focus: 0 };

    dom.window.document.addEventListener("visibilitychange", () => {
        events.visibility += 1;
    });
    dom.window.addEventListener("focus", () => {
        events.focus += 1;
    });

    evalFollowingRefreshScripts(dom);
    await waitForAsyncCallbacks();

    assert.equal(intervals.length, 1);

    intervals[0].fn();

    assert.equal(events.visibility, 0);
    assert.equal(events.focus, 0);
});

test("following refresh restarts the timer when the custom interval changes", async () => {
    const chrome = createFakeChrome({ sync: { followingRefreshSeconds: 10 } });
    const dom = createPageDom("<!doctype html><body><main></main></body>", "https://chzzk.naver.com/", chrome);
    const intervals = captureIntervals(dom);

    evalFollowingRefreshScripts(dom);
    await waitForAsyncCallbacks();

    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].ms, 10000);

    chrome.testState.storageChangeListeners[0](
        {
            followingRefreshSeconds: {
                oldValue: 10,
                newValue: 45,
            },
        },
        "sync"
    );

    assert.equal(intervals[0].cleared, true);
    assert.equal(intervals.length, 2);
    assert.equal(intervals[1].ms, 45000);
});

test("options page saves changed toggles and numbers when the save button is clicked", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipSeconds: 15,
            videoSearchEnabled: false,
        },
    });
    const dom = createDom("options.html", "options.html", chrome);

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    const skipSeconds = queryOption(document, "skipSeconds");
    const videoComment = queryOption(document, "videoSearchCommentEnabled");
    const autoQuality = queryOption(document, "autoQualityEnabled");
    const saveButton = document.getElementById("save");

    assert.equal(skipSeconds.value, "15");
    assert.equal(videoComment.disabled, true);

    autoQuality.checked = false;
    dispatch(dom, autoQuality, "change");
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.sync.autoQualityEnabled, undefined, "버튼을 누르기 전에는 토글을 저장하지 않는다");
    assert.equal(document.getElementById("notice").dataset.state, "dirty");
    assert.equal(saveButton.disabled, false);

    skipSeconds.value = "17";
    dispatch(dom, skipSeconds, "input");
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.sync.skipSeconds, 15, "버튼을 누르기 전에는 숫자 입력을 저장하지 않는다");

    saveButton.click();
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.sync.autoQualityEnabled, false);
    assert.equal(chrome.testState.sync.skipSeconds, 17);
    assert.equal(document.getElementById("notice").dataset.state, "saved");
    assert.equal(saveButton.disabled, true);

    skipSeconds.value = "9999";
    dispatch(dom, skipSeconds, "input");
    saveButton.click();
    await waitForAsyncCallbacks();

    assert.equal(skipSeconds.value, "600", "저장 후에는 보정된 숫자를 표시한다");
    assert.equal(chrome.testState.sync.skipSeconds, 600);
});

test("options requests the pstatic host permission only when enabling the preview toggle", async () => {
    const chrome = createFakeChrome({ sync: { followingPreviewTooltipEnabled: false } });
    const dom = createDom("options.html", "options.html", chrome);

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    const previewToggle = queryOption(document, "followingPreviewTooltipEnabled");
    const soundToggle = queryOption(document, "followingPreviewSoundEnabled");
    const rightClickSoundToggle = queryOption(document, "livePreviewRightClickSoundEnabled");
    const saveButton = document.getElementById("save");

    previewToggle.checked = true;
    dispatch(dom, previewToggle, "change");
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.permissionRequests.length, 0, "저장 전에는 권한을 요청하지 않는다");
    assert.equal(chrome.testState.sync.followingPreviewTooltipEnabled, false);

    saveButton.click();
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.permissionRequests.length, 1);
    assert.equal(JSON.stringify(chrome.testState.permissionRequests[0]), '{"origins":["https://*.pstatic.net/*"]}');
    assert.equal(chrome.testState.sync.followingPreviewTooltipEnabled, true);

    previewToggle.checked = false;
    dispatch(dom, previewToggle, "change");
    soundToggle.checked = false;
    dispatch(dom, soundToggle, "change");
    rightClickSoundToggle.checked = false;
    dispatch(dom, rightClickSoundToggle, "change");
    saveButton.click();
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.permissionRequests.length, 1, "끄기나 다른 토글에서는 권한을 요청하지 않는다");
});

test("options reverts the preview toggle when the permission request is denied", async () => {
    const chrome = createFakeChrome({
        sync: { followingPreviewTooltipEnabled: false },
        permissionGranted: false,
    });
    const dom = createDom("options.html", "options.html", chrome);

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    const previewToggle = queryOption(document, "followingPreviewTooltipEnabled");
    const saveButton = document.getElementById("save");

    previewToggle.checked = true;
    dispatch(dom, previewToggle, "change");
    saveButton.click();
    await waitForAsyncCallbacks();

    assert.equal(previewToggle.checked, false, "거부되면 토글이 꺼진 상태로 돌아간다");
    assert.equal(chrome.testState.sync.followingPreviewTooltipEnabled, false);
    assert.equal(document.getElementById("message").dataset.type, "error");
});

test("options page shows initial storage read failures without overwriting existing sync options", async () => {
    const chrome = createFakeChrome({
        sync: {
            autoQualityEnabled: true,
        },
    });
    chrome.storage.sync.get = (_keys, callback) => {
        setTimeout(() => {
            chrome.runtime.lastError = { message: "load failed" };
            callback({});
            chrome.runtime.lastError = null;
        }, 0);
    };
    const dom = createDom("options.html", "options.html", chrome);

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    const autoQuality = queryOption(document, "autoQualityEnabled");
    const message = document.getElementById("message");

    assert.equal(document.getElementById("notice").dataset.state, "error");
    assert.equal(autoQuality.disabled, true);
    assert.equal(message.textContent, "설정을 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.");

    autoQuality.checked = false;
    dispatch(dom, autoQuality, "change");
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.sync.autoQualityEnabled, true);
    assert.equal(document.getElementById("notice").dataset.state, "error");
    assert.equal(message.textContent, "설정을 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.");
});

test("options page shows storage write failures without updating saved options", async () => {
    const chrome = createFakeChrome({
        sync: {
            autoQualityEnabled: true,
        },
    });
    const dom = createDom("options.html", "options.html", chrome);

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    chrome.storage.sync.set = (_values, callback) => {
        setTimeout(() => {
            chrome.runtime.lastError = { message: "write failed" };
            callback();
            chrome.runtime.lastError = null;
        }, 0);
    };

    const { document } = dom.window;
    const autoQuality = queryOption(document, "autoQualityEnabled");
    const saveButton = document.getElementById("save");

    autoQuality.checked = false;
    dispatch(dom, autoQuality, "change");
    saveButton.click();
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.sync.autoQualityEnabled, true);
    assert.equal(document.getElementById("notice").dataset.state, "error");
    assert.equal(
        document.getElementById("message").textContent,
        "설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요."
    );
});

test("options page snaps out-of-range numbers back on change and saves the clamped value", async () => {
    const chrome = createFakeChrome();
    const dom = createDom("options.html", "options.html", chrome);

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    const skipSeconds = queryOption(document, "skipSeconds");
    const saveButton = document.getElementById("save");

    skipSeconds.value = "9999";
    dispatch(dom, skipSeconds, "input");
    dispatch(dom, skipSeconds, "change");
    saveButton.click();
    await waitForAsyncCallbacks();

    assert.equal(skipSeconds.value, "600", "범위 밖 값은 입력을 마치면 보정값으로 되돌려 보여준다");
    assert.equal(chrome.testState.sync.skipSeconds, 600);

    skipSeconds.value = "";
    dispatch(dom, skipSeconds, "input");
    dispatch(dom, skipSeconds, "change");
    await waitForAsyncCallbacks();

    assert.equal(skipSeconds.value, "600", "빈 칸은 마지막 저장값으로 복원된다");
    assert.equal(chrome.testState.sync.skipSeconds, 600);
});

test("options reset asks for confirmation before restoring defaults", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipSeconds: 15,
        },
    });
    const dom = createDom("options.html", "options.html", chrome);

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    const skipSeconds = queryOption(document, "skipSeconds");
    const resetButton = document.getElementById("reset");

    dom.window.confirm = () => false;
    resetButton.click();
    await waitForAsyncCallbacks();

    assert.equal(skipSeconds.value, "15", "확인을 거부하면 아무것도 바뀌지 않는다");
    assert.equal(chrome.testState.sync.skipSeconds, 15);

    dom.window.confirm = () => true;
    resetButton.click();
    await waitForAsyncCallbacks();

    assert.equal(skipSeconds.value, "5");
    assert.equal(chrome.testState.sync.skipSeconds, 5);
});

test("title tooltip shows full text when a card title is truncated", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><article class="card">',
            '<a class="card_title" href="/live/abc">아주 길어서 잘리는 방송 제목 전체 내용</a>',
            "</article></main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/lives",
        chrome
    );
    const { document } = dom.window;
    const title = document.querySelector(".card_title");

    Object.defineProperty(title, "scrollWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(title, "clientWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(title, "scrollHeight", { configurable: true, get: () => 20 });
    Object.defineProperty(title, "clientHeight", { configurable: true, get: () => 20 });
    title.getBoundingClientRect = () => ({
        left: 40,
        top: 120,
        right: 240,
        bottom: 140,
        width: 200,
        height: 20,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForTitleTooltipDelay();

    const tip = document.querySelector(".bctt-tooltip[data-show='1']");
    assert.ok(tip, "툴팁이 표시되어야 한다");
    assert.equal(tip.textContent, "아주 길어서 잘리는 방송 제목 전체 내용");
    assert.equal(title.getAttribute("data-bctt-active"), "1");
});

test("title tooltip accepts channel root links as card links", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><article class="card">',
            '<a class="card_title" href="/0123456789abcdef0123456789abcdef">채널 루트 링크의 잘리는 방송 제목</a>',
            "</article></main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/",
        chrome
    );
    const { document } = dom.window;
    const title = document.querySelector(".card_title");

    Object.defineProperty(title, "scrollWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(title, "clientWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(title, "scrollHeight", { configurable: true, get: () => 20 });
    Object.defineProperty(title, "clientHeight", { configurable: true, get: () => 20 });
    title.getBoundingClientRect = () => ({
        left: 40,
        top: 120,
        right: 240,
        bottom: 140,
        width: 200,
        height: 20,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForTitleTooltipDelay();

    const tip = document.querySelector(".bctt-tooltip[data-show='1']");
    assert.ok(tip);
    assert.equal(tip.textContent, "채널 루트 링크의 잘리는 방송 제목");
});

test("title tooltip excludes hidden navigation text from the full title", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><article class="card">',
            '<a class="card_title" href="/live/abc">',
            "JDG vs BLG | LPL Split 2 Playoff BO5 패자조 노코인 징비록 지면 끝",
            '<span class="blind">라이브 엔드로 이동</span>',
            "</a>",
            "</article></main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/lives",
        chrome
    );
    const { document } = dom.window;
    const title = document.querySelector(".card_title");

    Object.defineProperty(title, "scrollWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(title, "clientWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(title, "scrollHeight", { configurable: true, get: () => 20 });
    Object.defineProperty(title, "clientHeight", { configurable: true, get: () => 20 });
    title.getBoundingClientRect = () => ({
        left: 40,
        top: 120,
        right: 240,
        bottom: 140,
        width: 200,
        height: 20,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForTitleTooltipDelay();

    const tip = document.querySelector(".bctt-tooltip[data-show='1']");
    assert.ok(tip);
    assert.equal(tip.textContent, "JDG vs BLG | LPL Split 2 Playoff BO5 패자조 노코인 징비록 지면 끝");
    assert.equal(tip.textContent.includes("라이브 엔드로 이동"), false);
});

test("title tooltip ignores titles that fit", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><article class="card">',
            '<a class="card_title" href="/live/abc">짧은 제목</a>',
            "</article></main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/lives",
        chrome
    );
    const { document } = dom.window;
    const title = document.querySelector(".card_title");

    Object.defineProperty(title, "scrollWidth", { configurable: true, get: () => 100 });
    Object.defineProperty(title, "clientWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(title, "scrollHeight", { configurable: true, get: () => 20 });
    Object.defineProperty(title, "clientHeight", { configurable: true, get: () => 20 });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForTitleTooltipDelay();

    assert.equal(document.querySelector(".bctt-tooltip[data-show='1']"), null);
    assert.equal(title.hasAttribute("data-bctt-active"), false);
});

test("title tooltip keeps pending hover when moving inside the same title", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><article class="card">',
            '<a class="card_title" href="/live/abc"><span>자식 이동 중에도 유지되는 긴 방송 제목</span></a>',
            "</article></main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/lives",
        chrome
    );
    const { document } = dom.window;
    const title = document.querySelector(".card_title");
    const child = title.querySelector("span");

    Object.defineProperty(title, "scrollWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(title, "clientWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(title, "scrollHeight", { configurable: true, get: () => 20 });
    Object.defineProperty(title, "clientHeight", { configurable: true, get: () => 20 });
    title.getBoundingClientRect = () => ({
        left: 40,
        top: 120,
        right: 240,
        bottom: 140,
        width: 200,
        height: 20,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    child.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    title.dispatchEvent(new dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: child }));
    await new Promise((resolve) => setTimeout(resolve, 110));

    const tip = document.querySelector(".bctt-tooltip[data-show='1']");
    assert.ok(tip);
    assert.equal(tip.textContent, "자식 이동 중에도 유지되는 긴 방송 제목");
    assert.equal(title.getAttribute("data-bctt-active"), "1");
});

test("title tooltip stays disabled when the option is off", async () => {
    const chrome = createFakeChrome({
        sync: {
            titleTooltipEnabled: false,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><article class="card">',
            '<a class="card_title" href="/live/abc">잘려야 하는 긴 방송 제목</a>',
            "</article></main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/lives",
        chrome
    );
    const { document } = dom.window;
    const title = document.querySelector(".card_title");

    Object.defineProperty(title, "scrollWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(title, "clientWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(title, "scrollHeight", { configurable: true, get: () => 20 });
    Object.defineProperty(title, "clientHeight", { configurable: true, get: () => 20 });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForTitleTooltipDelay();

    assert.equal(document.querySelector(".bctt-tooltip[data-show='1']"), null);
    assert.equal(title.hasAttribute("data-bctt-active"), false);
});

test("title tooltip reacts to option changes without leaving stale UI", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><article class="card">',
            '<a class="card_title" href="/live/abc">옵션 변경 중에도 잘리는 방송 제목 전체 내용</a>',
            "</article></main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/lives",
        chrome
    );
    const { document } = dom.window;
    const title = document.querySelector(".card_title");

    Object.defineProperty(title, "scrollWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(title, "clientWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(title, "scrollHeight", { configurable: true, get: () => 20 });
    Object.defineProperty(title, "clientHeight", { configurable: true, get: () => 20 });
    title.getBoundingClientRect = () => ({
        left: 40,
        top: 120,
        right: 240,
        bottom: 140,
        width: 200,
        height: 20,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForTitleTooltipDelay();
    assert.ok(document.querySelector(".bctt-tooltip[data-show='1']"));
    assert.equal(title.getAttribute("data-bctt-active"), "1");

    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ titleTooltipEnabled: { newValue: false } }, "sync");
    }
    await waitForAsyncCallbacks();
    assert.equal(document.querySelector(".bctt-tooltip"), null);
    assert.equal(document.getElementById("betterchzzk-title-tooltip-style"), null);
    assert.equal(title.hasAttribute("data-bctt-active"), false);

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForTitleTooltipDelay();
    assert.equal(document.querySelector(".bctt-tooltip[data-show='1']"), null);

    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ titleTooltipEnabled: { newValue: true } }, "sync");
    }
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await waitForTitleTooltipDelay();
    const tip = document.querySelector(".bctt-tooltip[data-show='1']");
    assert.ok(tip);
    assert.equal(tip.textContent, "옵션 변경 중에도 잘리는 방송 제목 전체 내용");
    assert.equal(title.getAttribute("data-bctt-active"), "1");
});

test("volume wheel raises and lowers media volume over the volume control", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol">',
            '<button class="pzp-pc__volume-button" type="button"></button>',
            '<input id="slider" type="range" min="0" max="100" value="50">',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const vol = document.getElementById("vol");
    const slider = document.getElementById("slider");

    video.volume = 0.5;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    vol.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    let nativeWheelCount = 0;
    dom.window.addEventListener(
        "wheel",
        () => {
            nativeWheelCount += 1;
            video.volume = 1;
        },
        { capture: true }
    );

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    vol.dispatchEvent(up);
    assert.ok(Math.abs(video.volume - 0.55) < 1e-6, "휠 업이면 +5%");
    assert.equal(up.defaultPrevented, true);
    assert.equal(nativeWheelCount, 0);
    assert.equal(slider.value, "50");

    const down = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(down, "deltaY", { value: 100 });
    vol.dispatchEvent(down);
    assert.ok(Math.abs(video.volume - 0.5) < 1e-6, "휠 다운이면 -5%");
    assert.equal(down.defaultPrevented, true);
    assert.equal(slider.value, "50");
});

test("volume wheel ignores following preview videos when choosing media volume", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div class="bcfp-player" data-bcfp-player-mount="preview">',
            '<video id="previewVideo"></video>',
            "</div>",
            '<div class="pzp-pc" id="playerRoot">',
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol">',
            '<button class="pzp-pc__volume-button" type="button"></button>',
            "</div>",
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const previewVideo = document.getElementById("previewVideo");
    const vol = document.getElementById("vol");

    video.volume = 0.5;
    previewVideo.volume = 0.1;
    previewVideo.getBoundingClientRect = () => ({
        width: 800,
        height: 450,
        left: 0,
        top: 0,
        right: 800,
        bottom: 450,
    });
    video.getBoundingClientRect = () => ({ width: 320, height: 180, left: 0, top: 0, right: 320, bottom: 180 });
    vol.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    vol.dispatchEvent(up);

    assert.ok(Math.abs(video.volume - 0.55) < 1e-6);
    assert.ok(Math.abs(previewVideo.volume - 0.1) < 1e-6);
    assert.equal(up.defaultPrevented, true);
});

test("volume wheel installs the page wheel listener only after enabled settings publish", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol">',
            '<button class="pzp-pc__volume-button" type="button"></button>',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const vol = document.getElementById("vol");

    video.volume = 0.5;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    vol.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });

    const nativeAddEventListener = dom.window.addEventListener.bind(dom.window);
    const wheelListeners = [];
    dom.window.addEventListener = (type, listener, options) => {
        if (type === "wheel") wheelListeners.push(listener);
        return nativeAddEventListener(type, listener, options);
    };

    evalRepoScript(dom, "features", "volumeWheelPage.js");

    assert.equal(wheelListeners.length, 0);

    const beforeSettings = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(beforeSettings, "deltaY", { value: -100 });
    vol.dispatchEvent(beforeSettings);

    assert.equal(video.volume, 0.5);
    assert.equal(beforeSettings.defaultPrevented, false);

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "volumeWheel.js");
    await waitForAsyncCallbacks();

    assert.equal(wheelListeners.length, 1);

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    vol.dispatchEvent(up);

    assert.ok(Math.abs(video.volume - 0.55) < 1e-6);
    assert.equal(up.defaultPrevented, true);
});

test("volume wheel removes the page wheel listener after pushState leaves playback routes", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/live/test-channel", chrome);
    const nativeAddEventListener = dom.window.addEventListener.bind(dom.window);
    const nativeRemoveEventListener = dom.window.removeEventListener.bind(dom.window);
    const activeWheelListeners = new Set();

    dom.window.addEventListener = (type, listener, options) => {
        if (type === "wheel") activeWheelListeners.add(listener);
        return nativeAddEventListener(type, listener, options);
    };
    dom.window.removeEventListener = (type, listener, options) => {
        if (type === "wheel") activeWheelListeners.delete(listener);
        return nativeRemoveEventListener(type, listener, options);
    };

    evalRepoScript(dom, "features", "routeBridgePage.js");
    evalVolumeWheelScripts(dom);
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    assert.equal(activeWheelListeners.size, 1);

    dom.window.history.pushState({}, "", "/following");
    await waitForCondition(() => activeWheelListeners.size === 0);

    assert.equal(dom.window.location.pathname, "/following");
});

test("volume wheel respects unit-range native sliders", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol">',
            '<button class="pzp-pc__volume-button" type="button"></button>',
            '<input id="slider" type="range" min="0" max="1" step="0.01" value="0.5">',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const vol = document.getElementById("vol");
    const slider = document.getElementById("slider");

    video.volume = 0.5;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    vol.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    vol.dispatchEvent(up);

    assert.ok(Math.abs(video.volume - 0.55) < 1e-6);
    assert.equal(slider.value, "0.5");
    assert.notEqual(slider.value, "1");

    const down = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(down, "deltaY", { value: 100 });
    vol.dispatchEvent(down);

    assert.ok(Math.abs(video.volume - 0.5) < 1e-6);
    assert.equal(slider.value, "0.5");
});

test("volume wheel avoids native slider feedback on unit-range aria sliders", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol">',
            '<button class="pzp-pc__volume-button" type="button"></button>',
            '<div id="slider" role="slider" aria-label="\uBCFC\uB968" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0.5"></div>',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const vol = document.getElementById("vol");
    const slider = document.getElementById("slider");

    video.volume = 0.5;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    vol.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    let syntheticSliderEvents = 0;
    slider.addEventListener("input", () => {
        syntheticSliderEvents += 1;
        video.volume = 1;
    });
    slider.addEventListener("change", () => {
        syntheticSliderEvents += 1;
        video.volume = 0;
    });

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    vol.dispatchEvent(up);

    assert.ok(Math.abs(video.volume - 0.55) < 1e-6);
    assert.equal(slider.getAttribute("aria-valuenow"), "0.5");
    assert.notEqual(slider.getAttribute("aria-valuenow"), "1");
    assert.equal(slider.hasAttribute("aria-valuetext"), false);
    assert.equal(syntheticSliderEvents, 0);

    const down = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(down, "deltaY", { value: 100 });
    vol.dispatchEvent(down);

    assert.ok(Math.abs(video.volume - 0.5) < 1e-6);
    assert.equal(slider.getAttribute("aria-valuenow"), "0.5");

    video.volume = 0.04;
    video.muted = false;
    const downToMute = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(downToMute, "deltaY", { value: 100 });
    vol.dispatchEvent(downToMute);

    assert.equal(video.volume, 0);
    assert.equal(video.muted, true);
    assert.equal(slider.getAttribute("aria-valuenow"), "0.5");

    const upFromMute = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(upFromMute, "deltaY", { value: -100 });
    vol.dispatchEvent(upFromMute);

    assert.ok(Math.abs(video.volume - 0.05) < 1e-6);
    assert.equal(video.muted, false);
    assert.equal(slider.getAttribute("aria-valuenow"), "0.5");

    video.volume = 1;
    video.muted = false;
    const downFromMax = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(downFromMax, "deltaY", { value: 100 });
    vol.dispatchEvent(downFromMax);

    assert.ok(Math.abs(video.volume - 0.95) < 1e-6);
    assert.equal(slider.getAttribute("aria-valuenow"), "0.5");
    assert.equal(syntheticSliderEvents, 0);
});

test("volume wheel works on VOD playback routes", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol">',
            '<button class="pzp-pc__volume-button" type="button"></button>',
            '<input id="slider" type="range" min="0" max="100" value="40">',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/video/test-video",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const vol = document.getElementById("vol");
    const slider = document.getElementById("slider");

    video.volume = 0.4;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    vol.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    vol.dispatchEvent(up);

    assert.ok(Math.abs(video.volume - 0.45) < 1e-6);
    assert.equal(up.defaultPrevented, true);
    assert.equal(slider.value, "40");
});

test("volume wheel detects aria-labeled native buttons without volume classes", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__bottom-buttons--left" id="controls">',
            '<button class="pzp-button" id="vol" type="button" aria-label="\uC74C\uC18C\uAC70">',
            '<span id="icon" aria-hidden="true"></span>',
            "</button>",
            '<input id="slider" type="range" min="0" max="1" step="0.01" value="0.5" aria-label="\uBCFC\uB968">',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const controls = document.getElementById("controls");
    const button = document.getElementById("vol");
    const icon = document.getElementById("icon");
    const slider = document.getElementById("slider");

    video.volume = 0.5;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    controls.getBoundingClientRect = () => ({ width: 160, height: 40, left: 20, top: 320, right: 180, bottom: 360 });
    button.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    icon.dispatchEvent(up);

    assert.ok(Math.abs(video.volume - 0.55) < 1e-6);
    assert.equal(up.defaultPrevented, true);
    assert.equal(slider.value, "0.5");
});

test("volume wheel ignores volume-like controls outside the playback area", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div id="chatSettings">',
            '<button id="chatVolume" type="button" aria-label="volume notification"></button>',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const chatVolume = document.getElementById("chatVolume");

    video.volume = 0.5;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    chatVolume.getBoundingClientRect = () => ({ width: 120, height: 32, left: 700, top: 40, right: 820, bottom: 72 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    chatVolume.dispatchEvent(up);

    assert.equal(video.volume, 0.5);
    assert.equal(up.defaultPrevented, false);
});

test("volume wheel detects a single visible sibling slider without syncing it", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__bottom-buttons--left" id="controls">',
            '<button class="pzp-button" id="vol" type="button" aria-label="\uC74C\uC18C\uAC70">',
            '<span id="icon" aria-hidden="true"></span>',
            "</button>",
            '<input id="slider" type="range" min="0" max="1" step="0.01" value="0.5">',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const controls = document.getElementById("controls");
    const button = document.getElementById("vol");
    const icon = document.getElementById("icon");
    const slider = document.getElementById("slider");

    video.volume = 0.5;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    controls.getBoundingClientRect = () => ({ width: 160, height: 40, left: 20, top: 320, right: 180, bottom: 360 });
    button.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });
    slider.getBoundingClientRect = () => ({ width: 80, height: 16, left: 70, top: 332, right: 150, bottom: 348 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    icon.dispatchEvent(up);

    assert.ok(Math.abs(video.volume - 0.55) < 1e-6);
    assert.equal(up.defaultPrevented, true);
    assert.equal(slider.value, "0.5");
});

test("volume wheel ignores hidden volume controls", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol">',
            '<button class="pzp-pc__volume-button" type="button"></button>',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const vol = document.getElementById("vol");

    video.volume = 0.5;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    vol.getBoundingClientRect = () => ({ width: 0, height: 0, left: 20, top: 320, right: 20, bottom: 320 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    vol.dispatchEvent(up);

    assert.equal(video.volume, 0.5);
    assert.equal(up.defaultPrevented, false);
});

test("volume wheel ignores non-volume areas and disabled option", async () => {
    const chrome = createFakeChrome({
        sync: {
            volumeWheelEnabled: false,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol"><button class="pzp-pc__volume-button" type="button"></button></div>',
            '<div id="outside">outside</div>',
            '<input id="outsideSlider" type="range" min="0" max="100" value="70">',
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const vol = document.getElementById("vol");
    const outside = document.getElementById("outside");
    const outsideSlider = document.getElementById("outsideSlider");

    video.volume = 0.5;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    vol.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });
    outside.getBoundingClientRect = () => ({ width: 100, height: 20, left: 80, top: 320, right: 180, bottom: 340 });

    evalVolumeWheelScripts(dom);
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const disabledWheel = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(disabledWheel, "deltaY", { value: -100 });
    vol.dispatchEvent(disabledWheel);
    assert.equal(video.volume, 0.5);
    assert.equal(disabledWheel.defaultPrevented, false);

    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ volumeWheelEnabled: { newValue: true } }, "sync");
    }
    await waitForAsyncCallbacks();

    const outsideWheel = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(outsideWheel, "deltaY", { value: -100 });
    outside.dispatchEvent(outsideWheel);
    assert.equal(video.volume, 0.5);
    assert.equal(outsideWheel.defaultPrevented, false);

    const downToMute = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(downToMute, "deltaY", { value: 100 });
    video.volume = 0.03;
    video.muted = false;
    vol.dispatchEvent(downToMute);
    assert.equal(video.volume, 0);
    assert.equal(video.muted, true);
    assert.equal(outsideSlider.value, "70");

    const upFromMute = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(upFromMute, "deltaY", { value: -100 });
    vol.dispatchEvent(upFromMute);
    assert.ok(Math.abs(video.volume - 0.05) < 1e-6);
    assert.equal(video.muted, false);
    assert.equal(outsideSlider.value, "70");
});

test("audio compressor button yields to an existing external cheese-knife compressor", async () => {
    const { dom, document } = createAudioCompressorFixture({ withExternalCompressor: true });

    await loadAudioCompressorFeature(dom);

    assert.equal(document.getElementById("betterchzzk-audio-compressor"), null);
});

test("audio compressor button mounts next to the volume button when no external compressor exists", async () => {
    const { dom, document, volumeControl, volumeButton } = createAudioCompressorFixture();

    await loadAudioCompressorFeature(dom);

    await waitForCondition(() => document.getElementById("betterchzzk-audio-compressor"));
    const button = document.getElementById("betterchzzk-audio-compressor");

    assert.equal(button.parentElement, volumeControl);
    assert.equal(button.previousElementSibling, volumeButton);
    assert.equal(button.classList.contains(["knife", "audio", "compressor"].join("-")), false);
});

test("audio compressor button tooltip reports graph setup failures", async () => {
    const { dom, document } = createAudioCompressorFixture();

    dom.window.AudioContext = class {
        constructor() {
            this.state = "running";
            this.currentTime = 0;
        }

        createMediaElementSource() {
            throw new Error("media source already connected");
        }

        close() {}
    };

    await loadAudioCompressorFeature(dom);
    await waitForCondition(() => document.getElementById("betterchzzk-audio-compressor"));

    const button = document.getElementById("betterchzzk-audio-compressor");
    button.click();

    assert.equal(button.dataset.betterChzzkReady, "0");
    assert.equal(button.getAttribute("tooltip"), "오디오 컴프레서(사용할 수 없음)");
    assert.equal(button.getAttribute("aria-label"), "오디오 컴프레서(사용할 수 없음)");
});

test("audio compressor button is removed when an external cheese-knife compressor appears later", async () => {
    const { dom, document } = createAudioCompressorFixture();

    await loadAudioCompressorFeature(dom);
    await waitForCondition(() => document.getElementById("betterchzzk-audio-compressor"));

    const external = document.createElement("div");
    external.className = "knife-comp";
    document.body.appendChild(external);

    await waitForCondition(() => !document.getElementById("betterchzzk-audio-compressor"));
});

test("auto quality falls back to the highest selectable lower track", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const tracks = [
        { id: "auto", label: "auto 1080p", height: 1080 },
        { id: "480", label: "480p", height: 480, kind: "main" },
        { id: "720", label: "720p", height: 720, kind: "main" },
    ];
    const trackList = createVideoTrackList(tracks, 1);

    video.currentTime = 2;
    Object.defineProperty(video, "paused", {
        configurable: true,
        get: () => false,
    });
    makeVisibleVideo(video);
    Object.defineProperty(video, "videoTracks", {
        configurable: true,
        get: () => trackList,
    });

    evalRepoScript(dom, "features", "autoQualityPage.js");

    const result = requestAutoQualityApply(dom, "1080p");

    assert.equal(result.status, "selected");
    assert.equal(result.selected.height, 720);
    assert.equal(result.previous.height, 480);
    assert.equal(trackList.selectedIndex, 2);
    assert.equal(tracks[2].selected, true);
    assert.equal(tracks[1].selected, false);
});

test("auto quality retries by directly discovering videoTracks after they appear", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const tracks = [
        { id: "auto", label: "auto 1080p", height: 1080 },
        { id: "480", label: "480p", height: 480, kind: "main" },
        { id: "720", label: "720p", height: 720, kind: "main" },
    ];
    const trackList = createVideoTrackList(tracks, 1);

    video.currentTime = 2;
    makeVisibleVideo(video);
    evalRepoScript(dom, "features", "autoQualityPage.js");

    const pending = requestAutoQualityApply(dom, "1080p");
    assert.equal(pending.status, "pending");

    Object.defineProperty(video, "videoTracks", {
        configurable: true,
        get: () => trackList,
    });

    const result = requestAutoQualityApply(dom, "1080p");
    assert.equal(result.status, "selected");
    assert.equal(result.selected.height, 720);
    assert.equal(trackList.selectedIndex, 2);
});

test("auto quality treats an already selected fallback track as stable", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const tracks = [
        { id: "auto", label: "auto 1080p", height: 1080 },
        { id: "720", label: "720p", height: 720, kind: "main" },
        { id: "480", label: "480p", height: 480, kind: "main" },
    ];
    const trackList = createVideoTrackList(tracks, 1);

    video.currentTime = 2;
    makeVisibleVideo(video);
    Object.defineProperty(video, "videoTracks", {
        configurable: true,
        get: () => trackList,
    });

    evalRepoScript(dom, "features", "autoQualityPage.js");

    const result = requestAutoQualityApply(dom, "1080p");

    assert.equal(result.status, "already");
    assert.equal(result.selected.height, 720);
    assert.equal(trackList.selectedIndex, 1);
    assert.equal(tracks[1].selected, true);
});

test("auto quality treats an active preferred track as already selected", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const tracks = [
        { id: "auto", label: "auto 1080p", height: 1080 },
        { id: "1080", label: "1080p", height: 1080, kind: "main", active: true },
        { id: "720", label: "720p", height: 720, kind: "main" },
    ];
    const trackList = createVideoTrackList(tracks, -1);

    video.currentTime = 2;
    makeVisibleVideo(video);
    Object.defineProperty(video, "videoTracks", {
        configurable: true,
        get: () => trackList,
    });

    evalRepoScript(dom, "features", "autoQualityPage.js");

    const result = requestAutoQualityApply(dom, "1080p");

    assert.equal(result.status, "already");
    assert.equal(result.selected.height, 1080);
    assert.equal(trackList.selectedIndex, -1);
    assert.equal(tracks[1].selected, false);
});

test("auto quality removes the VOD startup timeupdate listener after startup settles", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const tracks = [
        { id: "auto", label: "auto 1080p", height: 1080 },
        { id: "1080", label: "1080p", height: 1080, kind: "main" },
    ];
    const trackList = createVideoTrackList(tracks, 0);
    const timeupdateListeners = [];
    const removedTimeupdateListeners = [];
    const nativeAddEventListener = video.addEventListener.bind(video);
    const nativeRemoveEventListener = video.removeEventListener.bind(video);

    video.currentTime = 2;
    makeVisibleVideo(video);
    Object.defineProperty(video, "duration", {
        configurable: true,
        get: () => 120,
    });
    Object.defineProperty(video, "videoTracks", {
        configurable: true,
        get: () => trackList,
    });
    video.addEventListener = (type, listener, options) => {
        if (type === "timeupdate") timeupdateListeners.push(listener);
        return nativeAddEventListener(type, listener, options);
    };
    video.removeEventListener = (type, listener, options) => {
        if (type === "timeupdate") removedTimeupdateListeners.push(listener);
        return nativeRemoveEventListener(type, listener, options);
    };

    evalRepoScript(dom, "features", "autoQualityPage.js");

    assert.equal(timeupdateListeners.length, 1);

    video.dispatchEvent(new dom.window.Event("timeupdate", { bubbles: true }));

    assert.deepEqual(removedTimeupdateListeners, timeupdateListeners);

    video.dispatchEvent(new dom.window.Event("timeupdate", { bubbles: true }));

    assert.deepEqual(removedTimeupdateListeners, timeupdateListeners);
});

test("auto quality stops the VOD page observer after a stable already result", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const tracks = [
        { id: "auto", label: "auto 1080p", height: 1080 },
        { id: "1080", label: "1080p", height: 1080, kind: "main", selected: true },
    ];
    const trackList = createVideoTrackList(tracks, 1);

    video.currentTime = 2;
    makeVisibleVideo(video);
    Object.defineProperty(video, "duration", {
        configurable: true,
        get: () => 120,
    });
    Object.defineProperty(video, "videoTracks", {
        configurable: true,
        get: () => trackList,
    });

    evalRepoScript(dom, "features", "autoQualityPage.js");

    const result = requestAutoQualityApply(dom, "1080p");
    assert.equal(result.status, "already");

    const statusBefore = document.documentElement.getAttribute("data-betterchzzk-auto-quality-status");
    document.body.appendChild(document.createElement("video"));
    await waitForAsyncCallbacks();

    assert.equal(document.documentElement.getAttribute("data-betterchzzk-auto-quality-status"), statusBefore);
});

test("auto quality removes VOD track list listeners after a stable already result", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const tracks = [
        { id: "auto", label: "auto 1080p", height: 1080 },
        { id: "1080", label: "1080p", height: 1080, kind: "main", selected: true },
    ];
    const trackList = createVideoTrackList(tracks, 1);
    const listeners = new Map();

    trackList.addEventListener = (type, listener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(listener);
    };
    trackList.removeEventListener = (type, listener) => {
        listeners.get(type)?.delete(listener);
    };

    video.currentTime = 2;
    makeVisibleVideo(video);
    Object.defineProperty(video, "duration", {
        configurable: true,
        get: () => 120,
    });
    Object.defineProperty(video, "videoTracks", {
        configurable: true,
        get: () => trackList,
    });

    evalRepoScript(dom, "features", "autoQualityPage.js");

    const result = requestAutoQualityApply(dom, "1080p");
    assert.equal(result.status, "already");
    assert.equal(listeners.get("change")?.size || 0, 0);

    const statusBefore = document.documentElement.getAttribute("data-betterchzzk-auto-quality-status");
    for (const listener of listeners.get("change") || []) {
        listener.call(trackList, new dom.window.Event("change"));
    }

    assert.equal(document.documentElement.getAttribute("data-betterchzzk-auto-quality-status"), statusBefore);
});

test("auto quality does not reopen VOD page apply after stable already startup progress", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const tracks = [
        { id: "auto", label: "auto 1080p", height: 1080 },
        { id: "1080", label: "1080p", height: 1080, kind: "main", selected: true },
    ];
    const trackList = createVideoTrackList(tracks, 1);

    video.currentTime = 2;
    makeVisibleVideo(video);
    Object.defineProperty(video, "duration", {
        configurable: true,
        get: () => 120,
    });
    Object.defineProperty(video, "videoTracks", {
        configurable: true,
        get: () => trackList,
    });

    evalRepoScript(dom, "features", "autoQualityPage.js");

    const result = requestAutoQualityApply(dom, "1080p");
    assert.equal(result.status, "already");

    const scheduledTimers = [];
    dom.window.setTimeout = (callback, delay) => {
        scheduledTimers.push({ callback, delay });
        return scheduledTimers.length;
    };
    dom.window.clearTimeout = () => {};
    const statusBefore = document.documentElement.getAttribute("data-betterchzzk-auto-quality-status");

    video.dispatchEvent(new dom.window.Event("timeupdate", { bubbles: true }));

    assert.equal(scheduledTimers.length, 0);
    assert.equal(document.documentElement.getAttribute("data-betterchzzk-auto-quality-status"), statusBefore);
});

test("auto quality reopens VOD page apply when the stable video is replaced", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const tracks = [
        { id: "auto", label: "auto 1080p", height: 1080 },
        { id: "1080", label: "1080p", height: 1080, kind: "main", selected: true },
    ];

    video.currentTime = 2;
    makeVisibleVideo(video);
    Object.defineProperty(video, "duration", {
        configurable: true,
        get: () => 120,
    });
    Object.defineProperty(video, "videoTracks", {
        configurable: true,
        get: () => createVideoTrackList(tracks, 1),
    });

    evalRepoScript(dom, "features", "autoQualityPage.js");

    const result = requestAutoQualityApply(dom, "1080p");
    assert.equal(result.status, "already");

    const scheduledTimers = [];
    dom.window.setTimeout = (callback, delay) => {
        scheduledTimers.push({ callback, delay });
        return scheduledTimers.length;
    };
    dom.window.clearTimeout = () => {};

    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:auto-quality:state"));
    assert.equal(scheduledTimers.length, 0);

    const replacement = document.createElement("video");
    replacement.currentTime = 2;
    makeVisibleVideo(replacement);
    Object.defineProperty(replacement, "duration", {
        configurable: true,
        get: () => 120,
    });
    Object.defineProperty(replacement, "videoTracks", {
        configurable: true,
        get: () =>
            createVideoTrackList(
                [
                    { id: "auto", label: "auto 1080p", height: 1080 },
                    { id: "1080", label: "1080p", height: 1080, kind: "main" },
                ],
                0
            ),
    });
    document.querySelector("main").replaceChildren(replacement);

    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:auto-quality:state"));
    assert.equal(scheduledTimers.length, 1);
    assert.equal(scheduledTimers[0].delay, 0);
});

test("auto quality drops tracked page targets after an SPA route change", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const oldTrackList = createVideoTrackList(
        [
            { id: "auto", label: "auto 1080p", height: 1080 },
            { id: "1080", label: "1080p", height: 1080, kind: "main" },
        ],
        1
    );

    video.currentTime = 2;
    makeVisibleVideo(video);
    evalRepoScript(dom, "features", "autoQualityPage.js");

    const oldPlayerAdapter = {};
    dom.window.Object.defineProperty(oldPlayerAdapter, "videoTracks", {
        configurable: true,
        get: () => oldTrackList,
    });
    assert.equal(oldPlayerAdapter.videoTracks, oldTrackList);
    assert.equal(requestAutoQualityApply(dom, "1080p").status, "already");

    dom.window.history.pushState({}, "", "/video/67890");
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));

    const replacement = document.createElement("video");
    replacement.currentTime = 2;
    makeVisibleVideo(replacement);
    document.querySelector("main").replaceChildren(replacement);

    const result = requestAutoQualityApply(dom, "1080p");
    assert.equal(result.status, "pending");
    assert.equal(result.reason, "player-missing");
    disableAutoQualityPage(dom);
    await waitForAsyncCallbacks();
    dom.window.close();
});

test("auto quality ignores the following preview video when choosing the main player", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div data-bcfp-tooltip="1"><video id="preview" class="bcfp-player" data-bcfp-player-mount="preview"></video></div>',
            '<pzp-player><video id="main"></video></pzp-player>',
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const preview = document.getElementById("preview");
    const main = document.getElementById("main");
    const tracks = [
        { id: "auto", label: "auto 1080p", height: 1080 },
        { id: "480", label: "480p", height: 480, kind: "main" },
        { id: "720", label: "720p", height: 720, kind: "main" },
    ];
    const trackList = createVideoTrackList(tracks, 1);

    main.currentTime = 2;
    preview.currentTime = 5;
    makeVisibleVideo(main);
    preview.getBoundingClientRect = () => ({
        width: 800,
        height: 450,
        left: 0,
        top: 0,
        right: 800,
        bottom: 450,
    });
    Object.defineProperty(main, "videoTracks", {
        configurable: true,
        get: () => trackList,
    });

    evalRepoScript(dom, "features", "autoQualityPage.js");

    const result = requestAutoQualityApply(dom, "1080p");
    assert.equal(result.status, "selected");
    assert.equal(trackList.selectedIndex, 2);
    assert.equal(preview.currentTime, 5);
    disableAutoQualityPage(dom);
    await waitForAsyncCallbacks();
    dom.window.close();
});

test("auto quality playback restore stops at an SPA route boundary", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const tracks = [
        { id: "auto", label: "auto 1080p", height: 1080 },
        { id: "480", label: "480p", height: 480, kind: "main" },
        { id: "720", label: "720p", height: 720, kind: "main" },
    ];
    const trackList = createVideoTrackList(tracks, 1);
    const scheduledTimers = [];
    const clearedTimers = new Set();

    dom.window.setTimeout = (callback, delay) => {
        const id = scheduledTimers.length + 1;
        scheduledTimers.push({ callback, delay, id });
        return id;
    };
    dom.window.clearTimeout = (id) => clearedTimers.add(id);
    video.currentTime = 30;
    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "videoTracks", {
        configurable: true,
        get: () => trackList,
    });

    evalRepoScript(dom, "features", "autoQualityPage.js");
    assert.equal(requestAutoQualityApply(dom, "1080p").status, "selected");

    const restoreTimer = scheduledTimers.find(({ delay }) => delay === 250);
    assert.ok(restoreTimer);

    dom.window.history.pushState({}, "", "/video/67890");
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));

    const replacement = document.createElement("video");
    let playCalls = 0;
    replacement.currentTime = 0;
    replacement.play = () => {
        playCalls += 1;
        return Promise.resolve();
    };
    makeVisibleVideo(replacement);
    Object.defineProperty(replacement, "paused", { configurable: true, get: () => true });
    document.querySelector("main").replaceChildren(replacement);

    assert.equal(clearedTimers.has(restoreTimer.id), true);
    restoreTimer.callback();
    assert.equal(replacement.currentTime, 0);
    assert.equal(playCalls, 0);
    disableAutoQualityPage(dom);
    await waitForAsyncCallbacks();
    dom.window.close();
});

test("auto quality page hook leaves videoTracks descriptors untouched outside playback routes", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/category/game/lives", chrome);
    const target = {};
    const getter = () => createVideoTrackList([{ id: "720", label: "720p", height: 720 }]);

    evalRepoScript(dom, "features", "autoQualityPage.js");

    dom.window.Object.defineProperty(target, "videoTracks", {
        configurable: true,
        get: getter,
    });

    assert.equal(getter.__betterChzzkVideoTracksWrapped, undefined);
    assert.equal(Object.getOwnPropertyDescriptor(target, "videoTracks").get, getter);
});

test("auto quality defineProperties hook preserves native descriptor-map semantics", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/live/test-channel", chrome);
    const nativeDefineProperty = dom.window.Object.defineProperty;
    const descriptorMapPrototype = { inherited: { configurable: true, value: "inherited" } };
    const descriptorMap = dom.window.Object.create(descriptorMapPrototype);
    const symbolKey = dom.window.Symbol("quality-test");
    const trackList = createVideoTrackList([{ id: "720", label: "720p", height: 720 }]);
    const qualityGetter = () => trackList;
    const qualityDescriptorPrototype = dom.window.Object.create(null);
    nativeDefineProperty(qualityDescriptorPrototype, "configurable", { value: true });
    nativeDefineProperty(qualityDescriptorPrototype, "enumerable", { value: true });
    nativeDefineProperty(qualityDescriptorPrototype, "get", { value: qualityGetter });
    const qualityDescriptor = dom.window.Object.create(qualityDescriptorPrototype);

    nativeDefineProperty(descriptorMap, "hidden", {
        configurable: true,
        enumerable: false,
        value: { configurable: true, enumerable: true, value: "hidden" },
    });
    nativeDefineProperty(descriptorMap, symbolKey, {
        configurable: true,
        enumerable: true,
        value: { configurable: true, enumerable: true, value: "symbol" },
    });
    nativeDefineProperty(descriptorMap, "__proto__", {
        configurable: true,
        enumerable: true,
        value: { configurable: true, enumerable: true, writable: true, value: "own-proto" },
    });
    nativeDefineProperty(descriptorMap, "videoTracks", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: qualityDescriptor,
    });
    const videoTracksMapDescriptor = Object.getOwnPropertyDescriptor(descriptorMap, "videoTracks");

    evalRepoScript(dom, "features", "autoQualityPage.js");

    const target = dom.window.Object.create(dom.window.Object.prototype);
    dom.window.Object.defineProperties(target, descriptorMap);

    assert.equal(Object.getPrototypeOf(descriptorMap), descriptorMapPrototype);
    assert.deepEqual(Object.getOwnPropertyDescriptor(descriptorMap, "videoTracks"), videoTracksMapDescriptor);
    assert.equal(Object.hasOwn(target, "hidden"), false);
    assert.equal(Object.hasOwn(target, "inherited"), false);
    assert.equal(target[symbolKey], "symbol");
    assert.equal(Object.getPrototypeOf(target), dom.window.Object.prototype);
    assert.equal(Object.hasOwn(target, "__proto__"), true);
    assert.equal(target.__proto__, "own-proto");
    assert.equal(target.videoTracks, trackList);
    const installedVideoTracksDescriptor = Object.getOwnPropertyDescriptor(target, "videoTracks");
    assert.equal(installedVideoTracksDescriptor.configurable, true);
    assert.equal(installedVideoTracksDescriptor.enumerable, true);
    assert.equal(installedVideoTracksDescriptor.get.__betterChzzkVideoTracksWrapped, true);
    disableAutoQualityPage(dom);
    dom.window.close();
});

test("auto quality defineProperties hook preserves a descriptor map locked during collection", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/live/test-channel", chrome);
    const nativeDefineProperty = dom.window.Object.defineProperty;
    const descriptorMap = dom.window.Object.create(null);
    const trackList = createVideoTrackList([{ id: "720", label: "720p", height: 720 }]);
    const qualityGetter = () => trackList;
    const qualityDescriptor = { configurable: true, get: qualityGetter };

    nativeDefineProperty(descriptorMap, "first", {
        configurable: true,
        enumerable: true,
        get() {
            nativeDefineProperty(descriptorMap, "videoTracks", {
                configurable: false,
                enumerable: true,
                writable: false,
                value: qualityDescriptor,
            });
            return { configurable: true, value: "first" };
        },
    });
    nativeDefineProperty(descriptorMap, "videoTracks", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: qualityDescriptor,
    });

    evalRepoScript(dom, "features", "autoQualityPage.js");

    const target = {};
    assert.doesNotThrow(() => dom.window.Object.defineProperties(target, descriptorMap));
    assert.equal(target.first, "first");
    assert.equal(target.videoTracks, trackList);
    assert.equal(Object.getOwnPropertyDescriptor(target, "videoTracks").get, qualityGetter);
    disableAutoQualityPage(dom);
    dom.window.close();
});

test("auto quality page hook unpatches defineProperty APIs outside playback routes", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom("<!doctype html><body></body>", "https://chzzk.naver.com/live/test-channel", chrome);
    const nativeDefineProperty = dom.window.Object.defineProperty;
    const nativeDefineProperties = dom.window.Object.defineProperties;
    const nativeReflectDefineProperty = dom.window.Reflect.defineProperty;

    evalRepoScript(dom, "features", "autoQualityPage.js");

    assert.notEqual(dom.window.Object.defineProperty, nativeDefineProperty);
    assert.notEqual(dom.window.Object.defineProperties, nativeDefineProperties);
    assert.notEqual(dom.window.Reflect.defineProperty, nativeReflectDefineProperty);

    dom.window.history.pushState({}, "", "/category/game/lives");
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:routechange", {
            detail: { href: dom.window.location.href, source: "test" },
        })
    );

    assert.equal(dom.window.Object.defineProperty, nativeDefineProperty);
    assert.equal(dom.window.Object.defineProperties, nativeDefineProperties);
    assert.equal(dom.window.Reflect.defineProperty, nativeReflectDefineProperty);

    dom.window.history.pushState({}, "", "/video/12345");
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:routechange", {
            detail: { href: dom.window.location.href, source: "test" },
        })
    );

    assert.notEqual(dom.window.Object.defineProperty, nativeDefineProperty);
    assert.notEqual(dom.window.Object.defineProperties, nativeDefineProperties);
    assert.notEqual(dom.window.Reflect.defineProperty, nativeReflectDefineProperty);

    disableAutoQualityPage(dom);

    assert.equal(dom.window.Object.defineProperty, nativeDefineProperty);
    assert.equal(dom.window.Object.defineProperties, nativeDefineProperties);
    assert.equal(dom.window.Reflect.defineProperty, nativeReflectDefineProperty);
});

test("auto quality publishes state without writing a page localStorage cache", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        "<!doctype html><body><video></video></body>",
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "autoQuality.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    assert.ok(dom.window.document.documentElement.getAttribute("data-betterchzzk-auto-quality-state"));
    assert.equal(dom.window.localStorage.getItem("betterchzzk:auto-quality:state-cache"), null);
});

test("live watch history sends cumulative session snapshots between flushes", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let mediaTime = 0;

    t.after(async () => {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    assert.equal(typeof tick, "function");
    assert.equal(typeof flush, "function");

    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTime += 10;
        tick();
    }
    flush();

    await waitForCondition(
        () =>
            chrome.testState.runtimeMessages.filter((message) => message?.operation?.kind === "upsertSessionSnapshot")
                .length === 1
    );

    clock.advance(10000);
    mediaTime += 10;
    tick();
    flush();

    await waitForCondition(
        () =>
            chrome.testState.runtimeMessages.filter((message) => message?.operation?.kind === "upsertSessionSnapshot")
                .length === 2
    );
    assert.equal(Object.keys(chrome.testState.local.betterChzzkLiveWatchHistory.entries).length, 1);
});

test("live watch history follows an in-flight open snapshot with the closed state", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    let releaseFirstResponse = null;
    chrome.runtime.sendMessage = (message, callback) => {
        const isFirstSnapshot = message?.operation?.kind === "upsertSessionSnapshot" && releaseFirstResponse === null;
        if (!isFirstSnapshot) {
            originalSendMessage(message, callback);
            return;
        }
        originalSendMessage(message, (response) => {
            releaseFirstResponse = () => callback?.(response);
        });
    };
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let mediaTime = 0;

    t.after(() => dom.window.close());

    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(() => typeof releaseFirstResponse === "function");

    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
    }
    await waitForAsyncCallbacks();
    releaseFirstResponse();

    await waitForCondition(
        () =>
            chrome.testState.runtimeMessages.filter((message) => message?.operation?.kind === "upsertSessionSnapshot")
                .length === 2
    );
    const snapshots = chrome.testState.runtimeMessages.filter(
        (message) => message?.operation?.kind === "upsertSessionSnapshot"
    );
    assert.equal(snapshots[0].operation.session.closed, false);
    assert.equal(snapshots[1].operation.session.closed, true);
    await waitForCondition(
        () => Object.values(chrome.testState.local.betterChzzkLiveWatchHistory.entries)[0].sessionDetails[0].closed
    );
});

test("live watch history keeps a pagehide force flush after an in-flight periodic write fails", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    let releaseFirstFailure = null;
    chrome.runtime.sendMessage = (message, callback) => {
        if (message?.operation?.kind === "upsertSessionSnapshot" && releaseFirstFailure === null) {
            chrome.testState.runtimeMessages.push(message);
            releaseFirstFailure = () => callback?.({ ok: false, error: "temporary failure" });
            return;
        }
        originalSendMessage(message, callback);
    };
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let mediaTime = 0;

    t.after(async () => {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(() => typeof releaseFirstFailure === "function");

    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    releaseFirstFailure();

    await waitForCondition(() => chrome.testState.runtimeMessages.length === 2);
    assert.equal(chrome.testState.runtimeMessages[1].operation.session.watchedSeconds, 60);
    await waitForCondition(() => Object.keys(chrome.testState.local.betterChzzkLiveWatchHistory.entries).length === 1);
});

test("live watch history starts the next SPA live session while the previous close is in flight", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    let snapshotCallCount = 0;
    let releaseClosedResponse = null;
    chrome.runtime.sendMessage = (message, callback) => {
        if (message?.operation?.kind !== "upsertSessionSnapshot") {
            originalSendMessage(message, callback);
            return;
        }
        snapshotCallCount += 1;
        if (snapshotCallCount === 2) {
            originalSendMessage(message, (response) => {
                releaseClosedResponse = () => callback?.(response);
            });
            return;
        }
        originalSendMessage(message, callback);
    };
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video-a"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/channel-a",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    let mediaTimeA = 0;
    let mediaTimeB = 0;

    function configurePlayingVideo(video, getMediaTime) {
        makeVisibleVideo(video);
        Object.defineProperty(video, "paused", { configurable: true, get: () => false });
        Object.defineProperty(video, "ended", { configurable: true, get: () => false });
        Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
        Object.defineProperty(video, "currentTime", { configurable: true, get: getMediaTime });
        Object.defineProperty(video, "readyState", {
            configurable: true,
            get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
        });
    }

    t.after(async () => {
        releaseClosedResponse?.();
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    const videoA = dom.window.document.getElementById("video-a");
    configurePlayingVideo(videoA, () => mediaTimeA);

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTimeA += 10;
        tick();
    }
    flush();
    await waitForCondition(() => chrome.testState.runtimeMessages.length === 1);

    const videoB = dom.window.document.createElement("video");
    videoB.id = "video-b";
    configurePlayingVideo(videoB, () => mediaTimeB);
    videoA.replaceWith(videoB);
    dom.window.history.pushState({}, "", "/live/channel-b");
    dom.window.dispatchEvent(
        new dom.window.CustomEvent("betterchzzk:routechange", {
            detail: { href: dom.window.location.href, source: "test" },
        })
    );
    await waitForCondition(() => typeof releaseClosedResponse === "function");

    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTimeB += 10;
        tick();
    }
    flush();
    await waitForCondition(() => chrome.testState.runtimeMessages.length === 3);

    const [openA, closedA, openB] = chrome.testState.runtimeMessages.map((message) => message.operation);
    assert.equal(openA.entry.channelId, "channel-a");
    assert.equal(closedA.entry.channelId, "channel-a");
    assert.equal(closedA.session.closed, true);
    assert.equal(closedA.session.watchedSeconds, 60);
    assert.equal(openB.entry.channelId, "channel-b");
    assert.equal(openB.session.closed, false);
    assert.equal(openB.session.watchedSeconds, 60);
    assert.notEqual(openB.session.id, openA.session.id);
});

test("live watch history releases an acknowledged closed session after in-flight reactivation", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    let snapshotCallCount = 0;
    let releaseClosedResponse = null;
    chrome.runtime.sendMessage = (message, callback) => {
        if (message?.operation?.kind !== "upsertSessionSnapshot") {
            originalSendMessage(message, callback);
            return;
        }
        snapshotCallCount += 1;
        if (snapshotCallCount === 2) {
            originalSendMessage(message, (response) => {
                releaseClosedResponse = () => callback?.(response);
            });
            return;
        }
        originalSendMessage(message, callback);
    };
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let mediaTime = 0;

    t.after(async () => {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(() => chrome.testState.runtimeMessages.length === 1);
    await waitForAsyncCallbacks();

    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
    }
    await waitForCondition(() => typeof releaseClosedResponse === "function");
    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ liveWatchHistoryEnabled: { newValue: true } }, "sync");
    }
    await waitForAsyncCallbacks();
    releaseClosedResponse();
    await waitForAsyncCallbacks();

    const closedSessionId = chrome.testState.runtimeMessages[1].operation.session.id;
    for (let index = 0; index < 7; index += 1) {
        clock.advance(10000);
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(() => chrome.testState.runtimeMessages.length === 3);

    assert.notEqual(chrome.testState.runtimeMessages[2].operation.session.id, closedSessionId);
    assert.equal(chrome.testState.runtimeMessages[2].operation.session.closed, false);
});

test("live watch history bounds closed-flush retries and resumes after cooldown", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    let allowSuccess = true;
    chrome.runtime.sendMessage = (message, callback) => {
        if (message?.operation?.kind === "upsertSessionSnapshot" && !allowSuccess) {
            chrome.testState.runtimeMessages.push(message);
            setTimeout(() => callback?.({ ok: false, error: "temporary failure" }), 0);
            return;
        }
        originalSendMessage(message, callback);
    };
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let mediaTime = 0;

    t.after(async () => {
        allowSuccess = true;
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const originalSetTimeout = dom.window.setTimeout.bind(dom.window);
    const originalClearTimeout = dom.window.clearTimeout.bind(dom.window);
    const retryTimers = [];
    let fakeTimerId = 10000;
    dom.window.setTimeout = (callback, delayMs, ...args) => {
        if ([5000, 10000, 20000, 40000, 300000].includes(delayMs)) {
            const timer = { callback: () => callback(...args), delayMs, id: fakeTimerId++, active: true };
            retryTimers.push(timer);
            return timer.id;
        }
        return originalSetTimeout(callback, delayMs, ...args);
    };
    dom.window.clearTimeout = (timerId) => {
        const timer = retryTimers.find((candidate) => candidate.id === timerId);
        if (timer) {
            timer.active = false;
            return;
        }
        originalClearTimeout(timerId);
    };

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(() => chrome.testState.runtimeMessages.length === 1);
    await waitForAsyncCallbacks();
    assert.equal(chrome.testState.runtimeMessages[0].operation.session.closed, false);

    allowSuccess = false;
    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
    }
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.runtimeMessages.length, 2);
    assert.equal(chrome.testState.runtimeMessages[1].operation.session.closed, true);

    for (let index = 0; index < 4; index += 1) {
        await waitForCondition(() => retryTimers[index]?.active === true);
        retryTimers[index].active = false;
        retryTimers[index].callback();
        await waitForCondition(() => chrome.testState.runtimeMessages.length === index + 3);
    }
    await waitForAsyncCallbacks();
    assert.deepEqual(
        retryTimers.map((timer) => timer.delayMs),
        [5000, 10000, 20000, 40000, 300000]
    );
    assert.equal(chrome.testState.runtimeMessages.length, 6);

    allowSuccess = true;
    retryTimers[4].active = false;
    retryTimers[4].callback();
    await waitForCondition(() => chrome.testState.runtimeMessages.length === 7);
    assert.equal(chrome.testState.runtimeMessages[6].operation.session.closed, true);
    await waitForCondition(
        () => Object.values(chrome.testState.local.betterChzzkLiveWatchHistory.entries)[0].sessionDetails[0].closed
    );
});

test("live watch history skips force flush when session state is unchanged", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let mediaTime = 0;

    t.after(async () => {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    assert.equal(typeof tick, "function");
    assert.equal(typeof flush, "function");

    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTime += 10;
        tick();
    }
    flush();

    await waitForCondition(
        () =>
            chrome.testState.runtimeMessages.filter((message) => message?.operation?.kind === "upsertSessionSnapshot")
                .length === 1
    );

    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    await waitForAsyncCallbacks();

    assert.equal(
        chrome.testState.runtimeMessages.filter((message) => message?.operation?.kind === "upsertSessionSnapshot")
            .length,
        1
    );
});

test("live watch history requires media progress before counting watch time", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let mediaTime = 0;

    t.after(async () => {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    assert.equal(typeof tick, "function");
    assert.equal(typeof flush, "function");

    for (let index = 0; index < 7; index += 1) {
        clock.advance(10000);
        tick();
    }
    flush();
    await waitForAsyncCallbacks();
    assert.equal(
        chrome.testState.runtimeMessages.filter((message) => message?.operation?.kind === "upsertSessionSnapshot")
            .length,
        0
    );

    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(
        () =>
            chrome.testState.runtimeMessages.filter((message) => message?.operation?.kind === "upsertSessionSnapshot")
                .length === 1
    );
    const entry = Object.values(chrome.testState.local.betterChzzkLiveWatchHistory.entries)[0];
    assert.equal(entry.watchedSeconds, 60);
});

test("live watch history restarts an active session after a retired checkpoint barrier", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    let retiredBarrier = 0;
    chrome.runtime.sendMessage = (message, callback) => {
        if (message?.operation?.kind === "upsertSessionSnapshot" && retiredBarrier === 0) {
            chrome.testState.runtimeMessages.push(message);
            retiredBarrier = message.operation.session.leftAt;
            setTimeout(
                () =>
                    callback?.({ ok: true, result: { status: "ignored", reason: "retired", barrier: retiredBarrier } }),
                0
            );
            return;
        }
        originalSendMessage(message, callback);
    };
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let nowMs = Date.parse("2026-07-10T12:00:00+09:00");
    let mediaTime = 0;

    t.after(async () => {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    dom.window.Date.now = () => nowMs;
    dom.window.fetch = async () => {
        throw new Error("metadata unavailable");
    };
    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        nowMs += 10000;
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(() => retiredBarrier > 0);
    await waitForAsyncCallbacks();

    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        nowMs += 10000;
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(() => chrome.testState.runtimeMessages.length === 2);

    const [retiredSnapshot, restartedSnapshot] = chrome.testState.runtimeMessages.map((message) => message.operation);
    assert.notEqual(restartedSnapshot.session.id, retiredSnapshot.session.id);
    assert.equal(restartedSnapshot.session.enteredAt, retiredBarrier + 1);
    assert.equal(restartedSnapshot.session.watchedSeconds, 60);
    assert.equal(Object.values(chrome.testState.local.betterChzzkLiveWatchHistory.entries)[0].watchedSeconds, 60);
});

test("live watch history caps stored watched ranges per session", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let nowMs = Date.parse("2026-06-29T12:00:00+09:00");
    let mediaTime = 0;

    t.after(async () => {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    dom.window.Date.now = () => nowMs;
    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    assert.equal(typeof tick, "function");
    assert.equal(typeof flush, "function");

    for (let index = 0; index < 205; index += 1) {
        clock.advance(10000);
        nowMs += 20000;
        mediaTime += 10;
        tick();
    }
    flush();

    await waitForCondition(() => chrome.testState.local.betterChzzkLiveWatchHistory);

    const entry = Object.values(chrome.testState.local.betterChzzkLiveWatchHistory.entries)[0];
    const detail = entry.sessionDetails[0];
    assert.equal(detail.watchedRanges.length, 200);
    assert.ok(detail.watchedSeconds >= 2000);
});

test("live watch history migrates a flushed provisional record when live detail arrives later", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    let releaseProvisionalResponse = null;
    let provisionalResponseHeld = false;
    chrome.runtime.sendMessage = (message, callback) => {
        if (message?.operation?.kind === "upsertSessionSnapshot" && !provisionalResponseHeld) {
            provisionalResponseHeld = true;
            originalSendMessage(message, () => {
                releaseProvisionalResponse = () =>
                    callback?.({ ok: true, result: { status: "ignored", reason: "deleted", barrier: Date.now() } });
            });
            return;
        }
        originalSendMessage(message, callback);
    };
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let mediaTime = 0;
    let resolveLiveDetail = null;

    t.after(async () => {
        releaseProvisionalResponse?.();
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    dom.window.fetch = () =>
        new Promise((resolve) => {
            resolveLiveDetail = () =>
                resolve({
                    ok: true,
                    json: async () => ({ content: { liveId: "late-live" } }),
                });
        });
    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForCondition(() => typeof resolveLiveDetail === "function");

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(() => typeof releaseProvisionalResponse === "function");
    const provisionalRecordId = chrome.testState.runtimeMessages[0].operation.recordId;
    assert.match(provisionalRecordId, /^channel:test-channel:provisional:/);

    resolveLiveDetail();
    await waitForCondition(() =>
        chrome.testState.runtimeMessages.some((message) => message?.operation?.kind === "migrateRecordId")
    );
    await waitForCondition(() => chrome.testState.local.betterChzzkLiveWatchHistory.entries["live:late-live"]);
    const history = chrome.testState.local.betterChzzkLiveWatchHistory;
    assert.equal(history.entries[provisionalRecordId], undefined);
    assert.equal(history.entries["live:late-live"].watchedSeconds, 60);
    assert.equal(history.entries["live:late-live"].liveId, "late-live");
    assert.equal(history.recordAliases[provisionalRecordId].targetRecordId, "live:late-live");

    releaseProvisionalResponse();
    releaseProvisionalResponse = null;
    await waitForCondition(
        () =>
            chrome.testState.runtimeMessages.filter((message) => message?.operation?.kind === "upsertSessionSnapshot")
                .length === 2
    );
    const snapshots = chrome.testState.runtimeMessages.filter(
        (message) => message?.operation?.kind === "upsertSessionSnapshot"
    );
    assert.equal(snapshots[1].operation.recordId, "live:late-live");
    assert.equal(snapshots[1].operation.session.id, snapshots[0].operation.session.id);
});

test("live watch history keeps a deleted provisional id until migration is acknowledged", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, callback) => {
        if (message?.operation?.kind === "migrateRecordId") {
            chrome.testState.runtimeMessages.push(message);
            setTimeout(() => callback?.({ ok: false, error: "migration unavailable" }), 0);
            return;
        }
        originalSendMessage(message, callback);
    };
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let nowMs = Date.parse("2026-07-10T12:00:00+09:00");
    let mediaTime = 0;
    let resolveLiveDetail = null;

    t.after(async () => {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    dom.window.Date.now = () => nowMs;
    dom.window.fetch = () =>
        new Promise((resolve) => {
            resolveLiveDetail = () =>
                resolve({
                    ok: true,
                    json: async () => ({ content: { liveId: "failed-migration-live" } }),
                });
        });
    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForCondition(() => typeof resolveLiveDetail === "function");

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        nowMs += 10000;
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(
        () =>
            chrome.testState.runtimeMessages.filter((message) => message?.operation?.kind === "upsertSessionSnapshot")
                .length === 1
    );
    const sourceRecordId = chrome.testState.runtimeMessages[0].operation.recordId;
    const deletion = watchHistoryStore.applyMutation(
        chrome.testState.local.betterChzzkLiveWatchHistory,
        { kind: "deleteEntries", entryIds: [sourceRecordId], cutoffAt: nowMs },
        nowMs
    );
    chrome.testState.local.betterChzzkLiveWatchHistory = deletion.history;

    resolveLiveDetail();
    await waitForCondition(() =>
        chrome.testState.runtimeMessages.some((message) => message?.operation?.kind === "migrateRecordId")
    );
    clock.advance(10000);
    nowMs += 10000;
    mediaTime += 10;
    tick();
    flush();
    await waitForCondition(
        () =>
            chrome.testState.runtimeMessages.filter((message) => message?.operation?.kind === "upsertSessionSnapshot")
                .length === 2
    );

    const snapshots = chrome.testState.runtimeMessages.filter(
        (message) => message?.operation?.kind === "upsertSessionSnapshot"
    );
    assert.equal(snapshots[1].operation.recordId, sourceRecordId);
    assert.equal(chrome.testState.local.betterChzzkLiveWatchHistory.entries[sourceRecordId], undefined);
    assert.equal(chrome.testState.local.betterChzzkLiveWatchHistory.entries["live:failed-migration-live"], undefined);
});

test("live watch history gives same-channel sessions distinct provisional record ids", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let mediaTime = 0;

    t.after(async () => {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    dom.window.fetch = async () => {
        throw new Error("metadata unavailable");
    };
    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    let tick = intervals.find((interval) => interval.ms === 5000 && !interval.cleared)?.fn;
    let flush = intervals.find((interval) => interval.ms === 15000 && !interval.cleared)?.fn;
    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(
        () =>
            chrome.testState.runtimeMessages.filter((message) => message?.operation?.kind === "upsertSessionSnapshot")
                .length === 1
    );

    dom.window.history.pushState({}, "", "/category/test/lives");
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));
    await waitForAsyncCallbacks();
    dom.window.history.pushState({}, "", "/live/test-channel");
    dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));
    await waitForAsyncCallbacks();

    tick = intervals.findLast((interval) => interval.ms === 5000 && !interval.cleared)?.fn;
    flush = intervals.findLast((interval) => interval.ms === 15000 && !interval.cleared)?.fn;
    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(
        () =>
            chrome.testState.runtimeMessages.filter(
                (message) =>
                    message?.operation?.kind === "upsertSessionSnapshot" && message.operation.session.closed !== true
            ).length === 2
    );

    const openSnapshots = chrome.testState.runtimeMessages
        .map((message) => message.operation)
        .filter((operation) => operation?.kind === "upsertSessionSnapshot" && operation.session.closed !== true);
    assert.notEqual(openSnapshots[0].session.id, openSnapshots[1].session.id);
    assert.notEqual(openSnapshots[0].recordId, openSnapshots[1].recordId);
    assert.match(openSnapshots[0].recordId, /^channel:test-channel:provisional:/);
    assert.match(openSnapshots[1].recordId, /^channel:test-channel:provisional:/);
    assert.equal(Object.keys(chrome.testState.local.betterChzzkLiveWatchHistory.entries).length, 2);
});

test("live watch history preserves capped aggregates and pins the first resolved live id", async (t) => {
    const dateKey = "2026-06-29";
    const dayStartMs = Date.parse("2026-06-29T00:00:00+09:00");
    const nowStartMs = Date.parse("2026-06-29T20:00:00+09:00");
    const storedSessionCount = 301;
    const retainedSessionCount = 300;
    const storedSeconds = storedSessionCount * 60;
    const retainedSessions = Array.from({ length: retainedSessionCount }, (_, index) => {
        const enteredAt = dayStartMs + index * 3 * 60 * 1000;
        return {
            closed: true,
            dailySeconds: { [dateKey]: 60 },
            enteredAt,
            id: `stored-session-${index}`,
            leftAt: enteredAt + 60 * 1000,
            title: "저장된 방송",
            watchedSeconds: 60,
        };
    });
    const recordId = "live:capped-live";
    const chrome = createFakeChrome({
        local: {
            betterChzzkLiveWatchHistory: {
                entries: {
                    [recordId]: {
                        channelId: "test-channel",
                        channelName: "테스트 채널",
                        dailySeconds: { [dateKey]: storedSeconds },
                        firstWatchedAt: dayStartMs - 3 * 60 * 1000,
                        id: recordId,
                        lastWatchedAt: retainedSessions.at(-1).leftAt,
                        liveId: "capped-live",
                        liveUrl: "https://chzzk.naver.com/live/test-channel",
                        sessionDetails: retainedSessions,
                        sessions: storedSessionCount,
                        title: "저장된 방송",
                        watchedSeconds: storedSeconds,
                    },
                },
                updatedAt: nowStartMs,
                version: 1,
            },
        },
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let nowMs = nowStartMs;
    let mediaTime = 0;
    let apiLiveId = "capped-live";
    let metadataRefreshCallback = null;
    let metadataTimerId = 50000;
    const metadataTimerIds = new Set();
    const originalSetTimeout = dom.window.setTimeout.bind(dom.window);
    const originalClearTimeout = dom.window.clearTimeout.bind(dom.window);
    dom.window.setTimeout = (callback, delayMs, ...args) => {
        if (delayMs === 60000) {
            const id = metadataTimerId++;
            metadataTimerIds.add(id);
            metadataRefreshCallback = () => callback(...args);
            return id;
        }
        return originalSetTimeout(callback, delayMs, ...args);
    };
    dom.window.clearTimeout = (id) => {
        if (metadataTimerIds.has(id)) {
            metadataTimerIds.delete(id);
            return;
        }
        originalClearTimeout(id);
    };

    t.after(async () => {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    dom.window.Date.now = () => nowMs;
    dom.window.fetch = async () => ({
        ok: true,
        json: async () => ({ content: { liveId: apiLiveId } }),
    });
    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    assert.equal(typeof tick, "function");
    assert.equal(typeof flush, "function");

    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        nowMs += 10000;
        mediaTime += 10;
        tick();
    }
    flush();

    await waitForCondition(() => chrome.testState.local.betterChzzkLiveWatchHistory.updatedAt > nowStartMs);
    const entry = chrome.testState.local.betterChzzkLiveWatchHistory.entries[recordId];
    assert.equal(entry.watchedSeconds, storedSeconds + 60);
    assert.equal(entry.dailySeconds[dateKey], storedSeconds + 60);
    assert.equal(entry.sessions, storedSessionCount + 1);
    assert.equal(entry.sessionDetails.length, retainedSessionCount);

    apiLiveId = "changed-live";
    assert.equal(typeof metadataRefreshCallback, "function");
    metadataRefreshCallback();
    await waitForAsyncCallbacks();
    clock.advance(10000);
    nowMs += 10000;
    mediaTime += 10;
    tick();
    flush();
    await waitForCondition(
        () =>
            chrome.testState.runtimeMessages.filter((message) => message?.operation?.kind === "upsertSessionSnapshot")
                .length === 2
    );
    assert.equal(
        chrome.testState.runtimeMessages.some((message) => message?.operation?.kind === "migrateRecordId"),
        false
    );
    assert.equal(chrome.testState.local.betterChzzkLiveWatchHistory.entries["live:changed-live"], undefined);
    assert.equal(chrome.testState.local.betterChzzkLiveWatchHistory.entries[recordId].liveId, "capped-live");
});

test("live watch history splits same-channel broadcasts when live detail changes", async (t) => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: true,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<head><title>A DOM 제목</title></head>",
            "<body>",
            "<main>",
            '<video id="video"></video>',
            "</main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const intervals = captureIntervals(dom);
    const clock = useFakePerformanceNow(dom);
    const video = dom.window.document.getElementById("video");
    let nowMs = Date.parse("2026-07-10T12:00:00+09:00");
    let mediaTime = 0;
    let apiLiveId = "broadcast-a";
    let apiTitle = "A 방송";
    let metadataRefreshCallback = null;
    let metadataTimerId = 60000;
    const metadataTimerIds = new Set();
    const originalSetTimeout = dom.window.setTimeout.bind(dom.window);
    const originalClearTimeout = dom.window.clearTimeout.bind(dom.window);
    dom.window.setTimeout = (callback, delayMs, ...args) => {
        if (delayMs === 60000) {
            const id = metadataTimerId++;
            metadataTimerIds.add(id);
            metadataRefreshCallback = () => callback(...args);
            return id;
        }
        return originalSetTimeout(callback, delayMs, ...args);
    };
    dom.window.clearTimeout = (id) => {
        if (metadataTimerIds.has(id)) {
            metadataTimerIds.delete(id);
            return;
        }
        originalClearTimeout(id);
    };

    t.after(async () => {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ liveWatchHistoryEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    });

    dom.window.Date.now = () => nowMs;
    dom.window.fetch = async () => ({
        ok: true,
        json: async () => ({
            content: {
                channelName: "테스트 채널",
                liveId: apiLiveId,
                liveTitle: apiTitle,
            },
        }),
    });
    makeVisibleVideo(video);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    Object.defineProperty(video, "playbackRate", { configurable: true, get: () => 1 });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => mediaTime });
    Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => dom.window.HTMLMediaElement.HAVE_CURRENT_DATA,
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "liveWatchHistory.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForCondition(() => typeof metadataRefreshCallback === "function");

    const tick = intervals.find((interval) => interval.ms === 5000)?.fn;
    const flush = intervals.find((interval) => interval.ms === 15000)?.fn;
    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        nowMs += 10000;
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(
        () => chrome.testState.local.betterChzzkLiveWatchHistory?.entries?.["live:broadcast-a"]?.watchedSeconds === 60
    );

    apiLiveId = "broadcast-b";
    apiTitle = "B 방송";
    dom.window.document.title = "B DOM 제목";
    metadataRefreshCallback();
    await waitForCondition(() =>
        chrome.testState.runtimeMessages.some(
            (message) =>
                message?.operation?.kind === "upsertSessionSnapshot" &&
                message.operation.recordId === "live:broadcast-a" &&
                message.operation.session.closed === true
        )
    );
    await waitForAsyncCallbacks();

    for (let index = 0; index < 6; index += 1) {
        clock.advance(10000);
        nowMs += 10000;
        mediaTime += 10;
        tick();
    }
    flush();
    await waitForCondition(
        () => chrome.testState.local.betterChzzkLiveWatchHistory?.entries?.["live:broadcast-b"]?.watchedSeconds === 60
    );
    video.dispatchEvent(new dom.window.Event("ended"));
    await waitForCondition(
        () =>
            chrome.testState.local.betterChzzkLiveWatchHistory.entries["live:broadcast-b"].sessionDetails[0].closed ===
            true
    );

    const history = chrome.testState.local.betterChzzkLiveWatchHistory;
    const entryA = history.entries["live:broadcast-a"];
    const entryB = history.entries["live:broadcast-b"];
    assert.equal(Object.keys(history.entries).length, 2);
    assert.equal(entryA.watchedSeconds, 60);
    assert.equal(entryB.watchedSeconds, 60);
    assert.equal(entryA.title, "A 방송");
    assert.equal(entryB.title, "B 방송");
    assert.equal(entryA.sessionDetails[0].title, "A 방송");
    assert.equal(entryB.sessionDetails[0].title, "B 방송");
    assert.notEqual(entryA.sessionDetails[0].id, entryB.sessionDetails[0].id);
    assert.equal(
        entryA.titleHistory.some((row) => row.title === "B 방송"),
        false
    );
    assert.equal(
        entryB.titleHistory.some((row) => row.title === "A 방송"),
        false
    );
});

test("VOD replay chat fix ignores currentTime-only URL changes on the same VOD", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const scheduledTimers = [];

    dom.window.setTimeout = (callback, delay) => {
        scheduledTimers.push({ callback, delay });
        return scheduledTimers.length;
    };
    dom.window.clearTimeout = () => {};
    video.currentTime = 20;
    makeVisibleVideo(video);

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "vodReplayChatFix.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();

    scheduledTimers.length = 0;
    dom.window.history.pushState({}, "", "/video/12345?currentTime=30");
    document.body.appendChild(document.createElement("div"));
    await waitForAsyncCallbacks();

    assert.equal(scheduledTimers.length, 0);
    assert.equal(dom.window.sessionStorage.getItem("betterchzzk:vod-chat-reload:/video/12345"), null);
});

test("VOD replay chat fix runs even when the old stored option is disabled", async () => {
    const chrome = createFakeChrome({
        sync: {
            vodReplayChatFixEnabled: false,
        },
    });
    const dom = createPageDom(
        ["<!doctype html>", "<body>", "<main>", '<video id="video"></video>', "</main>", "</body>"].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const scheduledTimers = [];

    dom.window.setTimeout = (callback, delay) => {
        scheduledTimers.push({ callback, delay });
        return scheduledTimers.length;
    };
    dom.window.clearTimeout = () => {};
    makeVisibleVideo(video);

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "vodReplayChatFix.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();

    scheduledTimers.length = 0;
    dom.window.history.pushState({}, "", "/video/67890");
    document.body.appendChild(document.createElement("div"));
    await waitForAsyncCallbacks();

    assert.deepEqual(
        scheduledTimers.map(({ delay }) => delay).filter((delay) => delay >= 12000),
        [12000, 16000, 22000]
    );
});

async function createVodBroadcastClockFixture(
    detail,
    { currentTime = 2, linkedDetails = {}, videoNo = "12345", watchHistory = [] } = {}
) {
    const chrome = createFakeChrome({
        local: {
            betterChzzkLiveWatchHistory: { entries: watchHistory },
        },
        sync: {
            liveWatchHistoryEnabled: watchHistory.length > 0,
            vodBroadcastClockEnabled: true,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            "<main>",
            '<video id="video"></video>',
            '<div class="pzp-vod-time" id="time">0:00 / 1:00</div>',
            '<h1 id="title">Split VOD fixture</h1>',
            "</main>",
            "</body>",
        ].join(""),
        `https://chzzk.naver.com/video/${videoNo}`,
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const time = document.getElementById("time");
    const title = document.getElementById("title");

    video.currentTime = currentTime;
    makeVisibleVideo(video);
    time.getBoundingClientRect = () => ({
        width: 120,
        height: 24,
        left: 16,
        top: 324,
        right: 136,
        bottom: 348,
    });
    title.getBoundingClientRect = () => ({
        width: 480,
        height: 36,
        left: 16,
        top: 372,
        right: 496,
        bottom: 408,
    });
    dom.window.fetch = async (url) => {
        const requestedVideoNo = decodeURIComponent(String(url).split("/").pop());
        const requestedDetail = requestedVideoNo === videoNo ? detail : linkedDetails[requestedVideoNo];
        assert.ok(requestedDetail, `unexpected VOD detail request: ${requestedVideoNo}`);
        return {
            ok: true,
            json: async () => ({
                content: {
                    videoNo: requestedVideoNo,
                    videoTitle: "Split VOD fixture",
                    ...requestedDetail,
                },
            }),
        };
    };

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "vodBroadcastClock.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));

    await waitForCondition(() => {
        const clock = document.getElementById("betterchzzk-vod-broadcast-clock");
        return Boolean(clock?.querySelector(".bcbc-time")?.textContent);
    });

    return {
        clock: document.getElementById("betterchzzk-vod-broadcast-clock"),
        chrome,
        dom,
        video,
    };
}

test("VOD broadcast clock keeps normal VOD start time without a split offset", async () => {
    const originalStart = Date.parse("2026-06-28T00:00:00+09:00");
    const durationSeconds = 60 * 60;
    const { clock } = await createVodBroadcastClockFixture({
        liveOpenDate: "2026-06-28 00:00:00",
        duration: durationSeconds,
        publishDate: new Date(originalStart + durationSeconds * 1000).toISOString(),
    });

    assert.equal(clock.querySelector(".bcbc-time").textContent, "00:00:02");
    assert.match(clock.title, /2026-06-28 00:00:00 KST/);
    assert.equal(clock.title.includes("VOD"), false);
});

test("VOD broadcast clock reuses an unchanged title history panel across time updates", async () => {
    const originalStart = Date.parse("2026-06-28T00:00:00+09:00");
    const durationSeconds = 60 * 60;
    const { chrome, dom, video } = await createVodBroadcastClockFixture(
        {
            liveOpenDate: "2026-06-28 00:00:00",
            duration: durationSeconds,
            publishDate: new Date(originalStart + durationSeconds * 1000).toISOString(),
        },
        {
            watchHistory: [
                {
                    id: "history-12345",
                    replayVideoNo: "12345",
                    title: "Split VOD fixture",
                    firstWatchedAt: originalStart,
                    lastWatchedAt: originalStart + 1000,
                    titleHistory: [
                        {
                            title: "Earlier fixture title",
                            firstSeenAt: originalStart - 2000,
                            lastSeenAt: originalStart - 1000,
                        },
                    ],
                },
            ],
        }
    );

    try {
        await waitForCondition(() => dom.window.document.getElementById("betterchzzk-vod-title-history-panel"));
        const panel = dom.window.document.getElementById("betterchzzk-vod-title-history-panel");
        const initialRow = panel.querySelector(".bcbc-title-history-row");
        let replaceCalls = 0;
        let hiddenMutations = 0;
        const replaceChildren = panel.replaceChildren.bind(panel);
        panel.replaceChildren = (...nodes) => {
            replaceCalls += 1;
            return replaceChildren(...nodes);
        };
        const observer = new dom.window.MutationObserver((mutations) => {
            hiddenMutations += mutations.filter(
                (mutation) => mutation.type === "attributes" && mutation.attributeName === "hidden"
            ).length;
        });
        observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });

        video.dispatchEvent(new dom.window.Event("timeupdate", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 220));
        observer.disconnect();

        assert.equal(panel.querySelector(".bcbc-title-history-row"), initialRow);
        assert.equal(replaceCalls, 0);
        assert.equal(hiddenMutations, 0);
    } finally {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener(
                {
                    liveWatchHistoryEnabled: { oldValue: true, newValue: false },
                    vodBroadcastClockEnabled: { oldValue: true, newValue: false },
                },
                "sync"
            );
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    }
});

test("VOD broadcast clock applies a 17h split offset for the second VOD segment", async () => {
    const originalStart = Date.parse("2026-06-28T00:00:00+09:00");
    const durationSeconds = 60 * 60;
    const secondSegmentStart = originalStart + 17 * 60 * 60 * 1000;
    const { clock } = await createVodBroadcastClockFixture({
        liveOpenDate: "2026-06-28 00:00:00",
        duration: durationSeconds,
        publishDate: new Date(secondSegmentStart + durationSeconds * 1000).toISOString(),
    });

    assert.equal(clock.querySelector(".bcbc-time").textContent, "17:00:02");
    assert.match(clock.title, /2026-06-28 17:00:00 KST/);
    assert.match(clock.title, /2026-06-28 00:00:00 KST/);
    assert.match(clock.title, /\+17:00:00/);
});

test("VOD broadcast clock applies a 34h split offset for the third VOD segment", async () => {
    const originalStart = Date.parse("2026-06-28T00:00:00+09:00");
    const durationSeconds = 60 * 60;
    const thirdSegmentStart = originalStart + 34 * 60 * 60 * 1000;
    const { clock } = await createVodBroadcastClockFixture({
        liveOpenDate: "2026-06-28 00:00:00",
        duration: durationSeconds,
        liveCloseDate: new Date(thirdSegmentStart + durationSeconds * 1000).toISOString(),
    });

    assert.equal(clock.querySelector(".bcbc-time").textContent, "10:00:02");
    assert.match(clock.title, /2026-06-29 10:00:00 KST/);
    assert.match(clock.title, /\+34:00:00/);
});

test("VOD broadcast clock follows linked 17h segments when publish processing is delayed", async () => {
    const liveOpenDate = "2026-07-10 19:01:32";
    const segmentOne = {
        duration: 17 * 60 * 60,
        liveOpenDate,
        nextVideo: { duration: 60 * 60, videoNo: "unrelated" },
    };
    const { clock: secondClock } = await createVodBroadcastClockFixture(
        {
            duration: 17 * 60 * 60 + 1,
            liveOpenDate,
            nextVideo: { duration: 17 * 60 * 60, videoNo: "segment-one" },
            publishDate: "2026-07-12 14:28:21",
        },
        { linkedDetails: { "segment-one": segmentOne } }
    );
    const { clock: thirdClock } = await createVodBroadcastClockFixture(
        {
            duration: 7 * 60 * 60 + 55 * 60 + 56,
            liveOpenDate,
            nextVideo: { duration: 17 * 60 * 60 + 1, videoNo: "segment-two" },
            publishDate: "2026-07-12 16:55:34",
        },
        {
            linkedDetails: {
                "segment-one": segmentOne,
                "segment-two": {
                    duration: 17 * 60 * 60 + 1,
                    liveOpenDate,
                    nextVideo: { duration: 17 * 60 * 60, videoNo: "segment-one" },
                },
            },
        }
    );

    assert.equal(secondClock.querySelector(".bcbc-time").textContent, "12:01:34");
    assert.match(secondClock.title, /2026-07-11 12:01:32 KST/);
    assert.match(secondClock.title, /\+17:00:00/);
    assert.equal(thirdClock.querySelector(".bcbc-time").textContent, "05:01:34");
    assert.match(thirdClock.title, /2026-07-12 05:01:32 KST/);
    assert.match(thirdClock.title, /\+34:00:00/);
});

test("VOD broadcast clock ignores small publish delays as normal VOD processing time", async () => {
    const originalStart = Date.parse("2026-06-28T00:00:00+09:00");
    const durationSeconds = 60 * 60;
    const { clock } = await createVodBroadcastClockFixture({
        liveOpenDate: "2026-06-28 00:00:00",
        duration: durationSeconds,
        publishDate: new Date(originalStart + durationSeconds * 1000 + 7 * 60 * 1000).toISOString(),
    });

    assert.equal(clock.querySelector(".bcbc-time").textContent, "00:00:02");
    assert.equal(clock.title.includes("VOD"), false);
});

test("VOD broadcast clock stays hidden when the broadcast start time is unavailable", async () => {
    const chrome = createFakeChrome({
        sync: {
            liveWatchHistoryEnabled: false,
            vodBroadcastClockEnabled: true,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            "<main>",
            '<video id="video"></video>',
            '<div class="pzp-vod-time" id="time">0:00 / 1:00</div>',
            "</main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/video/12345",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const time = document.getElementById("time");

    video.getBoundingClientRect = () => ({
        width: 640,
        height: 360,
        left: 0,
        top: 0,
        right: 640,
        bottom: 360,
    });
    time.getBoundingClientRect = () => ({
        width: 120,
        height: 24,
        left: 16,
        top: 324,
        right: 136,
        bottom: 348,
    });
    dom.window.fetch = async () => ({
        ok: true,
        json: async () => ({ content: { videoNo: "12345", videoTitle: "VOD without start time" } }),
    });

    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "vodBroadcastClock.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();

    assert.equal(document.getElementById("betterchzzk-vod-broadcast-clock"), null);
});

function bindLiveTimeShiftVideoState(video, state) {
    Object.defineProperty(video, "currentTime", {
        configurable: true,
        get: () => state.currentTime,
        set: (value) => {
            state.currentTime = Number(value);
        },
    });
    Object.defineProperty(video, "paused", {
        configurable: true,
        get: () => state.paused,
    });
    Object.defineProperty(video, "buffered", {
        configurable: true,
        get: () => createTimeRanges([[0, state.bufferedEnd]]),
    });
    Object.defineProperty(video, "seekable", {
        configurable: true,
        get: () => createTimeRanges([[0, state.seekableEnd]]),
    });
    makeVisibleVideo(video);
}

function createLiveTimeShiftGuardDom(chrome) {
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div class="pzp pzp-pc" id="playerRoot">',
            '<video id="video"></video>',
            '<div class="pzp-pc__progress-slider" id="seekbar" role="slider" aria-valuenow="0"></div>',
            '<div class="pzp-pc__bottom-buttons--left" id="controls">',
            '<div class="pzp-pc__volume-slider" id="volumeSlider" role="slider" aria-valuenow="50" aria-label="\uC74C\uB7C9"></div>',
            '<button class="pzp-pc__playback-switch" id="play" type="button">Play</button>',
            "</div>",
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const seekbar = document.getElementById("seekbar");
    const volumeSlider = document.getElementById("volumeSlider");
    const controls = document.getElementById("controls");
    const play = document.getElementById("play");
    const state = {
        bufferedEnd: 40,
        currentTime: 32,
        paused: false,
        seekableEnd: 40,
    };

    bindLiveTimeShiftVideoState(video, state);
    seekbar.getBoundingClientRect = () => ({
        width: 560,
        height: 12,
        left: 40,
        top: 302,
        right: 600,
        bottom: 314,
    });
    controls.getBoundingClientRect = () => ({
        width: 180,
        height: 40,
        left: 16,
        top: 316,
        right: 196,
        bottom: 356,
    });
    volumeSlider.getBoundingClientRect = () => ({
        width: 80,
        height: 20,
        left: 64,
        top: 326,
        right: 144,
        bottom: 346,
    });
    play.getBoundingClientRect = () => ({
        width: 36,
        height: 36,
        left: 20,
        top: 318,
        right: 56,
        bottom: 354,
    });

    return { controls, document, dom, play, seekbar, state, video, volumeSlider };
}

async function loadSkipControlPage(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "skipControl.js");
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();
}

function dispatchVideoEvent(dom, video, type) {
    video.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
}

function armLiveTimeShiftGuard(dom, video, state, currentTime = 32) {
    const seekbar = dom.window.document.getElementById("seekbar");
    seekbar?.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
    state.currentTime = currentTime;
    dispatchVideoEvent(dom, video, "seeking");
    dispatchVideoEvent(dom, video, "seeked");
    seekbar?.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true, cancelable: true }));
}

function waitForLiveTimeShiftSync() {
    return new Promise((resolve) => setTimeout(resolve, 650));
}

test("skip pill wheel decrement keeps one second as the minimum step", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipSeconds: 1,
        },
    });
    const { document, dom, state } = createLiveTimeShiftGuardDom(chrome);

    try {
        await loadSkipControlPage(dom);
        const pill = document.getElementById("betterchzzk-skip-pill");
        assert.ok(pill);

        const wheel = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
        Object.defineProperty(wheel, "deltaY", { value: 100 });
        pill.dispatchEvent(wheel);

        assert.equal(wheel.defaultPrevented, true);
        assert.equal(pill.querySelector(".bc-value").textContent, "1");

        const key = new dom.window.KeyboardEvent("keydown", {
            key: "ArrowRight",
            code: "ArrowRight",
            bubbles: true,
            cancelable: true,
        });
        document.body.dispatchEvent(key);

        assert.equal(key.defaultPrevented, true);
        assert.equal(state.currentTime, 33);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

function useFakePerformanceNow(dom, initialNow = 1000) {
    let now = initialNow;
    Object.defineProperty(dom.window.performance, "now", {
        configurable: true,
        value: () => now,
    });
    return {
        advance(milliseconds) {
            now += milliseconds;
        },
    };
}

async function closeSkipControlPage(dom, chrome) {
    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ skipControlEnabled: { newValue: false } }, "sync");
    }
    await waitForAsyncCallbacks();
    dom.window.close();
}

test("live timeshift guard does not roll back keyboard seeks into the near-live gray zone", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipSeconds: 5,
        },
    });
    const { document, dom, state, video } = createLiveTimeShiftGuardDom(chrome);

    try {
        await loadSkipControlPage(dom);
        armLiveTimeShiftGuard(dom, video, state, 32);

        const event = new dom.window.KeyboardEvent("keydown", {
            key: "ArrowRight",
            code: "ArrowRight",
            bubbles: true,
            cancelable: true,
        });
        document.body.dispatchEvent(event);

        assert.equal(event.defaultPrevented, true);
        assert.equal(video.currentTime, 37);

        await waitForLiveTimeShiftSync();

        assert.equal(video.currentTime, 37);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live timeshift guard preserves a deep user seek anywhere inside the seekable window", async () => {
    const chrome = createFakeChrome();
    const { dom, state, video } = createLiveTimeShiftGuardDom(chrome);
    const clock = useFakePerformanceNow(dom);

    try {
        state.bufferedEnd = 10000;
        state.currentTime = 2000;
        state.seekableEnd = 10000;
        await loadSkipControlPage(dom);
        armLiveTimeShiftGuard(dom, video, state, 2000);
        clock.advance(1300);

        state.currentTime = 10000;
        dispatchVideoEvent(dom, video, "seeking");

        assert.ok(video.currentTime >= 2000 && video.currentTime < 2002);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live timeshift guard ignores delayed live startup without user intent", async () => {
    const chrome = createFakeChrome();
    const { dom, state, video } = createLiveTimeShiftGuardDom(chrome);

    try {
        state.bufferedEnd = 1000;
        state.currentTime = 970;
        state.seekableEnd = 1000;
        await loadSkipControlPage(dom);

        dispatchVideoEvent(dom, video, "timeupdate");

        assert.equal(video.currentTime, 970);

        state.currentTime = 1000;
        dispatchVideoEvent(dom, video, "timeupdate");

        assert.equal(video.currentTime, 1000);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live timeshift guard does not re-arm after an explicit live-edge return", async () => {
    const chrome = createFakeChrome();
    const { document, dom, state, video } = createLiveTimeShiftGuardDom(chrome);
    const clock = useFakePerformanceNow(dom);

    try {
        state.bufferedEnd = 1000;
        state.currentTime = 970;
        state.seekableEnd = 1000;
        await loadSkipControlPage(dom);
        armLiveTimeShiftGuard(dom, video, state, 970);

        const liveButton = document.getElementById("betterchzzk-live-fast-forward");
        assert.ok(liveButton);
        liveButton.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));

        assert.equal(video.currentTime, 1000);

        clock.advance(1300);
        state.currentTime = 970;
        dispatchVideoEvent(dom, video, "timeupdate");

        assert.equal(video.currentTime, 970);

        state.currentTime = 1000;
        dispatchVideoEvent(dom, video, "timeupdate");

        assert.equal(video.currentTime, 1000);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live pause snapshot ignores initial paused attach without user intent", async () => {
    const chrome = createFakeChrome();
    const { dom, state, video } = createLiveTimeShiftGuardDom(chrome);

    try {
        state.bufferedEnd = 1000;
        state.currentTime = 970;
        state.paused = true;
        state.seekableEnd = 1000;
        await loadSkipControlPage(dom);

        dispatchVideoEvent(dom, video, "loadedmetadata");
        dispatchVideoEvent(dom, video, "durationchange");
        dispatchVideoEvent(dom, video, "progress");

        state.paused = false;
        state.currentTime = 1000;
        dispatchVideoEvent(dom, video, "play");
        dispatchVideoEvent(dom, video, "playing");

        assert.equal(video.currentTime, 1000);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live pause snapshot restores a user-paused time-shift", async () => {
    const chrome = createFakeChrome();
    const { dom, play, state, video } = createLiveTimeShiftGuardDom(chrome);

    try {
        state.bufferedEnd = 1000;
        state.currentTime = 970;
        state.seekableEnd = 1000;
        await loadSkipControlPage(dom);

        play.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        state.paused = true;
        dispatchVideoEvent(dom, video, "pause");

        state.paused = false;
        state.currentTime = 1000;
        dispatchVideoEvent(dom, video, "play");

        assert.ok(video.currentTime >= 970 && video.currentTime < 972);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live pause snapshot restores a deep user-paused position inside the seekable window", async () => {
    const chrome = createFakeChrome();
    const { dom, play, state, video } = createLiveTimeShiftGuardDom(chrome);

    try {
        state.bufferedEnd = 10000;
        state.currentTime = 2000;
        state.seekableEnd = 10000;
        await loadSkipControlPage(dom);

        play.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        state.paused = true;
        dispatchVideoEvent(dom, video, "pause");

        state.bufferedEnd = 10030;
        state.paused = false;
        state.currentTime = 10030;
        state.seekableEnd = 10030;
        dispatchVideoEvent(dom, video, "play");

        assert.ok(video.currentTime >= 2000 && video.currentTime < 2002);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live pause snapshot restores when the user pauses from the video surface", async () => {
    const chrome = createFakeChrome();
    const { dom, state, video } = createLiveTimeShiftGuardDom(chrome);

    try {
        state.bufferedEnd = 1000;
        state.currentTime = 970;
        state.seekableEnd = 1000;
        await loadSkipControlPage(dom);

        video.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        state.paused = true;
        dispatchVideoEvent(dom, video, "pause");

        state.paused = false;
        state.currentTime = 1000;
        dispatchVideoEvent(dom, video, "play");

        assert.ok(video.currentTime >= 970 && video.currentTime < 972);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live pause snapshot restores when an overlay inside the video area triggers pause", async () => {
    const chrome = createFakeChrome();
    const { document, dom, state, video } = createLiveTimeShiftGuardDom(chrome);
    const overlay = document.createElement("div");

    overlay.id = "playback-overlay";
    overlay.getBoundingClientRect = () => ({
        width: 640,
        height: 360,
        left: 0,
        top: 0,
        right: 640,
        bottom: 360,
    });
    document.getElementById("playerRoot").appendChild(overlay);

    try {
        state.bufferedEnd = 1000;
        state.currentTime = 970;
        state.seekableEnd = 1000;
        await loadSkipControlPage(dom);

        const pointer = new dom.window.Event("pointerdown", { bubbles: true, cancelable: true });
        Object.defineProperty(pointer, "clientX", { value: 320 });
        Object.defineProperty(pointer, "clientY", { value: 180 });
        overlay.dispatchEvent(pointer);
        state.paused = true;
        dispatchVideoEvent(dom, video, "pause");

        state.paused = false;
        state.currentTime = 1000;
        dispatchVideoEvent(dom, video, "play");

        assert.ok(video.currentTime >= 970 && video.currentTime < 972);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live pause snapshot stores a user pause at the live edge", async () => {
    const chrome = createFakeChrome();
    const { dom, play, state, video } = createLiveTimeShiftGuardDom(chrome);

    try {
        state.bufferedEnd = 1000;
        state.currentTime = 1000;
        state.seekableEnd = 1000;
        await loadSkipControlPage(dom);

        play.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        state.paused = true;
        dispatchVideoEvent(dom, video, "pause");

        state.bufferedEnd = 1030;
        state.paused = false;
        state.currentTime = 1030;
        state.seekableEnd = 1030;
        dispatchVideoEvent(dom, video, "play");

        assert.ok(video.currentTime >= 1000 && video.currentTime < 1002);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live pause snapshot restores from a native playback button without a known class", async () => {
    const chrome = createFakeChrome();
    const { controls, document, dom, state, video } = createLiveTimeShiftGuardDom(chrome);
    const nativePlay = document.createElement("button");

    nativePlay.type = "button";
    nativePlay.textContent = "Pause";
    nativePlay.getBoundingClientRect = () => ({
        width: 36,
        height: 36,
        left: 20,
        top: 318,
        right: 56,
        bottom: 354,
    });
    controls.appendChild(nativePlay);

    try {
        state.bufferedEnd = 1000;
        state.currentTime = 970;
        state.seekableEnd = 1000;
        await loadSkipControlPage(dom);

        nativePlay.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        state.paused = true;
        dispatchVideoEvent(dom, video, "pause");

        nativePlay.textContent = "Live Play";
        nativePlay.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        nativePlay.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));

        state.paused = false;
        state.currentTime = 1000;
        dispatchVideoEvent(dom, video, "play");

        assert.ok(video.currentTime >= 970 && video.currentTime < 972);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live pause snapshot is discarded when the video element is replaced on the same live route", async () => {
    const chrome = createFakeChrome();
    const { document, dom, play, state, video } = createLiveTimeShiftGuardDom(chrome);
    const clock = useFakePerformanceNow(dom);
    const nextVideo = document.createElement("video");
    const nextState = {
        bufferedEnd: 1000,
        currentTime: 1000,
        paused: false,
        seekableEnd: 1000,
    };

    bindLiveTimeShiftVideoState(nextVideo, nextState);

    try {
        state.bufferedEnd = 1000;
        state.currentTime = 970;
        state.seekableEnd = 1000;
        await loadSkipControlPage(dom);

        play.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        state.paused = true;
        dispatchVideoEvent(dom, video, "pause");

        video.replaceWith(nextVideo);
        await waitForAsyncCallbacks();
        await waitForAsyncCallbacks();
        await waitForLiveTimeShiftSync();

        dispatchVideoEvent(dom, nextVideo, "play");
        dispatchVideoEvent(dom, nextVideo, "playing");

        assert.equal(nextVideo.currentTime, 1000);

        armLiveTimeShiftGuard(dom, nextVideo, nextState, 970);
        clock.advance(1300);
        nextState.currentTime = 1000;
        dispatchVideoEvent(dom, nextVideo, "seeking");

        assert.ok(nextVideo.currentTime >= 970 && nextVideo.currentTime < 972);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("skip controls ignore following preview video when choosing the live player", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipSeconds: 5,
        },
    });
    const { document, dom, state, video } = createLiveTimeShiftGuardDom(chrome);
    const previewMount = document.createElement("div");
    const previewVideo = document.createElement("video");
    const previewState = {
        bufferedEnd: 80,
        currentTime: 10,
        paused: false,
        seekableEnd: 80,
    };

    previewMount.className = "bcfp-player";
    previewMount.setAttribute("data-bcfp-player-mount", "preview");
    previewMount.appendChild(previewVideo);
    document.body.prepend(previewMount);

    Object.defineProperty(previewVideo, "currentTime", {
        configurable: true,
        get: () => previewState.currentTime,
        set: (value) => {
            previewState.currentTime = Number(value);
        },
    });
    Object.defineProperty(previewVideo, "paused", {
        configurable: true,
        get: () => previewState.paused,
    });
    Object.defineProperty(previewVideo, "buffered", {
        configurable: true,
        get: () => createTimeRanges([[0, previewState.bufferedEnd]]),
    });
    Object.defineProperty(previewVideo, "seekable", {
        configurable: true,
        get: () => createTimeRanges([[0, previewState.seekableEnd]]),
    });
    previewVideo.getBoundingClientRect = () => ({
        width: 800,
        height: 450,
        left: 0,
        top: 0,
        right: 800,
        bottom: 450,
    });
    video.getBoundingClientRect = () => ({
        width: 320,
        height: 180,
        left: 0,
        top: 0,
        right: 320,
        bottom: 180,
    });

    try {
        await loadSkipControlPage(dom);

        const event = new dom.window.KeyboardEvent("keydown", {
            key: "ArrowRight",
            code: "ArrowRight",
            bubbles: true,
            cancelable: true,
        });
        document.body.dispatchEvent(event);

        assert.equal(event.defaultPrevented, true);
        assert.equal(state.currentTime, 37);
        assert.equal(previewState.currentTime, 10);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live timeshift guard accepts seekbar pointer seeks as user intent", async () => {
    const chrome = createFakeChrome();
    const { dom, seekbar, state, video } = createLiveTimeShiftGuardDom(chrome);

    try {
        await loadSkipControlPage(dom);
        armLiveTimeShiftGuard(dom, video, state, 32);

        seekbar.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        video.currentTime = 35;
        dispatchVideoEvent(dom, video, "seeking");
        dispatchVideoEvent(dom, video, "seeked");

        assert.equal(video.currentTime, 35);

        await waitForLiveTimeShiftSync();

        assert.equal(video.currentTime, 35);

        seekbar.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 1300));
        video.currentTime = 39;
        dispatchVideoEvent(dom, video, "seeking");

        assert.ok(video.currentTime >= 35 && video.currentTime < 37.5);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live timeshift guard keeps protection while a long seekbar drag is held", async () => {
    const chrome = createFakeChrome();
    const { dom, seekbar, state, video } = createLiveTimeShiftGuardDom(chrome);

    try {
        await loadSkipControlPage(dom);
        armLiveTimeShiftGuard(dom, video, state, 32);

        seekbar.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 1300));

        video.currentTime = 35.5;
        dispatchVideoEvent(dom, video, "seeking");
        dispatchVideoEvent(dom, video, "seeked");

        assert.equal(video.currentTime, 35.5, "유예보다 길게 잡고 있어도 드래그 중에는 롤백하지 않는다");

        seekbar.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true, cancelable: true }));
        video.currentTime = 38;
        dispatchVideoEvent(dom, video, "seeking");

        assert.equal(video.currentTime, 38, "드래그를 놓은 직후 커밋된 시크도 사용자 의도로 수용한다");
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live timeshift guard ignores non-seek slider gestures for forced live-edge jumps", async () => {
    const chrome = createFakeChrome();
    const { dom, state, video, volumeSlider } = createLiveTimeShiftGuardDom(chrome);
    const clock = useFakePerformanceNow(dom);

    try {
        await loadSkipControlPage(dom);
        armLiveTimeShiftGuard(dom, video, state, 32);
        clock.advance(1300);

        volumeSlider.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        video.currentTime = 39;
        dispatchVideoEvent(dom, video, "seeking");

        assert.ok(video.currentTime >= 32 && video.currentTime < 34);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live timeshift guard expires a held seekbar gesture when pointerup is missed", async () => {
    const chrome = createFakeChrome();
    const { dom, seekbar, state, video } = createLiveTimeShiftGuardDom(chrome);
    const clock = useFakePerformanceNow(dom);

    try {
        state.paused = true;
        await loadSkipControlPage(dom);
        armLiveTimeShiftGuard(dom, video, state, 32);

        seekbar.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true, cancelable: true }));
        clock.advance(8100);
        video.currentTime = 39;
        dispatchVideoEvent(dom, video, "seeking");

        assert.ok(video.currentTime >= 32 && video.currentTime < 34);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live timeshift guard still restores forced live-edge jumps after the user-established position goes stale", async () => {
    const chrome = createFakeChrome();
    const { dom, state, video } = createLiveTimeShiftGuardDom(chrome);
    const clock = useFakePerformanceNow(dom);

    try {
        await loadSkipControlPage(dom);
        armLiveTimeShiftGuard(dom, video, state, 32);
        clock.advance(1300);

        video.currentTime = 39;
        dispatchVideoEvent(dom, video, "seeking");

        assert.ok(video.currentTime >= 32 && video.currentTime < 34);
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live timeshift guard preserves state across consecutive forced live-edge jumps", async () => {
    const chrome = createFakeChrome();
    const { dom, state, video } = createLiveTimeShiftGuardDom(chrome);
    const clock = useFakePerformanceNow(dom);

    try {
        state.bufferedEnd = 1000;
        state.currentTime = 970;
        state.seekableEnd = 1000;
        await loadSkipControlPage(dom);
        armLiveTimeShiftGuard(dom, video, state, 970);
        clock.advance(1300);

        state.currentTime = 1000;
        dispatchVideoEvent(dom, video, "seeking");
        assert.ok(video.currentTime >= 970 && video.currentTime < 972);

        state.currentTime = 1000;
        dispatchVideoEvent(dom, video, "seeking");
        assert.equal(video.currentTime, 1000, "복원 중인 두 번째 점프는 즉시 재진입하지 않는다");

        await waitForAsyncCallbacks();
        clock.advance(121);
        dispatchVideoEvent(dom, video, "timeupdate");

        assert.ok(video.currentTime >= 970 && video.currentTime < 972, "보호 상태를 유지해 다음 동기화에서 복원한다");
    } finally {
        await closeSkipControlPage(dom, chrome);
    }
});

test("live fast-forward button seeks to the buffered live edge", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipLivePauseResumeEnabled: false,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__bottom-buttons--left" id="controls">',
            '<button class="pzp-pc__playback-switch" id="play" type="button">Play</button>',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const controls = document.getElementById("controls");
    const play = document.getElementById("play");

    video.currentTime = 12;
    video.getBoundingClientRect = () => ({
        width: 640,
        height: 360,
        left: 0,
        top: 0,
        right: 640,
        bottom: 360,
    });
    controls.getBoundingClientRect = () => ({
        width: 180,
        height: 40,
        left: 16,
        top: 316,
        right: 196,
        bottom: 356,
    });
    play.getBoundingClientRect = () => ({
        width: 36,
        height: 36,
        left: 20,
        top: 318,
        right: 56,
        bottom: 354,
    });
    Object.defineProperty(video, "buffered", {
        configurable: true,
        get: () => createTimeRanges([[0, 42]]),
    });

    try {
        evalRepoScript(dom, "shared", "settings.js");
        evalContentScripts(dom);
        evalRepoScript(dom, "features", "skipControl.js");
        document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
        await waitForAsyncCallbacks();
        await waitForAsyncCallbacks();

        const button = document.getElementById("betterchzzk-live-fast-forward");
        assert.ok(button);
        assert.equal(button.getAttribute("label"), "\uBE68\uB9AC \uAC10\uAE30");
        assert.equal(button.getAttribute("aria-label"), "\uBE68\uB9AC \uAC10\uAE30");
        assert.equal(button.getAttribute("tooltip"), "\uBE68\uB9AC \uAC10\uAE30");
        assert.equal(button.hasAttribute("title"), false);
        assert.equal(button.classList.contains("knife-ff"), true);
        assert.ok(button.querySelector("ui-next-media-icon.bc-live-ff-icon svg"));
        assert.equal(button.textContent.trim(), "");
        assert.equal(button.disabled, false);

        button.click();

        assert.equal(video.currentTime, 42);
    } finally {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ skipControlEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    }
});

test("live fast-forward button does not rewrite an unchanged disabled state during DOM resync", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipLivePauseResumeEnabled: false,
        },
    });
    const { dom, state } = createLiveTimeShiftGuardDom(chrome);
    let disabledObserver = null;

    state.bufferedEnd = 0;
    state.seekableEnd = 0;

    try {
        await loadSkipControlPage(dom);

        const button = dom.window.document.getElementById("betterchzzk-live-fast-forward");
        assert.ok(button);
        assert.equal(button.disabled, true);

        let disabledMutations = 0;
        disabledObserver = new dom.window.MutationObserver((mutations) => {
            disabledMutations += mutations.length;
        });
        disabledObserver.observe(button, {
            attributes: true,
            attributeFilter: ["disabled"],
        });

        button.setAttribute("label", "stale");
        await waitForCondition(() => button.getAttribute("label") === "\uBE68\uB9AC \uAC10\uAE30");
        await waitForAsyncCallbacks();

        assert.equal(disabledMutations, 0);
        assert.equal(button.disabled, true);
    } finally {
        disabledObserver?.disconnect();
        await closeSkipControlPage(dom, chrome);
    }
});

test("live fast-forward button jumps to the seekable live edge on a time-machine channel", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipLivePauseResumeEnabled: false,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__bottom-buttons--left" id="controls">',
            '<button class="pzp-pc__playback-switch" id="play" type="button">Play</button>',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const controls = document.getElementById("controls");
    const play = document.getElementById("play");

    video.currentTime = 12;
    video.getBoundingClientRect = () => ({
        width: 640,
        height: 360,
        left: 0,
        top: 0,
        right: 640,
        bottom: 360,
    });
    controls.getBoundingClientRect = () => ({
        width: 180,
        height: 40,
        left: 16,
        top: 316,
        right: 196,
        bottom: 356,
    });
    play.getBoundingClientRect = () => ({
        width: 36,
        height: 36,
        left: 20,
        top: 318,
        right: 56,
        bottom: 354,
    });
    // 타임머신 채널: forward 버퍼 끝(42)은 라이브 엣지(seekable.end=200)보다 한참 뒤.
    Object.defineProperty(video, "buffered", {
        configurable: true,
        get: () => createTimeRanges([[0, 42]]),
    });
    Object.defineProperty(video, "seekable", {
        configurable: true,
        get: () => createTimeRanges([[0, 200]]),
    });

    try {
        evalRepoScript(dom, "shared", "settings.js");
        evalContentScripts(dom);
        evalRepoScript(dom, "features", "skipControl.js");
        document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
        await waitForAsyncCallbacks();
        await waitForAsyncCallbacks();

        const button = document.getElementById("betterchzzk-live-fast-forward");
        assert.ok(button);
        assert.equal(button.disabled, false);

        button.click();

        assert.equal(video.currentTime, 200);
    } finally {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ skipControlEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    }
});

test("live fast-forward button does not duplicate an external knife button", async () => {
    const chrome = createFakeChrome({
        sync: {
            skipLivePauseResumeEnabled: false,
        },
    });
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__bottom-buttons--left" id="controls">',
            '<button class="pzp-pc__playback-switch" id="play" type="button">Play</button>',
            '<button class="knife-ff" id="external-ff" type="button" aria-label="\uBE68\uB9AC \uAC10\uAE30"></button>',
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const controls = document.getElementById("controls");
    const play = document.getElementById("play");
    const externalButton = document.getElementById("external-ff");

    video.getBoundingClientRect = () => ({
        width: 640,
        height: 360,
        left: 0,
        top: 0,
        right: 640,
        bottom: 360,
    });
    controls.getBoundingClientRect = () => ({
        width: 220,
        height: 40,
        left: 16,
        top: 316,
        right: 236,
        bottom: 356,
    });
    play.getBoundingClientRect = () => ({
        width: 36,
        height: 36,
        left: 20,
        top: 318,
        right: 56,
        bottom: 354,
    });
    externalButton.getBoundingClientRect = () => ({
        width: 36,
        height: 36,
        left: 64,
        top: 318,
        right: 100,
        bottom: 354,
    });

    try {
        evalRepoScript(dom, "shared", "settings.js");
        evalContentScripts(dom);
        evalRepoScript(dom, "features", "skipControl.js");
        document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
        await waitForAsyncCallbacks();
        await waitForAsyncCallbacks();

        assert.equal(document.getElementById("betterchzzk-live-fast-forward"), null);
        assert.equal(document.getElementById("external-ff"), externalButton);
    } finally {
        for (const listener of chrome.testState.storageChangeListeners) {
            listener({ skipControlEnabled: { newValue: false } }, "sync");
        }
        await waitForAsyncCallbacks();
        dom.window.close();
    }
});

function setupShortcutRescueDom(chrome, { pageScripts = [] } = {}) {
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<div class="pzp pzp-pc" id="playerRoot">',
            '<video id="video"></video>',
            '<div class="pzp-pc__bottom-buttons--left" id="controls">',
            '<button class="pzp-pc__playback-switch" id="play" type="button"></button>',
            '<button class="pzp-pc__volume-button" id="mute" type="button" aria-label="음소거"></button>',
            '<button class="pzp-pc__viewmode-button" id="theater" type="button" aria-label="넓은 화면"></button>',
            "</div>",
            "</div>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const state = { paused: true, clicks: { play: 0, mute: 0, theater: 0 } };

    Object.defineProperty(video, "paused", { configurable: true, get: () => state.paused });
    video.play = () => {
        state.paused = false;
        return Promise.resolve();
    };
    video.pause = () => {
        state.paused = true;
    };
    makeVisibleVideo(video);

    for (const id of ["play", "mute", "theater"]) {
        const button = document.getElementById(id);
        button.getBoundingClientRect = () => ({ width: 36, height: 36, left: 20, top: 318, right: 56, bottom: 354 });
        button.addEventListener("click", () => {
            state.clicks[id] += 1;
            if (id === "play") state.paused = !state.paused;
        });
    }

    for (const pageScript of pageScripts) evalRepoScript(dom, "features", pageScript);
    evalRepoScript(dom, "shared", "settings.js");
    evalContentScripts(dom);
    evalRepoScript(dom, "features", "shortcutRescue.js");

    return { dom, document, video, state };
}

function dispatchShortcutKey(dom, code, key) {
    const event = new dom.window.KeyboardEvent("keydown", {
        code,
        key,
        bubbles: true,
        cancelable: true,
    });
    dom.window.document.body.dispatchEvent(event);
    return event;
}

function waitForRescueProbe() {
    return new Promise((resolve) => setTimeout(resolve, 150));
}

test("shortcut rescue takes over once the native shortcut pipeline stays unresponsive", async () => {
    const chrome = createFakeChrome();
    const { dom, state } = setupShortcutRescueDom(chrome);
    await waitForAsyncCallbacks();

    const firstTheater = dispatchShortcutKey(dom, "KeyT", "t");
    assert.equal(state.clicks.theater, 1, "관찰할 수 없는 화면 전환 키도 첫 입력에서 버튼 클릭으로 처리된다");
    assert.equal(firstTheater.defaultPrevented, true);

    dispatchShortcutKey(dom, "Space", " ");
    await waitForRescueProbe();
    assert.equal(state.clicks.play, 1, "첫 미반응 키는 짧은 프로브 후 소급 실행된다");
    assert.equal(state.paused, false);

    const immediate = dispatchShortcutKey(dom, "Space", " ");
    assert.equal(state.clicks.play, 2, "첫 미반응 확정 후에는 지연 없이 즉시 실행된다");
    assert.equal(state.paused, true);
    assert.equal(immediate.defaultPrevented, true);

    dispatchShortcutKey(dom, "KeyM", "m");
    assert.equal(state.clicks.mute, 1);
});

test("shortcut rescue keeps a pending observable probe when view mode is rescued first", async () => {
    const chrome = createFakeChrome();
    const { dom, state } = setupShortcutRescueDom(chrome);
    await waitForAsyncCallbacks();

    dispatchShortcutKey(dom, "Space", " ");
    dispatchShortcutKey(dom, "KeyT", "t");
    assert.equal(state.clicks.theater, 1);

    await waitForRescueProbe();
    assert.equal(state.clicks.play, 1);
    assert.equal(state.paused, false);
});

test("shortcut rescue stays inactive while the native pipeline handles keys", async () => {
    const chrome = createFakeChrome();
    const { dom, state } = setupShortcutRescueDom(chrome);
    await waitForAsyncCallbacks();

    dom.window.addEventListener("keydown", (event) => {
        if (event.code === "Space") state.paused = !state.paused;
    });

    dispatchShortcutKey(dom, "Space", " ");
    await waitForRescueProbe();
    assert.equal(state.clicks.play, 0, "네이티브가 처리하면 폴백은 개입하지 않는다");
    assert.equal(state.paused, false);

    dispatchShortcutKey(dom, "Space", " ");
    await waitForRescueProbe();
    assert.equal(state.clicks.play, 0, "생존 확정 후에는 프로브도 하지 않는다");
    assert.equal(state.paused, true);
});

test("shortcut rescue ignores the removed legacy option and stays built in", async () => {
    const chrome = createFakeChrome({
        sync: {
            shortcutRescueEnabled: false,
        },
    });
    const { dom, state } = setupShortcutRescueDom(chrome);
    await waitForAsyncCallbacks();

    dispatchShortcutKey(dom, "Space", " ");
    await waitForRescueProbe();
    assert.equal(state.clicks.play, 1);
    assert.equal(state.paused, false);
});

test("history page loads local watch history state without crashing", async () => {
    const chrome = createFakeChrome();
    const dom = createDom("history.html", "history.html", chrome);

    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "history.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;

    assert.equal(document.getElementById("notice").dataset.state, "saved");
    assert.match(document.getElementById("notice").textContent, /0/);
    assert.match(document.getElementById("totalLiveCount").textContent, /0/);
    assert.equal(document.getElementById("weekdays").children.length, 7);
    assert.ok(document.getElementById("calendarDays").children.length >= 28);
    assert.equal(document.getElementById("deleteSelectedHistory").disabled, true);
    assert.equal(chrome.testState.storageChangeListeners.length, 1);
});

test("history page keeps legacy aggregate rows after an unrelated v2 mutation", async () => {
    const startMs = Date.parse("2026-07-10T09:00:00+09:00");
    const rawHistory = {
        version: 1,
        updatedAt: startMs,
        entries: {
            "live:legacy": {
                id: "live:legacy",
                channelId: "legacy-channel",
                channelName: "이전 채널",
                title: "이전 합계 기록",
                firstWatchedAt: startMs,
                lastWatchedAt: startMs + 60000,
                watchedSeconds: 60,
                dailySeconds: { "2026-07-10": 60 },
                sessions: 1,
            },
            "live:other": {
                id: "live:other",
                channelId: "other-channel",
                channelName: "다른 채널",
                title: "다른 기록",
                firstWatchedAt: startMs + 120000,
                lastWatchedAt: startMs + 180000,
                watchedSeconds: 60,
                dailySeconds: { "2026-07-10": 60 },
                sessions: 1,
                sessionDetails: [
                    {
                        id: "other-session",
                        title: "다른 기록",
                        enteredAt: startMs + 120000,
                        leftAt: startMs + 180000,
                        watchedSeconds: 60,
                        dailySeconds: { "2026-07-10": 60 },
                        closed: true,
                    },
                ],
            },
        },
    };
    const outcome = watchHistoryStore.applyMutation(
        rawHistory,
        { kind: "setReplayVideoNo", recordId: "live:other", videoNo: "777" },
        startMs + 240000
    );
    assert.equal(Object.hasOwn(outcome.history.entries["live:legacy"], "sessionDetails"), false);

    const chrome = createFakeChrome({
        local: {
            betterChzzkLiveWatchHistory: outcome.history,
        },
    });
    const dom = createDom("history.html", "history.html", chrome);

    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "history.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    assert.equal(document.getElementById("totalLiveCount").textContent, "2개");
    assert.match(document.getElementById("historyList").textContent, /이전 합계 기록/);
});

test("history page keeps stored totals when exact watch ranges are capped", async () => {
    const startMs = Date.parse("2026-06-29T09:00:00+09:00");
    const watchedSeconds = 2050;
    const dateKey = "2026-06-29";
    const chrome = createFakeChrome({
        local: {
            betterChzzkLiveWatchHistory: {
                entries: {
                    "live:capped-history": {
                        channelId: "test-channel",
                        channelName: "테스트 채널",
                        dailySeconds: { [dateKey]: watchedSeconds },
                        firstWatchedAt: startMs,
                        id: "live:capped-history",
                        lastWatchedAt: startMs + 50 * 60 * 1000,
                        liveId: "capped-history",
                        sessionDetails: [
                            {
                                dailySeconds: { [dateKey]: watchedSeconds },
                                enteredAt: startMs,
                                id: "session-capped-history",
                                leftAt: startMs + 50 * 60 * 1000,
                                watchedRanges: createCappedWatchRanges(startMs),
                                watchedSeconds,
                            },
                        ],
                        title: "범위 상한 기록",
                        watchedSeconds,
                    },
                },
                updatedAt: startMs,
                version: 1,
            },
        },
    });
    const dom = createDom("history.html", "history.html", chrome);

    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "history.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    assert.equal(document.getElementById("totalWatchTime").textContent, "34분");
    assert.equal(document.getElementById("monthWatchTime").textContent, "34분");
    assert.match(document.querySelector(`[data-date="${dateKey}"]`).getAttribute("aria-label"), /34분/);
});

test("history page counts overlapping tab ranges once while keeping a single merged session row", async () => {
    const startMs = Date.parse("2026-06-29T09:00:00+09:00");
    const watchedSeconds = 10 * 60;
    const dateKey = "2026-06-29";
    const session = (id) => ({
        dailySeconds: { [dateKey]: watchedSeconds },
        enteredAt: startMs,
        id,
        leftAt: startMs + watchedSeconds * 1000,
        watchedRanges: [{ startAt: startMs, endAt: startMs + watchedSeconds * 1000 }],
        watchedSeconds,
    });
    const chrome = createFakeChrome({
        local: {
            betterChzzkLiveWatchHistory: {
                entries: {
                    "live:overlapping-tabs": {
                        channelId: "test-channel",
                        channelName: "테스트 채널",
                        dailySeconds: { [dateKey]: watchedSeconds * 2 },
                        firstWatchedAt: startMs,
                        id: "live:overlapping-tabs",
                        lastWatchedAt: startMs + watchedSeconds * 1000,
                        liveId: "overlapping-tabs",
                        sessionDetails: [session("tab-a"), session("tab-b")],
                        title: "동시 탭 기록",
                        watchedSeconds: watchedSeconds * 2,
                    },
                },
            },
        },
    });
    const dom = createDom("history.html", "history.html", chrome);

    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "history.js");
    await waitForAsyncCallbacks();

    const { document } = dom.window;
    assert.equal(document.getElementById("totalWatchTime").textContent, "10분");
    assert.equal(document.getElementById("monthWatchTime").textContent, "10분");
    assert.match(document.querySelector(`[data-date="${dateKey}"]`).getAttribute("aria-label"), /10분/);
    document.querySelector(".history-entry-detail").click();
    assert.equal(document.querySelectorAll(".history-session-item").length, 1);
    assert.match(document.querySelector(".history-session-item").textContent, /시청10분/);
    dom.window.close();
});
