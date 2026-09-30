const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const {
    createFakeChrome,
    evalFeatureModules,
    evalRepoScript,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

const STORAGE_KEYS = {
    sidebar: "betterchzzk:panel-resize:sidebar-width:v1",
    chat: "betterchzzk:panel-resize:chat-width:v1",
};
const storedWidths = (sidebar = null, chat = null) => ({ [STORAGE_KEYS.sidebar]: sidebar, [STORAGE_KEYS.chat]: chat });
const localStore = (data = {}) => ({ data: { ...data }, calls: [], clients: new Set() });

// Measured flex relationships: docs/measurements/panel-resize-2026-09-28.md.
async function fixture(
    t,
    {
        route = "/live/test",
        stored,
        sidebar = true,
        chat = true,
        storageFails = false,
        delayedOptions = false,
        delayedRead = false,
        delayedWrite = false,
        localAvailable = true,
        sharedLocal,
        legacyStored,
    } = {}
) {
    const dom = new JSDOM(
        `<body><div id="layout"><header id="header"><button aria-controls="navigation" aria-expanded="true"></button></header>
    ${sidebar ? '<aside id="sidebar" style="position:fixed;width:240px;transform:translateY(111px);height:calc(100vh - 111px)"><div><a href="/lives">목록</a></div></aside>' : ""}
    <div id="layout-body" style="padding-left:${sidebar ? 240 : 0}px;padding-top:51px"><div id="player-row" style="display:flex;flex-direction:row"><main style="flex:1 1 0%;min-width:0"><video src="/native.mp4"></video></main>
    ${chat ? `<aside id="${route.startsWith("/video/") ? "vod-aside" : "aside-chatting"}" style="position:relative;width:353px;flex:0 0 auto;overflow:hidden;margin-bottom:-85px"><div id="messages"></div><textarea></textarea></aside>` : ""}
    </div></div></div></body>`,
        { url: `https://chzzk.naver.com${route}`, runScripts: "outside-only", pretendToBeVisual: true }
    );
    const win = dom.window,
        doc = win.document,
        frames = new Map(),
        resizes = new Set(),
        writes = [],
        cleanups = [];
    let frameId = 0,
        viewport = 1280,
        optionsChanged;
    Object.defineProperty(win, "innerWidth", { get: () => viewport });
    Object.defineProperty(doc.documentElement, "clientWidth", { get: () => viewport - 12 });
    win.requestAnimationFrame = (fn) => {
        frames.set(++frameId, fn);
        return frameId;
    };
    win.cancelAnimationFrame = (id) => frames.delete(id);
    win.ResizeObserver = class {
        constructor(callback) {
            this.callback = callback;
            this.nodes = new Set();
            resizes.add(this);
        }
        observe(node) {
            if (this.nodes.has(node)) return;
            this.nodes.add(node);
            // Native observers deliver an initial size, including after disconnect/reobserve.
            queueMicrotask(() => {
                if (this.nodes.has(node)) this.callback([{ target: node }]);
            });
        }
        disconnect() {
            this.nodes.clear();
        }
    };
    const width = (node, fallback) => Number.parseFloat(node?.style.getPropertyValue("--bcpr-width")) || fallback;
    const rect = (left, w, top = 60, h = 700) => ({
        left,
        right: left + w,
        x: left,
        top,
        bottom: top + h,
        y: top,
        width: w,
        height: h,
    });
    const sbWidth = () =>
        width(doc.getElementById("sidebar"), Number.parseFloat(doc.getElementById("sidebar")?.style.width) || 0);
    const bodySpace = () =>
        width(
            doc.getElementById("layout-body"),
            Number.parseFloat(doc.getElementById("layout-body")?.style.paddingLeft) || 0
        );
    function bindRects() {
        doc.getElementById("layout-body").getBoundingClientRect = () => rect(0, viewport - 12);
        for (const node of doc.querySelectorAll(
            "#sidebar, #aside-chatting, #vod-aside, #betterchzzk-vod-comment-aside"
        )) {
            node.getBoundingClientRect = () => {
                if (node.style.display === "none" || node.hidden) return rect(0, 0, 0, 0);
                const w = node.id === "sidebar" ? sbWidth() : width(node, Number.parseFloat(node.style.width) || 353);
                return rect(node.id === "sidebar" ? 0 : viewport - 12 - w, w);
            };
        }
        doc.getElementById("player-row").getBoundingClientRect = () => rect(bodySpace(), viewport - 12 - bodySpace());
        doc.querySelector("main").getBoundingClientRect = () => {
            const aside = doc.querySelector("#aside-chatting, #vod-aside, #betterchzzk-vod-comment-aside");
            return rect(
                bodySpace(),
                viewport -
                    12 -
                    bodySpace() -
                    (aside?.style.display === "none" ? 0 : width(aside, Number.parseFloat(aside?.style.width) || 0))
            );
        };
    }
    bindRects();
    const proto = win.Storage.prototype,
        originalSet = proto.setItem,
        originalGet = proto.getItem,
        originalRemove = proto.removeItem,
        sessionAccess = [],
        storageFailures = { read: storageFails, write: storageFails },
        pendingReads = [],
        pendingWrites = [],
        store = sharedLocal || localStore(stored ? storedWidths(stored.sidebarWidthPx, stored.chatWidthPx) : {});
    if (legacyStored) originalSet.call(win.sessionStorage, "betterchzzk:panel-resize:v1", JSON.stringify(legacyStored));
    for (const [name, original] of [
        ["getItem", originalGet],
        ["setItem", originalSet],
        ["removeItem", originalRemove],
    ]) {
        proto[name] = function (key, ...args) {
            if (key === "betterchzzk:panel-resize:v1") sessionAccess.push(name);
            return original.call(this, key, ...args);
        };
    }
    win.chrome = createFakeChrome();
    const notifyStorage = (changes) => {
        for (const listener of win.chrome.testState.storageChangeListeners) listener(changes, "local");
    };
    store.clients.add(notifyStorage);
    cleanups.push(() => store.clients.delete(notifyStorage));
    const complete = (callback, data, failed) => {
        if (failed) win.chrome.runtime.lastError = { message: "storage denied" };
        try {
            callback(data);
        } finally {
            delete win.chrome.runtime.lastError;
        }
    };
    const local = {
        get(keys, callback) {
            const snapshot = Object.fromEntries(
                keys.filter((key) => Object.hasOwn(store.data, key)).map((key) => [key, store.data[key]])
            );
            store.calls.push({ type: "get", keys: [...keys] });
            const failed = storageFailures.read;
            const finish = () => complete(callback, snapshot, failed);
            if (delayedRead) pendingReads.push(finish);
            else finish();
        },
        set(values, callback) {
            const next = JSON.parse(JSON.stringify(values)),
                failed = storageFailures.write;
            writes.push(next);
            store.calls.push({ type: "set", values: next });
            if (!failed) {
                const changes = Object.fromEntries(
                    Object.entries(next).map(([key, newValue]) => [key, { oldValue: store.data[key], newValue }])
                );
                Object.assign(store.data, next);
                for (const notify of store.clients) notify(changes);
            }
            const finish = () => complete(callback, undefined, failed);
            if (delayedWrite) pendingWrites.push(finish);
            else finish();
        },
    };
    if (localAvailable) win.chrome.storage.local = local;
    else delete win.chrome.storage.local;
    for (const file of [
        "shared/settings.js",
        "shared/data.js",
        "features/routeBridgePage.js",
        "content.js",
        "features/panelResizeModel.js",
    ])
        evalRepoScript(dom, file);
    win.BetterChzzk.utils.bindFeatureOptions = (apply) => {
        optionsChanged = apply;
        if (!delayedOptions) apply({ sidebarResizeEnabled: true, chatResizeEnabled: true });
        return () => {};
    };
    t.after(() => {
        for (const cleanup of cleanups) cleanup();
        win.BetterChzzk.panelResize?.stop();
        win.close();
    });
    evalRepoScript(dom, "features/panelResize.js");
    async function flush() {
        for (let i = 0; i < 8; i++) {
            await new Promise((resolve) => setImmediate(resolve));
            const pending = [...frames.values()];
            frames.clear();
            for (const fn of pending) fn(1000);
            if (!pending.length) break;
        }
        assert.equal(frames.size, 0, "DOM scheduling must settle");
    }
    const handle = (panel) => doc.querySelector(`[data-bcpr-handle="${panel}"]`);
    function pointer(target, type, x, extra = {}) {
        const ev = new win.MouseEvent(type, { clientX: x, button: 0, bubbles: true, cancelable: true, ...extra });
        Object.defineProperties(ev, {
            pointerId: { value: extra.pointerId ?? 1 },
            isPrimary: { value: extra.isPrimary ?? true },
            pointerType: { value: extra.pointerType ?? "mouse" },
        });
        target.dispatchEvent(ev);
        return ev;
    }
    function key(panel, value, extra = {}) {
        const event = new win.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...extra });
        handle(panel).dispatchEvent(event);
        return event;
    }
    function drag(panel, delta, extra = {}) {
        const start = 600,
            end = start + delta * (panel === "sidebar" ? 1 : -1);
        pointer(handle(panel), "pointerdown", start, extra);
        pointer(win, "pointermove", end, extra);
        pointer(win, "pointerup", end, extra);
    }
    function reset(panel, extra = {}) {
        for (let detail = 1; detail <= 2; detail++) {
            pointer(handle(panel), "pointerdown", 600, extra);
            pointer(win, "pointerup", 600, extra);
            handle(panel).dispatchEvent(
                new win.MouseEvent("click", { button: 0, detail, bubbles: true, cancelable: true })
            );
        }
        handle(panel).dispatchEvent(new win.MouseEvent("dblclick", { button: 0, bubbles: true, cancelable: true }));
    }
    await flush();
    return {
        dom,
        win,
        doc,
        frames,
        writes,
        cleanups,
        storageFailures,
        store,
        sessionAccess,
        pendingWrites,
        finishRead: () => {
            for (const finish of pendingReads.splice(0)) finish();
        },
        finishWrites: (reverse = false) => {
            const pending = pendingWrites.splice(0);
            for (const finish of reverse ? pending.reverse() : pending) finish();
        },
        restoreLocalApi: () => {
            win.chrome.storage.local = local;
        },
        setStored: (value) => Object.assign(store.data, storedWidths(value.sidebarWidthPx, value.chatWidthPx)),
        resizes,
        flush,
        bindRects,
        handle,
        pointer,
        key,
        drag,
        reset,
        width,
        options: (values) => optionsChanged({ sidebarResizeEnabled: true, chatResizeEnabled: true, ...values }),
        resize: (value) => {
            viewport = value;
            win.dispatchEvent(new win.Event("resize"));
        },
    };
}

