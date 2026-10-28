const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { createFakeChrome, waitForCondition } = require("./helpers/extension-page-fixture.js");

require("../shared/chatMultiview.js");

const chatModel = globalThis.CheeseSpannerChatMultiview;
const repoRoot = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");
const KEY = "betterchzzk:chat-multiview:v1";
const STORE_TYPE = "cheese-spanner:settings-store";
const ENTRY_ID = "cheese-spanner-chat-multiview";
const PANEL_ID = ENTRY_ID + "-panel";
const [A, B, C, D, E] = ["a", "b", "c", "d", "e"].map((letter) => letter.repeat(32));
const MAIN_CHANNEL = "f".repeat(32);
const THEME_SCRIPT = "shared/uiTheme.js";
const SCRIPTS = [
    "shared/settings.js",
    "shared/data.js",
    "content.js",
    "shared/chatMultiview.js",
    "features/chatWeeklyRanking.js",
    "features/chatMultiview.js",
];
// The runtime waits this long for the native chat log after a verified load, and for any load at all.
const CHAT_READY_DELAY = 20000;
const FRAME_LOAD_DELAY = 30000;
const TRUSTED_TYPES = new Set([
    "click",
    "keydown",
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointercancel",
    "dragstart",
    "dragend",
    "dragover",
    "dragleave",
    "drop",
]);

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const nameOf = (id) => "채널 " + id[0];
const layout = (ids, extra = {}) => ({
    version: 2,
    channels: ids.map((channelId) => ({ channelId, channelName: nameOf(channelId) })),
    chatWidth: 340,
    chatHeight: 600,
    corner: "bottom-right",
    x: 16,
    y: 16,
    input: false,
    scale: 100,
    ...extra,
});
// The panel-sized format used earlier on 2026-10-12, before sizes became per chat.
const legacyLayout = (ids, extra = {}) => ({
    version: 1,
    channels: ids.map((channelId) => ({ channelId, channelName: nameOf(channelId) })),
    width: 960,
    height: 600,
    corner: "bottom-right",
    ...extra,
});
const channel = (id) => ({
    channelId: id,
    channelName: nameOf(id),
    channelImageUrl: "https://nng-phinf.pstatic.net/" + id + "/profile.png",
    followerCount: 100,
});
const searchResponse = (ids) => ({ code: 200, content: { data: ids.map((id) => ({ channel: channel(id) })) } });
// Waits only where the assertion is that nothing else happens after already-scheduled callbacks.
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
const headerHtml = (extra = "") =>
    '<header id="header"><div class="_container_mzph5_1"><div class="_section_mzph5_8">' +
    extra +
    '<div class="_box_mzph5_15"><button type="button">네이티브 버튼</button></div></div></div></header>';
const pageHtml = (withHeader) =>
    (withHeader ? headerHtml() : "") +
    '<main id="layout-body"><div class="player"><video id="main-video"></video></div>' +
    '<aside id="aside-chatting"><div role="log" id="main-chat-log"></div></aside></main>';

function fixture(t, { enabled = true, stored, withHeader = true, holdReads = false, withTheme = false } = {}) {
    const chrome = createFakeChrome({
        sync: { chatMultiviewEnabled: enabled },
        local: stored === undefined ? {} : { [KEY]: clone(stored) },
    });
    chrome.runtime.getURL = (file) => "chrome-extension://cheese-spanner/" + file;
    const localReads = [],
        syncReads = [],
        heldReads = [],
        storeMessages = [];
    let holding = holdReads,
        storeMode = "emulate";
    const localGet = chrome.storage.local.get;
    chrome.storage.local.get = (keys, callback) => {
        localReads.push(keys);
        // The fake area snapshots data at call time, so holding the callback models a late, stale read.
        localGet(keys, (data) => {
            if (holding) heldReads.push(() => callback(data));
            else callback(data);
        });
    };
    const syncGet = chrome.storage.sync.get;
    chrome.storage.sync.get = (keys, callback) => {
        syncReads.push(keys);
        syncGet(keys, callback);
    };
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (message, callback) => {
        if (message?.type === STORE_TYPE) {
            storeMessages.push(clone(message));
            if (storeMode === "fail") {
                setTimeout(() => callback?.({ ok: false, error: "storage-write-failed" }), 0);
                return;
            }
        }
        send.call(chrome.runtime, message, callback);
    };

    const dom = new JSDOM(pageHtml(withHeader), {
        url: "https://chzzk.naver.com/live/" + MAIN_CHANNEL,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    // JSDOM cannot create trusted events; record listeners so tests can model real user input.
    const listeners = new WeakMap();
    const addListener = w.EventTarget.prototype.addEventListener;
    w.EventTarget.prototype.addEventListener = function (type, callback, ...rest) {
        if (TRUSTED_TYPES.has(type) && typeof callback === "function") {
            const byType = listeners.get(this) || new Map();
            byType.set(type, [...(byType.get(type) || []), callback]);
            listeners.set(this, byType);
        }
        return addListener.call(this, type, callback, ...rest);
    };
    // Hold the long frame timeouts so tests decide when they expire.
    const realSetTimeout = w.setTimeout.bind(w);
    const realClearTimeout = w.clearTimeout.bind(w);
    const held = new Map();
    let heldId = 1000000;
    w.setTimeout = (callback, delay, ...args) => {
        if (delay !== CHAT_READY_DELAY && delay !== FRAME_LOAD_DELAY) return realSetTimeout(callback, delay, ...args);
        held.set(++heldId, { callback, delay });
        return heldId;
    };
    w.clearTimeout = (id) => {
        if (held.has(id)) held.delete(id);
        else realClearTimeout(id);
    };
    const requests = [];
    let fetcher = async () => ({ code: 500, content: null });
    w.fetch = async (url, init = {}) => {
        const request = { url: new URL(String(url)), signal: init.signal };
        requests.push(request);
        const json = await fetcher(request);
        return { ok: true, json: async () => json };
    };
    w.chrome = chrome;
    // The manifest loads the shared in-page theme right after content.js. Most tests leave it out on purpose,
    // so the feature must also work when the optional ensureUiTheme request is missing.
    const scripts = withTheme
        ? SCRIPTS.flatMap((file) => (file === "content.js" ? [file, THEME_SCRIPT] : [file]))
        : SCRIPTS;
    for (const file of scripts) w.eval(read(file));
    t.after(() => {
        w.dispatchEvent(new w.Event("pagehide"));
        w.close();
    });

    const $ = (selector) => w.document.querySelector(selector);
    const f = {
        w,
        chrome,
        requests,
        storeMessages,
        localReads,
        syncReads,
        held,
        entry: () => $("#" + ENTRY_ID + " > button"),
        panel: () => w.document.getElementById(PANEL_ID),
        input: () => $("#" + PANEL_ID + " .bccmv-add input"),
        submit: () => $("#" + PANEL_ID + " .bccmv-add > button"),
        message: () => $("#" + PANEL_ID + " .bccmv-message")?.textContent || "",
        cell: (id) => $("#" + PANEL_ID + ' li[data-channel-id="' + id + '"]'),
        frame: (id) => f.cell(id)?.querySelector("iframe") || null,
        action: (id, action) => f.cell(id)?.querySelector('button[data-action="' + action + '"]') || null,
        targetText: (id) => f.cell(id)?.querySelector(".bccmv-cell-target")?.textContent || "",
        overlayText: (id) => f.cell(id)?.querySelector(".bccmv-cell-overlay p")?.textContent || "",
        result: (id) => $("#" + PANEL_ID + ' .bccmv-results button[data-channel-id="' + id + '"]'),
        sizeButton: (size) => $("#" + PANEL_ID + ' button[data-size="' + size + '"]'),
        bar: () => $("#" + PANEL_ID + " .bccmv-bar"),
        addToggle: () => $("#" + PANEL_ID + ' .bccmv-bar button[aria-label="채널 추가"]'),
        settingsToggle: () => $("#" + PANEL_ID + ' .bccmv-bar button[aria-label="채팅 멀티뷰 설정"]'),
        inputSwitch: () => $("#" + PANEL_ID + ' button[role="switch"]'),
        scaleButton: (direction) =>
            $("#" + PANEL_ID + ' button[aria-label="채팅 크기 ' + (direction < 0 ? "줄이기" : "키우기") + '"]'),
        scaleText: () => $("#" + PANEL_ID + " .bccmv-scale-value")?.textContent || "",
        sheetShown: (name) =>
            !$("#" + PANEL_ID + " .bccmv-" + name).hidden && !$("#" + PANEL_ID + " .bccmv-sheet").hidden,
        cornerButton: (corner) => $("#" + PANEL_ID + ' button[data-corner="' + corner + '"]'),
        cellIds: () =>
            [...w.document.querySelectorAll("#" + PANEL_ID + " li[data-channel-id]")]
                .sort((left, right) => Number(left.style.order) - Number(right.style.order))
                .map((node) => node.dataset.channelId),
        stored: () => clone(chrome.testState.local[KEY]),
        setFetch(next) {
            fetcher = next;
        },
        setStoreMode(mode) {
            storeMode = mode;
        },
        releaseReads() {
            holding = false;
            for (const deliver of heldReads.splice(0)) deliver();
        },
        trusted(node, type = "click", props = {}) {
            assert.ok(node === w || node?.isConnected, "trusted " + type + " target must be connected");
            if (type === "click" && node.disabled) return false;
            const event = {
                type,
                isTrusted: true,
                target: node,
                currentTarget: node,
                isComposing: false,
                button: 0,
                pointerId: 1,
                pointerType: "mouse",
                clientX: 0,
                clientY: 0,
                defaultPrevented: false,
                preventDefault() {
                    this.defaultPrevented = true;
                },
                stopPropagation() {},
                ...props,
            };
            const callbacks = listeners.get(node)?.get(type) || [];
            assert.ok(callbacks.length > 0, "no " + type + " listener");
            for (const callback of callbacks) callback.call(node, event);
            return true;
        },
        typeText(value) {
            f.input().value = value;
            f.input().dispatchEvent(new w.Event("input", { bubbles: true }));
        },
        enter() {
            f.trusted(f.input(), "keydown", { key: "Enter" });
        },
        async open() {
            await waitForCondition(() => f.entry(), { message: "header button" });
            f.trusted(f.entry());
            await waitForCondition(() => f.panel()?.querySelector(".bccmv-count")?.textContent, {
                message: "loaded panel",
            });
        },
        // The add and settings sheets open from the hover bar; opening them starts no request or save.
        openAdd() {
            if (!f.sheetShown("add")) f.addToggle().click();
            assert.ok(f.sheetShown("add"), "add sheet");
        },
        openSettings() {
            if (!f.sheetShown("settings")) f.settingsToggle().click();
            assert.ok(f.sheetShown("settings"), "settings sheet");
        },
        fire(delay) {
            for (const [id, timer] of [...held]) {
                if (timer.delay !== delay) continue;
                held.delete(id);
                timer.callback();
            }
        },
        heldCount: (delay) => [...held.values()].filter((timer) => timer.delay === delay).length,
        changeLocal(value) {
            const change = { oldValue: clone(chrome.testState.local[KEY]) };
            if (value === undefined) delete chrome.testState.local[KEY];
            else {
                chrome.testState.local[KEY] = clone(value);
                change.newValue = clone(value);
            }
            for (const listener of [...chrome.testState.storageChangeListeners]) listener({ [KEY]: change }, "local");
        },
        changeSync(values) {
            const changes = {};
            for (const [key, newValue] of Object.entries(values)) {
                changes[key] = { oldValue: chrome.testState.sync[key], newValue };
                chrome.testState.sync[key] = newValue;
            }
            for (const listener of [...chrome.testState.storageChangeListeners]) listener(changes, "sync");
        },
        navigate(url) {
            w.history.pushState({}, "", url);
            w.dispatchEvent(new w.Event("cheese-spanner:routechange"));
        },
        // Models the same-origin chat document behind one cell's frame.
        attachFrame(id, { chat = true, navigation = true, path: framePath = "/live/" + id + "/chat" } = {}) {
            const frame = f.frame(id);
            assert.ok(frame, "missing frame for " + id);
            const doc = w.document.implementation.createHTMLDocument("chat");
            const nav = navigation ? new w.EventTarget() : null;
            const location = { href: "", origin: chatModel.FRAME_ORIGIN, pathname: "" };
            let crossOrigin = false;
            const setPath = (next) => {
                location.pathname = next;
                location.href = chatModel.FRAME_ORIGIN + next;
            };
            setPath(framePath);
            const view = {
                navigation: nav,
                get location() {
                    if (crossOrigin) throw new w.DOMException("Blocked a cross-origin frame", "SecurityError");
                    return location;
                },
            };
            Object.defineProperty(frame, "contentWindow", { configurable: true, get: () => view });
            Object.defineProperty(frame, "contentDocument", {
                configurable: true,
                get: () => (crossOrigin ? null : doc),
            });
            const native = {
                doc,
                addLog() {
                    const log = doc.createElement("div");
                    log.setAttribute("role", "log");
                    doc.body.append(log);
                },
                load() {
                    frame.dispatchEvent(new w.Event("load"));
                },
                navigate(next) {
                    setPath(next);
                    nav?.dispatchEvent(new w.Event("currententrychange"));
                },
                moveSilently(next) {
                    setPath(next);
                },
                leaveOrigin() {
                    crossOrigin = true;
                    frame.dispatchEvent(new w.Event("load"));
                },
            };
            if (chat) native.addLog();
            return native;
        },
    };
    return f;
}

function collectJsFiles(dir) {
    const files = [];
    for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
        const relative = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...collectJsFiles(relative));
        else if (entry.isFile() && entry.name.endsWith(".js")) files.push(relative);
    }
    return files;
}

