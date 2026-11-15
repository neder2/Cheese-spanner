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
    // jsdom has no text layout. Text is laid out inside the 1024x768 viewport unless a test places the text of an
    // element (and its descendants) elsewhere, as Chrome reported for the measured 0x0 and off-screen titles.
    const textRects = new WeakMap();
    w.Range.prototype.getClientRects = function () {
        for (let node = this.startContainer.parentElement; node; node = node.parentElement) {
            const placed = textRects.get(node);
            if (placed) return [placed];
        }
        return [{ left: 300, top: 300, width: 240, height: 20, right: 540, bottom: 320 }];
    };
    const placeText = (element, { left, top, width, height }) =>
        textRects.set(element, { left, top, width, height, right: left + width, bottom: top + height });
    const frames = new Map();
    let frameId = 0;
    w.requestAnimationFrame = (callback) => {
        frames.set(++frameId, callback);
        return frameId;
    };
    w.cancelAnimationFrame = (id) => frames.delete(id);
    const listeners = new Set();
    w.CheeseSpannerSettings = {
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
    return { w, options, popup, frame, placeText };
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
                assert.equal(p.el.hasAttribute("data-cheese-spanner-adblock-popup-closing"), false);
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
            assert.equal(p.el.hasAttribute("data-cheese-spanner-adblock-popup-closing"), false);
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
        assert.equal(p.el.hasAttribute("data-cheese-spanner-adblock-popup-closing"), false);
    }
    assert.equal(f.w.getComputedStyle(backdrop).visibility, "visible");
    assert.deepEqual(report.actions, { report: 0, block: 0, submit: 0 });
});

