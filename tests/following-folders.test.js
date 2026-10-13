const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { waitForCondition: waitForSharedCondition } = require("./helpers/wait-for-condition.js");

const repoRoot = path.join(__dirname, "..");
const KEY = "betterchzzk:following-folders:v1";
const LAYER_SELECTOR = "#betterchzzk-following-folders-layer";
const TOAST_SELECTOR = "#betterchzzk-following-folders-toast";
const FOLDER_DRAG_TYPE = "application/x-betterchzzk-following-folder";
const MANAGE_SELECTOR = "#betterchzzk-following-folders-manage";
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const D = "d".repeat(32);
const E = "e".repeat(32);

function readRepoFile(...parts) {
    return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

function folder(id, name, channelIds = [], collapsed = false) {
    return { id, name, channelIds, collapsed };
}

function stateOf(...folders) {
    return { version: 1, folders };
}

function loadPureModule() {
    const context = vm.createContext({});
    vm.runInContext(readRepoFile("shared", "followingFolders.js"), context);
    return context.BetterChzzkFollowingFolders;
}

function plain(value) {
    return clone(value);
}

function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ── 순수 모듈 ───────────────────────────────────────────────────────────

test("parseState accepts only the exact v1 shape and returns a detached copy", () => {
    const Folders = loadPureModule();
    const input = stateOf(folder("games", "게임", [A, B]), folder("talk-1", "토크", [], true));
    const parsed = Folders.parseState(input);
    assert.equal(parsed.ok, true);
    assert.deepEqual(plain(parsed.state), input);
    parsed.state.folders[0].channelIds.push(C);
    assert.deepEqual(input.folders[0].channelIds, [A, B], "parsed state must not alias the stored value");
    assert.deepEqual(plain(Folders.EMPTY_STATE), { version: 1, folders: [] });
    assert.equal(Object.isFrozen(Folders.EMPTY_STATE), true);
    assert.equal(Object.isFrozen(Folders.EMPTY_STATE.folders), true);
    assert.equal(Folders.STORAGE_KEY, KEY);
    assert.equal(Folders.MAX_FOLDERS, 10);
    assert.equal(Folders.MAX_NAME_LENGTH, 20);
    assert.equal(Folders.MAX_ASSIGNMENTS, 150);
    assert.deepEqual(plain(Folders.parseStoredValue(undefined)), { ok: true, state: { version: 1, folders: [] } });
    assert.equal(Folders.parseState(undefined).ok, false, "a missing key is only valid through parseStoredValue");
});

test("parseState rejects malformed, over-limit, and cross-folder values without truncating them", () => {
    const Folders = loadPureModule();
    const base = () => stateOf(folder("games", "게임", [A]));
    const many = (count) => Array.from({ length: count }, (_, index) => index.toString(16).padStart(32, "0"));
    const cases = [
        ["null", null, "invalid-shape"],
        ["array", [], "invalid-shape"],
        ["extra top-level field", { ...base(), revision: 2 }, "invalid-shape"],
        ["missing folders", { version: 1 }, "invalid-shape"],
        ["unsupported version", { ...base(), version: 2 }, "unsupported-version"],
        ["folders not array", { version: 1, folders: {} }, "invalid-shape"],
        ["extra folder field", stateOf({ ...folder("games", "게임"), color: "red" }), "invalid-folder"],
        ["missing collapsed", stateOf({ id: "games", name: "게임", channelIds: [] }), "invalid-folder"],
        ["string collapsed", stateOf({ ...folder("games", "게임"), collapsed: "false" }), "invalid-folder"],
        ["channelIds not array", stateOf({ ...folder("games", "게임"), channelIds: A }), "invalid-folder"],
        ["uppercase folder id", stateOf(folder("Games", "게임")), "invalid-folder-id"],
        ["long folder id", stateOf(folder("a".repeat(25), "게임")), "invalid-folder-id"],
        ["duplicate folder id", stateOf(folder("games", "게임"), folder("games", "토크")), "duplicate-folder-id"],
        ["empty name", stateOf(folder("games", "")), "invalid-name"],
        ["untrimmed name", stateOf(folder("games", " 게임")), "invalid-name"],
        ["21 code point name", stateOf(folder("games", "가".repeat(21))), "invalid-name"],
        ["control character", stateOf(folder("games", "게\u0007임")), "invalid-name"],
        ["line separator", stateOf(folder("games", "게 임")), "invalid-name"],
        ["lone surrogate", stateOf(folder("games", "게\ud800임")), "invalid-name"],
        ["uppercase channel id", stateOf(folder("games", "게임", [A.toUpperCase()])), "invalid-channel-id"],
        ["short channel id", stateOf(folder("games", "게임", ["a".repeat(31)])), "invalid-channel-id"],
        ["non-hex channel id", stateOf(folder("games", "게임", ["channel-a"])), "invalid-channel-id"],
        ["duplicate in one folder", stateOf(folder("games", "게임", [A, A])), "duplicate-channel"],
        [
            "same channel in two folders",
            stateOf(folder("games", "게임", [A]), folder("talk", "토크", [A])),
            "duplicate-channel",
        ],
        [
            "eleven folders",
            stateOf(...Array.from({ length: 11 }, (_, index) => folder(`f${index}`, `폴더 ${index}`))),
            "too-many-folders",
        ],
        [
            "151 assignments",
            stateOf(folder("one", "하나", many(100)), folder("two", "둘", many(151).slice(100))),
            "too-many-assignments",
        ],
    ];
    for (const [label, value, error] of cases) {
        const before = clone(value);
        const result = Folders.parseState(value);
        assert.equal(result.ok, false, label);
        assert.equal(result.error, error, label);
        assert.deepEqual(clone(value), before, `${label} must not be modified`);
    }
});

test("the largest valid state fits under the sync item margin measured with the key", () => {
    const Folders = loadPureModule();
    const ids = Array.from({ length: 150 }, (_, index) => index.toString(16).padStart(32, "f"));
    const folders = Array.from({ length: 10 }, (_, index) =>
        folder(`${index}`.padStart(24, "x"), "😀".repeat(19) + String(index), ids.slice(index * 15, index * 15 + 15))
    );
    const state = stateOf(...folders);
    const parsed = Folders.parseState(state);
    assert.equal(parsed.ok, true, parsed.error);
    const bytes = Buffer.byteLength(KEY, "utf8") + Buffer.byteLength(JSON.stringify(state), "utf8");
    assert.equal(Folders.getStateBytes(parsed.state), bytes);
    assert.ok(bytes <= Folders.MAX_STATE_BYTES && Folders.MAX_STATE_BYTES < 8192, `${bytes} bytes`);
    assert.equal(Folders.parseState(stateOf(folder("games", "😀".repeat(20)))).ok, true, "20 code points");
    assert.equal(Folders.parseState(stateOf(folder("games", "😀".repeat(21)))).ok, false, "21 code points");
});

test("folder names are normalized for input and validated by code points", () => {
    const Folders = loadPureModule();
    assert.equal(Folders.normalizeFolderName("  새   폴더 \n "), "새 폴더");
    assert.equal(Folders.normalizeFolderName("한"), "한", "Hangul jamo are composed with NFC");
    assert.equal(Folders.normalizeFolderName("가".repeat(20)), "가".repeat(20));
    assert.equal(Folders.normalizeFolderName("가".repeat(21)), "");
    assert.equal(Folders.normalizeFolderName("   "), "");
    assert.equal(Folders.normalizeFolderName("a\u0000b"), "");
    assert.equal(Folders.normalizeFolderName("a\ud800"), "");
    assert.equal(Folders.normalizeFolderName(42), "");
    assert.equal(Folders.normalizeFolderName("가".repeat(201)), "");
});

test("individual commands apply to the latest stored value with single membership and limits", () => {
    const Folders = loadPureModule();
    const apply = (raw, command) => plain(Folders.applyCommand(raw, command));
    const raw = stateOf(folder("games", "게임", [A]), folder("talk", "토크", [B]));

    const created = apply(undefined, { type: "create", folderId: "new-1", name: "  새   폴더 " });
    assert.deepEqual(created, { ok: true, changed: true, state: stateOf(folder("new-1", "새 폴더")) });
    assert.equal(apply(raw, { type: "create", folderId: "x", name: "게임" }).error, "duplicate-name");
    assert.equal(apply(raw, { type: "create", folderId: "x", name: "GAMES" }).ok, true);
    assert.equal(
        apply(stateOf(folder("games", "Games")), { type: "create", folderId: "x", name: "games" }).error,
        "duplicate-name"
    );
    assert.equal(apply(raw, { type: "create", folderId: "games", name: "새" }).error, "duplicate-folder-id");
    const full = stateOf(...Array.from({ length: 10 }, (_, index) => folder(`f${index}`, `폴더${index}`)));
    assert.equal(apply(full, { type: "create", folderId: "x", name: "열하나" }).error, "folder-limit");
    assert.equal(apply(raw, { type: "create", folderId: "x", name: " " }).error, "invalid-name");

    assert.equal(apply(raw, { type: "rename", folderId: "talk", name: "게임" }).error, "duplicate-name");
    assert.equal(apply(raw, { type: "rename", folderId: "gone", name: "새" }).error, "folder-not-found");
    assert.deepEqual(apply(raw, { type: "rename", folderId: "games", name: "게임" }).changed, false);
    assert.equal(apply(raw, { type: "rename", folderId: "talk", name: "잡담" }).state.folders[1].name, "잡담");

    assert.deepEqual(apply(raw, { type: "delete", folderId: "gone" }), { ok: true, changed: false, state: raw });
    assert.deepEqual(apply(raw, { type: "delete", folderId: "games" }).state, stateOf(folder("talk", "토크", [B])));

    assert.deepEqual(
        apply(raw, { type: "move", folderId: "talk", offset: -1 }).state.folders.map((item) => item.id),
        ["talk", "games"]
    );
    assert.equal(apply(raw, { type: "move", folderId: "games", offset: -1 }).changed, false);
    assert.equal(apply(raw, { type: "move", folderId: "games", offset: 2 }).error, "invalid-command");

    const moved = apply(raw, { type: "assign", folderId: "talk", channelId: A });
    assert.deepEqual(moved.state, stateOf(folder("games", "게임"), folder("talk", "토크", [B, A])));
    assert.equal(apply(raw, { type: "assign", folderId: "games", channelId: A }).changed, false);
    assert.equal(apply(raw, { type: "assign", folderId: "gone", channelId: C }).error, "folder-not-found");
    assert.equal(apply(raw, { type: "assign", folderId: "games", channelId: "channel-c" }).error, "invalid-channel-id");
    const ids = Array.from({ length: 150 }, (_, index) => index.toString(16).padStart(32, "0"));
    const capped = stateOf(folder("one", "하나", ids.slice(0, 149)), folder("two", "둘", ids.slice(149)));
    assert.equal(apply(capped, { type: "assign", folderId: "one", channelId: C }).error, "assignment-limit");
    assert.equal(apply(capped, { type: "assign", folderId: "one", channelId: ids[149] }).ok, true, "moves keep total");

    // A channel moved elsewhere by another tab is not pulled out of its new folder.
    assert.equal(apply(raw, { type: "unassign", folderId: "games", channelId: B }).changed, false);
    assert.deepEqual(apply(raw, { type: "unassign", folderId: "games", channelId: A }).state.folders[0].channelIds, []);
    assert.equal(apply(raw, { type: "unassign", folderId: "gone", channelId: A }).changed, false);

    const collapsed = apply(raw, { type: "setCollapsed", folderId: "games", collapsed: true });
    assert.equal(collapsed.state.folders[0].collapsed, true);
    assert.equal(apply(raw, { type: "setCollapsed", folderId: "games", collapsed: false }).changed, false);
    assert.equal(apply(raw, { type: "setCollapsed", folderId: "gone", collapsed: true }).error, "folder-not-found");

    for (const command of [
        null,
        { type: "create", folderId: "x", name: "새", extra: true },
        { type: "drop", folderId: "games" },
        { type: "setCollapsed", folderId: "games", collapsed: "yes" },
        { type: "delete", folderId: "Games" },
        { type: "replace", state: raw, expectedState: raw },
    ]) {
        assert.equal(apply(raw, command).ok, false, JSON.stringify(command));
    }
});

test("corrupt stored values block ordinary commands and only an explicit reset replaces them", () => {
    const Folders = loadPureModule();
    const corrupt = { version: 1, folders: "broken" };
    assert.deepEqual(plain(Folders.applyCommand(corrupt, { type: "setCollapsed", folderId: "a", collapsed: true })), {
        ok: false,
        error: "corrupt-state",
        state: null,
    });
    assert.deepEqual(plain(Folders.applyCommand(corrupt, { type: "resetCorrupt" })), {
        ok: true,
        changed: true,
        state: { version: 1, folders: [] },
    });
    const valid = stateOf(folder("games", "게임"));
    assert.deepEqual(plain(Folders.applyCommand(valid, { type: "resetCorrupt" })), {
        ok: false,
        error: "not-corrupt",
        state: valid,
    });
});

test("expected entries round-trip absent and present stored values", () => {
    const Folders = loadPureModule();
    const raw = stateOf(folder("games", "게임"));
    assert.deepEqual(plain(Folders.toExpected(undefined)), { absent: true });
    assert.deepEqual(plain(Folders.toExpected(raw)), { value: raw });
    assert.deepEqual(plain(Folders.fromExpected({ absent: true })), { ok: true });
    assert.equal(Folders.fromExpected({ absent: true }).rawValue, undefined);
    assert.deepEqual(plain(Folders.fromExpected({ value: raw })), { ok: true, rawValue: raw });
    for (const entry of [undefined, null, {}, { absent: false }, { value: raw, absent: true }, { value: undefined }]) {
        assert.equal(Folders.fromExpected(entry).ok, false, JSON.stringify(entry));
    }
    const id = Folders.createFolderId();
    assert.equal(Folders.isValidFolderId(id), true, id);
});

test("shared module stays DOM- and chrome-independent and the feature writes only through settingsStoreSet", () => {
    const shared = stripComments(readRepoFile("shared", "followingFolders.js"));
    for (const name of ["document", "window", "chrome", "navigator", "localStorage", "fetch"]) {
        assert.equal(new RegExp(`\\b${name}\\b`).test(shared), false, `shared module references ${name}`);
    }
    const feature = stripComments(readRepoFile("features", "followingFolders.js"));
    assert.match(feature, /settingsStoreSet\("sync", \{ \[STORAGE_KEY\]: state \}/);
    for (const forbidden of [/storageSet\b/, /\.sync\.set\b/, /\bset\(\s*\{\s*\[STORAGE_KEY\]/, /runtimeSendMessage/]) {
        assert.equal(forbidden.test(feature), false, `feature must not write folders directly: ${forbidden}`);
    }
    const innerHtmlWrites = feature.match(/innerHTML\s*=\s*[^;]+;/g) || [];
    assert.ok(innerHtmlWrites.length > 0);
    // Only frozen static icon markup reaches innerHTML; names and labels always go through textContent.
    for (const write of innerHtmlWrites) assert.match(write, /innerHTML = ICONS(?:\.[a-zA-Z]+|\[icon\]);/);
    assert.match(feature, /const ICONS = Object\.freeze\(/);
});

// ── 콘텐츠 기능 ─────────────────────────────────────────────────────────

function createFakeChrome(initialSync = {}) {
    const runtime = { id: "cheese-spanner-test" };
    const listeners = [];
    const data = clone(initialSync);
    const testState = {
        data,
        listeners,
        getCalls: [],
        directSets: [],
        heldGets: [],
        holdKey: "",
        failGetKey: "",
        emitSync(changes) {
            for (const [key, change] of Object.entries(changes)) {
                if (Object.hasOwn(change, "newValue")) data[key] = clone(change.newValue);
                else delete data[key];
            }
            emit(changes);
        },
        writeOtherTab(values) {
            write(values);
        },
        writeSilently(values) {
            Object.assign(data, clone(values));
        },
    };
    function emit(changes) {
        const payload = {};
        for (const [key, change] of Object.entries(changes)) payload[key] = clone(change);
        setTimeout(() => {
            for (const listener of [...listeners]) listener(clone(payload), "sync");
        }, 0);
    }
    function write(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
            changes[key] = Object.hasOwn(data, key) ? { oldValue: data[key], newValue: value } : { newValue: value };
            data[key] = clone(value);
        }
        emit(changes);
    }
    testState.write = write;
    return {
        runtime,
        storage: {
            sync: {
                get(keys, callback) {
                    const list = Array.isArray(keys) ? keys : [keys];
                    testState.getCalls.push(list);
                    const fail = testState.failGetKey && list.includes(testState.failGetKey);
                    if (fail) testState.failGetKey = "";
                    const snapshot = {};
                    for (const key of list) if (Object.hasOwn(data, key)) snapshot[key] = clone(data[key]);
                    const respond = () => {
                        if (fail) runtime.lastError = { message: "sync read failed" };
                        callback(fail ? {} : snapshot);
                        delete runtime.lastError;
                    };
                    if (testState.holdKey && list.includes(testState.holdKey)) {
                        testState.holdKey = "";
                        testState.heldGets.push(respond);
                        return;
                    }
                    setTimeout(respond, 0);
                },
                set(values, callback) {
                    testState.directSets.push(clone(values));
                    write(values);
                    setTimeout(() => callback?.(), 0);
                },
            },
            onChanged: {
                addListener(listener) {
                    listeners.push(listener);
                },
                removeListener(listener) {
                    const index = listeners.indexOf(listener);
                    if (index >= 0) listeners.splice(index, 1);
                },
            },
        },
        testState,
    };
}

// The integration owner's worker compares expectations inside one lock; this fake keeps that contract.
function installSettingsStore(dom, chrome) {
    const store = { calls: [], conflicts: 0, failNext: "", beforeCompare: null, gate: null, queue: Promise.resolve() };
    dom.window.BetterChzzk.utils.settingsStoreSet = (area, values, expected) => {
        const call = { area, values: clone(values), expected: clone(expected) };
        store.calls.push(call);
        const run = store.queue.then(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (store.gate) await store.gate;
            if (store.failNext) {
                const code = store.failNext;
                store.failNext = "";
                throw Object.assign(new Error(code), { code });
            }
            store.beforeCompare?.(call);
            const data = chrome.testState.data;
            const current = {};
            let conflict = false;
            for (const [key, expectation] of Object.entries(expected || {})) {
                const has = Object.hasOwn(data, key);
                current[key] = has ? { value: clone(data[key]) } : { absent: true };
                const matches =
                    expectation.absent === true
                        ? !has
                        : has && stableStringify(data[key]) === stableStringify(expectation.value);
                if (!matches) conflict = true;
            }
            if (conflict) {
                store.conflicts += 1;
                throw Object.assign(new Error("conflict"), { code: "conflict", current });
            }
            chrome.testState.write(clone(values));
        });
        store.queue = run.catch(() => {});
        return run;
    };
    return store;
}

// Holds every settings-store request until release(), like a busy worker queue.
function holdStore(store) {
    let release;
    store.gate = new Promise((resolve) => {
        release = () => {
            store.gate = null;
            resolve();
        };
    });
    return release;
}

const ROW_ITEMS = [
    `<li id="rowA"><a href="/live/${A}"><span class="name_text">알파</span></a></li>`,
    `<li id="rowB"><a href="/${B}"><span class="name_text">베타</span></a></li>`,
    `<li id="rowC"><a href="/live/${C}"><span class="name_text">감마</span></a></li>`,
    `<li id="rowD"><a href="/${D}"><span class="name_text">델타</span></a></li>`,
    `<li id="rowE"><a href="/live/${E}"><span class="name_text">아주 긴 이름을 가진 엡실론 채널의 방송</span></a></li>`,
];
const ROWS_HTML = ROW_ITEMS.join("");
const COLLAPSED_ROWS = 3;

// collapsedList mimics the site's list (2026-10-13 public bundle, scaled from 5 + 50 per click down to 3 + 1).
function createDom(chrome, { collapsedList = false, ignoreMore = false, longList = false } = {}) {
    const rows = collapsedList ? ROW_ITEMS.slice(0, COLLAPSED_ROWS).join("") : ROWS_HTML;
    const button = collapsedList
        ? '<button id="moreButton" type="button" aria-expanded="false" aria-label="더보기">더보기</button>'
        : '<button id="moreButton" type="button" aria-expanded="true" aria-label="접기">접기</button>';
    const dom = new JSDOM(
        [
            "<!doctype html><html><body>",
            '<aside id="sidebar">',
            '<nav id="mainMenu"><ul><li><a href="/following">팔로잉</a></li></ul></nav>',
            '<nav id="followingSection" aria-label="팔로우">',
            '<header><strong>팔로잉 채널</strong><a href="/following?tab=LIVE">전체보기</a>',
            '<button id="followingRefresh" class="native-icon-button" type="button" aria-label="새로고침"></button>',
            "</header>",
            `<ul id="followingList">${rows}</ul>`,
            button,
            "</nav>",
            "</aside>",
            '<main><ul><li id="mainLive"><a href="/live/main-channel">본문 방송</a></li></ul></main>',
            "</body></html>",
        ].join(""),
        { url: "https://chzzk.naver.com/lives", runScripts: "outside-only", pretendToBeVisual: true }
    );
    dom.window.chrome = chrome;
    if (collapsedList) installNativeList(dom.window.document, { ignoreMore, longList });
    return dom;
}

// Each 더보기 builds the next row and 접기 appears only once every row exists; 접기 drops back to the first rows.
// refreshList() cuts the list back to its length after the first 더보기, like the site's refresh with a stale length.
// longList adds a sixth followed channel that no folder holds, so the list can stay partly built.
function installNativeList(document, { ignoreMore, longList }) {
    const items = longList
        ? [...ROW_ITEMS, `<li id="rowG"><a href="/${"9".repeat(32)}"><span class="name_text">감마2</span></a></li>`]
        : ROW_ITEMS;
    const list = document.getElementById("followingList");
    const more = document.getElementById("moreButton");
    const nativeRows = Array.from(list.children);
    let refreshLength = null;
    const render = (count) => {
        while (nativeRows.length > count) nativeRows.pop().remove();
        while (nativeRows.length < count) {
            const template = document.createElement("template");
            template.innerHTML = items[nativeRows.length];
            const row = template.content.firstElementChild;
            list.append(row);
            nativeRows.push(row);
        }
        // Like React, the button is touched only when its state changes, so a refresh mutates the list alone.
        const all = count === items.length;
        if (more.getAttribute("aria-expanded") === String(all)) return;
        more.setAttribute("aria-expanded", String(all));
        more.setAttribute("aria-label", all ? "접기" : "더보기");
        more.textContent = all ? "접기" : "더보기";
    };
    more.nativeClicks = 0;
    more.addEventListener("click", () => {
        more.nativeClicks += 1;
        if (ignoreMore) return;
        if (nativeRows.length < items.length) {
            render(nativeRows.length + 1);
            refreshLength ??= nativeRows.length;
        } else {
            refreshLength = null;
            render(COLLAPSED_ROWS);
        }
    });
    more.refreshList = () => render(refreshLength ?? COLLAPSED_ROWS);
}

function loadFeature(dom, chrome, { pin = false } = {}) {
    for (const parts of [
        ["features", "routeBridgePage.js"],
        ["shared", "settings.js"],
        ["shared", "data.js"],
        ["shared", "selectors.js"],
        ["content.js"],
        ["shared", "followingFolders.js"],
    ]) {
        dom.window.eval(readRepoFile(...parts));
    }
    if (pin) dom.window.eval(readRepoFile("features", "sidebarCustomization.js"));
    const store = installSettingsStore(dom, chrome);
    dom.window.eval(readRepoFile("features", "followingFolders.js"));
    return store;
}

async function setup(t, sync, options = {}) {
    const chrome = createFakeChrome(sync);
    const dom = createDom(chrome, options);
    t.after(() => dom.window.close());
    const store = loadFeature(dom, chrome, options);
    // Drag previews wait for a short dwell; the feature reads time from performance.now(), so tests step it.
    let now = 1000;
    dom.window.performance.now = () => now;
    const clock = {
        advance(ms) {
            now += ms;
        },
    };
    return { chrome, dom, store, clock, document: dom.window.document, window: dom.window };
}

function waitForCondition(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
    return waitForSharedCondition(predicate, {
        timeoutMs,
        intervalMs,
        message: "Timed out waiting for following folder state",
    });
}

function settle(ms = 60) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// JSDOM marks dispatchEvent() as untrusted; its internal dispatch keeps the flag like a real user event.
function dispatchTrusted(target, event) {
    const impl = Object.getOwnPropertySymbols(event).find((symbol) => symbol.description === "impl");
    event[impl].isTrusted = true;
    target[impl]._dispatch(event[impl]);
    return event;
}

function trustedClick(dom, element) {
    return dispatchTrusted(
        element,
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 })
    );
}

// Keyboard activation focuses the button before the trusted click, unlike JSDOM's dispatch.
function press(dom, element) {
    element.focus();
    return trustedClick(dom, element);
}

function untrustedClick(dom, element) {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    element.click();
}

function trustedKey(dom, element, key) {
    return dispatchTrusted(element, new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function typeText(dom, input, text) {
    input.value = text;
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

function createDataTransfer() {
    return {
        data: {},
        dropEffect: "none",
        effectAllowed: "all",
        setData(type, value) {
            this.data[type] = value;
        },
        getData(type) {
            return this.data[type] || "";
        },
    };
}

function dragEvent(dom, type, target, { trusted = true, dataTransfer = createDataTransfer(), clientY } = {}) {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    if (clientY !== undefined) Object.defineProperty(event, "clientY", { value: clientY });
    if (trusted) dispatchTrusted(target, event);
    else target.dispatchEvent(event);
    return event;
}

// Holds the pointer over a target long enough for the drag preview to follow it.
function hold(dom, clock, target, options = {}) {
    dragEvent(dom, "dragover", target, options);
    clock.advance(200);
    return dragEvent(dom, "dragover", target, options);
}

function storedState(chrome) {
    return clone(chrome.testState.data[KEY]);
}

function header(document, name) {
    return Array.from(document.querySelectorAll("[data-bcff-header]")).find((node) => node.textContent.trim() === name);
}

function headerButton(document, name) {
    return header(document, name)?.querySelector("button") || null;
}

function byLabel(root, label) {
    return (
        Array.from(root.querySelectorAll("button, input, select")).find(
            (node) => (node.getAttribute("aria-label") || node.textContent.trim()) === label
        ) || null
    );
}

function layer(document) {
    return document.querySelector(LAYER_SELECTOR);
}

function toastText(document) {
    return document.querySelector(TOAST_SELECTOR)?.textContent || "";
}

function nameButton(document, name) {
    return header(document, name)?.querySelector(".bcff-name") || null;
}

function moreButton(document, name) {
    return header(document, name)?.querySelector(".bcff-more") || null;
}

function renameInput(document) {
    return document.querySelector("[data-bcff-header] .bcff-rename");
}

function trustedMouse(dom, element, type, detail) {
    return dispatchTrusted(
        element,
        new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail })
    );
}

async function openMenu(dom, document, name) {
    trustedClick(dom, moreButton(document, name));
    await waitForCondition(() => layer(document)?.dataset.kind === "menu");
    return layer(document);
}

async function openPicker(dom, document, name) {
    const menu = await openMenu(dom, document, name);
    press(dom, byLabel(menu, `‘${name}’ 폴더 채널 선택`));
    await waitForCondition(() => layer(document)?.dataset.kind === "picker");
    return layer(document);
}

function visualOrder(dom, list = dom.window.document.getElementById("followingList")) {
    return Array.from(list.children)
        .map((node, index) => {
            const style = dom.window.getComputedStyle(node);
            return { node, index, order: Number(style.order) || 0, hidden: style.display === "none" };
        })
        .filter((entry) => !entry.hidden)
        .sort((left, right) => left.order - right.order || left.index - right.index)
        .map(({ node }) => (node.hasAttribute("data-bcff-header") ? `[${node.textContent.trim()}]` : node.id));
}

function nativeRowIds(list) {
    return Array.from(list.children)
        .filter((node) => !node.hasAttribute("data-bcff-header"))
        .map((node) => node.id);
}

const MARKER_SELECTOR = [
    "[data-bcff-list]",
    "[data-bcff-order]",
    "[data-bcff-hidden]",
    "[data-bcff-channel-id]",
    "[data-bcff-header]",
    "[data-bcff-max-rows]",
    "[data-bcff-manage-button]",
].join(", ");

function markerCount(document) {
    return document.querySelectorAll(MARKER_SELECTOR).length;
}

test("folders stay inactive by default and the max-row limit alone never reads or hides folders", async (t) => {
    const { chrome, dom, document } = await setup(t, {});
    const list = document.getElementById("followingList");
    const originalRows = nativeRowIds(list);
    await settle();
    assert.equal(document.getElementById("betterchzzk-following-folders-style"), null);
    assert.equal(document.querySelector(MANAGE_SELECTOR), null);
    assert.equal(markerCount(document), 0);
    assert.equal(chrome.testState.getCalls.flat().includes(KEY), false);

    chrome.testState.emitSync({ followingListMaxRows: { newValue: 6 } });
    await waitForCondition(() => list.getAttribute("data-bcff-max-rows") === "1");
    const rowsStyle = document.getElementById("betterchzzk-following-folders-rows-style");
    assert.match(rowsStyle.textContent, /max-height:288px!important/, "6 rows × 48px fallback before measurement");
    const baseStyle = document.getElementById("betterchzzk-following-folders-style").textContent;
    const scrollRule = /#sidebar \[data-bcff-max-rows="1"\]\{([^}]*)\}/.exec(baseStyle)?.[1] || "";
    assert.match(scrollRule, /overflow-y:auto!important/);
    assert.doesNotMatch(scrollRule, /overscroll-behavior/, "list scrolling still chains to the sidebar");
    assert.deepEqual(nativeRowIds(list), originalRows, "rows are never moved");
    for (const row of list.children) assert.notEqual(dom.window.getComputedStyle(row).display, "none");
    assert.equal(document.querySelector("[data-bcff-header]"), null);
    assert.equal(document.querySelector(MANAGE_SELECTOR), null);
    assert.equal(chrome.testState.getCalls.flat().includes(KEY), false);

    chrome.testState.emitSync({ followingListMaxRows: { newValue: 0 } });
    await waitForCondition(() => !list.hasAttribute("data-bcff-max-rows"));
    assert.equal(document.getElementById("betterchzzk-following-folders-rows-style"), null);
    assert.equal(document.getElementById("betterchzzk-following-folders-style"), null);
    assert.equal(markerCount(document), 0);
});

test("enabled folders without saved folders add nothing to the sidebar until a channel is dragged", async (t) => {
    const { chrome, document } = await setup(t, { followingFoldersEnabled: true });
    await waitForCondition(() => chrome.testState.getCalls.flat().includes(KEY));
    await settle();
    assert.equal(document.querySelector(MANAGE_SELECTOR), null, "there is no separate new-folder button");
    assert.equal(
        document.getElementById("followingRefresh").nextElementSibling,
        null,
        "nothing is added after refresh"
    );
    assert.equal(
        document.querySelector("[data-bcff-header], [data-bcff-order], [data-bcff-list], [data-bcff-status]"),
        null
    );
});

test("saved folders group native rows with CSS order and follow pin ranks without moving rows", async (t) => {
    const saved = stateOf(folder("games", "게임", [B, C]), folder("talk", "토크", [D], true));
    const { dom, document } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    const list = document.getElementById("followingList");
    const originalRows = nativeRowIds(list);
    await waitForCondition(() => header(document, "폴더 밖 채널"));
    assert.deepEqual(visualOrder(dom), ["[게임]", "rowC", "rowB", "[토크]", "[폴더 밖 채널]", "rowA", "rowE"]);
    assert.deepEqual(nativeRowIds(list), originalRows, "native rows keep their DOM order");
    assert.equal(list.querySelectorAll("a[href]").length, 5, "native rows are not cloned");
    assert.equal(dom.window.getComputedStyle(document.getElementById("rowD")).display, "none");
    assert.equal(headerButton(document, "토크").getAttribute("aria-expanded"), "false");
    assert.equal(headerButton(document, "게임").getAttribute("aria-expanded"), "true");
    assert.equal(headerButton(document, "게임").getAttribute("aria-label"), "게임 폴더 접기");
    assert.equal(headerButton(document, "토크").getAttribute("aria-label"), "토크 폴더 펼치기");
    assert.equal(nameButton(document, "게임").getAttribute("data-bcff-count"), "2");
    assert.equal(header(document, "폴더 밖 채널").querySelector("button"), null);

    // Pinning publishes its rank on the row; folders read it without waiting for the next frame.
    dom.window.requestAnimationFrame = () => 1;
    document.getElementById("rowB").setAttribute("data-bcsf-order-group", "pinned");
    await settle(0);
    assert.deepEqual(visualOrder(dom).slice(0, 3), ["[게임]", "rowB", "rowC"]);
    document.getElementById("rowB").setAttribute("data-bcsf-order-group", "offline-pinned");
    document.getElementById("rowE").setAttribute("data-bcsf-order-group", "pinned");
    await settle(0);
    assert.deepEqual(visualOrder(dom), ["[게임]", "rowC", "rowB", "[토크]", "[폴더 밖 채널]", "rowE", "rowA"]);
});

test("header collapse writes only after trusted clicks with the previous raw value as expectation", async (t) => {
    const saved = stateOf(folder("games", "게임", [C]));
    const { chrome, dom, document, store } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    await waitForCondition(() => headerButton(document, "게임"));
    const button = headerButton(document, "게임");
    untrustedClick(dom, button);
    await settle();
    assert.equal(store.calls.length, 0, "synthetic page clicks must not change saved folders");

    trustedClick(dom, button);
    await waitForCondition(() => storedState(chrome).folders[0].collapsed === true);
    assert.equal(store.calls.length, 1);
    assert.deepEqual(store.calls[0], {
        area: "sync",
        values: { [KEY]: stateOf(folder("games", "게임", [C], true)) },
        expected: { [KEY]: { value: saved } },
    });
    await waitForCondition(() => dom.window.getComputedStyle(document.getElementById("rowC")).display === "none");
    assert.equal(headerButton(document, "게임").getAttribute("aria-expanded"), "false");
    assert.deepEqual(chrome.testState.directSets, [], "folders never call chrome.storage.sync.set directly");

    trustedClick(dom, headerButton(document, "게임"));
    await waitForCondition(() => storedState(chrome).folders[0].collapsed === false);
    assert.deepEqual(store.calls[1].expected, { [KEY]: { value: stateOf(folder("games", "게임", [C], true)) } });
});

test("folder channel names leave out verified and achievement badge text and other hidden labels", async (t) => {
    // 2026-10-09 Codex Chrome: names read as "한동숙인증 마크" and "탬탬버린인증 마크치스티벌_배틀그라운드 우승 팀장".
    const saved = stateOf(folder("games", "게임", [B]));
    const { dom, document } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    const nameA = document.querySelector("#rowA .name_text");
    nameA.innerHTML = '한동숙<span class="blind">인증 마크</span>';
    const nameB = document.querySelector("#rowB .name_text");
    nameB.innerHTML =
        '탬탬버린<span class="_icon_official_x"><span class="blind">인증 마크</span></span>' +
        '<span class="_badge_x" role="img"><span class="blind">치스티벌_배틀그라운드 우승 팀장</span></span>' +
        '<span class="_tooltip_x">치스티벌_배틀그라운드 우승 팀장</span>';
    const nameC = document.querySelector("#rowC .name_text");
    nameC.innerHTML = '<span class="ellipsis">감마 <b>채널</b></span><svg aria-hidden="true"><title>장식</title></svg>';
    await waitForCondition(() => headerButton(document, "게임"));
    const picker = await openPicker(dom, document, "게임");
    assert.ok(byLabel(picker, "한동숙 채널을 ‘게임’ 폴더에 넣기"));
    assert.ok(byLabel(picker, "감마 채널 채널을 ‘게임’ 폴더에 넣기"));
    assert.ok(byLabel(picker, "탬탬버린 채널을 ‘게임’ 폴더에서 빼기"), "member names keep only the channel name");
    assert.doesNotMatch(picker.textContent, /인증 마크|우승 팀장|장식/);
});

test("the folder menu renames, reorders, and deletes folders with trusted input and keeps focus in place", async (t) => {
    const saved = stateOf(folder("games", "게임", [C]), folder("talk", "토크"), folder("new", "새 폴더"));
    const { chrome, dom, document, store } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    await waitForCondition(() => headerButton(document, "새 폴더"));

    untrustedClick(dom, moreButton(document, "토크"));
    await settle();
    assert.equal(layer(document), null, "the page cannot open folder menus with synthetic clicks");
    const menu = await openMenu(dom, document, "토크");
    assert.equal(menu.getAttribute("role"), "menu");
    assert.equal(moreButton(document, "토크").getAttribute("aria-expanded"), "true");
    assert.equal(document.activeElement.getAttribute("aria-label"), "‘토크’ 폴더 이름 변경");
    trustedKey(dom, document.activeElement, "ArrowDown");
    assert.equal(document.activeElement.getAttribute("aria-label"), "‘토크’ 폴더 채널 선택");

    press(dom, byLabel(menu, "‘토크’ 폴더 이름 변경"));
    await waitForCondition(() => renameInput(document));
    assert.equal(layer(document), null, "renaming closes the menu");
    const input = renameInput(document);
    assert.equal(document.activeElement, input);
    assert.equal(input.value, "토크");
    typeText(dom, input, "게임");
    trustedKey(dom, input, "Enter");
    await waitForCondition(() => /같은 이름/.test(input.nextElementSibling?.textContent || ""));
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(renameInput(document), input, "a rejected name keeps the field open for editing");
    typeText(dom, input, "  잡담 ");
    trustedKey(dom, input, "Enter");
    await waitForCondition(() => storedState(chrome).folders[1].name === "잡담");
    await waitForCondition(() => !renameInput(document) && nameButton(document, "잡담"));
    assert.equal(document.activeElement, nameButton(document, "잡담"));
    assert.match(toastText(document), /‘토크’ 폴더 이름을 ‘잡담’/);

    let upMenu = await openMenu(dom, document, "잡담");
    untrustedClick(dom, byLabel(upMenu, "‘잡담’ 폴더를 위로 이동"));
    await settle();
    assert.equal(storedState(chrome).folders[0].name, "게임");
    press(dom, byLabel(upMenu, "‘잡담’ 폴더를 위로 이동"));
    await waitForCondition(() => storedState(chrome).folders[0].name === "잡담");
    upMenu = layer(document);
    assert.equal(upMenu?.dataset.kind, "menu", "the menu stays open for further moves");
    assert.equal(byLabel(upMenu, "‘잡담’ 폴더를 위로 이동").disabled, true);
    await waitForCondition(() => document.activeElement?.getAttribute("aria-label") === "‘잡담’ 폴더를 아래로 이동");
    assert.deepEqual(
        visualOrder(dom).filter((entry) => entry.startsWith("[")),
        ["[잡담]", "[게임]", "[새 폴더]", "[폴더 밖 채널]"]
    );
    trustedKey(dom, document.activeElement, "Escape");
    await waitForCondition(() => !layer(document));
    assert.equal(document.activeElement, moreButton(document, "잡담"));

    const callsBeforeDelete = store.calls.length;
    const deleteMenu = await openMenu(dom, document, "새 폴더");
    press(dom, byLabel(deleteMenu, "‘새 폴더’ 폴더 삭제"));
    await settle();
    assert.equal(store.calls.length, callsBeforeDelete, "the first delete press only arms confirmation");
    const confirm = layer(document).querySelector('[data-bcff-key$=":delete"].bcff-danger[data-armed]');
    assert.equal(confirm.textContent, "한 번 더 눌러 삭제");
    assert.equal(document.activeElement, confirm, "arming keeps focus on the delete item");
    press(dom, confirm);
    await waitForCondition(() => storedState(chrome).folders.length === 2);
    await waitForCondition(() => !header(document, "새 폴더"));
    assert.equal(layer(document), null);
    assert.equal(document.activeElement, nameButton(document, "게임"), "focus moves to the neighboring folder");
    assert.equal(document.querySelectorAll("#followingList a[href]").length, 5, "follows and rows remain");
    assert.equal(store.conflicts, 0);
});

test("the channel picker is the keyboard path to put channels in, move them between folders, and take them out", async (t) => {
    const saved = stateOf(folder("games", "게임", [C]), folder("talk", "토크"));
    const { chrome, dom, document } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    await waitForCondition(() => headerButton(document, "토크"));
    const picker = await openPicker(dom, document, "토크");
    assert.equal(picker.getAttribute("role"), "dialog");
    assert.equal(document.activeElement.getAttribute("aria-label"), "채널 이름으로 찾기");
    const gamma = byLabel(picker, "감마 채널을 ‘토크’ 폴더에 넣기");
    assert.equal(gamma.getAttribute("aria-pressed"), "false");
    assert.match(gamma.textContent, /‘게임’에 있음/);

    untrustedClick(dom, gamma);
    await settle();
    assert.deepEqual(storedState(chrome), saved, "synthetic clicks never move channels");
    press(dom, byLabel(picker, "알파 채널을 ‘토크’ 폴더에 넣기"));
    await waitForCondition(() => storedState(chrome).folders[1].channelIds.includes(A));
    await waitForCondition(() => byLabel(layer(document), "알파 채널을 ‘토크’ 폴더에서 빼기"));
    assert.equal(byLabel(layer(document), "알파 채널을 ‘토크’ 폴더에서 빼기").getAttribute("aria-pressed"), "true");
    assert.equal(document.activeElement, byLabel(layer(document), "알파 채널을 ‘토크’ 폴더에서 빼기"));

    press(dom, byLabel(layer(document), "감마 채널을 ‘토크’ 폴더에 넣기"));
    await waitForCondition(() => storedState(chrome).folders[1].channelIds.includes(C));
    assert.deepEqual(storedState(chrome).folders[0].channelIds, [], "a channel belongs to one folder only");

    const filter = layer(document).querySelector('[data-bcff-key="picker-filter"]');
    typeText(dom, filter, "베타");
    await waitForCondition(() => layer(document).querySelectorAll(".bcff-pick").length === 1);
    typeText(dom, filter, "없는 이름");
    await waitForCondition(() => /찾는 채널이 없어요/.test(layer(document).textContent));
    typeText(dom, filter, "");

    press(dom, byLabel(layer(document), "알파 채널을 ‘토크’ 폴더에서 빼기"));
    await waitForCondition(() => !storedState(chrome).folders[1].channelIds.includes(A));
    trustedKey(dom, layer(document).querySelector('[data-bcff-key="picker-filter"]'), "Escape");
    await waitForCondition(() => !layer(document));
    assert.equal(document.activeElement, moreButton(document, "토크"));
});

test("arrow clicks and keyboard collapse at once, name clicks wait for a possible double click, and F2 renames", async (t) => {
    const saved = stateOf(folder("games", "게임", [C]), folder("talk", "토크", [A]));
    const { chrome, dom, document, store } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    await waitForCondition(() => headerButton(document, "게임"));
    assert.equal(headerButton(document, "게임").tabIndex, -1, "the arrow stays out of the tab order");

    trustedMouse(dom, nameButton(document, "게임"), "click", 1);
    await settle(30);
    assert.equal(store.calls.length, 0, "a single name click waits before collapsing");
    await waitForCondition(() => storedState(chrome).folders[0].collapsed === true);
    assert.equal(store.calls.length, 1);

    trustedMouse(dom, nameButton(document, "토크"), "click", 1);
    trustedMouse(dom, nameButton(document, "토크"), "click", 2);
    trustedMouse(dom, nameButton(document, "토크"), "dblclick", 2);
    await waitForCondition(() => renameInput(document));
    await settle(350);
    assert.equal(store.calls.length, 1, "a double click renames without collapsing");
    const input = renameInput(document);
    assert.equal(document.activeElement, input);
    assert.equal(input.selectionStart, 0);
    assert.equal(input.selectionEnd, "토크".length);
    trustedKey(dom, input, "Escape");
    await waitForCondition(() => !renameInput(document));
    assert.equal(document.activeElement, nameButton(document, "토크"));

    trustedMouse(dom, nameButton(document, "토크"), "click", 0);
    await waitForCondition(() => storedState(chrome).folders[1].collapsed === true);
    assert.equal(store.calls.length, 2, "keyboard activation collapses without waiting");

    trustedKey(dom, nameButton(document, "토크"), "F2");
    await waitForCondition(() => renameInput(document));
    typeText(dom, renameInput(document), "잡담");
    renameInput(document).blur();
    await waitForCondition(() => storedState(chrome).folders[1].name === "잡담");

    trustedKey(dom, nameButton(document, "잡담"), "F2");
    await waitForCondition(() => renameInput(document));
    typeText(dom, renameInput(document), "   ");
    renameInput(document).blur();
    await waitForCondition(() => !renameInput(document));
    assert.equal(storedState(chrome).folders[1].name, "잡담", "an empty name on blur keeps the old name");
});

test("the blank space beside a folder name collapses at once like the arrow, but not while renaming", async (t) => {
    const saved = stateOf(folder("games", "게임", [C]), folder("talk", "토크", [A]));
    const { chrome, dom, document, store } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    await waitForCondition(() => headerButton(document, "게임"));
    const spacer = () => header(document, "게임").querySelector(".bcff-spacer");

    untrustedClick(dom, spacer());
    await settle();
    assert.equal(store.calls.length, 0, "synthetic page clicks on the blank space must not change saved folders");

    trustedMouse(dom, spacer(), "click", 1);
    await waitForCondition(() => storedState(chrome).folders[0].collapsed === true);
    assert.equal(store.calls.length, 1, "the blank space collapses without waiting for a double click");
    trustedMouse(dom, header(document, "게임"), "click", 1);
    await waitForCondition(() => storedState(chrome).folders[0].collapsed === false);
    assert.equal(store.calls.length, 2, "the header row's own padding toggles too");

    trustedMouse(dom, header(document, "폴더 밖 채널"), "click", 1);
    await settle();
    assert.equal(store.calls.length, 2, "the rest header has nothing to toggle");

    trustedKey(dom, nameButton(document, "토크"), "F2");
    await waitForCondition(() => renameInput(document));
    const talkHeader = renameInput(document).parentElement;
    trustedMouse(dom, renameInput(document), "click", 1);
    trustedMouse(dom, talkHeader, "click", 1);
    await settle();
    assert.equal(store.calls.length, 2, "clicks around the rename input never collapse the folder");
    assert.equal(storedState(chrome).folders[1].collapsed, false);
});

test("folders are created from the ⋯ menu or by dropping a channel on the new-folder spot, then named in place", async (t) => {
    const { chrome, dom, document, clock } = await setup(t, { followingFoldersEnabled: true });
    await waitForCondition(() => chrome.testState.getCalls.flat().includes(KEY));
    await settle();
    const list = document.getElementById("followingList");

    // With no folders yet, the first one comes from dragging a channel to the spot that appears while dragging.
    dragEvent(dom, "dragstart", document.querySelector("#rowB a"));
    const zone = list.querySelector("[data-bcff-new-zone]");
    assert.ok(zone, "the new-folder spot appears even before any folder exists");
    hold(dom, clock, document.querySelector("#rowA a"));
    assert.equal(hold(dom, clock, zone).defaultPrevented, true);
    dragEvent(dom, "drop", zone);
    assert.ok(renameInput(document), "the new folder shows and opens its name before the save finishes");
    await waitForCondition(() => storedState(chrome)?.folders?.length === 1);
    assert.deepEqual(storedState(chrome).folders[0].channelIds, [B]);
    assert.equal(renameInput(document).value, "새 폴더");
    assert.equal(document.activeElement, renameInput(document));
    typeText(dom, renameInput(document), "게임");
    trustedKey(dom, renameInput(document), "Enter");
    await waitForCondition(() => storedState(chrome).folders[0].name === "게임");

    const menu = await openMenu(dom, document, "게임");
    untrustedClick(dom, byLabel(menu, "새 폴더 만들기"));
    await settle();
    assert.equal(storedState(chrome).folders.length, 1, "synthetic clicks never create folders");
    press(dom, byLabel(menu, "새 폴더 만들기"));
    assert.equal(layer(document), null);
    await waitForCondition(() => storedState(chrome).folders.length === 2);
    assert.equal(storedState(chrome).folders[1].name, "새 폴더");
    assert.equal(document.activeElement, renameInput(document));
    trustedKey(dom, renameInput(document), "Escape");
    await waitForCondition(() => !renameInput(document));
    press(dom, byLabel(await openMenu(dom, document, "게임"), "새 폴더 만들기"));
    await waitForCondition(() => storedState(chrome).folders.length === 3);
    assert.equal(storedState(chrome).folders[2].name, "새 폴더 2", "default names stay unique");
});

test("a collapsed folder keeps its live count beside the menu button while the pointer is over it", async (t) => {
    const saved = stateOf(folder("games", "게임", [A, B, C], true), folder("talk", "토크", [E]));
    const { document } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    await waitForCondition(() => headerButton(document, "게임"));
    const live = header(document, "게임").querySelector(".bcff-live");
    assert.equal(live.hidden, false);
    assert.equal(live.getAttribute("data-bcff-live"), "2");
    assert.equal(header(document, "토크").querySelector(".bcff-live").hidden, true, "open folders show their rows");

    const style = document.getElementById("betterchzzk-following-folders-style").textContent;
    for (const rule of style.split("}").filter((text) => /:hover|:focus-within/.test(text))) {
        if (!/\.bcff-live/.test(rule)) continue;
        assert.doesNotMatch(rule, /display:none|visibility:hidden/, "hover and focus never hide the live count");
    }
    assert.match(style, /\.bcff-more\{opacity:0\}/, "the menu button keeps its place, so the count does not move");
});

test("an open folder presses 더보기 until its channels are built, and the user's own 접기 holds until a folder opens", async (t) => {
    const saved = stateOf(folder("games", "게임", [A]), folder("talk", "토크", [E], true));
    const { chrome, dom, document, store } = await setup(
        t,
        { followingFoldersEnabled: true, [KEY]: saved },
        { collapsedList: true }
    );
    const more = document.getElementById("moreButton");
    const visible = (id) =>
        document.getElementById(id) && dom.window.getComputedStyle(document.getElementById(id)).display !== "none";
    await waitForCondition(() => headerButton(document, "토크"));
    await settle();
    assert.equal(more.nativeClicks, 0, "open folders that are fully built leave the native list alone");

    trustedClick(dom, headerButton(document, "토크"));
    await waitForCondition(() => visible("rowE"));
    assert.equal(more.nativeClicks, 2, "더보기 is pressed once per added batch until the folder's channel exists");
    assert.equal(more.getAttribute("aria-expanded"), "true");
    await waitForCondition(() => storedState(chrome).folders[1].collapsed === false);

    trustedClick(dom, more);
    await waitForCondition(() => !document.getElementById("rowD"));
    await settle();
    assert.equal(more.nativeClicks, 3, "the user's own 접기 is not undone");
    assert.equal(more.getAttribute("aria-expanded"), "false");

    trustedClick(dom, headerButton(document, "토크"));
    await waitForCondition(() => storedState(chrome).folders[1].collapsed === true);
    await settle();
    assert.equal(more.nativeClicks, 3, "closing a folder never presses 더보기");
    trustedClick(dom, headerButton(document, "토크"));
    await waitForCondition(() => visible("rowE"));
    assert.equal(more.nativeClicks, 5, "opening a folder again lifts the hold");
    await waitForCondition(() => storedState(chrome).folders[1].collapsed === false);
    await settle();
    assert.equal(store.calls.length, 3);
    assert.equal(more.nativeClicks, 5);
});

test("a folder already open after a reload gets its unbuilt channels without any click, but not while folders are off", async (t) => {
    const saved = stateOf(folder("games", "게임", [D]));
    const off = await setup(t, { followingListMaxRows: 3, [KEY]: saved }, { collapsedList: true });
    await settle();
    assert.equal(off.document.getElementById("moreButton").nativeClicks, 0, "folders off leaves the native list alone");

    const { dom, document } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved }, { collapsedList: true });
    await waitForCondition(() => document.getElementById("rowD"));
    await waitForCondition(() => dom.window.getComputedStyle(document.getElementById("rowD")).display !== "none");
    await settle();
    assert.equal(document.getElementById("moreButton").nativeClicks, 1, "it stops once the folder's channels exist");
    assert.equal(document.getElementById("rowE"), null);
    assert.equal(document.getElementById("rowD").getAttribute("data-bcff-channel-id"), D);
});

