const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { waitForCondition } = require("./helpers/wait-for-condition.js");

const FILTERED = "data-bcct-keyword-filtered";
const STYLE = "cheese-spanner-chat-keyword-filter-style";
const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const row = (id, text, author = "시청자", extra = "") =>
    `<div class="_item_61avy_82" data-chat-id="${id}"><div class="_container_w9pvh_1"><div class="_chatting_message_w9pvh_21"><button type="button" class="_nickname_w9pvh_33" aria-haspopup="true" aria-expanded="false"><span class="_nickname_1mc5x_80">${author}</span></button>${extra}<span class="_text_w9pvh_1">${text}</span></div></div></div>`;

function nativeListFixture(dom, { vod, height = 310, updated = false } = {}) {
    const { document } = dom.window;
    const log = document.querySelector('[role="log"]');
    const nodes = Array.from(log.children);
    const messages = nodes.map((node) => ({ key: node.getAttribute("data-chat-id") }));
    const list = document.createElement("div");
    list.className = updated
        ? vod
            ? "_list_tdctj_127"
            : "_wrapper_1li40_25"
        : vod
          ? "_list_61avy_67"
          : "_wrapper_8lqsk_25";
    let viewportHeight = height;
    Object.defineProperty(list, "clientHeight", { get: () => viewportHeight });
    const sentinel = document.createElement("div");
    sentinel.className = updated
        ? vod
            ? "_list_bottom_tdctj_154"
            : "_list_bottom_1li40_52"
        : vod
          ? "_list_bottom_61avy_94"
          : "_list_bottom_8lqsk_61";
    if (updated) {
        for (const node of nodes) node.className = vod ? "_item_tdctj_142" : "_item_1li40_7";
        list.style.setProperty("--chat-scale", "1");
    }
    log.replaceChildren(list);
    list.append(sentinel);
    const calls = [];
    const state = (value, dispatch = () => {}) => ({ memoizedState: value, queue: { dispatch }, next: null });
    const limit = state(Math.ceil(height / 31), (value) => {
        calls.push(value);
        dom.window.queueMicrotask(() => {
            limit.memoizedState = value;
            render();
        });
    });
    const paused = state(false);
    const backlog = state(messages);
    const rendered = state([]);
    const ref = { memoizedState: { current: list }, next: null };
    const effect = { memoizedState: { deps: [], create: () => {} }, next: null };
    const hooks = [limit, paused, backlog, rendered, ref, effect];
    hooks.forEach((hook, index) => (hook.next = hooks[index + 1] || null));
    const root = { tag: 3, stateNode: {} };
    root.stateNode.current = root;
    const owner = { tag: 0, memoizedState: hooks[0], return: root };
    const host = { tag: 5, stateNode: list, return: owner };
    list.__reactFiber$test = host;

    function render() {
        rendered.memoizedState = paused.memoizedState ? messages : messages.slice(0, limit.memoizedState);
        effect.memoizedState.deps = [messages, limit.memoizedState, paused.memoizedState];
        const count = rendered.memoizedState.length;
        for (let index = 0; index < nodes.length; index++) {
            if (index < count) {
                if (nodes[index].parentElement !== list) list.append(nodes[index]);
            } else nodes[index].remove();
        }
    }
    render();
    return {
        list,
        nodes,
        messages,
        calls,
        hooks,
        owner,
        root,
        host,
        get limit() {
            return limit.memoizedState;
        },
        request(value) {
            if (value === null) list.removeAttribute("data-bcct-hidden-count");
            else list.setAttribute("data-bcct-hidden-count", String(value));
            list.dispatchEvent(new dom.window.Event("cheese-spanner:chat-list-layout-request", { bubbles: true }));
        },
        pause(value) {
            paused.memoizedState = value;
            render();
        },
        resize(value) {
            viewportHeight = value;
            limit.memoizedState = Math.ceil(value / 31);
            render();
        },
    };
}

function fixture(t, rows, { url = "/live/test-channel", options = {}, extra = "", nativeWindow = false } = {}) {
    const vod = url.startsWith("/video/");
    const dom = new JSDOM(
        `<!doctype html><body>${extra}<aside id="${vod ? "vod-aside" : "aside-chatting"}" class="live_chatting_area"><div class="chat-header"><strong>채팅</strong><button class="chat-more" type="button" aria-label="더보기">⋮</button></div><div class="chat-list" role="log">${rows}</div></aside></body>`,
        { url: `https://chzzk.naver.com${url}`, runScripts: "outside-only", pretendToBeVisual: true }
    );
    const listeners = [];
    const native = nativeWindow ? nativeListFixture(dom, { vod, ...nativeWindow }) : null;
    const sync = { chatKeywordFilterEnabled: true, chatKeywordFilterWords: "금지", ...options };
    const writes = [];
    const area = (values = {}) => ({
        get(keys, callback) {
            const result = Object.fromEntries(
                (Array.isArray(keys) ? keys : [keys])
                    .filter((key) => Object.hasOwn(values, key))
                    .map((key) => [key, values[key]])
            );
            setTimeout(() => callback(result), 0);
        },
        set(values, callback) {
            writes.push(values);
            setTimeout(() => callback?.(), 0);
        },
        remove(_keys, callback) {
            setTimeout(() => callback?.(), 0);
        },
    });
    dom.window.chrome = {
        runtime: {},
        storage: {
            sync: area(sync),
            local: area(),
            onChanged: {
                addListener: (fn) => listeners.push(fn),
                removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
            },
        },
    };
    dom.window.fetch = async () => {
        throw new Error("chat filtering must not request messages");
    };
    let parseCount = 0;
    let containerTextReads = 0;
    for (const name of [
        "shared/settings.js",
        "shared/data.js",
        "content.js",
        "shared/uiTheme.js",
        "features/chatTools/parser.js",
        "features/chatTools/messageStore.js",
        "features/chatTools/panel.js",
        "features/chatTools/listLayoutPage.js",
        "features/chatTools.js",
        "features/routeBridgePage.js",
    ]) {
        dom.window.eval(read(name));
        if (name === "features/chatTools/parser.js") {
            const namespace = dom.window.CheeseSpanner.chatTools;
            const parser = namespace.parser;
            namespace.parser = {
                ...parser,
                getVisibleText(node, context) {
                    if (native && node === native.list) containerTextReads++;
                    return parser.getVisibleText(node, context);
                },
                parseChatRow: (node) => {
                    parseCount++;
                    return parser.parseChatRow(node);
                },
            };
        }
    }
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    t.after(() => {
        dom.window.dispatchEvent(new dom.window.Event("pagehide"));
        dom.window.close();
    });
    const set = (values) => {
        const changes = Object.fromEntries(
            Object.entries(values).map(([key, value]) => [key, { oldValue: sync[key], newValue: value }])
        );
        Object.assign(sync, values);
        for (const listener of listeners) listener(changes, "sync");
    };
    return {
        dom,
        document: dom.window.document,
        set,
        writes,
        native,
        get parseCount() {
            return parseCount;
        },
        get containerTextReads() {
            return containerTextReads;
        },
    };
}

