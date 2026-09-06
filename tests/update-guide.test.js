const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const UPDATE = "betterchzzkUpdateNotice";
const READ = "betterchzzkUpdateReadVersion";
const flush = () => new Promise((resolve) => setImmediate(resolve));

function chromeHarness(initial = {}) {
    const local = { ...initial };
    const sync = {};
    const listeners = [];
    const injections = [];
    const activatedTabs = [];
    const focusedWindows = [];
    let openTabs = [];
    let messageListener;
    let settingsOpened = 0;
    let installed;
    let badge = "";
    let failWrite = false;
    const chrome = {
        runtime: {
            id: "test",
            getManifest: () => ({ version: "1.3.3" }),
            getURL: (p) => `chrome-extension://test/${p}`,
            onInstalled: {
                addListener(fn) {
                    installed = fn;
                },
            },
            onMessage: {
                addListener(fn) {
                    messageListener = fn;
                },
            },
            async openOptionsPage() {
                settingsOpened++;
            },
            sendMessage(message) {
                return new Promise((resolve) =>
                    messageListener(message, { id: "test", url: "https://chzzk.naver.com/", tab: { id: 1 } }, resolve)
                );
            },
        },
        tabs: {
            async update(id) {
                activatedTabs.push(id);
            },
            async query(query) {
                assert.equal(query.url, "https://chzzk.naver.com/*");
                return openTabs;
            },
        },
        windows: {
            async update(id) {
                focusedWindows.push(id);
            },
        },
        scripting: {
            async executeScript(spec) {
                injections.push(spec);
                return [{ result: true }];
            },
        },
        action: {
            async setBadgeText(value) {
                badge = value.text;
            },
            async setBadgeBackgroundColor() {},
            async setTitle() {},
        },
        storage: {
            onChanged: {
                addListener(fn) {
                    listeners.push(fn);
                },
                removeListener(fn) {
                    const i = listeners.indexOf(fn);
                    if (i >= 0) listeners.splice(i, 1);
                },
            },
            local: {
                get(keys, cb) {
                    cb(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, local[key]])));
                },
                set(values, cb) {
                    if (failWrite) {
                        failWrite = false;
                        chrome.runtime.lastError = { message: "failed" };
                        cb();
                        chrome.runtime.lastError = null;
                        return;
                    }
                    const changes = Object.fromEntries(
                        Object.entries(values).map(([key, newValue]) => [key, { newValue }])
                    );
                    Object.assign(local, values);
                    cb();
                    for (const listener of [...listeners]) listener(changes, "local");
                },
            },
            sync: {
                get(_keys, cb) {
                    cb({ ...sync });
                },
                set(values, cb) {
                    if (failWrite) {
                        failWrite = false;
                        chrome.runtime.lastError = { message: "failed" };
                        cb();
                        chrome.runtime.lastError = null;
                        return;
                    }
                    Object.assign(sync, values);
                    cb();
                    const changes = Object.fromEntries(
                        Object.entries(values).map(([key, newValue]) => [key, { newValue }])
                    );
                    for (const listener of [...listeners]) listener(changes, "sync");
                },
            },
        },
    };
    return {
        chrome,
        local,
        injections,
        activatedTabs,
        focusedWindows,
        setTabs(tabs) {
            openTabs = tabs;
        },
        get settingsOpened() {
            return settingsOpened;
        },
        get listenerCount() {
            return listeners.length;
        },
        send(message, sender) {
            return new Promise((resolve) => messageListener(message, sender, resolve));
        },
        get badge() {
            return badge;
        },
        install: (details) => installed(details),
        failNextWrite() {
            failWrite = true;
        },
    };
}

function worker(h) {
    const context = vm.createContext({ chrome: h.chrome, URL, console, setTimeout, clearTimeout });
    context.importScripts = (...files) => files.forEach((file) => vm.runInContext(read(file), context));
    vm.runInContext(read("background.js"), context);
}

