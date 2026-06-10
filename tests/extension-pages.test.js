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

function createFakeChrome({ sync = {}, local = {} } = {}) {
    const syncArea = createStorageArea(sync);
    const localArea = createStorageArea(local);
    const storageChangeListeners = [];

    return {
        runtime: {},
        storage: {
            sync: syncArea,
            local: localArea,
            onChanged: {
                addListener(listener) {
                    storageChangeListeners.push(listener);
                },
            },
        },
        testState: {
            sync: syncArea.data,
            local: localArea.data,
            storageChangeListeners,
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

function dispatch(dom, element, type) {
    element.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
}

function queryOption(document, key) {
    return document.querySelector(`[data-option="${key}"]`);
}

function waitForAsyncCallbacks() {
    return new Promise((resolve) => setTimeout(resolve, 20));
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

function evalVolumeWheelScripts(dom) {
    evalRepoScript(dom, "features", "volumeWheelPage.js");
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "volumeWheel.js");
}

test("options page renders defaults and dependency-disabled controls without extension storage", () => {
    const dom = createDom("options.html", "options.html");

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document, BetterChzzkSettings } = dom.window;
    const optionInputs = Array.from(document.querySelectorAll("[data-option]"));
    const saveButton = document.getElementById("save");
    const notice = document.getElementById("notice");

    assert.equal(optionInputs.length, BetterChzzkSettings.OPTION_KEYS.length);
    assert.equal(queryOption(document, "skipSeconds").value, String(BetterChzzkSettings.DEFAULT_OPTIONS.skipSeconds));
    assert.equal(queryOption(document, "vodBroadcastClockEnabled").checked, false);
    assert.equal(saveButton.disabled, true);
    assert.equal(notice.dataset.state, "saved");
    assert.match(notice.textContent, /1080p/);

    const skipControl = queryOption(document, "skipControlEnabled");
    const skipKeyboard = queryOption(document, "skipKeyboardEnabled");
    const skipSeconds = queryOption(document, "skipSeconds");

    skipControl.checked = false;
    dispatch(dom, skipControl, "change");

    assert.equal(saveButton.disabled, false);
    assert.equal(skipKeyboard.disabled, true);
    assert.equal(skipSeconds.disabled, true);
    assert.equal(skipKeyboard.closest("[data-depends-on]").classList.contains("is-disabled"), true);
});

test("options playback controls show live settings before VOD settings", () => {
    const dom = createDom("options.html", "options.html");

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");

    const { document } = dom.window;
    const section = queryOption(document, "skipControlEnabled").closest(".settings-card");
    const optionOrder = Array.from(section.querySelectorAll("[data-option]")).map((input) => input.dataset.option);
    const detailOrder = Array.from(section.querySelectorAll("summary")).map((summary) => summary.textContent.trim());

    assert.equal(section.querySelector("h2").textContent.trim(), "라이브/다시보기 조작");
    assert.deepEqual(detailOrder, ["라이브 위치 유지 설정", "스킵 수치 설정", "볼륨 휠 설정"]);
    assert.deepEqual(optionOrder, [
        "skipControlEnabled",
        "skipKeyboardEnabled",
        "skipLivePauseResumeEnabled",
        "skipLivePauseResumeDepthMinutes",
        "timeMachineLagLabelEnabled",
        "skipPillEnabled",
        "skipLivePillEnabled",
        "skipSeconds",
        "skipWheelStep",
        "skipWheelShiftStep",
        "skipWheelAltStep",
        "volumeWheelEnabled",
        "volumeWheelStep",
        "vodBroadcastClockEnabled",
    ]);
});

test("manifest loads volume wheel page script in the main world", () => {
    const manifest = JSON.parse(readRepoFile("manifest.json"));
    const mainScript = manifest.content_scripts.find((entry) => entry.world === "MAIN");
    const isolatedScript = manifest.content_scripts.find((entry) => !entry.world);

    assert.ok(mainScript);
    assert.ok(isolatedScript);
    assert.ok(mainScript.js.includes("features/volumeWheelPage.js"));
    assert.ok(mainScript.js.indexOf("features/volumeWheelPage.js") > mainScript.js.indexOf("features/autoQualityPage.js"));
    assert.ok(isolatedScript.js.includes("features/volumeWheel.js"));
    assert.ok(isolatedScript.js.indexOf("features/volumeWheel.js") > isolatedScript.js.indexOf("content.js"));
});

test("options page loads stored values and writes normalized changes", async () => {
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
    const saveButton = document.getElementById("save");

    assert.equal(skipSeconds.value, "15");
    assert.equal(videoComment.disabled, true);
    assert.equal(saveButton.disabled, true);

    skipSeconds.value = "17";
    dispatch(dom, skipSeconds, "input");

    assert.equal(saveButton.disabled, false);

    saveButton.click();
    await waitForAsyncCallbacks();

    assert.equal(chrome.testState.sync.skipSeconds, 17);
    assert.equal(saveButton.disabled, true);
    assert.equal(document.getElementById("notice").dataset.state, "saved");
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
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));

    const tip = document.querySelector(".bctt-tooltip[data-show='1']");
    assert.ok(tip, "툴팁이 표시되어야 한다");
    assert.equal(tip.textContent, "아주 길어서 잘리는 방송 제목 전체 내용");
    assert.equal(title.getAttribute("data-bctt-active"), "1");
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
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));

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
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));

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
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    title.dispatchEvent(new dom.window.MouseEvent("pointerout", { bubbles: true, relatedTarget: child }));
    await new Promise((resolve) => setTimeout(resolve, 450));

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
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));

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
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));
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
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(document.querySelector(".bctt-tooltip[data-show='1']"), null);

    for (const listener of chrome.testState.storageChangeListeners) {
        listener({ titleTooltipEnabled: { newValue: true } }, "sync");
    }
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));
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
    dom.window.addEventListener("wheel", () => {
        nativeWheelCount += 1;
        video.volume = 1;
    }, { capture: true });

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
    assert.ok(Math.abs(video.volume - 0.50) < 1e-6, "휠 다운이면 -5%");
    assert.equal(down.defaultPrevented, true);
    assert.equal(slider.value, "50");
});