const hidden = (node) => node.hasAttribute(FILTERED);
const body = (node) => node.querySelector("._text_w9pvh_1");

test("chat bursts and recycled rows are filtered in the mutation turn before the deferred chat scan", async (t) => {
    for (const url of ["/live/test-channel", "/live/test-channel/chat", "/video/123"]) {
        await t.test(url, async (t) => {
            const f = fixture(t, row("ready", "금지"), { url });
            await waitForCondition(() => hidden(f.document.querySelector('[data-chat-id="ready"]')));
            const log = f.document.querySelector('[role="log"]');
            const initialParses = f.parseCount;
            for (let batch = 0; batch < 4; batch++) {
                log.insertAdjacentHTML(
                    "beforeend",
                    Array.from({ length: 12 }, (_, index) =>
                        row(`burst-${batch}-${index}`, index % 2 ? "허용" : "금지")
                    ).join("")
                );
                // Drain mutation delivery without advancing timers or animation frames.
                await Promise.resolve();
                for (let index = 0; index < 12; index++) {
                    assert.equal(
                        hidden(log.querySelector(`[data-chat-id="burst-${batch}-${index}"]`)),
                        index % 2 === 0,
                        "a new matching row is hidden before another frame can display it"
                    );
                }
            }
            assert.equal(f.parseCount - initialParses, 48, "each new row is parsed once, without rescanning backlog");
            const recycled = log.querySelector('[data-chat-id="burst-0-0"]');
            recycled.setAttribute("data-chat-id", "recycled-allowed");
            body(recycled).firstChild.data = "허용";
            await Promise.resolve();
            assert.equal(hidden(recycled), false, "a reused hidden row is restored in the same mutation turn");
            body(recycled).replaceChildren(f.document.createTextNode("금지 새 내용"));
            await Promise.resolve();
            assert.equal(hidden(recycled), true);
            const beforeOwnMarker = f.parseCount;
            recycled.setAttribute(FILTERED, "1");
            await Promise.resolve();
            assert.equal(f.parseCount, beforeOwnMarker, "our hidden marker does not trigger parsing again");
            // Allow the existing 120 ms collection scan to consume the already parsed rows.
            await new Promise((resolve) => setTimeout(resolve, 180));
            assert.equal(
                f.parseCount,
                beforeOwnMarker,
                "the deferred scan reuses unchanged rows without parsing twice"
            );
        });
    }
});

test("many hidden messages replenish native live, popup and VOD windows and OFF restores the native limit", async (t) => {
    for (const url of ["/live/test-channel", "/live/test-channel/chat", "/video/123"]) {
        await t.test(url, async (t) => {
            const f = fixture(
                t,
                Array.from({ length: 80 }, (_, i) => row(`window-${i}`, i % 4 ? "금지" : "허용")).join(""),
                { url, nativeWindow: true }
            );
            const visible = () =>
                Array.from(f.native.list.children).filter((node) => node.hasAttribute("data-chat-id") && !hidden(node));
            const expected = Array.from({ length: 10 }, (_, i) => `window-${i * 4}`);
            // Replenishment crosses several native commits, each using the existing 120 ms chat batch.
            await waitForCondition(
                () =>
                    visible()
                        .map((node) => node.getAttribute("data-chat-id"))
                        .join(",") === expected.join(","),
                { timeoutMs: 4000 }
            );
            assert.equal(visible().length, 10);
            assert.deepEqual(
                visible().map((node) => node.getAttribute("data-chat-id")),
                expected
            );
            assert.ok(f.native.calls.length < 12, "rendering converges instead of repeatedly increasing the budget");
            assert.equal(f.native.messages.length, 80, "native backlog is preserved");
            assert.equal(f.writes.length, 0);
            f.set({ chatKeywordFilterEnabled: false });
            await waitForCondition(() => f.native.limit === 10 && visible().length === 10);
            assert.equal(f.native.list.hasAttribute("data-bcct-hidden-count"), false);
            assert.equal(f.native.list.scrollTop, 0);
        });
    }
});

test("visible text reads each ancestor style once per call and still respects a later native hide", async (t) => {
    const f = fixture(t, row("visible-read", "금지 문구"));
    const { window } = f.dom;
    const node = window.document.querySelector('[data-chat-id="visible-read"]');
    await waitForCondition(() => node.hasAttribute(FILTERED));
    const original = window.getComputedStyle;
    const reads = new Map();
    window.getComputedStyle = (element) => {
        reads.set(element, (reads.get(element) || 0) + 1);
        return original.call(window, element);
    };
    try {
        assert.match(window.CheeseSpanner.chatTools.parser.getVisibleText(node), /금지 문구/);
        assert.ok(
            [...reads.values()].every((count) => count === 1),
            "one text read must not measure the same ancestor repeatedly"
        );
        assert.equal(node.getAttribute(FILTERED), "1");
        node.style.display = "none";
        assert.equal(
            window.CheeseSpanner.chatTools.parser.getVisibleText(node),
            "",
            "the next call reads current native visibility"
        );
    } finally {
        window.getComputedStyle = original;
    }
});