test("default boundaries preserve native styles, media and input; mouse drag and double click affect only one panel", async (t) => {
    const f = await fixture(t),
        sb = f.doc.getElementById("sidebar"),
        body = f.doc.getElementById("layout-body"),
        chat = f.doc.getElementById("aside-chatting"),
        video = f.doc.querySelector("video");
    const original = [sb.style.cssText, body.style.cssText, chat.style.cssText],
        parent = video.parentElement;
    assert.equal(f.doc.querySelectorAll('[role="separator"]').length, 2);
    assert.equal(f.handle("chat").getAttribute("aria-orientation"), "vertical");
    assert.equal(f.handle("chat").getAttribute("aria-valuenow"), "353");
    assert.equal(f.handle("sidebar").tabIndex, -1);
    assert.deepEqual([sb.style.cssText, body.style.cssText, chat.style.cssText], original);
    f.drag("sidebar", 10);
    f.drag("chat", 1);
    await f.flush();
    assert.equal(f.width(sb), 250);
    assert.equal(f.width(body), 250);
    assert.equal(f.width(chat), 354);
    assert.equal(f.writes.length, 2);
    f.reset("sidebar");
    await f.flush();
    assert.equal(sb.style.cssText, original[0]);
    assert.equal(body.style.cssText, original[1]);
    assert.equal(f.width(chat), 354);
    f.reset("chat");
    await f.flush();
    assert.equal(chat.style.cssText, original[2]);
    assert.equal(video.parentElement, parent);
    assert.equal(video.getAttribute("src"), "/native.mp4");
    assert.equal(video.currentTime, 0);
    assert.equal(video.playbackRate, 1);
    assert.equal(video.paused, true);
    let input = 0;
    f.doc.querySelector("textarea").addEventListener("pointerdown", () => input++);
    f.pointer(f.doc.querySelector("textarea"), "pointerdown", 1100);
    assert.equal(input, 1);
});