test("actual version updates create NEW, same-version reloads and browser updates do not", async () => {
    const h = chromeHarness();
    worker(h);
    await flush();
    for (const details of [
        { reason: "install" },
        { reason: "chrome_update" },
        { reason: "update", previousVersion: "1.3.3" },
    ]) {
        h.install(details);
        await flush();
        assert.equal(h.badge, "");
        assert.equal(h.local[UPDATE], undefined);
    }
    h.install({ reason: "update", previousVersion: "1.3.2" });
    await flush();
    assert.equal(h.badge, "NEW");
    assert.equal(h.local[UPDATE].previousVersion, "1.3.2");
    h.chrome.storage.local.set({ [READ]: "1.3.3" }, () => {});
    await flush();
    assert.equal(h.badge, "");
    h.install({ reason: "update", previousVersion: "1.3.3" });
    await flush();
    assert.equal(h.badge, "");
});

test("worker restart restores unread badge and an older acknowledgement cannot clear it", async () => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" }, [READ]: "1.3.2" });
    worker(h);
    await flush();
    assert.equal(h.badge, "NEW");
    h.chrome.storage.local.set({ [READ]: "1.3.1" }, () => {});
    await flush();
    assert.equal(h.badge, "NEW");
});

function page(t, h) {
    const dom = new JSDOM(read("options.html"), {
        url: "https://example.test/options.html",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    dom.window.chrome = h.chrome;
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {} });
    const dialog = dom.window.document.getElementById("featureGuide");
    dialog.showModal = () => dialog.setAttribute("open", "");
    dialog.close = () => dialog.removeAttribute("open");
    for (const file of ["shared/settings.js", "options.js", "shared/updateGuide.js", "optionsUpdateGuide.js"])
        vm.runInContext(read(file), dom.getInternalVMContext(), { filename: file });
    const get = (id) => dom.window.document.getElementById(id);
    return { dom, get, click: (id) => get(id).click() };
}

test("tutorial explains option locations, defers, replays and only completion acknowledges", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    worker(h);
    const p = page(t, h);
    await flush();
    assert.equal(p.get("updateNotice").hidden, false);
    p.click("guideOpen");
    assert.equal(p.get("guideProgress").textContent, "1 / 3");
    assert.match(p.get("guideTitle").textContent, /사이드바/);
    assert.equal(p.get("guidePrevious").disabled, true);
    assert.equal(p.get("guideSettings"), null);
    assert.match(p.get("guideText").textContent, /확장 옵션.*탐색 → 사이드바/);
    assert.equal(h.local[READ], undefined);
    p.click("guideReplay");
    p.click("guideNext");
    assert.equal(p.get("guideProgress").textContent, "2 / 3");
    assert.match(p.get("guideTitle").textContent, /멀티뷰/);
    assert.match(p.get("guideText").textContent, /확장 옵션.*플레이어 → 멀티뷰/);
    p.click("guideReplay");
    p.click("guideLater");
    assert.equal(p.get("updateNotice").hidden, false);
    p.click("guideReplay");
    p.click("guideNext");
    p.click("guideNext");
    assert.equal(p.get("guideFinish").textContent, "확인");
    assert.equal(p.get("guideNext").disabled, true);
    p.click("guideFinish");
    await flush();
    assert.equal(h.local[READ], "1.3.3");
    assert.equal(h.badge, "");
    assert.equal(p.get("updateNotice").hidden, true);
    p.click("guideReplay");
    assert.equal(p.get("featureGuide").open, true);
});

test("failed acknowledgement keeps the notice and can be retried", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    const p = page(t, h);
    p.click("guideOpen");
    p.click("guideNext");
    p.click("guideNext");
    h.failNextWrite();
    p.click("guideFinish");
    assert.equal(p.get("guideError").hidden, false);
    assert.equal(p.get("featureGuide").open, true);
    assert.equal(p.get("updateNotice").hidden, false);
    assert.equal(h.local[READ], undefined);
    p.click("guideFinish");
    assert.equal(h.local[READ], "1.3.3");
});