test("all hidden backlog stops at available messages, and an edited filter and resize refill the window", async (t) => {
    const f = fixture(
        t,
        Array.from({ length: 40 }, (_, i) => row(`all-${i}`, `금지 ${i % 2 ? "홀수" : "짝수"}`)).join(""),
        { nativeWindow: true }
    );
    await waitForCondition(
        () => f.native.limit === 40 && f.native.list.querySelectorAll(`[${FILTERED}]`).length === 40
    );
    const calls = f.native.calls.length;
    assert.equal(f.containerTextReads, 0, "a known list container is excluded before reading all descendant text");
    f.native.request(40);
    f.native.request(40);
    assert.equal(f.native.calls.length, calls, "exhausted backlog does not reschedule a native update");
    f.set({ chatKeywordFilterWords: "짝수" });
    const visibleIds = () =>
        Array.from(f.native.list.children)
            .filter((node) => node.hasAttribute("data-chat-id") && !hidden(node))
            .map((node) => node.getAttribute("data-chat-id"));
    await waitForCondition(
        () => visibleIds().join(",") === Array.from({ length: 10 }, (_, i) => `all-${i * 2 + 1}`).join(","),
        { timeoutMs: 4000 }
    );
    f.native.resize(465);
    await waitForCondition(
        () => visibleIds().join(",") === Array.from({ length: 15 }, (_, i) => `all-${i * 2 + 1}`).join(","),
        { timeoutMs: 4000 }
    );
});

test("updated chat scale layouts replenish hidden rows and restore the native window", async (t) => {
    // 2026-11-14 VOD DOM and the 2026-11-12 public bundle use new CSS module hashes.
    for (const url of ["/live/test-channel", "/live/test-channel/chat", "/video/123"]) {
        await t.test(url, async (t) => {
            const f = fixture(
                t,
                Array.from({ length: 80 }, (_, i) => row(`updated-${i}`, i % 4 ? "금지" : "허용")).join(""),
                { url, nativeWindow: { updated: true } }
            );
            const visibleIds = () =>
                Array.from(f.native.list.children)
                    .filter((node) => node.hasAttribute("data-chat-id") && !hidden(node))
                    .map((node) => node.getAttribute("data-chat-id"));
            const expected = Array.from({ length: 10 }, (_, i) => `updated-${i * 4}`);
            await waitForCondition(() => visibleIds().join(",") === expected.join(","), { timeoutMs: 4000 });
            assert.deepEqual(visibleIds(), expected);
            assert.ok(f.native.calls.length < 12);
            assert.equal(f.native.messages.length, 80);
            assert.equal(f.native.list.scrollTop, 0);
            assert.equal(f.writes.length, 0);
            f.set({ chatKeywordFilterEnabled: false });
            await waitForCondition(
                () => f.native.limit === 10 && !f.native.list.hasAttribute("data-bcct-hidden-count")
            );
            assert.equal(f.native.list.querySelectorAll(`[${FILTERED}]`).length, 0);
        });
    }
});

test("reading older chat does not force scrolling or a new limit, and disabling while paused restores the budget", async (t) => {
    const f = fixture(t, Array.from({ length: 60 }, (_, i) => row(`pause-${i}`, i % 2 ? "금지" : "허용")).join(""), {
        nativeWindow: true,
    });
    await waitForCondition(
        () => f.native.limit >= 19 && f.native.list.querySelectorAll(`[${FILTERED}]`).length === f.native.limit - 10
    );
    f.native.pause(true);
    f.native.list.scrollTop = -150;
    const calls = f.native.calls.length;
    await waitForCondition(() => f.native.list.querySelectorAll(`[${FILTERED}]`).length === 30);
    assert.equal(f.native.calls.length, calls);
    assert.equal(f.native.list.scrollTop, -150);
    f.set({ chatKeywordFilterEnabled: false });
    await waitForCondition(() => f.native.limit === 10);
    assert.equal(f.native.list.children.length, 61, "paused native backlog stays fully rendered");
    assert.equal(f.native.list.scrollTop, -150);
});

test("native layout restoration survives page lifecycle and a replacement list", async (t) => {
    const html = Array.from({ length: 40 }, (_, i) => row(`restore-${i}`, i % 2 ? "금지" : "허용")).join("");
    const f = fixture(t, html, { nativeWindow: true });
    await waitForCondition(() => f.native.limit >= 19);
    f.dom.window.dispatchEvent(new f.dom.window.Event("pagehide"));
    await waitForCondition(() => f.native.limit === 10);
    assert.equal(f.native.list.hasAttribute("data-bcct-hidden-count"), false);
    f.dom.window.dispatchEvent(new f.dom.window.Event("pageshow"));
    await waitForCondition(() => f.native.limit >= 19);
    const previous = f.native.list;
    f.document.querySelector('[role="log"]').innerHTML = html;
    const replacement = nativeListFixture(f.dom);
    await waitForCondition(() => replacement.limit >= 19);
    assert.equal(previous.hasAttribute("data-bcct-hidden-count"), false);
    f.set({ chatKeywordFilterEnabled: false });
    await waitForCondition(() => replacement.limit === 10);
});

test("native layout reads the current alternate and fractional content height without touching another hook", async (t) => {
    const f = fixture(t, Array.from({ length: 40 }, (_, i) => row(`height-${i}`, "허용")).join(""), {
        nativeWindow: true,
    });
    await waitForCondition(() => f.parseCount > 0);
    const n = f.native;
    n.resize(310.4);
    n.list.style.cssText = "height:334.4px;box-sizing:border-box;padding:10px 0;border:2px solid";
    const staleRoot = { tag: 3, stateNode: n.root.stateNode };
    n.list.__reactFiber$test = { stateNode: n.list, return: staleRoot, alternate: n.host };
    n.host.alternate = n.list.__reactFiber$test;
    n.request(5);
    await Promise.resolve();
    assert.equal(n.limit, 16, "ceil(310.4 / 31) is 11, plus five hidden rows");
    assert.deepEqual(n.calls, [16]);
    n.request(null);
    await Promise.resolve();
    assert.equal(n.limit, 11);
});

test("native list layout provider is packaged in MAIN and the filter remains isolated", () => {
    const entries = JSON.parse(read("manifest.json")).content_scripts;
    assert.equal(entries.find((entry) => entry.js.includes("features/chatTools/listLayoutPage.js"))?.world, "MAIN");
    assert.notEqual(entries.find((entry) => entry.js.includes("features/chatTools.js"))?.world, "MAIN");
});

