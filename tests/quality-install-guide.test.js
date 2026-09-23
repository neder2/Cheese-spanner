const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, pathname = "/live/measured") {
    const dom = new JSDOM("<!doctype html><body></body>", {
        url: `https://chzzk.naver.com${pathname}`,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    w.HTMLButtonElement.prototype.getBoundingClientRect = () => ({ width: 180, height: 40 });
    const active = new Set();
    const NativeObserver = w.MutationObserver;
    w.MutationObserver = class extends NativeObserver {
        observe(...args) {
            active.add(this);
            return super.observe(...args);
        }
        disconnect() {
            active.delete(this);
            super.disconnect();
        }
    };
    const optionReceivers = new Set();
    w.BetterChzzkSettings = {
        normalizeOptions: () => ({ adblockPopupEnabled: false }),
        getOptions(callback) {
            optionReceivers.add(callback);
        },
        addOptionsChangeListener() {
            return () => {};
        },
    };
    const options = (overrides = {}) => {
        for (const receive of optionReceivers)
            receive({
                autoQualityEnabled: true,
                adblockPopupEnabled: true,
                ...overrides,
            });
    };
    const route = (pathname) => {
        w.history.pushState({}, "", pathname);
        w.dispatchEvent(new w.Event("betterchzzk:routechange"));
    };
    w.eval(read("content.js"));
    w.eval(read("features/qualityInstallGuide.js"));
    const guide = ({ remove = true, onDecline = () => {} } = {}) => {
        const parent = w.document.createElement("div");
        parent.className = "_player_jwedy_23";
        parent.innerHTML = `<div class="_dimmed_10lql_28"><div class="_layer_10lql_38">
            <p>고화질 시청을 위해서는<br>네이버 라이브 스트리밍 커넥터가 필요합니다.</p>
            <div class="_button_10lql_70"><button type="button">설치하고 고화질 시청</button></div>
            <div class="_button_10lql_70"><button type="button">설치없이 일반 화질 시청</button></div>
        </div></div>`;
        const root = parent.firstElementChild;
        const layer = root.firstElementChild;
        const [install, decline] = parent.querySelectorAll("button");
        root.getBoundingClientRect = () => ({ width: 1280, height: 720 });
        const calls = { decline: 0, install: 0 };
        install.addEventListener("click", () => calls.install++);
        decline.addEventListener("click", () => {
            calls.decline++;
            onDecline();
            if (remove) root.remove();
        });
        return { parent, root, layer, install, decline, calls, mount: () => w.document.body.append(parent) };
    };
    t.after(() => {
        options({ adblockPopupEnabled: false });
        dom.window.close();
    });
    return {
        w,
        guide,
        options,
        route,
        active,
        state: () => JSON.parse(w.document.documentElement.getAttribute("data-betterchzzk-auto-quality-guide")),
    };
}

test("native decline initializes the player and also closes the next quality guide", async (t) => {
    const f = fixture(t);
    const first = f.guide({ onDecline: () => f.w.document.body.append(f.w.document.createElement("video")) });
    first.mount();
    await flush();
    assert.equal(first.calls.decline, 0, "saved options must load before clicking");
    assert.equal(f.w.document.querySelector("video"), null);
    f.options();
    await flush();
    assert.equal(first.calls.decline, 1);
    assert.equal(first.calls.install, 0);
    assert.ok(f.w.document.querySelector("video"), "the native handler creates the player");
    assert.equal(first.root.isConnected, false);
    const second = f.guide();
    second.mount();
    await flush();
    assert.equal(second.calls.decline, 1);
    assert.equal(second.calls.install, 0);
    assert.deepEqual(f.state(), { enabled: true, attempts: 2 });
    assert.equal(f.active.size, 1, "closed guides release their scoped observers");
});

test("one popup option controls both the adblock notice and connector guide without auto quality", async (t) => {
    const f = fixture(t);
    const ad = f.w.document.createElement("div");
    ad.setAttribute("role", "alertdialog");
    ad.setAttribute("aria-modal", "true");
    ad.innerHTML = '광고 차단 프로그램을 사용 중이신가요?<button aria-label="닫기">닫기</button>';
    ad.querySelector("button").addEventListener("click", () => ad.remove());
    ad.getBoundingClientRect = () => ({ width: 400, height: 200 });
    f.w.document.body.append(ad);
    const first = f.guide();
    first.mount();
    f.w.eval(read("features/adblockPopup.js"));
    f.options({ adblockPopupEnabled: false, autoQualityEnabled: false });
    await flush();
    assert.equal(first.calls.decline, 0);
    assert.equal(ad.hasAttribute("data-betterchzzk-suppress-adblock-popup"), false);
    f.options({ adblockPopupEnabled: true, autoQualityEnabled: false });
    await flush();
    assert.equal(first.calls.decline, 1);
    assert.equal(ad.isConnected, false);
    f.options({ adblockPopupEnabled: false, autoQualityEnabled: false });
    const next = f.guide();
    next.mount();
    await flush();
    assert.equal(next.calls.decline, 0);
    assert.equal(ad.hasAttribute("data-betterchzzk-suppress-adblock-popup"), false);
});

test("the unified popup setting gates guides independently of auto quality and cleans up on disable", async (t) => {
    const f = fixture(t);
    const g = f.guide();
    g.mount();
    for (const disabled of [
        { adblockPopupEnabled: false, autoQualityEnabled: true, autoQualityDismissInstallGuide: true },
        { adblockPopupEnabled: false, autoQualityEnabled: false, autoQualityDismissInstallGuide: false },
    ]) {
        f.options(disabled);
        g.layer.querySelector("p").append(" ");
        await flush();
        assert.equal(g.calls.decline, 0);
        assert.equal(f.active.size, 0);
        assert.equal(f.state().enabled, false);
    }
    f.options({ autoQualityEnabled: false, autoQualityDismissInstallGuide: false });
    await flush();
    assert.equal(g.calls.decline, 1);
    const next = f.guide({ remove: false });
    next.decline.disabled = true;
    next.mount();
    await flush();
    f.options({ adblockPopupEnabled: false });
    next.decline.disabled = false;
    await flush();
    assert.equal(next.calls.decline, 0);
    assert.equal(f.active.size, 0);
    f.options();
    await flush();
    assert.equal(next.calls.decline, 1);
});

test("hidden and disabled guides wait for a visible enabled native button", async (t) => {
    const f = fixture(t);
    const g = f.guide();
    g.root.hidden = true;
    g.parent.style.display = "none";
    g.decline.disabled = true;
    g.decline.setAttribute("aria-disabled", "true");
    g.mount();
    f.options();
    await flush();
    assert.equal(g.calls.decline, 0);
    g.root.hidden = false;
    g.parent.style.display = "";
    await flush();
    assert.equal(g.calls.decline, 0);
    g.decline.disabled = false;
    await flush();
    assert.equal(g.calls.decline, 0);
    g.decline.removeAttribute("aria-disabled");
    await flush();
    assert.equal(g.calls.decline, 1);
});

test("unrelated, ambiguous and incomplete dialogs remain untouched", async (t) => {
    const f = fixture(t);
    f.options();
    for (const change of [
        (g) => {
            g.layer.querySelector("p").textContent = "다른 프로그램 설치 안내";
        },
        (g) => {
            g.install.textContent = "설정 변경";
        },
        (g) => {
            g.layer.append(g.decline.cloneNode(true));
        },
        (g) => {
            g.layer.append(f.w.document.createElement("button"));
        },
        (g) => {
            g.root.append(g.layer.cloneNode(true));
        },
        (g) => {
            g.parent.className = "_chat_measured";
        },
        (g) => {
            g.root.className = "betterchzzk-update-notice";
        },
    ]) {
        const g = f.guide();
        change(g);
        g.mount();
        await flush();
        assert.deepEqual(g.calls, { decline: 0, install: 0 });
        assert.ok(g.root.isConnected);
        g.parent.remove();
        await flush();
    }
    assert.equal(f.state().attempts, 0);
});

test("a reused guide is checked again when its content becomes the measured installation guide", async (t) => {
    const f = fixture(t);
    const g = f.guide();
    const message = g.layer.querySelector("p");
    const text = message.textContent;
    message.textContent = "다른 안내";
    g.mount();
    f.options();
    await flush();
    assert.equal(g.calls.decline, 0);
    message.firstChild.data = text;
    await flush();
    assert.equal(g.calls.decline, 1);
});

test("ignored clicks remain visible without retries during chat mutations", async (t) => {
    const f = fixture(t);
    const g = f.guide({ remove: false });
    g.mount();
    f.options();
    await flush();
    let fullScans = 0;
    const bodyQuery = f.w.document.body.querySelectorAll.bind(f.w.document.body);
    f.w.document.body.querySelectorAll = (...args) => {
        fullScans++;
        return bodyQuery(...args);
    };
    for (let index = 0; index < 30; index++) {
        const chat = f.w.document.createElement("div");
        chat.textContent = `chat ${index}`;
        f.w.document.body.append(chat);
        g.layer.classList.toggle("measured-visible");
        await flush();
    }
    assert.equal(g.calls.decline, 1);
    assert.ok(g.root.isConnected);
    assert.equal(g.root.hidden, false);
    assert.equal(g.root.style.display, "");
    assert.equal(fullScans, 0, "chat updates do not rescan the full document");
});

test("a failed native action is not hidden or repeated", async (t) => {
    const f = fixture(t);
    const g = f.guide();
    let attempts = 0;
    g.decline.click = () => {
        attempts++;
        throw new Error("native action unavailable");
    };
    g.mount();
    f.options();
    await flush();
    g.layer.querySelector("p").append(" ");
    await flush();
    assert.equal(attempts, 1);
    assert.ok(g.root.isConnected);
    assert.equal(g.root.style.display, "");
});

test("reopened and reinserted native guide nodes can be dismissed again", async (t) => {
    const f = fixture(t);
    const g = f.guide({ remove: false });
    g.mount();
    f.options();
    await flush();
    g.root.hidden = true;
    await flush();
    g.root.hidden = false;
    await flush();
    assert.equal(g.calls.decline, 2);
    g.parent.remove();
    g.mount();
    await flush();
    assert.equal(g.calls.decline, 3, "same DOM objects can belong to a new guide mount");
    const replacement = g.decline.cloneNode(true);
    let replacementCalls = 0;
    replacement.addEventListener("click", () => replacementCalls++);
    g.decline.replaceWith(replacement);
    await flush();
    assert.equal(replacementCalls, 1);
    assert.equal(g.calls.decline, 3);
});

test("SPA transitions stop observation outside main live pages and bind the next live guide", async (t) => {
    const f = fixture(t, "/video/123");
    const g = f.guide();
    g.mount();
    f.options();
    await flush();
    assert.equal(g.calls.decline, 0);
    assert.equal(f.active.size, 0);
    f.route("/live/measured-a");
    await flush();
    assert.equal(g.calls.decline, 1);
    f.route("/live/measured-a/chat");
    const next = f.guide();
    next.mount();
    await flush();
    assert.equal(next.calls.decline, 0);
    assert.equal(f.active.size, 0);
    f.route("/live/measured-b");
    await flush();
    assert.equal(next.calls.decline, 1);
    f.route("/");
    assert.equal(f.active.size, 0);
});

test("document-start waits for the body and closes a later mounted guide", async (t) => {
    const f = fixture(t);
    const body = f.w.document.body;
    body.remove();
    f.options();
    await flush();
    f.w.document.documentElement.append(body);
    const g = f.guide();
    g.mount();
    await flush();
    assert.equal(g.calls.decline, 1);
    assert.equal(f.active.size, 1);
});

for (const [name, hide] of Object.entries({
    hidden: (el, hidden) => {
        el.hidden = hidden;
    },
    aria: (el, hidden) => {
        el.setAttribute("aria-hidden", String(hidden));
    },
    display: (el, hidden) => {
        el.style.display = hidden ? "none" : "";
    },
    visibility: (el, hidden) => {
        el.style.visibility = hidden ? "hidden" : "";
    },
})) {
    test(`guide observes distant ancestor ${name} changes and batched display cycles`, async (t) => {
        const f = fixture(t);
        const g = f.guide({ remove: false });
        const ancestor = f.w.document.createElement("section");
        ancestor.append(g.parent);
        hide(ancestor, true);
        f.w.document.body.append(ancestor);
        f.options();
        await flush();
        assert.equal(g.calls.decline, 0);
        hide(ancestor, false);
        await flush();
        assert.equal(g.calls.decline, 1);
        hide(ancestor, true);
        hide(ancestor, false);
        await flush();
        assert.equal(g.calls.decline, 2);
        hide(g.root, true);
        hide(g.root, false);
        await flush();
        assert.equal(g.calls.decline, 3);
        ancestor.className = "still-visible";
        await flush();
        assert.equal(g.calls.decline, 3);
        f.options({ adblockPopupEnabled: false });
        assert.equal(f.active.size, 0);
    });
}

test("an existing guide is discovered when only its parent becomes a player", async (t) => {
    const f = fixture(t);
    const g = f.guide();
    g.parent.className = "pending-player";
    g.mount();
    f.options();
    await flush();
    assert.equal(g.calls.decline, 0);
    g.parent.className = "_player_measured";
    await flush();
    assert.equal(g.calls.decline, 1);
    assert.equal(f.active.size, 1);
});

test("a hidden decline control waits until it is visible", async (t) => {
    const f = fixture(t);
    const g = f.guide();
    g.decline.hidden = true;
    g.mount();
    f.options();
    await flush();
    assert.equal(g.calls.decline, 0);
    g.decline.hidden = false;
    await flush();
    assert.equal(g.calls.decline, 1);
    assert.equal(g.calls.install, 0);
});

test("invalid candidates cannot block a later complete guide", async (t) => {
    const f = fixture(t);
    const invalid = Array.from({ length: 4 }, () => f.guide());
    invalid.forEach((g) => {
        g.layer.querySelector("p").textContent = "다른 안내";
        g.mount();
    });
    const g = f.guide();
    g.decline.disabled = true;
    g.mount();
    f.options();
    await flush();
    assert.equal(g.calls.decline, 0);
    assert.ok(f.active.size <= 5, "candidate observation remains bounded");
    g.decline.disabled = false;
    await flush();
    assert.equal(g.calls.decline, 1);
    assert.equal(g.calls.install, 0);
});

test("ancestor CSS visibility and remounts update scoped observation without stale clicks", async (t) => {
    const f = fixture(t);
    const g = f.guide({ remove: false });
    const style = f.w.document.createElement("style");
    style.textContent = ".native-hidden { display: none; }";
    f.w.document.head.append(style);
    const oldParent = f.w.document.createElement("section");
    oldParent.className = "native-hidden";
    oldParent.append(g.parent);
    f.w.document.body.append(oldParent);
    f.options();
    await flush();
    assert.equal(g.calls.decline, 0);
    oldParent.className = "";
    await flush();
    assert.equal(g.calls.decline, 1);
    const nextParent = f.w.document.createElement("section");
    nextParent.hidden = true;
    f.w.document.body.append(nextParent);
    nextParent.append(g.parent);
    await flush();
    assert.equal(g.calls.decline, 1);
    nextParent.hidden = false;
    await flush();
    assert.equal(g.calls.decline, 2);
    assert.equal(f.active.size, 2, "one discovery observer and one scoped guide observer");
    oldParent.hidden = true;
    oldParent.hidden = false;
    nextParent.style.color = "red";
    nextParent.style.color = "blue";
    await flush();
    assert.equal(g.calls.decline, 2);
    nextParent.remove();
    await flush();
    assert.equal(f.active.size, 1);
});

test("a zero-size decline control is not clicked until native layout makes it visible", async (t) => {
    const f = fixture(t);
    const g = f.guide();
    let width = 0;
    g.decline.getBoundingClientRect = () => ({ width, height: 30 });
    g.mount();
    f.options();
    await flush();
    assert.equal(g.calls.decline, 0);
    width = 180;
    g.decline.style.width = "180px";
    await flush();
    assert.equal(g.calls.decline, 1);
});