test("disabling update notifications hides badge and notice across future updates until reenabled", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    worker(h);
    const p = page(t, h);
    await flush();
    h.chrome.storage.sync.set({ updateNotificationsEnabled: false }, () => {});
    await flush();
    assert.equal(h.badge, "");
    assert.equal(p.get("updateNotice").hidden, true);
    h.chrome.runtime.getManifest = () => ({ version: "1.3.4" });
    h.install({ reason: "update", previousVersion: "1.3.3" });
    await flush();
    assert.equal(h.badge, "");
    h.chrome.storage.sync.set({ updateNotificationsEnabled: true }, () => {});
    await flush();
    assert.equal(h.badge, "NEW");
});

test("update injection targets only loaded CHZZK tabs and respects the global opt-out", async () => {
    const h = chromeHarness();
    h.setTabs([
        { id: 1, url: "https://chzzk.naver.com/live/a" },
        { id: 2, url: "https://chzzk.naver.com/", discarded: true },
        { id: 3, url: "https://example.com/" },
    ]);
    worker(h);
    h.install({ reason: "update", previousVersion: "1.3.2" });
    await flush();
    assert.equal(h.injections.length, 1);
    assert.equal(h.injections[0].target.tabId, 1);
    assert.equal(h.injections[0].world, "ISOLATED");
    assert.deepEqual(Array.from(h.injections[0].files), ["shared/updateGuide.js", "features/updateNotice.js"]);
    h.chrome.storage.sync.set({ updateNotificationsEnabled: false }, () => {});
    h.chrome.runtime.getManifest = () => ({ version: "1.3.4" });
    h.install({ reason: "update", previousVersion: "1.3.3" });
    await flush();
    assert.equal(h.injections.length, 1);
});

test("tutorial cards never offer a settings shortcut or open options automatically", async (t) => {
    const h = chromeHarness();
    const a = noticeTab(t, h);
    await flush();
    a.preview();
    await a.click("reload");
    a.load();
    await flush();
    for (let step = 0; step < 3; step++) {
        assert.equal(a.shadow().querySelector('[data-action="settings"]'), null);
        if (step < 2) await a.click("next");
    }
    assert.equal(h.settingsOpened, 0);
});