test("native list ownership stays scoped with many unrelated hooks and provider reinjection", async (t) => {
    const f = fixture(t, Array.from({ length: 30 }, (_, i) => row(`hooks-${i}`, "허용")).join(""), {
        nativeWindow: true,
    });
    await waitForCondition(() => f.parseCount > 0);
    const n = f.native;
    for (let i = 0; i < 200; i++)
        n.owner.memoizedState = { memoizedState: { current: null }, next: n.owner.memoizedState };
    f.dom.window.eval(read("features/chatTools/listLayoutPage.js"));
    n.request(5);
    await Promise.resolve();
    assert.equal(n.limit, 15);
    assert.deepEqual(n.calls, [15], "reinjection does not register a second layout controller");
});

test("native layout bridge rejects ambiguous hooks, stale ownership, unrelated lists and malformed counts", async (t) => {
    for (const scenario of [
        "duplicate-limit",
        "wrong-ref",
        "stale-root",
        "wrong-messages",
        "wrong-route",
        "wrong-list",
        "missing-sentinel",
        "nested-sentinel",
        "wrong-log",
        "invalid-count",
    ]) {
        await t.test(scenario, async (t) => {
            const f = fixture(t, Array.from({ length: 30 }, (_, i) => row(`safe-${i}`, "허용")).join(""), {
                nativeWindow: true,
            });
            await waitForCondition(() => f.parseCount > 0);
            const n = f.native;
            if (scenario === "duplicate-limit")
                n.hooks.splice(1, 0, {
                    memoizedState: 10,
                    queue: {
                        dispatch() {
                            throw new Error("wrong state");
                        },
                    },
                });
            if (scenario === "duplicate-limit") n.hooks.forEach((hook, i) => (hook.next = n.hooks[i + 1] || null));
            if (scenario === "wrong-ref") n.hooks[4].memoizedState.current = f.document.body;
            if (scenario === "stale-root") n.root.stateNode.current = {};
            if (scenario === "wrong-messages") n.hooks[3].memoizedState = [{ key: "other" }];
            if (scenario === "wrong-route") f.dom.window.history.replaceState({}, "", "/lives");
            if (scenario === "wrong-list") n.list.className = "unrelated-list";
            if (scenario === "missing-sentinel") n.list.firstElementChild.remove();
            if (scenario === "nested-sentinel") {
                const wrapper = f.document.createElement("div");
                wrapper.append(n.list.firstElementChild);
                n.list.prepend(wrapper);
            }
            if (scenario === "wrong-log") n.list.parentElement.removeAttribute("role");
            n.request(scenario === "invalid-count" ? "99999" : 20);
            assert.deepEqual(n.calls, []);
        });
    }
});

test("global and per-phrase conditions reapply to live, popup and VOD rows without removing messages", async (t) => {
    for (const url of ["/live/test-channel", "/live/test-channel/chat", "/video/123"]) {
        await t.test(url, async (t) => {
            const f = fixture(
                t,
                row("exact", "금지") +
                    row("long", "금지 문장") +
                    row("abc", "AbC") +
                    row("abc-long", "앞 ABC 뒤") +
                    row("unicode", "가"),
                { url, options: { chatKeywordFilterWords: "금지\nabc\n가", chatKeywordFilterMatchMode: "exact" } }
            );
            const get = (id) => f.document.querySelector(`[data-chat-id="${id}"]`);
            await waitForCondition(() => hidden(get("exact")) && hidden(get("abc")) && hidden(get("unicode")));
            assert.equal(hidden(get("long")), false);
            assert.equal(hidden(get("abc-long")), false);
            f.set({ chatKeywordFilterApplyMode: "individual", chatKeywordFilterExactWords: "금지" });
            await waitForCondition(() => hidden(get("abc-long")));
            assert.equal(hidden(get("long")), false);
            f.set({ chatKeywordFilterExactWords: "abc" });
            await waitForCondition(() => hidden(get("long")) && !hidden(get("abc-long")));
            f.set({ chatKeywordFilterApplyMode: "all", chatKeywordFilterMatchMode: "contains" });
            await waitForCondition(() => hidden(get("abc-long")));
            f.set({ chatKeywordFilterMatchMode: "exact" });
            await waitForCondition(() => !hidden(get("long")) && !hidden(get("abc-long")));
            body(get("exact")).textContent = "금지 이후 다른 본문";
            await waitForCondition(() => !hidden(get("exact")));
            f.set({ chatKeywordFilterEnabled: false });
            await waitForCondition(() => !hidden(get("abc")));
            assert.equal(f.document.querySelectorAll("[data-chat-id]").length, 5);
            assert.equal(f.writes.length, 0);
        });
    }
});

test("keyword filter uses literal body substrings, NFC and case-insensitive phrases, excluding metadata", async (t) => {
    const f = fixture(
        t,
        row("match", "앞부분 금지 뒷부분") +
            row("case", "Hello AbC World") +
            row("unicode", "한글") +
            row("literal", "a.*b") +
            row("safe", "axxxb") +
            row("name", "안녕하세요", "금지") +
            row("time", "반가워요", "시청자", "<time>금지</time>"),
        { options: { chatKeywordFilterWords: "금지\nABC\n한글\na.*b" } }
    );
    const get = (id) => f.document.querySelector(`[data-chat-id="${id}"]`);
    await waitForCondition(
        () => hidden(get("match")) && hidden(get("case")) && hidden(get("unicode")) && hidden(get("literal"))
    );
    for (const id of ["safe", "name", "time"]) assert.equal(hidden(get(id)), false, id);
    assert.equal(f.dom.window.getComputedStyle(get("match")).display, "none");
    assert.equal(get("match").isConnected, true, "hiding does not delete the native row");
    assert.deepEqual(f.writes, [], "filtering does not write chat records or settings");
});

test("reused rows are reparsed after character data, child replacement and identity changes without scanning backlog", async (t) => {
    const f = fixture(
        t,
        row("reuse", "금지") + Array.from({ length: 30 }, (_, index) => row(`old-${index}`, "정상 채팅")).join("")
    );
    const node = f.document.querySelector('[data-chat-id="reuse"]');
    await waitForCondition(() => hidden(node));
    const count = f.parseCount;
    body(node).firstChild.data = "허용된 내용";
    await waitForCondition(() => !hidden(node));
    assert.ok(f.parseCount - count < 5, "one changed row does not reparse the backlog");
    body(node).replaceChildren(f.document.createTextNode("다음 금지 내용"));
    await waitForCondition(() => hidden(node));
    node.setAttribute("data-chat-id", "next-message");
    body(node).textContent = "다른 메시지";
    await waitForCondition(() => !hidden(node));
    assert.notEqual(f.dom.window.getComputedStyle(node).display, "none");
});

