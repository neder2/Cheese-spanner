const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM, VirtualConsole } = require("jsdom");

const repo = path.join(__dirname, "..");
const KEY = "betterchzzk:following-list-state";
const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
    for (let i = 0; i < 80; i++) {
        if (check()) return;
        await wait(20);
    }
    assert.fail("Following list state did not settle");
}

function createChrome({ saved, enabled = true, deferRead = false } = {}) {
    const listeners = [];
    const pendingReads = [];
    const writes = [];
    const local = saved === undefined ? {} : { [KEY]: saved };
    const options = { followingListStateEnabled: enabled, followingPinEnabled: false };
    const runtime = {};
    return {
        runtime,
        storage: {
            sync: {
                get(_keys, callback) {
                    setTimeout(() => callback({ ...options }), 0);
                },
            },
            local: {
                get(_keys, callback) {
                    const snapshot = structuredClone(local);
                    const done = () => callback(snapshot);
                    if (deferRead) pendingReads.push(done);
                    else setTimeout(done, 0);
                },
                set(values, callback) {
                    Object.assign(local, structuredClone(values));
                    writes.push(structuredClone(values));
                    setTimeout(() => callback?.(), 0);
                },
            },
            onChanged: {
                addListener(fn) {
                    listeners.push(fn);
                },
                removeListener(fn) {
                    const i = listeners.indexOf(fn);
                    if (i >= 0) listeners.splice(i, 1);
                },
            },
        },
        state: {
            local,
            writes,
            pendingReads,
            releaseReads() {
                for (const done of pendingReads.splice(0)) done();
            },
            enable(value) {
                options.followingListStateEnabled = value;
                for (const fn of listeners) fn({ followingListStateEnabled: { newValue: value } }, "sync");
            },
            externalPreference(value) {
                local[KEY] = value;
                for (const fn of listeners) fn({ [KEY]: { newValue: value } }, "local");
            },
        },
    };
}

function createPage(
    t,
    chrome,
    { section = true, list = false, moreAvailable = true, ignoreList = false, delayed = false } = {}
) {
    const dom = new JSDOM(
        '<body><aside id="sidebar"></aside><main><button aria-label="더보기" aria-expanded="false">본문 더보기</button></main></body>',
        {
            url: "https://chzzk.naver.com/lives",
            runScripts: "outside-only",
            pretendToBeVisual: true,
            virtualConsole: new VirtualConsole(),
        }
    );
    t.after(() => {
        chrome.state.enable(false);
        dom.window.close();
    });
    dom.window.chrome = chrome;
    dom.window.fetch = () => {
        throw new Error("No extension fetch is needed for following list state");
    };
    const document = dom.window.document;
    const model = { section, list, moreAvailable, ignoreList };
    const clicks = { section: 0, list: 0, refresh: 0 };
    function render() {
        const nav = document.querySelector('nav[aria-label="팔로우"]');
        if (!nav) return;
        nav.innerHTML = `<div><strong>팔로잉 채널</strong>${model.section ? '<button type="button" aria-label="새로고침">새로고침</button>' : ""}<button type="button" data-kind="section" aria-expanded="${model.section}" aria-label="${model.section ? "펼쳐짐, 접기" : "접힘, 펼치기"}">구역</button></div>${model.section ? `<ul>${Array.from({ length: model.list ? 8 : 5 }, (_, i) => `<li><a href="/live/channel-${i}">채널 ${i}</a></li>`).join("")}</ul>${model.moreAvailable ? `<div><button type="button" data-kind="list" aria-expanded="${model.list}" aria-label="${model.list ? "접기" : "더보기"}">${model.list ? "접기" : "더보기"}</button></div>` : ""}` : ""}`;
    }
    function mount() {
        document.getElementById("sidebar").innerHTML =
            '<nav aria-label="인기 카테고리"><button aria-expanded="false" aria-label="더보기">더보기</button></nav><nav aria-label="팔로우"></nav>';
        render();
    }
    document.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (!button?.closest('nav[aria-label="팔로우"]')) return;
        const kind = button.dataset.kind;
        if (kind) {
            clicks[kind]++;
            if (kind === "list" && model.ignoreList) return;
            model[kind] = !model[kind];
        } else clicks.refresh++;
        render();
    });
    if (!delayed) mount();
    for (const file of ["shared/settings.js", "shared/data.js", "content.js", "features/followingListState.js"]) {
        dom.window.eval(fs.readFileSync(path.join(repo, file), "utf8"));
    }
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    return {
        dom,
        document,
        model,
        clicks,
        mount,
        render,
        button: (kind) => document.querySelector(`[data-kind="${kind}"]`),
        navigate() {
            dom.window.history.pushState({}, "", "/live/channel-a");
            dom.window.dispatchEvent(new dom.window.Event("betterchzzk:routechange"));
        },
    };
}

test("following state never saves an untouched native default when enabled", async (t) => {
    const chrome = createChrome();
    const page = createPage(t, chrome);
    await wait(80);
    assert.deepEqual(page.clicks, { section: 0, list: 0, refresh: 0 });
    assert.deepEqual(chrome.state.local, {});
    page.document.querySelector('nav[aria-label="인기 카테고리"] button').click();
    page.document.querySelector("main button").click();
    await wait();
    assert.equal(chrome.state.writes.length, 0);
    assert.equal(page.model.list, false);
});

