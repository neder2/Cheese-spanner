const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const {
    createFakeChrome,
    dispatchTrusted,
    readRepoFile,
    waitForAsyncCallbacks,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

const ID = "cheese-spanner-video-screenshot";
const PLAYER =
    '<div class="pzp-pc"><video class="webplayer-internal-video"></video><div class="pzp-pc__bottom-buttons-right"></div></div>';

async function fixture(t, initial = {}, path = "/live/current") {
    const host = path.startsWith("/video/")
        ? 'id="player_layout" class="chzzk_player type_vod"'
        : 'id="live_player_layout" class="chzzk_player type_live"';
    const dom = new JSDOM(
        `<!doctype html><div data-bcmv-video>${PLAYER}</div><aside>${PLAYER}</aside><main ${host}>${PLAYER}</main>`,
        {
            url: "https://chzzk.naver.com" + path,
            runScripts: "outside-only",
            pretendToBeVisual: true,
        }
    );
    const w = dom.window;
    const doc = w.document;
    const chrome = createFakeChrome({ sync: initial, permissionGranted: false });
    w.chrome = chrome;
    const h = {
        w,
        doc,
        chrome,
        video: doc.querySelector("main video"),
        button: () => doc.getElementById(ID),
        status: () => doc.getElementById(ID + "-status")?.textContent || "",
        downloads: [],
        draws: [],
        copies: [],
        requests: [],
        urls: [],
        readyState: 0,
        width: 1920,
        height: 1080,
        currentSrc: "blob:original",
        pixels: [24, 128, 255, 255],
        async options(values) {
            Object.assign(chrome.testState.sync, values);
            for (const listener of chrome.testState.storageChangeListeners) {
                listener(
                    Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])),
                    "sync"
                );
            }
            await waitForAsyncCallbacks();
        },
        media(type) {
            dispatchTrusted(h.video, new w.Event(type));
        },
        loadFrame() {
            h.media("loadstart");
            h.media("loadeddata");
        },
        click() {
            dispatchTrusted(h.button(), new w.MouseEvent("click", { bubbles: true }));
        },
    };
    w.Date.now = () => Date.parse("2026-11-27T15:23:45Z");
    function bindMedia(video) {
        Object.defineProperties(video, {
            readyState: { get: () => h.readyState },
            videoWidth: { get: () => h.width },
            videoHeight: { get: () => h.height },
            mediaKeys: { get: () => h.keys ?? null },
            currentSrc: { get: () => h.currentSrc },
            srcObject: { value: null, writable: true },
        });
    }
    bindMedia(h.video);
    h.replaceMain = () => {
        const next = h.video.cloneNode(false);
        bindMedia(next);
        h.video.replaceWith(next);
        h.video = next;
    };
    w.fetch = async (url, init) => {
        assert.equal(init.credentials, "omit");
        h.requests.push(url);
        if (h.pendingResponse) await h.pendingResponse;
        return {
            ok: true,
            json: async () => ({
                code: 200,
                content: {
                    status: "OPEN",
                    liveTitle: "오늘/방송",
                    videoTitle: "지난 방송",
                    videoNo: 123,
                    channel: { channelId: "current", channelName: "테스트" },
                },
            }),
        };
    };
    w.HTMLCanvasElement.prototype.getContext = function () {
        return {
            drawImage: (video, ...args) => {
                h.draws.push({ video, args, width: this.width, height: this.height });
                if (h.drawError) throw h.drawError;
            },
            getImageData: () => {
                if (h.pixelError) throw h.pixelError;
                return { data: h.pixels };
            },
        };
    };
    w.HTMLCanvasElement.prototype.toBlob = (callback, type) => {
        const finish = () => callback(h.emptyBlob ? null : new w.Blob(["sample"], { type }));
        if (h.delayEncoding) h.finishEncoding = finish;
        else queueMicrotask(finish);
    };
    w.URL.createObjectURL = (blob) => {
        h.urls.push(blob);
        return "blob:https://chzzk.naver.com/example";
    };
    w.URL.revokeObjectURL = () => {};
    w.HTMLAnchorElement.prototype.click = function () {
        h.downloads.push(this.download);
        assert.equal(this.isConnected, false);
    };
    w.ClipboardItem = class {
        constructor(data) {
            this.data = data;
        }
    };
    Object.defineProperty(w.navigator, "clipboard", {
        value: {
            async write(items) {
                h.copies.push(items);
                if (h.copyDenied) throw new Error("denied");
                await items[0].data["image/png"];
            },
        },
    });
    for (const file of ["shared/settings.js", "shared/data.js", "content.js", "features/videoScreenshot.js"]) {
        w.eval(readRepoFile(file));
    }
    t.after(() => {
        w.dispatchEvent(new w.Event("pagehide"));
        w.close();
    });
    await waitForAsyncCallbacks();
    h.readyState = 4;
    h.currentSrc = "blob:original";
    h.loadFrame();
    return h;
}

