const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const {
    readRepoFile,
    createFakeChrome,
    dispatchTrusted,
    waitForAsyncCallbacks,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

require("../shared/settings.js");
require("../shared/settingsBackup.js");
require("../shared/recordingDownloads.js");

const Recording = globalThis.CheeseSpannerRecordingDownloads;
const Settings = globalThis.CheeseSpannerSettings;
const SettingsBackup = globalThis.CheeseSpannerSettingsBackup;

const CHANNEL = "0123456789abcdef0123456789abcdef";
const BLOB = "blob:https://chzzk.naver.com/1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const MP4 = "video/mp4;codecs=avc1.640028,mp4a.40.2";
const WEBM = "video/webm;codecs=vp9,opus";
const SETTINGS_STORE = "cheese-spanner:settings-store";
// Native shapes reused from tests/player-buttons.test.js (2026-09-14) and tests/ambient-glow.test.js (gear menu).
const MENU = `<div class="pzp-settings pzp-pc-settings pzp-pc__settings" role="menu"><button class="pzp-ui-setting-home-item" role="menuitem" id="native-quality"><span class="pzp-ui-setting-home-item__top"><span class="pzp-ui-setting-home-item__left"><span class="pzp-ui-setting-home-item__label">해상도</span></span></span></button></div>`;
const PLAYER = `<div class="pzp-pc pzp-pc--controls"><div class="pzp-pc__video"><video></video></div>
<div class="pzp-pc__bottom-buttons-right"><button class="custom__clip-button pzp-pc__setting-button pzp-button"></button><button class="pzp-setting-button pzp-pc__setting-button" aria-label="설정"></button></div>
${MENU}</div>`;

function createWorker(chrome, { held = false } = {}) {
    const listeners = [];
    const permissions = { held };
    const workerChrome = {
        runtime: { id: chrome.runtime.id },
        storage: { sync: chrome.storage.sync },
        permissions: {
            contains(spec, callback) {
                setTimeout(() => callback(spec.permissions?.includes("downloads") && permissions.held), 0);
            },
            onAdded: { addListener() {} },
        },
        get downloads() {
            return permissions.held
                ? { onDeterminingFilename: { addListener: (fn) => listeners.push(fn) } }
                : undefined;
        },
    };
    const controller = Recording.createController({ chrome: workerChrome });
    controller.install();
    return {
        controller,
        listeners,
        permissions,
        determine(item) {
            const suggestions = [];
            for (const listener of listeners) listener(item, (suggestion) => suggestions.push(suggestion));
            return suggestions;
        },
    };
}

function fixture(t, { sync = {}, path = `/live/${CHANNEL}`, supported = [MP4, WEBM], held = false } = {}) {
    const chrome = createFakeChrome({ sync: { videoRecorderEnabled: true, ...sync } });
    const dom = new JSDOM(`<!doctype html><html><body><main>${PLAYER}</main></body></html>`, {
        url: `https://chzzk.naver.com${path}`,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    const doc = w.document;
    w.chrome = chrome;
    const worker = createWorker(chrome, { held });
    const sendMessage = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (message, callback) => {
        if (message?.type !== Recording.MESSAGE_TYPE) return sendMessage(message, callback);
        chrome.testState.runtimeMessages.push(message);
        const sender = {
            id: chrome.runtime.id,
            tab: { id: 7 },
            frameId: 0,
            url: w.location.href,
            origin: "https://chzzk.naver.com",
        };
        worker.controller.handleMessage(message, sender).then((response) => callback?.(response));
    };

    class FakeTrack extends w.EventTarget {
        constructor(kind) {
            super();
            this.kind = kind;
            this.stopped = false;
        }
        stop() {
            this.stopped = true;
        }
    }
    const captures = [];
    function prepareVideo(video) {
        Object.defineProperty(video, "readyState", { configurable: true, get: () => video.testReadyState ?? 4 });
        Object.defineProperty(video, "videoHeight", { configurable: true, get: () => 1080 });
        video.captureStream = () => {
            const tracks = [new FakeTrack("video"), new FakeTrack("audio")];
            captures.push(tracks);
            return { getTracks: () => tracks, getVideoTracks: () => tracks.filter((track) => track.kind === "video") };
        };
    }
    prepareVideo(doc.querySelector("video"));

    const recorders = [];
    class FakeMediaRecorder extends w.EventTarget {
        static isTypeSupported(type) {
            return supported.includes(type);
        }
        constructor(stream, options) {
            super();
            this.stream = stream;
            this.options = options;
            this.state = "inactive";
            recorders.push(this);
        }
        start(timeslice) {
            this.state = "recording";
            this.timeslice = timeslice;
        }
        emit(text) {
            const event = new w.Event("dataavailable");
            Object.defineProperty(event, "data", { value: new w.Blob([text]) });
            this.dispatchEvent(event);
        }
        stop() {
            this.state = "inactive";
            setTimeout(() => {
                this.emit("tail");
                this.dispatchEvent(new w.Event("stop"));
            }, 0);
        }
    }
    w.MediaRecorder = FakeMediaRecorder;

    const blobs = [];
    const revoked = [];
    w.URL.createObjectURL = (blob) => {
        blobs.push(blob);
        return BLOB;
    };
    w.URL.revokeObjectURL = (url) => revoked.push(url);
    const downloads = [];
    w.HTMLAnchorElement.prototype.click = function () {
        downloads.push({ href: this.href, download: this.download, connected: this.isConnected });
    };

    w.eval(readRepoFile("shared", "settings.js"));
    w.eval(readRepoFile("shared", "data.js"));
    w.eval(readRepoFile("content.js"));
    w.eval(readRepoFile("features", "videoRecorder.js"));
    t.after(() => {
        w.CheeseSpanner.videoRecorder?.stop();
        dom.window.close();
    });
    const button = () => doc.getElementById("cheese-spanner-video-recorder-toggle");
    return {
        w,
        doc,
        chrome,
        worker,
        captures,
        recorders,
        blobs,
        revoked,
        downloads,
        button,
        prepareVideo,
        badge: () => doc.getElementById("cheese-spanner-video-recorder-badge"),
        status: () => doc.getElementById("cheese-spanner-video-recorder-status"),
        click(target = button()) {
            dispatchTrusted(target, new w.MouseEvent("click", { bubbles: true, cancelable: true }));
        },
        recorderMessages: () => chrome.testState.runtimeMessages.filter((m) => m?.type === Recording.MESSAGE_TYPE),
        async setOptions(values) {
            const changes = {};
            for (const [key, value] of Object.entries(values)) {
                changes[key] = { oldValue: chrome.testState.sync[key], newValue: value };
                chrome.testState.sync[key] = value;
            }
            for (const listener of chrome.testState.storageChangeListeners) listener(changes, "sync");
            await waitForAsyncCallbacks();
        },
    };
}

async function ready(h) {
    await waitForCondition(() => h.button(), { message: "record button was not mounted" });
}

test("download folder names stay relative, bounded and free of path tricks", () => {
    const normalize = Settings.normalizeDownloadFolder;
    assert.equal(normalize(""), "");
    assert.equal(normalize("  치지직 녹화  "), "치지직 녹화");
    assert.equal(normalize("../../etc/passwd"), "etc/passwd");
    assert.equal(normalize("/Users/me/Movies"), "Users/me/Movies");
    assert.equal(normalize("C:\\Videos\\chzzk"), "C/Videos/chzzk");
    assert.equal(normalize("a/./b/../c"), "a/b/c");
    assert.equal(normalize('bad<>:"|?*name.'), "badname");
    assert.equal(normalize("con/LPT1.txt/ok"), "_con/_LPT1.txt/ok");
    assert.equal(normalize("a/b/c/d/e/f/g"), "a/b/c/d/e");
    assert.equal(normalize("x".repeat(80)).length, 60);
    assert.ok(normalize(Array.from({ length: 5 }, () => "y".repeat(60)).join("/")).length <= 120);
    for (const value of [null, 3, {}, ["a"]]) assert.equal(normalize(value), "");
    assert.equal(Settings.normalizeOptions({}).videoRecorderFolder, "");
    assert.equal(Settings.normalizeOptions({}).videoRecorderEnabled, true);
    assert.equal(Settings.normalizeOptions({ videoRecorderFolder: "../녹화" }).videoRecorderFolder, "녹화");
});

test("chzzk pages may write only an already normalized recording folder through the settings store", () => {
    assert.equal(SettingsBackup.validateStoreEntry("sync", "videoRecorderFolder", "치지직/녹화").ok, true);
    assert.equal(SettingsBackup.validateStoreEntry("sync", "videoRecorderFolder", "").ok, true);
    assert.equal(SettingsBackup.validateStoreEntry("sync", "videoRecorderFolder", "../녹화").ok, false);
    assert.equal(SettingsBackup.validateStoreEntry("sync", "videoRecorderFolder", 3).ok, false);
    assert.equal(SettingsBackup.validateStoreEntry("sync", "videoRecorderEnabled", false).ok, false);
    assert.equal(SettingsBackup.validateStoreEntry("local", "videoRecorderFolder", "a").ok, false);
});

test("the record button records the main video as MP4 and saves it to the download folder when no folder is set", async (t) => {
    const h = fixture(t);
    await ready(h);
    const controls = h.doc.querySelector(".pzp-pc__bottom-buttons-right");
    assert.equal(controls.firstElementChild, h.button());
    assert.equal(h.button().type, "button");
    assert.equal(h.button().getAttribute("aria-label"), "녹화 시작");
    assert.equal(h.button().getAttribute("aria-pressed"), "false");

    // A page script's click must not start capturing the video.
    h.button().click();
    assert.equal(h.recorders.length, 0);

    h.click();
    assert.equal(h.recorders.length, 1);
    const recorder = h.recorders[0];
    assert.equal(recorder.options.mimeType, MP4);
    assert.equal(recorder.options.videoBitsPerSecond, 8_000_000);
    assert.equal(recorder.state, "recording");
    assert.equal(recorder.timeslice, 1000);
    assert.equal(h.button().getAttribute("aria-pressed"), "true");
    assert.match(h.button().getAttribute("aria-label"), /^녹화 중지 \(00:0\d\)$/);
    assert.match(h.badge().textContent, /^녹화 00:0\d$/);
    assert.equal(h.w.CheeseSpanner.videoRecorder.isRecording(), true);

    recorder.emit("part-1");
    recorder.emit("part-2");
    h.click();
    await waitForCondition(() => h.downloads.length === 1, { message: "recording was not downloaded" });
    assert.equal(h.downloads[0].href, BLOB);
    assert.match(
        h.downloads[0].download,
        new RegExp(`^치지직 라이브 ${CHANNEL} \\d{4}-\\d\\d-\\d\\d \\d\\d-\\d\\d-\\d\\d\\.mp4$`)
    );
    assert.equal(h.downloads[0].connected, true);
    assert.equal(h.doc.querySelector("a[download]"), null);
    assert.equal(await h.blobs[0].text(), "part-1part-2tail");
    assert.equal(h.blobs[0].type, "video/mp4");
    assert.ok(h.captures[0].every((track) => track.stopped));
    assert.equal(h.badge(), null);
    assert.equal(h.button().getAttribute("aria-pressed"), "false");
    assert.equal(h.w.CheeseSpanner.videoRecorder.isRecording(), false);

    const [prepare] = h.recorderMessages().filter((m) => m.op === "prepare");
    assert.deepEqual(
        { ...prepare },
        {
            type: Recording.MESSAGE_TYPE,
            version: 1,
            op: "prepare",
            url: BLOB,
            fileName: h.downloads[0].download,
        }
    );
    assert.equal(h.status().textContent, "녹화 파일을 다운로드 폴더에 저장해요.");
    assert.deepEqual(h.worker.determine({ url: BLOB, filename: h.downloads[0].download }), []);
});

test("WebM is used when Chrome cannot encode MP4, and an unplayable video is not recorded", async (t) => {
    const h = fixture(t, { supported: [WEBM], path: "/video/12345" });
    await ready(h);
    const video = h.doc.querySelector("video");
    video.testReadyState = 1;
    h.click();
    assert.equal(h.recorders.length, 0);
    assert.equal(h.status().textContent, "영상이 재생되기 시작하면 다시 눌러 주세요.");
    video.testReadyState = 4;
    h.click();
    assert.equal(h.recorders[0].options.mimeType, WEBM);
    h.recorders[0].emit("a");
    h.click();
    await waitForCondition(() => h.downloads.length === 1);
    assert.match(h.downloads[0].download, /^치지직 다시보기 12345 .+\.webm$/);
    assert.equal(h.blobs[0].type, "video/webm");
});

test("a chosen folder is applied by the worker only for this blob while the downloads permission is held", async (t) => {
    const h = fixture(t, { sync: { videoRecorderFolder: "치지직/녹화" }, held: true });
    await ready(h);
    h.click();
    h.recorders[0].emit("x");
    h.click();
    await waitForCondition(() => h.downloads.length === 1);
    const fileName = h.downloads[0].download;
    assert.equal(h.status().textContent, "녹화 파일을 다운로드 폴더의 치지직/녹화에 저장해요.");
    // Another download keeps Chrome's own name; ours goes into the folder once.
    assert.deepEqual(h.worker.determine({ url: "https://example.com/a.zip", filename: "a.zip" }), []);
    assert.deepEqual(h.worker.determine({ url: BLOB, filename: fileName }), [
        { filename: `치지직/녹화/${fileName}`, conflictAction: "uniquify" },
    ]);
    assert.deepEqual(h.worker.determine({ url: BLOB, filename: fileName }), []);
});

test("without the downloads permission a folder is remembered but the file stays in the download folder", async (t) => {
    const h = fixture(t, { sync: { videoRecorderFolder: "녹화" }, held: false });
    await ready(h);
    h.click();
    h.recorders[0].emit("x");
    h.click();
    await waitForCondition(() => h.downloads.length === 1);
    assert.equal(h.status().textContent, "녹화 파일을 다운로드 폴더에 저장해요.");
    assert.equal(h.worker.listeners.length, 0);
});

test("leaving the route, a new source, a removed video and turning the option off each save what was recorded", async (t) => {
    const h = fixture(t);
    await ready(h);

    h.click();
    h.recorders[0].emit("route");
    h.w.history.pushState(null, "", "/live/fedcba9876543210fedcba9876543210");
    h.w.dispatchEvent(new h.w.Event("popstate"));
    await waitForCondition(() => h.downloads.length === 1, { message: "route change did not save" });
    assert.match(h.downloads[0].download, new RegExp(`^치지직 라이브 ${CHANNEL} `));

    await waitForCondition(() => h.button());
    h.click();
    h.recorders[1].emit("source");
    h.doc.querySelector("video").dispatchEvent(new h.w.Event("emptied"));
    await waitForCondition(() => h.downloads.length === 2, { message: "source change did not save" });

    h.click();
    h.recorders[2].emit("removed");
    const replacement = h.doc.createElement("video");
    h.prepareVideo(replacement);
    h.doc.querySelector("video").replaceWith(replacement);
    await waitForCondition(() => h.downloads.length === 3, { message: "replaced video did not save" });
    assert.equal(h.recorders.length, 3);

    await waitForCondition(() => h.button());
    h.click();
    h.recorders[3].emit("off");
    await h.setOptions({ videoRecorderEnabled: false });
    await waitForCondition(() => h.downloads.length === 4, { message: "turning the option off did not save" });
    assert.equal(h.button(), null);
    assert.equal(h.doc.getElementById("cheese-spanner-video-recorder-folder-row"), null);
    assert.equal(h.doc.getElementById("cheese-spanner-video-recorder-style"), null);
    for (const tracks of h.captures) assert.ok(tracks.every((track) => track.stopped));
});

test("leaving the page while recording asks for confirmation, and a stopped recording does not", async (t) => {
    const h = fixture(t);
    await ready(h);
    const leave = () => {
        const event = new h.w.Event("beforeunload", { cancelable: true });
        h.w.dispatchEvent(event);
        return event.defaultPrevented;
    };
    assert.equal(leave(), false);
    h.click();
    assert.equal(leave(), true);
    h.click();
    await waitForCondition(() => h.downloads.length === 1);
    assert.equal(leave(), false);
});

test("the gear menu edits the synced save folder through the settings store on a real press only", async (t) => {
    const h = fixture(t, { held: false });
    await ready(h);
    const row = await (async () => {
        await waitForCondition(() => h.doc.getElementById("cheese-spanner-video-recorder-folder-row"));
        return h.doc.getElementById("cheese-spanner-video-recorder-folder-row");
    })();
    const menu = h.doc.querySelector(".pzp-pc__settings");
    assert.equal(row.parentElement, menu);
    assert.ok(row.hasAttribute("data-cheese-spanner-menu-entry"));
    const menuButton = row.querySelector('[role="menuitem"]');
    assert.equal(row.querySelector(".pzp-ui-setting-home-item__value").textContent, "다운로드 폴더");
    const edit = h.doc.getElementById("cheese-spanner-video-recorder-folder-edit");
    assert.equal(edit.hidden, true);
    assert.equal(menuButton.getAttribute("aria-expanded"), "false");

    h.click(menuButton);
    assert.equal(edit.hidden, false);
    assert.equal(menuButton.getAttribute("aria-expanded"), "true");
    const input = edit.querySelector("input");
    const save = edit.querySelector("button");
    assert.equal(h.doc.activeElement, input);
    assert.equal(edit.querySelector("p").textContent, "비워 두면 Chrome 다운로드 폴더에 바로 저장해요.");

    input.value = " ../치지직/녹화. ";
    save.click();
    await waitForAsyncCallbacks();
    assert.equal(h.chrome.testState.runtimeMessages.filter((m) => m?.type === SETTINGS_STORE).length, 0);

    // Typing keys stay inside the field.
    let leaked = 0;
    h.w.addEventListener("keydown", () => leaked++);
    input.dispatchEvent(new h.w.KeyboardEvent("keydown", { key: "k", bubbles: true }));
    assert.equal(leaked, 0);

    dispatchTrusted(input, new h.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitForCondition(() => h.chrome.testState.sync.videoRecorderFolder === "치지직/녹화");
    const [request] = h.chrome.testState.runtimeMessages.filter((m) => m?.type === SETTINGS_STORE);
    assert.deepEqual({ ...request.values }, { videoRecorderFolder: "치지직/녹화" });
    assert.equal(input.value, "치지직/녹화");
    assert.equal(row.querySelector(".pzp-ui-setting-home-item__value").textContent, "치지직/녹화");
    await waitForCondition(() => /다운로드 권한/.test(edit.querySelector("p").textContent));
    assert.equal(
        edit.querySelector("p").textContent,
        "하위 폴더에 저장하려면 확장 옵션에서 다운로드 권한을 허용해 주세요. 지금은 다운로드 폴더에 저장해요."
    );

    h.worker.permissions.held = true;
    h.click(menuButton);
    h.click(menuButton);
    await waitForCondition(
        () => edit.querySelector("p").textContent === "다운로드 폴더 안의 치지직/녹화 폴더에 저장해요."
    );

    // A folder chosen in the options page appears in the open menu.
    await h.setOptions({ videoRecorderFolder: "다른" });
    assert.equal(row.querySelector(".pzp-ui-setting-home-item__value").textContent, "다른");
});

test("the worker accepts recorder requests only from a top chzzk frame of this extension with valid names", async () => {
    const chrome = createFakeChrome({ sync: { videoRecorderFolder: "녹화" } });
    const worker = createWorker(chrome, { held: true });
    const good = {
        id: chrome.runtime.id,
        tab: { id: 1 },
        frameId: 0,
        url: "https://chzzk.naver.com/live/x",
        origin: "https://chzzk.naver.com",
    };
    const prepare = { type: Recording.MESSAGE_TYPE, version: 1, op: "prepare", url: BLOB, fileName: "a.mp4" };
    for (const sender of [
        { ...good, id: "other" },
        { ...good, frameId: 2 },
        { ...good, tab: undefined },
        { ...good, url: "https://evil.example/live", origin: "https://evil.example" },
        { ...good, url: "https://chzzk.naver.com.evil.example/" },
        { ...good, origin: "https://evil.example" },
    ]) {
        assert.deepEqual(await worker.controller.handleMessage(prepare, sender), {
            ok: false,
            error: "untrusted-sender",
        });
    }
    for (const patch of [
        { url: "blob:https://evil.example/1b4e28ba-2fa1-11d2-883f-0016d3cca427" },
        { url: "https://chzzk.naver.com/a.mp4" },
        { fileName: "../a.mp4" },
        { fileName: "a/b.mp4" },
        { fileName: "a.exe" },
        { fileName: ".mp4" },
        { fileName: `${"a".repeat(151)}.mp4` },
    ]) {
        assert.deepEqual(await worker.controller.handleMessage({ ...prepare, ...patch }, good), {
            ok: false,
            error: "invalid-request",
        });
    }
    assert.deepEqual(await worker.controller.handleMessage({ ...prepare, version: 2 }, good), {
        ok: false,
        error: "unsupported-version",
    });
    assert.deepEqual(await worker.controller.handleMessage({ ...prepare, op: "download" }, good), {
        ok: false,
        error: "unknown-operation",
    });
    assert.deepEqual(await worker.controller.handleMessage({ ...prepare, op: "status" }, good), {
        ok: true,
        folder: "녹화",
        downloads: true,
    });
    // The folder comes from storage, never from the message.
    assert.deepEqual(await worker.controller.handleMessage({ ...prepare, folder: "../../x" }, good), {
        ok: true,
        routed: true,
        folder: "녹화",
    });
    assert.deepEqual(worker.determine({ url: "x", finalUrl: BLOB }), [
        { filename: "녹화/a.mp4", conflictAction: "uniquify" },
    ]);
});

test("remembered blobs expire and stay bounded", async () => {
    const chrome = createFakeChrome({ sync: { videoRecorderFolder: "녹화" } });
    let now = 0;
    const listeners = [];
    const controller = Recording.createController({
        now: () => now,
        chrome: {
            runtime: { id: chrome.runtime.id },
            storage: { sync: chrome.storage.sync },
            permissions: { contains: (spec, callback) => callback(true), onAdded: { addListener() {} } },
            downloads: { onDeterminingFilename: { addListener: (fn) => listeners.push(fn) } },
        },
    });
    controller.install();
    const sender = { id: chrome.runtime.id, tab: { id: 1 }, frameId: 0, url: "https://chzzk.naver.com/live/x" };
    const url = (i) => `blob:https://chzzk.naver.com/00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
    const determine = (item) => {
        const out = [];
        listeners[0](item, (suggestion) => out.push(suggestion));
        return out;
    };
    for (let i = 0; i < Recording.MAX_PENDING + 2; i++) {
        await controller.handleMessage(
            { type: Recording.MESSAGE_TYPE, version: 1, op: "prepare", url: url(i), fileName: `${i}.mp4` },
            sender
        );
    }
    assert.equal(listeners.length, 1);
    assert.deepEqual(determine({ url: url(0) }), []);
    assert.deepEqual(determine({ url: url(1) }), []);
    assert.equal(determine({ url: url(2) }).length, 1);
    now = Recording.PENDING_TTL_MS;
    assert.deepEqual(determine({ url: url(3) }), []);
});