function noticeTab(t, h, session = {}) {
    const dom = new JSDOM('<!doctype html><body><main id="root">치지직 화면</main></body>', {
        url: "https://chzzk.naver.com/",
        pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    let reloads = 0;
    const context = vm.createContext({
        window: dom.window,
        MutationObserver: dom.window.MutationObserver,
        document: dom.window.document,
        chrome: h.chrome,
        location: {
            origin: "https://chzzk.naver.com",
            reload() {
                reloads++;
            },
        },
        sessionStorage: {
            getItem: (key) => session[key] || null,
            setItem: (key, value) => {
                session[key] = value;
            },
            removeItem: (key) => {
                delete session[key];
            },
        },
    });
    const load = () => {
        for (const file of ["shared/updateGuide.js", "features/updateNotice.js"]) vm.runInContext(read(file), context);
    };
    load();
    t.after(() => context.BetterChzzkUpdateNoticeRuntime.destroy());
    const shadow = () => dom.window.document.getElementById("betterchzzk-update-notice")?.shadowRoot;
    return {
        dom,
        session,
        load,
        shadow,
        preview: () => context.BetterChzzkUpdateNoticeRuntime.showPreview(),
        tutorial: () => context.BetterChzzkUpdateNoticeRuntime.showTutorial(),
        get reloads() {
            return reloads;
        },
        async click(action) {
            shadow().querySelector(`[data-action="${action}"]`).click();
            await flush();
        },
    };
}

test("top notice reloads only the clicked tab and continues the three-step guide", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    worker(h);
    const a = noticeTab(t, h);
    const b = noticeTab(t, h);
    await flush();
    assert.equal(a.shadow().getElementById("title").textContent, "Better Chzzk 업데이트 완료");
    assert.equal(a.shadow().getElementById("text").textContent, "새로고침 후 새 기능을 확인해요.");
    assert.equal(a.shadow().querySelector('[data-action="mute"]').textContent, "알림 끄기");
    assert.equal(
        a.shadow().querySelector('[data-action="mute"]').getAttribute("aria-label"),
        "업데이트 다시 알리지 않음"
    );
    await a.click("reload");
    assert.equal(a.reloads, 1);
    assert.equal(b.reloads, 0);
    assert.equal(a.session.betterchzzkUpdateGuideAfterReload, "1.3.3");
    a.load();
    await flush();
    assert.equal(a.session.betterchzzkUpdateGuideAfterReload, undefined);
    assert.equal(a.shadow().getElementById("title").textContent, "사이드바 숨김 기능 추가");
    assert.equal(a.shadow().getElementById("progress").textContent, "1 / 3");
    await a.click("next");
    assert.equal(a.shadow().getElementById("title").textContent, "멀티뷰 기능 추가");
    assert.equal(a.shadow().activeElement.dataset.action, "next");
    assert.equal(a.shadow().querySelector('[data-action="settings"]'), null);
    await a.click("next");
    assert.equal(a.shadow().getElementById("title").textContent, "멀티뷰 설정은 여기 있어요");
    assert.equal(a.shadow().getElementById("progress").textContent, "3 / 3");
    await a.click("finish");
    assert.equal(h.local[READ], "1.3.3");
    assert.equal(a.shadow(), undefined);
    assert.equal(b.shadow(), undefined);
    assert.equal(h.badge, "");
});

test("top notice mutes all tabs and persists opt-out, without pretending a failed write succeeded", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    worker(h);
    const a = noticeTab(t, h);
    const b = noticeTab(t, h);
    await flush();
    h.failNextWrite();
    await a.click("mute");
    assert.equal(a.shadow().getElementById("error").hidden, false);
    assert.ok(b.shadow());
    assert.equal(h.badge, "NEW");
    await a.click("mute");
    assert.equal(a.shadow(), undefined);
    assert.equal(b.shadow(), undefined);
    assert.equal(h.badge, "");
    a.load();
    await flush();
    assert.equal(a.shadow(), undefined);
});

test("reinjection does not duplicate the notice or listeners; body remounts preserve it", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    const a = noticeTab(t, h);
    await flush();
    const listeners = h.listenerCount;
    a.load();
    await flush();
    assert.equal(h.listenerCount, listeners);
    assert.equal(a.dom.window.document.querySelectorAll("#betterchzzk-update-notice").length, 1);
    a.dom.window.document.body.replaceChildren();
    assert.ok(a.shadow());
});

test("no notice is fabricated on storage read failure or without a pending update", async (t) => {
    const h = chromeHarness();
    const a = noticeTab(t, h);
    await flush();
    assert.equal(a.shadow(), undefined);
    h.chrome.storage.local.get = (_keys, callback) => {
        h.chrome.runtime.lastError = { message: "failed" };
        callback({ [UPDATE]: { version: "1.3.3" } });
        h.chrome.runtime.lastError = null;
    };
    a.load();
    await flush();
    assert.equal(a.shadow(), undefined);
});

test("compact notice anchors beside the header search box and follows viewport changes", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    const a = noticeTab(t, h);
    const form = a.dom.window.document.createElement("form");
    form.innerHTML = '<input id="search-input">';
    let right = 600;
    form.getBoundingClientRect = () => ({ width: 400, right });
    a.dom.window.document.body.prepend(form);
    await flush();
    const host = a.dom.window.document.getElementById("betterchzzk-update-notice");
    assert.equal(host.style.left, "612px");
    assert.equal(host.hasAttribute("data-guide"), false);
    right = 2000;
    a.dom.window.dispatchEvent(new a.dom.window.Event("resize"));
    assert.equal(host.style.left, `${a.dom.window.innerWidth - 280 - 12}px`);
});

