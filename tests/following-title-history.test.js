const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repoRoot = path.join(__dirname, "..");
const STORAGE_KEY = "betterchzzkFollowingLiveTitleHistory";
const openDoms = new Set();

test.afterEach(() => {
    for (const dom of openDoms) {
        const chrome = dom.window.chrome;
        if (chrome?.testState) {
            chrome.testState.sync.followingTitleHistoryEnabled = false;
            for (const listener of [...chrome.testState.storageChangeListeners]) {
                listener({ followingTitleHistoryEnabled: { oldValue: true, newValue: false } }, "sync");
            }
        }
        dom.window.close();
    }
    openDoms.clear();
});

function readRepoFile(...parts) {
    return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

function createStorageArea(initialData = {}) {
    const data = structuredClone(initialData);
    return {
        data,
        get(keys, callback) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                if (Object.hasOwn(data, key)) result[key] = structuredClone(data[key]);
            }
            setTimeout(() => callback(result), 0);
        },
        set(values, callback) {
            Object.assign(data, structuredClone(values || {}));
            setTimeout(() => callback?.(), 0);
        },
    };
}

function createFakeChrome({ local = {}, sync = {} } = {}) {
    const syncArea = createStorageArea({ followingTitleHistoryEnabled: true, ...sync });
    const localArea = createStorageArea(local);
    const storageChangeListeners = [];
    return {
        runtime: {},
        storage: {
            local: localArea,
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
            local: localArea.data,
            storageChangeListeners,
            sync: syncArea.data,
        },
    };
}

function createFollowingDom({ chrome = createFakeChrome(), meta, url = "https://chzzk.naver.com/following?tab=ALL" }) {
    const dom = new JSDOM(
        [
            "<!doctype html><body>",
            '<aside><a href="/live/sidebar-channel">사이드바 채널</a></aside>',
            "<main><section><ul>",
            '<li id="liveCard">',
            '<a class="_thumbnail_card" href="/live/channel-123"><span>LIVE</span></a>',
            '<div class="_wrapper_card"><div class="_area_card">',
            '<a id="liveTitle" class="_title_card" href="/live/channel-123">첫 번째 제목<span class="blind">라이브 엔드로 이동</span></a>',
            '<div class="_name_card"><a href="/channel-123">테스트 채널</a></div>',
            '<div class="_information_card">카테고리</div>',
            "</div></div>",
            "</li>",
            "</ul></section></main>",
            "</body>",
        ].join(""),
        {
            url,
            runScripts: "outside-only",
            pretendToBeVisual: true,
        }
    );
    const state = {
        fetchCount: 0,
        meta: {
            channel: { channelName: "테스트 채널" },
            liveId: "live-1",
            liveTitle: "첫 번째 제목",
            ...meta,
        },
    };
    dom.window.chrome = chrome;
    dom.window.fetch = async (requestUrl) => {
        state.fetchCount += 1;
        assert.match(String(requestUrl), /\/service\/v3\/channels\/channel-123\/live-detail$/);
        return {
            ok: true,
            json: async () => ({ code: 200, content: structuredClone(state.meta) }),
        };
    };
    openDoms.add(dom);
    return { chrome, document: dom.window.document, dom, state };
}

function evalFeatureScripts(dom) {
    dom.window.eval(readRepoFile("shared", "settings.js"));
    dom.window.eval(readRepoFile("shared", "data.js"));
    dom.window.eval(readRepoFile("content.js"));
    dom.window.eval(readRepoFile("features", "followingTitleHistory.js"));
}

function waitForFeature() {
    return new Promise((resolve) => setTimeout(resolve, 100));
}

async function waitFor(predicate, message, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(message);
}

function getStoredEntry(chrome) {
    return chrome.testState.local[STORAGE_KEY]?.entries?.find((entry) => entry.channelId === "channel-123");
}

test("manifest loads following title history after following refresh and before preview", () => {
    const manifest = JSON.parse(readRepoFile("manifest.json"));
    const scripts = manifest.content_scripts.find((entry) =>
        entry.js?.includes("features/followingTitleHistory.js")
    ).js;
    assert.ok(scripts.indexOf("features/followingTitleHistory.js") > scripts.indexOf("features/followingRefresh.js"));
    assert.ok(
        scripts.indexOf("features/followingTitleHistory.js") < scripts.indexOf("features/followingPreviewTooltip.js")
    );
});