async function integratedFixture(t, { free = false } = {}) {
    const mainId = "a".repeat(32),
        otherId = "b".repeat(32);
    const f = await fixture(t, { route: `/live/${mainId}` });
    const { win, doc, dom } = f;
    const input = doc.querySelector("textarea"),
        video = doc.querySelector("video"),
        messages = doc.getElementById("messages");
    const native = doc.createElement("div");
    native.className = "chzzk_player type_live";
    native.innerHTML =
        '<div class="pzp-pc pzp-pc--controls"><div class="pzp-pc__bottom-buttons--right"><button class="pzp-pc__viewmode-button" aria-label="넓은 화면">넓은 화면</button></div></div>';
    video.before(native);
    native.firstElementChild.prepend(video);
    video.className = "webplayer-internal-video";
    const header = doc.createElement("div");
    header.className = "chat-header";
    header.innerHTML =
        '<h2>채팅</h2><div class="chat-fold"><button type="button" aria-label="채팅 접기">접기</button></div><div class="chat-menu"><button type="button" aria-haspopup="true" aria-label="더보기 메뉴">⋮</button></div>';
    messages.before(header);
    messages.setAttribute("role", "log");
    messages.className = "chat-list";
    messages.innerHTML =
        '<div class="chat-row" data-chat-id="integration-message"><span class="badge" aria-label="매니저"></span><span class="nickname">안내 담당</span><span class="message">안내 메시지</span></div>';
    input.value = "작성 중인 채팅";
    input.setSelectionRange(2, 5);
    // As in the multiview fixture, JSDOM models popover ownership, not browser top-layer hit testing.
    const popovers = new Set();
    win.HTMLElement.prototype.togglePopover = function (open) {
        if (open) popovers.add(this);
        else popovers.delete(this);
        return open;
    };
    win.HTMLElement.prototype.hidePopover = function () {
        popovers.delete(this);
    };
    const mediaCalls = [];
    for (const name of ["play", "pause", "load"])
        win.HTMLMediaElement.prototype[name] = function () {
            mediaCalls.push([this, name]);
            return name === "play" ? Promise.resolve() : undefined;
        };
    const requests = [],
        subscribers = new Set();
    let options = win.BetterChzzkSettings.normalizeOptions({
        liveMultiviewEnabled: true,
        chatToolsModeratorBoxEnabled: true,
    });
    const configure = (patch) => {
        options = win.BetterChzzkSettings.normalizeOptions({ ...options, ...patch });
        for (const apply of subscribers) apply(options);
    };
    win.BetterChzzk.utils.bindFeatureOptions = (apply) => {
        subscribers.add(apply);
        apply(options);
        return () => subscribers.delete(apply);
    };
    // Secondary discovery stays pending: no decoder/network simulation is needed to test layout ownership.
    win.BetterChzzk.utils.fetchJson = (url, init) => {
        requests.push({ url, signal: init.signal });
        return new Promise(() => {});
    };
    win.sessionStorage.setItem(
        "betterChzzkMultiviewSession",
        JSON.stringify({
            version: 1,
            layoutVersion: 3,
            active: true,
            freeLayoutEnabled: free,
            freeWindowSpace: "viewport",
            freeWindows: [
                { id: mainId, rect: [0.05, 0.1, 0.5, 0.5] },
                { id: otherId, rect: [0.6, 0.15, 0.3, 0.3] },
            ],
            channels: [
                { id: mainId, volume: 0.6, muted: false },
                { id: otherId, volume: 0.3, muted: true },
            ],
            dockTree: { axis: "columns", ratio: 0.6, a: mainId, b: otherId },
            customLayout: true,
        })
    );
    f.cleanups.push(() =>
        configure({
            liveMultiviewEnabled: false,
            chatToolsModeratorBoxEnabled: false,
            chatToolsShowBlindEnabled: false,
            chatToolsRemoveWelcomeEnabled: false,
        })
    );
    evalRepoScript(dom, "shared/liveTiming.js");
    evalFeatureModules(dom, "liveMultiview");
    evalFeatureModules(dom, "chatTools");
    evalRepoScript(dom, "features/chatTools.js");
    await waitForCondition(() => {
        const callbacks = [...f.frames.values()];
        f.frames.clear();
        for (const callback of callbacks) callback(1000);
        return doc.querySelectorAll(".bcmv-cell").length === 2 && !!doc.querySelector(".bcct-moderator-row");
    });
    await f.flush();
    const host = doc.querySelector("[data-bcmv-host]");
    const notifyHostResize = async () => {
        for (const observer of f.resizes) if (observer.nodes.has(host)) observer.callback([{ target: host }]);
        await f.flush();
    };
    return { ...f, input, video, native, messages, host, popovers, mediaCalls, requests, configure, notifyHostResize };
}

test("integrated split multiview follows the resized host while native chat, moderator controls and playback stay intact", async (t) => {
    const f = await integratedFixture(t),
        { doc, win, host, video, input, messages } = f;
    const chat = doc.getElementById("aside-chatting"),
        handle = f.handle("chat"),
        box = doc.querySelector(".bcct-moderator-box"),
        trigger = doc.querySelector(".bcct-moderator-trigger");
    trigger.click();
    assert.equal(box.dataset.open, "1");
    const multiview = win.sessionStorage.getItem("betterChzzkMultiviewSession");
    const original = {
        hostWidth: host.getBoundingClientRect().width,
        height: Number(host.style.getPropertyValue("--bcmv-main-height")),
        parent: video.parentElement,
        nodes: [...doc.querySelectorAll("video")],
        message: messages.firstElementChild,
        inputParent: input.parentElement,
        media: [
            video.currentTime,
            video.playbackRate,
            video.paused,
            video.volume,
            video.muted,
            video.getAttribute("src"),
        ],
        calls: f.mediaCalls.length,
        requests: f.requests.length,
    };
    let inputDowns = 0;
    input.addEventListener("pointerdown", () => inputDowns++);
    const start = chat.getBoundingClientRect().left;
    f.pointer(handle, "pointerdown", start);
    f.pointer(win, "pointermove", start + 113);
    await f.flush();
    await f.notifyHostResize();
    f.pointer(win, "pointerup", start + 113);
    await f.flush();
    assert.ok(
        host.getBoundingClientRect().width > original.hostWidth,
        "shrinking chat returns usable space to the real multiview host"
    );
    assert.ok(
        Number(host.style.getPropertyValue("--bcmv-main-height")) > original.height,
        "the real host ResizeObserver refits the video aspect ratio"
    );
    assert.equal(
        win.sessionStorage.getItem("betterChzzkMultiviewSession"),
        multiview,
        "resizing chat does not alter multiview choices"
    );
    assert.equal(handle.parentElement, chat);
    assert.equal(host.contains(handle), false);
    assert.equal(doc.querySelectorAll('[data-bcpr-handle="chat"]').length, 1);
    assert.equal(doc.querySelector(".bcmv-drop-preview"), null);
    assert.equal(box.dataset.open, "1");
    assert.equal(chat.contains(box), true);
    assert.equal(doc.querySelector(".bcct-moderator-row").textContent.includes("안내 메시지"), true);
    f.pointer(input, "pointerdown", start + 150);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    assert.equal(inputDowns, 1);
    assert.equal(input.value, "작성 중인 채팅");
    assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 5]);
    assert.equal(input.parentElement, original.inputParent);
    assert.equal(messages.firstElementChild, original.message);
    assert.equal(video.parentElement, original.parent);
    assert.deepEqual([...doc.querySelectorAll("video")], original.nodes);
    assert.deepEqual(
        [video.currentTime, video.playbackRate, video.paused, video.volume, video.muted, video.getAttribute("src")],
        original.media
    );
    assert.equal(f.mediaCalls.length, original.calls);
    assert.equal(f.requests.length, original.requests);
    trigger.click();
    assert.equal(box.dataset.open, "0");
    trigger.click();
    assert.equal(box.dataset.open, "1");
    f.options({ chatResizeEnabled: false });
    await f.flush();
    assert.equal(f.handle("chat"), null);
    assert.equal(box.dataset.open, "1");
    assert.equal(chat.contains(box), true);
    assert.equal(video.parentElement, original.parent);
});

