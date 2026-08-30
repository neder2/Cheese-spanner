const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repoRoot = path.join(__dirname, "..");
const STORAGE_KEY = "betterchzzkPinnedFollowingChannelIds";

function readRepoFile(...parts) {
    return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

function createStorageArea(initialData, runtime) {
    const data = { ...initialData };
    const state = { failNextSet: false };
    return {
        data,
        state,
        get(keys, callback) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                if (Object.hasOwn(data, key)) result[key] = data[key];
            }
            setTimeout(() => callback(result), 0);
        },
        set(values, callback) {
            setTimeout(() => {
                if (state.failNextSet) {
                    state.failNextSet = false;
                    runtime.lastError = { message: "sync write failed" };
                    callback?.();
                    delete runtime.lastError;
                    return;
                }
                Object.assign(data, values || {});
                callback?.();
            }, 0);
        },
    };
}

function createFakeChrome(sync = {}) {
    const runtime = {};
    const syncArea = createStorageArea(sync, runtime);
    const storageChangeListeners = [];
    return {
        runtime,
        storage: {
            sync: syncArea,
            onChanged: {
                addListener(listener) {
                    storageChangeListeners.push(listener);
                },
                removeListener(listener) {
                    const index = storageChangeListeners.indexOf(listener);
                    if (index >= 0) storageChangeListeners.splice(index, 1);
                },
            },
        },
        testState: {
            sync: syncArea.data,
            syncArea,
            storageChangeListeners,
            emitSync(changes) {
                for (const [key, change] of Object.entries(changes)) {
                    if (Object.hasOwn(change || {}, "newValue")) syncArea.data[key] = change.newValue;
                }
                for (const listener of [...storageChangeListeners]) listener(changes, "sync");
            },
        },
    };
}

function createSidebarDom(chrome) {
    const dom = new JSDOM(
        [
            "<!doctype html>",
            "<body>",
            '<header><a id="headerCheese" href="/cheezefarm">헤더 치즈</a></header>',
            '<aside id="sidebar">',
            '<nav id="mainMenu"><ul>',
            '<li><a href="/following">팔로잉</a></li>',
            '<li id="cheeseItem"><a href="/cheezefarm">치즈팜</a></li>',
            "</ul></nav>",
            '<nav id="followingSection">',
            '<header><strong>팔로잉 채널</strong><a href="/following?tab=LIVE">전체보기</a>',
            '<button id="followingRefresh" class="native-icon-button" type="button" aria-label="새로고침"></button>',
            "</header>",
            '<ul id="followingList">',
            '<li id="liveA"><a href="/live/channel-a"><span class="name_text">알파</span></a></li>',
            '<li id="offlineB"><a href="/channel-b"><span class="name_text">베타</span></a></li>',
            '<li id="liveC"><a href="/live/channel-c"><span class="name_text">감마</span></a>',
            '<span id="liveCViewer">321명</span><button id="liveCNativeControl" type="button">메뉴</button></li>',
            "</ul>",
            "</nav>",
            "</aside>",
            '<main><ul><li id="mainLive"><a href="/live/main-channel">본문 방송</a></li></ul></main>',
            "</body>",
        ].join(""),
        {
            url: "https://chzzk.naver.com/lives",
            runScripts: "outside-only",
            pretendToBeVisual: true,
        }
    );
    dom.window.chrome = chrome;
    return dom;
}

function evalRepoScript(dom, ...parts) {
    dom.window.eval(readRepoFile(...parts));
}

function evalSidebarScripts(dom) {
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "shared", "selectors.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "sidebarCustomization.js");
}

function waitForSync(delayMs = 60) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForCondition(predicate, { timeoutMs = 2000, intervalMs = 20 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
        if (predicate()) return;
        await waitForSync(intervalMs);
    }
    assert.fail("Timed out waiting for sidebar customization state");
}

function dispatchClick(dom, element, init = {}) {
    const event = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
    element.dispatchEvent(event);
    return event;
}

function getVisualRowIds(dom, list) {
    return Array.from(list.children)
        .sort(
            (left, right) =>
                Number(dom.window.getComputedStyle(left).order) - Number(dom.window.getComputedStyle(right).order)
        )
        .map((row) => row.id);
}

