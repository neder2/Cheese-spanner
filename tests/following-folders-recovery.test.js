const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = readFileSync(path.join(root, "shared/followingFoldersRecovery.js"), "utf8");
const siteOrigin = "https://chzzk.naver.com";
const readyTab = { id: 7, url: `${siteOrigin}/lives`, active: true, status: "complete" };

function setup() {
    const listeners = {};
    const requests = [];
    const queries = [];
    const harness = {
        tab: { ...readyTab },
        page: { location: { origin: siteOrigin }, document: { visibilityState: "visible", readyState: "complete" } },
        enabled: true,
        documentId: "original-document",
        frameId: 0,
        attach: async () => [],
    };
    const event = (name) => ({ addListener: (listener) => (listeners[name] = listener) });
    const chrome = {
        runtime: { onInstalled: event("installed") },
        windows: { onFocusChanged: event("focused") },
        tabs: {
            onActivated: event("activated"),
            get: async () => harness.tab,
            query: async (query) => {
                queries.push(query);
                return [harness.tab];
            },
        },
        scripting: {
            executeScript(request) {
                requests.push(request);
                if (request.files) return harness.attach();
                return Promise.resolve([
                    {
                        result: vm.runInNewContext(`(${request.func})()`, harness.page),
                        documentId: harness.documentId,
                        frameId: harness.frameId,
                    },
                ]);
            },
        },
        storage: { sync: {} },
    };
    const worker = vm.createContext({
        CheeseSpanner: { utils: { storageGet: async () => ({ followingFoldersEnabled: harness.enabled }) } },
    });
    vm.runInContext(source, worker);
    worker.CheeseSpannerFollowingFoldersRecovery.install(chrome);
    return Object.assign(harness, {
        requests,
        queries,
        activate: () => listeners.activated({ tabId: readyTab.id }),
        focus: (windowId) => listeners.focused(windowId),
        install: (reason) => listeners.installed({ reason }),
    });
}

test("folder recovery targets only an enabled, active, loaded Chzzk tab", async () => {
    const h = setup();
    for (const change of [
        { active: false },
        { discarded: true },
        { status: "loading" },
        { pendingUrl: `${siteOrigin}/following` },
        { url: "https://api.chzzk.naver.com/" },
        { url: "https://chzzk.naver.com.example.org/" },
    ]) {
        h.tab = { ...readyTab, ...change };
        await h.activate();
    }
    h.tab = { ...readyTab };
    h.enabled = false;
    await h.activate();
    await h.focus(-1);
    assert.equal(h.requests.length, 0);
    assert.equal(h.queries.length, 0);
});

test("the document probe rejects a live runtime, a changed origin, and non-top-frame results", async () => {
    const h = setup();
    h.page.CheeseSpanner = { utils: { bindFeatureOptions() {} } };
    await h.activate();
    delete h.page.CheeseSpanner;
    h.page.location.origin = "https://api.chzzk.naver.com";
    await h.activate();
    h.page.location.origin = siteOrigin;
    h.frameId = 1;
    await h.activate();
    assert.equal(h.requests.length, 3);
    assert.ok(h.requests.every((request) => request.func && !request.files));
});

test("recovery loads bundled folder scripts in the probed isolated document", async () => {
    const h = setup();
    await h.activate();
    const [probe, injection] = structuredClone(h.requests.map(({ func: _func, ...request }) => request));
    assert.deepEqual(probe.target, { tabId: readyTab.id, frameIds: [0] });
    assert.deepEqual(injection.target, { tabId: readyTab.id, documentIds: [h.documentId] });
    assert.equal(probe.world, "ISOLATED");
    assert.equal(injection.world, "ISOLATED");

    const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
    const contentScripts = manifest.content_scripts.find((entry) => entry.js.includes("features/followingFolders.js"));
    assert.notEqual(contentScripts.world, "MAIN");
    assert.deepEqual(
        injection.files,
        contentScripts.js.filter((file) => injection.files.includes(file))
    );
    assert.equal(injection.files.at(-1), "features/followingFolders.js");
    assert.deepEqual(
        injection.files.filter((file) => file.startsWith("features/")),
        ["features/followingFolders.js"]
    );
});

test("overlapping foreground events share an attempt and a navigation failure can recover on the next activation", async () => {
    const h = setup();
    let failAttachment;
    h.attach = () => new Promise((_, reject) => (failAttachment = reject));
    const activation = h.activate();
    await h.focus(4);
    await h.install("update");
    assert.equal(h.requests.length, 2);
    assert.deepEqual(structuredClone(h.queries), [
        { windowId: 4, active: true, url: `${siteOrigin}/*` },
        { lastFocusedWindow: true, active: true, url: `${siteOrigin}/*` },
    ]);
    failAttachment(new Error("No document with id original-document"));
    await activation;

    h.documentId = "returning-document";
    h.attach = async () => [];
    await h.activate();
    assert.equal(h.requests.length, 4);
    assert.equal(h.requests.at(-1).target.documentIds[0], "returning-document");
});