test("integrated free multiview keeps its windows and top-layer ownership when the sidebar is resized", async (t) => {
    const f = await integratedFixture(t, { free: true }),
        { doc, win, host, video } = f;
    assert.equal(f.popovers.has(host), true);
    const session = win.sessionStorage.getItem("betterChzzkMultiviewSession"),
        windows = [...doc.querySelectorAll(".bcmv-cell")].map((node) => [node, node.style.cssText]),
        parent = video.parentElement,
        calls = f.mediaCalls.length;
    const handle = f.handle("sidebar");
    assert.equal(host.contains(handle), false);
    assert.equal(handle.closest("[popover]"), null);
    f.drag("sidebar", 10);
    await f.flush();
    await f.notifyHostResize();
    assert.equal(f.width(doc.getElementById("sidebar")), 250);
    assert.equal(win.sessionStorage.getItem("betterChzzkMultiviewSession"), session);
    assert.deepEqual(
        [...doc.querySelectorAll(".bcmv-cell")].map((node) => [node, node.style.cssText]),
        windows
    );
    assert.equal(f.popovers.has(host), true);
    assert.equal(video.parentElement, parent);
    assert.equal(f.mediaCalls.length, calls);
    const choice = { ...f.store.data };
    f.configure({ liveMultiviewEnabled: false });
    await f.flush();
    assert.equal(f.popovers.has(host), false);
    assert.equal(f.handle("sidebar"), handle);
    assert.deepEqual(f.store.data, choice);
    assert.ok(doc.querySelector(".bcct-moderator-trigger"));
});

test("drag previews batch without writes, preserve the opposite actual width and commit once before lost capture", async (t) => {
    const f = await fixture(t, { stored: { version: 1, sidebarWidthPx: 420, chatWidthPx: 640 } }),
        sb = f.doc.getElementById("sidebar"),
        chat = f.doc.getElementById("aside-chatting");
    const other = f.width(chat),
        start = f.width(sb),
        h = f.handle("sidebar");
    h.setPointerCapture = () => {};
    h.releasePointerCapture = () => f.pointer(h, "lostpointercapture", 500);
    f.pointer(h, "pointerdown", start);
    for (let x = start - 1; x >= start - 20; x--) f.pointer(f.win, "pointermove", x);
    assert.equal(f.writes.length, 0);
    assert.equal(f.frames.size, 1);
    await f.flush();
    assert.equal(f.width(sb), start - 20);
    assert.equal(f.width(chat), other);
    f.pointer(f.win, "pointerup", start - 20);
    await f.flush();
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0], { [STORAGE_KEYS.sidebar]: start - 20 });
    assert.equal(f.store.data[STORAGE_KEYS.chat], 640);
    assert.equal(f.width(sb), start - 20);
    assert.equal(f.width(chat), other);
    f.drag("sidebar", 10);
    await f.flush();
    assert.equal(f.width(sb), start - 10);
    assert.equal(f.width(chat), other);
    for (const observer of f.resizes) if (observer.nodes.size) observer.callback([]);
    await f.flush();
    assert.equal(f.width(sb), start - 10);
    assert.equal(f.width(chat), other);
});

for (const cancel of ["pointercancel", "lostpointercapture", "blur", "route", "hide", "pagehide", "off", "replace"]) {
    test(`${cancel} cancels a preview without saving and clears the old gesture`, async (t) => {
        const f = await fixture(t),
            chat = f.doc.getElementById("aside-chatting"),
            h = f.handle("chat");
        f.pointer(h, "pointerdown", 915);
        f.pointer(f.win, "pointermove", 860);
        await f.flush();
        assert.equal(f.width(chat), 408);
        if (cancel === "route") f.win.history.pushState({}, "", "/live/other");
        else if (cancel === "hide") chat.style.display = "none";
        else if (cancel === "off") f.options({ chatResizeEnabled: false });
        else if (cancel === "replace") {
            const next = chat.cloneNode(false);
            next.removeAttribute("data-bcpr-width");
            next.style.removeProperty("--bcpr-width");
            chat.replaceWith(next);
            f.bindRects();
        } else f.pointer(cancel === "lostpointercapture" ? h : f.win, cancel, 860);
        await f.flush();
        f.pointer(f.win, "pointerup", 860);
        await f.flush();
        assert.equal(f.writes.length, 0);
        assert.equal(chat.style.getPropertyValue("--bcpr-width"), "");
    });
}

test("folding, overlay, fullscreen and options release owned CSS and restore selections", async (t) => {
    const f = await fixture(t),
        sb = f.doc.getElementById("sidebar"),
        body = f.doc.getElementById("layout-body"),
        chat = f.doc.getElementById("aside-chatting");
    f.drag("sidebar", 10);
    f.drag("chat", 10);
    await f.flush();
    sb.style.transform = "translateY(170px)";
    body.style.paddingTop = "110px";
    f.doc.querySelector('[aria-controls="navigation"]').setAttribute("aria-expanded", "false");
    sb.style.width = "82px";
    body.style.paddingLeft = "82px";
    await f.flush();
    assert.equal(f.handle("sidebar"), null);
    assert.equal(sb.style.getPropertyValue("--bcpr-width"), "");
    assert.equal(f.width(chat), 363);
    f.doc.querySelector('[aria-controls="navigation"]').setAttribute("aria-expanded", "true");
    sb.style.width = "240px";
    body.style.paddingLeft = "240px";
    await f.flush();
    assert.equal(f.width(sb), 250);
    f.resize(1199);
    body.style.paddingLeft = "82px";
    await f.flush();
    assert.equal(f.handle("sidebar"), null);
    f.resize(1280);
    body.style.paddingLeft = "240px";
    await f.flush();
    assert.equal(f.width(sb), 250);
    Object.defineProperty(f.doc, "fullscreenElement", { configurable: true, value: f.doc.querySelector("video") });
    f.doc.dispatchEvent(new f.win.Event("fullscreenchange"));
    await f.flush();
    assert.equal(f.doc.querySelectorAll('[role="separator"]').length, 0);
    Object.defineProperty(f.doc, "fullscreenElement", { configurable: true, value: null });
    f.doc.dispatchEvent(new f.win.Event("fullscreenchange"));
    await f.flush();
    assert.equal(f.width(chat), 363);
    f.options({ sidebarResizeEnabled: false, chatResizeEnabled: false });
    await f.flush();
    assert.equal(f.doc.querySelectorAll('[role="separator"]').length, 0);
    assert.equal(
        [...f.resizes].some((r) => r.nodes.size),
        false
    );
    assert.equal(sb.style.transform, "translateY(170px)");
    assert.equal(body.style.paddingTop, "110px");
    assert.equal(chat.style.marginBottom, "-85px");
    f.options({});
    await f.flush();
    assert.equal(f.width(sb), 250);
    assert.equal(f.width(chat), 363);
    assert.equal(f.writes.length, 2);
});

