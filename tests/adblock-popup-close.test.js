const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const path = require("node:path");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, { defaultEnabled = false } = {}) {
    const dom = new JSDOM("<!doctype html><body></body>", {
        url: "https://chzzk.naver.com/live/test",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    w.HTMLButtonElement.prototype.getBoundingClientRect = () => ({ width: 80, height: 30 });
    const frames = new Map();
    let frameId = 0;
    w.requestAnimationFrame = (callback) => {
        frames.set(++frameId, callback);
        return frameId;
    };
    w.cancelAnimationFrame = (id) => frames.delete(id);
    const listeners = new Set();
    w.BetterChzzkSettings = {
        normalizeOptions: () => ({ adblockPopupEnabled: defaultEnabled }),
        getOptions(callback) {
            listeners.add(callback);
        },
        addOptionsChangeListener() {
            return () => {};
        },
    };
    w.eval(read("content.js"));
    w.eval(read("features/adblockPopup.js"));
    const options = (enabled) => listeners.forEach((callback) => callback({ adblockPopupEnabled: enabled }));
    t.after(() => {
        options(false);
        dom.window.close();
    });
    function popup({ close = true, text = "광고 차단 프로그램을 사용 중이신가요?" } = {}) {
        const el = w.document.createElement("div");
        el.setAttribute("role", "alertdialog");
        el.innerHTML = `<strong>${text}</strong><button type="button" aria-label="닫기">닫기</button>`;
        el.getBoundingClientRect = () => ({ width: 400, height: 200 });
        const button = el.querySelector("button");
        let clicks = 0;
        button.addEventListener("click", () => {
            clicks++;
            if (close) el.remove();
        });
        w.document.body.append(el);
        return { el, button, clicks: () => clicks };
    }
    const frame = () => {
        const callbacks = Array.from(frames.values());
        frames.clear();
        callbacks.forEach((callback) => callback());
    };
    return { w, options, popup, frame };
}

function profilePopup(f, { kind, nickname, label = "팝업 닫기", close = true }) {
    const p = f.popup({ close, text: "프로필 정보 · 변경된 제목" });
    p.button.setAttribute("aria-label", label);
    const wrapper = f.w.document.createElement("section");
    const actions = { profile: 0, report: 0, block: 0 };
    if (kind === "own") {
        p.el.className = "other-token _container_xwsra_203 another-token";
        wrapper.innerHTML = `<div><button type="button" class="extra _profile_xwsra_407"><span>${nickname}</span></button></div>`;
        wrapper.querySelector("button").addEventListener("click", () => actions.profile++);
    } else {
        p.el.className = "other-token _container_y6scg_309 another-token";
        wrapper.innerHTML = `<div class="_contents_y6scg_501"><div>${nickname}</div><button type="button" data-action="report">메시지 신고</button><button type="button" data-action="block">사용자 차단</button></div><div><div class="_control_y6scg_602"></div></div>`;
        wrapper.querySelector('[data-action="report"]').addEventListener("click", () => actions.report++);
        wrapper.querySelector('[data-action="block"]').addEventListener("click", () => actions.block++);
        wrapper.querySelector("._control_y6scg_602").append(p.button);
    }
    p.el.append(wrapper);
    return { ...p, wrapper, actions };
}

function reportPopup(f, { shop = false, label = "팝업 닫기", close = true } = {}) {
    const p = f.popup({ close, text: "Adblock 광고 차단 관련 영상·상품 제목" });
    p.button.setAttribute("aria-label", label);
    const heading = f.w.document.createElement("h2");
    heading.textContent = shop ? "스트리머샵\n신고하기" : "신고 하기";
    p.el.prepend(heading);
    const form = f.w.document.createElement("form");
    form.innerHTML = `<section><ul role="${shop ? "group" : "radiogroup"}"><li><input type="${shop ? "checkbox" : "radio"}" name="report-reason"></li></ul></section><button type="submit">신고하기</button><button type="button">사용자 차단</button>`;
    const actions = { report: 0, block: 0, submit: 0 };
    form.querySelector('[type="submit"]').addEventListener("click", () => actions.report++);
    form.querySelector('button[type="button"]').addEventListener("click", () => actions.block++);
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        actions.submit++;
    });
    p.el.append(form);
    return { ...p, actions };
}