// ── 순수 모델 ────────────────────────────────────────────────────────────────

test("model exposes the delegated contract and a default layout that passes strict parsing", () => {
    assert.equal(chatModel.STORAGE_KEY, KEY);
    assert.equal(chatModel.MAX_CHANNELS, 4);
    const fallback = chatModel.normalizeConfig(undefined);
    assert.deepEqual(fallback, {
        version: 2,
        channels: [],
        chatWidth: 340,
        chatHeight: 600,
        corner: "bottom-right",
        x: 16,
        y: 16,
        input: false,
        scale: 100,
    });
    assert.deepEqual(chatModel.parseConfig(fallback), { ok: true, config: fallback });
    assert.ok(Object.isFrozen(chatModel.DEFAULT_CONFIG));
    const value = layout([A, B, C, D], { chatWidth: 1600, chatHeight: 180, corner: "top-left", x: 7680, y: 0 });
    const parsed = chatModel.parseConfig(value);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.config, value);
    assert.notEqual(parsed.config, value);
    assert.notEqual(parsed.config.channels[0], value.channels[0]);
    assert.equal(chatModel.parseConfig(layout([A], { channels: [{ channelId: A, channelName: "" }] })).ok, true);
    // The earlier panel-sized format keeps its chats, corner, input, and chat size; sizes fall back to the default.
    assert.deepEqual(chatModel.parseConfig(legacyLayout([A], { width: 720, corner: "bottom-left" })), {
        ok: true,
        config: layout([A], { corner: "bottom-left" }),
    });
    assert.deepEqual(chatModel.parseConfig(legacyLayout([A, B], { input: true, scale: 70 })), {
        ok: true,
        config: layout([A, B], { input: true, scale: 70 }),
    });
});

test("parseConfig rejects every shape outside the exact stored format instead of trimming it", () => {
    const valid = layout([A]);
    const cases = [
        [null, "not-object"],
        [[], "not-object"],
        ["layout", "not-object"],
        [{ ...valid, open: true }, "unexpected-fields"],
        [{ version: 2, channels: [], chatWidth: 340, chatHeight: 600 }, "unexpected-fields"],
        [{ ...valid, input: undefined, scale: undefined }, "invalid-input"],
        [{ ...valid, version: 3 }, "invalid-version"],
        [{ ...valid, channels: {} }, "invalid-channels"],
        [layout([A, B, C, D, E]), "too-many-channels"],
        [{ ...valid, channels: [{ channelId: A, channelName: "a", live: true }] }, "invalid-channel"],
        [{ ...valid, channels: [A] }, "invalid-channel"],
        [{ ...valid, channels: [{ channelId: A.toUpperCase(), channelName: "a" }] }, "invalid-channel-id"],
        [{ ...valid, channels: [{ channelId: A.slice(1), channelName: "a" }] }, "invalid-channel-id"],
        [{ ...valid, channels: [{ channelId: A, channelName: " 채널" }] }, "invalid-channel-name"],
        [{ ...valid, channels: [{ channelId: A, channelName: "가".repeat(101) }] }, "invalid-channel-name"],
        [{ ...valid, channels: [{ channelId: A, channelName: 1 }] }, "invalid-channel-name"],
        [{ ...valid, channels: [...valid.channels, ...valid.channels] }, "duplicate-channel"],
        [{ ...valid, chatWidth: 239 }, "invalid-width"],
        [{ ...valid, chatWidth: 1601 }, "invalid-width"],
        [{ ...valid, chatWidth: 340.5 }, "invalid-width"],
        [{ ...valid, chatWidth: "340" }, "invalid-width"],
        [{ ...valid, chatHeight: 179 }, "invalid-height"],
        [{ ...valid, chatHeight: 2161 }, "invalid-height"],
        [{ ...valid, corner: "center" }, "invalid-corner"],
        [{ ...valid, x: -1 }, "invalid-position"],
        [{ ...valid, x: 7681 }, "invalid-position"],
        [{ ...valid, y: 1.5 }, "invalid-position"],
        [{ ...valid, y: "16" }, "invalid-position"],
        [legacyLayout([A], { extra: true }), "unexpected-fields"],
        [legacyLayout([A], { width: 319 }), "invalid-width"],
        [legacyLayout([A], { height: 2161 }), "invalid-height"],
        [legacyLayout([A], { corner: "top-left" }), "invalid-corner"],
        [legacyLayout([A], { scale: 200 }), "invalid-scale"],
        [{ ...valid, input: "true" }, "invalid-input"],
        [{ ...valid, input: null }, "invalid-input"],
        [{ ...valid, scale: 69 }, "invalid-scale"],
        [{ ...valid, scale: 151 }, "invalid-scale"],
        [{ ...valid, scale: 100.5 }, "invalid-scale"],
        [{ ...valid, scale: "100" }, "invalid-scale"],
    ];
    for (const [value, error] of cases) {
        assert.deepEqual(chatModel.parseConfig(value), { ok: false, error }, JSON.stringify(value));
        assert.deepEqual(
            chatModel.normalizeConfig(value),
            chatModel.normalizeConfig(undefined),
            "reads fall back to default"
        );
    }
    const emoji = "😀".repeat(100);
    assert.equal(chatModel.parseConfig({ ...valid, channels: [{ channelId: A, channelName: emoji }] }).ok, true);
});

test("frame addresses are only the native chat path of a validated lowercase channel id", () => {
    assert.equal(chatModel.frameUrl(A), "https://chzzk.naver.com/live/" + A + "/chat");
    for (const value of [A.toUpperCase(), A.slice(1), A + "/../x", A + "?x", "", undefined, null, 1])
        assert.equal(chatModel.frameUrl(value), "", String(value));
    assert.equal(chatModel.isFramePath("/live/" + A + "/chat", A), true);
    assert.equal(chatModel.isFramePath("/live/" + A + "/chat/", A), true);
    for (const pathname of ["/live/" + A, "/live/" + B + "/chat", "/live/" + A + "/chat/x", "/" + A, "/chat"])
        assert.equal(chatModel.isFramePath(pathname, A), false, pathname);
    assert.equal(chatModel.isFramePath("/live/undefined/chat", undefined), false);
});

test("channel input accepts ids and CHZZK channel addresses, searches names, and rejects other addresses", () => {
    const id = (channelId) => ({ kind: "id", channelId });
    for (const [input, expected] of [
        [A, id(A)],
        ["  " + A.toUpperCase() + "  ", id(A)],
        ["https://chzzk.naver.com/live/" + A, id(A)],
        ["https://chzzk.naver.com/live/" + A + "/chat", id(A)],
        ["http://chzzk.naver.com/live/" + A + "/", id(A)],
        ["chzzk.naver.com/" + A, id(A)],
        ["https://chzzk.naver.com/" + A + "/videos?page=2", id(A)],
        ["", { kind: "empty" }],
        ["   ", { kind: "empty" }],
        ["  치즈 스패너 ", { kind: "keyword", keyword: "치즈 스패너" }],
        ["https://example.com/live/" + A, { kind: "invalid" }],
        ["https://chzzk.naver.com.example.com/live/" + A, { kind: "invalid" }],
        ["https://m.chzzk.naver.com/live/" + A, { kind: "invalid" }],
        ["https://user@chzzk.naver.com/live/" + A, { kind: "invalid" }],
        ["https://chzzk.naver.com:8443/live/" + A, { kind: "invalid" }],
        ["ftp://chzzk.naver.com/live/" + A, { kind: "invalid" }],
        ["chzzk.naver.com/video/123", { kind: "invalid" }],
        ["chzzk.naver.com/live/" + A + "/chat/extra", { kind: "invalid" }],
    ])
        assert.deepEqual(chatModel.parseChannelInput(input), expected, input);
});

test("layout changes return fresh values and keep the four-chat, duplicate, size, and corner rules", () => {
    const base = layout([A, B, C]);
    const snapshot = clone(base);
    const added = chatModel.addChannel(base, { channelId: D, channelName: "  " + "가".repeat(105) + "  " });
    assert.equal(added.ok, true);
    assert.deepEqual(added.config.channels.at(-1), { channelId: D, channelName: "가".repeat(100) });
    assert.equal(chatModel.parseConfig(added.config).ok, true);
    assert.deepEqual(base, snapshot, "inputs are never mutated");
    assert.deepEqual(chatModel.addChannel(added.config, channel(E)), { ok: false, error: "limit" });
    assert.deepEqual(chatModel.addChannel(base, channel(A)), { ok: false, error: "duplicate" });
    assert.deepEqual(chatModel.addChannel(base, { channelId: "bad", channelName: "x" }), {
        ok: false,
        error: "invalid-channel",
    });
    const ids = (result) => result.config.channels.map((item) => item.channelId);
    assert.deepEqual(ids(chatModel.moveChannel(base, B, -1)), [B, A, C]);
    assert.deepEqual(ids(chatModel.moveChannel(base, B, 1)), [A, C, B]);
    assert.equal(chatModel.moveChannel(base, A, -1).unchanged, true);
    assert.equal(chatModel.moveChannel(base, C, 1).unchanged, true);
    assert.equal(chatModel.moveChannel(base, E, 1).unchanged, true);
    assert.deepEqual(ids(chatModel.removeChannel(base, B)), [A, C]);
    assert.equal(chatModel.removeChannel(base, E).unchanged, true);
    assert.deepEqual(chatModel.withChatSize(base, 10, 99999.6).config, { ...base, chatWidth: 240, chatHeight: 2160 });
    assert.equal(chatModel.withChatSize(base, 340, 600).unchanged, true);
    assert.equal(chatModel.withChatSize(base, Number.NaN, 600).ok, false);
    assert.deepEqual(chatModel.withPosition(base, "top-left", 20.4, 99999).config, {
        ...base,
        corner: "top-left",
        x: 20,
        y: 7680,
    });
    assert.equal(chatModel.withPosition(base, "bottom-right", 16, 16).unchanged, true);
    assert.equal(chatModel.withPosition(base, "center", 0, 0).ok, false);
    assert.equal(chatModel.withPosition(base, "top-left", Number.NaN, 0).ok, false);
    assert.equal(chatModel.parseConfig(chatModel.withPosition(base, "top-right", -5, 3).config).ok, true);
    assert.equal(chatModel.sizePresetOf(base), "medium");
    assert.equal(chatModel.sizePresetOf({ ...base, chatWidth: 420, chatHeight: 760 }), "large");
    assert.equal(chatModel.sizePresetOf({ ...base, chatWidth: 300 }), "");
    assert.deepEqual(chatModel.withInput(base, true).config, { ...base, input: true });
    assert.equal(chatModel.withInput(base, false).unchanged, true);
    assert.equal(chatModel.withInput(base, "yes").ok, false);
    const scaled = (scale, direction) => chatModel.stepScale({ ...base, scale }, direction);
    assert.equal(scaled(100, 1).config.scale, 110);
    assert.equal(scaled(100, -1).config.scale, 90);
    assert.equal(scaled(95, 1).config.scale, 100, "an off-step value moves to the next step");
    assert.equal(scaled(95, -1).config.scale, 90);
    assert.equal(scaled(150, 1).unchanged, true);
    assert.equal(scaled(70, -1).unchanged, true);
    assert.equal(chatModel.parseConfig(scaled(140, 1).config).ok, true);
    assert.deepEqual(base, snapshot);
});

test("stored values compare structurally for expected-state checks regardless of key order", () => {
    const value = layout([A, B]);
    const reordered = {
        corner: value.corner,
        y: value.y,
        x: value.x,
        chatHeight: value.chatHeight,
        chatWidth: value.chatWidth,
        channels: value.channels.map(({ channelName, channelId }) => ({ channelName, channelId })),
        scale: value.scale,
        input: value.input,
        version: 2,
    };
    assert.equal(chatModel.isSameStoredValue(value, reordered), true);
    assert.equal(chatModel.isSameStoredValue(undefined, undefined), true);
    assert.equal(chatModel.isSameStoredValue(undefined, value), false);
    assert.equal(chatModel.isSameStoredValue(value, layout([B, A])), false);
    assert.equal(chatModel.isSameStoredValue(value, { ...value, extra: undefined }), false);
    assert.equal(chatModel.isSameStoredValue([1, 2], [1, 2]), true);
    assert.equal(chatModel.isSameStoredValue([1, 2], { 0: 1, 1: 2 }), false);
});

// ── 페이지 런타임 ─────────────────────────────────────────────────────────────

test("stays off by default without reading the layout or adding a header button", async (t) => {
    const f = fixture(t, { enabled: false, stored: layout([A]) });
    assert.equal(f.w.CheeseSpannerSettings.DEFAULT_OPTIONS.chatMultiviewEnabled, false);
    await waitForCondition(() => f.syncReads.length > 0);
    // The option callback and one animation frame have passed; nothing may appear after them.
    await settle(50);
    assert.equal(f.entry(), null);
    assert.equal(f.panel(), null);
    assert.deepEqual(f.localReads, []);
    assert.equal(f.w.document.querySelector("iframe"), null);
    assert.equal(f.requests.length, 0);
    assert.equal(f.storeMessages.length, 0);
});