test("SPA comment-only replacement shares document selection; storage failures retain memory and BFCache restores it", async (t) => {
    const f = await fixture(t, { sidebar: false, storageFails: true });
    f.drag("chat", 10);
    await f.flush();
    const old = f.doc.getElementById("aside-chatting");
    old.remove();
    f.win.history.pushState({}, "", "/video/123");
    const aside = f.doc.createElement("aside");
    aside.id = "betterchzzk-vod-comment-aside";
    aside.style.cssText = "position:relative;width:353px;flex:0 0 353px;max-width:35%;min-width:280px;overflow:hidden";
    f.doc.getElementById("player-row").setAttribute("data-bcvc-comment-only-host", "1");
    f.doc.getElementById("player-row").append(aside);
    f.bindRects();
    await f.flush();
    assert.equal(f.width(aside), 363);
    assert.equal(old.style.getPropertyValue("--bcpr-width"), "");
    assert.equal(f.doc.querySelectorAll('[role="separator"]').length, 1);
    f.win.dispatchEvent(new f.win.Event("pagehide"));
    await f.flush();
    assert.equal(f.handle("chat"), null);
    f.win.dispatchEvent(new f.win.Event("pageshow"));
    await f.flush();
    assert.equal(f.width(aside), 363);
    f.handle("chat").remove();
    await f.flush();
    assert.ok(f.handle("chat"));
    assert.equal(aside.style.maxWidth, "35%");
    assert.equal(aside.parentElement.getAttribute("data-bcvc-comment-only-host"), "1");
});

test("chat rows do not rescan or loop; retired callbacks cannot remount", async (t) => {
    const f = await fixture(t);
    let reads = 0;
    const get = f.doc.getElementById.bind(f.doc);
    f.doc.getElementById = (...args) => {
        reads++;
        return get(...args);
    };
    const messages = get("messages");
    for (let i = 0; i < 100; i++) messages.append(f.doc.createElement("p"));
    await f.flush();
    assert.equal(reads, 0);
    f.pointer(f.handle("chat"), "pointerdown", 915);
    f.pointer(f.win, "pointermove", 860);
    const retired = [...f.frames.values()];
    f.options({ sidebarResizeEnabled: false, chatResizeEnabled: false });
    for (const fn of retired) fn();
    await f.flush();
    assert.equal(f.doc.querySelectorAll('[role="separator"]').length, 0);
    assert.equal(f.writes.length, 0);
});

test("secondary input and stationary clicks leave even oversized native widths untouched", async (t) => {
    const f = await fixture(t, { sidebar: false });
    const chat = f.doc.getElementById("aside-chatting"),
        h = f.handle("chat");
    chat.style.width = "800px";
    await f.flush();
    for (const extra of [{ button: 2 }, { isPrimary: false }, { pointerType: "touch" }, { pointerType: "pen" }]) {
        f.pointer(h, "pointerdown", 468, extra);
        f.pointer(f.win, "pointermove", 450);
        f.pointer(f.win, "pointerup", 450);
    }
    f.pointer(h, "pointerdown", 468);
    f.pointer(f.win, "pointerup", 468);
    h.dispatchEvent(new f.win.MouseEvent("dblclick", { button: 2, bubbles: true, cancelable: true }));
    await f.flush();
    assert.equal(chat.style.getPropertyValue("--bcpr-width"), "");
    assert.equal(f.writes.length, 0);
    assert.equal(h.getAttribute("aria-valuenow"), "800");
});

test("right drag respects min/max, guards its release click and leaves subsequent user clicks alone", async (t) => {
    const f = await fixture(t),
        h = f.handle("chat"),
        video = f.doc.querySelector("video");
    let clicks = 0;
    video.addEventListener("click", () => clicks++);
    f.pointer(h, "pointerdown", 915);
    f.pointer(f.win, "pointermove", 1800);
    f.pointer(f.win, "pointerup", 1800);
    await f.flush();
    assert.equal(f.width(f.doc.getElementById("aside-chatting")), 240);
    video.dispatchEvent(new f.win.MouseEvent("click", { clientX: 1800, detail: 1, bubbles: true }));
    assert.equal(clicks, 0);
    f.pointer(video, "pointerdown", 300);
    video.dispatchEvent(new f.win.MouseEvent("click", { clientX: 300, detail: 1, bubbles: true }));
    assert.equal(clicks, 1);
    f.pointer(h, "pointerdown", 1028);
    f.pointer(f.win, "pointermove", -1000);
    f.pointer(f.win, "pointerup", -1000);
    await f.flush();
    assert.equal(f.width(f.doc.getElementById("aside-chatting")), 640);
    assert.equal(f.writes.length, 2);
});

test("overflowing narrow native rows and stacked layouts release widths; returning restores the selection", async (t) => {
    const f = await fixture(t),
        chat = f.doc.getElementById("aside-chatting"),
        row = f.doc.getElementById("player-row");
    f.drag("chat", 10);
    await f.flush();
    const normal = row.getBoundingClientRect;
    f.resize(720);
    f.doc.getElementById("layout-body").style.paddingLeft = "82px";
    row.getBoundingClientRect = () => ({ left: 82, right: 950, width: 868, top: 60, bottom: 800, height: 740 });
    await f.flush();
    assert.equal(f.handle("chat"), null);
    assert.equal(chat.style.getPropertyValue("--bcpr-width"), "");
    row.getBoundingClientRect = normal;
    f.resize(1280);
    f.doc.getElementById("layout-body").style.paddingLeft = "240px";
    await f.flush();
    assert.equal(f.width(chat), 363);
    row.style.flexDirection = "column";
    await f.flush();
    assert.equal(f.handle("chat"), null);
    row.style.flexDirection = "row";
    await f.flush();
    assert.equal(f.width(chat), 363);
    assert.equal(f.writes.length, 1);
});