// These fixtures use the two observed profile module families, with changed numeric suffixes and copy.
for (const kind of ["own", "other"]) {
    for (const nickname of ["Adblock연구소", "광고문의 · 사용자 차단"]) {
        for (const label of ["닫기", "팝업 닫기"]) {
            test(`${kind} profile with ${nickname} preserves ${label} and user actions`, async (t) => {
                const f = fixture(t);
                const p = profilePopup(f, { kind, nickname, label });
                f.w.document.body.style.cssText = "overflow:hidden;padding-right:17px";
                const bodyStyle = f.w.document.body.style.cssText;
                f.options(true);
                await flush();
                f.frame();
                await flush();
                assert.equal(p.clicks(), 0);
                assert.equal(p.el.isConnected, true);
                assert.equal(p.el.hasAttribute("data-betterchzzk-adblock-popup-closing"), false);
                assert.equal(f.w.getComputedStyle(p.el).visibility, "visible");
                assert.equal(f.w.document.body.style.cssText, bodyStyle);
                assert.deepEqual(p.actions, { profile: 0, report: 0, block: 0 });
            });
        }
    }
}

for (const shop of [false, true]) {
    for (const label of ["닫기", "팝업 닫기"]) {
        test(`${shop ? "shop" : "video"} report with ad words preserves ${label} and submission`, async (t) => {
            const f = fixture(t);
            const p = reportPopup(f, { shop, label });
            f.options(true);
            await flush();
            f.frame();
            await flush();
            assert.equal(p.clicks(), 0);
            assert.equal(p.el.isConnected, true);
            assert.equal(p.el.hasAttribute("data-betterchzzk-adblock-popup-closing"), false);
            assert.deepEqual(p.actions, { report: 0, block: 0, submit: 0 });
        });
    }
}

test("normal sibling popups do not exempt an ad notice or conceal their shared backdrop", async (t) => {
    const f = fixture(t);
    const profile = profilePopup(f, { kind: "own", nickname: "Adblock연구소" });
    const report = reportPopup(f);
    const ad = f.popup();
    const backdrop = f.w.document.createElement("div");
    backdrop.className = "_dimmed_jao35_2";
    f.w.document.body.append(backdrop);
    backdrop.append(profile.el, report.el, ad.el);
    f.options(true);
    await flush();
    f.frame();
    assert.equal(ad.clicks(), 1);
    assert.equal(ad.el.isConnected, false);
    for (const p of [profile, report]) {
        assert.equal(p.clicks(), 0);
        assert.equal(p.el.isConnected, true);
        assert.equal(p.el.hasAttribute("data-betterchzzk-adblock-popup-closing"), false);
    }
    assert.equal(f.w.getComputedStyle(backdrop).visibility, "visible");
    assert.deepEqual(report.actions, { report: 0, block: 0, submit: 0 });
});

test("reused profile roots follow their current local structure without a permanent exemption", async (t) => {
    const f = fixture(t);
    const p = profilePopup(f, { kind: "own", nickname: "Adblock연구소", close: false });
    p.el.querySelector("strong").textContent = "광고 차단 안내";
    f.options(true);
    await flush();
    assert.equal(p.clicks(), 0);
    p.wrapper.remove();
    await flush();
    f.frame();
    assert.equal(p.clicks(), 1);
    p.el.append(p.wrapper);
    await flush();
    assert.equal(p.clicks(), 1);
    assert.equal(p.el.hasAttribute("data-betterchzzk-adblock-popup-closing"), false);
    p.wrapper.remove();
    await flush();
    f.frame();
    assert.equal(p.clicks(), 2);
    assert.deepEqual(p.actions, { profile: 0, report: 0, block: 0 });
});