test("opens only from a trusted header click and shows saved channels as native chat frames", async (t) => {
    const f = fixture(t, { stored: layout([A, B]) });
    const mainVideo = f.w.document.getElementById("main-video");
    const mainChat = f.w.document.getElementById("aside-chatting");
    const mainHtml = f.w.document.getElementById("layout-body").outerHTML;
    await waitForCondition(() => f.entry());
    assert.equal(f.entry().textContent, "채팅 멀티뷰");
    assert.equal(f.entry().getAttribute("aria-expanded"), "false");
    assert.equal(f.w.document.querySelectorAll("#" + ENTRY_ID).length, 1);
    assert.equal(f.panel(), null, "a reload never reopens saved chats");
    f.entry().click();
    f.entry().dispatchEvent(new f.w.MouseEvent("click", { bubbles: true }));
    assert.equal(f.panel(), null, "synthetic page clicks must not load chat frames");

    await f.open();
    assert.equal(f.panel().getAttribute("role"), "dialog");
    assert.equal(f.entry().getAttribute("aria-expanded"), "true");
    assert.notEqual(f.w.document.activeElement, f.input(), "saved chats open without pulling focus into the bar");
    assert.equal(f.sheetShown("add"), false, "only the chats show; adding waits behind the hover bar");
    assert.equal(f.panel().querySelector(".bccmv-count").textContent, "2/4");
    assert.deepEqual(f.cellIds(), [A, B]);
    assert.equal(f.w.document.querySelectorAll("iframe").length, 2);
    for (const id of [A, B]) {
        const frame = f.frame(id);
        assert.equal(frame.getAttribute("src"), "https://chzzk.naver.com/live/" + id + "/chat");
        const sandbox = frame.getAttribute("sandbox").split(/\s+/);
        assert.ok(sandbox.includes("allow-scripts") && sandbox.includes("allow-same-origin"));
        assert.equal(sandbox.includes("allow-top-navigation"), false, "frames cannot replace the main page");
        assert.ok(frame.hasAttribute("inert"), "an unverified frame cannot take input");
        assert.equal(f.targetText(id), "입력 대상 확인 중");
        assert.equal(f.cell(id).querySelector(".bccmv-cell-name").textContent, nameOf(id));
        // The head shows the channel name only; the input target is read out through the frame description.
        assert.ok(f.cell(id).querySelector(".bccmv-cell-target").classList.contains("bccmv-visually-hidden"));
        assert.equal(f.frame(id).getAttribute("aria-describedby"), f.cell(id).querySelector(".bccmv-cell-target").id);
        assert.equal(f.cell(id).querySelector(".bccmv-avatar"), null);
    }
    assert.equal(f.storeMessages.length, 0, "opening never writes the layout");
    assert.deepEqual(f.stored(), layout([A, B]));

    f.panel().querySelector('[aria-label="채팅 멀티뷰 닫기"]').click();
    assert.equal(f.panel(), null);
    assert.equal(f.w.document.querySelector("iframe"), null);
    assert.equal(f.entry().getAttribute("aria-expanded"), "false");
    assert.equal(f.w.document.activeElement, f.entry());
    assert.equal(f.w.document.getElementById("main-video"), mainVideo);
    assert.equal(f.w.document.getElementById("aside-chatting"), mainChat);
    assert.equal(f.w.document.getElementById("layout-body").outerHTML, mainHtml);
    assert.equal(f.storeMessages.length, 0);
    assert.equal(f.held.size, 0, "closing clears frame timers");
});

test("a frame load alone is not success: the verified chat path and the native chat log are both required", async (t) => {
    const f = fixture(t, { stored: layout([A, B, C]) });
    await f.open();
    const a = f.attachFrame(A, { chat: false });
    a.load();
    assert.equal(f.cell(A).dataset.state, "loading");
    assert.equal(f.targetText(A), "입력 대상 확인 중");
    assert.ok(f.frame(A).hasAttribute("inert"));
    a.addLog();
    await waitForCondition(() => f.cell(A).dataset.state === "ready");
    assert.equal(f.targetText(A), "입력 대상: " + nameOf(A));
    assert.equal(f.frame(A).hasAttribute("inert"), false);
    assert.equal(f.cell(A).querySelector(".bccmv-cell-overlay").hidden, true);

    const b = f.attachFrame(B, { chat: false });
    b.load();
    f.fire(CHAT_READY_DELAY);
    assert.equal(f.cell(B).dataset.state, "unverified");
    assert.equal(f.targetText(B), "입력 대상: " + nameOf(B));
    assert.match(f.cell(B).textContent, /채팅 목록을 확인하지 못했어요/);
    assert.equal(f.action(B, "retry").hidden, false);

    f.fire(FRAME_LOAD_DELAY);
    assert.equal(f.cell(C).dataset.state, "failed");
    assert.equal(f.overlayText(C), "채팅을 불러오지 못했어요.");
    assert.ok(f.frame(C).hasAttribute("inert"));
    assert.equal(f.cell(A).dataset.state, "ready", "each cell keeps its own state");
    assert.equal(f.cell(B).dataset.state, "unverified");

    f.action(C, "reload").click();
    assert.equal(f.cell(C).dataset.state, "failed", "a synthetic click does not reload");
    f.trusted(f.action(C, "reload"));
    assert.equal(f.cell(C).dataset.state, "loading");
    assert.equal(f.frame(C).getAttribute("src"), chatModel.frameUrl(C));
    assert.equal(f.heldCount(FRAME_LOAD_DELAY), 1);
    f.trusted(f.action(B, "retry"));
    assert.equal(f.cell(B).dataset.state, "loading");
    assert.equal(f.frame(B).getAttribute("src"), chatModel.frameUrl(B));
    assert.equal(f.storeMessages.length, 0);
    assert.equal(f.requests.length, 0, "frames never call channel APIs");
});

test("a verified chat frame that moves to another address is hidden until it returns to its own chat", async (t) => {
    const f = fixture(t, { stored: layout([A, B, C]) });
    await f.open();
    const a = f.attachFrame(A);
    const frameA = f.frame(A);
    a.load();
    assert.equal(f.cell(A).dataset.state, "ready");
    a.navigate("/live/" + B + "/chat");
    assert.equal(f.cell(A).dataset.state, "left");
    assert.ok(frameA.hasAttribute("inert"));
    assert.equal(frameA.isConnected, false, "the hidden document that left its chat is unloaded");
    assert.equal(f.targetText(A), "입력할 수 없어요");
    assert.match(f.overlayText(A), /벗어나/);
    assert.equal(f.action(A, "reload").textContent, "채팅으로 돌아가기");
    f.trusted(f.action(A, "reload"));
    assert.equal(f.cell(A).dataset.state, "loading");
    assert.equal(f.frame(A), frameA, "returning reuses the same frame element");
    a.moveSilently("/live/" + A + "/chat");
    a.load();
    assert.equal(f.cell(A).dataset.state, "ready");

    // Without the Navigation API the frame is checked again when the pointer enters it.
    const b = f.attachFrame(B, { navigation: false });
    const frameB = f.frame(B);
    b.load();
    assert.equal(f.cell(B).dataset.state, "ready");
    b.moveSilently("/" + B);
    f.cell(B).querySelector(".bccmv-cell-body").dispatchEvent(new f.w.Event("pointerenter"));
    assert.equal(f.cell(B).dataset.state, "left");
    assert.ok(frameB.hasAttribute("inert"));
    assert.equal(frameB.isConnected, false);

    // A login page or any other origin is never shown as the chat input target.
    const c = f.attachFrame(C);
    const frameC = f.frame(C);
    c.load();
    assert.equal(f.cell(C).dataset.state, "ready");
    c.leaveOrigin();
    assert.equal(f.cell(C).dataset.state, "left");
    assert.ok(frameC.hasAttribute("inert"));
    assert.equal(frameC.isConnected, false);
});

test("a cell that leaves for a live page unloads that hidden page and returns only to its own chat address", async (t) => {
    const f = fixture(t, { stored: layout([A, B]) });
    await f.open();
    const a = f.attachFrame(A);
    const frame = f.frame(A);
    const body = f.cell(A).querySelector(".bccmv-cell-body");
    a.load();
    assert.equal(f.cell(A).dataset.state, "ready");
    // The chat document's own SPA moves to another channel's live page, which would mount its player.
    a.navigate("/live/" + C);
    assert.equal(f.cell(A).dataset.state, "left");
    assert.equal(frame.isConnected, false, "the hidden live page does not stay loaded behind the overlay");
    assert.equal(frame.getAttribute("src"), chatModel.frameUrl(A), "the frame address is never changed to it");
    assert.equal(f.cell(A).querySelector(".bccmv-cell-overlay").hidden, false);
    assert.equal(f.action(A, "reload").textContent, "채팅으로 돌아가기");
    assert.equal(f.w.document.querySelectorAll("iframe").length, 1, "no other frame takes its place");
    assert.equal(f.heldCount(FRAME_LOAD_DELAY) + f.heldCount(CHAT_READY_DELAY), 1, "only B still waits");
    // A later pointer check or another tab's layout change does not bring the page back.
    body.dispatchEvent(new f.w.Event("pointerenter"));
    f.changeLocal(layout([A, B]));
    assert.equal(frame.isConnected, false);
    assert.equal(f.cell(A).dataset.state, "left");

    // Returning puts the same frame back first in the cell, at its chat address only, and waits for verification.
    f.trusted(f.action(A, "reload"));
    assert.equal(f.frame(A), frame);
    assert.equal(body.firstElementChild, frame);
    assert.equal(frame.getAttribute("src"), chatModel.frameUrl(A));
    assert.equal(f.cell(A).dataset.state, "loading");
    assert.ok(frame.hasAttribute("inert"), "the returned frame waits for verification before taking input");
    assert.equal(f.heldCount(FRAME_LOAD_DELAY), 2);
    a.moveSilently("/live/" + A + "/chat");
    a.load();
    assert.equal(f.cell(A).dataset.state, "ready");
    assert.equal(frame.hasAttribute("inert"), false);
    assert.equal(f.w.document.querySelectorAll("iframe").length, 2);
    assert.equal(f.requests.length, 0);
    assert.equal(f.storeMessages.length, 0);

    // A cell that is still away when the panel closes leaves nothing behind.
    a.navigate("/live/" + C);
    assert.equal(frame.isConnected, false);
    f.panel().querySelector('[aria-label="채팅 멀티뷰 닫기"]').click();
    assert.equal(f.w.document.querySelector("iframe"), null);
    assert.equal(f.held.size, 0);
});

test("adds a channel from its address only after a matching lookup and saves with the previous value as expected", async (t) => {
    const f = fixture(t);
    await f.open();
    assert.match(f.panel().textContent, /채널을 추가하면/);
    f.setFetch(async ({ url }) => {
        const id = url.pathname.split("/").pop();
        return id === A
            ? { code: 200, content: { channelId: A, channelName: "  " + nameOf(A) + "  " } }
            : { code: 200, content: null };
    });
    f.typeText("https://chzzk.naver.com/live/" + A);
    f.input().dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    f.submit().click();
    assert.equal(f.requests.length, 0, "synthetic Enter or clicks must not query");
    f.enter();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].url.href, "https://api.chzzk.naver.com/service/v1/channels/" + A);
    await waitForCondition(() => f.storeMessages.length === 1);
    assert.deepEqual(f.storeMessages[0], {
        type: STORE_TYPE,
        version: 1,
        area: "local",
        values: { [KEY]: layout([A]) },
        expected: { [KEY]: { absent: true } },
    });
    await waitForCondition(() => f.cell(A));
    assert.deepEqual(f.stored(), layout([A]));
    assert.equal(f.frame(A).getAttribute("src"), chatModel.frameUrl(A));
    assert.equal(f.input().value, "");
    assert.ok(f.sheetShown("add"), "the add sheet opened for an empty panel stays open for the next channel");
    assert.equal(f.w.document.activeElement, f.input());
    assert.equal(f.message(), nameOf(A) + " 채팅을 추가했어요.");

    const invalid = "치지직 채널 주소나 32자리 채널 ID를 확인해 주세요.";
    for (const [text, message] of [
        ["https://example.com/live/" + B, invalid],
        ["chzzk.naver.com/video/123", invalid],
        [A.toUpperCase(), "이미 추가한 채널이에요."],
        ["   ", "채널 URL·채널 ID 또는 채널명을 입력해 주세요."],
    ]) {
        f.typeText(text);
        f.enter();
        assert.equal(f.message(), message, text);
    }
    assert.equal(f.requests.length, 1, "rejected input never reaches the network");

    f.typeText(B);
    f.enter();
    await waitForCondition(() => /확인하지 못했어요/.test(f.message()));
    assert.equal(f.storeMessages.length, 1, "a failed lookup is not saved");
    assert.equal(f.cell(B), null);

    f.setFetch(async () => ({ code: 200, content: { channelId: C, channelName: nameOf(C) } }));
    f.typeText("chzzk.naver.com/" + C);
    f.trusted(f.submit());
    await waitForCondition(() => f.storeMessages.length === 2);
    assert.deepEqual(f.storeMessages[1].expected, { [KEY]: { value: layout([A]) } });
    await waitForCondition(() => f.cell(C));
    assert.deepEqual(f.stored(), layout([A, C]));
});