test("defaults off, then a trusted press downloads only the main video's unscaled frame", async (t) => {
    const h = await fixture(t);
    assert.equal(h.button(), null);
    await h.options({ videoScreenshotEnabled: true });
    assert.equal(h.doc.querySelector("[data-bcmv-video] button"), null);
    assert.equal(h.doc.querySelector("aside button"), null);
    h.click();
    assert.match(h.status(), /새로고침/);
    assert.deepEqual(h.draws, []);
    h.currentSrc = "blob:next";
    h.loadFrame();
    h.button().click();
    assert.deepEqual(h.draws, []);
    h.click();
    await waitForCondition(() => h.downloads.length);
    assert.deepEqual(h.draws, [{ video: h.video, args: [0, 0], width: 1920, height: 1080 }]);
    assert.deepEqual(h.downloads, ["2026-11-28 오늘_방송 - 테스트 (00-23-45).png"]);
    assert.equal(h.urls[0].type, "image/png");
    assert.equal(h.copies.length, 0);
    assert.deepEqual(h.chrome.testState.permissionRequests, []);
    assert.deepEqual(h.chrome.testState.runtimeMessages, []);
    await h.options({ videoScreenshotEnabled: false });
    assert.equal(h.button(), null);
});

test("VOD metadata uses the video number and a clipboard denial leaves the requested file download intact", async (t) => {
    const h = await fixture(t, { videoScreenshotEnabled: true, videoScreenshotAction: "both" }, "/video/123");
    h.copyDenied = true;
    h.click();
    await waitForCondition(() => h.status().includes("차단"));
    assert.deepEqual(h.downloads, ["2026-11-28 지난 방송 - 테스트 (00-23-45).png"]);
    assert.match(h.status(), /다운로드 요청/);
    assert.equal(h.copies.length, 1);
    assert.deepEqual(h.requests, ["https://api.chzzk.naver.com/service/v2/videos/123"]);
});

test("clipboard-only submits during the click and does not download or look up metadata", async (t) => {
    const h = await fixture(t, { videoScreenshotEnabled: true, videoScreenshotAction: "clipboard" });
    h.delayEncoding = true;
    h.click();
    assert.equal(h.copies.length, 1);
    assert.equal(h.status(), "");
    h.finishEncoding();
    await waitForCondition(() => h.status().includes("복사했습니다"));
    h.copyDenied = true;
    h.delayEncoding = false;
    h.click();
    await waitForCondition(() => h.status().includes("차단"));
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.downloads, []);
});

