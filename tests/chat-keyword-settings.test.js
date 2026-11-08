const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { waitForCondition } = require("./helpers/wait-for-condition.js");
const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const ENTRY = "[data-bcct-keyword-settings-entry]";
const PANEL = "[data-bcct-keyword-settings-panel]";
const ENABLED = "chatKeywordFilterEnabled";
const WORDS = "chatKeywordFilterWords";
const APPLY = "chatKeywordFilterApplyMode";
const MATCH = "chatKeywordFilterMatchMode";
const EXACT = "chatKeywordFilterExactWords";
const defaultConditions = { [APPLY]: "all", [MATCH]: "contains", [EXACT]: "" };
const absentConditions = Object.fromEntries(Object.keys(defaultConditions).map((key) => [key, { absent: true }]));
const plain = (value) => JSON.parse(JSON.stringify(value));
const menuMarkup =
    '<div class="_wrapper_11w2f_52"><button type="button" class="_button_11w2f_15"><span class="_contents_11w2f_21"><span>클린봇</span><span>켜짐</span></span></button></div>';

function trusted(dom, target, type = "click", init = {}) {
    const event = type.startsWith("key")
        ? new dom.window.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
        : new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
    const impl = Object.getOwnPropertySymbols(event).find((symbol) => symbol.description === "impl");
    event[impl].isTrusted = true;
    target[impl]._dispatch(event[impl]);
    return event;
}

function fixture(t, { raw = {}, url = "/live/test-channel", deferWrites = false, holdReads = false } = {}) {
    const dom = new JSDOM(
        `<!doctype html><body><button id="outside">바깥</button><aside id="aside-chatting"><div class="_container_1e2su_2"><h2>채팅</h2><div class="_wrapper_1e2su_28 _menu_1e2su_36"><button aria-label="더보기 메뉴" aria-haspopup="true" aria-expanded="false">⋯</button></div></div><div role="log"></div></aside></body>`,
        { url: `https://chzzk.naver.com${url}`, runScripts: "outside-only", pretendToBeVisual: true }
    );
    const document = dom.window.document;
    const listeners = [];
    const writes = [];
    const reads = [];
    const pending = [];
    const data = { ...raw };
    let pauseReads = holdReads;
    const emit = (values) => {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
            changes[key] = { oldValue: data[key], newValue: value };
            if (value === undefined) delete data[key];
            else data[key] = value;
        }
        for (const listener of listeners) listener(changes, "sync");
    };
    const area = {
        get(keys, callback) {
            const result = Object.fromEntries(
                (Array.isArray(keys) ? keys : [keys])
                    .filter((key) => Object.hasOwn(data, key))
                    .map((key) => [key, data[key]])
            );
            if (pauseReads) reads.push(() => callback(result));
            else setTimeout(() => callback(result), 0);
        },
    };
    dom.window.chrome = {
        runtime: {},
        storage: {
            sync: area,
            local: area,
            onChanged: {
                addListener: (listener) => listeners.push(listener),
                removeListener: (listener) => listeners.splice(listeners.indexOf(listener), 1),
            },
        },
    };
    for (const name of ["shared/settings.js", "shared/data.js", "content.js", "shared/uiTheme.js"])
        dom.window.eval(read(name));
    dom.window.CheeseSpanner.utils.settingsStoreSet = (area, values, expected) => {
        writes.push(plain({ area, values, expected }));
        return new Promise((resolve, reject) => {
            const finish = () => {
                emit(plain(values));
                resolve();
            };
            if (deferWrites) pending.push({ resolve: finish, reject });
            else finish();
        });
    };
    dom.window.eval(read("features/chatTools/keywordSettings.js"));
    dom.window.eval(read("features/routeBridgePage.js"));
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    t.after(() => {
        dom.window.dispatchEvent(new dom.window.Event("pagehide"));
        dom.window.close();
    });
    const trigger = document.querySelector('button[aria-label="더보기 메뉴"]');
    const openMenu = (parent = trigger.parentElement, opener = trigger) => {
        const menu = document.createElement("div");
        menu.className = "_container_11w2f_1";
        menu.innerHTML = menuMarkup;
        parent.append(menu);
        opener.setAttribute("aria-expanded", "true");
        return menu;
    };
    const openPanel = async () => {
        await waitForCondition(() => document.querySelector(`${ENTRY} button`));
        trusted(dom, document.querySelector(`${ENTRY} button`));
        await waitForCondition(() => document.querySelector(PANEL));
        return document.querySelector(PANEL);
    };
    const loaded = async () => {
        await waitForCondition(() => document.querySelector(`${PANEL} textarea`)?.disabled === false);
        return document.querySelector(PANEL);
    };
    return {
        dom,
        document,
        trigger,
        openMenu,
        openPanel,
        loaded,
        writes,
        pending,
        emit,
        data,
        reads,
        releaseReads() {
            pauseReads = false;
            for (const finish of reads.splice(0)) finish();
        },
    };
}
const typeWords = (f, value) => {
    const input = f.document.querySelector(`${PANEL} textarea`);
    input.value = value;
    input.dispatchEvent(new f.dom.window.Event("input", { bubbles: true }));
    return input;
};
const clickAction = (f, action) => trusted(f.dom, f.document.querySelector(`${PANEL} [data-action="${action}"]`));