test("a site refresh that cuts the list back is built again before the next frame", async (t) => {
    const saved = stateOf(folder("games", "게임", [E]));
    const { dom, document } = await setup(
        t,
        { followingFoldersEnabled: true, [KEY]: saved },
        { collapsedList: true, longList: true }
    );
    const more = document.getElementById("moreButton");
    await waitForCondition(() => document.getElementById("rowE"));
    await settle();
    assert.equal(more.nativeClicks, 2);
    assert.equal(more.getAttribute("aria-expanded"), "false", "the list stays partly built, so 더보기 stays as it is");

    let frames = 0;
    const countFrame = () => {
        frames += 1;
    };
    dom.window.requestAnimationFrame(countFrame);
    more.refreshList();
    assert.equal(document.getElementById("rowE"), null, "the site's refresh drops the rows after the first 더보기");
    for (let step = 0; step < 5; step += 1) await Promise.resolve();
    assert.ok(document.getElementById("rowE"), "the cut rows are built again from the mutation callbacks");
    assert.equal(frames, 0, "no frame ran in between");
    assert.equal(more.nativeClicks, 3);
    await settle();
    assert.equal(more.nativeClicks, 3);
});

test("channels missing from the whole list and a 더보기 that does nothing never keep pressing it", async (t) => {
    const F = "f".repeat(32);
    const saved = stateOf(folder("games", "게임", [D, F]));
    const { document } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved }, { collapsedList: true });
    const more = document.getElementById("moreButton");
    await waitForCondition(() => more.getAttribute("aria-expanded") === "true");
    await settle();
    assert.equal(more.nativeClicks, 2, "it builds the whole list once looking for the unfollowed channel");
    more.refreshList();
    await settle();
    assert.equal(more.nativeClicks, 2, "a channel missing from the whole list is not a reason to build it again");
    assert.ok(document.getElementById("rowD"));

    const stuck = await setup(
        t,
        { followingFoldersEnabled: true, [KEY]: saved },
        { collapsedList: true, ignoreMore: true }
    );
    await waitForCondition(() => stuck.document.getElementById("moreButton").nativeClicks === 1);
    await settle(120);
    assert.equal(stuck.document.getElementById("moreButton").nativeClicks, 1, "an ignored 더보기 is pressed once");
});