test("new documents restore local data and suspended choices return after viewport growth", async (t) => {
    const stored = { version: 1, sidebarWidthPx: 420, chatWidthPx: 640 };
    const f = await fixture(t, { stored }),
        other = await fixture(t);
    const chat = f.doc.getElementById("aside-chatting");
    assert.ok(f.width(chat) < 640);
    assert.equal(other.doc.getElementById("aside-chatting").style.getPropertyValue("--bcpr-width"), "");
    f.resize(1700);
    await f.flush();
    assert.equal(f.width(chat), 640);
    assert.equal(f.width(f.doc.getElementById("sidebar")), 420);
    assert.deepEqual(f.store.data, storedWidths(420, 640));
    assert.equal(f.writes.length, 0);
});

test("restoring a wider native sidebar still reserves the center without overwriting the right choice", async (t) => {
    const f = await fixture(t, { stored: { version: 1, sidebarWidthPx: 180, chatWidthPx: 640 } });
    f.resize(1200);
    await f.flush();
    f.reset("sidebar");
    await f.flush();
    assert.equal(f.doc.getElementById("sidebar").style.getPropertyValue("--bcpr-width"), "");
    assert.equal(f.width(f.doc.getElementById("aside-chatting")), 628);
    assert.deepEqual(f.writes[0], { [STORAGE_KEYS.sidebar]: null });
    assert.equal(f.store.data[STORAGE_KEYS.chat], 640);
});

test("async initial options never mount before stored false values are known", async (t) => {
    const f = await fixture(t, { delayedOptions: true, stored: { version: 1, sidebarWidthPx: 400, chatWidthPx: 600 } });
    assert.equal(f.doc.querySelectorAll('[role="separator"]').length, 0);
    assert.equal(f.doc.querySelectorAll("[data-bcpr-width]").length, 0);
    f.options({ sidebarResizeEnabled: false, chatResizeEnabled: false });
    await f.flush();
    assert.equal(f.doc.querySelectorAll('[role="separator"]').length, 0);
    f.options({ sidebarResizeEnabled: false });
    await f.flush();
    assert.equal(f.handle("sidebar"), null);
    assert.ok(f.handle("chat"));
    assert.equal(f.writes.length, 0);
});

test("BFCache resume keeps its document selection despite another document writing", async (t) => {
    const f = await fixture(t, { stored: { version: 1, sidebarWidthPx: 280, chatWidthPx: 400 } });
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pagehide", { persisted: true }));
    f.setStored({ version: 1, sidebarWidthPx: 310, chatWidthPx: 500 });
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pageshow", { persisted: true }));
    await f.flush();
    assert.equal(f.width(f.doc.getElementById("sidebar")), 280);
    assert.equal(f.width(f.doc.getElementById("aside-chatting")), 400);
    assert.equal(f.writes.length, 0);
});

test("BFCache keeps failed local choices and never rereads other documents", async (t) => {
    const f = await fixture(t, { stored: { version: 1, sidebarWidthPx: 280, chatWidthPx: 400 } });
    f.storageFailures.write = true;
    f.drag("sidebar", 10);
    await f.flush();
    const resume = async () => {
        f.win.dispatchEvent(new f.win.PageTransitionEvent("pagehide", { persisted: true }));
        f.win.dispatchEvent(new f.win.PageTransitionEvent("pageshow", { persisted: true }));
        await f.flush();
    };
    await resume();
    assert.equal(f.width(f.doc.getElementById("sidebar")), 290);
    f.storageFailures.read = true;
    await resume();
    assert.equal(f.width(f.doc.getElementById("sidebar")), 290);
    f.storageFailures.read = false;
    await resume();
    assert.equal(f.width(f.doc.getElementById("sidebar")), 290);
    assert.equal(f.width(f.doc.getElementById("aside-chatting")), 400);
    f.setStored({ version: 1, sidebarWidthPx: 280, chatWidthPx: 440 });
    await resume();
    assert.equal(
        f.width(f.doc.getElementById("sidebar")),
        290,
        "changing stored chat alone must not discard an unsaved sidebar choice"
    );
    assert.equal(f.width(f.doc.getElementById("aside-chatting")), 400);
    f.setStored({ version: 1, sidebarWidthPx: 320, chatWidthPx: 450 });
    await resume();
    assert.equal(f.width(f.doc.getElementById("sidebar")), 290);
    assert.equal(f.width(f.doc.getElementById("aside-chatting")), 400);
    assert.equal(f.writes.length, 1, "resume never retries failed writes");
});

test("failed initial read is not retried on BFCache resume and current memory remains authoritative", async (t) => {
    const f = await fixture(t, { storageFails: true, stored: { version: 1, sidebarWidthPx: 400, chatWidthPx: 550 } });
    f.drag("chat", 10);
    await f.flush();
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pagehide", { persisted: true }));
    f.storageFailures.read = false;
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pageshow", { persisted: true }));
    await f.flush();
    assert.equal(f.doc.getElementById("sidebar").style.getPropertyValue("--bcpr-width"), "");
    assert.equal(f.width(f.doc.getElementById("aside-chatting")), 363);
    f.setStored({ version: 1, sidebarWidthPx: 300, chatWidthPx: 430 });
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pagehide", { persisted: true }));
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pageshow", { persisted: true }));
    await f.flush();
    assert.equal(f.doc.getElementById("sidebar").style.getPropertyValue("--bcpr-width"), "");
    assert.equal(f.width(f.doc.getElementById("aside-chatting")), 363);
    assert.equal(f.writes.length, 1);
});

test("shared local widths apply only to new documents and independent panel writes preserve each other", async (t) => {
    const store = localStore(),
        a = await fixture(t, { sharedLocal: store }),
        b = await fixture(t, { sharedLocal: store });
    a.drag("sidebar", 40);
    b.drag("chat", 47);
    await a.flush();
    await b.flush();
    assert.deepEqual(store.data, storedWidths(280, 400));
    assert.equal(a.doc.getElementById("aside-chatting").style.getPropertyValue("--bcpr-width"), "");
    assert.equal(b.doc.getElementById("sidebar").style.getPropertyValue("--bcpr-width"), "");
    const fresh = await fixture(t, { sharedLocal: store });
    assert.equal(fresh.width(fresh.doc.getElementById("sidebar")), 280);
    assert.equal(fresh.width(fresh.doc.getElementById("aside-chatting")), 400);
    assert.equal(fresh.writes.length, 0);
    a.options({ sidebarResizeEnabled: false, chatResizeEnabled: false });
    a.win.history.pushState({}, "", "/live/other");
    a.options({});
    await a.flush();
    assert.equal(a.width(a.doc.getElementById("sidebar")), 280);
    assert.equal(a.doc.getElementById("aside-chatting").style.getPropertyValue("--bcpr-width"), "");
    assert.equal(store.calls.filter((call) => call.type === "get").length, 3);
    b.reset("sidebar");
    await b.flush();
    assert.deepEqual(
        store.data,
        storedWidths(null, 400),
        "an explicit reset wins even in a document already at native width"
    );
    assert.equal(a.width(a.doc.getElementById("sidebar")), 280);
    const reloaded = await fixture(t, { sharedLocal: store });
    assert.equal(reloaded.doc.getElementById("sidebar").style.getPropertyValue("--bcpr-width"), "");
    assert.equal(reloaded.width(reloaded.doc.getElementById("aside-chatting")), 400);
});