for (const [attribute, invalid] of [
    ["name", "unrelated"],
    ["type", "text"],
]) {
    test(`report input ${attribute} changes recheck the current popup without replacing nodes`, async (t) => {
        const f = fixture(t);
        const p = reportPopup(f, { close: false });
        const input = p.el.querySelector("input");
        const original = input.getAttribute(attribute);
        f.options(true);
        await flush();
        assert.equal(p.clicks(), 0);
        input.setAttribute(attribute, invalid);
        await flush();
        f.frame();
        assert.equal(p.clicks(), 1);
        input.setAttribute(attribute, original);
        await flush();
        assert.equal(p.clicks(), 1);
        assert.equal(p.el.hasAttribute("data-betterchzzk-adblock-popup-closing"), false);
        input.setAttribute(attribute, invalid);
        await flush();
        f.frame();
        assert.equal(p.clicks(), 2);
        assert.equal(p.el.isConnected, true);
        assert.deepEqual(p.actions, { report: 0, block: 0, submit: 0 });
    });
}

test("a child popup cannot borrow profile evidence from its parent popup", async (t) => {
    const f = fixture(t);
    const parent = profilePopup(f, { kind: "own", nickname: "Adblock연구소" });
    const child = f.popup();
    child.el.className = "_container_xwsra_901";
    parent.wrapper.append(child.el);
    f.options(true);
    await flush();
    f.frame();
    assert.equal(child.clicks(), 1);
    assert.equal(child.el.isConnected, false);
    assert.equal(parent.clicks(), 0);
    assert.equal(parent.el.isConnected, true);
});

test("incomplete or unrelated normal-popup hints do not exempt ad notices", async (t) => {
    const f = fixture(t);
    const cases = [
        ["own root only", "_container_xwsra_2", ""],
        ["own child only", "", '<button type="button" class="_profile_xwsra_38">프로필</button>'],
        ["own nonbutton", "_container_xwsra_2", '<div class="_profile_xwsra_38">프로필</div>'],
        ["own lookalike token", "prefix_container_xwsra_2", '<button class="_profile_xwsra_38">프로필</button>'],
        ["own nonnumeric suffix", "_container_xwsra_next", '<button class="_profile_xwsra_38">프로필</button>'],
        ["own child token suffix", "_container_xwsra_2", '<button class="_profile_xwsra_38_extra">프로필</button>'],
        ["other missing contents", "_container_y6scg_2", '<div class="_control_y6scg_300"></div>'],
        ["other missing control", "_container_y6scg_2", '<div class="_contents_y6scg_5"></div>'],
        ["other children only", "", '<div class="_contents_y6scg_5"></div><div class="_control_y6scg_300"></div>'],
        ["ordinary profile class", "profile", '<button type="button" class="profile">사용 중인 프로필</button>'],
        ["report heading only", "", "<h2>신고하기</h2>"],
        ["report input only", "", '<ul role="radiogroup"><li><input type="radio" name="report-reason"></li></ul>'],
        [
            "report body copy only",
            "",
            '<p>신고하기</p><ul role="radiogroup"><li><input type="radio" name="report-reason"></li></ul>',
        ],
        [
            "report input outside group",
            "",
            '<h2>신고하기</h2><ul role="radiogroup"></ul><input type="radio" name="report-reason">',
        ],
        [
            "report unrelated input",
            "",
            '<h2>신고하기</h2><ul role="radiogroup"><li><input type="radio" name="unrelated"></li></ul>',
        ],
        [
            "report wrong input type",
            "",
            '<h2>신고하기</h2><ul role="radiogroup"><li><input type="text" name="report-reason"></li></ul>',
        ],
        ["normal words only", "", "<p>프로필 · 공유 · 신고 · 로그인 · 사용자 차단</p>"],
    ];
    const popups = cases.map(([name, className, html]) => {
        const p = f.popup();
        p.el.className = className;
        p.el.insertAdjacentHTML("beforeend", html);
        return { name, ...p };
    });
    f.options(true);
    await flush();
    f.frame();
    for (const p of popups) {
        assert.equal(p.clicks(), 1, p.name);
        assert.equal(p.el.isConnected, false, p.name);
    }
});