test("empty phrases, option edits and OFF immediately restore only extension-owned hiding", async (t) => {
    const f = fixture(t, row("first", "금지") + row("second", "다른말"));
    const first = f.document.querySelector('[data-chat-id="first"]');
    const second = f.document.querySelector('[data-chat-id="second"]');
    first.style.color = "red";
    await waitForCondition(() => hidden(first));
    f.set({ chatKeywordFilterWords: "다른말" });
    await waitForCondition(() => !hidden(first) && hidden(second));
    f.set({ chatKeywordFilterWords: "   \n  " });
    await waitForCondition(() => !hidden(second));
    assert.equal(f.document.getElementById(STYLE), null);
    f.set({ chatKeywordFilterWords: "금지" });
    await waitForCondition(() => hidden(first));
    first.hidden = true;
    f.set({ chatKeywordFilterEnabled: false });
    await waitForCondition(() => !hidden(first));
    assert.equal(first.hidden, true, "native hiding survives turning the feature off");
    assert.equal(first.style.color, "red");
    assert.equal(f.document.getElementById(STYLE), null);
});

test("profile UI is not a message and an expanded profile is left visible until closed", async (t) => {
    const f = fixture(t, row("profile", "정상 채팅"));
    const node = f.document.querySelector('[data-chat-id="profile"]');
    await waitForCondition(() => f.parseCount > 0);
    const button = node.querySelector("button");
    button.setAttribute("aria-expanded", "true");
    const dialog = f.document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.textContent = "금지";
    node.append(dialog);
    f.set({ chatKeywordFilterWords: "금지\n추가" });
    await new Promise((resolve) => setTimeout(resolve, 160)); // A complete chat-sync interval with the profile expanded.
    assert.equal(hidden(node), false);
    dialog.remove();
    button.setAttribute("aria-expanded", "false");
    body(node).textContent = "금지";
    await waitForCondition(() => hidden(node));
    button.setAttribute("aria-expanded", "true");
    await waitForCondition(() => !hidden(node));
});

test("root replacement, row removal and page lifecycle clean and restore filter markers", async (t) => {
    const f = fixture(t, row("old", "금지"));
    const old = f.document.querySelector('[data-chat-id="old"]');
    await waitForCondition(() => hidden(old));
    const root = f.document.querySelector('[role="log"]');
    const replacement = root.cloneNode(false);
    replacement.innerHTML = row("new", "금지");
    root.replaceWith(replacement);
    const current = replacement.firstElementChild;
    await waitForCondition(() => hidden(current));
    assert.equal(hidden(old), false);
    current.remove();
    await waitForCondition(() => !hidden(current));
    replacement.append(current);
    await waitForCondition(() => hidden(current));
    f.dom.window.dispatchEvent(new f.dom.window.Event("pagehide"));
    assert.equal(hidden(current), false);
    f.dom.window.dispatchEvent(new f.dom.window.Event("pageshow"));
    await waitForCondition(() => hidden(current));
});

test("VOD filtering uses only the measured chat log and does not activate live moderator UI or filter comments", async (t) => {
    const f = fixture(t, row("vod-chat", "금지"), {
        url: "/video/123",
        options: { chatToolsModeratorBoxEnabled: true },
        extra: `<section class="comment-list" role="log">${row("comment", "금지")}</section>`,
    });
    const chat = f.document.querySelector('[data-chat-id="vod-chat"]');
    const comment = f.document.querySelector('[data-chat-id="comment"]');
    await waitForCondition(() => hidden(chat));
    assert.equal(hidden(comment), false);
    assert.equal(f.document.querySelector(".bcct-moderator-trigger"), null);
    body(chat).textContent = "다음 시각의 다른 채팅";
    await waitForCondition(() => !hidden(chat));
    f.dom.window.history.pushState({}, "", "/lives");
    body(chat).textContent = "금지";
    await new Promise((resolve) => setTimeout(resolve, 250)); // Non-playback route must not schedule filtering.
    assert.equal(hidden(chat), false);
    f.dom.window.history.pushState({}, "", "/video/124");
    await waitForCondition(() => hidden(chat));
});

test("native live chat popup route also filters and a later SPA live entry starts filtering", async (t) => {
    const f = fixture(t, row("popup", "금지"), { url: "/lives" });
    const node = f.document.querySelector('[data-chat-id="popup"]');
    await waitForCondition(() => !!f.document.getElementById(STYLE));
    assert.equal(hidden(node), false);
    f.dom.window.history.pushState({}, "", "/live/test-channel/chat");
    await waitForCondition(() => hidden(node));
});