test("volume wheel stays inert until settings publish while keeping early listener priority", async () => {
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

    evalRepoScript(dom, "features", "volumeWheelPage.js");

    let nativeWheelCount = 0;
    dom.window.addEventListener("wheel", () => {
        nativeWheelCount += 1;
        video.volume = 1;
    }, { capture: true });

    const beforeSettings = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(beforeSettings, "deltaY", { value: -100 });
    vol.dispatchEvent(beforeSettings);

    assert.equal(video.volume, 1);
    assert.equal(beforeSettings.defaultPrevented, false);
    assert.equal(nativeWheelCount, 1);

    video.volume = 0.5;
    nativeWheelCount = 0;

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "volumeWheel.js");
    await waitForAsyncCallbacks();

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    vol.dispatchEvent(up);

    assert.ok(Math.abs(video.volume - 0.55) < 1e-6);
    assert.equal(up.defaultPrevented, true);
    assert.equal(nativeWheelCount, 0);
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

    assert.ok(Math.abs(video.volume - 0.50) < 1e-6);
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

    assert.ok(Math.abs(video.volume - 0.50) < 1e-6);
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

test("auto quality falls back to the highest selectable lower track", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            "<main>",
            '<video id="video"></video>',
            "</main>",
            "</body>",
        ].join(""),
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

test("auto quality treats an already selected fallback track as stable", () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            "<main>",
            '<video id="video"></video>',
            "</main>",
            "</body>",
        ].join(""),
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

test("VOD replay chat fix ignores currentTime-only URL changes on the same VOD", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            "<main>",
            '<video id="video"></video>',
            "</main>",
            "</body>",
        ].join(""),
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
    evalRepoScript(dom, "content.js");
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
        [
            "<!doctype html>",
            "<body>",
            "<main>",
            '<video id="video"></video>',
            "</main>",
            "</body>",
        ].join(""),
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
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "vodReplayChatFix.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();

    scheduledTimers.length = 0;
    dom.window.history.pushState({}, "", "/video/67890");
    document.body.appendChild(document.createElement("div"));
    await waitForAsyncCallbacks();

    assert.deepEqual(
        scheduledTimers
            .map(({ delay }) => delay)
            .filter((delay) => delay >= 12000),
        [12000, 16000, 22000]
    );
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
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "vodBroadcastClock.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();
    await waitForAsyncCallbacks();

    assert.equal(document.getElementById("betterchzzk-vod-broadcast-clock"), null);
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
        evalRepoScript(dom, "content.js");
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
        evalRepoScript(dom, "content.js");
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

test("history page loads local watch history state without crashing", async () => {
    const chrome = createFakeChrome();
    const dom = createDom("history.html", "history.html", chrome);

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