test("the native menu remains reachable when moderator actions wrap its trigger", async (t) => {
    const f = fixture(t);
    const host = f.trigger.parentElement;
    const actions = f.document.createElement("span");
    actions.setAttribute("data-bcct-moderator-actions", "1");
    host.insertBefore(actions, f.trigger);
    actions.append(f.trigger);
    const menu = f.openMenu(host);
    await waitForCondition(() => menu.querySelector(ENTRY));
    const button = menu.querySelector(`${ENTRY} button`);
    assert.equal(button.textContent, "문구 숨김");
    assert.equal(button.querySelectorAll("svg path").length, 2);
    await f.openPanel();
    const panel = await f.loaded();
    assert.equal(panel.getAttribute("aria-label"), "문구 숨김");
    assert.equal(menu.querySelectorAll(ENTRY).length, 1);
});

test("only the real header menu gains one entry even when filtering is OFF or empty", async (t) => {
    const f = fixture(t, { raw: { [ENABLED]: false, [WORDS]: "" } });
    const fixed = f.document.createElement("div");
    fixed.innerHTML = '<button aria-label="더보기 메뉴" aria-haspopup="true" aria-expanded="true">⋯</button>';
    f.document.querySelector('[role="log"]').append(fixed);
    const fakeMenu = f.openMenu(fixed, fixed.firstElementChild);
    const menu = f.openMenu();
    await waitForCondition(() => menu.querySelector(ENTRY));
    assert.equal(fakeMenu.querySelector(ENTRY), null);
    assert.equal(menu.querySelectorAll(ENTRY).length, 1);
    assert.equal(f.document.querySelector("h2").parentElement.querySelectorAll(":scope > button").length, 0);
    f.document.querySelector(`${ENTRY} button`).click();
    assert.equal(f.document.querySelector(PANEL), null, "untrusted page click cannot open the editor");
    await f.openPanel();
    const panel = await f.loaded();
    assert.equal(panel.querySelector("input").checked, false);
    assert.equal(panel.querySelector("textarea").value, "");
    assert.equal(menu.querySelectorAll(ENTRY).length, 1);
    assert.equal(menu.querySelectorAll("._wrapper_11w2f_52").length, 2, "native cleanbot row stays in place");
});

test("a real save normalizes phrases and uses raw absent expectations, while a synthetic click writes nothing", async (t) => {
    const f = fixture(t);
    f.openMenu();
    await f.openPanel();
    const panel = await f.loaded();
    assert.equal(panel.querySelector("input").checked, true);
    typeWords(f, " 금지 \nABC\nabc\n");
    panel.querySelector('[data-action="save"]').click();
    assert.equal(f.writes.length, 0);
    clickAction(f, "save");
    await waitForCondition(() => panel.querySelector('[role="status"]').textContent === "저장했어요.");
    assert.deepEqual(f.writes, [
        {
            area: "sync",
            values: { [ENABLED]: true, [WORDS]: "금지\nABC", ...defaultConditions },
            expected: { [ENABLED]: { absent: true }, [WORDS]: { absent: true }, ...absentConditions },
        },
    ]);
    assert.equal(panel.querySelector("textarea").value, "금지\nABC");
});