test("reused profile roots follow their current local structure without a permanent exemption", async (t) => {
    const f = fixture(t);
    const p = profilePopup(f, { kind: "own", nickname: "Adblock연구소", close: false });
    p.el.querySelector("strong").textContent = "광고 차단 프로그램을 사용 중이신가요?";
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
    assert.equal(p.el.hasAttribute("data-cheese-spanner-adblock-popup-closing"), false);
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
        // The report heading makes the title ambiguous, so the measured log area carries the notice identity.
        p.el.setAttribute("data-nlog-area", "ad_blocking_info_layer");
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
        assert.equal(p.el.hasAttribute("data-cheese-spanner-adblock-popup-closing"), false);
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
        // Report headings would make the title ambiguous; the measured log area keeps every case an ad notice.
        p.el.setAttribute("data-nlog-area", "ad_blocking_info_layer");
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
    p.el.setAttribute("data-nlog-area", "ad_blocking_info_layer");
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
    assert.equal(p.el.hasAttribute("data-cheese-spanner-adblock-popup-closing"), false);
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
    assert.equal(p.el.hasAttribute("data-cheese-spanner-adblock-popup-closing"), false);
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
    p.el.querySelector("strong").textContent = "광고 차단 프로그램을 사용하시나요?";
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
    f.w.dispatchEvent(new f.w.Event("cheese-spanner:routechange"));
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
    assert.equal(p.el.hasAttribute("data-cheese-spanner-adblock-popup-closing"), false);
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

// Ad words in a normal modal's nickname, body or buttons are not the measured notice (findings 2026-10-17).
// Only the popup's own log area or its single visible measured title approves the close path.
test("ad words, hidden titles and other popups' evidence never approve the generic close", async (t) => {
    const f = fixture(t);
    const normal = (name, html, label = "팝업 닫기") => {
        const p = f.popup({ text: "사용자 정보" });
        p.button.setAttribute("aria-label", label);
        p.el.insertAdjacentHTML("beforeend", html);
        return { name, ...p };
    };
    const popups = [
        normal("nickname adblock", '<div class="nickname">adblock팬</div>'),
        normal("nickname ad block words", "<span>광고문의 · 사용자 차단</span>", "닫기"),
        normal("body ad channel block", "<p>광고채널 차단</p>"),
        normal(
            "button copy",
            '<button type="button">광고 차단 해제</button><button type="button">Adblock 신고</button>'
        ),
        normal("old extension wording", "<p>확장 기능을 종료하면 광고가 정상 재생돼요.</p>"),
        normal("hidden measured title", '<strong style="display:none">광고 차단 프로그램을 사용 중이신가요?</strong>'),
        normal("aria-hidden measured title", '<h2 aria-hidden="true">광고 차단 프로그램을 사용 중이신가요?</h2>'),
        normal("measured title beside another heading", "<h2>광고 차단 프로그램을 사용 중이신가요?</h2>"),
        normal("measured title as body copy", "<p>광고 차단 프로그램을 사용 중이신가요?</p>"),
    ];
    // A keyword-only heading is not the measured title either.
    const keywordTitle = f.popup({ text: "광고 차단 안내" });
    popups.push({ name: "keyword-only title", ...keywordTitle });
    // A hidden title alone (no other heading) is still hidden evidence.
    const hiddenOnly = f.popup();
    hiddenOnly.el.querySelector("strong").hidden = true;
    popups.push({ name: "only title hidden", ...hiddenOnly });
    // A notice title inside a nested child popup cannot approve its normal parent, and the closeless child stays.
    const parent = normal("parent of nested title", "");
    const child = f.w.document.createElement("div");
    child.setAttribute("role", "dialog");
    child.innerHTML = "<strong>광고 차단 프로그램을 사용 중이신가요?</strong>";
    parent.el.append(child);
    popups.push(parent);
    // A sibling measured notice in the same backdrop closes; the normal sibling modal is untouched.
    const backdrop = f.w.document.createElement("div");
    backdrop.className = "_dimmed_jao35_2";
    f.w.document.body.append(backdrop);
    const sibling = normal("sibling of a notice", "<p>광고채널 차단</p>");
    const notice = f.popup();
    backdrop.append(sibling.el, notice.el);
    popups.push(sibling);
    f.options(true);
    await flush();
    f.frame();
    await flush();
    for (const p of popups) {
        assert.equal(p.clicks(), 0, p.name);
        assert.equal(p.el.isConnected, true, p.name);
        assert.equal(p.el.hasAttribute("data-cheese-spanner-adblock-popup-closing"), false, p.name);
    }
    assert.equal(child.isConnected, true);
    assert.equal(notice.clicks(), 1, "the measured sibling notice still closes once");
    assert.equal(notice.el.isConnected, false);
    assert.equal(f.w.getComputedStyle(backdrop).visibility, "visible");
});

// Codex r2-m1 Chrome reproduction: each of these single-heading normal modals was closed once by the r2 check.
// Hidden descendants are not rendered evidence, and a strong inside body copy or the close button is not a title.
test("hidden title descendants and strong in body copy or the close button never approve the generic close", async (t) => {
    const f = fixture(t);
    const TITLE = "광고 차단 프로그램을 사용 중이신가요?";
    const bare = (name, html) => {
        const p = f.popup();
        p.el.querySelector("strong").remove();
        p.button.setAttribute("aria-label", "팝업 닫기");
        p.el.insertAdjacentHTML("afterbegin", html);
        return { name, ...p };
    };
    const popups = [
        bare("hidden child of the title", `<h2><span hidden>${TITLE}</span></h2><p>일반 정보</p>`),
        bare("display:none child of the title", `<h2><span style="display:none">${TITLE}</span></h2><p>일반 정보</p>`),
        bare("aria-hidden child of the title", `<h2><span aria-hidden="true">${TITLE}</span></h2><p>일반 정보</p>`),
        bare("strong quoted in body copy", `<p>인용한 도움말 문구: <strong>${TITLE}</strong></p>`),
    ];
    const inButton = bare("strong inside the close button", "<p>일반 정보</p>");
    inButton.button.innerHTML = `<strong>${TITLE}</strong>`;
    popups.push(inButton);
    for (const p of popups) assert.equal(p.el.querySelectorAll("strong, h2").length, 1, p.name);
    // Contrast: the measured placement (popup > div > div > strong) with a visible split title still closes once.
    const measured = bare(
        "measured placement",
        '<div class="_contents_jao35_95"><div><strong><span>광고 차단 프로그램을</span> <span>사용 중이신가요?</span></strong><p>안내 본문</p></div></div>'
    );
    f.options(true);
    await flush();
    f.frame();
    await flush();
    for (const p of popups) {
        assert.equal(p.clicks(), 0, p.name);
        assert.equal(p.el.isConnected, true, p.name);
        assert.equal(p.el.hasAttribute("data-cheese-spanner-adblock-popup-closing"), false, p.name);
        assert.equal(f.w.getComputedStyle(p.el).visibility, "visible", p.name);
    }
    assert.equal(measured.clicks(), 1, "the measured placement still closes once");
    assert.equal(measured.el.isConnected, false);
});

test("the measured title variants and the notice log area approve the generic close once", async (t) => {
    const f = fixture(t);
    const variants = [
        f.popup({ text: "광고 차단 프로그램을 사용하고 계신가요?" }),
        f.popup({ text: "<span>광고 차단 프로그램을</span> <span>사용 중인가요?</span>" }),
    ];
    const area = f.popup({ text: "안내" });
    area.el.setAttribute("data-nlog-area", "ad_blocking_info_layer");
    area.button.setAttribute("aria-label", "팝업 닫기");
    f.options(true);
    await flush();
    f.frame();
    for (const p of [...variants, area]) {
        assert.equal(p.clicks(), 1);
        assert.equal(p.el.isConnected, false);
    }
});

// Codex r3-m1 Chrome reproduction: these single-heading normal modals were each closed once because the title
// check ignored opacity, zero-size text and text outside the viewport. Only text the user can see is evidence.
test("transparent, zero-size and off-screen title text never approves the generic close", async (t) => {
    const f = fixture(t);
    const TITLE = "광고 차단 프로그램을 사용 중이신가요?";
    const bare = (name, html) => {
        const p = f.popup();
        p.el.querySelector("strong").remove();
        p.button.setAttribute("aria-label", "팝업 닫기");
        p.el.insertAdjacentHTML("afterbegin", html);
        return { name, ...p };
    };
    const popups = [
        bare("opacity:0 child of the title", `<h2><span style="opacity:0">${TITLE}</span></h2><p>일반 정보</p>`),
        bare("opacity:0 title", `<h2 style="opacity:0">${TITLE}</h2><p>일반 정보</p>`),
        bare("opacity:0 wrapper", `<div style="opacity:0"><h2>${TITLE}</h2></div><p>일반 정보</p>`),
        bare(
            "font-size:0 child of the title",
            `<h2><span style="font-size:0;line-height:0">${TITLE}</span></h2><p>일반 정보</p>`
        ),
        bare("font-size:0 title", `<h2 style="font-size:0;line-height:0">${TITLE}</h2><p>일반 정보</p>`),
        bare(
            "off-screen title",
            `<h2 style="position:absolute;left:-10000px;top:0;white-space:nowrap">${TITLE}</h2><p>일반 정보</p>`
        ),
        bare("0x0 text in a sized title", `<h2><span>${TITLE}</span></h2><p>일반 정보</p>`),
    ];
    // Chrome geometry of the measured cases: the off-screen title at x=-9013 and 0x0 text in a positive-size title.
    f.placeText(popups[5].el.querySelector("h2"), { left: -9013, top: 0, width: 320, height: 22 });
    f.placeText(popups[6].el.querySelector("span"), { left: 300, top: 300, width: 0, height: 0 });
    // An ancestor outside the popup (its backdrop) that is fully transparent hides the title too.
    const transparentBackdrop = f.w.document.createElement("div");
    transparentBackdrop.style.opacity = "0";
    f.w.document.body.append(transparentBackdrop);
    const underBackdrop = f.popup();
    transparentBackdrop.append(underBackdrop.el);
    popups.push({ name: "opacity:0 ancestor outside the popup", ...underBackdrop });
    for (const p of popups) assert.equal(p.el.querySelectorAll("strong, h2").length, 1, p.name);

    // Contrasts that are really visible: a font-size:0 wrapper whose title resets the size, a title partly inside
    // the viewport, an explicitly opaque title and the default measured notice each close once.
    const resetSize = bare(
        "font-size:0 wrapper with a sized title",
        `<div style="font-size:0"><strong style="font-size:16px">${TITLE}</strong></div>`
    );
    const partly = bare("title partly inside the viewport", `<h2>${TITLE}</h2>`);
    f.placeText(partly.el.querySelector("h2"), { left: -120, top: 10, width: 320, height: 22 });
    const opaque = bare("opaque title", `<h2 style="opacity:1">${TITLE}</h2>`);
    const measured = f.popup();
    f.options(true);
    await flush();
    f.frame();
    await flush();
    for (const p of popups) {
        assert.equal(p.clicks(), 0, p.name);
        assert.equal(p.el.isConnected, true, p.name);
        assert.equal(p.el.hasAttribute("data-cheese-spanner-adblock-popup-closing"), false, p.name);
        assert.equal(f.w.getComputedStyle(p.el).visibility, "visible", p.name);
    }
    for (const p of [resetSize, partly, opaque, measured]) {
        assert.equal(p.clicks(), 1, `${p.name || "measured notice"} closes once`);
        assert.equal(p.el.isConnected, false);
    }
});

test("a title revealed by a CSS fade or slide-in closes once its transition or animation ends", async (t) => {
    const f = fixture(t);
    // A stylesheet rule hides the title at insertion; changing the rule is no mutation inside the popup.
    const style = f.w.document.createElement("style");
    style.textContent = ".fade-title{opacity:0}";
    f.w.document.head.append(style);
    const fade = f.popup();
    fade.el.querySelector("strong").className = "fade-title";
    const slide = f.popup();
    f.placeText(slide.el.querySelector("strong"), { left: -9013, top: 0, width: 320, height: 22 });
    f.options(true);
    await flush();
    f.frame();
    await flush();
    assert.equal(fade.clicks(), 0, "still transparent");
    assert.equal(slide.clicks(), 0, "still off-screen");

    style.textContent = ".fade-title{opacity:1}";
    await flush();
    assert.equal(fade.clicks(), 0, "a stylesheet change alone is not a popup mutation");
    fade.el.querySelector("strong").dispatchEvent(new f.w.Event("transitionend", { bubbles: true }));
    assert.equal(fade.clicks(), 1, "the faded-in title closes once");
    assert.equal(slide.clicks(), 0, "the other popup is still off-screen");

    f.placeText(slide.el.querySelector("strong"), { left: 300, top: 300, width: 320, height: 22 });
    slide.el.dispatchEvent(new f.w.Event("animationend", { bubbles: true }));
    assert.equal(slide.clicks(), 1, "the slid-in title closes once");
    // An unrelated transition elsewhere does not rescan or click again.
    f.w.document.body.dispatchEvent(new f.w.Event("transitionend", { bubbles: true }));
    assert.equal(fade.clicks() + slide.clicks(), 2);
});