test("save failures keep the previous folders and tell the user what happened", async (t) => {
    const saved = stateOf(folder("games", "게임", [C]));
    const { chrome, dom, document, store } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    await waitForCondition(() => headerButton(document, "게임"));
    store.failNext = "storage-write-failed";
    trustedClick(dom, headerButton(document, "게임"));
    await waitForCondition(() => document.getElementById("betterchzzk-following-folders-toast"));
    const toast = document.getElementById("betterchzzk-following-folders-toast");
    assert.equal(toast.getAttribute("role"), "status");
    assert.match(toast.textContent, /저장하지 못했어요.*이전 상태/);
    assert.deepEqual(storedState(chrome), saved);
    assert.equal(headerButton(document, "게임").getAttribute("aria-expanded"), "true");
    assert.notEqual(dom.window.getComputedStyle(document.getElementById("rowC")).display, "none");

    delete dom.window.BetterChzzk.utils.settingsStoreSet;
    trustedClick(dom, headerButton(document, "게임"));
    await waitForCondition(() =>
        /확장 프로그램과 연결되지 않아/.test(
            document.getElementById("betterchzzk-following-folders-toast")?.textContent || ""
        )
    );
    assert.deepEqual(storedState(chrome), saved);
    assert.deepEqual(chrome.testState.directSets, [], "no direct sync.set fallback");
});

