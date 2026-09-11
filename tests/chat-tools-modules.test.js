const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repoRoot = path.join(__dirname, "..");

function createModules(t, rows = "") {
    const dom = new JSDOM(
        `<aside class="live_chatting_area"><header class="chat-header"><strong>채팅</strong><button aria-label="더보기">⋮</button></header><div class="chat-list" role="log">${rows}</div></aside>`,
        { url: "https://chzzk.naver.com/live/test-channel", runScripts: "outside-only", pretendToBeVisual: true }
    );
    const cleanup = [];
    t.after(() => {
        for (const dispose of cleanup) dispose();
        dom.window.close();
    });
    for (const filename of [
        "shared/settings.js",
        "shared/data.js",
        "content.js",
        "features/chatTools/parser.js",
        "features/chatTools/messageStore.js",
        "features/chatTools/panel.js",
    ]) {
        dom.window.eval(fs.readFileSync(path.join(repoRoot, filename), "utf8"));
    }
    const pending = new Map();
    let nextTimer = 1;
    dom.window.setTimeout = (callback) => {
        const id = nextTimer++;
        pending.set(id, callback);
        return id;
    };
    dom.window.clearTimeout = (id) => pending.delete(id);
    const namespace = dom.window.BetterChzzk.chatTools;
    const root = dom.window.document.querySelector(".chat-list");
    const published = [];
    const store = namespace.createMessageStore({ onChange: (messages) => published.push(messages) });
    store.adoptRoot(root);
    cleanup.push(() => store.resetRoot());
    return {
        dom,
        namespace,
        root,
        store,
        published,
        pending,
        cleanup,
        collect(row) {
            store.noteMutation(row);
            store.collect(store.parseChatMessage(row));
        },
        nextPass() {
            const callbacks = Array.from(pending.values());
            pending.clear();
            for (const callback of callbacks) callback();
        },
        snapshot() {
            return published[published.length - 1] || [];
        },
    };
}

function moderatorRow({ id = "", index = "", author = "운영자", text = "안내" } = {}) {
    return `<div class="chat-row" ${id ? `data-chat-id="${id}"` : ""} ${index ? `data-virtual-index="${index}"` : ""}><span class="badge" aria-label="매니저"></span><span class="nickname">${author}</span><span class="message">${text}</span></div>`;
}

test("the stateless parser reads current DOM without collecting, adding markers, or assigning an identity", (t) => {
    const h = createModules(t, moderatorRow({ author: "첫 작성자", text: "첫 본문" }));
    const row = h.root.firstElementChild;
    const initialMarkup = row.outerHTML;
    const first = h.namespace.parser.parseChatRow(row);
    assert.equal(first.author, "첫 작성자");
    assert.equal(first.text, "첫 본문");
    assert.equal(first.role, "manager");
    assert.equal(first.id, undefined);
    assert.equal(row.outerHTML, initialMarkup);
    assert.equal(h.published.length, 0);

    row.querySelector(".nickname").textContent = "다음 작성자";
    row.querySelector(".message").textContent = "다음 본문";
    row.querySelector(".badge").remove();
    const second = h.namespace.parser.parseChatRow(row);
    assert.equal(second.author, "다음 작성자");
    assert.equal(second.text, "다음 본문");
    assert.equal(second.role, "");
    assert.equal(first.author, "첫 작성자");
});

test("message snapshots isolate collection ownership and acknowledge only existing unread messages", (t) => {
    const h = createModules(t, moderatorRow({ id: "first" }));
    const row = h.root.firstElementChild;
    h.collect(row);
    const message = h.snapshot()[0];
    assert.equal(Object.hasOwn(message, "node"), false);
    assert.equal(Object.hasOwn(message, "sourceIdentityKey"), false);
    assert.equal(Object.isFrozen(message), true);
    assert.equal(Object.isFrozen(message.badges), true);
    assert.equal(Reflect.set(message, "text", "외부 변경"), false);
    const count = h.published.length;
    h.store.markRead(["missing-id"]);
    assert.equal(h.published.length, count);
    h.store.markRead([message.id]);
    assert.equal(h.snapshot()[0].unread, false);
    assert.equal(message.unread, true);
    assert.equal(h.snapshot()[0].recordId, message.recordId);
    h.store.markRead([message.id]);
    assert.equal(h.published.length, count + 1);

    let scrolls = 0;
    row.scrollIntoView = () => scrolls++;
    h.store.navigate(message.id, message.recordId);
    assert.equal(scrolls, 1);
    row.querySelector(".nickname").textContent = "재사용된 작성자";
    h.store.navigate(message.id, message.recordId);
    assert.equal(scrolls, 1);
    h.store.clear();
    h.collect(row);
    const replacement = h.snapshot()[0];
    assert.equal(replacement.id, message.id);
    assert.notEqual(replacement.recordId, message.recordId);
    h.store.navigate(message.id, message.recordId);
    assert.equal(scrolls, 1);
    h.store.navigate(replacement.id, replacement.recordId);
    assert.equal(scrolls, 2);
});

test("capacity eviction retains native row ownership without reviving old messages on a later mutation", (t) => {
    const h = createModules(t, moderatorRow({ id: "old" }) + moderatorRow({ id: "new", text: "최근 안내" }));
    h.store.configure({ enabled: true, maximum: 1 });
    const [oldRow, newRow] = h.root.children;
    h.collect(oldRow);
    h.collect(newRow);
    assert.deepEqual(
        Array.from(h.snapshot(), (message) => message.text),
        ["최근 안내"]
    );
    assert.equal(h.store.hasBinding(oldRow), true);
    assert.equal(oldRow.getAttribute("data-bcct-moderator-highlight"), "1");
    oldRow.querySelector(".nickname").style.color = "rgb(1, 2, 3)";
    h.collect(oldRow);
    h.store.finishScan(true);
    assert.deepEqual(
        Array.from(h.snapshot(), (message) => message.text),
        ["최근 안내"]
    );
});