test("nickname search shows at most five validated channels, drops late responses, and adds on a trusted click", async (t) => {
    const f = fixture(t, { stored: layout([A]) });
    await f.open();
    f.openAdd();
    const pending = [];
    f.setFetch(() => {
        const next = deferred();
        pending.push(next);
        return next.promise;
    });
    f.typeText("치즈");
    f.enter();
    assert.equal(f.requests.length, 1);
    const first = f.requests[0];
    assert.equal(first.url.pathname, "/service/v1/search/channels");
    assert.equal(first.url.searchParams.get("keyword"), "치즈");
    assert.equal(first.url.searchParams.get("size"), "5");
    assert.equal(first.url.searchParams.get("withFirstChannelContent"), "false");
    f.typeText("치즈 스패너");
    assert.equal(first.signal.aborted, true, "changing the input cancels the old search");
    pending[0].resolve(searchResponse([B, C]));
    await settle();
    assert.equal(f.result(B), null, "a late response is discarded");

    f.enter();
    assert.equal(f.requests.length, 2);
    pending[1].resolve({
        code: 200,
        content: {
            data: [
                { channel: channel(A) },
                { channel: channel(B) },
                { channel: channel(B) },
                { channel: { channelId: "bad", channelName: "잘못된 채널" } },
                { channel: { ...channel(C), channelName: "  " } },
                { channel: channel(D) },
                { channel: channel(E) },
            ],
        },
    });
    await waitForCondition(() => f.result(B));
    const rows = f.panel().querySelectorAll(".bccmv-results button[data-channel-id]");
    const ids = [...rows].map((node) => node.dataset.channelId);
    assert.deepEqual(ids, [A, B], "only the first five rows are read and invalid rows are dropped");
    // Like the video multiview search, the whole row is the add control and shows its state on the right.
    assert.equal(f.result(A).querySelector(".bccmv-result-state").textContent, "추가됨");
    assert.equal(f.result(A).getAttribute("aria-label"), nameOf(A) + " 채팅, 이미 추가했어요");
    assert.equal(f.result(A).disabled, true);
    assert.equal(f.result(B).querySelector(".bccmv-result-state").textContent, "추가");
    assert.equal(f.result(B).getAttribute("aria-label"), nameOf(B) + " 채팅 추가");
    assert.equal(f.result(B).querySelector(".bccmv-result-name").textContent, nameOf(B));
    assert.equal(f.result(B).querySelector(".bccmv-result-detail").textContent, "팔로워 100명");
    assert.equal(f.result(B).disabled, false);
    f.result(B).click();
    await settle();
    assert.equal(f.storeMessages.length, 0, "a synthetic click does not save");
    f.trusted(f.result(B));
    await waitForCondition(() => f.cell(B));
    assert.deepEqual(f.stored(), layout([A, B]));
    assert.equal(f.panel().querySelector(".bccmv-results").hidden, true);
    assert.equal(f.requests.length, 2);
});

test("the add button reads 검색 for names and 추가 for addresses, and results show live status from the search", async (t) => {
    const f = fixture(t, { stored: layout([A]) });
    await f.open();
    f.openAdd();
    assert.equal(f.submit().textContent, "검색");
    f.typeText("https://chzzk.naver.com/live/" + B);
    assert.equal(f.submit().textContent, "추가");
    f.typeText(C);
    assert.equal(f.submit().textContent, "추가");
    f.typeText("탬탬");
    assert.equal(f.submit().textContent, "검색");
    f.setFetch(async () => ({
        code: 200,
        content: {
            data: [
                { channel: { ...channel(B), openLive: true } },
                { channel: { ...channel(C), openLive: false, followerCount: 12345 } },
            ],
        },
    }));
    f.enter();
    await waitForCondition(() => f.result(C));
    assert.equal(f.result(B).querySelector(".bccmv-result-detail").textContent, "방송 중 · 팔로워 100명");
    assert.equal(f.result(B).querySelector(".bccmv-result-detail").dataset.live, "1");
    assert.equal(f.result(C).querySelector(".bccmv-result-detail").textContent, "오프라인 · 팔로워 12,345명");
    assert.match(f.panel().querySelector(".bccmv-results").textContent, /끌어 놓아도 추가돼요/);
});

test("a following channel link dropped on the panel is looked up and added; other drops and synthetic drops are not", async (t) => {
    const f = fixture(t, { stored: layout([A]) });
    await f.open();
    const panel = f.panel();
    const transfer = (url, types = ["text/uri-list", "text/plain"]) => ({
        types,
        dropEffect: "none",
        getData: (type) => (type === "text/uri-list" || type === "text/plain" ? url : ""),
    });

    f.trusted(f.w, "dragstart");
    assert.ok(panel.hasAttribute("data-bccmv-dragging"), "chat frames stop taking pointer events while dragging");
    const folderDrag = {
        types: ["application/x-cheese-spanner-following-folder"],
        dropEffect: "none",
        getData: () => "",
    };
    const ignored = { defaultPrevented: false };
    f.trusted(panel, "dragover", {
        dataTransfer: folderDrag,
        preventDefault() {
            ignored.defaultPrevented = true;
        },
    });
    assert.equal(ignored.defaultPrevented, false, "drags without a link are not accepted");
    assert.equal(panel.hasAttribute("data-bccmv-drop"), false);

    const link = transfer("https://chzzk.naver.com/live/" + B);
    const over = { defaultPrevented: false };
    f.trusted(panel, "dragover", {
        dataTransfer: link,
        preventDefault() {
            over.defaultPrevented = true;
        },
    });
    assert.equal(over.defaultPrevented, true);
    assert.equal(link.dropEffect, "link");
    assert.equal(panel.getAttribute("data-bccmv-drop"), "ready");

    panel.dispatchEvent(new f.w.Event("drop", { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(f.requests.length, 0, "a synthetic drop never looks up or adds channels");

    f.setFetch(async () => ({ code: 200, content: { channelId: B, channelName: nameOf(B) } }));
    f.trusted(panel, "drop", { dataTransfer: link });
    assert.equal(panel.hasAttribute("data-bccmv-drop"), false);
    await waitForCondition(() => f.cell(B));
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].url.pathname, "/service/v1/channels/" + B);
    assert.deepEqual(f.stored(), layout([A, B]));

    f.trusted(panel, "dragover", { dataTransfer: transfer("https://chzzk.naver.com/lives") });
    f.trusted(panel, "drop", { dataTransfer: transfer("https://chzzk.naver.com/lives") });
    await waitForCondition(() => /치지직 채널 링크만/.test(f.message()));
    assert.equal(f.requests.length, 1, "non-channel links are not looked up");

    f.trusted(panel, "dragover", { dataTransfer: transfer("https://chzzk.naver.com/" + B) });
    f.trusted(panel, "drop", { dataTransfer: transfer("https://chzzk.naver.com/" + B) });
    await waitForCondition(() => /이미 추가한 채널/.test(f.message()));
    assert.equal(f.requests.length, 1);

    f.trusted(f.w, "dragend");
    assert.equal(panel.hasAttribute("data-bccmv-dragging"), false);
});

test("a drag whose source leaves the page before it ends does not keep chat frames from taking the pointer", async (t) => {
    const f = fixture(t, { stored: layout([A]) });
    await f.open();
    const panel = f.panel();
    const link = { types: ["text/uri-list"], dropEffect: "none", getData: () => "" };
    // The press that starts a drag comes before dragstart and does not cancel the drag state.
    f.trusted(f.w, "pointerdown");
    f.trusted(f.w, "dragstart");
    assert.ok(panel.hasAttribute("data-bccmv-dragging"));
    f.trusted(panel, "dragover", { dataTransfer: link });
    assert.ok(panel.hasAttribute("data-bccmv-dragging"), "a drag in progress keeps the frames out of the way");
    assert.equal(panel.getAttribute("data-bccmv-drop"), "ready");
    // The dragged sidebar row is replaced mid-drag (e.g. a re-rendered following row). Its dragend fires at the
    // detached node, so it never reaches the window, and nothing is dropped: only the leave arrives here.
    f.trusted(panel, "dragleave", { relatedTarget: null });
    assert.equal(panel.hasAttribute("data-bccmv-drop"), false);
    assert.ok(panel.hasAttribute("data-bccmv-dragging"), "no dragend or drop reached this document");
    // A page script's synthetic press does not change it; the user's next press, which only happens after the
    // drag is over, gives the chat frames the pointer again.
    f.w.dispatchEvent(new f.w.Event("pointerdown"));
    assert.ok(panel.hasAttribute("data-bccmv-dragging"));
    f.trusted(f.w, "pointerdown");
    assert.equal(panel.hasAttribute("data-bccmv-dragging"), false);
    assert.equal(f.storeMessages.length, 0);
    assert.equal(f.requests.length, 0);

    // The ordinary end of a drag still clears it at once.
    f.trusted(f.w, "dragstart");
    f.trusted(f.w, "dragend");
    assert.equal(panel.hasAttribute("data-bccmv-dragging"), false);
});

test("keeps the four-chat limit and removes one chat without recreating the others", async (t) => {
    const f = fixture(t, { stored: layout([A, B, C, D]) });
    await f.open();
    f.openAdd();
    const frames = Object.fromEntries([A, C, D].map((id) => [id, f.frame(id)]));
    for (const text of [E, "다른 채널"]) {
        f.typeText(text);
        f.enter();
        assert.equal(f.message(), "채팅은 최대 4개까지 추가할 수 있어요.", text);
    }
    assert.equal(f.requests.length, 0);
    f.action(B, "remove").click();
    await settle();
    assert.equal(f.storeMessages.length, 0);
    f.trusted(f.action(B, "remove"));
    await waitForCondition(() => !f.cell(B));
    assert.deepEqual(f.storeMessages[0].expected, { [KEY]: { value: layout([A, B, C, D]) } });
    assert.deepEqual(f.stored(), layout([A, C, D]));
    for (const id of [A, C, D]) assert.equal(f.frame(id), frames[id], "kept chats are not recreated");
    assert.deepEqual(f.cellIds(), [A, C, D]);
});

test("reordering keeps every chat frame alive and keeps keyboard focus on a usable control", async (t) => {
    const f = fixture(t, { stored: layout([A, B, C]) });
    await f.open();
    const frames = [A, B, C].map((id) => f.frame(id));
    const pendingLoads = f.heldCount(FRAME_LOAD_DELAY);
    assert.equal(f.action(A, "back").disabled, true);
    assert.equal(f.action(C, "forward").disabled, true);
    f.action(B, "back").focus();
    f.trusted(f.action(B, "back"));
    await waitForCondition(() => f.cellIds()[0] === B);
    assert.deepEqual(f.stored(), layout([B, A, C]));
    assert.deepEqual(f.cellIds(), [B, A, C]);
    assert.deepEqual(
        [A, B, C].map((id) => f.frame(id)),
        frames
    );
    assert.ok(frames.every((frame) => frame.isConnected));
    assert.equal(f.heldCount(FRAME_LOAD_DELAY), pendingLoads, "no frame was reloaded");
    assert.equal(f.action(B, "back").disabled, true);
    assert.equal(f.w.document.activeElement, f.action(B, "forward"));
    f.trusted(f.action(A, "forward"));
    await waitForCondition(() => f.cellIds()[2] === A);
    assert.deepEqual(f.stored(), layout([B, C, A]));
});

test("sizes are per chat: the panel grows with the chats, wraps evenly, and fits the window without moving frames", async (t) => {
    // 2026-10-12 user report: presets stretched each chat across a fixed panel. Presets now size one chat
    // (작게 280×480, 보통 340×600, 크게 420×760) and the panel is columns × chat + 4px gaps + 4px padding.
    // JSDOM's window is 1024×768, leaving 992×696 after the 16px margins and the 40px bar space.
    const presets = {
        small: { chatWidth: 280, chatHeight: 480 },
        medium: { chatWidth: 340, chatHeight: 600 },
        large: { chatWidth: 420, chatHeight: 760 },
    };
    const expected = {
        small: [
            [1, 1, 288, 488],
            [2, 1, 572, 488],
            [3, 1, 856, 488],
            [2, 2, 572, 696],
        ],
        medium: [
            [1, 1, 348, 608],
            [2, 1, 692, 608],
            [2, 2, 692, 696],
            [2, 2, 692, 696],
        ],
        large: [
            [1, 1, 428, 696],
            [2, 1, 852, 696],
            [2, 2, 852, 696],
            [2, 2, 852, 696],
        ],
    };
    const geometry = (f) => {
        const grid = f.panel().querySelector(".bccmv-grid");
        return [
            Number(grid.dataset.columns),
            Number(grid.dataset.rows),
            parseFloat(f.panel().style.width),
            parseFloat(f.panel().style.height),
        ];
    };
    for (let count = 1; count <= 4; count += 1) {
        const ids = [A, B, C, D].slice(0, count);
        const f = fixture(t, { stored: layout(ids) });
        await f.open();
        const grid = f.panel().querySelector(".bccmv-grid");
        const frames = ids.map((id) => f.frame(id));
        const pendingLoads = f.heldCount(FRAME_LOAD_DELAY);
        const moves = [];
        new f.w.MutationObserver((rows) => moves.push(...rows)).observe(grid, { childList: true });
        for (const [name, size] of Object.entries(presets)) {
            f.changeLocal(layout(ids, size));
            const [columns, rows, width, height] = expected[name][count - 1];
            assert.deepEqual(geometry(f), [columns, rows, width, height], `${count} chats in ${name}`);
            assert.equal(grid.style.getPropertyValue("--bccmv-columns"), String(columns));
            assert.equal(grid.style.getPropertyValue("--bccmv-rows"), String(rows));
            // Docked 16px from the bottom-right corner, never above the bar space.
            assert.equal(f.panel().style.left, 1024 - 16 - width + "px");
            assert.equal(f.panel().style.top, Math.max(56, 768 - 16 - height) + "px");
        }
        await settle();
        assert.deepEqual(
            ids.map((id) => f.frame(id)),
            frames,
            "layout changes keep each chat frame"
        );
        assert.equal(moves.length, 0, "layout changes never move or re-append frames");
        assert.equal(f.heldCount(FRAME_LOAD_DELAY), pendingLoads, "no frame was reloaded");
    }

    const f = fixture(t, { stored: layout([A, B, C, D]) });
    await f.open();
    const grid = f.panel().querySelector(".bccmv-grid");
    assert.deepEqual(
        [grid.style.getPropertyValue("--bccmv-cell-width"), grid.style.getPropertyValue("--bccmv-cell-height")],
        ["240px", "180px"]
    );
    // A wider window fits all four chats in one row; the chats keep their own width.
    Object.defineProperty(f.w, "innerWidth", { configurable: true, value: 1440 });
    f.w.dispatchEvent(new f.w.Event("resize"));
    assert.deepEqual(geometry(f), [4, 1, 1380, 608]);
    assert.equal(f.panel().style.left, 1440 - 16 - 1380 + "px");
    // The input needs 340×320 per chat (2026-10-09 measurement); a larger chat size raises that minimum.
    f.changeLocal(layout([A, B], { chatWidth: 280, chatHeight: 480, input: true }));
    assert.deepEqual(geometry(f), [2, 1, 692, 488]);
    assert.deepEqual(
        [grid.style.getPropertyValue("--bccmv-cell-width"), grid.style.getPropertyValue("--bccmv-cell-height")],
        ["340px", "320px"]
    );
    f.changeLocal(layout([A], { input: true, scale: 120 }));
    assert.deepEqual(geometry(f), [1, 1, 416, 608]);
    assert.equal(grid.style.getPropertyValue("--bccmv-cell-width"), "408px");
    assert.equal(grid.style.getPropertyValue("--bccmv-cell-height"), "384px");
    const css = f.w.document.getElementById(ENTRY_ID + "-style").textContent;
    const gridRule = css.match(/\.bccmv-grid\{[^}]*\}/)[0];
    assert.match(
        gridRule,
        /grid-template-columns:repeat\(var\(--bccmv-columns,1\),minmax\(var\(--bccmv-cell-width,240px\),1fr\)\)/
    );
    assert.match(
        gridRule,
        /grid-template-rows:repeat\(var\(--bccmv-rows,1\),minmax\(var\(--bccmv-cell-height,180px\),1fr\)\)/
    );
    assert.match(gridRule, /overflow:auto/);
    assert.doesNotMatch(css, /min-width:220px/, "the old squeezed single-row cells are gone");
});