test("chat menu saves global and individual conditions, retains choices across modes and handles condition conflicts", async (t) => {
    const f = fixture(t, { raw: { [WORDS]: "금지\nABC" } });
    f.openMenu();
    await f.openPanel();
    let panel = await f.loaded();
    const choose = (selector, value) => {
        const select = panel.querySelector(selector);
        select.value = value;
        select.dispatchEvent(new f.dom.window.Event("change", { bubbles: true }));
        return select;
    };
    choose('[data-field="matchMode"]', "exact");
    clickAction(f, "save");
    await waitForCondition(() => f.data[MATCH] === "exact" && !panel.querySelector('[data-action="save"]').disabled);
    choose('[data-field="applyMode"]', "individual");
    assert.equal(panel.querySelector('[data-field="matchMode"]').disabled, true);
    assert.equal(panel.querySelector('[data-field="individual"]').hidden, false);
    const selected = choose('[data-keyword-phrase="금지"]', "exact");
    selected.focus();
    assert.equal(f.document.activeElement, selected, "changing a condition keeps its control mounted");
    choose('[data-field="applyMode"]', "all");
    assert.equal(panel.querySelector('[data-field="matchMode"]').value, "exact");
    choose('[data-field="applyMode"]', "individual");
    assert.equal(panel.querySelector('[data-keyword-phrase="금지"]').value, "exact");
    assert.equal(panel.querySelector('[data-keyword-phrase="ABC"]').value, "contains");
    typeWords(f, "금지\nABC\n<img src=x onerror=alert(1)>");
    assert.equal(panel.querySelectorAll('[data-field="rules"] select').length, 3);
    assert.equal(panel.querySelector('[data-field="rules"] img'), null);
    clickAction(f, "save");
    await waitForCondition(() => f.data[APPLY] === "individual" && f.data[EXACT] === "금지");
    clickAction(f, "close");
    await f.openPanel();
    panel = await f.loaded();
    assert.equal(panel.querySelector('[data-keyword-phrase="금지"]').value, "exact");
    choose('[data-keyword-phrase="ABC"]', "exact");
    f.emit({ [EXACT]: "ABC" });
    assert.equal(panel.querySelector('[data-action="save"]').disabled, true);
    assert.equal(panel.querySelector('[data-keyword-phrase="금지"]').value, "exact");
    clickAction(f, "reload");
    await f.loaded();
    assert.equal(panel.querySelector('[data-keyword-phrase="금지"]').value, "contains");
    assert.equal(panel.querySelector('[data-keyword-phrase="ABC"]').value, "exact");
    typeWords(f, "금지");
    clickAction(f, "save");
    await waitForCondition(() => f.data[EXACT] === "");
    assert.deepEqual(f.writes.at(-1).expected[EXACT], { value: "ABC" });
});

test("oversized phrase and failed writes preserve the typed text", async (t) => {
    const f = fixture(t, { deferWrites: true });
    f.openMenu();
    await f.openPanel();
    const panel = await f.loaded();
    typeWords(f, "가".repeat(101));
    clickAction(f, "save");
    assert.equal(f.writes.length, 0);
    assert.match(panel.querySelector('[role="status"]').textContent, /100자/);
    typeWords(f, "다시 시도할 문구");
    clickAction(f, "save");
    f.pending[0].reject(new Error("storage failed"));
    await waitForCondition(() => panel.querySelector('[role="status"]').textContent.includes("저장하지 못했어요"));
    assert.equal(panel.querySelector("textarea").value, "다시 시도할 문구");
    assert.equal(panel.querySelector('[data-action="save"]').disabled, false);
});

test("external changes preserve a dirty edit and require explicit reload before saving", async (t) => {
    const f = fixture(t, { raw: { [ENABLED]: true, [WORDS]: "이전" } });
    f.openMenu();
    await f.openPanel();
    const panel = await f.loaded();
    typeWords(f, "내 입력");
    f.emit({ [ENABLED]: false, [WORDS]: "다른 창 입력" });
    assert.equal(panel.querySelector("textarea").value, "내 입력");
    assert.equal(panel.querySelector("input").checked, true);
    assert.equal(panel.querySelector('[data-action="save"]').disabled, true);
    clickAction(f, "save");
    assert.equal(f.writes.length, 0);
    clickAction(f, "reload");
    await f.loaded();
    assert.equal(panel.querySelector("textarea").value, "다른 창 입력");
    assert.equal(panel.querySelector("input").checked, false);
    typeWords(f, "명시 재편집");
    clickAction(f, "save");
    await waitForCondition(() => f.writes.length === 1);
    assert.deepEqual(f.writes[0].expected, {
        [ENABLED]: { value: false },
        [WORDS]: { value: "다른 창 입력" },
        ...absentConditions,
    });
});