test("stale writes re-apply the same command to the latest value and stop after bounded conflicts", async (t) => {
    const saved = stateOf(folder("games", "게임", [C]));
    const { chrome, dom, document, store } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    await waitForCondition(() => headerButton(document, "게임"));

    // Another tab changed the value but this document has not received storage.onChanged yet.
    const otherTab = stateOf(folder("games", "게임", [C]), folder("talk", "토크", [A]));
    chrome.testState.writeSilently({ [KEY]: otherTab });
    trustedClick(dom, headerButton(document, "게임"));
    await waitForCondition(() => storedState(chrome).folders[0].collapsed === true);
    assert.equal(store.calls.length, 2);
    assert.equal(store.conflicts, 1);
    assert.deepEqual(store.calls[1].expected, { [KEY]: { value: otherTab } });
    assert.deepEqual(storedState(chrome), stateOf(folder("games", "게임", [C], true), folder("talk", "토크", [A])));
    await waitForCondition(() => headerButton(document, "토크"), { timeoutMs: 1000 });

    // A value that keeps changing is not retried forever.
    let revision = 0;
    store.beforeCompare = () => {
        revision += 1;
        chrome.testState.writeSilently({
            [KEY]: stateOf(folder("games", "게임", [C], true), folder("talk", `토크${revision}`, [A])),
        });
    };
    const before = store.calls.length;
    trustedClick(dom, headerButton(document, "게임"));
    await waitForCondition(() =>
        /계속 바뀌어/.test(document.getElementById("betterchzzk-following-folders-toast")?.textContent || "")
    );
    await settle(100);
    assert.equal(store.calls.length - before, 3, "first write plus two re-applications");
    assert.equal(storedState(chrome).folders[0].collapsed, true, "the rejected collapse is not written");
});

