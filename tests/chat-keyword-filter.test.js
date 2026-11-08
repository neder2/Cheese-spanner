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

function fixture(t, rows, { url = "/live/test-channel", options = {}, extra = "" } = {}) {
    const vod = url.startsWith("/video/");
    const dom = new JSDOM(
        `<!doctype html><body>${extra}<aside id="${vod ? "vod-aside" : "aside-chatting"}" class="live_chatting_area"><div class="chat-header"><strong>채팅</strong><button class="chat-more" type="button" aria-label="더보기">⋮</button></div><div class="chat-list" role="log">${rows}</div></aside></body>`,
        { url: `https://chzzk.naver.com${url}`, runScripts: "outside-only", pretendToBeVisual: true }
    );
    const listeners = [];
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
    for (const name of [
        "shared/settings.js",
        "shared/data.js",
        "content.js",
        "shared/uiTheme.js",
        "features/chatTools/parser.js",
        "features/chatTools/messageStore.js",
        "features/chatTools/panel.js",
        "features/chatTools.js",
        "features/routeBridgePage.js",
    ]) {
        dom.window.eval(read(name));
        if (name === "features/chatTools/parser.js") {
            const namespace = dom.window.CheeseSpanner.chatTools;
            const parser = namespace.parser;
            namespace.parser = {
                ...parser,
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
        get parseCount() {
            return parseCount;
        },
    };
}

const hidden = (node) => node.hasAttribute(FILTERED);
const body = (node) => node.querySelector("._text_w9pvh_1");

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

test("moderator panel hides matching text without deleting collected history and restores it on OFF", async (t) => {
    const badge = '<img alt="채팅 운영자" src="https://ssl.pstatic.net/badge.png">';
    const f = fixture(
        t,
        row("moderator-hidden", "금지", "운영자", badge) + row("moderator-visible", "정상 공지", "운영자", badge),
        { options: { chatToolsModeratorBoxEnabled: true } }
    );
    const panelRows = () => [...f.document.querySelectorAll(".bcct-moderator-row")];
    await waitForCondition(() => panelRows().length === 1);
    assert.match(panelRows()[0].textContent, /정상 공지/);
    f.set({ chatKeywordFilterEnabled: false });
    await waitForCondition(() => panelRows().length === 2);
    assert.ok(panelRows().some((node) => node.textContent.includes("금지")));
    f.set({ chatKeywordFilterEnabled: true });
    await waitForCondition(() => panelRows().length === 1);
    assert.match(panelRows()[0].textContent, /정상 공지/);
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
    await waitForCondition(() => !hidden(node) && !node.querySelector(".bcct-blind-reveal"));
    assert.equal(body(node).textContent, notice);
});
