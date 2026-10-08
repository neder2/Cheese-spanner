const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const {
    createFakeChrome,
    createDom,
    evalRepoScript,
    dispatch,
    queryOption,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

async function fixture(
    t,
    {
        version = "1.4.1",
        popup = false,
        tabUrl = "https://chzzk.naver.com/live/test",
        reply = { ok: true },
        sendError = null,
        forward = null,
        hash = "",
    } = {}
) {
    const chrome = createFakeChrome();
    const calls = { query: [], send: [], close: 0, writes: [] };
    chrome.runtime.getManifest = () => ({ version });
    chrome.runtime.getURL = (file) => `chrome-extension://better-chzzk/${file}`;
    chrome.tabs = {
        getCurrent(callback) {
            callback(popup ? undefined : { id: 9, url: chrome.runtime.getURL("options.html") });
        },
        query(query, callback) {
            calls.query.push(query);
            callback([{ id: 5, url: tabUrl }]);
        },
        sendMessage(...args) {
            calls.send.push(args.slice(0, -1));
            if (sendError) {
                chrome.runtime.lastError = { message: sendError };
                args.at(-1)();
                delete chrome.runtime.lastError;
            } else if (forward) {
                forward(args[1], { id: chrome.runtime.id, url: chrome.runtime.getURL("options.html") }, args.at(-1));
            } else args.at(-1)(reply);
        },
    };
    const set = chrome.storage.sync.set;
    chrome.storage.sync.set = (values, callback) => {
        calls.writes.push(values);
        set(values, callback);
    };
    const dom = createDom("options.html", "options.html", chrome);
    const nativeClose = dom.window.close.bind(dom.window);
    t.after(nativeClose);
    dom.window.close = () => calls.close++;
    dom.reconfigure({ url: chrome.runtime.getURL("options.html") + hash });
    for (const parts of [
        ["shared", "settings.js"],
        ["options.js"],
        ["shared", "updateGuide.js"],
        ["shared", "updateGuideView.js"],
        ["optionsUpdateGuide.js"],
    ])
        evalRepoScript(dom, ...parts);
    await waitForCondition(() => dom.window.document.getElementById("notice").dataset.state === "saved");
    return { dom, chrome, calls, document: dom.window.document, nativeClose };
}

function chzzkPage(t) {
    const dom = new JSDOM('<body><button id="outside">치지직 화면</button></body>', {
        url: "https://chzzk.naver.com/live/test",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const listeners = new Set();
    dom.window.chrome = {
        runtime: {
            id: "better-chzzk",
            getURL: (file) => `chrome-extension://better-chzzk/${file}`,
            getManifest: () => ({ version: "1.4.1" }),
            sendMessage: (_, callback) => callback({ ok: true, show: false }),
            onMessage: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
        },
    };
    dom.window.BetterChzzk = { utils: { startPageChangeDetection: () => () => {} } };
    dom.window.BetterChzzkSettings = {
        getOptions: (callback) => callback({ updateGuideEnabled: false }),
        addOptionsChangeListener: () => () => {},
    };
    // The action popup owns focus while its page receives the manual replay request.
    dom.window.document.hasFocus = () => false;
    dom.window.HTMLElement.prototype.animate = () => ({ currentTime: 0, pause() {}, play() {}, cancel() {} });
    for (const file of ["shared/updateGuide.js", "shared/updateGuideView.js", "features/updateGuide.js"])
        evalRepoScript(dom, file);
    t.after(() => {
        dom.window.BetterChzzk.updateGuide.stop();
        dom.window.close();
    });
    return {
        dom,
        document: dom.window.document,
        forward: (message, sender, callback) => {
            for (const listener of listeners) listener(message, sender, callback);
        },
    };
}

test("new guide option defaults on and manual replay remains usable with an unsaved opt-out", async (t) => {
    const h = await fixture(t, { popup: true });
    const toggle = queryOption(h.document, "updateGuideEnabled");
    assert.ok(toggle.checked);
    toggle.checked = false;
    dispatch(h.dom, toggle, "change");
    h.document.getElementById("updateGuideReplay").click();
    await waitForCondition(() => h.document.getElementById("updateGuideStatus").textContent.includes("열었어요"));
    assert.equal(toggle.checked, false);
    assert.equal(h.document.getElementById("save").disabled, false);
    assert.equal(h.calls.writes.length, 0);
    assert.equal(h.calls.send.length, 1);
    assert.equal(h.calls.close, 0, "opening a guide cannot discard unsaved options");
    assert.equal(h.document.querySelector("[data-bcug-view]"), null);
});

test("standalone options explain where to open the guide and preserve unsaved edits", async (t) => {
    const h = await fixture(t);
    const quality = queryOption(h.document, "autoQualityEnabled");
    quality.checked = false;
    dispatch(h.dom, quality, "change");
    const selectedTab = h.document.querySelector('.tab[aria-selected="true"]').dataset.tab;
    h.document.getElementById("updateGuideReplay").click();
    await waitForCondition(() => h.document.getElementById("updateGuideStatus").textContent.includes("확장 아이콘"));
    assert.equal(h.document.querySelector('.tab[aria-selected="true"]').dataset.tab, selectedTab);
    assert.equal(h.document.querySelector("[data-bcug-view]"), null);
    assert.equal(quality.checked, false);
    assert.equal(h.calls.writes.length, 0);
    assert.equal(h.calls.query.length, 0);
    assert.equal(h.calls.send.length, 0);
    assert.equal(h.calls.close, 0);
});

test("popup replay targets only its active CHZZK top frame and closes only after acknowledgement", async (t) => {
    const h = await fixture(t, { popup: true });
    h.document.getElementById("updateGuideReplay").click();
    await waitForCondition(() => h.calls.close === 1);
    assert.equal(h.calls.send.length, 1);
    const [tab, message, options] = h.calls.send[0];
    assert.equal(tab, 5);
    assert.equal(message.action, "replay");
    assert.equal(message.guideVersion, "1.4.1");
    assert.equal(message.protocol, 1);
    assert.equal(options.frameId, 0);
    assert.equal(h.document.querySelector("[data-bcug-view]"), null);
});

for (const config of [
    { popup: true, reply: { ok: false } },
    { popup: true, reply: null },
    { popup: true, sendError: "Could not establish connection. Receiving end does not exist." },
    { popup: true, tabUrl: "https://chzzk.naver.com.evil.test/" },
]) {
    test(`popup replay reports failure without an options overlay for ${config.tabUrl || config.sendError || JSON.stringify(config.reply)}`, async (t) => {
        const h = await fixture(t, config);
        h.document.getElementById("updateGuideReplay").click();
        await waitForCondition(() => !h.document.getElementById("updateGuideReplay").disabled);
        assert.equal(h.document.querySelector("[data-bcug-view]"), null);
        assert.doesNotMatch(h.document.getElementById("updateGuideStatus").textContent, /열었어요/);
        assert.match(h.document.getElementById("updateGuideStatus").textContent, /다시 눌러/);
        if (config.tabUrl) assert.equal(h.calls.send.length, 0);
        assert.equal(h.calls.writes.length, 0);
        assert.equal(h.calls.close, 0);
    });
}

test("the real page receiver owns the guide after the options popup is closed", async (t) => {
    const page = chzzkPage(t);
    const h = await fixture(t, { popup: true, forward: page.forward });
    h.document.getElementById("updateGuideReplay").click();
    await waitForCondition(() => h.calls.close === 1);
    assert.equal(h.document.querySelector("[data-bcug-view]"), null);
    const guide = page.document.querySelector("[data-bcug-view]");
    assert.ok(guide);
    assert.equal(guide.ownerDocument, page.document);
    assert.equal(guide.querySelectorAll("li").length, 2);
    assert.equal(guide.querySelectorAll("button").length, 1);
    assert.ok(guide.querySelector("[data-bcug-progress]"));
    h.dom.window.dispatchEvent(new h.dom.window.Event("pagehide"));
    h.nativeClose();
    assert.equal(page.document.querySelector("[data-bcug-view]"), guide);
    page.dom.window.dispatchEvent(new page.dom.window.Event("blur"));
    assert.equal(page.document.querySelector("[data-bcug-view]"), guide);
    guide.querySelector("button").click();
    assert.equal(page.document.querySelector("[data-bcug-view]"), null);
});

test("pending replay is sent once and a reply after popup closure cannot reopen UI", async (t) => {
    let reply;
    const h = await fixture(t, { popup: true, forward: (_, __, callback) => (reply = callback) });
    const button = h.document.getElementById("updateGuideReplay");
    button.click();
    button.click();
    await waitForCondition(() => !!reply);
    assert.equal(h.calls.send.length, 1);
    assert.equal(h.calls.close, 0);
    h.dom.window.dispatchEvent(new h.dom.window.Event("pagehide"));
    reply({ ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.document.querySelector("[data-bcug-view]"), null);
    assert.equal(h.calls.close, 0);
});

test("a development 1.4.0 installation cannot replay the future 1.4.1 guide", async (t) => {
    const h = await fixture(t, { version: "1.4.0" });
    assert.equal(h.document.getElementById("updateGuideReplay").disabled, true);
    assert.match(h.document.getElementById("updateGuideStatus").textContent, /이 버전/);
    assert.equal(h.document.querySelector("[data-bcug-view]"), null);
});

for (const [target, option, tab] of [
    ["panels", "chatResizeEnabled", "chat"],
    ["history", null, "history"],
    ["stream", "streamInfoEnabled", "player"],
    ["categories", "categoryToolsExclusionsEnabled", "search-filter"],
]) {
    test(`guide link ${target} survives late group restoration without changing options`, async (t) => {
        const h = await fixture(t, { hash: `#update-guide-${target}` });
        const node = option ? queryOption(h.document, option) : h.document.querySelector('a[href="history.html"]');
        assert.equal(h.document.querySelector('.tab[aria-selected="true"]').dataset.tab, tab);
        assert.equal(node.closest("details").open, true);
        assert.equal(h.calls.writes.length, 0);
        assert.equal(h.dom.window.BetterChzzkOptionsNavigation.showGuideTarget("https://outside.test"), false);
    });
}

test("options sender validation permits only the known page and guide fragments", async (t) => {
    const h = await fixture(t);
    const check = h.dom.window.BetterChzzkSettings.isOptionsPageSender;
    for (const hash of [
        "",
        "#update-guide-panels",
        "#update-guide-history",
        "#update-guide-stream",
        "#update-guide-categories",
    ]) {
        assert.equal(
            check({ id: h.chrome.runtime.id, frameId: 0, url: h.chrome.runtime.getURL("options.html") + hash }),
            true
        );
    }
    for (const url of [
        "https://chzzk.naver.com/options.html",
        h.chrome.runtime.getURL("history.html"),
        h.chrome.runtime.getURL("options.html") + "?redirect=bad",
        h.chrome.runtime.getURL("options.html") + "#bad",
    ]) {
        assert.equal(check({ id: h.chrome.runtime.id, frameId: 0, url }), false);
    }
    assert.equal(check({ id: "other", url: h.chrome.runtime.getURL("options.html") }), false);
    assert.equal(check({ id: h.chrome.runtime.id, frameId: 1, url: h.chrome.runtime.getURL("options.html") }), false);
});