test("following pins preserve native row DOM and never request a replacement list", async (t) => {
    const savedPins = ["channel-c", "not-rendered-yet"];
    const chrome = createFakeChrome({ [STORAGE_KEY]: savedPins });
    const dom = createSidebarDom(chrome);
    t.after(() => dom.window.close());
    const { document } = dom.window;
    const list = document.getElementById("followingList");
    const nativeRows = Array.from(list.children);
    const nativeElements = Array.from(list.querySelectorAll("*"), (node) => ({
        node,
        parent: node.parentElement,
        className: node.className,
        style: node.getAttribute("style"),
    }));
    let sourceRequests = 0;
    let networkRequests = 0;
    document.addEventListener("betterchzzk:following-source-request", () => sourceRequests++);
    dom.window.fetch = () => {
        networkRequests++;
        throw new Error("Pin sorting must not fetch a replacement list");
    };
    evalSidebarScripts(dom);
    await waitForCondition(() => document.getElementById("liveC").hasAttribute("data-bcsf-pinned"));
    assert.equal(document.getElementById("followingList"), list);
    assert.deepEqual(Array.from(list.children), nativeRows);
    for (const { node, parent, className, style } of nativeElements) {
        assert.equal(node.parentElement, parent);
        assert.equal(node.className, className);
        assert.equal(node.getAttribute("style"), style);
    }
    assert.equal(document.getElementById("liveCViewer").textContent, "321명");
    assert.deepEqual(getVisualRowIds(dom, list), ["liveC", "liveA", "offlineB"]);
    assert.equal(document.getElementById("betterchzzk-following-list"), null);
    assert.equal(document.querySelector("[data-bcsf-native-hidden], [data-bcsf-source-state]"), null);
    assert.equal(sourceRequests, 0);
    assert.equal(networkRequests, 0);
    assert.deepEqual(chrome.testState.sync[STORAGE_KEY], savedPins);
    const manifest = JSON.parse(readRepoFile("manifest.json"));
    assert.ok(manifest.content_scripts.every((entry) => !entry.js.includes("features/followingSnapshotPage.js")));
});