test("tutorial uses sidebar width, arrow navigation and an anchored multiview speech bubble", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    const a = noticeTab(t, h, { betterchzzkUpdateGuideAfterReload: "1.3.3" });
    const doc = a.dom.window.document;
    const sidebar = doc.createElement("aside");
    sidebar.id = "sidebar";
    sidebar.getBoundingClientRect = () => ({ left: 0, right: 224, top: 64, width: 224, height: 700 });
    const launcher = doc.createElement("button");
    launcher.id = "betterchzzk-multiview-launcher";
    let buttonTop = 500;
    launcher.getBoundingClientRect = () => ({ left: 700, right: 736, top: buttonTop, width: 36, height: 36 });
    doc.body.append(sidebar, launcher);
    await flush();
    const host = doc.getElementById("betterchzzk-update-notice");
    host.getBoundingClientRect = () => ({ height: 140 });
    a.dom.window.dispatchEvent(new a.dom.window.Event("resize"));
    assert.equal(host.style.width, "208px");
    assert.equal(host.style.left, "8px");
    assert.equal(host.style.top, "72px");
    const nav = a.shadow().querySelector(".navigation");
    assert.equal(nav.querySelector('[aria-label="이전"]').disabled, true);
    assert.ok(nav.querySelector('[aria-label="다음"] svg'));
    await a.click("next");
    assert.equal(host.style.width, "240px");
    assert.equal(host.style.top, "334px");
    assert.equal(host.style.left, "598px");
    assert.equal(host.getAttribute("data-arrow"), "bottom");
    assert.equal(a.shadow().querySelector('[data-action="next"]').disabled, false);
    assert.equal(a.shadow().querySelector('[data-action="finish"]'), null);
    buttonTop = 450;
    a.dom.window.dispatchEvent(new a.dom.window.Event("resize"));
    assert.equal(host.style.top, "284px");
    launcher.remove();
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(host.hasAttribute("data-arrow"), false);
    doc.body.appendChild(launcher);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(host.getAttribute("data-arrow"), "bottom");
    await a.click("previous");
    assert.equal(host.style.width, "208px");
    assert.equal(host.hasAttribute("data-arrow"), false);
    assert.equal(a.shadow().querySelector('[data-action="previous"]').disabled, true);
});

test("step transition exits before moving, enters at the destination and cancels on dismissal", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    const a = noticeTab(t, h, { betterchzzkUpdateGuideAfterReload: "1.3.3" });
    await flush();
    const host = a.dom.window.document.getElementById("betterchzzk-update-notice");
    const animations = [];
    host.animate = (frames, options) => {
        let resolve, reject;
        const animation = {
            frames,
            options,
            cancelled: false,
            finished: new Promise((yes, no) => {
                resolve = yes;
                reject = no;
            }),
            finish: () => resolve(),
            cancel() {
                this.cancelled = true;
                reject(new Error("cancelled"));
            },
        };
        animations.push(animation);
        return animation;
    };
    await a.click("next");
    assert.equal(animations.length, 1);
    assert.equal(a.shadow().getElementById("progress").textContent, "1 / 3");
    assert.equal(animations[0].frames[1].transform, "translateY(8px)");
    assert.equal(animations[0].frames[1].opacity, 0);
    assert.equal(a.shadow().querySelector('[data-action="next"]').disabled, true);
    animations[0].finish();
    await flush();
    assert.equal(animations.length, 2);
    assert.equal(a.shadow().getElementById("progress").textContent, "2 / 3");
    assert.equal(animations[1].frames[0].opacity, 0);
    assert.equal(animations[1].frames[1].transform, "translateY(0)");
    animations[1].finish();
    await flush();
    assert.equal(host.hasAttribute("data-transition"), false);
    assert.equal(a.shadow().querySelector('[data-action="next"]').disabled, false);
    assert.equal(a.shadow().activeElement.dataset.action, "next");
    await a.click("previous");
    h.chrome.storage.sync.set({ updateNotificationsEnabled: false }, () => {});
    await flush();
    assert.equal(animations[2].cancelled, true);
    assert.equal(a.shadow(), undefined);
    assert.equal(animations.length, 3);
});