test("commands queued before an OFF→ON cycle are dropped instead of writing into the new generation", async (t) => {
    const saved = stateOf(folder("games", "게임", [C]), folder("talk", "토크", [A]));
    const { chrome, dom, document, store } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    await waitForCondition(() => headerButton(document, "토크"));
    const release = holdStore(store);
    trustedClick(dom, headerButton(document, "게임"));
    await waitForCondition(() => store.calls.length === 1);
    // The second command waits behind the in-flight write and has not been sent yet.
    trustedClick(dom, headerButton(document, "토크"));
    await settle();
    assert.equal(store.calls.length, 1);

    chrome.testState.emitSync({ followingFoldersEnabled: { newValue: false } });
    await waitForCondition(() => !document.querySelector("[data-bcff-header]"));
    chrome.testState.emitSync({ followingFoldersEnabled: { newValue: true } });
    await waitForCondition(() => headerButton(document, "토크"));

    release();
    // The already-sent write may finish; its echo reaches the new generation through storage.onChanged.
    await waitForCondition(() => headerButton(document, "게임")?.getAttribute("aria-expanded") === "false");
    await settle(100);
    assert.equal(store.calls.length, 1, "the old queued collapse must not be sent after re-enabling");
    assert.equal(storedState(chrome).folders[1].collapsed, false);
    assert.equal(document.getElementById("betterchzzk-following-folders-toast"), null, "dropped commands stay silent");

    trustedClick(dom, headerButton(document, "토크"));
    await waitForCondition(() => storedState(chrome).folders[1].collapsed === true);
    assert.equal(store.calls.length, 2);
    assert.deepEqual(store.calls[1].expected, {
        [KEY]: { value: stateOf(folder("games", "게임", [C], true), folder("talk", "토크", [A])) },
    });
    assert.equal(store.conflicts, 0);
});