test("ad, DRM, unavailable video, tainted canvas, transparent or black frame and encoding failure each stop export", async (t) => {
    const h = await fixture(t, { videoScreenshotEnabled: true });
    h.video.parentElement.classList.add("pzp-pc--adbreak");
    h.click();
    assert.match(h.status(), /광고/);
    h.video.parentElement.classList.remove("pzp-pc--adbreak");
    h.keys = {};
    h.click();
    assert.match(h.status(), /보호/);
    h.keys = null;
    h.readyState = 1;
    h.click();
    assert.match(h.status(), /준비/);
    h.readyState = 4;
    h.width = 0;
    h.click();
    assert.match(h.status(), /준비/);
    assert.deepEqual(h.draws, []);
    h.width = 1920;
    for (const property of ["pixelError", "drawError"]) {
        h[property] = new h.w.DOMException("origin", "SecurityError");
        h.click();
        assert.match(h.status(), /보안 정책/);
        h[property] = null;
    }
    for (const rgba of [
        [0, 0, 0, 255],
        [87, 12, 10, 0],
    ]) {
        h.pixels = rgba;
        h.click();
        assert.match(h.status(), /프레임/);
    }
    h.pixels = [255, 64, 16, 255];
    h.emptyBlob = true;
    h.click();
    await waitForCondition(() => h.status().includes("PNG로 만들 수 없"));
    assert.deepEqual(h.downloads, []);
    assert.deepEqual(h.copies, []);
    assert.deepEqual(h.requests, []);
});

test("route change invalidates a pending filename and blocks the previous connected frame until the source changes", async (t) => {
    const h = await fixture(t, { videoScreenshotEnabled: true });
    let finish;
    h.pendingResponse = new Promise((resolve) => {
        finish = resolve;
    });
    h.click();
    await waitForCondition(() => h.requests.length);
    h.w.history.pushState({}, "", "/live/another");
    h.w.dispatchEvent(new h.w.Event("popstate"));
    finish();
    await waitForAsyncCallbacks();
    assert.deepEqual(h.downloads, []);
    h.click();
    assert.match(h.status(), /새로고침/);
    assert.equal(h.draws.length, 1);
    h.currentSrc = "blob:new";
    h.media("loadeddata");
    h.click();
    assert.equal(h.draws.length, 1, "loadeddata alone cannot stamp the old load as the new route");
    h.loadFrame();
    h.click();
    await waitForCondition(() => h.downloads.length);
    assert.match(h.downloads[0], /라이브 another - 스트리머 정보 없음/);
    assert.match(h.requests[1], /channels\/another\/live-detail/);
});

test("turning the option off and pagehide cancel delayed PNG encoding", async (t) => {
    const h = await fixture(t, { videoScreenshotEnabled: true, videoScreenshotAction: "both" });
    h.delayEncoding = true;
    h.click();
    await h.options({ videoScreenshotEnabled: false });
    h.finishEncoding();
    await waitForAsyncCallbacks();
    await h.options({ videoScreenshotEnabled: true });
    h.loadFrame();
    h.click();
    h.w.dispatchEvent(new h.w.Event("pagehide"));
    assert.equal(h.button(), null);
    h.finishEncoding();
    await waitForAsyncCallbacks();
    assert.deepEqual(h.downloads, []);
    assert.deepEqual(h.requests, []);
    h.w.dispatchEvent(new h.w.Event("pageshow"));
    assert.ok(h.button());
});

test("chat-only and nested paths cannot mount the screenshot control", async (t) => {
    const h = await fixture(t, { videoScreenshotEnabled: true }, "/live/current/chat");
    assert.equal(h.button(), null);
    h.w.history.pushState({}, "", "/video/123/comments");
    h.w.dispatchEvent(new h.w.Event("popstate"));
    assert.equal(h.button(), null);
    h.w.history.pushState({}, "", "/live/current/simple");
    h.w.dispatchEvent(new h.w.Event("popstate"));
    assert.ok(h.button());
    h.currentSrc = "blob:simple-main";
    h.loadFrame();
    h.w.history.pushState({}, "", "/live/current/");
    h.w.dispatchEvent(new h.w.Event("popstate"));
    h.click();
    await waitForCondition(() => h.downloads.length);
    assert.equal(h.downloads.length, 1);
});