test("collection roles stay visible in chat and the panel across keyword modes and collection OFF", async (t) => {
    for (const url of ["/live/test-channel", "/live/test-channel/chat", "/video/123"]) {
        await t.test(url, async (t) => {
            const protectedIds = ["broadcaster", "manager", "partner", "challenger"];
            const f = fixture(
                t,
                row("broadcaster", "금지", "방송자", '<img alt="스트리머" src="https://ssl.pstatic.net/owner.png">') +
                    row(
                        "manager",
                        "금지",
                        "운영자",
                        '<img alt="채팅 운영자" src="https://ssl.pstatic.net/manager.png">'
                    ) +
                    row("partner", "금지", '방문자<i class="_mark_1pcsq_81 _is_partner_1pcsq_81"></i>') +
                    row("challenger", "금지", '방문자<i class="_mark_1pcsq_81 _is_challenger_1pcsq_84"></i>') +
                    row("viewer", "금지", "일반 시청자") +
                    row("prefix", "앞 금지", "일반 시청자") +
                    row("official", "금지", '방문자<i class="_mark_1pcsq_81 _is_official_1pcsq_87"></i>') +
                    row("role-words", "금지 방송자 채팅 운영자 파트너 챌린저", "일반 시청자"),
                { url, options: { chatToolsModeratorBoxEnabled: true } }
            );
            const get = (id) => f.document.querySelector(`[data-chat-id="${id}"]`);
            await waitForCondition(() => hidden(get("prefix")));
            for (const id of protectedIds) assert.equal(hidden(get(id)), false, `${id} is exempt from keyword hiding`);
            for (const id of ["viewer", "official", "role-words"]) assert.equal(hidden(get(id)), true);
            if (url.startsWith("/live/")) {
                await waitForCondition(() => f.document.querySelectorAll(".bcct-moderator-row").length === 4);
            } else {
                assert.equal(f.document.querySelector(".bcct-moderator-trigger"), null);
            }
            f.set({ chatKeywordFilterMatchMode: "exact" });
            await waitForCondition(() => !hidden(get("prefix")));
            for (const id of protectedIds) assert.equal(hidden(get(id)), false);
            assert.equal(hidden(get("viewer")), true);
            f.set({
                chatKeywordFilterApplyMode: "individual",
                chatKeywordFilterExactWords: "",
                chatToolsModeratorBoxEnabled: false,
            });
            await waitForCondition(() => hidden(get("prefix")));
            for (const id of protectedIds) assert.equal(hidden(get(id)), false, "collection OFF keeps the exemption");
            assert.equal(hidden(get("viewer")), true);
            f.set({ chatKeywordFilterExactWords: "금지" });
            await waitForCondition(() => !hidden(get("prefix")));
            for (const id of protectedIds) assert.equal(hidden(get(id)), false);
            assert.equal(hidden(get("viewer")), true);
        });
    }
});

test("a late collection badge restores a hidden row immediately and row reuse does not inherit its exemption", async (t) => {
    const f = fixture(t, row("changing", "금지", "방문자"), { options: { chatToolsModeratorBoxEnabled: true } });
    const node = f.document.querySelector('[data-chat-id="changing"]');
    await waitForCondition(() => hidden(node));
    const author = node.querySelector("button > span");
    author.insertAdjacentHTML("beforeend", '<i class="_mark_1pcsq_81 _is_partner_1pcsq_81"></i>');
    await Promise.resolve();
    assert.equal(hidden(node), false, "the current badge is honored before the next frame");
    await waitForCondition(() => node.hasAttribute("data-bcct-moderator-collected"));
    node.setAttribute("data-chat-id", "next-viewer");
    author.textContent = "일반 시청자";
    await Promise.resolve();
    assert.equal(hidden(node), true, "the previous collection marker cannot exempt a reused viewer row");
    author.insertAdjacentHTML("beforeend", '<i class="_mark_1pcsq_81 _is_challenger_1pcsq_84"></i>');
    await Promise.resolve();
    assert.equal(hidden(node), false);
    author.querySelector("i").className = "_mark_1pcsq_81 _is_official_1pcsq_87";
    await Promise.resolve();
    assert.equal(hidden(node), true, "changing the badge class rechecks the current collection role");
});

test("moderator panel preserves matching messages and record identities when keyword filtering is toggled", async (t) => {
    const badge = '<img alt="채팅 운영자" src="https://ssl.pstatic.net/badge.png">';
    const f = fixture(
        t,
        row("moderator-hidden", "금지", "운영자", badge) + row("moderator-visible", "정상 공지", "운영자", badge),
        { options: { chatToolsModeratorBoxEnabled: true } }
    );
    const panelRows = () => [...f.document.querySelectorAll(".bcct-moderator-row")];
    await waitForCondition(() => panelRows().length === 2);
    const originals = panelRows();
    assert.ok(originals.some((node) => node.textContent.includes("금지")));
    assert.equal(hidden(f.document.querySelector('[data-chat-id="moderator-hidden"]')), false);
    f.set({ chatKeywordFilterEnabled: false });
    await waitForCondition(() => !f.document.getElementById(STYLE));
    assert.deepEqual(panelRows(), originals);
    assert.ok(panelRows().some((node) => node.textContent.includes("금지")));
    f.set({ chatKeywordFilterEnabled: true });
    await waitForCondition(() => Boolean(f.document.getElementById(STYLE)));
    assert.deepEqual(panelRows(), originals);
    assert.ok(panelRows().some((node) => node.textContent.includes("정상 공지")));
});

test("immediate filtering keeps moderator collection deferred and discards parsed text after another mutation", async (t) => {
    const f = fixture(t, row("ready", "금지"), { options: { chatToolsModeratorBoxEnabled: true } });
    await waitForCondition(() => Boolean(f.document.querySelector(".bcct-moderator-trigger")));
    const log = f.document.querySelector('[role="log"]');
    const badge = '<img alt="채팅 운영자" src="https://ssl.pstatic.net/badge.png">';
    log.insertAdjacentHTML(
        "beforeend",
        row("moderator-fast-a", "금지 첫 내용", "운영자", badge) +
            row("moderator-fast-b", "허용 첫 내용", "운영자", badge)
    );
    await Promise.resolve();
    const first = log.querySelector('[data-chat-id="moderator-fast-a"]');
    const second = log.querySelector('[data-chat-id="moderator-fast-b"]');
    assert.equal(hidden(first), false);
    assert.equal(hidden(second), false);
    assert.equal(f.document.querySelectorAll(".bcct-moderator-row").length, 0, "collection still waits for its batch");
    body(first).firstChild.data = "허용 최종 내용";
    body(second).firstChild.data = "금지 최종 내용";
    await Promise.resolve();
    assert.equal(hidden(first), false);
    assert.equal(hidden(second), false);
    await waitForCondition(() => f.document.querySelectorAll(".bcct-moderator-row").length === 2);
    f.set({ chatKeywordFilterEnabled: false });
    await waitForCondition(() => f.document.querySelectorAll(".bcct-moderator-row").length === 2);
    const texts = [...f.document.querySelectorAll(".bcct-moderator-row")].map((node) => node.textContent);
    assert.ok(
        texts.every((text) => text.includes("최종 내용")),
        "the earlier parse is never collected as the final message"
    );
});