test("offline pins lead their offline group by default and optionally join all pins at the top", async (t) => {
    const pinnedIds = ["channel-h", "channel-d", "channel-b", "channel-a"];
    const chrome = createFakeChrome({ [STORAGE_KEY]: pinnedIds });
    const dom = createSidebarDom(chrome);
    t.after(() => dom.window.close());
    const { document } = dom.window;
    let list = document.getElementById("followingList");
    const nativeIds = ["liveC", "liveA", "liveD", "liveE", "offlineF", "offlineB", "offlineG", "offlineH"];
    list.innerHTML = nativeIds
        .map((id) => {
            const channelId = `channel-${id.slice(-1).toLowerCase()}`;
            const href = `${id.startsWith("live") ? "/live/" : "/"}${channelId}`;
            return `<li id="${id}"><a href="${href}"><span class="name_text">${id}</span></a></li>`;
        })
        .join("");
    const nativeNodes = Array.from(list.children);
    const defaultOrder = ["liveA", "liveD", "liveC", "liveE", "offlineB", "offlineH", "offlineF", "offlineG"];
    const allPinsOrder = ["liveA", "liveD", "offlineB", "offlineH", "liveC", "liveE", "offlineF", "offlineG"];

    evalSidebarScripts(dom);
    await waitForCondition(() => document.getElementById("liveA").hasAttribute("data-bcsf-pinned"));
    assert.deepEqual(getVisualRowIds(dom, list), defaultOrder);
    assert.deepEqual(Array.from(list.children), nativeNodes, "sorting must not move React-owned nodes");
    assert.equal(document.getElementById("betterchzzk-following-pin-mode").getAttribute("aria-pressed"), "false");

    chrome.testState.emitSync({ followingPinOfflineToTopEnabled: { newValue: true } });
    await waitForCondition(() => getVisualRowIds(dom, list).join() === allPinsOrder.join());
    assert.deepEqual(getVisualRowIds(dom, list), allPinsOrder, "pins retain native relative order, not storage order");
    assert.deepEqual(Array.from(list.children), nativeNodes);
    assert.deepEqual(chrome.testState.sync[STORAGE_KEY], pinnedIds, "the option must not rewrite saved pins");

    chrome.testState.emitSync({ followingPinOfflineToTopEnabled: { newValue: false } });
    await waitForCondition(() => getVisualRowIds(dom, list).join() === defaultOrder.join());
    document.querySelector("#liveA a").href = "/channel-a";
    const endedOrder = ["liveD", "liveC", "liveE", "liveA", "offlineB", "offlineH", "offlineF", "offlineG"];
    await waitForCondition(() => getVisualRowIds(dom, list).join() === endedOrder.join());
    document.querySelector("#offlineH a").href = "/live/channel-h";
    const startedOrder = ["liveD", "offlineH", "liveC", "liveE", "liveA", "offlineB", "offlineF", "offlineG"];
    await waitForCondition(() => getVisualRowIds(dom, list).join() === startedOrder.join());

    chrome.testState.emitSync({ [STORAGE_KEY]: { newValue: ["channel-a", "channel-d", "channel-h"] } });
    const unpinnedOrder = ["liveD", "offlineH", "liveC", "liveE", "liveA", "offlineF", "offlineB", "offlineG"];
    await waitForCondition(() => getVisualRowIds(dom, list).join() === unpinnedOrder.join());
    document.querySelector("#liveA a").href = "/channel-z";
    const reusedOrder = ["liveD", "offlineH", "liveC", "liveE", "liveA", "offlineF", "offlineB", "offlineG"];
    await waitForCondition(() => !document.getElementById("liveA").hasAttribute("data-bcsf-pinned"));
    assert.deepEqual(getVisualRowIds(dom, list), reusedOrder);

    const remountedList = list.cloneNode(true);
    list.replaceWith(remountedList);
    list = remountedList;
    dom.window.history.pushState({}, "", "/following");
    chrome.testState.emitSync({ [STORAGE_KEY]: { newValue: ["channel-z", "channel-b"] } });
    const remountedOrder = ["liveC", "liveD", "liveE", "offlineH", "liveA", "offlineB", "offlineF", "offlineG"];
    await waitForCondition(() => getVisualRowIds(dom, list).join() === remountedOrder.join());
    chrome.testState.emitSync({ followingPinEnabled: { newValue: false } });
    await waitForCondition(() => !list.hasAttribute("data-bcsf-list"));
    assert.deepEqual(getVisualRowIds(dom, list), nativeIds, "disabling restores the native order");
    assert.equal(document.querySelector("[data-bcsf-order-group]"), null);

    chrome.testState.emitSync({
        followingPinEnabled: { newValue: true },
        followingPinOfflineToTopEnabled: { newValue: true },
    });
    const restoredOrder = ["liveA", "offlineB", "liveC", "liveD", "liveE", "offlineH", "offlineF", "offlineG"];
    await waitForCondition(() => getVisualRowIds(dom, list).join() === restoredOrder.join());
    assert.deepEqual(
        Array.from(list.children, (row) => row.id),
        nativeIds
    );
});

test("offline pin ordering also handles offline-only lists and a persisted top option", async (t) => {
    for (const offlineToTop of [false, true]) {
        await t.test(`stored top option: ${offlineToTop}`, async (t) => {
            const chrome = createFakeChrome({
                followingPinOfflineToTopEnabled: offlineToTop,
                [STORAGE_KEY]: ["channel-b", "channel-c"],
            });
            const dom = createSidebarDom(chrome);
            t.after(() => dom.window.close());
            const { document } = dom.window;
            const list = document.getElementById("followingList");
            document.querySelector("#liveA a").href = "/channel-a";
            document.querySelector("#liveC a").href = "/channel-c";
            evalSidebarScripts(dom);
            await waitForCondition(() => document.getElementById("offlineB").hasAttribute("data-bcsf-pinned"));
            assert.deepEqual(getVisualRowIds(dom, list), ["offlineB", "liveC", "liveA"]);

            document.querySelector("#liveA a").href = "/live/channel-a";
            await waitForCondition(
                () => document.getElementById("liveA").getAttribute("data-bcsf-order-group") === "live"
            );
            assert.deepEqual(
                getVisualRowIds(dom, list),
                offlineToTop ? ["offlineB", "liveC", "liveA"] : ["liveA", "offlineB", "liveC"]
            );
            chrome.testState.emitSync({ [STORAGE_KEY]: { newValue: [] } });
            await waitForCondition(() => !document.querySelector("[data-bcsf-pinned]"));
            assert.deepEqual(getVisualRowIds(dom, list), ["liveA", "offlineB", "liveC"]);
        });
    }
});

