const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const {
    createFakeChrome,
    readRepoFile,
    dispatchTrusted,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

// Native home menu shape from docs/measurements/stream-info-settings-2026-09-15.md: two native items.
const MENU = `<div class="pzp-settings pzp-pc-settings pzp-pc__settings" role="menu">
<div role="menuitem" tabindex="0" class="pzp-ui-setting-home-item" id="native-quality">해상도</div>
<div role="menuitem" tabindex="0" class="pzp-ui-setting-home-item" id="native-filter">선명한 화면</div></div>`;

function rect(width, height) {
    return { x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height };
}

const FEATURE_ROWS = {
    stream: "cheese-spanner-stream-info-settings-item",
    ambient: "cheese-spanner-ambient-row",
};
// Each feature's capture keydown handler on the gear menu, by its function name.
const MENU_NAVIGATION = { onSettingsNavigation: "stream", onMenuNavigation: "ambient" };

// Both features inject a row into the same gear menu. The second feature is only loaded after the first one's
// row is installed, so the given order is the real injection and menu keydown listener order (asserted below).
async function fixture(t, order) {
    const chrome = createFakeChrome({ sync: { ambientEnabled: true, streamInfoEnabled: true } });
    const dom = new JSDOM(
        `<!doctype html><html><body><div id="layout-body"><main><div class="pzp-pc"><div class="pzp-pc__video"><video></video></div>
<div class="pzp-pc__bottom-buttons-right"><button class="pzp-setting-button" aria-label="설정" aria-expanded="false"></button></div>
${MENU}</div></main></div></body></html>`,
        { url: "https://chzzk.naver.com/live/test-channel", runScripts: "outside-only", pretendToBeVisual: true }
    );
    const w = dom.window;
    w.chrome = chrome;
    w.HTMLCanvasElement.prototype.getContext = () => null;
    // Currently registered capture keydown listeners on the gear menu, in registration (= dispatch) order.
    const menuListeners = [];
    const isMenuCapture = (target, type, options) =>
        type === "keydown" &&
        target instanceof w.Element &&
        target.matches(".pzp-pc__settings") &&
        (options === true || options?.capture === true);
    const nativeAdd = w.EventTarget.prototype.addEventListener;
    const nativeRemove = w.EventTarget.prototype.removeEventListener;
    w.EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (isMenuCapture(this, type, options) && !menuListeners.includes(listener)) menuListeners.push(listener);
        return nativeAdd.call(this, type, listener, options);
    };
    w.EventTarget.prototype.removeEventListener = function (type, listener, options) {
        if (isMenuCapture(this, type, options) && menuListeners.includes(listener))
            menuListeners.splice(menuListeners.indexOf(listener), 1);
        return nativeRemove.call(this, type, listener, options);
    };
    const video = w.document.querySelector("video");
    Object.defineProperty(video, "readyState", { configurable: true, get: () => 4 });
    w.HTMLElement.prototype.getBoundingClientRect = function () {
        return this.closest(".pzp-pc") ? rect(1280, 720) : rect(0, 0);
    };
    // Every menu row is rendered (hidden rows have no client rects).
    w.Element.prototype.getClientRects = function () {
        return this.hidden || this.closest("[hidden]") ? [] : [rect(240, 42)];
    };
    for (const file of [
        "shared/settings.js",
        "shared/data.js",
        "content.js",
        "shared/uiTheme.js",
        "shared/liveTiming.js",
    ])
        w.eval(readRepoFile(file));
    const features = {
        stream: ["features/streamInfoModel.js", "features/streamInfo.js"],
        ambient: ["features/ambientGlow.js"],
    };
    t.after(() => {
        const off = { streamInfoEnabled: { newValue: false }, ambientEnabled: { newValue: false } };
        for (const listener of [...chrome.testState.storageChangeListeners]) listener(off, "sync");
        w.CheeseSpanner.ambientGlow?.stop?.();
        w.close();
    });
    const doc = w.document;
    for (const [index, name] of order.entries()) {
        for (const file of features[name]) w.eval(readRepoFile(file));
        if (index === 0) doc.dispatchEvent(new w.Event("DOMContentLoaded"));
        await waitForCondition(() => doc.getElementById(FEATURE_ROWS[name]));
    }
    return {
        w,
        doc,
        menuListenerOrder: () => menuListeners.map((listener) => MENU_NAVIGATION[listener.name] || listener.name),
        menu: () => doc.querySelector(".pzp-pc__settings"),
        stream: () => doc.getElementById("cheese-spanner-stream-info-settings-item"),
        ambient: () => doc.getElementById("cheese-spanner-ambient-expand"),
        toggle: () => doc.getElementById("cheese-spanner-ambient-toggle"),
        first: () => doc.getElementById("native-quality"),
        last: () => doc.getElementById("native-filter"),
        press(target, key) {
            target.focus();
            const event = new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
            dispatchTrusted(target, event);
            return event;
        },
    };
}

for (const order of [
    ["stream", "ambient"],
    ["ambient", "stream"],
]) {
    test(`arrow keys reach both injected gear rows when ${order.join(" then ")} install in that order`, async (t) => {
        const f = await fixture(t, order);
        assert.ok(f.stream() && f.ambient());
        // Menu order: [해상도, 선명한 화면, ...injected rows in install order].
        const rows = [...f.menu().children].filter((row) => row.getAttribute("role") !== "group");
        assert.equal(rows.length, 4);
        const injected = rows.slice(2);
        assert.deepEqual(
            injected.map((row) => row.id),
            order.map((name) => FEATURE_ROWS[name]),
            "rows are injected in install order"
        );
        // The menu capture handlers run in install order too; each must yield to the other's rows either way.
        assert.deepEqual(f.menuListenerOrder(), order, "menu keydown listeners are registered in install order");
        const entry = (row) => (row.id === "cheese-spanner-ambient-row" ? f.ambient() : row);
        const [a, b] = injected.map(entry);
        for (const [from, key, to] of [
            [f.last(), "ArrowDown", a],
            [a, "ArrowDown", b],
            [b, "ArrowDown", f.first()],
            [f.first(), "ArrowUp", b],
            [b, "ArrowUp", a],
            [a, "ArrowUp", f.last()],
            [f.first(), "End", b],
            [b, "Home", f.first()],
        ]) {
            const event = f.press(from, key);
            assert.equal(event.defaultPrevented, true, `${from.id} ${key}`);
            assert.equal(f.doc.activeElement, to, `${from.id} ${key} -> ${to.id}`);
        }
        // The ambient switch belongs to the same row and leaves it like the label does.
        if (b === f.ambient()) {
            f.press(f.toggle(), "ArrowDown");
            assert.equal(f.doc.activeElement, f.first());
        } else {
            f.press(f.toggle(), "ArrowDown");
            assert.equal(f.doc.activeElement, b);
        }
        // Native-to-native moves stay with the player.
        assert.equal(f.press(f.first(), "ArrowDown").defaultPrevented, false);
        assert.equal(f.press(f.last(), "ArrowUp").defaultPrevented, false);
    });
}
