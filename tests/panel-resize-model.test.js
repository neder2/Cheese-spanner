const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function setup() {
    const existing = { utils: { sentinel: true } };
    const context = vm.createContext({ BetterChzzk: existing });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../features/panelResizeModel.js"), "utf8"), context);
    assert.equal(context.BetterChzzk, existing);
    assert.equal(existing.utils.sentinel, true);
    return context.BetterChzzk.panelResizeModel;
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const state = (sidebarWidthPx = null, chatWidthPx = null) => ({ version: 1, sidebarWidthPx, chatWidthPx });
function geometry(availableWidthPx = 1500, patch = {}) {
    return {
        availableWidthPx,
        sidebar: { visible: true, enabled: true, nativeWidthPx: 240 },
        chat: { visible: true, enabled: true, nativeWidthPx: 360 },
        ...patch,
    };
}

test("local keys normalize independent widths without coercion or storage access", () => {
    const model = setup();
    assert.deepEqual(plain(model.STORAGE_KEYS), {
        sidebar: "betterchzzk:panel-resize:sidebar-width:v1",
        chat: "betterchzzk:panel-resize:chat-width:v1",
    });
    assert.equal(Object.isFrozen(model.STORAGE_KEYS), true);
    for (const raw of [undefined, null, [], 1, "text", {}]) {
        assert.deepEqual(plain(model.fromStorage(raw)), state());
    }
    for (const invalid of [undefined, null, -1, 0, 1.1, NaN, Infinity, -Infinity, 8193, "300", true, {}, []]) {
        assert.equal(model.normalizeWidth(invalid), null);
        assert.deepEqual(
            plain(model.fromStorage({ [model.STORAGE_KEYS.sidebar]: invalid, [model.STORAGE_KEYS.chat]: 450 })),
            state(null, 450)
        );
        assert.deepEqual(
            plain(model.fromStorage({ [model.STORAGE_KEYS.sidebar]: 260, [model.STORAGE_KEYS.chat]: invalid })),
            state(260, null)
        );
    }
    assert.deepEqual(
        plain(model.fromStorage({ [model.STORAGE_KEYS.sidebar]: 1, [model.STORAGE_KEYS.chat]: 8192, extra: 42 })),
        state(1, 8192)
    );
    for (const raw of [null, [], 1, "text", {}, { version: 0 }, { version: "1" }]) {
        assert.deepEqual(plain(model.normalizeState(raw)), state());
    }
    assert.deepEqual(plain(model.normalizeState({ version: 1, sidebarWidthPx: 270 })), state(270));
    assert.deepEqual(plain(model.normalizeState({ version: 1, chatWidthPx: 410 })), state(null, 410));
});

test("partial reset and changes are pure and retain the other panel", () => {
    const model = setup();
    const chosen = Object.freeze(state(290, 470));
    assert.deepEqual(plain(model.withWidth(chosen, "sidebar", null)), state(null, 470));
    assert.deepEqual(plain(model.withWidth(chosen, "chat", null)), state(290));
    assert.deepEqual(plain(model.withWidth(chosen, "chat", 550)), state(290, 550));
    assert.deepEqual(plain(model.withWidth(chosen, "other", 500)), chosen);
    assert.deepEqual(plain(model.withWidth(chosen, "chat", NaN)), chosen);
    assert.deepEqual(chosen, state(290, 470));
});

test("native widths remain untouched, even outside the custom limits", () => {
    const model = setup();
    assert.deepEqual(
        plain(
            model.calculateLayout(
                state(),
                geometry(1500, {
                    sidebar: { visible: true, enabled: true, nativeWidthPx: 80 },
                    chat: { visible: true, enabled: true, nativeWidthPx: 700 },
                })
            )
        ),
        { suspended: false, sidebarWidthPx: null, chatWidthPx: null }
    );
    assert.deepEqual(plain(model.calculateLayout(state(1, 8192), geometry())), {
        suspended: false,
        sidebarWidthPx: 180,
        chatWidthPx: 640,
    });
});

test("window shrink reduces both excess widths by the same ratio and expansion restores the choices", () => {
    const model = setup();
    const chosen = Object.freeze(state(420, 640));
    assert.deepEqual(plain(model.calculateLayout(chosen, geometry(1060))), {
        suspended: false,
        sidebarWidthPx: 300,
        chatWidthPx: 440,
    });
    assert.deepEqual(plain(model.calculateLayout(chosen, geometry(740))), {
        suspended: false,
        sidebarWidthPx: 180,
        chatWidthPx: 240,
    });
    assert.deepEqual(plain(model.calculateLayout(chosen, geometry(739))), {
        suspended: true,
        sidebarWidthPx: null,
        chatWidthPx: null,
    });
    assert.deepEqual(plain(model.calculateLayout(chosen, geometry(1500))), {
        suspended: false,
        sidebarWidthPx: 420,
        chatWidthPx: 640,
    });
    assert.deepEqual(chosen, state(420, 640));
    const fractional = model.calculateLayout(chosen, geometry(1060.8));
    assert.ok(fractional.sidebarWidthPx + fractional.chatWidthPx + 320 <= 1060.8);
    assert.ok(Math.abs((fractional.sidebarWidthPx - 180) / 240 - (fractional.chatWidthPx - 240) / 400) < 0.005);
});

test("one custom panel reserves the native panel and disabled or hidden selections are retained", () => {
    const model = setup();
    assert.deepEqual(plain(model.calculateLayout(state(420), geometry(900))), {
        suspended: false,
        sidebarWidthPx: 220,
        chatWidthPx: null,
    });
    assert.deepEqual(plain(model.calculateLayout(state(null, 640), geometry(900))), {
        suspended: false,
        sidebarWidthPx: null,
        chatWidthPx: 340,
    });
    assert.equal(model.calculateLayout(state(420), geometry(859)).suspended, true);
    const chosen = Object.freeze(state(420, 640));
    assert.deepEqual(
        plain(
            model.calculateLayout(
                chosen,
                geometry(1000, {
                    sidebar: { visible: true, enabled: false, nativeWidthPx: 240 },
                })
            )
        ),
        { suspended: false, sidebarWidthPx: null, chatWidthPx: 440 }
    );
    assert.deepEqual(
        plain(
            model.calculateLayout(
                chosen,
                geometry(960, {
                    sidebar: { visible: false, enabled: true, nativeWidthPx: 240 },
                })
            )
        ),
        { suspended: false, sidebarWidthPx: null, chatWidthPx: 640 }
    );
    assert.deepEqual(plain(model.calculateLayout(chosen, geometry(740, { chat: { visible: false } }))), {
        suspended: false,
        sidebarWidthPx: 420,
        chatWidthPx: null,
    });
    assert.deepEqual(chosen, state(420, 640));
});

test("invalid measurements yield to native layout instead of calculating an unsafe width", () => {
    const model = setup();
    for (const width of [undefined, NaN, Infinity, -1, "1000"]) {
        assert.equal(
            model.calculateLayout(state(300, 450), geometry(width === undefined ? NaN : width)).suspended,
            true
        );
    }
    assert.equal(
        model.calculateLayout(
            state(300),
            geometry(1200, {
                chat: { visible: true, enabled: true, nativeWidthPx: NaN },
            })
        ).suspended,
        true
    );
});

test("one-panel resize clamps to the remaining actual space without changing the other choice", () => {
    const model = setup();
    assert.deepEqual(plain(model.getResizeRange("sidebar", 1000, 440)), { min: 180, max: 240 });
    assert.deepEqual(plain(model.getResizeRange("chat", 1100.5, 240.2)), { min: 240, max: 540 });
    assert.equal(model.getResizeRange("sidebar", 939, 440), null);
    assert.equal(model.getResizeRange("other", 1500, 0), null);
    assert.equal(model.getResizeRange("chat", NaN, 200), null);
    assert.equal(model.getResizeRange("chat", 1500, -1), null);
    assert.equal(model.clampWidth("sidebar", 800, 1000, 440), 240);
    assert.equal(model.clampWidth("sidebar", 0, 1000, 440), 180);
    assert.equal(model.clampWidth("chat", 321.6, 1500, 240), 322);
    assert.equal(model.clampWidth("chat", NaN, 1500, 240), null);
    assert.equal(model.clampWidth("sidebar", 300, 939, 440), null);
    const chosen = Object.freeze(state(420, 640));
    const updated = model.withWidth(chosen, "sidebar", model.clampWidth("sidebar", 800, 1000, 440));
    assert.deepEqual(plain(updated), state(240, 640));
});