// Moves the last of three folders up from its menu while the page's own storage.onChanged and the save reply
// arrive in the requested order, then checks that screen and menu decisions follow the saved order.
async function moveFolderUpWithArrivalOrder(t, { eventFirst }) {
    const first = folder("a", "가");
    const second = folder("b", "나");
    const third = folder("c", "다");
    const { chrome, dom, document, store } = await setup(t, {
        followingFoldersEnabled: true,
        [KEY]: stateOf(first, second, third),
    });
    await waitForCondition(() => headerButton(document, "다"));
    // Each arrival is logged once the page has handled it; the later one waits 40ms so the gap is observable.
    const arrivals = [];
    const pageListeners = chrome.testState.listeners.splice(0);
    chrome.testState.listeners.push((changes, area) =>
        setTimeout(
            () => {
                for (const listener of pageListeners) listener(changes, area);
                if (Object.hasOwn(changes, KEY)) arrivals.push("event");
            },
            eventFirst ? 0 : 40
        )
    );
    const utils = dom.window.BetterChzzk.utils;
    const send = utils.settingsStoreSet;
    utils.settingsStoreSet = async (...args) => {
        const result = await send(...args);
        // Chrome can deliver the write's storage.onChanged before the worker's reply reaches the page.
        if (eventFirst) await settle(40);
        arrivals.push("reply");
        return result;
    };
    const folderOrder = () => visualOrder(dom).filter((entry) => entry.startsWith("["));
    const menuItem = (label) => byLabel(layer(document), label);
    const expectMovedOnce = (when) => {
        assert.deepEqual(folderOrder(), ["[가]", "[다]", "[나]", "[폴더 밖 채널]"], when);
        assert.equal(layer(document)?.dataset.kind, "menu", when);
        assert.equal(menuItem("‘다’ 폴더를 위로 이동").disabled, false, when);
        assert.equal(menuItem("‘다’ 폴더를 아래로 이동").disabled, false, when);
    };

    const menu = await openMenu(dom, document, "다");
    press(dom, byLabel(menu, "‘다’ 폴더를 위로 이동"));
    expectMovedOnce("the move shows before the save finishes");
    await waitForCondition(() => arrivals.length === 1);
    assert.deepEqual(arrivals, [eventFirst ? "event" : "reply"]);
    // The confirmed value now holds the move while the other notice is still on its way; it is not applied twice.
    expectMovedOnce(`after only the ${arrivals[0]}`);
    await waitForCondition(() => arrivals.length === 2);
    await settle();
    assert.deepEqual(storedState(chrome), stateOf(first, third, second));
    expectMovedOnce("after both the reply and the storage change");
    assert.equal(store.calls.length, 1);
    assert.equal(store.conflicts, 0);

    // The next decision starts from the saved order: one more move up puts 다 first and disables 위로 이동.
    press(dom, menuItem("‘다’ 폴더를 위로 이동"));
    await waitForCondition(() => arrivals.length === 4);
    await settle();
    assert.deepEqual(store.calls[1].expected, { [KEY]: { value: stateOf(first, third, second) } });
    assert.deepEqual(storedState(chrome), stateOf(third, first, second));
    assert.deepEqual(folderOrder(), ["[다]", "[가]", "[나]", "[폴더 밖 채널]"]);
    assert.equal(menuItem("‘다’ 폴더를 위로 이동").disabled, true);
    assert.equal(store.conflicts, 0);
}

test("a folder move shows the saved order when the save reply arrives before the page's own storage change", async (t) => {
    await moveFolderUpWithArrivalOrder(t, { eventFirst: false });
});

test("a folder move shows the saved order when the page's own storage change arrives before the save reply", async (t) => {
    await moveFolderUpWithArrivalOrder(t, { eventFirst: true });
});

test("a pending save marks the native list busy only while it runs, also when folders are turned off meanwhile", async (t) => {
    const { chrome, dom, document, store } = await setup(t, {
        followingFoldersEnabled: true,
        [KEY]: stateOf(folder("one", "하나")),
    });
    await waitForCondition(() => headerButton(document, "하나"));
    const list = document.getElementById("followingList");
    assert.equal(list.hasAttribute("aria-busy"), false);

    let release = holdStore(store);
    trustedClick(dom, headerButton(document, "하나"));
    await waitForCondition(() => store.calls.length === 1);
    assert.equal(list.getAttribute("aria-busy"), "true");
    release();
    await waitForCondition(() => storedState(chrome).folders[0].collapsed === true);
    await settle();
    assert.equal(list.hasAttribute("aria-busy"), false, "a finished save leaves no aria-busy behind");

    release = holdStore(store);
    trustedClick(dom, headerButton(document, "하나"));
    await waitForCondition(() => store.calls.length === 2);
    assert.equal(list.getAttribute("aria-busy"), "true");
    chrome.testState.emitSync({ followingFoldersEnabled: { oldValue: true, newValue: false } });
    await waitForCondition(() => !document.querySelector("[data-bcff-header]"));
    assert.equal(list.hasAttribute("aria-busy"), false, "turning folders off releases the native list at once");
    release();
    await settle();
    assert.equal(list.hasAttribute("aria-busy"), false, "the late save result does not mark the list again");
    assert.equal(markerCount(document), 0);
});

test("a pending save restores the site's own aria-busy on the native list afterwards", async (t) => {
    const { chrome, dom, document, store } = await setup(t, {
        followingFoldersEnabled: true,
        followingListMaxRows: 6,
        [KEY]: stateOf(folder("one", "하나")),
    });
    const list = document.getElementById("followingList");
    list.setAttribute("aria-busy", "false");
    await waitForCondition(() => headerButton(document, "하나"));

    let release = holdStore(store);
    trustedClick(dom, headerButton(document, "하나"));
    await waitForCondition(() => store.calls.length === 1);
    assert.equal(list.getAttribute("aria-busy"), "true");
    release();
    await waitForCondition(() => storedState(chrome).folders[0].collapsed === true);
    await settle();
    assert.equal(list.getAttribute("aria-busy"), "false", "the site's value comes back after the save");

    // With the row limit still on, the runtime stays installed after folders are turned off.
    release = holdStore(store);
    trustedClick(dom, headerButton(document, "하나"));
    await waitForCondition(() => store.calls.length === 2);
    assert.equal(list.getAttribute("aria-busy"), "true");
    chrome.testState.emitSync({ followingFoldersEnabled: { oldValue: true, newValue: false } });
    await waitForCondition(() => !document.querySelector("[data-bcff-header]"));
    assert.equal(list.getAttribute("data-bcff-max-rows"), "1");
    assert.equal(list.getAttribute("aria-busy"), "false", "turning folders off gives the site's value back");
    release();
    await settle();
    assert.equal(list.getAttribute("aria-busy"), "false");
});

test("other-tab changes win over late initial reads and corrupt values need an explicit two-step reset", async (t) => {
    const oldState = stateOf(folder("old", "이전"));
    const chrome = createFakeChrome({ followingFoldersEnabled: true, [KEY]: oldState });
    chrome.testState.holdKey = KEY;
    const dom = createDom(chrome);
    t.after(() => dom.window.close());
    const store = loadFeature(dom, chrome);
    const { document } = dom.window;
    await waitForCondition(() => chrome.testState.heldGets.length === 1);
    chrome.testState.writeOtherTab({ [KEY]: stateOf(folder("new", "새것", [A])) });
    await waitForCondition(() => headerButton(document, "새것"));
    chrome.testState.heldGets.shift()();
    await settle();
    assert.equal(header(document, "이전"), undefined, "a late initial read must not restore older folders");
    assert.ok(headerButton(document, "새것"));

    chrome.testState.emitSync({ [KEY]: {} });
    await waitForCondition(() => !document.querySelector("[data-bcff-header]"));
    assert.equal(document.querySelector("[data-bcff-order]"), null, "removing the key clears the grouping");

    const corrupt = { version: 1, folders: "broken" };
    chrome.testState.writeOtherTab({ [KEY]: corrupt });
    await settle();
    // The notice sits at the top of the following list; there is no separate button or panel.
    const status = () => document.querySelector("#followingList > [data-bcff-status]");
    await waitForCondition(() => status()?.querySelector('[data-bcff-key="reset"]'));
    assert.equal(document.getElementById("followingList").firstElementChild, status());
    assert.match(status().textContent, /올바르지 않아/);
    assert.equal(document.querySelector("[data-bcff-header]"), null);
    untrustedClick(dom, status().querySelector('[data-bcff-key="reset"]'));
    await settle();
    assert.equal(status().querySelector('[data-bcff-key="reset"]').textContent, "폴더 정보 초기화");
    press(dom, status().querySelector('[data-bcff-key="reset"]'));
    await settle();
    assert.equal(store.calls.length, 0, "the first reset press only arms confirmation");
    assert.equal(status().querySelector('[data-bcff-key="reset"]').textContent, "한 번 더 눌러 초기화");
    assert.equal(document.activeElement, status().querySelector('[data-bcff-key="reset"]'), "focus stays on it");
    trustedClick(dom, status().querySelector('[data-bcff-key="reset"]'));
    await waitForCondition(() => storedState(chrome)?.folders?.length === 0);
    assert.deepEqual(store.calls[0].expected, { [KEY]: { value: corrupt } });
    await waitForCondition(() => !status(), { timeoutMs: 1000 });
});

test("a failed first read offers a retry instead of treating storage as empty", async (t) => {
    const chrome = createFakeChrome({ followingFoldersEnabled: true, [KEY]: stateOf(folder("games", "게임")) });
    chrome.testState.failGetKey = KEY;
    const dom = createDom(chrome);
    t.after(() => dom.window.close());
    const store = loadFeature(dom, chrome);
    const { document } = dom.window;
    const status = () => document.querySelector("#followingList > [data-bcff-status]");
    await waitForCondition(() => status()?.querySelector('[data-bcff-key="retry"]'));
    assert.equal(document.querySelector("[data-bcff-header]"), null);
    assert.match(status().textContent, /읽지 못했어요/);
    trustedClick(dom, status().querySelector('[data-bcff-key="retry"]'));
    await waitForCondition(() => headerButton(document, "게임"));
    await waitForCondition(() => !status(), { timeoutMs: 1000 });
    assert.equal(store.calls.length, 0);
});

test("reused rows and replaced lists are re-judged by their current href before paint", async (t) => {
    const saved = stateOf(folder("games", "게임", [A]));
    const { dom, document } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    await waitForCondition(() => headerButton(document, "게임"));
    await settle();
    dom.window.requestAnimationFrame = () => 1;
    const rowA = document.getElementById("rowA");
    const link = rowA.querySelector("a");
    link.setAttribute("href", `/live/${B}`);
    await settle(0);
    assert.equal(rowA.getAttribute("data-bcff-channel-id"), B);
    assert.deepEqual(visualOrder(dom).slice(0, 2), ["[게임]", "[폴더 밖 채널]"]);
    link.setAttribute("href", `/${A}`);
    await settle(0);
    assert.equal(rowA.getAttribute("data-bcff-channel-id"), A);
    assert.deepEqual(visualOrder(dom).slice(0, 3), ["[게임]", "rowA", "[폴더 밖 채널]"]);
    link.setAttribute("href", "/video/123");
    await settle(0);
    assert.equal(rowA.hasAttribute("data-bcff-order"), false, "non-channel rows lose folder markers");

    const list = document.getElementById("followingList");
    const replacement = document.createElement("ul");
    replacement.id = "replacementList";
    replacement.innerHTML = ROWS_HTML.replaceAll('id="row', 'id="newRow');
    list.replaceWith(replacement);
    await settle(0);
    assert.equal(replacement.getAttribute("data-bcff-list"), "1");
    assert.deepEqual(visualOrder(dom, replacement).slice(0, 3), ["[게임]", "newRowA", "[폴더 밖 채널]"]);
    assert.equal(list.querySelector("[data-bcff-header]"), null, "the detached list keeps no extension rows");

    const removed = document.getElementById("newRowC");
    removed.remove();
    await settle(0);
    assert.equal(removed.hasAttribute("data-bcff-order"), false);
    assert.equal(removed.hasAttribute("data-bcff-channel-id"), false);
});