test("reduced-motion preference switches tutorial steps immediately without animation", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    const a = noticeTab(t, h, { betterchzzkUpdateGuideAfterReload: "1.3.3" });
    await flush();
    a.dom.window.matchMedia = () => ({ matches: true });
    a.dom.window.document.getElementById("betterchzzk-update-notice").animate = () =>
        assert.fail("motion must be disabled");
    await a.click("next");
    assert.equal(a.shadow().getElementById("progress").textContent, "2 / 3");
    assert.equal(a.shadow().querySelector('[data-action="next"]').disabled, false);
});

test("real-page preview is restricted to options and activates one eligible tab", async () => {
    const h = chromeHarness();
    worker(h);
    const message = { type: "betterchzzk:update:preview" };
    const sender = { id: "test", url: "chrome-extension://test/options.html" };
    assert.equal((await h.send(message, { id: "test", url: "https://chzzk.naver.com/", tab: {} })).ok, false);
    assert.equal((await h.send(message, sender)).ok, false);
    assert.equal(h.injections.length, 0);
    h.setTabs([
        { id: 1, windowId: 10, url: "https://chzzk.naver.com/", lastAccessed: 100 },
        { id: 2, windowId: 20, url: "https://chzzk.naver.com/live/a", active: true, lastAccessed: 1 },
    ]);
    assert.equal((await h.send(message, sender)).ok, true);
    assert.equal(h.injections.length, 2);
    assert.equal(h.injections[0].target.tabId, 2);
    assert.equal(h.injections[1].target.tabId, 2);
    assert.deepEqual(h.activatedTabs, [2]);
    assert.deepEqual(h.focusedWindows, [20]);
});

test("third speech bubble points up at the real multiview settings button and follows remounts", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    const a = noticeTab(t, h, { betterchzzkUpdateGuideAfterReload: "1.3.3" });
    await flush();
    await a.click("next");
    await a.click("next");
    const host = a.dom.window.document.getElementById("betterchzzk-update-notice");
    host.getBoundingClientRect = () => ({ height: 120 });
    assert.equal(host.hasAttribute("data-arrow"), false);
    assert.equal(a.shadow().getElementById("title").textContent, "멀티뷰 설정은 여기 있어요");
    assert.equal(a.shadow().querySelector('[data-action="next"]').disabled, true);
    assert.equal(a.shadow().querySelector('[data-action="finish"]').textContent, "확인");
    const settings = a.dom.window.document.createElement("button");
    settings.id = "betterchzzk-multiview-chat-settings";
    settings.getBoundingClientRect = () => ({ left: 870, top: 70, right: 900, bottom: 100, width: 30, height: 30 });
    a.dom.window.document.body.appendChild(settings);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(host.style.top, "110px");
    assert.equal(host.getAttribute("data-arrow"), "top");
    settings.remove();
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(host.hasAttribute("data-arrow"), false);
    await a.click("finish");
    assert.equal(h.local[READ], "1.3.3");
});