test("a report input cannot borrow a group outside its popup", async (t) => {
    const f = fixture(t);
    const p = f.popup();
    p.el.insertAdjacentHTML("beforeend", '<h2>신고하기</h2><input type="radio" name="report-reason">');
    const group = f.w.document.createElement("ul");
    group.setAttribute("role", "radiogroup");
    f.w.document.body.append(group);
    group.append(p.el);
    f.options(true);
    await flush();
    assert.equal(p.clicks(), 1);
    assert.equal(p.el.isConnected, false);
});

test("saved options load before any default-enabled popup action", async (t) => {
    const f = fixture(t, { defaultEnabled: true });
    const p = f.popup();
    await flush();
    assert.equal(p.clicks(), 0);
    assert.equal(p.el.hasAttribute("data-betterchzzk-adblock-popup-closing"), false);
    f.options(false);
    await flush();
    assert.equal(p.clicks(), 0);
    f.options(true);
    assert.equal(p.clicks(), 1);
});

test("the measured popup close label closes once and keeps other actions untouched", async (t) => {
    const f = fixture(t);
    const p = f.popup();
    p.button.setAttribute("aria-label", "팝업 닫기");
    const untouched = [];
    for (const label of ["광고 닫기", "팝업 닫기 및 설치", "닫기 설정", "확인"]) {
        const other = f.popup();
        other.button.setAttribute("aria-label", label);
        untouched.push({ label, other });
    }
    f.options(true);
    await flush();
    f.frame();
    assert.equal(p.clicks(), 1);
    assert.equal(p.el.isConnected, false);
    for (const { label, other } of untouched) {
        assert.equal(other.clicks(), 0, label);
        assert.equal(other.el.isConnected, true, label);
    }
});

test("both measured close labels count toward ambiguity", async (t) => {
    const f = fixture(t);
    const p = f.popup();
    const second = p.button.cloneNode(true);
    second.setAttribute("aria-label", "팝업 닫기");
    second.addEventListener("click", () => assert.fail("ambiguous second close button clicked"));
    p.el.append(second);
    f.options(true);
    await flush();
    assert.equal(p.clicks(), 0);
    assert.equal(p.el.hasAttribute("data-betterchzzk-adblock-popup-closing"), false);
});

const visibilityCycles = {
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
};

for (const [name, hide] of Object.entries(visibilityCycles)) {
    test(`native ${name} close during concealment permits the next display cycle`, async (t) => {
        const f = fixture(t);
        const p = f.popup({ close: false });
        p.button.addEventListener("click", () => hide(p.el, true));
        f.options(true);
        await flush();
        f.frame();
        hide(p.el, false);
        await flush();
        assert.equal(p.clicks(), 2);
        f.frame();
        await flush();
        assert.equal(p.clicks(), 2);
    });

    test(`batched ancestor ${name} hide and reveal permits only one new attempt`, async (t) => {
        const f = fixture(t);
        const p = f.popup({ close: false });
        const ancestor = f.w.document.createElement("section");
        f.w.document.body.append(ancestor);
        ancestor.append(p.el);
        f.options(true);
        await flush();
        // Keep the extension's concealment active during the native display cycle.
        hide(ancestor, true);
        hide(ancestor, false);
        await flush();
        f.frame();
        await flush();
        assert.equal(p.clicks(), 2);
        p.el.className = "unrelated-visible-change";
        await flush();
        assert.equal(p.clicks(), 2);
    });
}