test("same-panel writes issue in gesture order and stale success or failure callbacks cannot change the latest choice", async (t) => {
    const store = localStore(),
        a = await fixture(t, { sharedLocal: store, delayedWrite: true }),
        b = await fixture(t, { sharedLocal: store, delayedWrite: true });
    a.storageFailures.write = true;
    a.drag("chat", 10);
    a.storageFailures.write = false;
    a.drag("chat", 10);
    b.drag("chat", 47);
    a.drag("chat", 10);
    assert.deepEqual(
        store.calls.filter((call) => call.type === "set").map((call) => call.values),
        [
            { [STORAGE_KEYS.chat]: 363 },
            { [STORAGE_KEYS.chat]: 373 },
            { [STORAGE_KEYS.chat]: 400 },
            { [STORAGE_KEYS.chat]: 383 },
        ]
    );
    a.finishWrites(true);
    b.finishWrites();
    await a.flush();
    await b.flush();
    assert.equal(a.width(a.doc.getElementById("aside-chatting")), 383);
    assert.equal(b.width(b.doc.getElementById("aside-chatting")), 400);
    assert.equal(store.data[STORAGE_KEYS.chat], 383);
    a.options({ sidebarResizeEnabled: false, chatResizeEnabled: false });
    b.win.dispatchEvent(new b.win.Event("pagehide"));
    await a.flush();
    await b.flush();
    assert.equal(a.writes.length, 3, "older failures are never automatically retried");
    const fresh = await fixture(t, { sharedLocal: store });
    assert.equal(fresh.width(fresh.doc.getElementById("aside-chatting")), 383);
});

test("local read and options must both finish before mounting; late reads respect OFF and pagehide", async (t) => {
    for (const hide of ["off", "pagehide"]) {
        const f = await fixture(t, {
            delayedRead: true,
            delayedOptions: true,
            stored: { sidebarWidthPx: 280, chatWidthPx: 400 },
        });
        f.options({});
        assert.equal(f.handle("chat"), null);
        assert.equal(f.doc.querySelectorAll("[data-bcpr-width]").length, 0);
        if (hide === "off") f.options({ sidebarResizeEnabled: false, chatResizeEnabled: false });
        else f.win.dispatchEvent(new f.win.Event("pagehide"));
        f.finishRead();
        await f.flush();
        assert.equal(f.handle("chat"), null);
        assert.equal(f.doc.querySelectorAll("[data-bcpr-width]").length, 0);
        if (hide === "off") f.options({});
        else f.win.dispatchEvent(new f.win.PageTransitionEvent("pageshow", { persisted: true }));
        await f.flush();
        assert.equal(f.width(f.doc.getElementById("aside-chatting")), 400);
        assert.equal(f.writes.length, 0);
    }
});

test("old session values are untouched; malformed local values fall back independently without writes", async (t) => {
    for (const value of [undefined, null, "400", 0, -1, 8193, 10.5, true, [], {}]) {
        const store = localStore({ [STORAGE_KEYS.sidebar]: 280, [STORAGE_KEYS.chat]: value });
        const f = await fixture(t, {
            sharedLocal: store,
            legacyStored: { version: 1, sidebarWidthPx: 420, chatWidthPx: 600 },
        });
        assert.equal(f.width(f.doc.getElementById("sidebar")), 280);
        assert.equal(f.doc.getElementById("aside-chatting").style.getPropertyValue("--bcpr-width"), "");
        assert.equal(f.writes.length, 0);
        assert.deepEqual(f.sessionAccess, []);
    }
    const empty = await fixture(t, { legacyStored: { version: 1, sidebarWidthPx: 420, chatWidthPx: 600 } });
    assert.equal(empty.doc.querySelectorAll("[data-bcpr-width]").length, 0);
    empty.drag("chat", 10);
    empty.reset("chat");
    await empty.flush();
    assert.deepEqual(empty.sessionAccess, []);
});

test("failed writes and unavailable API retain memory, permit same-value retry and never auto-save", async (t) => {
    for (const unavailable of [false, true]) {
        const f = await fixture(t, { localAvailable: !unavailable });
        f.storageFailures.write = true;
        f.drag("chat", 10);
        await f.flush();
        assert.equal(f.width(f.doc.getElementById("aside-chatting")), 363);
        assert.deepEqual(f.store.data, {});
        f.storageFailures.write = false;
        if (unavailable) f.restoreLocalApi();
        f.options({ chatResizeEnabled: false });
        f.options({});
        await f.flush();
        assert.deepEqual(f.store.data, {}, "restoring storage and UI does not retry automatically");
        f.pointer(f.handle("chat"), "pointerdown", 600);
        f.pointer(f.win, "pointermove", 590);
        await f.flush();
        f.pointer(f.win, "pointermove", 600);
        f.pointer(f.win, "pointerup", 600);
        await f.flush();
        assert.equal(
            f.store.data[STORAGE_KEYS.chat],
            363,
            "a real drag back to the failed choice can explicitly retry it"
        );
        f.storageFailures.write = true;
        f.reset("chat");
        await f.flush();
        assert.equal(f.doc.getElementById("aside-chatting").style.getPropertyValue("--bcpr-width"), "");
        assert.equal(f.store.data[STORAGE_KEYS.chat], 363);
        f.storageFailures.write = false;
        f.reset("chat");
        await f.flush();
        assert.equal(f.store.data[STORAGE_KEYS.chat], null);
    }
});

test("late write callbacks after OFF or pagehide never restore UI or overwrite newer reset", async (t) => {
    for (const hide of ["off", "pagehide"]) {
        const f = await fixture(t, { delayedWrite: true });
        f.drag("chat", 10);
        f.reset("chat");
        if (hide === "off") f.options({ sidebarResizeEnabled: false, chatResizeEnabled: false });
        else f.win.dispatchEvent(new f.win.Event("pagehide"));
        f.finishWrites(true);
        await f.flush();
        assert.equal(f.doc.querySelectorAll("[data-bcpr-handle]").length, 0);
        assert.equal(f.doc.querySelectorAll("[data-bcpr-width]").length, 0);
        assert.equal(f.store.data[STORAGE_KEYS.chat], null);
        assert.equal(f.writes.length, 2);
    }
});