test("settings tutorial stays by the chat header while multiview is off and retargets a newly mounted button", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    const a = noticeTab(t, h, { betterchzzkUpdateGuideAfterReload: "1.3.3" });
    const doc = a.dom.window.document;
    // Native header shape measured 2026-09-06, with no multiview button present.
    const chat = doc.createElement("aside");
    chat.id = "aside-chatting";
    chat.innerHTML = '<div><h2>채팅</h2><div class="menu"><button aria-label="더보기 메뉴"></button></div></div>';
    const header = chat.firstElementChild;
    header.getBoundingClientRect = () => ({ left: 700, right: 1000, top: 60, bottom: 104, width: 300, height: 44 });
    doc.body.appendChild(chat);
    await flush();
    await a.click("next");
    await a.click("next");
    const host = doc.getElementById("betterchzzk-update-notice");
    assert.equal(host.style.left, "730px");
    assert.equal(host.style.top, "114px");
    assert.equal(host.hasAttribute("data-arrow"), false, "do not point to a nonexistent settings button");
    const button = doc.createElement("button");
    button.id = "betterchzzk-multiview-chat-settings";
    button.getBoundingClientRect = () => ({ left: 940, right: 970, top: 70, bottom: 100, width: 30, height: 30 });
    header.querySelector(".menu").appendChild(button);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(host.style.left, "776px");
    assert.equal(host.style.top, "110px");
    assert.equal(host.getAttribute("data-arrow"), "top");
    button.remove();
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(host.style.left, "730px");
    assert.equal(host.hasAttribute("data-arrow"), false);
    chat.remove();
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(host.style.left, "");
    assert.equal(host.style.right, "12px");
});

test("clicking the actual multiview launcher on step two advances after its native action", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    const a = noticeTab(t, h, { betterchzzkUpdateGuideAfterReload: "1.3.3" });
    const document = a.dom.window.document;
    const launcher = document.createElement("button");
    launcher.id = "betterchzzk-multiview-launcher";
    launcher.innerHTML = "<svg><path></path></svg>";
    let nativeCalls = 0;
    launcher.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        nativeCalls++;
        assert.equal(a.shadow().getElementById("progress").textContent, nativeCalls === 1 ? "1 / 3" : "2 / 3");
        if (nativeCalls === 2) {
            const settings = document.createElement("button");
            settings.id = "betterchzzk-multiview-chat-settings";
            settings.getBoundingClientRect = () => ({
                left: 800,
                top: 60,
                right: 830,
                bottom: 90,
                width: 30,
                height: 30,
            });
            document.body.appendChild(settings);
            const urlInput = document.createElement("input");
            urlInput.id = "native-multiview-url";
            document.body.appendChild(urlInput);
            urlInput.focus();
        }
    });
    document.body.appendChild(launcher);
    await flush();
    launcher.click();
    await flush();
    assert.equal(a.shadow().getElementById("progress").textContent, "1 / 3");
    await a.click("next");
    launcher
        .querySelector("path")
        .dispatchEvent(new a.dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await flush();
    assert.equal(nativeCalls, 2);
    assert.equal(document.activeElement.id, "native-multiview-url");
    assert.equal(a.shadow().getElementById("progress").textContent, "3 / 3");
    assert.equal(document.getElementById("betterchzzk-update-notice").getAttribute("data-arrow"), "top");
    assert.equal(h.local[READ], undefined);
});

test("temporary real-page preview bypasses opt-out without changing preferences or acknowledgement", async (t) => {
    const h = chromeHarness({ [READ]: "1.3.3" });
    h.chrome.storage.sync.set({ updateNotificationsEnabled: false }, () => {});
    const a = noticeTab(t, h);
    await flush();
    assert.equal(a.shadow(), undefined);
    assert.equal(a.preview(), true);
    assert.match(a.shadow().querySelector(".tag").textContent, /미리보기/);
    await a.click("reload");
    assert.equal(a.reloads, 1);
    a.load();
    await flush();
    assert.equal(a.shadow().getElementById("progress").textContent, "1 / 3");
    await a.click("next");
    await a.click("next");
    await a.click("finish");
    assert.equal(a.shadow(), undefined);
    assert.equal(h.local[READ], "1.3.3");
    a.preview();
    await a.click("mute");
    h.chrome.storage.sync.get("updateNotificationsEnabled", (data) =>
        assert.equal(data.updateNotificationsEnabled, false)
    );
    assert.equal(a.shadow(), undefined);
    assert.equal(h.local[UPDATE], undefined);
});