test("only visible enabled close controls count toward ambiguity", async (t) => {
    const f = fixture(t);
    const p = f.popup();
    for (const setup of [
        (button) => {
            button.hidden = true;
        },
        (button) => {
            button.disabled = true;
        },
        (button) => {
            button.style.display = "none";
        },
        (button) => {
            button.getBoundingClientRect = () => ({ width: 0, height: 0 });
        },
    ]) {
        const copy = p.button.cloneNode(true);
        setup(copy);
        copy.addEventListener("click", () => assert.fail("inactive close control clicked"));
        p.el.append(copy);
    }
    f.options(true);
    await flush();
    assert.equal(p.clicks(), 1);
});

test("native class hiding during concealment resets the attempt after the frame", async (t) => {
    const f = fixture(t);
    const p = f.popup({ close: false });
    const style = f.w.document.createElement("style");
    style.textContent = ".native-closed { visibility: hidden; }";
    f.w.document.head.append(style);
    p.button.addEventListener("click", () => {
        p.el.className = "native-closed";
    });
    f.options(true);
    await flush();
    f.frame();
    p.el.className = "";
    await flush();
    assert.equal(p.clicks(), 2);
});

test("adblock notice closes through its handler so modal state releases native shortcuts", async (t) => {
    const f = fixture(t);
    const p = f.popup();
    let modalOpen = true;
    let toggles = 0;
    p.button.addEventListener("click", () => {
        modalOpen = false;
    });
    f.w.addEventListener("keydown", () => {
        if (!modalOpen) toggles++;
    });
    f.options(true);
    await flush();
    f.w.dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "m" }));
    assert.equal(p.clicks(), 1);
    assert.equal(p.el.isConnected, false);
    assert.equal(toggles, 1);
});

test("failed close stays visible and is not retried on unrelated mutations", async (t) => {
    const f = fixture(t);
    const p = f.popup({ close: false });
    f.w.document.body.style.cssText = "overflow:hidden;padding-right:17px;color:red";
    f.options(true);
    await flush();
    f.frame();
    p.el.className = "changed";
    await flush();
    assert.equal(p.clicks(), 1);
    assert.equal(f.w.getComputedStyle(p.el).display, "block");
    assert.equal(f.w.document.body.style.overflow, "hidden");
    assert.equal(f.w.document.body.style.paddingRight, "17px");
    f.options(false);
    assert.equal(f.w.document.body.style.color, "red");
});

test("missing, disabled, ambiguous and unrelated close controls remain untouched", async (t) => {
    const f = fixture(t);
    const missing = f.popup();
    missing.button.remove();
    const disabled = f.popup();
    disabled.button.disabled = true;
    const ambiguous = f.popup();
    ambiguous.el.append(ambiguous.button.cloneNode(true));
    const other = f.popup({ text: "확장 프로그램 설치 안내" });
    f.options(true);
    await flush();
    for (const p of [missing, disabled, ambiguous, other]) {
        assert.equal(p.clicks(), 0);
        assert.equal(f.w.getComputedStyle(p.el).display, "block");
    }
    disabled.button.disabled = false;
    await flush();
    assert.equal(disabled.clicks(), 1);
});

test("late buttons, popup reuse, remount and option changes respect popup identity", async (t) => {
    const f = fixture(t);
    const p = f.popup({ close: false });
    p.button.remove();
    f.options(true);
    await flush();
    p.el.append(p.button);
    await flush();
    f.frame();
    assert.equal(p.clicks(), 1);
    p.el.querySelector("strong").textContent = "다른 안내";
    await flush();
    p.el.querySelector("strong").textContent = "광고 차단 안내";
    await flush();
    f.frame();
    assert.equal(p.clicks(), 2);
    p.el.remove();
    f.w.document.body.append(p.el);
    await flush();
    assert.equal(p.clicks(), 3);
    f.options(false);
    const next = f.popup();
    await flush();
    assert.equal(next.clicks(), 0);
    f.options(true);
    await flush();
    assert.equal(next.clicks(), 1);
});