test("dragging following links onto headers assigns or releases them; synthetic and stale drops do not", async (t) => {
    const saved = stateOf(folder("games", "게임"), folder("talk", "토크"));
    const { chrome, dom, document, store, clock } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    await waitForCondition(() => headerButton(document, "토크"));
    const list = document.getElementById("followingList");
    const linkA = document.querySelector("#rowA a");

    dragEvent(dom, "dragstart", linkA, { trusted: false });
    const ignoredOver = dragEvent(dom, "dragover", header(document, "게임"));
    assert.equal(ignoredOver.defaultPrevented, false, "an untrusted drag source is not accepted");

    dragEvent(dom, "dragstart", linkA);
    assert.equal(list.getAttribute("data-bcff-dragging"), "1");
    const over = hold(dom, clock, header(document, "게임"));
    assert.equal(over.defaultPrevented, true);
    assert.equal(header(document, "게임").getAttribute("data-bcff-drop-target"), "1");
    dragEvent(dom, "drop", header(document, "게임"), { trusted: false });
    await settle();
    assert.equal(store.calls.length, 0, "a synthetic drop must not assign channels");
    dragEvent(dom, "drop", header(document, "게임"));
    await waitForCondition(() => storedState(chrome).folders[0].channelIds.includes(A));
    assert.equal(list.hasAttribute("data-bcff-dragging"), false);
    assert.equal(document.querySelector("[data-bcff-drop-target]"), null);

    const linkB = document.querySelector("#rowB a");
    dragEvent(dom, "dragstart", linkB);
    linkB.setAttribute("href", `/${D}`);
    dragEvent(dom, "dragover", header(document, "토크"));
    const callsBeforeStale = store.calls.length;
    dragEvent(dom, "drop", header(document, "토크"));
    await waitForCondition(() =>
        /목록이 바뀌어/.test(document.getElementById("betterchzzk-following-folders-toast")?.textContent || "")
    );
    assert.equal(store.calls.length, callsBeforeStale, "a reused row during drag is not assigned");

    await waitForCondition(() => visualOrder(dom).indexOf("rowA") === 1);
    dragEvent(dom, "dragstart", linkA);
    dragEvent(dom, "dragover", header(document, "폴더 밖 채널"));
    dragEvent(dom, "drop", header(document, "폴더 밖 채널"));
    await waitForCondition(() => storedState(chrome).folders[0].channelIds.length === 0);

    dragEvent(dom, "dragstart", linkA);
    assert.equal(list.getAttribute("data-bcff-dragging"), "1");
    dragEvent(dom, "dragend", linkA);
    assert.equal(list.hasAttribute("data-bcff-dragging"), false);
});

test("dropping on a folder's rows or the new-folder spot moves channels; outside the sidebar the link drag is untouched", async (t) => {
    const saved = stateOf(folder("games", "게임", [C]), folder("talk", "토크"));
    const { chrome, dom, document, store, clock } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    await waitForCondition(() => headerButton(document, "토크"));
    const list = document.getElementById("followingList");
    const linkA = document.querySelector("#rowA a");

    const transfer = createDataTransfer();
    transfer.setData("text/uri-list", "https://chzzk.naver.com/live/" + A);
    transfer.effectAllowed = "copyLink";
    dragEvent(dom, "dragstart", linkA, { dataTransfer: transfer });
    assert.deepEqual(Object.keys(transfer.data), ["text/uri-list"], "the link payload is left as the page set it");
    assert.equal(transfer.effectAllowed, "copyLink");
    const zone = list.querySelector("[data-bcff-new-zone]");
    assert.ok(zone, "the new-folder spot appears only while a channel is dragged");
    assert.equal(zone.parentElement, list);
    assert.equal(zone.getAttribute("data-bcff-channel-id"), null);

    const outside = dragEvent(dom, "dragover", document.getElementById("mainLive"), { dataTransfer: transfer });
    assert.equal(outside.defaultPrevented, false, "outside the sidebar other targets keep receiving the link");
    assert.equal(document.querySelector("[data-bcff-drop-target]"), null);
    dragEvent(dom, "drop", document.getElementById("mainLive"), { dataTransfer: transfer });
    await settle();
    assert.equal(store.calls.length, 0, "a drop outside the sidebar never changes folders");
    assert.ok(list.querySelector("[data-bcff-new-zone]"), "the drag is still running");

    const sameSpot = dragEvent(dom, "dragover", document.getElementById("rowE"), { dataTransfer: transfer });
    assert.equal(sameSpot.defaultPrevented, false, "dropping back where the channel already is does nothing");

    const overRow = hold(dom, clock, document.querySelector("#rowC a"), { dataTransfer: transfer });
    assert.equal(overRow.defaultPrevented, true, "a folder's own rows accept the drop");
    assert.equal(transfer.dropEffect, "link");
    assert.equal(header(document, "게임").getAttribute("data-bcff-drop-target"), "1");
    assert.equal(header(document, "게임").getAttribute("data-bcff-drop-hint"), "게임 폴더로 이동");
    assert.equal(document.getElementById("rowC").getAttribute("data-bcff-drop-target"), "1");
    assert.equal(document.getElementById("rowE").hasAttribute("data-bcff-drop-target"), false);
    dragEvent(dom, "drop", document.querySelector("#rowC a"), { dataTransfer: transfer });
    await waitForCondition(() => storedState(chrome).folders[0].channelIds.includes(A));
    assert.equal(list.querySelector("[data-bcff-new-zone]"), null);
    assert.equal(document.querySelector("[data-bcff-drop-target]"), null);
    assert.match(toastText(document), /알파 채널을 ‘게임’ 폴더에 넣었어요/);

    dragEvent(dom, "dragstart", document.querySelector("#rowE a"));
    // The spot can appear right under the pointer when the last row is dragged; it waits until the pointer moves on.
    const underPointer = dragEvent(dom, "dragover", list.querySelector("[data-bcff-new-zone]"));
    assert.equal(underPointer.defaultPrevented, false);
    dragEvent(dom, "drop", list.querySelector("[data-bcff-new-zone]"));
    await settle();
    assert.equal(storedState(chrome).folders.length, 2, "an immediate drop on the spot creates nothing");
    dragEvent(dom, "dragover", header(document, "토크"));
    const overZone = dragEvent(dom, "dragover", list.querySelector("[data-bcff-new-zone]"));
    assert.equal(overZone.defaultPrevented, true);
    dragEvent(dom, "drop", list.querySelector("[data-bcff-new-zone]"));
    await waitForCondition(() => storedState(chrome).folders.length === 3);
    assert.deepEqual(storedState(chrome).folders[2], {
        id: storedState(chrome).folders[2].id,
        name: "새 폴더",
        channelIds: [E],
        collapsed: false,
    });
    await waitForCondition(() => renameInput(document));
    assert.equal(renameInput(document).value, "새 폴더", "the new folder opens its name for editing");
    trustedKey(dom, renameInput(document), "Escape");
    await waitForCondition(() => !renameInput(document));

    // A narrow (collapsed) sidebar has no room for folder targets, so drags stay plain link drags.
    list.getBoundingClientRect = () => ({ width: 60, height: 300, top: 0, left: 0, right: 60, bottom: 300 });
    chrome.testState.emitSync({ followingListMaxRows: { newValue: 0 } });
    await waitForCondition(() => list.getAttribute("data-bcff-compact") === "1");
    dragEvent(dom, "dragstart", document.querySelector("#rowB a"));
    assert.equal(list.querySelector("[data-bcff-new-zone]"), null);
    assert.equal(dragEvent(dom, "dragover", header(document, "토크")).defaultPrevented, false);
    dragEvent(dom, "dragend", document.querySelector("#rowB a"));
});

test("folder names drag to reorder folders inside the sidebar only", async (t) => {
    const saved = stateOf(folder("games", "게임", [C]), folder("talk", "토크"), folder("music", "음악"));
    const { chrome, dom, document, store, clock } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    await waitForCondition(() => headerButton(document, "음악"));
    const order = () => storedState(chrome).folders.map((item) => item.name);

    const untrusted = createDataTransfer();
    dragEvent(dom, "dragstart", nameButton(document, "음악"), { trusted: false, dataTransfer: untrusted });
    assert.deepEqual(untrusted.data, {}, "synthetic drags carry no folder");

    const transfer = createDataTransfer();
    dragEvent(dom, "dragstart", nameButton(document, "음악"), { dataTransfer: transfer });
    assert.deepEqual(Object.keys(transfer.data), [FOLDER_DRAG_TYPE], "folder drags carry no link");
    assert.equal(transfer.effectAllowed, "move");
    assert.equal(document.querySelector("[data-bcff-new-zone]"), null);
    assert.equal(
        dragEvent(dom, "dragover", document.getElementById("mainLive"), { dataTransfer: transfer }).defaultPrevented,
        false
    );
    assert.equal(
        dragEvent(dom, "dragover", header(document, "음악"), { dataTransfer: transfer }).defaultPrevented,
        false,
        "a folder cannot be dropped on itself"
    );
    const headers = () => visualOrder(dom).filter((entry) => entry.startsWith("["));
    const over = hold(dom, clock, document.querySelector("#rowC a"), { dataTransfer: transfer });
    assert.equal(over.defaultPrevented, true);
    // The dragged folder moves into its new place while held; nothing is saved yet.
    assert.deepEqual(headers(), ["[음악]", "[게임]", "[토크]", "[폴더 밖 채널]"]);
    assert.deepEqual(order(), ["게임", "토크", "음악"]);
    assert.equal(store.calls.length, 0);
    const overMoved = dragEvent(dom, "dragover", header(document, "음악"), { dataTransfer: transfer });
    assert.equal(overMoved.defaultPrevented, true, "hovering the moved folder keeps the preview");
    assert.deepEqual(headers(), ["[음악]", "[게임]", "[토크]", "[폴더 밖 채널]"]);
    dragEvent(dom, "dragover", document.getElementById("mainLive"), { dataTransfer: transfer });
    assert.deepEqual(headers(), ["[게임]", "[토크]", "[음악]", "[폴더 밖 채널]"], "leaving the sidebar puts it back");
    dragEvent(dom, "dragover", document.querySelector("#rowC a"), { dataTransfer: transfer });
    dragEvent(dom, "drop", document.querySelector("#rowC a"), { dataTransfer: transfer });
    assert.deepEqual(headers(), ["[음악]", "[게임]", "[토크]", "[폴더 밖 채널]"], "the drop keeps the previewed order");
    await waitForCondition(() => order().join() === "음악,게임,토크");
    assert.deepEqual(store.calls.at(-1).expected, { [KEY]: { value: saved } });

    dragEvent(dom, "dragstart", nameButton(document, "음악"));
    dragEvent(dom, "dragover", header(document, "폴더 밖 채널"));
    dragEvent(dom, "drop", header(document, "폴더 밖 채널"));
    await waitForCondition(() => order().join() === "게임,토크,음악");
});

test("a held channel previews its landing spot, drops show at once, failed saves roll back, and collapsed folders open while held", async (t) => {
    const saved = stateOf(folder("games", "게임", [C]), folder("talk", "토크", [D], true));
    const { chrome, dom, document, store, clock } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    await waitForCondition(() => headerButton(document, "토크"));
    const rowA = document.getElementById("rowA");

    const images = [];
    const transfer = createDataTransfer();
    transfer.setDragImage = (element, x, y) => images.push({ id: element.id, text: element.textContent, x, y });
    dragEvent(dom, "dragstart", rowA.querySelector("a"), { dataTransfer: transfer });
    assert.equal(images.length, 1, "the dragged channel follows the pointer as a small card");
    assert.equal(images[0].id, "betterchzzk-following-folders-drag-card");
    assert.match(images[0].text, /알파/);
    assert.match(images[0].text, /방송 중/);
    await settle();
    assert.equal(document.getElementById("betterchzzk-following-folders-drag-card"), null, "the card is removed");
    assert.equal(rowA.getAttribute("data-bcff-drag-source"), "1");

    dragEvent(dom, "dragover", document.querySelector("#rowC a"), { dataTransfer: transfer });
    assert.deepEqual(visualOrder(dom).slice(0, 2), ["[게임]", "rowC"], "passing over a folder does not move rows yet");
    clock.advance(200);
    dragEvent(dom, "dragover", document.querySelector("#rowC a"), { dataTransfer: transfer });
    assert.deepEqual(
        visualOrder(dom).slice(0, 3),
        ["[게임]", "rowA", "rowC"],
        "the row moves into the folder while held"
    );
    assert.deepEqual(storedState(chrome), saved, "previews are never saved");
    assert.equal(store.calls.length, 0);
    const overSelf = dragEvent(dom, "dragover", rowA.querySelector("a"), { dataTransfer: transfer });
    assert.equal(overSelf.defaultPrevented, true, "hovering the moved row keeps the same target");
    assert.deepEqual(visualOrder(dom).slice(0, 3), ["[게임]", "rowA", "rowC"]);

    dragEvent(dom, "dragover", document.getElementById("mainLive"), { dataTransfer: transfer });
    assert.deepEqual(visualOrder(dom).slice(0, 2), ["[게임]", "rowC"], "outside the sidebar the row goes back");

    clock.advance(200);
    hold(dom, clock, header(document, "토크"), { dataTransfer: transfer });
    assert.equal(visualOrder(dom).includes("rowA"), false, "a collapsed target keeps its rows hidden at first");
    await settle(600);
    const opened = visualOrder(dom);
    assert.ok(opened.indexOf("rowA") > opened.indexOf("[토크]") && opened.includes("rowD"), "held over, it opens");
    assert.equal(headerButton(document, "토크").getAttribute("aria-expanded"), "true");
    assert.equal(storedState(chrome).folders[1].collapsed, true, "opening while held is not saved");

    const release = holdStore(store);
    dragEvent(dom, "drop", header(document, "토크"), { dataTransfer: transfer });
    assert.equal(rowA.hasAttribute("data-bcff-drag-source"), false);
    const shown = visualOrder(dom);
    assert.ok(shown.indexOf("rowA") > shown.indexOf("[토크]"), "the drop shows before the save finishes");
    assert.equal(nameButton(document, "토크").getAttribute("data-bcff-count"), "2");
    assert.deepEqual(storedState(chrome), saved);
    release();
    await waitForCondition(() => storedState(chrome).folders[1].channelIds.includes(A));
    assert.equal(storedState(chrome).folders[1].collapsed, false, "a folder opened while dropping stays open");

    store.failNext = "storage-write-failed";
    dragEvent(dom, "dragstart", document.querySelector("#rowE a"));
    dragEvent(dom, "dragover", header(document, "게임"));
    dragEvent(dom, "drop", header(document, "게임"));
    assert.ok(visualOrder(dom).indexOf("rowE") < visualOrder(dom).indexOf("[토크]"), "shown in the folder at once");
    await waitForCondition(() => /저장하지 못했어요/.test(toastText(document)));
    const after = visualOrder(dom);
    assert.ok(after.indexOf("rowE") > after.indexOf("[폴더 밖 채널]"), "a failed save puts the row back");
    assert.equal(storedState(chrome).folders[0].channelIds.includes(E), false);
});