test("following section and full-list choices persist independently and restore through native controls", async (t) => {
    const chrome = createChrome();
    const page = createPage(t, chrome);
    await wait(60);
    page.button("list").click();
    await until(() => chrome.state.local[KEY]?.list === true);
    page.button("section").click();
    await until(() => chrome.state.local[KEY]?.section === false);
    assert.deepEqual(chrome.state.local[KEY], { list: true, section: false });
    const reloaded = createPage(t, chrome);
    await until(() => reloaded.model.section === false);
    assert.equal(reloaded.clicks.section, 1);
    assert.equal(reloaded.clicks.list, 0, "a closed section must not be opened just to reach its list button");
    reloaded.button("section").click();
    await until(() => reloaded.model.list && chrome.state.local[KEY].section === true);
    assert.equal(reloaded.clicks.list, 1);
    reloaded.button("list").click();
    await until(() => chrome.state.local[KEY].list === false);
    assert.equal(reloaded.model.section, true);
    assert.equal(page.model.section, false, "another already-open tab is not expanded by the stored preference");
});

test("following state survives delayed controls, sidebar replacement and SPA navigation", async (t) => {
    const chrome = createChrome({ saved: { section: true, list: true } });
    const page = createPage(t, chrome, { delayed: true, moreAvailable: false });
    await wait();
    page.mount();
    await wait();
    assert.equal(page.clicks.list, 0);
    page.model.moreAvailable = true;
    page.render();
    await until(() => page.model.list);
    assert.equal(page.clicks.list, 1);
    page.document.getElementById("sidebar").outerHTML = '<aside id="sidebar"></aside>';
    page.model.list = false;
    page.mount();
    page.navigate();
    await until(() => page.model.list);
    assert.equal(page.clicks.list, 2);
    assert.equal(chrome.state.writes.length, 0, "restoring does not write new preferences");
});

test("following state records the native result of a click without fighting a new user choice", async (t) => {
    const chrome = createChrome({ saved: { list: true } });
    const page = createPage(t, chrome);
    await until(() => page.model.list);
    page.button("list").click();
    await until(() => chrome.state.local[KEY]?.list === false);
    page.document.querySelector('nav[aria-label="팔로우"] button[aria-label="새로고침"]').click();
    await wait(80);
    assert.equal(page.model.list, false);
    assert.equal(page.clicks.list, 2);
    page.button("list").click();
    page.button("list").click();
    await wait();
    assert.equal(page.model.list, false, "rapid clicks keep the final native result");
    assert.equal(chrome.state.local[KEY].list, false);
});

test("following state never repeatedly clicks a native button that rejects restoration", async (t) => {
    const chrome = createChrome({ saved: { list: true } });
    const page = createPage(t, chrome, { ignoreList: true });
    await until(() => page.clicks.list === 1);
    for (let i = 0; i < 5; i++) page.button("list").setAttribute("aria-expanded", "false");
    await wait(100);
    assert.equal(page.clicks.list, 1);
    assert.equal(page.model.list, false);
    assert.equal(chrome.state.writes.length, 0);
    page.render();
    await until(() => page.clicks.list === 2);
    await wait(60);
    assert.equal(page.clicks.list, 2);
});

test("following state stops on disable and ignores a late initial storage response", async (t) => {
    const chrome = createChrome({ saved: { list: true }, deferRead: true });
    const page = createPage(t, chrome);
    await until(() => chrome.state.pendingReads.length === 1);
    chrome.state.enable(false);
    chrome.state.releaseReads();
    page.button("list").click();
    await wait();
    assert.equal(chrome.state.writes.length, 0);
    page.model.list = false;
    page.render();
    await wait();
    assert.equal(page.clicks.list, 1, "disabled features do not restore remounted buttons");
    chrome.state.enable(true);
    await until(() => chrome.state.pendingReads.length === 1);
    chrome.state.releaseReads();
    await until(() => page.model.list);
    assert.equal(page.clicks.list, 2);
});

test("following state prioritizes a user's click over a stale initial preference", async (t) => {
    const chrome = createChrome({ saved: { list: false, section: true }, deferRead: true });
    const page = createPage(t, chrome);
    await until(() => chrome.state.pendingReads.length === 1);
    page.button("list").click();
    await wait();
    chrome.state.releaseReads();
    await until(() => chrome.state.local[KEY]?.list === true);
    assert.equal(page.model.list, true);
    assert.equal(page.clicks.list, 1);
    assert.deepEqual(chrome.state.local[KEY], { list: true, section: true });
    chrome.state.externalPreference({ section: false, list: false });
    await wait();
    assert.equal(page.model.list, true);
    assert.equal(page.model.section, true);
});

test("following state ignores malformed values and cannot operate on a recycled non-following section", async (t) => {
    const chrome = createChrome({ saved: { list: "true", section: 0 } });
    const page = createPage(t, chrome);
    await wait(60);
    assert.equal(page.clicks.list, 0);
    const nav = page.document.querySelector('nav[aria-label="팔로우"]');
    nav.setAttribute("aria-label", "인기 카테고리");
    page.button("list").click();
    await wait();
    assert.equal(page.clicks.list, 0);
    assert.equal(chrome.state.writes.length, 0);
});
