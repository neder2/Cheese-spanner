const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { evalRepoScript } = require("./helpers/extension-page-fixture.js");

function fixture(t, { oneCard = false, summaryOnly = false, maliciousText = false } = {}) {
    const dom = new JSDOM(
        '<body><button id="opener">안내 열기</button><button id="elsewhere">다른 버튼</button><aside id="panel"><button data-bcpr-handle="chat"></button></aside></body>',
        { url: "https://chzzk.naver.com/live/test", runScripts: "outside-only", pretendToBeVisual: true }
    );
    const win = dom.window,
        doc = win.document,
        frames = new Map();
    let frameId = 0,
        closes = 0;
    win.requestAnimationFrame = (fn) => {
        frames.set(++frameId, fn);
        return frameId;
    };
    win.cancelAnimationFrame = (id) => frames.delete(id);
    evalRepoScript(dom, "shared/updateGuide.js");
    evalRepoScript(dom, "shared/updateGuideView.js");
    const guide = structuredClone(win.BetterChzzkUpdateGuide.getGuide("1.4.1"));
    if (oneCard) guide.cards = guide.cards.slice(0, 1);
    if (summaryOnly) guide.cards = [];
    if (maliciousText) {
        guide.cards[0].title = '<img src="bad" onerror="alert(1)">';
        guide.cards[0].instructions = ["<script>bad()</script>"];
    }
    const view = win.BetterChzzkUpdateGuideView.create({ document: doc, guide, onClose: () => closes++ });
    const opener = doc.getElementById("opener");
    opener.focus();
    t.after(() => {
        view.destroy();
        win.close();
    });
    const flush = async () => {
        await new Promise((resolve) => setImmediate(resolve));
    };
    return { win, doc, view, opener, guide, frames, flush, closes: () => closes };
}

test("one nonmodal window shows both features safely with one close control and focus return", async (t) => {
    const f = fixture(t, { maliciousText: true });
    assert.equal(f.view.open(), true);
    await f.flush();
    const root = f.doc.querySelector("[data-bcug-view]");
    assert.equal(root.getAttribute("aria-modal"), "false");
    assert.equal(root.querySelectorAll("li").length, 2);
    assert.equal(root.querySelector("h3").textContent, '<img src="bad" onerror="alert(1)">');
    assert.equal(root.querySelector("li p").textContent, "<script>bad()</script>");
    assert.equal(root.querySelector("img, script"), null);
    assert.match(root.textContent, /시청기록 백업 및 불러오기/);
    assert.equal(f.doc.activeElement, root.querySelector("h2"));
    assert.equal(root.querySelectorAll("button").length, 1);
    assert.equal(root.querySelector("button").getAttribute("aria-label"), "닫기");
    assert.equal(
        root.querySelector(
            '[data-bcug-action="previous"],[data-bcug-action="next"],[data-bcug-action="settings"],[data-bcug-action="complete"]'
        ),
        null
    );
    root.querySelector("button").click();
    assert.equal(f.doc.querySelector("[data-bcug-view]"), null);
    assert.equal(f.doc.activeElement, f.opener);
    assert.equal(f.closes(), 1);
});