test("previews ignore quick passes and layout shifts under a still pointer, and switch once the pointer really moves", async (t) => {
    const saved = stateOf(folder("games", "게임", [C]), folder("talk", "토크", [D]));
    const { dom, document, clock } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    await waitForCondition(() => headerButton(document, "토크"));
    const rowE = document.getElementById("rowE");
    const folderOfE = () => {
        const order = visualOrder(dom);
        const at = order.indexOf("rowE");
        if (at < order.indexOf("[토크]")) return "게임";
        return at < order.indexOf("[폴더 밖 채널]") ? "토크" : "밖";
    };
    dragEvent(dom, "dragstart", rowE.querySelector("a"));

    // Sweeping across both folders on the way somewhere else changes nothing.
    dragEvent(dom, "dragover", document.querySelector("#rowC a"), { clientY: 100 });
    clock.advance(40);
    dragEvent(dom, "dragover", header(document, "토크"), { clientY: 140 });
    clock.advance(40);
    dragEvent(dom, "dragover", document.getElementById("mainLive"), { clientY: 400 });
    assert.equal(folderOfE(), "밖");

    clock.advance(300);
    hold(dom, clock, document.querySelector("#rowC a"), { clientY: 100 });
    assert.equal(folderOfE(), "게임");
    // The preview moved rows; a still pointer now sits over another folder but the preview must not flip back and forth.
    clock.advance(300);
    dragEvent(dom, "dragover", header(document, "토크"), { clientY: 102 });
    clock.advance(300);
    dragEvent(dom, "dragover", header(document, "토크"), { clientY: 102 });
    assert.equal(folderOfE(), "게임", "a layout shift under a still pointer keeps the target");

    dragEvent(dom, "dragover", header(document, "토크"), { clientY: 150 });
    clock.advance(200);
    dragEvent(dom, "dragover", header(document, "토크"), { clientY: 150 });
    assert.equal(folderOfE(), "토크", "a real pointer move switches after a short hold");
    // Right after a switch the rows are still sliding, so even a moved pointer waits.
    clock.advance(50);
    dragEvent(dom, "dragover", document.querySelector("#rowC a"), { clientY: 90 });
    dragEvent(dom, "dragover", document.querySelector("#rowC a"), { clientY: 90 });
    assert.equal(folderOfE(), "토크");
    // Moving around inside the target folder crosses the 3px gaps between native rows; the preview stays put.
    clock.advance(300);
    const list = document.getElementById("followingList");
    for (let step = 0; step < 6; step += 1) {
        dragEvent(dom, "dragover", list, { clientY: 160 + step * 10 });
        assert.equal(folderOfE(), "토크", `gap ${step} keeps the preview`);
        clock.advance(80);
        dragEvent(dom, "dragover", document.querySelector("#rowD a"), { clientY: 165 + step * 10 });
        assert.equal(folderOfE(), "토크", `row ${step} keeps the preview`);
        clock.advance(80);
    }
    dragEvent(dom, "dragend", rowE.querySelector("a"));
    assert.equal(folderOfE(), "밖", "ending the drag without a drop restores the list");
});

test("undo restores the folders from before a change and refuses once something else changed them", async (t) => {
    const saved = stateOf(folder("games", "게임", [C]), folder("talk", "토크"));
    const { chrome, dom, document, store } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    await waitForCondition(() => headerButton(document, "토크"));

    dragEvent(dom, "dragstart", document.querySelector("#rowC a"));
    dragEvent(dom, "dragover", header(document, "토크"));
    dragEvent(dom, "drop", header(document, "토크"));
    await waitForCondition(() => storedState(chrome).folders[1].channelIds.includes(C));
    await waitForCondition(() => document.querySelector(`${TOAST_SELECTOR} [data-bcff-key="undo"]`));
    const moved = storedState(chrome);
    untrustedClick(dom, document.querySelector(`${TOAST_SELECTOR} [data-bcff-key="undo"]`));
    await settle();
    assert.deepEqual(storedState(chrome), moved, "synthetic clicks cannot undo");
    trustedClick(dom, document.querySelector(`${TOAST_SELECTOR} [data-bcff-key="undo"]`));
    await waitForCondition(() => storedState(chrome).folders[0].channelIds.includes(C));
    assert.deepEqual(storedState(chrome), saved);
    assert.deepEqual(store.calls.at(-1).expected, { [KEY]: { value: moved } });
    await waitForCondition(() => /되돌렸어요/.test(toastText(document)));
    assert.equal(document.querySelector(`${TOAST_SELECTOR} [data-bcff-key="undo"]`), null, "undo is one step");

    dragEvent(dom, "dragstart", document.querySelector("#rowC a"));
    dragEvent(dom, "dragover", header(document, "토크"));
    dragEvent(dom, "drop", header(document, "토크"));
    await waitForCondition(() => document.querySelector(`${TOAST_SELECTOR} [data-bcff-key="undo"]`));
    const callsBeforeOtherTab = store.calls.length;
    chrome.testState.writeOtherTab({ [KEY]: stateOf(folder("games", "게임"), folder("talk", "토크", [C, A])) });
    await waitForCondition(
        () => headerButton(document, "토크") && storedState(chrome).folders[1].channelIds.length === 2
    );
    await settle();
    const undoButton = document.querySelector(`${TOAST_SELECTOR} [data-bcff-key="undo"]`);
    assert.ok(undoButton, "the earlier undo offer is still on screen");
    trustedClick(dom, undoButton);
    await waitForCondition(() => /되돌리지 않았어요/.test(toastText(document)));
    await settle();
    assert.equal(store.calls.length, callsBeforeOtherTab, "another tab's change is never overwritten by undo");
    assert.deepEqual(storedState(chrome).folders[1].channelIds, [C, A]);
});

test("the undo notice moves aside only when an open menu actually overlaps it", async (t) => {
    const saved = stateOf(folder("games", "게임", [C]), folder("talk", "토크"));
    const { chrome, dom, document } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    await waitForCondition(() => headerButton(document, "토크"));
    const rect = (left, top, width, height) => ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
    });
    const win = dom.window;
    Object.defineProperty(win, "innerHeight", { configurable: true, value: 800 });
    Object.defineProperty(win, "innerWidth", { configurable: true, value: 1400 });
    document.getElementById("sidebar").getBoundingClientRect = () => rect(0, 0, 240, 800);
    const sized = (node, width, height) => {
        Object.defineProperty(node, "offsetWidth", { configurable: true, value: width });
        Object.defineProperty(node, "offsetHeight", { configurable: true, value: height });
    };
    const toastNode = () => document.querySelector(TOAST_SELECTOR);
    const menu = await openMenu(dom, document, "토크");
    // The menu floats high in the sidebar's neighbour column, well above the notice at the bottom.
    menu.getBoundingClientRect = () => rect(248, 200, 208, 260);
    press(dom, byLabel(menu, "‘토크’ 폴더를 위로 이동"));
    await waitForCondition(() => toastNode() && storedState(chrome).folders[0].name === "토크");
    sized(toastNode(), 300, 48);
    win.dispatchEvent(new win.Event("resize"));
    assert.equal(toastNode().style.left, "252px", "a menu above the notice leaves it next to the sidebar");

    // Now the menu reaches down to the notice's row, so the notice moves past the menu.
    layer(document).getBoundingClientRect = () => rect(248, 560, 208, 220);
    win.dispatchEvent(new win.Event("resize"));
    assert.equal(toastNode().style.left, `${248 + 208 + 12}px`);
});

test("turning folders off removes every marker, closes open layers, and stops following storage", async (t) => {
    const saved = stateOf(folder("games", "게임", [C], true));
    const { chrome, dom, document } = await setup(t, { followingFoldersEnabled: true, [KEY]: saved });
    await waitForCondition(() => headerButton(document, "게임"));
    await openPicker(dom, document, "게임");
    const listenersWhileOn = chrome.testState.listeners.length;

    chrome.testState.emitSync({ followingFoldersEnabled: { newValue: false } });
    await waitForCondition(() => !document.querySelector("[data-bcff-header]"));
    assert.equal(layer(document), null);
    assert.equal(markerCount(document), 0);
    assert.equal(document.getElementById("betterchzzk-following-folders-style"), null);
    assert.notEqual(dom.window.getComputedStyle(document.getElementById("rowC")).display, "none");
    assert.equal(chrome.testState.listeners.length, listenersWhileOn - 1);

    chrome.testState.writeOtherTab({ [KEY]: stateOf(folder("talk", "토크")) });
    await settle();
    assert.equal(document.querySelector("[data-bcff-header]"), null);

    chrome.testState.emitSync({ followingFoldersEnabled: { newValue: true } });
    await waitForCondition(() => headerButton(document, "토크"));
});

test("folders combine with pinning: pin ranks order rows inside folders and sidebar buttons stay stable", async (t) => {
    const saved = stateOf(folder("games", "게임", [B, C, D]));
    const { chrome, dom, document } = await setup(
        t,
        {
            followingFoldersEnabled: true,
            followingPinEnabled: true,
            betterchzzkPinnedFollowingChannelIds: [B],
            [KEY]: saved,
        },
        { pin: true }
    );
    await waitForCondition(
        () =>
            headerButton(document, "게임") &&
            document.getElementById("rowB").getAttribute("data-bcsf-order-group") === "offline-pinned"
    );
    await waitForCondition(() => document.getElementById("rowB").getAttribute("data-bcff-order") === "3");
    const order = (id) => Number(document.getElementById(id).getAttribute("data-bcff-order"));
    assert.ok(order("rowC") < order("rowB") && order("rowB") < order("rowD"), "live → pinned offline → offline");

    const refresh = document.getElementById("followingRefresh");
    const pinButton = document.getElementById("betterchzzk-following-pin-mode");
    assert.equal(pinButton.nextElementSibling, refresh);
    assert.equal(document.querySelector(MANAGE_SELECTOR), null, "folders add no button to the sidebar header");

    chrome.testState.emitSync({ followingPinOfflineToTopEnabled: { newValue: true } });
    await waitForCondition(() => order("rowB") === 1);
    assert.ok(order("rowB") < order("rowC"));

    await settle(80);
    const sidebar = document.getElementById("sidebar");
    let mutations = 0;
    const observer = new dom.window.MutationObserver((records) => {
        mutations += records.length;
    });
    observer.observe(sidebar, { subtree: true, childList: true, attributes: true });
    await settle(150);
    observer.disconnect();
    assert.equal(mutations, 0, "pin and folder sync must not trigger each other repeatedly");
});
