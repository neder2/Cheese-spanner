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

function createWorker(chrome, { held = false, now, directory } = {}) {
    const listeners = [];
    const permissions = { held };
    const workerChrome = {
        runtime: { id: chrome.runtime.id, getURL: (path) => `chrome-extension://${chrome.runtime.id}/${path}` },
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
    const controller = Recording.createController({ chrome: workerChrome, now, directory });
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

function fixture(
    t,
    { sync = {}, path = `/live/${CHANNEL}`, supported = [MP4, WEBM], held = false, directory, fetchMetadata } = {}
) {
    const chrome = createFakeChrome({ sync: { videoRecorderEnabled: true, ...sync } });
    const dom = new JSDOM(`<!doctype html><html><body><main>${PLAYER}</main></body></html>`, {
        url: `https://chzzk.naver.com${path}`,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    const doc = w.document;
    w.chrome = chrome;
    w.Blob = Blob;
    w.fetch =
        fetchMetadata ||
        (async (url) => ({
            ok: true,
            async json() {
                const channelId = url.match(/channels\/([^/]+)\/live-detail/)?.[1];
                const videoNo = url.match(/videos\/(\d+)/)?.[1];
                return {
                    code: 200,
                    content: {
                        status: "OPEN",
                        liveTitle: "오늘 방송",
                        videoTitle: "다시보기 방송 제목",
                        videoNo: Number(videoNo),
                        channel: { channelId, channelName: "테스트 스트리머" },
                    },
                };
            },
        }));
    const worker = createWorker(chrome, { held, directory });
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
        const download = { href: this.href, connected: this.isConnected, parts: [], done: false };
        downloads.push(download);
        worker.controller.handleFetch({
            request: { url: this.href, mode: "navigate", method: "GET", destination: "document" },
            respondWith(response) {
                download.response = response;
                download.download = decodeURIComponent(response.headers.get("Content-Disposition").split("UTF-8''")[1]);
                download.suggestions = worker.determine({ url: download.href, filename: download.download });
                download.reader = response.body.getReader();
                download.reading = (async () => {
                    try {
                        for (;;) {
                            const { done, value } = await download.reader.read();
                            if (done) break;
                            download.parts.push(Buffer.from(value));
                        }
                        download.done = true;
                    } catch (_) {
                        download.failed = true;
                    }
                })();
            },
        });
    };

    w.eval(readRepoFile("shared", "settings.js"));
    w.eval(readRepoFile("shared", "data.js"));
    w.eval(readRepoFile("content.js"));
    w.eval(readRepoFile("features", "videoRecorder.js"));
    t.after(async () => {
        w.CheeseSpanner.videoRecorder?.stop();
        await waitForAsyncCallbacks();
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
        async start() {
            dispatchTrusted(button(), new w.MouseEvent("click", { bubbles: true, cancelable: true }));
            await waitForCondition(() => recorders.at(-1)?.state === "recording", {
                message: "recording did not start",
            });
        },
        text: (index) => Buffer.concat(downloads[index].parts).toString(),
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

function chosenDirectory({ denied = false, failWrite = false, failClose = false } = {}) {
    const writes = [];
    const state = { closed: false, aborted: false };
    return {
        writes,
        state,
        async get() {
            return { name: "내 녹화", queryPermission: async () => (denied ? "prompt" : "granted") };
        },
        async openFile() {
            if (denied) throw new Error("directory-permission");
            return {
                fileName: "unique.mp4",
                writer: {
                    async write(bytes) {
                        if (failWrite) throw new Error("disk-full");
                        writes.push(Buffer.from(bytes));
                    },
                    async close() {
                        if (failClose) throw new Error("disk-full");
                        state.closed = true;
                    },
                    async abort() {
                        state.aborted = true;
                    },
                },
            };
        },
    };
}

test("a selected native directory receives recording bytes without a download and commits on stop", async (t) => {
    const directory = chosenDirectory();
    const h = fixture(t, { directory });
    await ready(h);
    await h.start();
    h.recorders[0].emit("first");
    await waitForCondition(() => directory.writes.length > 0);
    assert.equal(h.downloads.length, 0);
    assert.equal(directory.state.closed, false);
    h.click();
    await waitForCondition(() => directory.state.closed);
    assert.match(Buffer.concat(directory.writes).toString(), /first/);
    await waitForCondition(() => /내 녹화.*저장 완료/.test(h.status()?.textContent));
});

test("a revoked folder permission prevents recording instead of silently downloading elsewhere", async (t) => {
    const h = fixture(t, { directory: chosenDirectory({ denied: true }) });
    await ready(h);
    h.click();
    await waitForCondition(() => /저장 폴더 접근 실패/.test(h.status()?.textContent));
    assert.equal(h.downloads.length, 0);
    assert.equal(h.recorders[0].state, "inactive");
    assert.ok(h.captures[0].every((track) => track.stopped));
});

test("directory writes preserve sender, size and sequence checks and fail closed on disk errors", async () => {
    for (const fault of [{}, { failWrite: true }, { failClose: true }]) {
        const directory = chosenDirectory(fault);
        const h = streamFixture({ directory });
        const route = await h.send({ op: "start", fileName: "test.mp4" });
        assert.equal(route.destination, "directory");
        const write = { op: "write", id: route.id, sequence: 0, data: "YWJj" };
        assert.equal((await h.send(write, { ...h.sender, documentId: "another" })).error, "unknown-recording");
        assert.equal((await h.send({ ...write, sequence: 1 })).error, "invalid-chunk");
        assert.equal((await h.send({ ...write, data: Buffer.alloc(65537).toString("base64") })).error, "invalid-chunk");
        const result = await h.send(write);
        assert.equal(result.ok, !fault.failWrite);
        if (!fault.failWrite) {
            assert.equal((await h.send(write)).error, "invalid-chunk");
            assert.equal((await h.send({ op: "finish", id: route.id, sequence: 1 })).ok, !fault.failClose);
        }
        assert.equal(directory.state.closed, !fault.failWrite && !fault.failClose);
        assert.equal(directory.state.aborted, Boolean(fault.failWrite || fault.failClose));
        assert.equal((await h.send({ op: "pulse", id: route.id })).error, "unknown-recording");
    }
});

test("unreadable directory storage never falls back to a different destination", async () => {
    const h = streamFixture({
        directory: {
            async get() {
                throw new Error("storage-failed");
            },
        },
    });
    assert.equal((await h.send({ op: "start", fileName: "test.mp4" })).error, "directory-unavailable");
});

test("returning from folder settings refreshes the player's destination without starting recording", async (t) => {
    const directory = chosenDirectory();
    let selected = null;
    directory.get = async () => selected;
    const h = fixture(t, { directory });
    await ready(h);
    const value = h.doc.querySelector("#cheese-spanner-video-recorder-folder-row .pzp-ui-setting-home-item__value");
    assert.equal(value.textContent, "다운로드 폴더");
    selected = { name: "선택한 폴더", queryPermission: async () => "granted" };
    h.w.dispatchEvent(new h.w.Event("focus"));
    await waitForCondition(() => value.textContent === "선택한 폴더");
    assert.equal(h.recorders.length, 0, "folder selection does not start recording");
});

test("directory backpressure allows one write and abort prevents a late write from reviving a session", async () => {
    let finishWrite;
    let aborted = false;
    const h = streamFixture({
        directory: {
            async get() {
                return { name: "recordings" };
            },
            async openFile() {
                return {
                    fileName: "test.mp4",
                    writer: {
                        write() {
                            return new Promise((resolve) => {
                                finishWrite = resolve;
                            });
                        },
                        async abort() {
                            aborted = true;
                        },
                    },
                };
            },
        },
    });
    const route = await h.send({ op: "start", fileName: "test.mp4" });
    const write = { op: "write", id: route.id, sequence: 0, data: "YWJj" };
    const pending = h.send(write);
    assert.equal((await h.send(write)).error, "write-pending");
    assert.equal((await h.send({ op: "abort", id: route.id })).ok, true);
    finishWrite();
    assert.equal((await pending).ok, false);
    assert.equal(aborted, true);
    assert.equal((await h.send(write)).error, "unknown-recording");
});

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
    assert.equal(Settings.normalizeOptions({}).videoRecorderEnabled, false);
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

test("recording defaults off and enabling the button still waits for a user click", async (t) => {
    const h = fixture(t, { sync: { videoRecorderEnabled: undefined } });
    await waitForAsyncCallbacks();
    assert.equal(h.button(), null);
    assert.equal(h.captures.length, 0);
    assert.equal(h.recorders.length, 0);
    await h.setOptions({ videoRecorderEnabled: true });
    await ready(h);
    assert.equal(h.recorders.length, 0);
    h.click();
    assert.equal(h.recorders.length, 1);
    await h.setOptions({ videoRecorderEnabled: false });
    assert.equal(h.button(), null);
});

test("recording names use the KST start date, verified title and streamer with safe bounded characters", async (t) => {
    const h = fixture(t, {
        fetchMetadata: async () => ({
            ok: true,
            json: async () => ({
                code: 200,
                content: {
                    status: "OPEN",
                    liveTitle: '오늘: 방송/준비? "완료"',
                    channel: { channelId: CHANNEL, channelName: "방송인*이름" },
                },
            }),
        }),
    });
    h.w.Date.now = () => Date.parse("2026-11-07T15:30:00Z");
    await ready(h);
    await h.start();
    assert.equal(h.downloads[0].download, "2026-11-08 오늘_ 방송_준비_ _완료_ - 방송인_이름.mp4");
    h.click();
    await waitForCondition(() => h.downloads[0].done);
    h.w.fetch = async () => ({
        ok: true,
        json: async () => ({
            code: 200,
            content: {
                status: "OPEN",
                liveTitle: "😀가".repeat(200),
                channel: { channelId: CHANNEL, channelName: "나".repeat(200) },
            },
        }),
    });
    await h.start();
    const name = h.downloads[1].download;
    assert.ok(name.length <= 154);
    assert.ok(Buffer.byteLength(name) <= 240);
    assert.equal(name.isWellFormed(), true);
});

test("metadata from a different channel or video cannot name the recording after the previous broadcast", async (t) => {
    for (const path of [`/live/${CHANNEL}`, "/video/12345"]) {
        const h = fixture(t, {
            path,
            fetchMetadata: async () => ({
                ok: true,
                json: async () => ({
                    code: 200,
                    content: {
                        status: "OPEN",
                        videoNo: 999,
                        liveTitle: "이전 방송",
                        videoTitle: "이전 영상",
                        channel: { channelId: "other", channelName: "이전 스트리머" },
                    },
                }),
            }),
        });
        h.doc.title = "이전 방송 - 이전 스트리머";
        await ready(h);
        await h.start();
        assert.doesNotMatch(h.downloads[0].download, /이전/);
        assert.match(h.downloads[0].download, /스트리머 정보 없음\.mp4$/);
        assert.ok(h.downloads[0].download.includes(path.startsWith("/live/") ? CHANNEL : "12345"));
    }
});

test("a late title response after route changes does not create a file or start capture", async (t) => {
    let reply;
    let signal;
    const h = fixture(t, {
        fetchMetadata: (_, options) => {
            signal = options.signal;
            return new Promise((resolve) => {
                reply = resolve;
            });
        },
    });
    await ready(h);
    h.click();
    h.w.history.pushState({}, "", "/video/98765");
    h.w.dispatchEvent(new h.w.Event("popstate"));
    await waitForCondition(() => signal.aborted);
    reply({
        ok: true,
        json: async () => ({
            code: 200,
            content: { status: "OPEN", liveTitle: "옛 방송", channel: { channelId: CHANNEL, channelName: "옛 이름" } },
        }),
    });
    await waitForCondition(() => h.captures[0].every((track) => track.stopped));
    assert.equal(signal.aborted, true);
    assert.equal(h.downloads.length, 0);
    assert.equal(h.recorders[0].state, "inactive");
    assert.equal(h.recorderMessages().filter((message) => message.op === "start").length, 0);
});

test("the record button streams MP4 to the download folder during recording and closes it on stop", async (t) => {
    const h = fixture(t);
    await ready(h);
    const controls = h.doc.querySelector(".pzp-pc__bottom-buttons-right");
    assert.equal(controls.firstElementChild, h.button());
    assert.equal(h.button().type, "button");
    assert.equal(h.button().getAttribute("aria-label"), "녹화 시작");
    assert.equal(h.button().getAttribute("aria-pressed"), "false");
    h.button().click();
    assert.equal(h.recorders.length, 0, "synthetic clicks cannot record");
    await h.start();
    const recorder = h.recorders[0];
    assert.equal(recorder.options.mimeType, MP4);
    assert.equal(recorder.options.videoBitsPerSecond, 8_000_000);
    assert.equal(recorder.timeslice, 1000);
    assert.equal(h.button().getAttribute("aria-pressed"), "true");
    assert.match(h.button().getAttribute("aria-label"), /^녹화 중지 \(00:0\d\)$/);
    assert.match(h.badge().textContent, /^녹화 00:0\d$/);
    assert.equal(h.w.CheeseSpanner.videoRecorder.isRecording(), true);
    assert.equal(h.downloads.length, 1, "download opens before recording data arrives");
    const download = h.downloads[0];
    assert.equal(download.connected, true);
    assert.match(download.href, /recording-download\.txt\?id=/);
    assert.match(download.download, new RegExp(`^\\d{4}-\\d\\d-\\d\\d 오늘 방송 - 테스트 스트리머\\.mp4$`));
    assert.equal(download.response.headers.get("Content-Type"), "video/mp4");
    assert.equal(h.doc.querySelector('a[href*="recording-download"]'), null);
    recorder.emit("part-1");
    await waitForCondition(() => h.text(0) === "part-1");
    assert.equal(download.done, false, "the file keeps growing while recording");
    recorder.emit("part-2");
    await waitForCondition(() => h.text(0) === "part-1part-2");
    h.click();
    await waitForCondition(() => download.done);
    assert.equal(h.text(0), "part-1part-2tail");
    assert.equal(h.blobs.length, 0, "the recording is never collected into a whole-file blob");
    assert.ok(h.captures[0].every((track) => track.stopped));
    assert.equal(h.badge(), null);
    assert.equal(h.button().getAttribute("aria-pressed"), "false");
    assert.equal(h.w.CheeseSpanner.videoRecorder.isRecording(), false);
    assert.equal(h.recorderMessages().filter((m) => m.op === "start").length, 1);
    assert.equal(h.recorderMessages().filter((m) => m.op === "prepare").length, 0);
    assert.equal(h.status().textContent, "녹화 파일 다운로드 마무리 중 (다운로드 폴더)");
    assert.deepEqual(download.suggestions, []);
});

test("recording a VOD multiview tile captures and names only its own video", async (t) => {
    const h = fixture(t, { path: "/video/123" });
    await ready(h);
    let mainCaptures = 0;
    h.doc.querySelector("video").captureStream = () => {
        mainCaptures++;
    };
    const cell = h.doc.createElement("div");
    cell.dataset.bcmvVideo = "1";
    cell.innerHTML = PLAYER;
    h.doc.querySelector("main").append(cell);
    const player = cell.firstElementChild;
    const video = cell.querySelector("video");
    h.prepareVideo(video);
    const auxiliary = { player, video, media: { videoNo: "456" }, title: "보조 영상", channelName: "보조 채널" };
    h.w.CheeseSpanner.vodMultiview = { getAuxiliaries: () => (cell.isConnected ? [auxiliary] : []) };
    const notify = () => h.doc.dispatchEvent(new h.w.Event("cheese-spanner:vod-multiview:auxiliary"));
    notify();
    const button = cell.querySelector("[data-bcvm-recorder]");
    button.click();
    assert.equal(h.recorders.length, 0);
    h.click(button);
    await waitForCondition(() => h.recorders[0]?.state === "recording");
    assert.equal(mainCaptures, 0);
    assert.equal(h.button().disabled, true);
    assert.equal(button.getAttribute("aria-pressed"), "true");
    assert.match(h.downloads[0].download, /보조 영상 - 보조 채널\.mp4$/);
    cell.remove();
    notify();
    await waitForCondition(() => h.downloads[0].done);
    assert.ok(h.captures[0].every((track) => track.stopped));
    assert.equal(h.button().disabled, false);
});

test("WebM is streamed when Chrome cannot encode MP4, and an unplayable video is not recorded", async (t) => {
    const h = fixture(t, { supported: [WEBM], path: "/video/12345" });
    await ready(h);
    const video = h.doc.querySelector("video");
    video.testReadyState = 1;
    h.click();
    assert.equal(h.recorders.length, 0);
    assert.equal(h.status().textContent, "영상 재생 후 녹화 버튼 다시 누르기");
    video.testReadyState = 4;
    await h.start();
    assert.equal(h.recorders[0].options.mimeType, WEBM);
    h.recorders[0].emit("a");
    h.click();
    await waitForCondition(() => h.downloads[0].done);
    assert.match(h.downloads[0].download, /^\d{4}-\d{2}-\d{2} 다시보기 방송 제목 - 테스트 스트리머\.webm$/);
    assert.equal(h.downloads[0].response.headers.get("Content-Type"), "video/webm");
    assert.equal(h.text(0), "atail");
});

test("the chosen folder applies once to this recording at download start and leaves other downloads alone", async (t) => {
    const h = fixture(t, { sync: { videoRecorderFolder: "치지직/녹화" }, held: true });
    await ready(h);
    await h.start();
    const download = h.downloads[0];
    assert.deepEqual(download.suggestions, [
        { filename: `치지직/녹화/${download.download}`, conflictAction: "uniquify" },
    ]);
    assert.deepEqual(h.worker.determine({ url: "https://example.com/a.zip", filename: "a.zip" }), []);
    assert.deepEqual(h.worker.determine({ url: download.href, filename: download.download }), []);
    h.recorders[0].emit("x");
    h.click();
    await waitForCondition(() => download.done);
    assert.equal(h.status().textContent, "녹화 파일 다운로드 마무리 중 (다운로드 폴더의 치지직/녹화)");
});

test("without downloads permission a chosen folder is remembered but streaming uses the download folder", async (t) => {
    const h = fixture(t, { sync: { videoRecorderFolder: "녹화" }, held: false });
    await ready(h);
    await h.start();
    h.recorders[0].emit("x");
    h.click();
    await waitForCondition(() => h.downloads[0].done);
    assert.equal(h.status().textContent, "녹화 파일 다운로드 마무리 중 (다운로드 폴더)");
    assert.equal(h.worker.listeners.length, 0);
    assert.deepEqual(h.downloads[0].suggestions, []);
});

test("route, source, video replacement and option off each drain and finish the existing download", async (t) => {
    const h = fixture(t);
    await ready(h);
    await h.start();
    h.recorders[0].emit("route");
    h.w.history.pushState(null, "", "/live/fedcba9876543210fedcba9876543210");
    h.w.dispatchEvent(new h.w.Event("popstate"));
    await waitForCondition(() => h.downloads[0].done);
    assert.match(h.downloads[0].download, /^\d{4}-\d{2}-\d{2} 오늘 방송 - 테스트 스트리머\.mp4$/);
    assert.equal(h.text(0), "routetail");
    await waitForCondition(() => h.button());
    await h.start();
    h.recorders[1].emit("source");
    h.doc.querySelector("video").dispatchEvent(new h.w.Event("emptied"));
    await waitForCondition(() => h.downloads[1].done);
    assert.equal(h.text(1), "sourcetail");
    await h.start();
    h.recorders[2].emit("removed");
    const replacement = h.doc.createElement("video");
    h.prepareVideo(replacement);
    h.doc.querySelector("video").replaceWith(replacement);
    await waitForCondition(() => h.downloads[2].done);
    assert.equal(h.text(2), "removedtail");
    assert.equal(h.recorders.length, 3);
    await waitForCondition(() => h.button());
    await h.start();
    h.recorders[3].emit("off");
    await h.setOptions({ videoRecorderEnabled: false });
    await waitForCondition(() => h.downloads[3].done);
    assert.equal(h.text(3), "offtail");
    assert.equal(h.button(), null);
    assert.equal(h.doc.getElementById("cheese-spanner-video-recorder-folder-row"), null);
    assert.equal(h.doc.getElementById("cheese-spanner-video-recorder-style"), null);
    for (const tracks of h.captures) assert.ok(tracks.every((track) => track.stopped));
});

test("leaving while recording asks for confirmation, and stopping finishes without another download", async (t) => {
    const h = fixture(t);
    await ready(h);
    const leave = () => {
        const event = new h.w.Event("beforeunload", { cancelable: true });
        h.w.dispatchEvent(event);
        return event.defaultPrevented;
    };
    assert.equal(leave(), false);
    await h.start();
    assert.equal(leave(), true);
    h.click();
    assert.equal(leave(), true, "leaving is still guarded while the final bytes are being sent");
    await waitForCondition(() => h.downloads[0].done);
    assert.equal(h.downloads.length, 1);
    assert.equal(leave(), false);
});

test("cancelling download preparation does not later start recording", async (t) => {
    const h = fixture(t);
    await ready(h);
    h.click();
    const leave = new h.w.Event("beforeunload", { cancelable: true });
    h.w.dispatchEvent(leave);
    assert.equal(leave.defaultPrevented, false, "opening the attachment must not trigger a leave-page prompt");
    h.click();
    await waitForAsyncCallbacks();
    assert.equal(h.recorders[0].state, "inactive");
    assert.equal(h.downloads.length, 0);
    assert.ok(h.captures[0].every((track) => track.stopped));
});

test("an encoder that fails to start cancels the opened download and releases capture", async (t) => {
    const h = fixture(t);
    await ready(h);
    h.w.MediaRecorder.prototype.start = () => {
        throw new Error("encoder unavailable");
    };
    h.click();
    await waitForCondition(() => h.downloads[0]?.failed);
    assert.equal(h.w.CheeseSpanner.videoRecorder.isRecording(), false);
    assert.equal(h.button().disabled, false);
    assert.ok(h.captures[0].every((track) => track.stopped));
    assert.equal(
        h.recorderMessages().some((message) => message.op === "finish"),
        false
    );
    assert.equal(h.status().textContent, "녹화 시작 실패");
});

test("large media chunks are streamed in ordered bounded messages and download cancellation stops capture", async (t) => {
    const h = fixture(t);
    await ready(h);
    await h.start();
    const data = "a".repeat(Recording.MAX_CHUNK_BYTES * 2 + 3);
    h.recorders[0].emit(data);
    await waitForCondition(() => h.text(0) === data);
    const writes = h.recorderMessages().filter((m) => m.op === "write");
    assert.deepEqual(
        writes.map((m) => m.sequence),
        [0, 1, 2]
    );
    assert.deepEqual(
        writes.map((m) => Buffer.from(m.data, "base64").length),
        [65536, 65536, 3]
    );
    await h.downloads[0].reader.cancel();
    h.recorders[0].emit("after-cancel");
    await waitForCondition(() => h.recorders[0].state === "inactive");
    await waitForCondition(() => /녹화 파일 완성 실패/.test(h.status()?.textContent || ""));
    assert.equal(h.text(0), data);
    assert.ok(h.captures[0].every((track) => track.stopped));
});

test("a delayed native Blob can follow an in-flight write and drain without stopping capture", async (t) => {
    const h = fixture(t);
    await ready(h);
    await h.start();
    const sendMessage = h.chrome.runtime.sendMessage;
    let release;
    let released = false;
    h.chrome.runtime.sendMessage = (message, callback) => {
        if (message.op === "write" && !release) {
            release = () => {
                if (released) return;
                released = true;
                sendMessage(message, callback);
            };
            return;
        }
        sendMessage(message, callback);
    };
    try {
        h.recorders[0].emit("before");
        await waitForCondition(() => release);
        const large = Buffer.alloc(17 * 1024 * 1024 + 3, 97);
        h.recorders[0].emit(large);
        h.recorders[0].emit("after");
        assert.equal(h.recorders[0].state, "recording", "one native Blob is not a stalled download");
        release();
        const deliveredBytes = () => h.downloads[0].parts.reduce((sum, part) => sum + part.length, 0);
        await waitForCondition(() => deliveredBytes() === large.length + 11, { timeoutMs: 30_000 });
        assert.equal(h.recorders[0].state, "recording");
        assert.deepEqual(
            Buffer.concat(h.downloads[0].parts),
            Buffer.concat([Buffer.from("before"), large, Buffer.from("after")])
        );

        // Once the first delayed Blob has drained, another native flush can use the same bounded allowance.
        h.recorders[0].emit(large);
        h.recorders[0].emit("end");
        assert.equal(h.recorders[0].state, "recording");
        h.click();
        await waitForCondition(() => h.downloads[0].done, { timeoutMs: 30_000 });
        assert.deepEqual(
            Buffer.concat(h.downloads[0].parts),
            Buffer.concat([Buffer.from("before"), large, Buffer.from("after"), large, Buffer.from("endtail")])
        );
        const writes = h.recorderMessages().filter((message) => message.op === "write");
        assert.ok(
            writes.every(
                (message, index) =>
                    message.sequence === index &&
                    Buffer.from(message.data, "base64").length <= Recording.MAX_CHUNK_BYTES
            )
        );
        assert.doesNotMatch(h.status().textContent, /중단/);
    } finally {
        h.chrome.runtime.sendMessage = sendMessage;
        if (!h.downloads[0].done) await h.downloads[0].reader.cancel().catch(() => {});
        release?.();
        if (h.recorders[0].state === "recording") h.click();
        await waitForCondition(() => h.recorders[0].state === "inactive" && !h.button().disabled, {
            message: "recording cleanup did not finish",
        });
    }
});

test("one large native Blob does not remove the backlog bound or allow a second large Blob to accumulate", async (t) => {
    for (const kind of ["ordinary-backlog", "second-large-blob", "ordinary-backlog-drain"]) {
        await t.test(kind, async (t) => {
            const h = fixture(t);
            await ready(h);
            await h.start();
            const sendMessage = h.chrome.runtime.sendMessage;
            let release;
            let released = false;
            h.chrome.runtime.sendMessage = (message, callback) => {
                if (message.op === "write" && !release) {
                    release = () => {
                        if (released) return;
                        released = true;
                        sendMessage(message, callback);
                    };
                    return;
                }
                sendMessage(message, callback);
            };
            try {
                const chunks = [Buffer.alloc(17 * 1024 * 1024, 97)];
                h.recorders[0].emit(chunks[0]);
                await waitForCondition(() => release);
                assert.equal(h.recorders[0].state, "recording");
                if (kind !== "second-large-blob") {
                    chunks.push(Buffer.alloc(8 * 1024 * 1024, 98), Buffer.alloc(8 * 1024 * 1024, 99));
                    h.recorders[0].emit(chunks[1]);
                    h.recorders[0].emit(chunks[2]);
                    assert.equal(h.recorders[0].state, "recording", "the ordinary backlog may reach 16MiB");
                    chunks.push(Buffer.from("overflow"));
                    h.recorders[0].emit(chunks[3]);
                } else {
                    chunks.push(Buffer.alloc(17 * 1024 * 1024, 98));
                    h.recorders[0].emit(chunks[1]);
                }
                assert.equal(h.recorders[0].state, "inactive", "additional queued data stops further capture");
                if (kind === "ordinary-backlog-drain") {
                    release();
                    await waitForCondition(() => h.downloads[0].done, { timeoutMs: 30_000 });
                    assert.deepEqual(
                        Buffer.concat(h.downloads[0].parts),
                        Buffer.concat([...chunks, Buffer.from("tail")])
                    );
                    assert.match(h.status().textContent, /중단 시점까지/);
                } else {
                    await h.downloads[0].reader.cancel();
                    release();
                    await waitForCondition(() => /녹화 파일 완성 실패/.test(h.status()?.textContent || ""));
                }
                assert.ok(h.captures[0].every((track) => track.stopped));
                assert.equal(h.button().disabled, false);
            } finally {
                h.chrome.runtime.sendMessage = sendMessage;
                if (!h.downloads[0].done) await h.downloads[0].reader.cancel().catch(() => {});
                release?.();
                if (h.recorders[0].state === "recording") h.click();
                await waitForCondition(() => h.recorders[0].state === "inactive" && !h.button().disabled, {
                    message: "recording cleanup did not finish",
                });
            }
        });
    }
});

test("the gear menu opens a directory picker only on a trusted press and preserves synced settings", async (t) => {
    const h = fixture(t);
    await ready(h);
    await waitForCondition(() => h.doc.getElementById("cheese-spanner-video-recorder-folder-row"));
    const row = h.doc.getElementById("cheese-spanner-video-recorder-folder-row");
    const button = row.querySelector('[role="menuitem"]');
    assert.equal(button.getAttribute("aria-haspopup"), "dialog");
    let calls = 0;
    h.w.showDirectoryPicker = async (options) => {
        calls++;
        assert.equal(options.mode, "readwrite");
        return { name: "선택 폴더", queryPermission: async () => "granted" };
    };
    button.click();
    await waitForAsyncCallbacks();
    assert.equal(calls, 0);
    h.click(button);
    await waitForCondition(() => row.textContent.includes("선택 폴더"));
    assert.equal(calls, 1);
    assert.equal(h.recorders.length, 0);
    assert.equal(h.chrome.testState.runtimeMessages.filter((m) => m?.type === SETTINGS_STORE).length, 0);
    h.w.showDirectoryPicker = async () => {
        throw new h.w.DOMException("Cancelled", "AbortError");
    };
    h.click(button);
    await waitForCondition(() => !row.textContent.includes("선택 중"));
    assert.ok(row.textContent.includes("선택 폴더"));
});

test("a late directory picker result cannot update a removed or replacement menu", async (t) => {
    const h = fixture(t);
    await ready(h);
    await waitForCondition(() => h.doc.getElementById("cheese-spanner-video-recorder-folder-row"));
    let finish;
    h.w.showDirectoryPicker = () =>
        new Promise((resolve) => {
            finish = resolve;
        });
    const row = h.doc.getElementById("cheese-spanner-video-recorder-folder-row");
    h.click(row.querySelector('[role="menuitem"]'));
    assert.equal(typeof finish, "function");
    h.doc.querySelector(".pzp-pc__settings").remove();
    await waitForCondition(() => !row.isConnected);
    await waitForAsyncCallbacks();
    h.doc.querySelector(".pzp-pc").insertAdjacentHTML("beforeend", MENU);
    await waitForCondition(() => h.doc.getElementById("cheese-spanner-video-recorder-folder-row"));
    finish({ name: "늦은 폴더", queryPermission: async () => "granted" });
    await waitForAsyncCallbacks();
    const replacement = h.doc.getElementById("cheese-spanner-video-recorder-folder-row");
    assert.equal(replacement.querySelector(".pzp-ui-setting-home-item__value").textContent, "다운로드 폴더");
    assert.equal(h.recorders.length, 0);
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

function streamFixture(options) {
    const chrome = createFakeChrome();
    const worker = createWorker(chrome, options);
    const sender = {
        id: chrome.runtime.id,
        tab: { id: 1 },
        documentId: "document-1",
        frameId: 0,
        url: `https://chzzk.naver.com/live/${CHANNEL}`,
        origin: "https://chzzk.naver.com",
    };
    return {
        sender,
        send: (message, owner = sender) =>
            worker.controller.handleMessage({ type: Recording.MESSAGE_TYPE, version: 1, ...message }, owner),
        fetch(url, patch = {}) {
            let result;
            worker.controller.handleFetch({
                request: { url, method: "GET", mode: "navigate", destination: "document", ...patch },
                respondWith(response) {
                    result = response;
                },
            });
            return result;
        },
    };
}

test("stream downloads bind writes to the starting tab and document and reject page fetches and replays", async () => {
    const h = streamFixture();
    assert.equal((await h.send({ op: "start", fileName: "../a.mp4" })).error, "invalid-request");
    assert.equal(
        (await h.send({ op: "start", fileName: "a.mp4" }, { ...h.sender, frameId: 1 })).error,
        "untrusted-sender"
    );
    const route = await h.send({ op: "start", fileName: "방송.mp4" });
    assert.equal(route.ok, true);
    assert.equal(h.fetch("https://example.com/recording-download.txt"), undefined);
    for (const patch of [
        { mode: "cors" },
        { mode: "no-cors" },
        { destination: "iframe" },
        { method: "POST" },
        { url: `${route.url}&extra=1` },
    ]) {
        assert.equal(h.fetch(route.url, patch).status, 204);
    }
    for (const owner of [
        { ...h.sender, tab: { id: 2 } },
        { ...h.sender, documentId: "new-document" },
    ]) {
        for (const op of ["ready", "write", "finish", "abort", "pulse"]) {
            assert.equal(
                (await h.send({ op, id: route.id, sequence: 0, data: "YQ==" }, owner)).error,
                "unknown-recording"
            );
        }
    }
    const opening = h.send({ op: "ready", id: route.id });
    const response = h.fetch(route.url);
    assert.equal((await opening).ok, true);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(h.fetch(route.url).status, 204, "the same URL cannot consume the recording twice");
    const reader = response.body.getReader();
    assert.equal((await h.send({ op: "write", id: route.id, sequence: 0, data: "YQ==" })).ok, true);
    assert.equal(Buffer.from((await reader.read()).value).toString(), "a");
    assert.equal((await h.send({ op: "finish", id: route.id, sequence: 1 })).ok, true);
    assert.equal((await reader.read()).done, true);
    assert.equal((await h.send({ op: "write", id: route.id, sequence: 1, data: "Yg==" })).error, "unknown-recording");
});

test("stream chunks remain ordered and bounded, and a slow download applies backpressure", async () => {
    const h = streamFixture();
    const route = await h.send({ op: "start", fileName: "test.webm" });
    const response = h.fetch(route.url);
    const reader = response.body.getReader();
    const write = (sequence, data) => h.send({ op: "write", id: route.id, sequence, data });
    for (const [sequence, data] of [
        [1, "YQ=="],
        [-1, "YQ=="],
        [0.5, "YQ=="],
        [0, ""],
        [0, "%%%="],
        [0, Buffer.alloc(Recording.MAX_CHUNK_BYTES + 1).toString("base64")],
    ]) {
        assert.equal((await write(sequence, data)).error, "invalid-chunk");
    }
    assert.equal((await write(0, "YQ==")).ok, true);
    assert.equal((await write(0, "YQ==")).error, "invalid-chunk");
    let settled = false;
    const blocked = write(1, "Yg==").then((result) => {
        settled = true;
        return result;
    });
    await Promise.resolve();
    assert.equal(settled, false, "only one chunk may wait in the download stream");
    assert.equal((await write(2, "Yw==")).error, "write-pending");
    assert.equal((await h.send({ op: "pulse", id: route.id })).ok, true, "keepalive does not displace a pending write");
    assert.equal(Buffer.from((await reader.read()).value).toString(), "a");
    assert.equal((await blocked).ok, true);
    assert.equal(Buffer.from((await reader.read()).value).toString(), "b");
    assert.equal((await h.send({ op: "finish", id: route.id, sequence: 1 })).error, "invalid-sequence");
    assert.equal((await h.send({ op: "finish", id: route.id, sequence: 2 })).ok, true);
    assert.equal((await reader.read()).done, true);
});

test("download cancellation releases a waiting write and abandoned stream sessions stay bounded", async () => {
    let now = 0;
    const h = streamFixture({ now: () => now });
    const routes = await Promise.all(
        Array.from({ length: Recording.MAX_PENDING + 1 }, () => h.send({ op: "start", fileName: "a.mp4" }))
    );
    assert.equal(routes.filter((route) => route.ok).length, Recording.MAX_PENDING);
    assert.equal(routes.filter((route) => route.error === "too-many-recordings").length, 1);
    const route = routes.find((entry) => entry.ok);
    const reader = h.fetch(route.url).body.getReader();
    await h.send({ op: "write", id: route.id, sequence: 0, data: "YQ==" });
    const blocked = h.send({ op: "write", id: route.id, sequence: 1, data: "Yg==" });
    await reader.cancel();
    assert.equal((await blocked).error, "download-closed");
    assert.equal((await h.send({ op: "pulse", id: route.id })).error, "unknown-recording");
    assert.equal((await h.send({ op: "start", fileName: "b.mp4" })).ok, true, "cancellation releases its slot");
    now = 31_000;
    assert.equal((await h.send({ op: "start", fileName: "c.mp4" })).ok, true);
    for (const stale of routes.filter((entry) => entry.ok)) {
        assert.equal(h.fetch(stale.url).status, 204);
    }
});
