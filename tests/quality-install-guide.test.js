const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

// 화면 실측 두 변형과 공개 번들에서 확인한 기본 화질 두 변형. 문구·설치·미설치 선택을 짝지어 둔다.
const GUIDE_HTML = {
    // 2026-09-14 Chrome 커넥터 안내
    connector: `<div class="_dimmed_10lql_28"><div class="_layer_10lql_38">
            <p>고화질 시청을 위해서는<br>네이버 라이브 스트리밍 커넥터가 필요합니다.</p>
            <div class="_button_10lql_70"><button type="button">설치하고 고화질 시청</button></div>
            <div class="_button_10lql_70"><button type="button">설치없이 일반 화질 시청</button></div>
        </div></div>`,
    // 2026-10-11 Edge 브라우저 확장 프로그램 안내
    extension: `<div class="_dimmed_10lql_28"><div class="_layer_10lql_38">
            <p class="_text_10lql_50">크롬, 엣지 브라우저에서 고화질 시청을 위해<br><strong>브라우저 확장 프로그램</strong>을 먼저 설치합니다.</p>
            <p class="_text_10lql_50">이미 확장 프로그램을 설치했다면<br><a href="https://help.naver.com/alias/navergame/chzzk6.naver" target="_blank" rel="noreferrer" class="_link_10lql_63">여기</a>를 참고해주세요.</p>
            <div class="_button_10lql_70"><button type="button">확장 프로그램 설치</button></div>
            <div class="_button_10lql_70"><button type="button">설치없이 일반 화질 시청</button></div>
        </div></div>`,
    // 2026-10-17 공개 번들·한국어 locale의 p2pMinScanline < 720 분기(화면 실측 아님).
    connectorLower: `<div class="_dimmed_10lql_28"><div class="_layer_10lql_38">
            <p>더 높은 화질로 시청하려면<br><strong>네이버 라이브 스트리밍 커넥터</strong>가 필요합니다.</p>
            <div class="_button_10lql_70"><button type="button">설치하고 더 높은 화질 시청</button></div>
            <div class="_button_10lql_70"><button type="button">설치없이 기본 화질 시청</button></div>
        </div></div>`,
    extensionLower: `<div class="_dimmed_10lql_28"><div class="_layer_10lql_38">
            <p>크롬, 엣지 브라우저에서 더 높은 화질로 시청하려면<br><strong>브라우저 확장 프로그램</strong>을 먼저 설치해주세요.</p>
            <p>이미 확장 프로그램을 설치했다면<br><a href="https://help.naver.com/alias/navergame/chzzk6.naver" target="_blank" rel="noreferrer">여기</a>를 참고해주세요.</p>
            <div class="_button_10lql_70"><button type="button">확장 프로그램 설치</button></div>
            <div class="_button_10lql_70"><button type="button">설치없이 기본 화질 시청</button></div>
        </div></div>`,
};

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
    w.CheeseSpannerSettings = {
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
        w.dispatchEvent(new w.Event("cheese-spanner:routechange"));
    };
    w.eval(read("content.js"));
    w.eval(read("features/qualityInstallGuide.js"));
    const guide = ({ remove = true, onDecline = () => {}, variant = "connector" } = {}) => {
        const parent = w.document.createElement("div");
        parent.className = "_player_jwedy_23";
        parent.innerHTML = GUIDE_HTML[variant];
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
        state: () => JSON.parse(w.document.documentElement.getAttribute("data-cheese-spanner-auto-quality-guide")),
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
    assert.equal(ad.hasAttribute("data-cheese-spanner-suppress-adblock-popup"), false);
    f.options({ adblockPopupEnabled: true, autoQualityEnabled: false });
    await flush();
    assert.equal(first.calls.decline, 1);
    assert.equal(ad.isConnected, false);
    f.options({ adblockPopupEnabled: false, autoQualityEnabled: false });
    const next = f.guide();
    next.mount();
    await flush();
    assert.equal(next.calls.decline, 0);
    assert.equal(ad.hasAttribute("data-cheese-spanner-suppress-adblock-popup"), false);
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
            g.root.className = "cheese-spanner-update-notice";
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

test("the browser extension guide measured on Edge is declined like the connector guide", async (t) => {
    const f = fixture(t);
    const first = f.guide({
        variant: "extension",
        onDecline: () => f.w.document.body.append(f.w.document.createElement("video")),
    });
    first.mount();
    await flush();
    assert.equal(first.calls.decline, 0, "saved options must load before clicking");
    f.options();
    await flush();
    assert.deepEqual(first.calls, { decline: 1, install: 0 });
    assert.ok(f.w.document.querySelector("video"), "the native handler creates the player");
    assert.equal(first.root.isConnected, false);
    const second = f.guide({ variant: "extension" });
    second.mount();
    await flush();
    assert.deepEqual(second.calls, { decline: 1, install: 0 });
    assert.deepEqual(f.state(), { enabled: true, attempts: 2 });
    assert.equal(f.active.size, 1, "closed guides release their scoped observers");
});

test("guide variants are matched only as the measured pairs of message and install button", async (t) => {
    const f = fixture(t);
    f.options();
    for (const [variant, change] of [
        [
            "extension",
            (g) => {
                g.install.textContent = "설치하고 고화질 시청";
            },
        ],
        [
            "connector",
            (g) => {
                g.install.textContent = "확장 프로그램 설치";
            },
        ],
        [
            "extension",
            (g) => {
                g.layer.querySelector("p").textContent =
                    "고화질 시청을 위해서는 네이버 라이브 스트리밍 커넥터가 필요합니다.";
            },
        ],
        [
            "extension",
            (g) => {
                g.layer.querySelector("p").remove();
            },
        ],
        [
            "extension",
            (g) => {
                g.install.textContent = "다른 확장 프로그램 설치하기";
            },
        ],
        [
            "extension",
            (g) => {
                g.decline.textContent = "확장 프로그램 설치";
            },
        ],
        [
            "extension",
            (g) => {
                g.layer.append(g.install.cloneNode(true));
            },
        ],
    ]) {
        const g = f.guide({ variant });
        change(g);
        g.mount();
        await flush();
        assert.deepEqual(g.calls, { decline: 0, install: 0 }, variant);
        assert.ok(g.root.isConnected);
        g.parent.remove();
        await flush();
    }
    assert.equal(f.state().attempts, 0);
});

// 아래 소변경은 실브라우저에서 관측한 새 문구가 아닌 보수적인 호환성 회귀다.
test("guide meaning survives punctuation and bounded wording changes within each measured pair", async (t) => {
    const f = fixture(t);
    f.options();
    for (const [variant, message, install, decline] of [
        [
            "connector",
            "고화질 시청을 위해 네이버 라이브 스트리밍 커넥터가 필요합니다!",
            "설치하고 고화질 시청하기",
            "설치 없이 일반 화질로 시청하기",
        ],
        [
            "connector",
            "고화질 시청을 위해서는 ‘네이버 라이브 스트리밍 커넥터’가 필요해요.",
            "설치하고 고화질 시청",
            "설치없이 일반 화질 시청",
        ],
        [
            "extension",
            "크롬 · 엣지 브라우저에서 고화질 시청을 위해 브라우저 확장 프로그램을 먼저 설치합니다!",
            "확장 프로그램 설치하기",
            "설치 없이 일반 화질 시청하기",
        ],
        [
            "extension",
            "크롬, 엣지 브라우저에서 고화질 시청을 위해서는 브라우저 확장 프로그램을 설치해 주세요.",
            "확장 프로그램 설치",
            "설치 없이 일반 화질로 시청",
        ],
    ]) {
        const g = f.guide({ variant });
        g.layer.querySelector("p").textContent = message;
        g.install.textContent = install;
        g.decline.textContent = decline;
        g.mount();
        await flush();
        assert.deepEqual(g.calls, { decline: 1, install: 0 }, message);
        g.parent.remove();
    }
    assert.equal(f.state().attempts, 4);
});

test("the lower-resolution pairs present in the current public bundle use only their native basic-quality choice", async (t) => {
    const f = fixture(t);
    f.options();
    for (const variant of ["connectorLower", "extensionLower"]) {
        const g = f.guide({ variant });
        g.mount();
        await flush();
        assert.deepEqual(g.calls, { decline: 1, install: 0 }, variant);
        assert.equal(g.root.isConnected, false);
        g.parent.remove();
    }
    assert.equal(f.state().attempts, 2);
});

test("high and lower-resolution guide evidence cannot be mixed to authorize a choice", async (t) => {
    const f = fixture(t);
    f.options();
    for (const [variant, field, text] of [
        ["connectorLower", "install", "설치하고 고화질 시청"],
        ["connectorLower", "decline", "설치없이 일반 화질 시청"],
        ["extensionLower", "decline", "설치없이 일반 화질 시청"],
        ["connector", "decline", "설치없이 기본 화질 시청"],
        ["extension", "decline", "설치없이 기본 화질 시청"],
        ["extensionLower", "install", "설치하고 더 높은 화질 시청"],
    ]) {
        const g = f.guide({ variant });
        g[field].textContent = text;
        g.mount();
        await flush();
        assert.deepEqual(g.calls, { decline: 0, install: 0 }, `${variant}: ${text}`);
        g.parent.remove();
        await flush();
    }
});

test("shallow neutral wrappers and message markup changes preserve only the native decline action", async (t) => {
    const f = fixture(t);
    const g = f.guide({ variant: "extension", remove: false });
    for (const node of [g.root, g.layer]) {
        for (let index = 0; index < 2; index++) {
            const wrapper = f.w.document.createElement("div");
            node.replaceWith(wrapper);
            wrapper.append(node);
        }
    }
    const message = g.layer.querySelector("p");
    const replacement = f.w.document.createElement("div");
    replacement.innerHTML = `<span>${message.innerHTML}</span>`;
    message.replaceWith(replacement);
    g.decline.innerHTML = "<span>설치 없이</span> <strong>일반 화질 시청</strong>";
    const media = f.w.document.createElement("video");
    media.setAttribute("src", "/main-content.m3u8");
    media.currentTime = 42;
    const calls = { play: 0, pause: 0, load: 0 };
    for (const method of Object.keys(calls)) media[method] = () => calls[method]++;
    g.parent.append(media);
    g.mount();
    f.options();
    await flush();
    assert.deepEqual(g.calls, { decline: 1, install: 0 });
    assert.deepEqual(calls, { play: 0, pause: 0, load: 0 });
    assert.equal(media.currentTime, 42);
    assert.equal(media.getAttribute("src"), "/main-content.m3u8");
    assert.equal(media.parentElement, g.parent);
    assert.ok(g.root.isConnected, "a native handler that leaves the guide open is not replaced by DOM removal");
    replacement.append(" ");
    g.root.classList.add("still-visible");
    await flush();
    assert.equal(g.calls.decline, 1, "a visible guide is not retried after a harmless wording or class update");
});

test("partial phrases, negation, other services and unsupported choices remain untouched", async (t) => {
    const f = fixture(t);
    f.options();
    for (const [variant, field, text] of [
        ["connector", "message", "네이버 라이브 스트리밍 커넥터가 필요합니다."],
        ["connector", "message", "고화질 시청을 위해서는 다른 서비스 라이브 스트리밍 커넥터가 필요합니다."],
        ["connector", "message", "고화질 시청을 위해서는 네이버 라이브 스트리밍 커넥터가 필요하지 않습니다."],
        [
            "extension",
            "message",
            "크롬, 엣지 브라우저에서 고화질 시청을 위해 브라우저 확장 프로그램을 설치하지 마세요.",
        ],
        ["extension", "message", "고화질 시청을 위해 브라우저 확장 프로그램을 설치합니다."],
        ["extension", "install", "브라우저 설정 변경"],
        ["extension", "decline", "설치하고 일반 화질 시청"],
        ["extension", "decline", "설치 없이 고화질 시청"],
        ["extension", "decline", "일반 화질 시청"],
        ["extension", "decline", "설치 없이 일반 화질 시청 및 결제"],
    ]) {
        const g = f.guide({ variant });
        (field === "message" ? g.layer.querySelector("p") : g[field]).textContent = text;
        g.mount();
        await flush();
        assert.deepEqual(g.calls, { decline: 0, install: 0 }, text);
        assert.ok(g.root.isConnected);
        g.parent.remove();
        await flush();
    }
});

test("hidden message or install evidence cannot authorize a visible decline control", async (t) => {
    const f = fixture(t);
    f.options();
    for (const field of ["message", "install"]) {
        const g = f.guide({ variant: "extension" });
        const evidence = field === "message" ? g.layer.querySelector("p") : g.install;
        evidence.hidden = true;
        g.mount();
        await flush();
        assert.deepEqual(g.calls, { decline: 0, install: 0 }, field);
        evidence.hidden = false;
        await flush();
        assert.deepEqual(g.calls, { decline: 1, install: 0 }, field);
        g.parent.remove();
    }
});

test("extra actions and nested dialog boundaries invalidate otherwise matching guides", async (t) => {
    const f = fixture(t);
    f.options();
    for (const change of [
        (g) => g.layer.insertAdjacentHTML("beforeend", '<a href="/purchase">구매하기</a>'),
        (g) => g.layer.insertAdjacentHTML("beforeend", '<div role="button" tabindex="0">다음</div>'),
        (g) => g.layer.insertAdjacentHTML("beforeend", '<input type="checkbox">'),
        (g) => g.root.insertAdjacentHTML("beforeend", '<button type="button">재생</button>'),
        (g) => g.layer.querySelector("a").setAttribute("href", "https://example.com/chzzk6.naver"),
        (g) => g.layer.setAttribute("role", "dialog"),
        (g) => {
            const wrapper = f.w.document.createElement("div");
            wrapper.setAttribute("role", "dialog");
            g.root.replaceWith(wrapper);
            wrapper.append(g.root);
        },
    ]) {
        const g = f.guide({ variant: "extension" });
        change(g);
        g.mount();
        await flush();
        assert.deepEqual(g.calls, { decline: 0, install: 0 });
        assert.ok(g.root.isConnected);
        g.parent.remove();
        await flush();
    }
});

test("a complete player inside another dialog does not authorize its installation guide", async (t) => {
    const f = fixture(t);
    f.options();
    for (const attributes of [{ role: "dialog" }, { role: "alertdialog" }, { "aria-modal": "true" }]) {
        const g = f.guide({ variant: "extension" });
        const dialog = f.w.document.createElement("div");
        for (const [name, value] of Object.entries(attributes)) dialog.setAttribute(name, value);
        dialog.append(g.parent);
        f.w.document.body.append(dialog);
        await flush();
        assert.deepEqual(g.calls, { decline: 0, install: 0 }, JSON.stringify(attributes));
        assert.ok(g.root.isConnected, "a guide in another dialog stays available for the user");
        dialog.remove();
        await flush();
    }
    assert.equal(f.state().attempts, 0);
});

test("guide traversal rejects distant wrappers, large subtrees and conflicting guide messages", async (t) => {
    const f = fixture(t);
    f.options();
    for (const change of [
        (g) => {
            for (let index = 0; index < 3; index++) {
                const wrapper = f.w.document.createElement("div");
                g.root.replaceWith(wrapper);
                wrapper.append(g.root);
            }
        },
        (g) => {
            for (let index = 0; index < 3; index++) {
                const wrapper = f.w.document.createElement("div");
                g.layer.replaceWith(wrapper);
                wrapper.append(g.layer);
            }
        },
        (g) => {
            for (let index = 0; index < 100; index++) g.layer.append(f.w.document.createElement("span"));
        },
        (g) => {
            g.layer.insertAdjacentHTML(
                "afterbegin",
                "<p>고화질 시청을 위해서는 네이버 라이브 스트리밍 커넥터가 필요합니다.</p>"
            );
        },
        (g) => {
            const nested = f.w.document.createElement("div");
            nested.className = "_layer_other";
            g.layer.append(nested);
        },
    ]) {
        const g = f.guide({ variant: "extension" });
        change(g);
        g.mount();
        await flush();
        assert.deepEqual(g.calls, { decline: 0, install: 0 });
        assert.ok(g.root.isConnected);
        g.parent.remove();
        await flush();
    }
});
