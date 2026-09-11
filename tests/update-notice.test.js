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
        url: "chrome-extension://test/options.html",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    dom.window.chrome = h.chrome;
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {} });
    for (const file of ["shared/settings.js", "options.js", "shared/updateNotice.js", "optionsUpdateNotice.js"])
        vm.runInContext(read(file), dom.getInternalVMContext());
    const get = (id) => dom.window.document.getElementById(id);
    return { dom, get };
}

function noticeTab(t, h, session = {}) {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
        url: "https://chzzk.naver.com/",
        pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    let reloads = 0;
    const context = vm.createContext({
        window: dom.window,
        document: dom.window.document,
        chrome: h.chrome,
        location: {
            origin: "https://chzzk.naver.com",
            reload() {
                reloads++;
            },
        },
        sessionStorage: {
            removeItem(key) {
                delete session[key];
            },
        },
    });
    const load = () => {
        for (const file of ["shared/updateNotice.js", "features/updateNotice.js"]) vm.runInContext(read(file), context);
    };
    load();
    t.after(() => context.BetterChzzkUpdateNoticeRuntime.destroy());
    const shadow = () => dom.window.document.getElementById("betterchzzk-update-notice")?.shadowRoot;
    return {
        dom,
        session,
        load,
        shadow,
        context,
        get reloads() {
            return reloads;
        },
        async click(action) {
            shadow().querySelector(`[data-action="${action}"]`).click();
            await flush();
        },
    };
}

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
    assert.deepEqual(Array.from(h.injections[0].files), ["shared/updateNotice.js", "features/updateNotice.js"]);
    h.chrome.storage.sync.set({ updateNotificationsEnabled: false }, () => {});
    h.chrome.runtime.getManifest = () => ({ version: "1.3.4" });
    h.install({ reason: "update", previousVersion: "1.3.3" });
    await flush();
    assert.equal(h.injections.length, 1);
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

test("refresh acknowledges the update and reloads only the clicked tab without a tutorial", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    worker(h);
    const a = noticeTab(t, h, { betterchzzkUpdateGuideAfterReload: "1.3.3" });
    const b = noticeTab(t, h);
    await flush();
    assert.equal(a.shadow().getElementById("text").textContent, "새로고침해서 업데이트를 적용해 주세요.");
    assert.deepEqual(
        Array.from(a.shadow().querySelectorAll("button"), (button) => button.dataset.action),
        ["reload", "mute"]
    );
    assert.equal(a.shadow().querySelector(".navigation"), null);
    assert.equal(a.context.BetterChzzkUpdateNoticeRuntime.showTutorial, undefined);
    assert.equal(a.session.betterchzzkUpdateGuideAfterReload, undefined);
    await a.click("reload");
    assert.equal(a.reloads, 1);
    assert.equal(b.reloads, 0);
    assert.equal(h.local[READ], "1.3.3");
    assert.equal(h.badge, "");
    a.load();
    await flush();
    assert.equal(a.shadow(), undefined);
    assert.equal(b.shadow(), undefined);
    assert.equal(h.settingsOpened, 0);
});

test("failed refresh acknowledgement leaves the notice and supports retry", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    const a = noticeTab(t, h);
    await flush();
    h.failNextWrite();
    await a.click("reload");
    assert.equal(a.reloads, 0);
    assert.equal(h.local[READ], undefined);
    assert.equal(a.shadow().getElementById("error").hidden, false);
    assert.equal(a.shadow().querySelector('[data-action="reload"]').disabled, false);
    await a.click("reload");
    assert.equal(a.reloads, 1);
    assert.equal(h.local[READ], "1.3.3");
});

test("repeated clicks during acknowledgement reload the tab once", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    const a = noticeTab(t, h);
    await flush();
    const button = a.shadow().querySelector('[data-action="reload"]');
    button.click();
    button.click();
    await flush();
    assert.equal(a.reloads, 1);
});

test("pagehide prevents a delayed read from restoring the notice and removes listeners", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    const a = noticeTab(t, h);
    await flush();
    const listeners = h.listenerCount;
    const reads = [];
    h.chrome.storage.local.get = (_keys, callback) => reads.push(callback);
    a.load();
    a.dom.window.dispatchEvent(new a.dom.window.Event("pagehide"));
    reads.forEach((callback) => callback({ [UPDATE]: { version: "1.3.3" } }));
    await flush();
    assert.equal(a.shadow(), undefined);
    assert.equal(h.listenerCount, listeners - 1);
});

test("a page restored from the back-forward cache still responds to update state", async (t) => {
    const h = chromeHarness();
    const a = noticeTab(t, h);
    await flush();
    const listeners = h.listenerCount;
    a.dom.window.dispatchEvent(new a.dom.window.PageTransitionEvent("pagehide", { persisted: true }));
    h.chrome.storage.local.set({ [UPDATE]: { version: "1.3.3" } }, () => {});
    a.dom.window.dispatchEvent(new a.dom.window.PageTransitionEvent("pageshow", { persisted: true }));
    await flush();
    assert.equal(h.listenerCount, listeners);
    assert.ok(a.shadow());
});

test("legacy continuation never creates a tutorial without an update", async (t) => {
    const a = noticeTab(t, chromeHarness(), { betterchzzkUpdateGuideAfterReload: "preview:1.3.3" });
    await flush();
    assert.equal(a.shadow(), undefined);
    assert.equal(a.session.betterchzzkUpdateGuideAfterReload, undefined);
});

test("popup only prompts a refresh and has no tutorial, replay or navigation controls", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    const p = page(t, h);
    await flush();
    assert.equal(p.get("updateNotice").hidden, false);
    assert.match(p.get("updateNotice").textContent, /새로고침해서 업데이트를 적용/);
    assert.equal(p.get("featureGuide"), null);
    assert.equal(p.get("guideOpen"), null);
    assert.equal(p.get("guideTutorialReplay"), null);
    assert.equal(p.get("updateNotice").querySelector("button"), null);
    const document = p.dom.window.document;
    const adblock = document.querySelector('[data-option="adblockPopupEnabled"]').closest("details");
    const updates = document.querySelector('[data-option="updateNotificationsEnabled"]').closest("details");
    assert.notEqual(adblock, updates);
    assert.equal(adblock.parentElement, updates.parentElement);
    assert.equal(p.get("tab-3").getAttribute("aria-label"), "팝업·알림");
});

test("popup acknowledgement changes hide the notice and pagehide detaches its listener", async (t) => {
    const h = chromeHarness({ [UPDATE]: { version: "1.3.3" } });
    const p = page(t, h);
    await flush();
    h.chrome.storage.local.set({ [READ]: "1.3.3" }, () => {});
    assert.equal(p.get("updateNotice").hidden, true);
    const listeners = h.listenerCount;
    p.dom.window.dispatchEvent(new p.dom.window.Event("pagehide"));
    assert.equal(h.listenerCount, listeners - 1);
});