test("sidebar customization scopes cheese hiding and exposes pin mode beside native refresh", async (t) => {
    const fillers = Array.from({ length: 62 }, (_, index) => `filler-${index}`);
    const chrome = createFakeChrome({
        sidebarCheeseFarmHidden: true,
        followingPinEnabled: true,
        [STORAGE_KEY]: ["channel-a", "channel-b", ...fillers, "channel-c", "channel-a", null],
    });
    const dom = createSidebarDom(chrome);
    t.after(() => dom.window.close());

    evalSidebarScripts(dom);
    await waitForCondition(() => dom.window.document.getElementById("followingList")?.hasAttribute("data-bcsf-list"));

    const { document } = dom.window;
    const style = document.getElementById("betterchzzk-sidebar-customization-style");
    const list = document.getElementById("followingList");
    const liveA = document.getElementById("liveA");
    const offlineB = document.getElementById("offlineB");
    const liveC = document.getElementById("liveC");
    const refreshButton = document.getElementById("followingRefresh");
    const modeButton = document.getElementById("betterchzzk-following-pin-mode");

    assert.equal(document.documentElement.getAttribute("data-bcsf-cheese-hidden"), "1");
    assert.match(style.textContent, /#sidebar a\[href="\/cheezefarm"\]/);
    assert.doesNotMatch(style.textContent, /#sidebar nav:has/);
    assert.equal(document.getElementById("headerCheese").closest("#sidebar"), null);
    assert.equal(list.getAttribute("data-bcsf-list"), "1");
    assert.equal(document.querySelector("[data-bcsf-pin-button]"), null);
    assert.equal(modeButton.nextElementSibling, refreshButton);
    assert.equal(modeButton.className, refreshButton.className);
    assert.equal(modeButton.getAttribute("aria-pressed"), "false");
    assert.match(modeButton.getAttribute("aria-label"), /고정 모드 켜기/);
    assert.equal(liveA.getAttribute("data-bcsf-order-group"), "pinned");
    assert.equal(liveA.getAttribute("data-bcsf-pinned"), "1");
    assert.equal(offlineB.getAttribute("data-bcsf-order-group"), "offline-pinned");
    assert.equal(offlineB.getAttribute("data-bcsf-pinned"), "1");
    assert.equal(liveC.getAttribute("data-bcsf-order-group"), "live", "the normalized pin list is capped at 64");
    assert.deepEqual(
        Array.from(list.children, (row) => row.id),
        ["liveA", "offlineB", "liveC"],
        "React-owned rows must not be moved"
    );
    assert.deepEqual(getVisualRowIds(dom, list), ["liveA", "liveC", "offlineB"]);
    assert.match(style.textContent, /data-bcsf-pin-mode[^}]+data-bcsf-pinned/s);
    assert.match(style.textContent, /#087a4b/);

    liveA.querySelector("a").setAttribute("role", "link");
    modeButton.click();
    await waitForCondition(() => list.getAttribute("data-bcsf-pin-mode") === "1");
    assert.equal(modeButton.getAttribute("aria-pressed"), "true");
    assert.match(modeButton.getAttribute("aria-label"), /고정 모드 끄기/);
    assert.equal(liveA.querySelector("a").getAttribute("role"), "button");
    assert.equal(liveA.querySelector("a").getAttribute("aria-pressed"), "true");
    assert.equal(liveC.querySelector("a").getAttribute("aria-pressed"), "false");

    modeButton.click();
    await waitForCondition(() => !list.hasAttribute("data-bcsf-pin-mode"));
    assert.equal(liveA.querySelector("a").getAttribute("role"), "link");
    assert.equal(liveA.querySelector("a").hasAttribute("aria-pressed"), false);

    refreshButton.remove();
    await waitForCondition(() => !document.getElementById("betterchzzk-following-pin-mode"));
    assert.equal(
        document.querySelector("[data-bcsf-pin-mode-button]"),
        null,
        "no fallback mounts without native refresh"
    );

    chrome.testState.emitSync({ sidebarCheeseFarmHidden: { oldValue: true, newValue: false } });
    await waitForCondition(() => !document.documentElement.hasAttribute("data-bcsf-cheese-hidden"));
    assert.equal(document.documentElement.hasAttribute("data-bcsf-cheese-hidden"), false);
    assert.ok(document.getElementById("betterchzzk-sidebar-customization-style"), "pin styles stay installed");
});

test("following pins persist, sync across tabs, survive remounts, and clean up when disabled", async (t) => {
    const chrome = createFakeChrome({ followingPinEnabled: true, [STORAGE_KEY]: [] });
    const dom = createSidebarDom(chrome);
    t.after(() => dom.window.close());

    evalSidebarScripts(dom);
    await waitForCondition(() => dom.window.document.getElementById("betterchzzk-following-pin-mode"));

    const { document } = dom.window;
    const liveCLink = document.querySelector("#liveC a");
    const liveCViewer = document.getElementById("liveCViewer");
    const liveCNativeControl = document.getElementById("liveCNativeControl");
    let nativeClicks = 0;
    let rowClicks = 0;
    let lastNativeDefaultPrevented = null;
    liveCLink.addEventListener("click", (event) => {
        nativeClicks += 1;
        lastNativeDefaultPrevented = event.defaultPrevented;
        event.preventDefault();
    });
    document.getElementById("liveC").addEventListener("click", () => {
        rowClicks += 1;
    });

    dispatchClick(dom, liveCLink);
    assert.equal(nativeClicks, 1);
    assert.equal(rowClicks, 1);
    assert.equal(lastNativeDefaultPrevented, false, "pin mode off keeps native channel navigation");
    assert.deepEqual(Array.from(chrome.testState.sync[STORAGE_KEY]), []);

    document.getElementById("betterchzzk-following-pin-mode").click();
    await waitForCondition(() => document.getElementById("followingList").hasAttribute("data-bcsf-pin-mode"));
    dispatchClick(dom, liveCViewer);
    await waitForCondition(() => chrome.testState.sync[STORAGE_KEY]?.includes("channel-c"));

    assert.deepEqual(Array.from(chrome.testState.sync[STORAGE_KEY]), ["channel-c"]);
    assert.equal(nativeClicks, 1, "pin mode clicks must not reach the native following link");
    assert.equal(rowClicks, 1, "viewer-count clicks must be intercepted at the verified following row");
    assert.equal(document.getElementById("betterchzzk-following-pin-mode").getAttribute("aria-pressed"), "true");
    assert.equal(document.getElementById("liveC").getAttribute("data-bcsf-order-group"), "pinned");

    dispatchClick(dom, liveCLink, { ctrlKey: true });
    dispatchClick(dom, liveCLink, { button: 1 });
    assert.equal(nativeClicks, 3, "modified and middle clicks keep native navigation");
    assert.deepEqual(Array.from(chrome.testState.sync[STORAGE_KEY]), ["channel-c"]);

    dispatchClick(dom, liveCNativeControl);
    assert.equal(rowClicks, 4, "native row controls keep their own click path");
    assert.deepEqual(Array.from(chrome.testState.sync[STORAGE_KEY]), ["channel-c"]);

    dispatchClick(dom, liveCLink, { detail: 0 });
    await waitForCondition(() => !chrome.testState.sync[STORAGE_KEY]?.includes("channel-c"));
    dispatchClick(dom, liveCLink, { detail: 0 });
    await waitForCondition(() => chrome.testState.sync[STORAGE_KEY]?.includes("channel-c"));
    assert.equal(document.getElementById("betterchzzk-following-pin-mode").getAttribute("aria-pressed"), "true");

    const offlineLink = document.querySelector("#offlineB a");
    offlineLink.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    await waitForCondition(() => chrome.testState.sync[STORAGE_KEY]?.includes("channel-b"));
    assert.equal(document.getElementById("offlineB").getAttribute("data-bcsf-order-group"), "offline-pinned");
    assert.equal(document.getElementById("offlineB").getAttribute("data-bcsf-pinned"), "1");

    chrome.testState.emitSync({
        [STORAGE_KEY]: { oldValue: ["channel-c", "channel-b"], newValue: ["channel-a", "channel-b"] },
    });
    await waitForCondition(() => document.getElementById("liveA").getAttribute("data-bcsf-order-group") === "pinned");

    assert.equal(document.getElementById("liveA").getAttribute("data-bcsf-order-group"), "pinned");
    assert.equal(document.getElementById("offlineB").getAttribute("data-bcsf-order-group"), "offline-pinned");
    assert.equal(document.querySelector("#liveC a").getAttribute("aria-pressed"), "false");

    const reusedLink = document.querySelector("#liveA a");
    reusedLink.setAttribute("href", "/live/channel-z");
    await waitForCondition(() => document.getElementById("liveA").getAttribute("data-bcsf-channel-id") === "channel-z");
    assert.equal(document.getElementById("liveA").getAttribute("data-bcsf-channel-id"), "channel-z");
    assert.equal(document.getElementById("liveA").getAttribute("data-bcsf-order-group"), "live");

    document.getElementById("followingSection").innerHTML = [
        '<header><strong>팔로잉 채널</strong><a href="/following">전체보기</a>',
        '<button id="followingRefresh2" class="replacement-icon-button" type="button" aria-label="새로고침"></button>',
        "</header>",
        '<ul id="followingList2"><li id="remountedA">',
        '<a href="/live/channel-a"><span class="name_text">알파</span></a>',
        "</li></ul>",
    ].join("");
    await waitForCondition(
        () => document.getElementById("betterchzzk-following-pin-mode")?.nextElementSibling?.id === "followingRefresh2"
    );
    assert.equal(document.getElementById("betterchzzk-following-pin-mode").className, "replacement-icon-button");
    assert.equal(document.getElementById("betterchzzk-following-pin-mode").getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector("#remountedA a").getAttribute("aria-pressed"), "true");
    assert.equal(document.getElementById("remountedA").getAttribute("data-bcsf-order-group"), "pinned");

    chrome.testState.emitSync({ followingPinEnabled: { oldValue: true, newValue: false } });
    await waitForCondition(() => !document.getElementById("betterchzzk-following-pin-mode"));
    assert.equal(document.querySelector("[data-bcsf-pin-mode-button]"), null);
    assert.equal(document.querySelector("[data-bcsf-list]"), null);
    assert.equal(document.querySelector("[data-bcsf-row]"), null);
    assert.equal(document.querySelector("[data-bcsf-pin-target]"), null);
    assert.equal(document.querySelector("#remountedA a").hasAttribute("role"), false);
    assert.equal(document.querySelector("#remountedA a").hasAttribute("aria-pressed"), false);
    assert.equal(document.getElementById("betterchzzk-sidebar-customization-style"), null);
    assert.deepEqual(Array.from(chrome.testState.sync[STORAGE_KEY]), ["channel-a", "channel-b"]);
});

test("pinned status icons follow channel names outside edit mode and track row updates", async (t) => {
    const chrome = createFakeChrome({ followingPinEnabled: true, [STORAGE_KEY]: ["channel-a", "channel-b"] });
    const dom = createSidebarDom(chrome);
    t.after(() => dom.window.close());
    const { document } = dom.window;
    const iconSelector = "[data-bcsf-pin-indicator]";
    const liveA = document.getElementById("liveA");
    const offlineB = document.getElementById("offlineB");
    const liveC = document.getElementById("liveC");
    const nameA = liveA.querySelector(".name_text");
    const nameB = offlineB.querySelector(".name_text");
    const nameC = liveC.querySelector(".name_text");
    const viewer = document.getElementById("liveCViewer");

    evalSidebarScripts(dom);
    await waitForCondition(() => liveA.getAttribute("data-bcsf-order-group") === "pinned");
    const modeButton = document.getElementById("betterchzzk-following-pin-mode");
    const iconA = liveA.querySelector(iconSelector);
    assert.ok(iconA, "pinned live channels show a status icon without entering edit mode");
    assert.equal(nameA.lastChild, iconA, "the icon stays inside the native name line");
    assert.equal(nameA.textContent, "알파", "the native name and tooltip text stay unchanged");
    assert.equal(iconA.tagName, "SPAN");
    assert.equal(iconA.getAttribute("role"), "img");
    assert.equal(iconA.getAttribute("aria-label"), "고정됨");
    assert.equal(iconA.hasAttribute("tabindex"), false, "status is not another interactive control");
    assert.equal(iconA.querySelector("svg").getAttribute("aria-hidden"), "true");
    assert.equal(nameB.lastChild, offlineB.querySelector(iconSelector), "offline pins show the same status");
    assert.equal(document.querySelectorAll(iconSelector).length, 2);
    assert.equal(modeButton.getAttribute("aria-pressed"), "false");
    assert.equal(liveC.querySelector(iconSelector), null);
    assert.equal(document.querySelector("main").querySelector(iconSelector), null);
    const iconStyle = dom.window.getComputedStyle(iconA);
    assert.equal(iconStyle.display, "inline-flex");
    assert.notEqual(iconStyle.position, "absolute", "status must not overlay the viewer count");
    assert.equal(iconStyle.flexShrink, "0");

    let nativeClicks = 0;
    liveA.querySelector("a").addEventListener("click", (event) => {
        nativeClicks += 1;
        event.preventDefault();
    });
    dispatchClick(dom, iconA);
    assert.equal(nativeClicks, 1, "status keeps normal navigation while edit mode is off");
    modeButton.click();
    await waitForCondition(() => modeButton.getAttribute("aria-pressed") === "true");
    assert.equal(liveA.querySelector(iconSelector), iconA, "mode changes do not duplicate or replace icons");
    dispatchClick(dom, iconA);
    await waitForCondition(() => !liveA.querySelector(iconSelector));
    assert.equal(nativeClicks, 1, "status clicks in edit mode unpin without navigating");
    assert.deepEqual(Array.from(chrome.testState.sync[STORAGE_KEY]), ["channel-b"]);
    modeButton.click();
    await waitForCondition(() => modeButton.getAttribute("aria-pressed") === "false");
    assert.equal(document.querySelectorAll(iconSelector).length, 1);

    chrome.testState.emitSync({ [STORAGE_KEY]: { newValue: ["channel-c"] } });
    await waitForCondition(() => liveC.querySelector(iconSelector));
    assert.equal(offlineB.querySelector(iconSelector), null);
    assert.equal(nameC.lastChild, liveC.querySelector(iconSelector));
    assert.equal(document.getElementById("liveCViewer"), viewer);
    assert.equal(viewer.textContent, "321명");

    liveC.querySelector("a").href = "/live/channel-z";
    await waitForCondition(() => !liveC.querySelector(iconSelector));
    chrome.testState.emitSync({ [STORAGE_KEY]: { newValue: ["channel-z"] } });
    await waitForCondition(() => liveC.querySelector(iconSelector));
    const replacementName = document.createElement("span");
    replacementName.className = "name_text";
    replacementName.textContent = "새 채널";
    nameC.replaceWith(replacementName);
    await waitForCondition(() => replacementName.lastChild === liveC.querySelector(iconSelector));
    assert.equal(liveC.querySelectorAll(iconSelector).length, 1);
    replacementName.remove();
    await waitForCondition(() => !liveC.querySelector(iconSelector));
    liveC.querySelector("a").append(replacementName);
    await waitForCondition(() => liveC.querySelector(iconSelector));

    chrome.testState.emitSync({ followingPinEnabled: { newValue: false } });
    await waitForCondition(() => !document.querySelector(iconSelector));
    assert.equal(liveC.querySelector(".name_text"), replacementName, "cleanup preserves native name nodes");
    chrome.testState.emitSync({ followingPinEnabled: { newValue: true } });
    await waitForCondition(() => liveC.querySelector(iconSelector));
    assert.equal(document.querySelectorAll(iconSelector).length, 1);
    assert.equal(document.getElementById("betterchzzk-following-pin-mode").getAttribute("aria-pressed"), "false");
});

test("native flex name lines keep the status icon inside the line after badges", async (t) => {
    const chrome = createFakeChrome({ [STORAGE_KEY]: ["pinned-short", "pinned-long"] });
    const dom = new JSDOM(readRepoFile("tests", "fixtures", "sidebar-pin-layout.html"), {
        url: "https://chzzk.naver.com/lives",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    dom.window.chrome = chrome;
    t.after(() => dom.window.close());
    const { document } = dom.window;
    const names = Array.from(document.querySelectorAll("#sidebar .name"));
    const nativeChildren = names.map((name) => Array.from(name.children));
    evalSidebarScripts(dom);
    await waitForCondition(() => document.querySelectorAll("[data-bcsf-pin-indicator]").length === 2);
    for (let index = 0; index < names.length; index += 1) {
        const name = names[index];
        const icon = name.querySelector("[data-bcsf-pin-indicator]");
        assert.ok(icon);
        assert.equal(icon.previousElementSibling, name.querySelector(".badge"));
        assert.equal(dom.window.getComputedStyle(name).display, "flex");
        assert.equal(dom.window.getComputedStyle(name).alignItems, "center");
        assert.equal(name.nextElementSibling.className, "description");
        assert.deepEqual(Array.from(name.children).slice(0, -1), nativeChildren[index]);
    }
    chrome.testState.emitSync({ followingPinEnabled: { newValue: false } });
    await waitForCondition(() => !document.querySelector("[data-bcsf-pin-indicator]"));
    names.forEach((name, index) => assert.deepEqual(Array.from(name.children), nativeChildren[index]));
});

test("a failed sync write rolls the optimistic pin state back", async (t) => {
    const chrome = createFakeChrome({ followingPinEnabled: true, [STORAGE_KEY]: [] });
    const dom = createSidebarDom(chrome);
    const warnings = [];
    dom.window.console.warn = (...args) => warnings.push(args.join(" "));
    t.after(() => dom.window.close());

    evalSidebarScripts(dom);
    await waitForCondition(() => dom.window.document.getElementById("betterchzzk-following-pin-mode"));
    const { document } = dom.window;
    document.getElementById("betterchzzk-following-pin-mode").click();
    await waitForCondition(() => document.querySelector("#liveA a").getAttribute("role") === "button");
    chrome.testState.syncArea.state.failNextSet = true;
    dispatchClick(dom, document.querySelector("#liveA a"));
    await waitForCondition(() => warnings.some((message) => message.includes("고정 저장 실패")));

    assert.deepEqual(Array.from(chrome.testState.sync[STORAGE_KEY]), []);
    assert.equal(document.querySelector("#liveA a").getAttribute("aria-pressed"), "false");
    assert.equal(document.getElementById("liveA").getAttribute("data-bcsf-order-group"), "live");
    assert.equal(document.querySelector("#liveA [data-bcsf-pin-indicator]"), null);
    assert.equal(
        warnings.some((message) => message.includes("고정 저장 실패")),
        true
    );
});

test("pin mode does not intercept the native following refresh control", async (t) => {
    const chrome = createFakeChrome({ followingPinEnabled: true, followingRefreshSeconds: 10 });
    const dom = createSidebarDom(chrome);
    const intervals = [];
    dom.window.setInterval = (fn, ms) => {
        intervals.push({ fn, ms });
        return intervals.length;
    };
    dom.window.clearInterval = () => {};
    t.after(() => dom.window.close());

    let refreshClicks = 0;
    dom.window.document.getElementById("followingRefresh").addEventListener("click", () => {
        refreshClicks += 1;
    });
    evalSidebarScripts(dom);
    evalRepoScript(dom, "features", "followingRefresh.js");
    await waitForCondition(() => dom.window.document.getElementById("betterchzzk-following-pin-mode"));

    dom.window.document.getElementById("betterchzzk-following-pin-mode").click();
    await waitForCondition(
        () =>
            dom.window.document.getElementById("betterchzzk-following-pin-mode").getAttribute("aria-pressed") === "true"
    );
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].ms, 10000);
    intervals[0].fn();

    assert.equal(refreshClicks, 1);
    assert.equal(
        dom.window.document.getElementById("betterchzzk-following-pin-mode").getAttribute("aria-pressed"),
        "true"
    );
});