test("following live title changes are cached per live and previous titles expand beside the current title", async () => {
    const { chrome, document, dom, state } = createFollowingDom({});
    evalFeatureScripts(dom);
    await waitFor(() => getStoredEntry(chrome), "initial live title was not stored");

    let entry = getStoredEntry(chrome);
    assert.equal(entry.liveId, "live-1");
    assert.deepEqual(
        entry.titleHistory.map((row) => row.title),
        ["첫 번째 제목"]
    );
    assert.equal(document.querySelector("[data-bcfth-toggle]"), null);

    state.meta.liveTitle = "두 번째 제목";
    document.getElementById("liveTitle").firstChild.nodeValue = "두 번째 제목";
    await waitFor(
        () => getStoredEntry(chrome)?.titleHistory?.length === 2 && document.querySelector("button[data-bcfth-toggle]"),
        "changed live title was not stored and rendered"
    );

    entry = getStoredEntry(chrome);
    assert.deepEqual(
        entry.titleHistory.map((row) => row.title),
        ["첫 번째 제목", "두 번째 제목"]
    );
    const titleLink = document.getElementById("liveTitle");
    const button = document.querySelector("button[data-bcfth-toggle]");
    assert.equal(titleLink.nextElementSibling, button);
    assert.equal(button.getAttribute("aria-label"), "이전 방송 제목 1개 보기");
    assert.equal(button.getAttribute("aria-expanded"), "false");

    button.click();
    const panel = document.getElementById("betterchzzk-following-title-history-panel");
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.equal(panel.hidden, false);
    assert.match(panel.textContent, /첫 번째 제목/);
    assert.doesNotMatch(panel.textContent, /두 번째 제목/);
});

test("visible symbol-only title changes keep the previous title toggle", async () => {
    const { chrome, document, dom, state } = createFollowingDom({});
    evalFeatureScripts(dom);
    await waitFor(() => getStoredEntry(chrome), "initial live title was not stored");

    state.meta.liveTitle = "첫 번째 제목 🔴";
    document.getElementById("liveTitle").firstChild.nodeValue = "첫 번째 제목 🔴";

    await waitFor(
        () => getStoredEntry(chrome)?.titleHistory?.length === 2 && document.querySelector("button[data-bcfth-toggle]"),
        "symbol-only title change was not stored and rendered"
    );

    assert.deepEqual(
        getStoredEntry(chrome).titleHistory.map((row) => row.title),
        ["첫 번째 제목", "첫 번째 제목 🔴"]
    );
    assert.equal(
        document.querySelector("button[data-bcfth-toggle]").getAttribute("aria-label"),
        "이전 방송 제목 1개 보기"
    );
});

test("a new live id replaces the previous broadcast title cache", async () => {
    const oldTime = Date.now() - 60_000;
    const chrome = createFakeChrome({
        local: {
            [STORAGE_KEY]: {
                version: 1,
                entries: [
                    {
                        channelId: "channel-123",
                        liveId: "old-live",
                        channelName: "테스트 채널",
                        titleHistory: [
                            { title: "이전 방송 첫 제목", firstSeenAt: oldTime, lastSeenAt: oldTime },
                            { title: "이전 방송 끝 제목", firstSeenAt: oldTime + 1, lastSeenAt: oldTime + 1 },
                        ],
                        updatedAt: oldTime,
                    },
                ],
            },
        },
    });
    const { document, dom } = createFollowingDom({ chrome, meta: { liveId: "new-live" } });
    evalFeatureScripts(dom);
    await waitFor(() => getStoredEntry(chrome)?.liveId === "new-live", "new live id did not replace old cache");

    const entry = getStoredEntry(chrome);
    assert.equal(entry.liveId, "new-live");
    assert.deepEqual(
        entry.titleHistory.map((row) => row.title),
        ["첫 번째 제목"]
    );
    assert.equal(document.querySelector("[data-bcfth-toggle]"), null);
});

test("the feature ignores non-following pages, sidebar links, and disabled state", async () => {
    const outside = createFollowingDom({ url: "https://chzzk.naver.com/lives" });
    evalFeatureScripts(outside.dom);
    await waitForFeature();
    assert.equal(outside.state.fetchCount, 0);
    assert.equal(getStoredEntry(outside.chrome), undefined);

    const chrome = createFakeChrome({ sync: { followingTitleHistoryEnabled: false } });
    const disabled = createFollowingDom({ chrome });
    evalFeatureScripts(disabled.dom);
    await waitForFeature();
    assert.equal(disabled.state.fetchCount, 0);
    assert.equal(disabled.document.querySelector("[data-bcfth-toggle]"), null);
    assert.equal(disabled.document.getElementById("betterchzzk-following-title-history-style"), null);
});