test("re-enabling on route B rejects A's drawable source and an unverified replacement until B loads a frame", async (t) => {
    const h = await fixture(t, { videoScreenshotEnabled: true });
    h.w.history.pushState({}, "", "/live/another");
    h.w.dispatchEvent(new h.w.Event("popstate"));
    await h.options({ videoScreenshotEnabled: false });
    await h.options({ videoScreenshotEnabled: true });

    h.click();
    assert.match(h.status(), /새로고침/);
    h.loadFrame();
    h.click();
    assert.deepEqual(h.draws, [], "the same source on the same element belonged to A before the option toggled");
    h.currentSrc = "blob:another";
    h.video.dispatchEvent(new h.w.Event("loadstart"));
    h.media("loadeddata");
    h.click();
    assert.deepEqual(h.draws, [], "a synthetic loadstart cannot identify a new source");
    h.media("loadstart");
    h.click();
    assert.deepEqual(h.draws, [], "changing the URL or starting a load does not establish a decoded frame");
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.downloads, []);
    assert.deepEqual(h.copies, []);
    h.media("loadeddata");
    h.click();
    await waitForCondition(() => h.downloads.length);
    assert.equal(h.draws[0].video, h.video);
    assert.match(h.downloads[0], /라이브 another/);
});

test("only the unique native player, main video and its own controls can host the button", async (t) => {
    const h = await fixture(t, { videoScreenshotEnabled: true });
    const native = h.doc.querySelector("main");
    const outside = h.doc.querySelector("aside video");
    outside.getBoundingClientRect = () => ({ width: 3840, height: 2160 });
    assert.equal(h.w.CheeseSpanner.utils.getMainVideoElement(), outside);
    assert.ok(native.contains(h.button()));
    native.querySelector(".pzp-pc").classList.add("pzp-pc--adbreak");
    h.click();
    assert.match(h.status(), /광고/);
    native.querySelector(".pzp-pc").classList.remove("pzp-pc--adbreak");
    h.click();
    await waitForCondition(() => h.downloads.length);
    assert.equal(h.draws[0].video, h.video);

    const duplicate = native.cloneNode(true);
    duplicate.querySelector("button").remove();
    native.after(duplicate);
    h.click();
    assert.equal(h.button(), null, "ambiguous native hosts release the control immediately");
    native.remove();
    duplicate.remove();
    await waitForAsyncCallbacks();
    assert.equal(h.doc.querySelector("aside button"), null, "an unrelated PZP cannot replace the missing native host");
    assert.equal(h.draws.length, 1);
});

test("first enabling on B cannot claim A's already drawable source even if that same source reloads", async (t) => {
    const h = await fixture(t);
    h.w.history.pushState({}, "", "/live/another");
    h.w.dispatchEvent(new h.w.Event("popstate"));
    await h.options({ videoScreenshotEnabled: true });
    h.loadFrame();
    h.click();
    assert.match(h.status(), /새로고침/);
    assert.deepEqual(h.draws, []);
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.downloads, []);
    assert.deepEqual(h.copies, []);
    h.currentSrc = "blob:new-b-source";
    h.loadFrame();
    h.click();
    await waitForCondition(() => h.downloads.length);
    assert.equal(h.draws[0].video, h.video);
    assert.match(h.downloads[0], /라이브 another/);
});

test("replacing the native element on B rejects A's blob and saves only B's newly decoded native frame", async (t) => {
    const h = await fixture(t, { videoScreenshotEnabled: true });
    h.w.history.pushState({}, "", "/live/another");
    h.w.dispatchEvent(new h.w.Event("popstate"));
    const old = h.video;
    h.replaceMain();
    h.loadFrame();
    h.click(); // The old control observes the replaced native element and remounts.
    h.click();
    assert.match(h.status(), /새로고침/);
    assert.deepEqual(h.draws, []);
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.downloads, []);
    h.currentSrc = "blob:new-native";
    h.loadFrame();
    h.click();
    await waitForCondition(() => h.downloads.length);
    assert.notEqual(h.video, old);
    assert.equal(h.draws[0].video, h.video);
    assert.match(h.downloads[0], /라이브 another/);
});