test("a collected-role row that leaves before the deferred scan is retained with filtering ON or OFF", async (t) => {
    for (const chatKeywordFilterEnabled of [true, false]) {
        await t.test(String(chatKeywordFilterEnabled), async (t) => {
            const f = fixture(t, row("ready", "허용"), {
                options: { chatToolsModeratorBoxEnabled: true, chatKeywordFilterEnabled },
            });
            await waitForCondition(() => Boolean(f.document.querySelector(".bcct-moderator-trigger")));
            const log = f.document.querySelector('[role="log"]');
            const badge = '<img alt="채팅 운영자" src="https://ssl.pstatic.net/badge.png">';
            log.insertAdjacentHTML("beforeend", row("fleeting", "금지 한 줄", "운영자", badge));
            const fleeting = log.lastElementChild;
            await Promise.resolve();
            assert.equal(hidden(fleeting), false);
            assert.equal(f.document.querySelectorAll(".bcct-moderator-row").length, 0);
            fleeting.remove();
            await Promise.resolve();
            await waitForCondition(() => f.document.querySelectorAll(".bcct-moderator-row").length === 1);
            assert.match(f.document.querySelector(".bcct-moderator-row").textContent, /금지 한 줄/);
            log.append(fleeting);
            await Promise.resolve();
            fleeting.remove();
            await Promise.resolve();
            // The same explicit message leaving twice must not become two records in the next collection batch.
            await new Promise((resolve) => setTimeout(resolve, 180));
            assert.equal(f.document.querySelectorAll(".bcct-moderator-row").length, 1);
        });
    }
});

