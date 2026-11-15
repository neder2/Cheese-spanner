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
    const state = {
        local,
        writes,
        pendingReads,
        failReads: 0,
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
    };
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
                    const failed = state.failReads > 0;
                    if (failed) state.failReads -= 1;
                    const done = () => {
                        if (!failed) return callback(snapshot);
                        runtime.lastError = { message: "read failed" };
                        try {
                            callback(undefined);
                        } finally {
                            delete runtime.lastError;
                        }
                    };
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
        state,
    };
}

// Web Locks keeps one holder per name across same-origin tabs; this fake grants requests in order.
function createLockManager() {
    const tails = new Map();
    return {
        request(name, work) {
            const run = (tails.get(name) || Promise.resolve()).then(() => work());
            tails.set(
                name,
                run.then(
                    () => {},
                    () => {}
                )
            );
            return run;
        },
    };
}

function createPage(
    t,
    chrome,
    { section = true, list = false, moreAvailable = true, ignoreList = false, delayed = false, locks = null } = {}
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
    if (locks) Object.defineProperty(dom.window.navigator, "locks", { value: locks, configurable: true });
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
            dom.window.dispatchEvent(new dom.window.Event("cheese-spanner:routechange"));
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
    // Saving reads the latest stored value first, and this fixture holds every read until released.
    await until(() => {
        chrome.state.releaseReads();
        return chrome.state.local[KEY]?.list === true;
    });
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

// Like the site (2026-10-13 public bundle, scaled down): the same 더보기 button stays, each click adds a step of rows,
// and only a fully built list turns it into 접기. refresh() cuts the list back to its length after the first click.
function createSteppedPage(t, chrome, { total = 11, step = 2, collapsed = 5, endless = false } = {}) {
    const dom = new JSDOM(
        '<body><aside id="sidebar"><nav aria-label="팔로우"><div><strong>팔로잉 채널</strong><button type="button" data-kind="section" aria-expanded="true" aria-label="펼쳐짐, 접기">구역</button></div><ul></ul><div><button type="button" data-kind="list" aria-expanded="false" aria-label="더보기">더보기</button></div></nav></aside></body>',
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
    const document = dom.window.document;
    const list = document.querySelector("ul");
    const more = document.querySelector('[data-kind="list"]');
    const page = { document, clicks: 0, rows: () => list.children.length, more };
    let firstLength = null;
    const render = (count) => {
        while (list.children.length > count) list.lastElementChild.remove();
        while (list.children.length < count) {
            const row = document.createElement("li");
            row.innerHTML = `<a href="/live/channel-${list.children.length}">채널</a>`;
            list.append(row);
        }
        const all = !endless && count >= total;
        if (more.getAttribute("aria-expanded") === String(all)) return;
        more.setAttribute("aria-expanded", String(all));
        more.setAttribute("aria-label", all ? "접기" : "더보기");
    };
    more.addEventListener("click", () => {
        page.clicks += 1;
        if (more.getAttribute("aria-expanded") === "true") {
            firstLength = null;
            render(collapsed);
            return;
        }
        render(Math.min(endless ? Infinity : total, list.children.length + step));
        firstLength ??= list.children.length;
    });
    page.refresh = () => render(firstLength ?? collapsed);
    render(collapsed);
    for (const file of ["shared/settings.js", "shared/data.js", "content.js", "features/followingListState.js"]) {
        dom.window.eval(fs.readFileSync(path.join(repo, file), "utf8"));
    }
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    return page;
}

test("following state keeps pressing a kept 더보기 until the whole list is restored, also after a site refresh", async (t) => {
    const chrome = createChrome({ saved: { section: true, list: true } });
    const page = createSteppedPage(t, chrome);
    await until(() => page.more.getAttribute("aria-expanded") === "true");
    assert.equal(page.rows(), 11);
    assert.equal(page.clicks, 3, "one click per step");
    page.refresh();
    assert.equal(page.rows(), 7, "the site's refresh cut the list back");
    await until(() => page.more.getAttribute("aria-expanded") === "true");
    assert.equal(page.rows(), 11);
    assert.equal(page.clicks, 5);
    await wait(80);
    assert.equal(page.clicks, 5);
    assert.equal(chrome.state.writes.length, 0, "restoring does not write new preferences");

    const endless = createSteppedPage(t, createChrome({ saved: { list: true } }), { endless: true });
    await until(() => endless.clicks >= 12);
    await wait(120);
    assert.equal(endless.clicks, 12, "a list that never finishes is pressed a bounded number of times");
});

test("following state resumes a long restore once the click limit runs out, without another list change", async (t) => {
    // The site's shape (2026-10-13 public bundle): 5 rows, 50 more per click, at most 505.
    const shape = { total: 505, step: 50, collapsed: 5 };
    const chrome = createChrome({ saved: { section: true, list: true } });
    const page = createSteppedPage(t, chrome, shape);
    const offChrome = createChrome({ saved: { section: true, list: true } });
    const off = createSteppedPage(t, offChrome, shape);
    await until(() => page.rows() === 505 && off.rows() === 505);
    assert.equal(page.clicks, 10);
    // A refresh right after the restore cuts the list back while the earlier clicks still count.
    page.refresh();
    off.refresh();
    await until(() => page.clicks === 12 && off.clicks === 12);
    await wait(200);
    assert.equal(page.rows(), 155, "the click limit holds the restore for now");
    assert.equal(page.clicks, 12);
    offChrome.state.enable(false);
    await wait(5200);
    await until(() => page.rows() === 505);
    assert.equal(page.more.getAttribute("aria-expanded"), "true");
    assert.equal(page.clicks, 19, "the restore goes on once the limit runs out");
    assert.equal(off.clicks, 12, "turning the feature off cancels the pending restore");
    assert.equal(off.rows(), 155);
    assert.equal(chrome.state.writes.length, 0, "restoring does not write new preferences");
});

test("following state saves only the changed choice over what another tab saved meanwhile", async (t) => {
    const chrome = createChrome({ saved: { section: true, list: true } });
    const first = createPage(t, chrome);
    const second = createPage(t, chrome);
    await until(() => first.model.list && second.model.list);
    first.button("list").click();
    await until(() => chrome.state.local[KEY]?.list === false);
    assert.deepEqual(chrome.state.local[KEY], { section: true, list: false });
    second.button("section").click();
    await until(() => chrome.state.local[KEY]?.section === false);
    await wait();
    assert.deepEqual(chrome.state.local[KEY], { section: false, list: false }, "the other tab's list choice is kept");
    assert.equal(first.model.section, true, "an open tab is not changed by the other tab's choice");
});

test("following state keeps both tabs' choices when their saves read the stored value at the same time", async (t) => {
    const chrome = createChrome({ saved: { section: true, list: true }, deferRead: true });
    const locks = createLockManager();
    const first = createPage(t, chrome, { locks });
    const second = createPage(t, chrome, { locks });
    await until(() => {
        chrome.state.releaseReads();
        return first.model.list && second.model.list;
    });
    first.button("list").click();
    second.button("section").click();
    await until(() => chrome.state.pendingReads.length > 0);
    await wait();
    // Release every read that is waiting now, as if both tabs read before either saved.
    chrome.state.releaseReads();
    await until(() => {
        chrome.state.releaseReads();
        return chrome.state.writes.length === 2;
    });
    await wait();
    assert.deepEqual(chrome.state.local[KEY], { section: false, list: false }, "neither tab's choice is lost");
    assert.equal(first.model.section, true, "an open tab is not changed by the other tab's choice");
});

test("following state writes nothing when it cannot read the latest stored choices", async (t) => {
    const chrome = createChrome({ saved: { section: true, list: true } });
    const page = createPage(t, chrome);
    await until(() => page.model.list);
    // Another tab folded the list meanwhile, and this tab cannot read that.
    chrome.state.local[KEY] = { section: true, list: false };
    chrome.state.failReads = 1;
    page.button("section").click();
    await until(() => chrome.state.failReads === 0);
    await wait(80);
    assert.equal(chrome.state.writes.length, 0, "a failed read does not save this tab's older choices");
    assert.deepEqual(chrome.state.local[KEY], { section: true, list: false });

    page.button("section").click();
    await until(() => chrome.state.writes.length === 1);
    assert.deepEqual(chrome.state.local[KEY], { section: true, list: false }, "the next save merges again");
});