test("when chats overflow the panel, a visible bar names every chat and moves between them without touching frames", async (t) => {
    // 2026-10-09 Codex Chrome: in 작게 only two chats showed and macOS hid the scrollbar, so the others looked absent.
    const f = await fixture(t, {
        stored: layout([A, B, C, D], {
            channels: [A, B, C, D].map((id, i) => ({ channelId: id, channelName: "채널" + (i + 1) })),
        }),
    });
    await f.open();
    const grid = f.panel().querySelector(".bccmv-grid");
    const nav = f.panel().querySelector(".bccmv-nav");
    assert.equal(nav.hidden, true, "no bar while everything fits");
    const frames = [A, B, C, D].map((id) => f.frame(id));
    const pendingLoads = f.heldCount(FRAME_LOAD_DELAY);
    const moves = [];
    new f.w.MutationObserver((rows) => moves.push(...rows)).observe(grid, { childList: true });
    // 작게: a 696×370 grid shows two 340px columns; four chats need 1,384px.
    let scrollLeft = 0;
    const area = { left: 100, top: 100, right: 796, bottom: 470, width: 696, height: 370 };
    Object.defineProperty(grid, "clientWidth", { configurable: true, get: () => 696 });
    Object.defineProperty(grid, "scrollWidth", { configurable: true, get: () => 1384 });
    Object.defineProperty(grid, "clientHeight", { configurable: true, get: () => 370 });
    Object.defineProperty(grid, "scrollHeight", { configurable: true, get: () => 370 });
    grid.getBoundingClientRect = () => ({ ...area });
    grid.scrollBy = ({ left = 0 }) => {
        scrollLeft = Math.max(0, Math.min(1384 - 696, scrollLeft + left));
        grid.dispatchEvent(new f.w.Event("scroll"));
    };
    [A, B, C, D].forEach((id, index) => {
        f.cell(id).getBoundingClientRect = () => {
            const left = area.left + index * 348 - scrollLeft;
            return { left, right: left + 340, top: area.top, bottom: area.bottom, width: 340, height: 370 };
        };
    });
    f.w.dispatchEvent(new f.w.Event("resize"));
    await waitForCondition(() => !nav.hidden);
    const chips = () => Array.from(nav.querySelectorAll(".bccmv-nav-chip"));
    const status = () => nav.querySelector(".bccmv-nav-status").textContent;
    const prev = nav.querySelector('[aria-label="이전 채팅 보기"]'),
        next = nav.querySelector('[aria-label="다음 채팅 보기"]');
    assert.equal(nav.getAttribute("role"), "group");
    assert.deepEqual(
        chips().map((chip) => chip.textContent),
        ["채널1", "채널2", "채널3", "채널4"]
    );
    assert.deepEqual(
        chips().map((chip) => chip.getAttribute("aria-current")),
        ["true", "true", null, null]
    );
    assert.equal(status(), "4개 중 1–2번째가 보여요");
    assert.equal(prev.disabled, true);
    assert.equal(next.disabled, false);
    assert.ok(chips().every((chip) => chip.type === "button"));
    next.click();
    await waitForCondition(() => status() === "4개 중 3–4번째가 보여요");
    assert.equal(scrollLeft, 688);
    assert.equal(prev.disabled, false);
    assert.equal(next.disabled, true);
    assert.equal(chips()[2].getAttribute("aria-label"), "채널3 채팅, 지금 보여요");
    chips()[0].click();
    await waitForCondition(() => status() === "4개 중 1–2번째가 보여요");
    assert.equal(scrollLeft, 0);
    assert.deepEqual(
        [A, B, C, D].map((id) => f.frame(id)),
        frames
    );
    assert.equal(moves.length, 0, "navigation never moves frames");
    assert.equal(f.heldCount(FRAME_LOAD_DELAY), pendingLoads, "navigation never reloads frames");
    Object.defineProperty(grid, "scrollWidth", { configurable: true, get: () => 696 });
    f.w.dispatchEvent(new f.w.Event("resize"));
    await waitForCondition(() => nav.hidden, { timeoutMs: 2000 });
    const css = f.w.document.getElementById(ENTRY_ID + "-style").textContent;
    assert.match(
        css,
        /\.bccmv-grid::-webkit-scrollbar\{width:10px;height:10px\}/,
        "Chrome keeps the scrollbar visible"
    );
});

test("the chat size presets, corner buttons, and resize handle save only from trusted input and stay on screen", async (t) => {
    const f = fixture(t, { stored: layout([A]) });
    await f.open();
    const panel = f.panel();
    const box = () => [panel.style.left, panel.style.top, panel.style.width, panel.style.height];
    assert.deepEqual(box(), ["660px", "144px", "348px", "608px"]);
    assert.equal(panel.dataset.corner, "bottom-right");
    assert.equal(f.sheetShown("settings"), false);
    f.openSettings();
    assert.equal(f.settingsToggle().getAttribute("aria-expanded"), "true");
    assert.equal(f.sizeButton("medium").getAttribute("aria-label"), "채팅 칸 크기 보통");
    assert.equal(f.sizeButton("medium").getAttribute("aria-pressed"), "true");
    assert.match(f.panel().querySelector(".bccmv-settings").textContent, /채널 이름 줄을 끌어/);
    f.sizeButton("large").click();
    await settle();
    assert.equal(f.storeMessages.length, 0);
    f.trusted(f.sizeButton("large"));
    await waitForCondition(() => f.sizeButton("large").getAttribute("aria-pressed") === "true");
    assert.deepEqual(f.stored(), layout([A], { chatWidth: 420, chatHeight: 760 }));
    assert.deepEqual(box(), ["580px", "56px", "428px", "696px"], "the window limits the height, not the width");
    f.trusted(f.sizeButton("medium"));
    await waitForCondition(() => f.stored()?.chatWidth === 340);
    f.trusted(f.cornerButton("bottom-left"));
    await waitForCondition(() => panel.dataset.corner === "bottom-left");
    assert.deepEqual(f.stored(), layout([A], { corner: "bottom-left" }));
    assert.deepEqual(box(), ["16px", "144px", "348px", "608px"]);
    assert.equal(f.cornerButton("bottom-left").getAttribute("aria-pressed"), "true");

    const handle = panel.querySelector(".bccmv-resize");
    f.trusted(handle, "pointerdown", { pointerType: "touch", clientX: 360, clientY: 150 });
    assert.equal(panel.hasAttribute("data-bccmv-resizing"), false, "touch and pen do not resize");
    // Docked bottom-left, the handle is on the top-right: dragging right and up grows the chat.
    f.trusted(handle, "pointerdown", { clientX: 360, clientY: 150 });
    assert.ok(panel.hasAttribute("data-bccmv-resizing"));
    f.trusted(handle, "pointermove", { clientX: 410, clientY: 110 });
    assert.deepEqual(box(), ["16px", "104px", "398px", "648px"], "the docked corner stays put");
    const before = f.storeMessages.length;
    f.trusted(handle, "pointerup", { clientX: 410, clientY: 110 });
    assert.equal(panel.hasAttribute("data-bccmv-resizing"), false);
    await waitForCondition(() => f.stored()?.chatWidth === 390);
    assert.equal(f.storeMessages.length, before + 1);
    assert.equal(f.stored().chatHeight, 640);
    assert.equal(f.message(), "채팅 칸 크기를 저장했어요.");
    assert.deepEqual(box(), ["16px", "104px", "398px", "648px"]);
    assert.equal(f.sizeButton("medium").getAttribute("aria-pressed"), "false");

    // Escape cancels a resize without saving.
    f.trusted(handle, "pointerdown", { clientX: 410, clientY: 110 });
    f.trusted(handle, "pointermove", { clientX: 600, clientY: 300 });
    f.trusted(panel, "keydown", { key: "Escape" });
    assert.equal(panel.hasAttribute("data-bccmv-resizing"), false);
    assert.deepEqual(box(), ["16px", "104px", "398px", "648px"]);
    await settle();
    assert.equal(f.storeMessages.length, before + 1);
    assert.ok(f.panel(), "Escape ends the drag before closing anything");
});

// 2026-10-17 report: at 70% with the input off the handle shrank a chat to 168×126 but the saved size snapped to
// 240×180, so the panel grew after release. Saved sizes are the on-screen CSS px of one chat, kept in the model's bounds.
test("a released resize keeps its size at every chat scale, input mode, and the model's bounds", async (t) => {
    const cases = [];
    for (const scale of [70, 100, 150])
        for (const input of [false, true]) for (const ids of [[A], [A, B]]) cases.push({ scale, input, ids });
    for (const { scale, input, ids } of cases) {
        const name = `${scale}% input ${input ? "on" : "off"} ${ids.length} chat(s)`;
        const f = fixture(t, { stored: layout(ids, { scale, input }) });
        // Wide enough for two of the largest minimum chats side by side, so only the handle limits the size.
        Object.defineProperty(f.w, "innerWidth", { configurable: true, value: 1600 });
        await f.open();
        const panel = f.panel();
        const size = () => [parseInt(panel.style.width, 10), parseInt(panel.style.height, 10)];
        const handle = panel.querySelector(".bccmv-resize");
        const grid = panel.querySelector(".bccmv-grid");
        const span = (count, cell) => count * cell + (count - 1) * 4 + 8;
        const base = input ? { width: 340, height: 320 } : { width: 240, height: 180 };
        const min = {
            width: Math.max(chatModel.MIN_CHAT_WIDTH, Math.ceil((base.width * scale) / 100)),
            height: Math.max(chatModel.MIN_CHAT_HEIGHT, Math.ceil((base.height * scale) / 100)),
        };
        // Docked bottom-right, the handle is on the top-left: dragging right and down shrinks every chat.
        f.trusted(handle, "pointerdown", { clientX: 400, clientY: 400 });
        f.trusted(handle, "pointermove", { clientX: 3000, clientY: 3000 });
        const dragged = size();
        assert.equal(grid.dataset.columns, String(ids.length), name);
        assert.deepEqual(
            dragged,
            [span(ids.length, min.width), span(1, min.height)],
            name + ": the handle stops at the smallest size that can be saved"
        );
        const before = f.storeMessages.length;
        f.trusted(handle, "pointerup", { clientX: 3000, clientY: 3000 });
        await waitForCondition(() => f.storeMessages.length === before + 1 && f.stored().chatWidth === min.width);
        await settle();
        assert.deepEqual(size(), dragged, name + ": the panel keeps the released size after saving");
        assert.equal(f.stored().chatHeight, min.height, name);
        assert.equal(f.stored().scale, scale, name);
    }

    // A large screen: the handle stops at the saved maximum instead of shrinking back after release.
    const f = fixture(t, { stored: layout([A]) });
    Object.defineProperty(f.w, "innerWidth", { configurable: true, value: 3840 });
    Object.defineProperty(f.w, "innerHeight", { configurable: true, value: 2600 });
    await f.open();
    const panel = f.panel();
    const size = () => [parseInt(panel.style.width, 10), parseInt(panel.style.height, 10)];
    const handle = panel.querySelector(".bccmv-resize");
    f.trusted(handle, "pointerdown", { clientX: 3000, clientY: 1900 });
    f.trusted(handle, "pointermove", { clientX: -3000, clientY: -3000 });
    const dragged = size();
    assert.equal(dragged[0], chatModel.MAX_CHAT_WIDTH + 8, "the width stops at the saved maximum");
    f.trusted(handle, "pointerup", { clientX: -3000, clientY: -3000 });
    await waitForCondition(() => f.stored()?.chatWidth === chatModel.MAX_CHAT_WIDTH);
    await settle();
    assert.deepEqual(size(), dragged);
    assert.equal(f.stored().chatHeight, dragged[1] - 8, "the window limits the height, and that height is saved");

    // A cancelled drag saves nothing and returns to the saved size.
    const saves = f.storeMessages.length;
    f.trusted(handle, "pointerdown", { clientX: 2000, clientY: 1900 });
    f.trusted(handle, "pointermove", { clientX: 2600, clientY: 2400 });
    assert.notDeepEqual(size(), dragged);
    f.trusted(handle, "pointercancel", { clientX: 2600, clientY: 2400 });
    assert.deepEqual(size(), dragged);
    await settle();
    assert.equal(f.storeMessages.length, saves);
});