test("a detached candidate is rejected if its identity, body or role changed before removal delivery", async (t) => {
    const f = fixture(t, row("ready", "허용"), { options: { chatToolsModeratorBoxEnabled: true } });
    await waitForCondition(() => Boolean(f.document.querySelector(".bcct-moderator-trigger")));
    const log = f.document.querySelector('[role="log"]');
    const badge = '<img alt="채팅 운영자" src="https://ssl.pstatic.net/badge.png">';
    for (const kind of ["identity", "body", "role"]) {
        log.insertAdjacentHTML("beforeend", row(`pending-${kind}`, "이전 내용", "이전 작성자", badge));
        const node = log.lastElementChild;
        await Promise.resolve();
        if (kind === "identity") node.setAttribute("data-chat-id", "different-message");
        if (kind === "body") body(node).textContent = "새 내용";
        if (kind === "role") node.querySelector("img").remove();
        node.remove();
        await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(f.document.querySelectorAll(".bcct-moderator-row").length, 0);
});

test("an uncollected id-less candidate survives root replacement and binds once to its redrawn row", async (t) => {
    const f = fixture(t, row("ready", "허용"), { options: { chatToolsModeratorBoxEnabled: true } });
    await waitForCondition(() => Boolean(f.document.querySelector(".bcct-moderator-trigger")));
    const log = f.document.querySelector('[role="log"]');
    const html = row(
        "",
        "금지 원래 메시지",
        "운영자",
        '<img alt="채팅 운영자" src="https://ssl.pstatic.net/badge.png">'
    );
    log.insertAdjacentHTML("beforeend", html);
    await Promise.resolve();
    const next = log.cloneNode(false);
    next.innerHTML = html;
    log.replaceWith(next);
    await waitForCondition(
        () =>
            f.document.querySelectorAll(".bcct-moderator-row").length === 1 &&
            next.firstElementChild.hasAttribute("data-bcct-moderator-collected")
    );
    assert.match(f.document.querySelector(".bcct-moderator-row").textContent, /금지 원래 메시지/);
    assert.equal(log.querySelector("[data-bcct-moderator-collected]"), null);
    next.firstElementChild.remove();
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(f.document.querySelectorAll(".bcct-moderator-row").length, 1);
});

for (const chatKeywordFilterEnabled of [true, false]) {
    for (const chatToolsShowBlindEnabled of [true, false]) {
        test(`native message reappearance stays collected once (filter ${chatKeywordFilterEnabled}, originals ${chatToolsShowBlindEnabled})`, async (t) => {
            const html = row(
                "",
                "같은 내용의 공지",
                "진행담당",
                '<img alt="채팅 운영자" src="https://ssl.pstatic.net/manager.png">'
            );
            const f = fixture(t, html + row("ordinary", "일반 채팅"), {
                options: { chatToolsModeratorBoxEnabled: true, chatKeywordFilterEnabled, chatToolsShowBlindEnabled },
            });
            const log = f.document.querySelector('[role="log"]');
            const attach = (node, key = "original-message") => {
                node.querySelector('[class*="chatting_message"]').__reactProps$collection = {
                    children: {
                        props: {
                            chatMessage: {
                                key,
                                user: "same-author",
                                time: 1794700800000,
                                status: "NORMAL",
                                profile: { nickname: "진행담당", userIdHash: "same-author" },
                            },
                        },
                    },
                };
            };
            const original = log.firstElementChild;
            attach(original);
            f.dom.window.eval(read("features/chatTimestampPage.js"));
            const collected = () => [...f.document.querySelectorAll(".bcct-moderator-row")];
            await waitForCondition(() => collected().length === 1);
            const firstRecord = collected()[0];
            original.remove();
            // Wait past the 120 ms collection batch: this is later window expansion, not a single replacement.
            await new Promise((resolve) => setTimeout(resolve, 180));
            log.insertAdjacentHTML("beforeend", html);
            const returned = log.lastElementChild;
            attach(returned);
            await waitForCondition(() => returned.hasAttribute("data-bcct-moderator-collected"));
            assert.deepEqual(collected(), [firstRecord], "native reappearance keeps the same panel row");
            log.insertAdjacentHTML("beforeend", html);
            attach(log.lastElementChild, "actual-repeat");
            await waitForCondition(() => collected().length === 2);
            assert.equal(collected()[0], firstRecord, "a real repeated message is a separate record");
            assert.equal(log.querySelector("[data-bcct-source-message], [data-bcct-source-original]"), null);
        });
    }
}

test("OFF and route changes discard candidates that have not reached the collection batch", async (t) => {
    for (const cancel of ["option", "route", "pagehide"]) {
        await t.test(cancel, async (t) => {
            const f = fixture(t, row("ready", "허용"), { options: { chatToolsModeratorBoxEnabled: true } });
            await waitForCondition(() => Boolean(f.document.querySelector(".bcct-moderator-trigger")));
            const log = f.document.querySelector('[role="log"]');
            const badge = '<img alt="채팅 운영자" src="https://ssl.pstatic.net/badge.png">';
            log.insertAdjacentHTML("beforeend", row("cancelled", "금지 이전 방송", "운영자", badge));
            await Promise.resolve();
            if (cancel === "option") f.set({ chatToolsModeratorBoxEnabled: false });
            if (cancel === "route") f.dom.window.history.pushState({}, "", "/live/next-channel");
            if (cancel === "pagehide") f.dom.window.dispatchEvent(new f.dom.window.Event("pagehide"));
            log.lastElementChild.remove();
            await Promise.resolve();
            await new Promise((resolve) => setTimeout(resolve, 180));
            assert.equal(f.document.querySelectorAll(".bcct-moderator-row").length, 0);
        });
    }
});

test("blind reveal is filtered using only its validated current original, and missing originals keep the native notice", async (t) => {
    const notice = "클린봇이 부적절한 표현을 감지했습니다.";
    const f = fixture(t, row("blind", notice), { options: { chatToolsShowBlindEnabled: true } });
    const node = f.document.querySelector('[data-chat-id="blind"]');
    const props = {
        chatMessage: {
            key: "blind",
            user: "user-a",
            time: 1730000000000,
            status: "CBOTBLIND",
            originalContent: "금지 원문",
            profile: { userIdHash: "user-a", nickname: "시청자" },
        },
    };
    node.querySelector("._container_w9pvh_1").__reactProps$keywordFilter = { children: { props } };
    f.dom.window.eval(read("features/chatTimestampPage.js"));
    await waitForCondition(() => hidden(node));
    assert.equal(node.querySelector(".bcct-blind-reveal")?.textContent, "금지 원문");
    f.set({ chatKeywordFilterMatchMode: "exact" });
    await waitForCondition(() => !hidden(node));
    assert.equal(node.querySelector(".bcct-blind-reveal")?.textContent, "금지 원문");
    f.set({
        chatKeywordFilterWords: "금지 원문",
        chatKeywordFilterApplyMode: "individual",
        chatKeywordFilterExactWords: "금지 원문",
    });
    await waitForCondition(() => hidden(node));
    props.chatMessage = { ...props.chatMessage, key: "new-blind", originalContent: "" };
    node.setAttribute("data-chat-id", "new-blind");
    await Promise.resolve();
    assert.equal(hidden(node), false, "immediate filtering cannot borrow the previous message's revealed original");
    assert.equal(node.querySelector(".bcct-blind-reveal"), null);
    await waitForCondition(() => !hidden(node) && !node.querySelector(".bcct-blind-reveal"));
    assert.equal(body(node).textContent, notice);
});

test("a validated blind original also honors the current collection-role exemption", async (t) => {
    const notice = "클린봇이 부적절한 표현을 감지했습니다.";
    const f = fixture(
        t,
        row("blind-role", notice, "방문자", '<img alt="채팅 운영자" src="https://ssl.pstatic.net/manager.png">'),
        { options: { chatToolsShowBlindEnabled: true, chatToolsModeratorBoxEnabled: false } }
    );
    const node = f.document.querySelector('[data-chat-id="blind-role"]');
    node.querySelector("._container_w9pvh_1").__reactProps$keywordFilter = {
        children: {
            props: {
                chatMessage: {
                    key: "blind-role",
                    user: "user-role",
                    time: 1730000000000,
                    status: "CBOTBLIND",
                    originalContent: "금지 원문",
                    profile: { userIdHash: "user-role", nickname: "방문자" },
                },
            },
        },
    };
    f.dom.window.eval(read("features/chatTimestampPage.js"));
    await waitForCondition(() => node.querySelector(".bcct-blind-reveal")?.textContent === "금지 원문");
    assert.equal(hidden(node), false);
    node.querySelector('img[alt="채팅 운영자"]').remove();
    await Promise.resolve();
    assert.equal(hidden(node), true, "the same validated original is filtered after the role is removed");
    assert.equal(node.querySelector(".bcct-blind-reveal")?.textContent, "금지 원문");
});

test("Cleanbot OFF filters a coherent visible CBOTBLIND body, but preserves roles and rejects a stale body", async (t) => {
    const f = fixture(t, row("ordinary", "금지 공개") + row("manager", "금지 안내") + row("stale", "금지 이전"));
    for (const [id, userRoleCode, originalContent] of [
        ["ordinary", "common_user", "금지 공개"],
        ["manager", "streaming_chat_manager", "금지 안내"],
        ["stale", "common_user", "다른 메시지"],
    ]) {
        const node = f.document.querySelector(`[data-chat-id="${id}"]`);
        node.querySelector("._container_w9pvh_1").__reactProps$test = {
            children: {
                props: {
                    chatMessage: {
                        key: id,
                        time: 1730000000000,
                        user: id,
                        status: "CBOTBLIND",
                        originalContent,
                        profile: { userIdHash: id, nickname: "시청자", userRoleCode },
                    },
                },
            },
        };
    }
    f.dom.window.eval(read("features/chatTimestampPage.js"));
    await waitForCondition(() => hidden(f.document.querySelector('[data-chat-id="ordinary"]')));
    assert.equal(hidden(f.document.querySelector('[data-chat-id="manager"]')), false);
    assert.equal(hidden(f.document.querySelector('[data-chat-id="stale"]')), false);
    assert.equal(f.document.querySelector(".bcct-blind-reveal"), null);
});

test("restoring a VOD chat tab reparses matching messages received while comments hid the log", async (t) => {
    const f = fixture(t, row("before", "금지"), { url: "/video/123" });
    const log = f.document.querySelector('[role="log"]');
    await waitForCondition(() => hidden(log.firstElementChild));
    log.style.visibility = "hidden";
    log.setAttribute("aria-hidden", "true");
    log.insertAdjacentHTML("beforeend", row("during", "금지 문구") + row("allowed", "허용"));
    await new Promise((resolve) => setTimeout(resolve, 160));
    log.style.removeProperty("visibility");
    log.removeAttribute("aria-hidden");
    await waitForCondition(() => hidden(log.querySelector('[data-chat-id="during"]')));
    assert.equal(hidden(log.firstElementChild), true);
    assert.equal(hidden(log.lastElementChild), false);
});