test("a replacement video on B rejects A's reattached stream object, then saves B's fresh stream", async (t) => {
    const h = await fixture(t, { videoScreenshotEnabled: true, videoScreenshotAction: "both" });
    h.currentSrc = "";
    const streamA = {};
    h.video.srcObject = streamA;
    h.loadFrame();
    h.w.history.pushState({}, "", "/live/another");
    h.w.dispatchEvent(new h.w.Event("popstate"));
    h.replaceMain();
    h.video.srcObject = streamA;
    h.loadFrame();
    h.click(); // Rebind the old control to the replacement player.
    h.click();
    assert.deepEqual(h.draws, []);
    assert.match(h.status(), /새로고침/);
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.downloads, []);
    assert.deepEqual(h.copies, []);

    h.video.srcObject = {};
    h.loadFrame();
    h.click();
    await waitForCondition(() => h.downloads.length);
    assert.equal(h.draws[0].video, h.video);
    assert.equal(h.copies.length, 1);
    assert.match(h.downloads[0], /라이브 another/);
});

test("after several native sources on A the replacement on B refuses even A's earliest URL", async (t) => {
    const h = await fixture(t, { videoScreenshotEnabled: true, videoScreenshotAction: "both" });
    const urls = ["blob:original", "blob:a-quality-two", "blob:a-quality-three"];
    for (const src of urls.slice(1)) {
        h.currentSrc = src;
        h.loadFrame();
    }
    h.w.history.pushState({}, "", "/live/another");
    h.w.dispatchEvent(new h.w.Event("popstate"));
    h.replaceMain();
    for (const [index, src] of urls.entries()) {
        h.currentSrc = src;
        h.loadFrame();
        if (index === 0) h.click(); // Remount the control on the replacement video.
        h.click();
        assert.deepEqual(h.draws, [], src);
        assert.match(h.status(), /새로고침/);
    }
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.copies, []);
    assert.deepEqual(h.downloads, []);
    h.currentSrc = "blob:b-fresh";
    h.loadFrame();
    h.click();
    await waitForCondition(() => h.downloads.length);
    assert.equal(h.draws[0].video, h.video);
    assert.match(h.downloads[0], /라이브 another/);
});

test("a full document URL table rejects new sources without forgetting an older broadcast until reload", async (t) => {
    const h = await fixture(t, { videoScreenshotEnabled: true });
    // Together with the initial URL, these 31 source changes reach the document limit of 32.
    for (let i = 1; i <= 31; i++) {
        h.currentSrc = `blob:a-${i}`;
        h.loadFrame();
    }
    h.click();
    await waitForCondition(() => h.downloads.length);
    h.currentSrc = "blob:untracked-a";
    h.loadFrame();
    h.click();
    assert.equal(h.draws.length, 1);
    assert.match(h.status(), /한도.*새로고침/);

    h.w.history.pushState({}, "", "/live/another");
    h.w.dispatchEvent(new h.w.Event("popstate"));
    await h.options({ videoScreenshotEnabled: false });
    await h.options({ videoScreenshotEnabled: true });
    for (const src of ["blob:original", "blob:untracked-a", "blob:new-b"]) {
        h.currentSrc = src;
        h.loadFrame();
        h.click();
        assert.equal(h.draws.length, 1, src);
        assert.match(h.status(), /새로고침/);
    }
    assert.equal(h.requests.length, 1);
    assert.equal(h.downloads.length, 1);
    assert.equal(h.copies.length, 0);
    const fresh = await fixture(t, { videoScreenshotEnabled: true }, "/live/another");
    fresh.currentSrc = "blob:new-b";
    fresh.loadFrame();
    fresh.click();
    await waitForCondition(() => fresh.downloads.length);
    assert.match(fresh.downloads[0], /라이브 another/);
});