test("dragging a chat's name bar moves the whole panel and docks it to the nearest screen corner", async (t) => {
    const f = fixture(t, { stored: layout([A, B]) });
    await f.open();
    const panel = f.panel();
    const head = f.cell(A).querySelector(".bccmv-cell-head");
    const box = () => [panel.style.left, panel.style.top];
    assert.deepEqual(box(), ["316px", "144px"]);
    assert.equal(head.title, "끌어서 패널 옮기기");

    // Buttons in the name bar keep working and never start a move; neither do synthetic or touch input.
    f.trusted(head, "pointerdown", { target: f.action(A, "remove"), clientX: 600, clientY: 150 });
    head.dispatchEvent(new f.w.Event("pointerdown", { bubbles: true }));
    f.trusted(head, "pointerdown", { pointerType: "touch", clientX: 600, clientY: 150 });
    assert.equal(panel.hasAttribute("data-bccmv-moving"), false);

    f.trusted(head, "pointerdown", { clientX: 600, clientY: 150 });
    assert.ok(panel.hasAttribute("data-bccmv-moving"), "chat frames stop taking the pointer while moving");
    f.trusted(head, "pointermove", { clientX: 300, clientY: 100 });
    assert.deepEqual(box(), ["16px", "94px"]);
    assert.equal(panel.dataset.corner, "bottom-left", "the panel's center decides the corner while moving");
    // The bar above the panel stays on screen.
    f.trusted(head, "pointermove", { clientX: 300, clientY: -500 });
    assert.deepEqual(box(), ["16px", "56px"]);
    assert.equal(panel.dataset.corner, "top-left");
    f.trusted(head, "pointerup", { clientX: 300, clientY: -500 });
    assert.equal(panel.hasAttribute("data-bccmv-moving"), false);
    await waitForCondition(() => f.stored()?.corner === "top-left");
    assert.deepEqual(f.stored(), layout([A, B], { corner: "top-left", x: 16, y: 56 }));
    assert.deepEqual(box(), ["16px", "56px"]);
    assert.equal(f.message(), "", "moving stays quiet");

    // A narrower window keeps the panel docked to its corner and inside the window.
    f.trusted(head, "pointerdown", { clientX: 100, clientY: 70 });
    f.trusted(head, "pointermove", { clientX: 600, clientY: 70 });
    f.trusted(head, "pointerup", { clientX: 600, clientY: 70 });
    await waitForCondition(() => f.stored()?.corner === "top-right");
    assert.deepEqual(f.stored(), layout([A, B], { corner: "top-right", x: 16, y: 56 }));
    Object.defineProperty(f.w, "innerWidth", { configurable: true, value: 900 });
    f.w.dispatchEvent(new f.w.Event("resize"));
    assert.deepEqual(box(), [900 - 16 - 692 + "px", "56px"]);
    assert.equal(f.storeMessages.length, 2, "window changes never save");
    // The corner buttons in the settings put it back.
    f.openSettings();
    assert.equal(f.cornerButton("bottom-right").getAttribute("aria-pressed"), "false");
    f.trusted(f.cornerButton("bottom-right"));
    await waitForCondition(() => f.stored()?.corner === "bottom-right");
    assert.deepEqual(f.stored(), layout([A, B]));
});

test("a failed save keeps this document's layout; a conflict shows the other tab's layout without overwriting it", async (t) => {
    const f = fixture(t, { stored: layout([A, B]) });
    await f.open();
    f.setStoreMode("fail");
    f.trusted(f.action(A, "remove"));
    await waitForCondition(() => /저장하지 못했어요/.test(f.message()));
    assert.equal(f.message(), "구성을 저장하지 못했어요. 이 탭에서만 바뀐 구성으로 표시해요.");
    assert.equal(f.cell(A), null, "the current document keeps the user's change");
    assert.deepEqual(f.stored(), layout([A, B]));

    f.setStoreMode("emulate");
    // Another tab saved first and its change notification has not reached this document yet.
    f.chrome.testState.local[KEY] = layout([C]);
    f.openSettings();
    f.trusted(f.sizeButton("small"));
    await waitForCondition(() => f.message().startsWith("다른 탭에서"));
    const conflicting = f.storeMessages.at(-1);
    assert.deepEqual(conflicting.expected, { [KEY]: { value: layout([A, B]) } });
    assert.deepEqual(conflicting.values[KEY], layout([B], { chatWidth: 280, chatHeight: 480 }));
    assert.deepEqual(f.stored(), layout([C]), "the other tab's layout is not overwritten");
    await waitForCondition(() => f.cell(C));
    assert.deepEqual(f.cellIds(), [C]);
    assert.equal(f.sizeButton("medium").getAttribute("aria-pressed"), "true");
});

test("another tab's saved layout updates open chats without reloading kept frames and replaces an unsaved change", async (t) => {
    const f = fixture(t, { stored: layout([A, B]) });
    await f.open();
    const frameB = f.frame(B);
    f.changeLocal(layout([B, C]));
    assert.deepEqual(f.cellIds(), [B, C]);
    assert.equal(f.frame(B), frameB);
    assert.equal(f.cell(A), null);

    f.setStoreMode("fail");
    f.trusted(f.action(C, "remove"));
    await waitForCondition(() => f.cell(C) === null);
    f.changeLocal(layout([B, C, D]));
    assert.deepEqual(f.cellIds(), [B, C, D]);
    assert.equal(f.message(), "다른 탭에서 저장한 구성을 반영했어요. 이 탭에서 저장하지 못한 변경은 사라졌어요.");
    assert.equal(f.frame(B), frameB);
    assert.equal(f.storeMessages.length, 1);
});

test("waits for the saved layout and lets a change that arrived during the first read win over the late result", async (t) => {
    const f = fixture(t, { stored: layout([A]), holdReads: true });
    await waitForCondition(() => f.entry());
    f.trusted(f.entry());
    assert.ok(f.panel());
    assert.match(f.panel().textContent, /구성을 불러오는 중이에요/);
    assert.equal(f.w.document.querySelector("iframe"), null);
    assert.equal(f.submit().disabled, true);
    assert.equal(f.sizeButton("large").disabled, true);
    f.typeText(B);
    f.enter();
    assert.equal(f.requests.length, 0);

    f.changeLocal(layout([C]));
    assert.deepEqual(f.cellIds(), [C]);
    f.releaseReads();
    await settle();
    assert.deepEqual(f.cellIds(), [C], "the older read result does not replace the newer change");
    assert.equal(f.storeMessages.length, 0, "reading never writes");
});

test("an invalid saved layout reads as the default layout and reading never rewrites it", async (t) => {
    const invalid = { ...layout([A]), extra: true };
    const f = fixture(t, { stored: invalid });
    await f.open();
    assert.equal(f.w.document.querySelector("iframe"), null);
    assert.equal(f.panel().querySelector(".bccmv-count").textContent, "0/4");
    assert.match(f.panel().textContent, /채널을 추가하면/);
    await settle();
    assert.deepEqual(f.stored(), invalid);
    assert.equal(f.storeMessages.length, 0);
});

test("option OFF and pagehide remove frames and requests, and neither ON nor pageshow reopens chats", async (t) => {
    const f = fixture(t, { stored: layout([A]) });
    await f.open();
    f.openAdd();
    const lookup = deferred();
    f.setFetch(() => lookup.promise);
    f.typeText(B);
    f.enter();
    assert.equal(f.requests.length, 1);

    f.changeSync({ chatMultiviewEnabled: false });
    assert.equal(f.panel(), null);
    assert.equal(f.entry(), null);
    assert.equal(f.w.document.querySelector("iframe"), null);
    assert.equal(f.requests[0].signal.aborted, true);
    assert.equal(f.held.size, 0, "frame timers are cleared");
    lookup.resolve({ code: 200, content: { channelId: B, channelName: nameOf(B) } });
    await settle();
    assert.equal(f.storeMessages.length, 0, "a late lookup cannot add a chat after OFF");

    f.changeSync({ chatMultiviewEnabled: true });
    await waitForCondition(() => f.entry());
    assert.equal(f.panel(), null, "turning the option back on does not reopen chats");
    await f.open();
    assert.ok(f.frame(A));

    f.w.dispatchEvent(new f.w.Event("pagehide"));
    assert.equal(f.panel(), null);
    assert.equal(f.entry(), null);
    assert.equal(f.w.document.getElementById(ENTRY_ID + "-style"), null);
    assert.equal(f.held.size, 0);
    f.w.dispatchEvent(new f.w.Event("pageshow"));
    await waitForCondition(() => f.entry());
    assert.equal(f.panel(), null, "a restored page does not reopen chats");
    assert.equal(f.w.document.querySelector("iframe"), null);
});

test("SPA navigation keeps open chats and reconnects one header button after the live alert button", async (t) => {
    const f = fixture(t, { stored: layout([A]) });
    await f.open();
    const frame = f.frame(A);
    const holder = f.w.document.createElement("div");
    holder.innerHTML = headerHtml(
        '<span id="cheese-spanner-live-start-registration"><button type="button">방송 알림</button></span>'
    );
    const nextHeader = holder.firstElementChild;
    f.w.document.getElementById("header").replaceWith(nextHeader);
    f.navigate("/" + B);
    await waitForCondition(() => nextHeader.contains(f.entry()));
    assert.equal(f.w.document.querySelectorAll("#" + ENTRY_ID).length, 1);
    assert.equal(f.w.document.getElementById("cheese-spanner-live-start-registration").nextElementSibling.id, ENTRY_ID);
    assert.equal(f.entry().getAttribute("aria-expanded"), "true");
    assert.ok(f.panel());
    assert.equal(f.frame(A), frame);
    assert.ok(frame.isConnected);
});

test("Escape closes search results first, then the panel, and returns focus to the header button", async (t) => {
    const f = fixture(t);
    await f.open();
    f.setFetch(async () => searchResponse([B]));
    f.typeText("치즈");
    f.enter();
    await waitForCondition(() => f.result(B));
    const results = f.panel().querySelector(".bccmv-results");
    f.trusted(f.panel(), "keydown", { key: "Escape", target: f.input(), isComposing: true });
    assert.equal(results.hidden, false, "IME composition keeps the results");
    f.trusted(f.panel(), "keydown", { key: "Escape", target: f.input() });
    assert.equal(results.hidden, true);
    assert.ok(f.panel());
    f.trusted(f.panel(), "keydown", { key: "Escape", target: f.input() });
    assert.equal(f.panel(), null);
    assert.equal(f.w.document.activeElement, f.entry());
});