test("keyboard events remain untouched and mouse dragging preserves input focus with one hover or drag line", async (t) => {
    const f = await fixture(t),
        h = f.handle("chat"),
        chat = f.doc.getElementById("aside-chatting"),
        input = f.doc.querySelector("textarea");
    input.focus();
    let propagated = 0;
    f.win.addEventListener("keydown", () => propagated++);
    const keys = ["ArrowLeft", "ArrowRight", "Shift", "Enter", "Escape"];
    for (const key of keys) assert.equal(f.key("chat", key, { shiftKey: true }).defaultPrevented, false);
    assert.equal(propagated, keys.length);
    assert.equal(f.writes.length, 0);
    assert.equal(chat.style.getPropertyValue("--bcpr-width"), "");
    assert.equal(h.tabIndex, -1);
    assert.equal(h.getAttribute("aria-controls"), chat.id);
    assert.equal(h.getAttribute("aria-label"), "채팅·댓글 너비 조절");
    assert.equal(h.title, "마우스로 드래그해 너비 조절 · 더블클릭으로 기본 너비");
    f.pointer(h, "pointerdown", 600, { shiftKey: true });
    f.pointer(f.win, "pointermove", 580, { shiftKey: true });
    await f.flush();
    assert.equal(f.doc.activeElement, input);
    assert.equal(f.width(chat), 373);
    for (const key of keys) assert.equal(f.key("chat", key, { shiftKey: true }).defaultPrevented, false);
    assert.equal(propagated, keys.length * 2);
    assert.equal(f.width(chat), 373, "Escape and arrows do not cancel or change a mouse preview");
    assert.equal(h.hasAttribute("data-bcpr-dragging"), true);
    f.pointer(f.win, "pointerup", 580);
    await f.flush();
    assert.equal(f.writes.length, 1);
    assert.equal(f.doc.activeElement, input);
    assert.equal(h.hasAttribute("data-bcpr-dragging"), false);
    const rules = [...f.doc.getElementById("betterchzzk-panel-resize-style").sheet.cssRules];
    const base = rules.find((rule) => rule.selectorText === "[data-bcpr-handle]");
    assert.equal(base.style.getPropertyValue("width"), "8px");
    assert.equal(base.style.getPropertyValue("background"), "transparent");
    assert.equal(base.style.getPropertyValue("outline"), "none");
    assert.equal(base.style.getPropertyValue("border"), "0px");
    assert.equal(base.style.getPropertyValue("box-shadow"), "none");
    // Keep the 8px hit area inside each panel, with the visible guide at its edge.
    assert.equal(f.win.getComputedStyle(f.handle("sidebar")).right, "0px");
    assert.equal(f.win.getComputedStyle(h).left, "0px");
    const guide = rules.find((rule) => rule.selectorText === "[data-bcpr-handle]::after");
    assert.equal(guide.style.getPropertyValue("width"), "2px");
    assert.equal(guide.style.getPropertyValue("left"), "0px");
    const sidebarGuide = rules.find((rule) => rule.selectorText === '[data-bcpr-handle="sidebar"]::after');
    assert.ok(sidebarGuide, "sidebar guide must be anchored to the right edge");
    assert.equal(sidebarGuide.style.getPropertyValue("left"), "auto");
    assert.equal(sidebarGuide.style.getPropertyValue("right"), "0px");
    const liveGuide = rules.find((rule) => rule.selectorText === '#aside-chatting > [data-bcpr-handle="chat"]::after');
    assert.ok(liveGuide, "live guide must cover the native separator outside the chat edge");
    assert.equal(liveGuide.style.getPropertyValue("left"), "-1px");
    const highlights = rules.filter(
        (rule) =>
            rule.selectorText?.includes("[data-bcpr-handle]") &&
            rule.style.getPropertyValue("background").includes("--sem-color-content-brand-strong")
    );
    assert.equal(highlights.length, 1);
    assert.equal(
        highlights[0].selectorText,
        "[data-bcpr-handle]:hover::after, [data-bcpr-handle][data-bcpr-dragging]::after"
    );
    assert.equal(
        rules.some((rule) => rule.selectorText?.includes(":focus")),
        false
    );
    assert.equal(rules.filter((rule) => rule.selectorText?.includes("::before")).length, 0);
});

test("explicit stop during the first read stays stopped after callbacks, options and pageshow", async (t) => {
    const f = await fixture(t, { delayedRead: true, stored: { sidebarWidthPx: 280, chatWidthPx: 400 } });
    f.win.BetterChzzk.panelResize.stop();
    f.finishRead();
    f.options({});
    f.win.dispatchEvent(new f.win.PageTransitionEvent("pageshow", { persisted: true }));
    await f.flush();
    assert.equal(f.doc.querySelectorAll("[data-bcpr-handle]").length, 0);
    assert.equal(f.doc.querySelectorAll("[data-bcpr-width]").length, 0);
    assert.equal(f.writes.length, 0);
});

test("an older successful callback cannot clear a newer failure or prevent a fast same-value drag retry", async (t) => {
    const f = await fixture(t, { delayedWrite: true });
    f.drag("chat", 10);
    f.storageFailures.write = true;
    f.drag("chat", 10);
    f.finishWrites(true);
    await f.flush();
    assert.equal(f.width(f.doc.getElementById("aside-chatting")), 373);
    assert.equal(f.store.data[STORAGE_KEYS.chat], 363);
    f.storageFailures.write = false;
    f.pointer(f.handle("chat"), "pointerdown", 600);
    f.pointer(f.win, "pointermove", 590);
    f.pointer(f.win, "pointermove", 600);
    f.pointer(f.win, "pointerup", 600);
    f.finishWrites();
    await f.flush();
    assert.equal(f.store.data[STORAGE_KEYS.chat], 373);
    assert.equal(f.writes.length, 3);
});

for (const panel of ["sidebar", "chat"]) {
    for (const pointerType of ["touch", "pen"]) {
        test(`${panel} ignores ${pointerType} compatibility double clicks after a mouse gesture and accepts a new mouse reset`, async (t) => {
            const f = await fixture(t),
                node = f.doc.getElementById(panel === "sidebar" ? "sidebar" : "aside-chatting"),
                chosen = (panel === "sidebar" ? 240 : 353) + 10;
            f.drag(panel, 10);
            await f.flush();
            assert.equal(f.width(node), chosen);
            assert.equal(f.writes.length, 1);
            f.reset(panel, { pointerType });
            await f.flush();
            assert.equal(f.width(node), chosen, "a previous mouse input cannot authorize a later touch or pen reset");
            assert.equal(f.store.data[STORAGE_KEYS[panel]], chosen);
            assert.equal(f.writes.length, 1);
            f.reset(panel);
            await f.flush();
            assert.equal(node.style.getPropertyValue("--bcpr-width"), "");
            assert.equal(f.store.data[STORAGE_KEYS[panel]], null);
            assert.equal(f.writes.length, 2);
            f.reset(panel);
            await f.flush();
            assert.equal(f.writes.length, 3, "a repeated explicit mouse reset still persists null");
        });
    }
}