test("preview completion does not acknowledge a real pending update", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    const a = noticeTab(t, h);
    await flush();
    a.preview();
    await a.click("reload");
    a.load();
    await flush();
    await a.click("next");
    await a.click("next");
    await a.click("finish");
    assert.equal(h.local[READ], undefined);
});

test("options keep the feature guide usable without the old preview control", (t) => {
    const h = chromeHarness();
    const p = page(t, h);
    assert.equal(p.get("guidePagePreview"), null);
    assert.equal(p.get("guidePreviewStatus"), null);
    p.click("guideReplay");
    assert.equal(p.get("featureGuide").open, true);
    assert.equal(h.injections.length, 0);
    assert.equal(h.activatedTabs.length, 0);
});

test("adblock and updates are separate peer groups in the popup and alerts category", async (t) => {
    const p = page(t, chromeHarness());
    const document = p.dom.window.document;
    const adblock = document.querySelector('[data-option="adblockPopupEnabled"]').closest("details");
    const updates = document.querySelector('[data-option="updateNotificationsEnabled"]').closest("details");
    assert.notEqual(adblock, updates);
    assert.equal(adblock.parentElement, updates.parentElement);
    assert.equal(p.get("guideTutorialReplay").closest("details"), updates);
    assert.equal(p.get("guideTutorialReplay").textContent.trim(), "튜토리얼 다시보기");
    assert.equal(p.get("tab-3").getAttribute("aria-label"), "팝업·알림");
});

test("tutorial replay starts at step one without reload or update state changes", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    h.chrome.storage.sync.set({ updateNotificationsEnabled: false }, () => {});
    const a = noticeTab(t, h);
    await flush();
    assert.equal(a.tutorial(), true);
    assert.equal(a.shadow().getElementById("progress").textContent, "1 / 3");
    assert.equal(a.shadow().querySelector(".tag").textContent, "튜토리얼 다시보기");
    assert.equal(a.reloads, 0);
    assert.equal(a.shadow().querySelector('[data-action="reload"]'), null);
    await a.click("next");
    await a.click("next");
    await a.click("finish");
    assert.equal(h.local[READ], undefined);
    a.tutorial();
    assert.equal(a.shadow().getElementById("progress").textContent, "1 / 3");
    await a.click("mute");
    assert.equal(a.shadow(), undefined);
    h.chrome.storage.sync.get("updateNotificationsEnabled", (data) =>
        assert.equal(data.updateNotificationsEnabled, false)
    );
});

test("tutorial replay handles missing tabs, the tutorial entry point, and injection errors", async (t) => {
    const h = chromeHarness();
    const p = page(t, h);
    p.click("guideTutorialReplay");
    await flush();
    assert.equal(p.get("guideTutorialStatus").textContent, "치지직 페이지를 먼저 열어 주세요.");
    assert.equal(p.get("guideTutorialReplay").disabled, false);
    h.setTabs([{ id: 5, windowId: 2, url: "https://chzzk.naver.com/live/a", active: true }]);
    p.click("guideTutorialReplay");
    await flush();
    assert.equal(h.injections.length, 2);
    assert.equal(h.injections[1].args[0], true);
    let called = false;
    assert.equal(
        vm.runInNewContext("(" + h.injections[1].func.toString() + ")(true)", {
            BetterChzzkUpdateNoticeRuntime: {
                showTutorial() {
                    called = true;
                    return true;
                },
                showPreview() {
                    assert.fail("Replay must start the tutorial");
                },
            },
        }),
        true
    );
    assert.equal(called, true);
    assert.deepEqual(h.activatedTabs, [5]);
    assert.equal(p.get("guideTutorialStatus").textContent, "치지직 페이지에서 튜토리얼을 시작했어요.");
    h.chrome.scripting.executeScript = async () => {
        throw Error("Cannot access contents of the page");
    };
    p.click("guideTutorialReplay");
    await flush();
    assert.match(p.get("guideTutorialStatus").textContent, /Cannot access contents of the page/);
    assert.equal(p.get("guideTutorialReplay").disabled, false);
});