test("cells show only the channel name and chat; the bar, cell actions, and resize handle appear on hover or keyboard focus", async (t) => {
    const f = fixture(t, { stored: layout([A, B]) });
    await f.open();
    const head = f.cell(A).querySelector(".bccmv-cell-head");
    const visible = [...head.children].filter(
        (node) => !node.hidden && !node.classList.contains("bccmv-visually-hidden")
    );
    assert.deepEqual(
        visible.map((node) => node.className),
        ["bccmv-cell-name", "bccmv-cell-actions"],
        "the head holds the name and the hover actions only"
    );
    assert.deepEqual(
        [...f.cell(A).querySelectorAll(".bccmv-cell-actions button")].map((node) => node.dataset.action),
        ["retry", "back", "forward", "remove"]
    );
    assert.equal(f.panel().querySelector(".bccmv-top"), null, "no permanent header row");
    assert.equal(f.bar().getAttribute("role"), "toolbar");
    assert.deepEqual(
        [...f.bar().querySelectorAll(":scope > button, :scope > .bccmv-scale button")].map((node) =>
            node.getAttribute("aria-label")
        ),
        ["채팅 크기 줄이기", "채팅 크기 키우기", "채널 추가", "채팅 멀티뷰 설정", "채팅 멀티뷰 닫기"]
    );
    const css = f.w.document.getElementById(ENTRY_ID + "-style").textContent;
    const rule = (selector) => {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return css.match(new RegExp("(?:^|\\n)" + escaped + "\\{([^}]*)\\}"))?.[1] || "";
    };
    const P = "#" + PANEL_ID;
    assert.match(rule(P + " .bccmv-bar"), /opacity:0;pointer-events:none/, "hidden bar never blocks the page");
    assert.match(rule(P + " .bccmv-bar"), /bottom:calc\(100% \+ 6px\)/, "the bar sits above the chats");
    assert.match(
        css,
        new RegExp(
            P + ":hover \\.bccmv-bar," + P + " \\.bccmv-bar:focus-within,[^{]*\\{opacity:1;pointer-events:auto\\}"
        )
    );
    assert.match(rule(P + " .bccmv-cell-actions"), /opacity:0/);
    assert.match(
        css,
        new RegExp(
            P + " \\.bccmv-cell:hover \\.bccmv-cell-actions," + P + " \\.bccmv-cell-actions:focus-within\\{opacity:1\\}"
        )
    );
    assert.match(rule(P + " .bccmv-resize"), /opacity:0/);
    assert.match(css, new RegExp(P + ":hover \\.bccmv-resize,[^{]*\\{opacity:1\\}"));
    assert.match(rule(P), /padding:4px/);
    assert.match(rule(P), /gap:4px/);
    assert.match(rule(P + " .bccmv-cell-head"), /height:26px/);
    assert.match(
        css,
        /@media \(hover:none\)\{[^@]*\.bccmv-bar\{opacity:1;pointer-events:auto\}/,
        "touch keeps controls"
    );
});

test("verified chat frames get one extension style that hides the native header, banner, ranking, and donation button", async (t) => {
    const f = fixture(t, { stored: layout([A, B]) });
    await f.open();
    const nativeChat = (native) => {
        // 2026-10-12 public bundle: the popup chat aside and its direct boxes.
        const aside = native.doc.createElement("aside");
        aside.id = "aside-chatting";
        aside.className = "_container_b8csn_2 _is_popup_chat_b8csn_13";
        aside.innerHTML =
            '<div class="_container_1e2su_2" id="native-header"><h2 class="_title_1e2su_12">채팅</h2>' +
            '<div class="_wrapper_1e2su_28 _scale_1e2su_39"><button type="button">-</button><span>100%</span></div></div>' +
            '<div class="_banner_b8csn_41" id="native-banner"></div>' +
            '<div id="native-ranking"><button class="_ranking_button_wl8bq_141">주간 후원 랭킹</button></div>' +
            '<div id="native-power"><div class="_header_wl8bq_13 _show_power_wl8bq_25"></div></div>' +
            '<div role="log" id="native-log"><div class="_item_1"><div><h2 id="message-heading">공지</h2></div></div></div>' +
            '<div class="_area_b8csn_49" id="native-area"><div class="_container_19u4u_2" id="native-input"></div>' +
            '<div class="_tools_19u4u_125"><div class="_donation_19u4u_132" id="native-donation">' +
            '<button class="_donation_text_19u4u_137">후원</button></div>' +
            '<button class="_send_button_19u4u_176" id="native-send">채팅</button></div></div>';
        // The popup page box is `min-width:353px` (2026-10-12 public CSS), wider than a 340px or 280px chat.
        const page = native.doc.createElement("div");
        page.id = "native-page";
        page.className = "_container_1gtzb_1";
        page.append(aside);
        native.doc.body.append(page);
    };
    const frameStyle = (doc) => {
        const style = doc.getElementById("cheese-spanner-chat-multiview-frame-style");
        assert.ok(style, "frame style");
        return style.textContent;
    };
    const hiddenIds = (doc) => {
        const selector = frameStyle(doc).match(/([^}]*)\{display:none!important\}$/)?.[1];
        assert.ok(selector, "hidden rule");
        return [...doc.querySelectorAll(selector)].map((node) => node.id).sort();
    };
    const a = f.attachFrame(A, { chat: false });
    nativeChat(a);
    assert.equal(
        a.doc.getElementById("cheese-spanner-chat-multiview-frame-style"),
        null,
        "nothing before verification"
    );
    a.load();
    assert.equal(f.cell(A).dataset.state, "ready");
    assert.equal(a.doc.querySelectorAll("#cheese-spanner-chat-multiview-frame-style").length, 1);
    // No sideways scroll under narrow chats: only the chat box's page wrapper loses its minimum width.
    const fit = frameStyle(a.doc).match(/^([^{]*)\{min-width:0!important\}/)?.[1];
    assert.deepEqual(
        [...a.doc.querySelectorAll(fit)].map((node) => node.id),
        ["native-page"]
    );
    assert.match(frameStyle(a.doc), /html,body\{overflow-x:hidden!important\}/);
    assert.deepEqual(hiddenIds(a.doc), [
        "native-area",
        "native-banner",
        "native-donation",
        "native-header",
        "native-power",
        "native-ranking",
    ]);
    f.changeLocal(layout([A, B]));
    assert.equal(a.doc.querySelectorAll("#cheese-spanner-chat-multiview-frame-style").length, 1, "never duplicated");

    // Turning the input on in the multiview settings shows each verified chat's input but keeps donation hidden.
    f.openSettings();
    assert.equal(f.inputSwitch().getAttribute("aria-checked"), "false");
    f.trusted(f.inputSwitch());
    await waitForCondition(() => f.stored()?.input === true);
    await waitForCondition(() => !hiddenIds(a.doc).includes("native-area"));
    assert.deepEqual(hiddenIds(a.doc), [
        "native-banner",
        "native-donation",
        "native-header",
        "native-power",
        "native-ranking",
    ]);

    // A frame that leaves its own chat path is never styled.
    const b = f.attachFrame(B, { path: "/" + B });
    b.load();
    assert.equal(f.cell(B).dataset.state, "left");
    assert.equal(b.doc.getElementById("cheese-spanner-chat-multiview-frame-style"), null);
    assert.equal(f.requests.length, 0);
});

test("the chat size steps from the hover bar, scales frames from outside, and is saved without reloading chats", async (t) => {
    const f = fixture(t, { stored: layout([A]) });
    await f.open();
    const panel = f.panel();
    const frame = f.frame(A);
    const pendingLoads = f.heldCount(FRAME_LOAD_DELAY);
    assert.equal(f.scaleText(), "100%");
    assert.equal(panel.hasAttribute("data-bccmv-scaled"), false);
    f.scaleButton(1).click();
    await settle();
    assert.equal(f.storeMessages.length, 0, "a synthetic click does not save");
    f.trusted(f.scaleButton(1));
    await waitForCondition(() => f.scaleText() === "110%");
    assert.deepEqual(f.stored(), layout([A], { scale: 110 }));
    assert.equal(panel.style.getPropertyValue("--bccmv-scale"), "1.1");
    assert.ok(panel.hasAttribute("data-bccmv-scaled"));
    assert.equal(f.message(), "", "size steps stay quiet");
    for (let step = 0; step < 4; step += 1) {
        f.trusted(f.scaleButton(-1));
        await waitForCondition(() => f.storeMessages.length === step + 2);
    }
    await waitForCondition(() => f.scaleText() === "70%");
    assert.equal(f.scaleButton(-1).disabled, true);
    assert.equal(f.stored().scale, 70);
    assert.equal(f.frame(A), frame);
    assert.equal(f.heldCount(FRAME_LOAD_DELAY), pendingLoads, "scaling never reloads a chat");
    const css = f.w.document.getElementById(ENTRY_ID + "-style").textContent;
    assert.match(
        css,
        /\[data-bccmv-scaled\] \.bccmv-frame\{width:calc\(100% \/ var\(--bccmv-scale\)\);height:calc\(100% \/ var\(--bccmv-scale\)\);transform:scale\(var\(--bccmv-scale\)\);transform-origin:0 0\}/
    );
    f.changeLocal(layout([A], { scale: 150 }));
    assert.equal(f.scaleText(), "150%");
    assert.equal(f.scaleButton(1).disabled, true);
});

test("the chat input is a multiview setting: off by default, saved from a trusted switch, and widens cells", async (t) => {
    const f = fixture(t, { stored: layout([A]) });
    await f.open();
    const grid = f.panel().querySelector(".bccmv-grid");
    assert.equal(grid.style.getPropertyValue("--bccmv-cell-width"), "240px");
    f.openSettings();
    assert.equal(f.inputSwitch().getAttribute("aria-checked"), "false");
    assert.match(f.panel().querySelector(".bccmv-settings").textContent, /후원 버튼은 계속 숨겨요/);
    f.inputSwitch().click();
    await settle();
    assert.equal(f.storeMessages.length, 0);
    f.trusted(f.inputSwitch());
    await waitForCondition(() => f.inputSwitch().getAttribute("aria-checked") === "true");
    assert.deepEqual(f.storeMessages[0].expected, { [KEY]: { value: layout([A]) } });
    assert.deepEqual(f.stored(), layout([A], { input: true }));
    assert.equal(f.message(), "칸에서 채팅을 입력할 수 있어요.");
    assert.equal(grid.style.getPropertyValue("--bccmv-cell-width"), "340px");
    f.trusted(f.inputSwitch());
    await waitForCondition(() => f.stored()?.input === false);
    assert.equal(f.message(), "채팅 입력창을 숨겼어요.");
});

test("a layout saved in the earlier panel-sized format keeps its chats and writes the per-chat format on the next save", async (t) => {
    const legacy = legacyLayout([A, B], { width: 1280, corner: "bottom-left", scale: 120 });
    const f = fixture(t, { stored: legacy });
    await f.open();
    assert.deepEqual(f.cellIds(), [A, B]);
    assert.equal(f.scaleText(), "120%");
    assert.equal(f.panel().dataset.corner, "bottom-left");
    assert.equal(f.panel().style.width, "692px", "two default-sized chats, not the old 1280px panel");
    await settle();
    assert.deepEqual(f.stored(), legacy, "reading never rewrites");
    f.trusted(f.action(B, "remove"));
    await waitForCondition(() => f.storeMessages.length === 1);
    assert.deepEqual(f.storeMessages[0].expected, { [KEY]: { value: legacy } });
    assert.deepEqual(f.storeMessages[0].values[KEY], layout([A], { corner: "bottom-left", scale: 120 }));
});

test("the add and settings sheets toggle from the bar, and Escape closes an open sheet before the panel", async (t) => {
    const f = fixture(t, { stored: layout([A]) });
    await f.open();
    f.openAdd();
    assert.equal(f.addToggle().getAttribute("aria-expanded"), "true");
    assert.equal(f.panel().getAttribute("data-bccmv-sheet"), "add");
    assert.equal(f.w.document.activeElement, f.input());
    f.openSettings();
    assert.equal(f.sheetShown("add"), false, "one sheet at a time");
    assert.equal(f.addToggle().getAttribute("aria-expanded"), "false");
    f.settingsToggle().click();
    assert.equal(f.panel().hasAttribute("data-bccmv-sheet"), false);
    f.openAdd();
    f.trusted(f.panel(), "keydown", { key: "Escape", target: f.input() });
    assert.equal(f.sheetShown("add"), false);
    assert.ok(f.panel());
    assert.equal(f.w.document.activeElement, f.addToggle());
    f.trusted(f.panel(), "keydown", { key: "Escape", target: f.addToggle() });
    assert.equal(f.panel(), null);
});

test("leaving the add sheet an empty panel shows by itself cancels its pending lookup", async (t) => {
    const f = fixture(t);
    await f.open();
    assert.ok(f.sheetShown("add"), "an empty panel shows the add sheet without a chosen sheet");
    const lookup = deferred();
    f.setFetch(() => lookup.promise);
    f.typeText("https://chzzk.naver.com/live/" + A);
    f.enter();
    assert.equal(f.requests.length, 1);

    f.openSettings();
    assert.equal(f.requests[0].signal.aborted, true, "switching to settings cancels the lookup");
    lookup.resolve({ code: 200, content: { channelId: A, channelName: nameOf(A) } });
    await settle();
    assert.equal(f.storeMessages.length, 0, "a late lookup neither adds nor saves a chat");
    assert.equal(f.cell(A), null);

    // Closing settings shows the empty panel's add sheet again, and a new lookup still adds.
    f.settingsToggle().click();
    assert.ok(f.sheetShown("add"));
    f.setFetch(async () => ({ code: 200, content: { channelId: B, channelName: nameOf(B) } }));
    f.typeText(B);
    f.enter();
    await waitForCondition(() => f.cell(B));
    assert.equal(f.storeMessages.length, 1);
});

// ── 프레임 범위와 정적 경계 ──────────────────────────────────────────────────

test("never runs inside a child frame, so a chat frame cannot open nested chats or read the layout", async (t) => {
    const chrome = createFakeChrome({ sync: { chatMultiviewEnabled: true }, local: { [KEY]: layout([A]) } });
    const reads = [];
    const localGet = chrome.storage.local.get;
    chrome.storage.local.get = (keys, callback) => {
        reads.push(keys);
        localGet(keys, callback);
    };
    const dom = new JSDOM('<iframe id="chat"></iframe>', {
        url: "https://chzzk.naver.com/live/" + MAIN_CHANNEL,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    const child = dom.window.document.getElementById("chat").contentWindow;
    child.document.body.innerHTML = headerHtml();
    child.chrome = chrome;
    // The weekly ranking switch is its own feature; this checks only the chat multiview's top-frame guard.
    for (const file of SCRIPTS.filter((name) => name !== "features/chatWeeklyRanking.js")) child.eval(read(file));
    // Any option callback and animation frame would have run by now.
    await settle(60);
    assert.notEqual(child.top, child);
    assert.equal(child.document.getElementById(ENTRY_ID), null);
    assert.equal(child.document.getElementById(ENTRY_ID + "-style"), null);
    assert.deepEqual(reads, []);
    assert.equal(chrome.testState.storageChangeListeners.length, 0);
    assert.equal(chrome.testState.runtimeMessages.length, 0);
});

test("content scripts and the dynamic ad script stay in the top frame, so chat frames run no history, reward, or playback code", () => {
    const manifest = JSON.parse(read("manifest.json"));
    for (const entry of manifest.content_scripts) {
        assert.notEqual(entry.all_frames, true, entry.js[0]);
        assert.notEqual(entry.match_about_blank, true, entry.js[0]);
        assert.notEqual(entry.match_origin_as_fallback, true, entry.js[0]);
    }
    require("../shared/adVideoRegistration.js");
    const adScript = globalThis.CheeseSpannerAdVideoRegistration.CONTENT_SCRIPT;
    assert.equal(adScript.allFrames, false);
    assert.notEqual(adScript.matchOriginAsFallback, true);
    const injected = new Set([...manifest.content_scripts.flatMap((entry) => entry.js), ...adScript.js]);
    for (const file of [
        "features/liveWatchHistory.js",
        "features/watchActivity.js",
        "features/watchActivityPage.js",
        "features/rewardAutoCollect.js",
        "features/autoQuality.js",
        "features/autoQualityPage.js",
        "features/skipControl.js",
        "features/offlineLiveReload.js",
    ])
        assert.ok(injected.has(file), file + " is injected only through the checked top-frame entries");
    const runtimeFiles = [
        "background.js",
        "options.js",
        "optionsLiveStart.js",
        ...collectJsFiles("shared"),
        ...collectJsFiles("features"),
    ];
    for (const file of runtimeFiles) {
        const source = read(file);
        assert.doesNotMatch(
            source,
            /allFrames\s*:\s*true|all_frames|matchOriginAsFallback\s*:\s*true|match_about_blank/,
            file
        );
        for (const call of source.matchAll(/executeScript\s*\(\s*\{[\s\S]{0,200}?target\s*:\s*\{([^}]*)\}/g))
            assert.match(call[1], /frameIds\s*:\s*\[\s*0\s*\]/, file + " scripts only the top frame");
    }
});

test("chat multiview source keeps the frame address, storage, and input boundaries", () => {
    const source = read("features/chatMultiview.js");
    for (const [label, pattern] of [
        ["new window or tab", /window\.open|chrome\.(?:tabs|windows)\b|target\s*=\s*["']_blank/],
        ["arbitrary HTML", /innerHTML|outerHTML|insertAdjacentHTML|document\.write/],
        ["inline frame document", new RegExp("src" + "doc", "i")],
        ["own chat connection", /WebSocket|EventSource|sendBeacon|postMessage/],
        ["direct storage write", /chrome\.storage\.(?:local|sync)\.(?:set|remove)|storage(?:Set|Remove)\b/],
        ["extension message", /runtime\.sendMessage/],
        ["synthetic input", /\.click\(\)|dispatchEvent|requestSubmit|\.submit\(/],
        ["native chat input access", /textarea|contenteditable|execCommand/i],
    ])
        assert.doesNotMatch(source, pattern, label);
    assert.equal(source.match(/createElement\("iframe"\)/g)?.length, 1);
    assert.deepEqual((source.match(/[\w.]+\.src\s*=\s*[^;]+;/g) || []).sort(), [
        "cell.frame.src = url;",
        "image.src = channel.imageUrl;",
    ]);
    assert.match(source, /const url = model\.frameUrl\(cell\.channelId\);/);
    assert.equal((source.match(/store\("local", \{ \[KEY\]: next \}, expected\)/g) || []).length, 1);
    assert.doesNotMatch(read("shared/chatMultiview.js"), /\b(?:window|document|chrome)\b\s*[.?[]/);
});

// ── 통합 계약(통합 소유자가 연결한 뒤 통과) ──────────────────────────────────

test("integration: manifest loads the pure model before the isolated top-frame feature and options expose the switch", () => {
    const manifest = JSON.parse(read("manifest.json"));
    const entries = manifest.content_scripts.filter((entry) => entry.js.includes("features/chatMultiview.js"));
    assert.equal(entries.length, 1, "features/chatMultiview.js is injected by exactly one content script entry");
    const [entry] = entries;
    assert.equal(entry.world, undefined, "isolated world");
    assert.notEqual(entry.all_frames, true);
    const files = entry.js;
    const featureIndex = files.indexOf("features/chatMultiview.js");
    for (const dependency of [
        "shared/settings.js",
        "shared/data.js",
        "content.js",
        THEME_SCRIPT,
        "shared/chatMultiview.js",
        "features/chatWeeklyRanking.js",
    ]) {
        const index = files.indexOf(dependency);
        assert.ok(index >= 0 && index < featureIndex, dependency + " loads before the feature");
    }
    assert.match(read("options.html"), /data-option="chatMultiviewEnabled"/);
});

// shared/uiTheme.js owns the only light/dark fallback table and the single "CheeseSpanner Pretendard" @font-face for
// in-page UI (shared/AGENTS.md, features/AGENTS.md). The panel keeps only theme-independent colors: the live dot, the warning mark with its
// white glyph, and the white toggle knob with its shadow.
const CHAT_FIXED_COLORS = ["#ff4545", "#f08c00", "#fff", "#0000004d"];
const chatCssColors = (css) => [...css.matchAll(/#[0-9a-f]{3,8}(?![\w-])|rgba?\([^)]*\)/gi)].map(([color]) => color);

test("chat multiview uses the shared theme font instead of declaring its own @font-face", async (t) => {
    const source = read("features/chatMultiview.js");
    assert.doesNotMatch(source, /@font-face|PretendardVariable\.woff2|runtime\??\.getURL/);
    const f = fixture(t, { enabled: false, stored: layout([A]), withTheme: true });
    await waitForCondition(() => f.w.document.getElementById(ENTRY_ID + "-style"));
    assert.equal(f.w.document.getElementById("cheese-spanner-ui-theme"), null, "no theme while the option is off");
    f.changeSync({ chatMultiviewEnabled: true });
    await f.open();
    const d = f.w.document;
    assert.equal(d.querySelectorAll("#cheese-spanner-ui-theme").length, 1);
    const fontFaces = [...d.querySelectorAll("style")].flatMap((style) =>
        [...style.textContent.matchAll(/@font-face\{[^}]*\}/g)].map(([rule]) => rule)
    );
    assert.equal(fontFaces.length, 1, "one shared @font-face in the document");
    assert.match(
        fontFaces[0],
        /font-family:"CheeseSpanner Pretendard";src:url\("chrome-extension:\/\/cheese-spanner\//
    );
    assert.match(d.getElementById("cheese-spanner-ui-theme").textContent, /@font-face/);
    const css = d.getElementById(ENTRY_ID + "-style").textContent;
    assert.match(css, new RegExp("\\n#" + ENTRY_ID + "\\{[^}]*font:14px/1\\.4 var\\(--bct-font\\)"));
    assert.match(css, new RegExp("\\n#" + PANEL_ID + "\\{[^}]*font:13px/1\\.5 var\\(--bct-font\\)"));
    assert.doesNotMatch(css, /CheeseSpanner Pretendard|system-ui|Segoe UI/, "the font stack lives in the theme only");

    // The chat frames get only the hide style: no theme variables or fonts are needed inside them.
    const a = f.attachFrame(A);
    a.load();
    assert.equal(f.cell(A).dataset.state, "ready");
    const frameStyle = a.doc.getElementById("cheese-spanner-chat-multiview-frame-style");
    assert.ok(frameStyle);
    assert.equal(a.doc.querySelectorAll("style").length, 1);
    assert.equal(a.doc.getElementById("cheese-spanner-ui-theme"), null);
    assert.doesNotMatch(frameStyle.textContent, /var\(|@font-face|font-family/);
});

test("chat multiview colors, radii, shadow and states come from the shared theme without a fallback palette", async (t) => {
    const f = fixture(t, { stored: layout([A]), withTheme: true });
    await f.open();
    const d = f.w.document;
    const css = d.getElementById(ENTRY_ID + "-style").textContent;
    const defined = new Set(
        [...d.getElementById("cheese-spanner-ui-theme").textContent.matchAll(/(--bct-[a-z-]+):/g)].map(
            ([, name]) => name
        )
    );
    const used = [...css.matchAll(/var\((--bct-[a-z-]+)(\)|,)/g)];
    assert.ok(used.length > 15);
    for (const [, name, end] of used) {
        assert.ok(defined.has(name), name + " is defined by shared/uiTheme.js");
        assert.equal(end, ")", name + " is used without a feature fallback");
    }
    assert.doesNotMatch(css, /var\(--sem-|var\(--(?:Surface|Content|Border)-/);
    assert.doesNotMatch(css, /theme_dark|data-theme/);
    for (const color of chatCssColors(css))
        assert.ok(CHAT_FIXED_COLORS.includes(color.toLowerCase()), color + " is not a theme color");
    const variables = css.match(new RegExp("\\n#" + ENTRY_ID + ",#" + PANEL_ID + "\\{([^}]*)\\}"))?.[1] || "";
    for (const pair of [
        "--bccmv-surface:var(--bct-surface)",
        "--bccmv-weak:var(--bct-surface-weak)",
        "--bccmv-base:var(--bct-surface-base)",
        "--bccmv-bg:var(--bct-bg)",
        "--bccmv-text:var(--bct-text)",
        "--bccmv-strong:var(--bct-text-body)",
        "--bccmv-muted:var(--bct-text-muted)",
        "--bccmv-faint:var(--bct-text-dim)",
        "--bccmv-brand:var(--bct-brand-text)",
        "--bccmv-brand-fill:var(--bct-brand)",
        "--bccmv-brand-soft:var(--bct-brand-weak)",
        "--bccmv-on-brand:var(--bct-on-brand)",
        "--bccmv-line:var(--bct-border-alpha-weaker)",
        "--bccmv-line-strong:var(--bct-border-alpha)",
        "--bccmv-hover:var(--bct-hover)",
        "--bccmv-shadow:var(--bct-shadow)",
        "--bccmv-border:var(--bct-border-strong)",
    ])
        assert.ok(variables.includes(pair), pair);
    const P = "#" + PANEL_ID;
    const rule = (selector) => {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return css.match(new RegExp("(?:^|\\n)" + escaped + "\\{([^}]*)\\}"))?.[1] || "";
    };
    assert.match(rule(P), /border-radius:var\(--bct-radius-lg\)/);
    assert.match(rule(P + " button"), /border-radius:var\(--bct-radius-md\)/);
    assert.match(rule(P + " :is(button,input):focus-visible"), /outline:2px solid var\(--bct-focus-ring\)/);
    assert.match(rule("#" + ENTRY_ID + ">button:focus-visible"), /outline:2px solid var\(--bct-focus-ring\)/);
    assert.match(rule(P + " button:hover:not(:disabled)"), /background:var\(--bccmv-hover\)/);
    // Small text never uses the dim text color (3.7:1 in dark) or small brand text on a tinted surface (light).
    for (const selector of [
        P + " .bccmv-result-detail",
        P + " .bccmv-results-hint",
        P + " .bccmv-setting-help",
        P + " .bccmv-empty-hint",
    ])
        assert.match(rule(selector), /color:var\(--bccmv-muted\)/, selector);
    // Selected and current states use the brand tint with primary text, which keeps 4.5:1 in both themes.
    for (const selector of [
        P + " .bccmv-result-state",
        P + ' .bccmv-bar button[aria-expanded="true"]',
        P + ' .bccmv-group button[aria-pressed="true"]',
        P + ' .bccmv-nav-chip[aria-current="true"]',
    ])
        assert.match(rule(selector), /background:var\(--bccmv-brand-soft\);color:var\(--bccmv-text\)/, selector);
    assert.match(
        rule("#" + ENTRY_ID + '>button[aria-expanded="true"]'),
        /background:var\(--bccmv-brand-soft\);border-color:var\(--bct-brand-text-base\)/
    );
    for (const [, value] of css.matchAll(/border-radius:([^;}]*)/g))
        assert.match(
            value,
            /^(?:var\(--bct-radius-(?:sm|md|lg|full)\)|50%|0 3px 0 0|0 0 0 3px|0 0 3px 0)$/,
            "radius " + value
        );
    for (const [, value] of css.matchAll(/box-shadow:([^;}]*)/g))
        assert.match(
            value,
            /^(?:var\(--bccmv-shadow\),0 0 0 1px var\(--bccmv-line\)|none|0 1px 2px #0000004d)$/,
            value
        );
    // User decision 2026-10-12: 4px padding and gaps, controls only on hover or focus.
    assert.match(rule(P), /padding:4px/);
    assert.match(rule(P), /gap:4px/);
    assert.match(rule(P + " .bccmv-bar"), /opacity:0;pointer-events:none/);
});