test("a storage change arriving before the initial read wins over the delayed read", async (t) => {
    const f = fixture(t, { holdReads: true, raw: { [WORDS]: "오래된 읽기" } });
    f.openMenu();
    await f.openPanel();
    f.emit({ [WORDS]: "새 문구" });
    f.releaseReads();
    const panel = await f.loaded();
    assert.equal(panel.querySelector("textarea").value, "새 문구");
    typeWords(f, "편집");
    clickAction(f, "save");
    await waitForCondition(() => f.writes.length === 1);
    assert.deepEqual(f.writes[0].expected[WORDS], { value: "새 문구" });
});

test("backend CAS conflict preserves input and never retries with a newer expected value", async (t) => {
    const f = fixture(t, { deferWrites: true, raw: { [WORDS]: "기준" } });
    f.openMenu();
    await f.openPanel();
    const panel = await f.loaded();
    typeWords(f, "내 변경");
    clickAction(f, "save");
    f.pending[0].reject(
        Object.assign(new Error("conflict"), { code: "conflict", current: { [WORDS]: { value: "외부 변경" } } })
    );
    await waitForCondition(() => panel.querySelector('[role="status"]').textContent.includes("바뀌어 저장하지"));
    assert.equal(panel.querySelector("textarea").value, "내 변경");
    assert.equal(panel.querySelector('[data-action="save"]').disabled, true);
    assert.equal(f.writes.length, 1);
});

test("menu removal, replacement, SPA and pagehide invalidate delayed reads or writes", async (t) => {
    const f = fixture(t, { deferWrites: true });
    let menu = f.openMenu();
    await f.openPanel();
    await f.loaded();
    typeWords(f, "저장");
    clickAction(f, "save");
    menu.remove();
    f.pending[0].resolve();
    await waitForCondition(() => !f.document.querySelector(PANEL));
    menu = f.openMenu();
    await f.openPanel();
    await f.loaded();
    assert.equal(f.document.querySelectorAll(PANEL).length, 1);
    f.dom.window.history.pushState({}, "", "/video/123");
    await waitForCondition(() => !f.document.querySelector(PANEL) && !f.document.querySelector(ENTRY));
    f.dom.window.history.pushState({}, "", "/live/next/chat");
    await waitForCondition(() => f.document.querySelector(ENTRY));
    await f.openPanel();
    await f.loaded();
    f.dom.window.dispatchEvent(new f.dom.window.Event("pagehide"));
    assert.equal(f.document.querySelector(PANEL), null);
    assert.equal(f.document.querySelector(ENTRY), null);
});

test("editor keyboard events stay out of player shortcuts, Escape restores focus, and outside clicks close", async (t) => {
    const f = fixture(t);
    f.openMenu();
    await f.openPanel();
    const panel = await f.loaded();
    let playerKeys = 0;
    f.dom.window.addEventListener("keydown", () => playerKeys++, true);
    const words = panel.querySelector("textarea");
    words.focus();
    trusted(f.dom, words, "keydown", { key: "ArrowRight", code: "ArrowRight" });
    trusted(f.dom, words, "keyup", { key: "ArrowRight", code: "ArrowRight" });
    assert.equal(playerKeys, 0);
    const button = panel.querySelector('[data-action="save"]');
    button.focus();
    const tab = trusted(f.dom, button, "keydown", { key: "Tab", code: "Tab" });
    assert.equal(tab.defaultPrevented, true);
    assert.equal(f.document.activeElement, panel.querySelector("input"));
    trusted(f.dom, panel.querySelector("input"), "keydown", { key: "Escape", code: "Escape" });
    assert.equal(f.document.querySelector(PANEL), null);
    assert.equal(f.document.activeElement, f.document.querySelector(`${ENTRY} button`));
    await f.openPanel();
    await f.loaded();
    trusted(f.dom, f.document.querySelector("#outside"), "pointerdown");
    assert.equal(f.document.querySelector(PANEL), null);
});

test("closed chat menus and VOD pages do not gain standalone controls", async (t) => {
    const f = fixture(t, { url: "/video/123" });
    f.openMenu();
    await new Promise((resolve) => setTimeout(resolve, 130)); // Beyond one menu-sync interval, still outside supported live header route.
    assert.equal(f.document.querySelector(ENTRY), null);
    assert.equal(f.document.querySelector(PANEL), null);
    f.dom.window.history.pushState({}, "", "/live/channel/chat");
    await waitForCondition(() => f.document.querySelector(ENTRY));
    f.trigger.setAttribute("aria-expanded", "false");
    await waitForCondition(() => !f.document.querySelector(ENTRY));
});