test("reuse candidates restart on mutation revisions and cancel at reset before queued callbacks can publish", (t) => {
    const h = createModules(t, moderatorRow({ index: "1" }));
    const row = h.root.firstElementChild;
    h.collect(row);
    row.setAttribute("data-virtual-index", "2");
    row.querySelector(".nickname").textContent = "다음 운영자";
    h.collect(row);
    h.nextPass();
    assert.equal(h.snapshot().length, 1);
    row.querySelector(".message").textContent = "최종 안내";
    h.store.noteMutation(row);
    h.nextPass();
    assert.equal(h.snapshot().length, 1);
    h.nextPass();
    assert.equal(h.snapshot().length, 1);
    h.nextPass();
    assert.deepEqual(
        Array.from(h.snapshot(), (message) => message.text),
        ["안내", "최종 안내"]
    );

    row.setAttribute("data-virtual-index", "3");
    h.collect(row);
    const staleCallbacks = Array.from(h.pending.values());
    assert.equal(staleCallbacks.length, 1);
    h.store.resetRoot();
    h.store.clear();
    for (const callback of staleCallbacks) callback();
    assert.equal(h.pending.size, 0);
    assert.equal(h.snapshot().length, 0);
    assert.equal(row.hasAttribute("data-bcct-moderator-collected"), false);
    assert.equal(row.hasAttribute("data-bcct-moderator-highlight"), false);
});

test("an empty root remount preserves id-less records and read state only through its first hydration", (t) => {
    const h = createModules(t, moderatorRow());
    h.collect(h.root.firstElementChild);
    const first = h.snapshot()[0];
    h.store.markRead([first.id]);
    const nextRoot = h.root.cloneNode(false);
    h.root.replaceWith(nextRoot);
    h.store.adoptRoot(nextRoot);
    h.store.finishScan(false);
    nextRoot.innerHTML = moderatorRow();
    h.collect(nextRoot.firstElementChild);
    h.store.finishScan(true);
    assert.equal(h.snapshot().length, 1);
    assert.equal(h.snapshot()[0].id, first.id);
    assert.equal(h.snapshot()[0].recordId, first.recordId);
    assert.equal(h.snapshot()[0].unread, false);
    nextRoot.insertAdjacentHTML("beforeend", moderatorRow());
    h.collect(nextRoot.lastElementChild);
    assert.equal(h.snapshot().length, 2);
    assert.notEqual(h.snapshot()[1].id, first.id);
    assert.equal(h.snapshot()[1].unread, true);
});

test("subtree replacement transfers collection ownership but drops an original-text cache from the removed DOM", (t) => {
    const h = createModules(t, moderatorRow());
    const oldRow = h.root.firstElementChild;
    const parsed = h.store.parseChatMessage(oldRow);
    h.store.cacheOriginal(oldRow, parsed);
    h.collect(oldRow);
    const first = h.snapshot()[0];
    h.store.markRead([first.id]);
    assert.equal(h.store.originalText(oldRow, parsed), "안내");

    const nextRow = oldRow.cloneNode(true);
    oldRow.replaceWith(nextRow);
    h.store.removeSubtrees([oldRow], [nextRow]);
    assert.equal(h.store.originalText(oldRow, parsed), "");
    assert.equal(h.store.hasBinding(oldRow), false);
    h.collect(nextRow);
    h.store.finishScan(true);
    assert.equal(h.snapshot().length, 1);
    assert.equal(h.snapshot()[0].recordId, first.recordId);
    assert.equal(h.snapshot()[0].unread, false);
    assert.equal(h.store.hasBinding(nextRow), true);
});

test("panel snapshots preserve text nodes on backfill and replace a new record even if the native ID repeats", (t) => {
    const h = createModules(t);
    const navigations = [];
    const panel = h.namespace.createPanel({
        onNavigate: (...args) => navigations.push(args),
        onRead: () => {},
        onRequestSync: () => {},
    });
    h.cleanup.push(() => panel.remove());
    panel.mount(h.root);
    const first = {
        id: "data-chat-id:reused",
        recordId: 1,
        author: "처음 작성자",
        role: "manager",
        text: "처음 본문",
        badges: [],
        authorColor: "",
        timestamp: "",
        unread: true,
    };
    panel.render([first]);
    const oldRow = h.dom.window.document.querySelector(".bcct-moderator-row");
    const oldText = oldRow.querySelector(".bcct-moderator-row__text").firstChild;
    panel.render([{ ...first, unread: false, authorColor: "rgb(1, 2, 3)" }]);
    assert.equal(h.dom.window.document.querySelector(".bcct-moderator-row"), oldRow);
    assert.equal(oldRow.querySelector(".bcct-moderator-row__text").firstChild, oldText);
    panel.render([{ ...first, recordId: 2, author: "새 작성자", text: "새 본문" }]);
    const nextRow = h.dom.window.document.querySelector(".bcct-moderator-row");
    assert.notEqual(nextRow, oldRow);
    assert.equal(nextRow.querySelector(".bcct-moderator-row__author").textContent, "새 작성자");
    assert.equal(nextRow.querySelector(".bcct-moderator-row__text").textContent, "새 본문");
    oldRow.click();
    nextRow.click();
    assert.deepEqual(navigations, [
        [first.id, 1],
        [first.id, 2],
    ]);
    assert.equal(first.unread, true);
});