test("hidden notices and nested unrelated dialogs are not clicked", async (t) => {
    const f = fixture(t);
    const p = f.popup();
    const parent = f.w.document.createElement("div");
    parent.hidden = true;
    f.w.document.body.append(parent);
    parent.append(p.el);
    const outer = f.popup();
    const inner = f.popup({ text: "다른 확인 사항" });
    outer.el.append(inner.el);
    f.options(true);
    await flush();
    assert.equal(p.clicks(), 0);
    assert.equal(outer.clicks(), 0);
    assert.equal(inner.clicks(), 0);
    parent.hidden = false;
    await flush();
    assert.equal(p.clicks(), 1);
});

test("SPA changes and replaced buttons use current popup state without duplicate handlers", async (t) => {
    const f = fixture(t);
    const p = f.popup({ close: false });
    f.options(true);
    f.options(true);
    await flush();
    f.frame();
    assert.equal(p.clicks(), 1);
    f.w.history.pushState({}, "", "/video/123");
    f.w.dispatchEvent(new f.w.Event("betterchzzk:routechange"));
    await flush();
    f.frame();
    assert.equal(p.clicks(), 2);
    const replacement = p.button.cloneNode(true);
    let calls = 0;
    replacement.addEventListener("click", () => {
        calls++;
        p.el.remove();
    });
    p.button.replaceWith(replacement);
    await flush();
    assert.equal(calls, 1);
    assert.equal(p.clicks(), 2);
});

test("notice and its own backdrop are hidden before native close, then restored on failure", async (t) => {
    const f = fixture(t);
    const p = f.popup({ close: false });
    const backdrop = f.w.document.createElement("div");
    backdrop.className = "_dimmed_jao35_2";
    f.w.document.body.append(backdrop);
    backdrop.append(p.el);
    let duringClick;
    p.button.addEventListener("click", () => {
        duringClick = [f.w.getComputedStyle(p.el).visibility, f.w.getComputedStyle(backdrop).visibility];
    });
    f.options(true);
    assert.deepEqual(duringClick, ["hidden", "hidden"]);
    assert.equal(f.w.getComputedStyle(p.el).visibility, "hidden");
    await flush();
    assert.equal(p.clicks(), 1);
    f.frame();
    await flush();
    assert.equal(f.w.getComputedStyle(p.el).visibility, "visible");
    assert.equal(f.w.getComputedStyle(backdrop).visibility, "visible");
    assert.equal(p.clicks(), 1);
});

test("native async removal releases concealment and a thrown click restores immediately", async (t) => {
    const f = fixture(t);
    const p = f.popup({ close: false });
    p.button.addEventListener("click", () => f.w.queueMicrotask(() => p.el.remove()));
    f.options(true);
    assert.equal(f.w.getComputedStyle(p.el).visibility, "hidden");
    await flush();
    assert.equal(p.el.isConnected, false);
    assert.equal(p.el.hasAttribute("data-betterchzzk-adblock-popup-closing"), false);
    f.frame();
    const failing = f.popup({ close: false });
    let attempts = 0;
    failing.button.click = () => {
        attempts++;
        throw new Error("native close failed");
    };
    await flush();
    assert.equal(attempts, 1);
    assert.equal(f.w.getComputedStyle(failing.el).visibility, "visible");
    failing.el.className = "changed";
    await flush();
    f.frame();
    assert.equal(attempts, 1);
});

test("temporary concealment restores on disable and does not hide a shared backdrop", async (t) => {
    const f = fixture(t);
    const p = f.popup({ close: false });
    const other = f.popup({ text: "다른 안내" });
    const backdrop = f.w.document.createElement("div");
    backdrop.className = "_dimmed_jao35_2";
    f.w.document.body.append(backdrop);
    backdrop.append(p.el, other.el);
    f.options(true);
    assert.equal(f.w.getComputedStyle(p.el).visibility, "hidden");
    assert.equal(f.w.getComputedStyle(other.el).visibility, "visible");
    assert.equal(f.w.getComputedStyle(backdrop).visibility, "visible");
    f.options(false);
    assert.equal(f.w.getComputedStyle(p.el).visibility, "visible");
    f.frame();
    await flush();
    assert.equal(p.clicks(), 1);
});