test("Escape is scoped to guide focus and manually moved focus is never stolen", (t) => {
    const f = fixture(t);
    f.view.open();
    const elsewhere = f.doc.getElementById("elsewhere");
    elsewhere.focus();
    elsewhere.dispatchEvent(new f.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.ok(f.doc.querySelector("[data-bcug-view]"));
    f.view.close();
    assert.equal(f.doc.activeElement, elsewhere);
    f.view.open();
    f.doc.activeElement.dispatchEvent(new f.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(f.doc.querySelector("[data-bcug-view]"), null);
});

test("window and tab switches keep the same manual notice without restoring its focus", (t) => {
    const f = fixture(t);
    f.view.open();
    const root = f.doc.querySelector("[data-bcug-view]");
    const elsewhere = f.doc.getElementById("elsewhere");
    elsewhere.focus();
    f.win.dispatchEvent(new f.win.Event("blur"));
    Object.defineProperty(f.doc, "visibilityState", { configurable: true, value: "hidden" });
    f.doc.dispatchEvent(new f.win.Event("visibilitychange"));
    assert.equal(f.doc.querySelector("[data-bcug-view]"), root);
    assert.equal(f.closes(), 0);
    Object.defineProperty(f.doc, "visibilityState", { configurable: true, value: "visible" });
    f.doc.dispatchEvent(new f.win.Event("visibilitychange"));
    f.win.dispatchEvent(new f.win.Event("focus"));
    assert.equal(f.doc.querySelector("[data-bcug-view]"), root);
    assert.equal(f.doc.activeElement, elsewhere);
    f.view.close();
    assert.equal(f.doc.activeElement, elsewhere);
    assert.equal(f.closes(), 1);
});

test("two brief introductions are visible together without stream information or repeated explanations", (t) => {
    const f = fixture(t);
    f.view.open();
    const root = f.doc.querySelector("[data-bcug-view]");
    assert.deepEqual(
        [...root.querySelectorAll("h3")].map((node) => node.textContent),
        ["채팅창·사이드바 크기 조절", "시청기록 백업 및 불러오기"]
    );
    assert.deepEqual(
        [...root.querySelectorAll("li p")].map((node) => node.textContent),
        ["경계 드래그로 조절, 더블클릭으로 초기화."]
    );
    assert.equal(root.querySelectorAll("li")[1].textContent, "시청기록 백업 및 불러오기");
    assert.equal(root.querySelectorAll("li")[1].querySelector("p"), null);
    assert.doesNotMatch(root.textContent, /스트림|1 \/ 2|이전|다음|설정 보기|초록색|JSON|살펴보세요/);
    assert.equal(root.querySelectorAll("button").length, 1);
});

test("page target replacement and hiding do not add overlays, navigate or rebuild the notice", async (t) => {
    const f = fixture(t);
    f.view.open();
    const root = f.doc.querySelector("[data-bcug-view]");
    const firstItem = root.querySelector("li");
    const panel = f.doc.getElementById("panel");
    panel.hidden = true;
    panel.replaceChildren(f.doc.createElement("input"));
    panel.remove();
    f.win.dispatchEvent(new f.win.Event("resize"));
    f.win.dispatchEvent(new f.win.Event("scroll"));
    await f.flush();
    assert.equal(root.querySelector("li"), firstItem);
    assert.equal(f.doc.querySelector("[data-bcug-highlight],[data-bcug-location]"), null);
    assert.equal(f.frames.size, 0);
    assert.equal(f.doc.activeElement, root.querySelector("h2"));
});

test("one-item notice keeps only close and destroys its UI on fullscreen", async (t) => {
    const f = fixture(t, { oneCard: true });
    f.view.open();
    await f.flush();
    const root = f.doc.querySelector("[data-bcug-view]");
    assert.equal(root.querySelectorAll("li").length, 1);
    assert.equal(root.querySelectorAll("button").length, 1);
    Object.defineProperty(f.doc, "fullscreenElement", { configurable: true, value: f.doc.body });
    f.doc.dispatchEvent(new f.win.Event("fullscreenchange"));
    assert.equal(f.doc.querySelector("[data-bcug-view]"), null);
    assert.equal(f.frames.size, 0);
});

test("repeated open and destroy leave no duplicate UI or late visibility restoration", (t) => {
    const f = fixture(t);
    assert.equal(f.view.open(), true);
    assert.equal(f.view.open(), false);
    assert.equal(f.doc.querySelectorAll("[data-bcug-view]").length, 1);
    f.view.destroy();
    f.view.destroy();
    f.doc.dispatchEvent(new f.win.Event("visibilitychange"));
    assert.equal(f.view.open(), false);
    assert.equal(f.doc.querySelector("[data-bcug-view]"), null);
    assert.equal(f.closes(), 1);
    assert.equal(f.frames.size, 0);
});

test("summary-only releases show their authored summary without invented items or extra controls", (t) => {
    const f = fixture(t, { summaryOnly: true });
    f.view.open();
    const root = f.doc.querySelector("[data-bcug-view]");
    assert.ok(root.textContent.includes(f.guide.summary));
    assert.equal(root.querySelector("li"), null);
    assert.equal(root.querySelectorAll("button").length, 1);
    root.querySelector("button").click();
    assert.equal(f.doc.querySelector("[data-bcug-view]"), null);
});
