const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

const REQUEST = "cheese-spanner:adblock-notice-confirm";
const STATUS_ATTR = "data-cheese-spanner-adblock-notice-confirm";
const CLOSING_ATTR = "data-cheese-spanner-adblock-popup-closing";
const RESULT_ATTR = "data-cheese-spanner-adblock-notice-result";
// features/adblockPopup.js NOTICE_REMOVAL_WAIT_MS
const REMOVAL_WAIT_MS = 1000;
const HELP = "https://help.naver.com/alias/navergame/chzzkars49.naver";
const LIVE = "/live/b044e3a3b9259246bc92e863e7d3f3b8";
// 2026-10-11 bundle index-VdvK-ysl.js: live e=>{e.isTrusted&&xe(!1)}, VOD e=>{e.isTrusted&&m(!1)}.
const MEASURED_HANDLER = "e=>{e.isTrusted&&xe(!1)}";

// 2026-10-11 사용자 Edge에서 읽은 안내 DOM. 배경은 body 바로 아래 포털이고 버튼은 확인 하나뿐이다.
const NOTICE_HTML = `<div class="_container_jao35_20 _modal_jao35_27" role="alertdialog" aria-modal="true" data-nlog-area="ad_blocking_info_layer" data-nlog-params='{"component_type":"layer"}' style="width: 450px;">
    <div class="_contents_jao35_95"><div style="text-align: center; letter-spacing: -0.3px;">
        <strong style="font-size: 22px; font-weight: bold;">광고 차단 프로그램을 사용 중이신가요?</strong>
        <p style="margin-top: 15px;">광고 차단 프로그램 사용 시 재생 환경에 영향을 미칠 수 있으니<br>사용 중인 확장 프로그램이 있다면, 삭제 후 서비스를 이용해 주세요.</p>
        <p style="margin-top: 15px;">※ 광고 차단 프로그램을 사용하지 않는 경우,<br>다른 확장 프로그램 영향일 수 있습니다.<br>브라우저 &gt; 시크릿 모드에서 확인해 주세요.&nbsp;<a href="${HELP}" target="_blank" rel="noreferrer">자세히 보기</a></p>
    </div></div>
    <div class="_footer_jao35_57"><div class="_inner_jao35_237"><div class="_cell_jao35_248"><button type="button" class="_container_vgt54_2 _primary_vgt54_30 _solid_vgt54_26 _largest_vgt54_209 _font_bold_vgt54_15 _full_button_vgt54_11">확인</button></div></div></div>
</div>`;

function fixture(t, { pathname = LIVE, main = true, defaultEnabled = false } = {}) {
    const dom = new JSDOM("<!doctype html><body></body>", {
        url: `https://chzzk.naver.com${pathname}`,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const w = dom.window;
    w.HTMLButtonElement.prototype.getBoundingClientRect = () => ({ width: 402, height: 46 });
    const frames = new Map();
    let frameId = 0;
    w.requestAnimationFrame = (callback) => {
        frames.set(++frameId, callback);
        return frameId;
    };
    w.cancelAnimationFrame = (id) => frames.delete(id);
    // Deterministic timers for the bounded removal wait.
    const timers = new Map();
    let timerId = 0;
    let clock = 0;
    w.setTimeout = (callback, delay = 0, ...args) => {
        timers.set(++timerId, { at: clock + Number(delay || 0), run: () => callback(...args) });
        return timerId;
    };
    w.clearTimeout = (id) => timers.delete(id);
    const advance = (ms) => {
        clock += ms;
        for (const [id, timer] of Array.from(timers)) {
            if (timer.at > clock || !timers.has(id)) continue;
            timers.delete(id);
            timer.run();
        }
    };
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
    // manifest: MAIN document_start scripts run before the isolated feature list.
    if (main) w.eval(read("features/adblockPopupPage.js"));
    w.eval(read("content.js"));
    w.eval(read("features/adblockPopup.js"));
    const requests = [];
    w.document.addEventListener(REQUEST, (event) => requests.push({ target: event.target, event }), true);
    const domClicks = [];
    w.addEventListener("click", (event) => domClicks.push(event), true);
    const options = (enabled) => listeners.forEach((callback) => callback({ adblockPopupEnabled: enabled }));
    t.after(() => {
        options(false);
        dom.window.close();
    });
    const frame = () => {
        const callbacks = Array.from(frames.values());
        frames.clear();
        callbacks.forEach((callback) => callback());
    };
    const shortcuts = { blocked: 0 };
    const reactKey = "__reactProps$k2v9x0s1";

    // Minimal model of mX + di: mount locks scroll/shortcuts, React removal runs the effect cleanup.
    function notice({ closes = "microtask", handler = MEASURED_HANDLER, setter = "xe" } = {}) {
        const backdrop = w.document.createElement("div");
        backdrop.className = "_dimmed_jao35_2 _dimmed_transparent_jao35_32";
        backdrop.innerHTML = NOTICE_HTML;
        const el = backdrop.firstElementChild;
        el.getBoundingClientRect = () => ({ width: 450, height: 300 });
        const button = el.querySelector("button");
        const calls = [];
        let pending = null;
        let savedOverflow = "";
        const unmount = () => {
            if (!backdrop.isConnected) return;
            backdrop.remove();
            w.document.body.style.overflow = savedOverflow;
            shortcuts.blocked -= 1;
        };
        const set = (value) => {
            calls.push(value);
            if (value !== false || !closes) return;
            // React commits the state change after the callback returns.
            if (closes === "microtask") w.queueMicrotask(unmount);
            else pending = unmount;
        };
        const onClick = w.eval(`(${setter}) => ${handler}`)(set);
        el[reactKey] = {
            className: el.className,
            role: "alertdialog",
            "aria-modal": "true",
            "data-nlog-area": "ad_blocking_info_layer",
            "data-nlog-params": '{"component_type":"layer"}',
        };
        button[reactKey] = { type: "button", disabled: undefined, onClick, children: ["확인", undefined, false] };
        // React's delegated click passes the native event, whose isTrusted is false for script clicks.
        button.addEventListener("click", (event) => button[reactKey]?.onClick?.(event));
        const mount = () => {
            savedOverflow = w.document.body.style.overflow;
            shortcuts.blocked += 1;
            w.document.body.append(backdrop);
            w.document.body.style.overflow = "hidden";
        };
        return {
            backdrop,
            el,
            button,
            calls,
            set,
            mount,
            unmount,
            commit: () => pending?.(),
            visible: () => backdrop.isConnected && w.getComputedStyle(el).visibility !== "hidden",
            concealed: () => el.getAttribute(CLOSING_ATTR) === "1",
        };
    }

    const status = () => JSON.parse(w.document.documentElement.getAttribute(STATUS_ATTR) || "null");
    const result = () => JSON.parse(w.document.documentElement.getAttribute(RESULT_ATTR) || "null");
    const forge = (button) => button.dispatchEvent(new w.Event(REQUEST, { cancelable: true }));
    const navigate = (pathname) => {
        w.history.pushState({}, "", pathname);
        w.dispatchEvent(new w.Event("cheese-spanner:routechange"));
    };
    return {
        w,
        options,
        frame,
        advance,
        notice,
        requests,
        domClicks,
        shortcuts,
        reactKey,
        status,
        result,
        forge,
        navigate,
    };
}

test("saved options gate the request and the exact notice closes through its current callback", async (t) => {
    const f = fixture(t, { defaultEnabled: true });
    const n = f.notice();
    n.mount();
    await flush();
    assert.deepEqual(n.calls, [], "saved options must load before any callback");
    assert.equal(f.requests.length, 0);
    f.options(false);
    await flush();
    assert.deepEqual(n.calls, []);
    assert.equal(f.requests.length, 0);

    f.options(true);
    assert.deepEqual(n.calls, [false], "the measured callback receives the minimal trusted argument once");
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].target, n.button);
    assert.equal(f.requests[0].event.defaultPrevented, true, "MAIN reports the call, not success");
    assert.equal(n.concealed(), true, "the notice is concealed until its native removal");
    assert.equal(n.backdrop.isConnected, true, "the callback return alone does not remove the notice");
    assert.equal(f.result(), null, "an acknowledged call is not reported as a close");
    await flush();
    assert.equal(n.backdrop.isConnected, false);
    assert.equal(n.concealed(), false);
    assert.equal(f.w.document.body.style.overflow, "", "native cleanup restores the scroll lock");
    assert.equal(f.shortcuts.blocked, 0, "native cleanup releases the shortcut block");
    assert.equal(f.domClicks.length, 0, "the extension never synthesizes a DOM click for the notice");
    assert.deepEqual(f.status(), { status: "invoked", invoked: 1, refused: 0 });
    const closed = f.result();
    assert.equal(closed.last, "removed", "success is the observed removal of the notice node");
    assert.deepEqual([closed.removed, closed.timedOut, closed.refused], [1, 0, 0]);
    f.frame();
    f.advance(REMOVAL_WAIT_MS * 2);
    await flush();
    assert.deepEqual(n.calls, [false]);
    assert.equal(f.result().timedOut, 0, "a finished wait leaves no timer behind");
});

test("React removal later than the next frame keeps the notice concealed until it happens", async (t) => {
    const f = fixture(t);
    const n = f.notice({ closes: "manual" });
    n.mount();
    f.options(true);
    for (let index = 0; index < 5; index += 1) {
        f.frame();
        f.advance(100);
        await flush();
        assert.equal(n.concealed(), true, `frame ${index}: no re-exposure before native removal`);
        assert.equal(n.visible(), false);
    }
    n.commit();
    await flush();
    assert.equal(n.backdrop.isConnected, false);
    assert.equal(n.concealed(), false, "the removed node keeps no extension marker");
    assert.equal(f.result().last, "removed");
    f.advance(REMOVAL_WAIT_MS);
    assert.equal(f.result().timedOut, 0);
});

test("plain click and dispatched click events stay rejected by the measured handler", async (t) => {
    const f = fixture(t);
    const n = f.notice();
    n.mount();
    n.button.click();
    n.button.dispatchEvent(new f.w.MouseEvent("click", { bubbles: true }));
    await flush();
    assert.deepEqual(n.calls, [], "isTrusted is false for script-created clicks");
    assert.equal(n.visible(), true);
    f.options(true);
    await flush();
    assert.deepEqual(n.calls, [false]);
    assert.equal(n.backdrop.isConnected, false);
    assert.equal(f.domClicks.length, 2, "only the two manual script clicks reached the DOM");
});

test("an ignored callback is revealed after the bounded wait without retrying or forcing native state", async (t) => {
    const f = fixture(t);
    const n = f.notice({ closes: false });
    n.mount();
    f.options(true);
    await flush();
    assert.deepEqual(n.calls, [false]);
    assert.equal(n.concealed(), true);
    f.frame();
    f.frame();
    f.advance(REMOVAL_WAIT_MS - 1);
    await flush();
    assert.equal(n.concealed(), true, "frames alone do not reveal a notice waiting for native removal");
    f.advance(1);
    assert.equal(n.visible(), true, "the bounded wait reveals a notice that stayed mounted");
    assert.equal(f.result().last, "timeout");
    n.el.className += " unrelated-change";
    n.el.querySelector("strong").style.color = "red";
    await flush();
    f.frame();
    f.advance(REMOVAL_WAIT_MS * 3);
    assert.deepEqual(n.calls, [false], "the same display cycle is not retried");
    assert.equal(n.concealed(), false, "a failed notice is never concealed again");
    assert.equal(f.requests.length, 1);
    assert.equal(f.w.document.body.style.overflow, "hidden", "scroll ownership stays native");
    assert.equal(f.shortcuts.blocked, 1);
    assert.deepEqual([f.result().removed, f.result().timedOut], [0, 1]);
});

const nonTargets = {
    "other layer": (n) => n.el.setAttribute("data-nlog-area", "other_layer"),
    "dialog role": (n) => n.el.setAttribute("role", "dialog"),
    "missing aria-modal": (n) => n.el.removeAttribute("aria-modal"),
    "different title": (n) => {
        n.el.querySelector("strong").textContent = "광고 차단 프로그램 설정을 확인해 주세요.";
    },
    "different description": (n) => {
        n.el.querySelector("p").textContent = "광고 차단 프로그램을 끄고 다시 시도해 주세요.";
    },
    "different help link": (n) => n.el.querySelector("a").setAttribute("href", "https://help.naver.com/other"),
    "extra link": (n) => n.el.querySelector("p").append(n.el.querySelector("a").cloneNode(true)),
    "second button": (n) => n.button.parentElement.append(n.button.cloneNode(true)),
    "different button text": (n) => {
        n.button.textContent = "확인하기";
    },
    "submit button": (n) => n.button.setAttribute("type", "submit"),
    "disabled button": (n) => {
        n.button.disabled = true;
    },
    "aria-disabled button": (n) => n.button.setAttribute("aria-disabled", "true"),
    "detached notice": (n) => n.backdrop.remove(),
    "template content": (n) => {
        const template = n.backdrop.ownerDocument.createElement("template");
        n.backdrop.ownerDocument.body.append(template);
        template.content.append(n.backdrop);
    },
    "button moved out of the notice": (n) => n.backdrop.ownerDocument.body.append(n.button),
    "backdrop with another child": (n) => n.backdrop.append(n.backdrop.ownerDocument.createElement("div")),
    "not a dimmed backdrop": (n) => {
        n.backdrop.className = "_layer_10lql_38";
    },
    "nested inside another dialog": (n) => {
        const outer = n.backdrop.ownerDocument.createElement("div");
        outer.setAttribute("role", "dialog");
        outer.append(n.backdrop);
        n.backdrop.ownerDocument.body.append(outer);
    },
    "dialog nested in the notice": (n) => {
        const inner = n.backdrop.ownerDocument.createElement("div");
        inner.setAttribute("role", "dialog");
        n.el.querySelector("p").append(inner);
    },
};

test("non-target and ambiguous notices are not requested and forged requests are refused", async (t) => {
    const f = fixture(t);
    f.options(true);
    for (const [name, change] of Object.entries(nonTargets)) {
        const n = f.notice();
        n.mount();
        change(n);
        await flush();
        assert.equal(f.requests.length, 0, name);
        assert.equal(n.concealed(), false, name);
        assert.equal(f.forge(n.button), true, `${name}: MAIN must not report a call`);
        // The extension's concealment marker is never evidence of a valid target.
        n.el.setAttribute(CLOSING_ATTR, "1");
        assert.equal(f.forge(n.button), true, `${name}: a concealment marker grants no trust`);
        assert.deepEqual(n.calls, [], name);
        f.requests.length = 0;
        n.unmount();
        f.w.document.body.replaceChildren();
        await flush();
    }
    const first = f.notice();
    const second = f.notice();
    first.mount();
    second.mount();
    await flush();
    assert.equal(f.requests.length, 0, "two notices leave ownership unclear");
    assert.equal(f.forge(first.button), true);
    assert.deepEqual([first.calls, second.calls], [[], []]);
    assert.equal(f.status().invoked, 0);
});

const hiddenExactNotices = {
    "display:none button": (n) => {
        n.button.style.display = "none";
    },
    "zero-size button": (n) => {
        n.button.getBoundingClientRect = () => ({ width: 0, height: 0 });
    },
    "visibility:hidden backdrop": (n) => {
        n.backdrop.style.visibility = "hidden";
    },
    "display:none backdrop": (n) => {
        n.backdrop.style.display = "none";
    },
    "zero-size notice": (n) => {
        n.el.getBoundingClientRect = () => ({ width: 0, height: 0 });
    },
};

for (const [name, change] of Object.entries(hiddenExactNotices)) {
    test(`a connected exact notice is handled once even when not painted: ${name}`, async (t) => {
        const f = fixture(t);
        const n = f.notice();
        n.mount();
        change(n);
        f.options(true);
        assert.deepEqual(n.calls, [false], "existence and the current callback decide, not visibility");
        assert.equal(f.requests[0].event.defaultPrevented, true);
        await flush();
        assert.equal(n.backdrop.isConnected, false);
        assert.equal(f.result().last, "removed");
        f.advance(REMOVAL_WAIT_MS);
        assert.deepEqual(n.calls, [false]);
        assert.equal(f.requests.length, 1);
    });
}

for (const pathname of ["/", "/lives", "/category/GAME/x/lives", `${LIVE}/extra`, "/video/abc"]) {
    test(`notices outside live and replay routes are left alone: ${pathname}`, async (t) => {
        const f = fixture(t, { pathname });
        const n = f.notice();
        n.mount();
        f.options(true);
        await flush();
        assert.equal(f.requests.length, 0);
        assert.equal(f.forge(n.button), true);
        assert.deepEqual(n.calls, []);
    });
}

test("the replay notice uses the same exact path", async (t) => {
    const f = fixture(t, { pathname: "/video/12345678" });
    const n = f.notice({ handler: "e=>{e.isTrusted&&m(!1)}", setter: "m" });
    n.mount();
    f.options(true);
    await flush();
    assert.deepEqual(n.calls, [false]);
    assert.equal(n.backdrop.isConnected, false);
});

const reactVariants = {
    "missing button props": (n, key) => delete n.button[key],
    "missing notice props": (n, key) => delete n.el[key],
    "two React copies on the button": (n, key) => {
        n.button.__reactProps$other = { ...n.button[key] };
    },
    "button and notice from different roots": (n, key) => {
        n.el.__reactProps$other = n.el[key];
        delete n.el[key];
    },
    "notice props for another layer": (n, key) => {
        n.el[key] = { ...n.el[key], "data-nlog-area": "other_layer" };
    },
    "disabled props": (n, key) => {
        n.button[key] = { ...n.button[key], disabled: true };
    },
    "non-function onClick": (n, key) => {
        n.button[key] = { ...n.button[key], onClick: "xe(false)" };
    },
};
const unmeasuredHandlers = [
    "e=>{xe(!1)}",
    "e=>{e.isTrusted&&xe(!0)}",
    "e=>{e.isTrusted&&xe(!1);xe.report()}",
    "e=>{e.isTrusted&&(xe(!1),xe.log())}",
    "e=>{e.target.isTrusted&&xe(!1)}",
    "(e,t)=>{e.isTrusted&&xe(!1)}",
    "e=>{e.isTrusted&&xe(false,xe(!1))}",
    "e=>{if(e.isTrusted){xe(false);xe(!1)}}",
    "e=>{if(e.isTrusted){xe(false)}else{xe(false)}}",
    "e=>{if(!e.isTrusted){xe(false)}}",
    "e=>{e.isTrusted&&xe.call(null,false)}",
    "e=>{e.isTrusted&&xe(e.value=false)}",
    "e=>{e.isTrusted&&xe(false);e.report()}",
    "async e=>{e.isTrusted&&xe(false)}",
];

const equivalentConfirmHandlers = [
    "e=>{e.isTrusted&&xe(false)}",
    "(e)=>{e.isTrusted&&xe(!1);}",
    "(event) => { (event.isTrusted) && xe((false)); }",
    "e=>e.isTrusted&&xe(false)",
    "e=>{if(e.isTrusted)xe(false)}",
    "(e)=>{if(e.isTrusted){xe(!1);}}",
];

for (const handler of equivalentConfirmHandlers) {
    test(`one trusted false setter accepts an equivalent expression: ${handler}`, async (t) => {
        const f = fixture(t);
        const n = f.notice({ handler });
        n.mount();
        f.options(true);
        await flush();
        assert.deepEqual(n.calls, [false]);
        assert.equal(n.backdrop.isConnected, false);
        assert.equal(f.result().last, "removed");
        assert.equal(f.forge(n.button), true, "the same button is never called twice");
    });
}

test("notice wording and neutral wrappers preserve the same native confirmation", async (t) => {
    const f = fixture(t);
    const n = f.notice();
    const title = f.w.document.createElement("h2");
    title.textContent = "광고 차단 프로그램을 사용하시나요?";
    n.el.querySelector("strong").replaceWith(title);
    const paragraph = n.el.querySelector("p");
    paragraph.textContent = "광고 차단 프로그램 사용은 재생 환경에 영향을 줄 수 있습니다.";
    const followup = f.w.document.createElement("p");
    followup.textContent = "사용 중인 확장 프로그램이 있다면 삭제한 뒤 서비스를 이용해 주세요.";
    paragraph.after(followup);
    const inside = f.w.document.createElement("div");
    n.el.replaceWith(inside);
    inside.append(n.el);
    n.mount();
    const outside = f.w.document.createElement("div");
    n.backdrop.replaceWith(outside);
    outside.append(n.backdrop);
    f.options(true);
    await flush();
    assert.deepEqual(n.calls, [false]);
    assert.equal(n.backdrop.isConnected, false);
    assert.equal(f.shortcuts.blocked, 0, "only the native close releases modal state");
    assert.equal(f.w.document.body.style.overflow, "");
});

test("semantic notice matching preserves independent anchors and rejects unsafe wrappers", async (t) => {
    const f = fixture(t);
    f.options(true);
    const changes = [
        [
            "missing playback warning",
            (n) => {
                n.el.querySelector("p").textContent =
                    "광고 차단 프로그램 사용 중인 확장 프로그램을 삭제 후 서비스를 이용해 주세요.";
            },
        ],
        [
            "missing extension removal guidance",
            (n) => {
                n.el.querySelector("p").textContent =
                    "광고 차단 프로그램 사용 시 재생 환경에 영향을 미칠 수 있어 서비스를 이용할 수 없습니다.";
            },
        ],
        [
            "different help URL on a revised title",
            (n) => {
                n.el.querySelector("strong").textContent = "광고 차단 프로그램을 사용하시나요?";
                n.el.querySelector("a").href = "https://help.naver.com/alias/navergame/other.naver";
            },
        ],
        [
            "interactive wrapper",
            (n) => {
                const wrapper = f.w.document.createElement("div");
                wrapper.setAttribute("role", "button");
                n.el.replaceWith(wrapper);
                wrapper.append(n.el);
            },
        ],
        [
            "wrapper has another action",
            (n) => {
                const wrapper = f.w.document.createElement("div");
                n.el.replaceWith(wrapper);
                wrapper.append(n.el, f.w.document.createElement("button"));
            },
        ],
        [
            "portal wrapper has another dialog",
            (n) => {
                const wrapper = f.w.document.createElement("div");
                const sibling = f.w.document.createElement("div");
                sibling.setAttribute("role", "dialog");
                n.backdrop.replaceWith(wrapper);
                wrapper.append(n.backdrop, sibling);
            },
        ],
    ];
    for (const [name, change] of changes) {
        const n = f.notice();
        n.mount();
        change(n);
        await flush();
        assert.deepEqual(n.calls, [], name);
        assert.equal(f.requests.length, 0, `${name}: isolated refuses`);
        assert.equal(f.forge(n.button), true, `${name}: MAIN refuses`);
        assert.equal(n.concealed(), false, name);
        f.requests.length = 0;
        n.unmount();
        f.w.document.body.replaceChildren();
        await flush();
    }
});

test("React links must be current, unique and the measured confirm shape", async (t) => {
    const f = fixture(t);
    f.options(true);
    const cases = [
        ...Object.entries(reactVariants).map(([name, change]) => [name, MEASURED_HANDLER, change]),
        ...unmeasuredHandlers.map((handler) => [handler, handler, () => {}]),
    ];
    for (const [name, handler, change] of cases) {
        const n = f.notice({ handler });
        change(n, f.reactKey);
        n.mount();
        await flush();
        assert.equal(n.visible(), true, `${name}: a refused request never conceals the notice`);
        f.frame();
        assert.deepEqual(n.calls, [], name);
        assert.equal(n.visible(), true, name);
        assert.equal(n.concealed(), false, name);
        assert.equal(f.requests.length, 1, name);
        assert.equal(f.requests[0].event.defaultPrevented, false, name);
        n.el.className += " later-change";
        await flush();
        assert.equal(f.requests.length, 1, `${name}: no retry in the same display cycle`);
        f.requests.length = 0;
        n.unmount();
        await flush();
    }
    assert.deepEqual(f.status(), { status: "refused", invoked: 0, refused: cases.length });
    assert.deepEqual([f.result().refused, f.result().removed], [cases.length, 0]);
});

test("a throwing callback leaves the notice for manual confirmation and is not repeated", async (t) => {
    const f = fixture(t);
    const n = f.notice();
    n.button[f.reactKey].onClick = f.w.eval("(xe) => e=>{e.isTrusted&&xe(!1)}")(() => {
        n.calls.push("threw");
        throw new Error("native setter failed");
    });
    n.mount();
    f.options(true);
    assert.equal(n.visible(), true, "a thrown callback is not concealed");
    await flush();
    f.frame();
    assert.deepEqual(n.calls, ["threw"]);
    assert.equal(n.visible(), true);
    assert.equal(n.concealed(), false);
    assert.equal(f.forge(n.button), true, "MAIN does not call the same button twice");
    n.el.className += " later-change";
    await flush();
    assert.deepEqual(n.calls, ["threw"]);
    assert.deepEqual(f.status(), { status: "refused", invoked: 0, refused: 2 });
    assert.deepEqual([f.result().last, f.result().refused], ["refused", 1]);
});

test("without the MAIN helper the notice stays visible and no state is forced", async (t) => {
    const f = fixture(t, { main: false });
    const n = f.notice();
    n.mount();
    f.options(true);
    assert.equal(n.visible(), true, "an unanswered request is not concealed");
    await flush();
    f.frame();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].event.defaultPrevented, false);
    assert.deepEqual(n.calls, []);
    assert.equal(n.visible(), true);
    assert.equal(n.concealed(), false);
    assert.equal(f.w.document.body.style.overflow, "hidden");
    assert.equal(f.result().last, "refused");
    f.advance(REMOVAL_WAIT_MS * 2);
    assert.equal(n.concealed(), false, "a refused notice is never concealed later");
});

test("only the callback currently attached to the button is called", async (t) => {
    const f = fixture(t);
    const n = f.notice();
    const current = [];
    n.button[f.reactKey] = {
        ...n.button[f.reactKey],
        onClick: f.w.eval(`(xe) => ${MEASURED_HANDLER}`)((value) => {
            current.push(value);
            n.unmount();
        }),
    };
    n.mount();
    f.options(true);
    assert.deepEqual(n.calls, [], "a superseded callback is never called");
    assert.deepEqual(current, [false]);
    assert.equal(n.backdrop.isConnected, false);
});

test("button replacement and remount call only the current node's callback", async (t) => {
    const f = fixture(t);
    const n = f.notice({ closes: false });
    n.mount();
    f.options(true);
    await flush();
    f.frame();
    assert.deepEqual(n.calls, [false]);
    const replacementCalls = [];
    const replacement = n.button.cloneNode(true);
    replacement[f.reactKey] = {
        ...n.button[f.reactKey],
        onClick: f.w.eval(`(xe) => ${MEASURED_HANDLER}`)((value) => {
            replacementCalls.push(value);
            n.unmount();
        }),
    };
    n.button.replaceWith(replacement);
    await flush();
    assert.deepEqual(replacementCalls, [false], "the replaced node is a new display state");
    assert.deepEqual(n.calls, [false], "the old node's callback is never reused");
    assert.equal(n.backdrop.isConnected, false);
    assert.equal(f.result().removed, 1, "a replaced button is not counted as a native close");
});

test("repeated displays stop at the per-route limit and resume on a different route", async (t) => {
    const f = fixture(t);
    f.options(true);
    const shown = [];
    for (let index = 0; index < 3; index += 1) {
        const n = f.notice();
        n.mount();
        await flush();
        f.frame();
        shown.push(n);
    }
    assert.deepEqual(
        shown.map((n) => n.calls),
        [[false], [false], []]
    );
    const third = shown[2];
    assert.equal(third.visible(), true, "a recurring notice is left for manual confirmation");
    f.options(false);
    f.options(true);
    await flush();
    assert.deepEqual(third.calls, [], "toggling the option does not reset the route limit");
    f.navigate("/live/0123456789abcdef0123456789abcdef");
    await flush();
    assert.deepEqual(third.calls, [false]);
    assert.equal(third.backdrop.isConnected, false);
    f.navigate(`${LIVE}?from=search`);
    const fourth = f.notice();
    fourth.mount();
    await flush();
    assert.deepEqual(fourth.calls, [false], "a different path starts its own limit");
    assert.deepEqual(f.status(), { status: "invoked", invoked: 4, refused: 0 });
});

test("OFF, SPA and BFCache during a pending native removal never call again", async (t) => {
    const f = fixture(t);
    const n = f.notice({ closes: "manual" });
    n.mount();
    f.options(true);
    assert.deepEqual(n.calls, [false]);
    assert.equal(n.concealed(), true);
    f.navigate(`${LIVE}/`);
    await flush();
    assert.equal(n.concealed(), false, "route changes restore the concealment immediately");
    assert.deepEqual(n.calls, [false], "the already called button is not called on the new route");
    f.w.dispatchEvent(new f.w.PageTransitionEvent("pageshow", { persisted: true }));
    await flush();
    f.frame();
    assert.deepEqual(n.calls, [false]);
    f.options(false);
    assert.equal(n.visible(), true);
    f.advance(REMOVAL_WAIT_MS * 2);
    assert.equal(n.concealed(), false, "no late timer re-conceals after OFF");
    n.commit();
    await flush();
    assert.equal(n.backdrop.isConnected, false);
    const next = f.notice();
    next.mount();
    await flush();
    f.frame();
    assert.deepEqual(next.calls, [], "OFF never requests a callback");
    assert.equal(f.requests.length, 1);
});

test("route changes cancel a pending wait and its late timer never touches a new notice", async (t) => {
    const f = fixture(t);
    const first = f.notice({ closes: "manual" });
    first.mount();
    f.options(true);
    assert.equal(first.concealed(), true);
    f.advance(400);
    f.navigate("/live/0123456789abcdef0123456789abcdef");
    assert.equal(first.concealed(), false, "the previous generation's concealment is released at once");
    assert.equal(f.result().last, "cancelled");
    first.commit();
    await flush();
    const second = f.notice({ closes: "manual" });
    second.mount();
    await flush();
    assert.deepEqual(second.calls, [false]);
    assert.equal(second.concealed(), true);
    f.advance(REMOVAL_WAIT_MS - 400);
    assert.equal(second.concealed(), true, "the first notice's deadline does not reveal the second");
    f.advance(399);
    assert.equal(second.concealed(), true);
    f.advance(1);
    assert.equal(second.visible(), true);
    assert.equal(f.result().last, "timeout");
    assert.deepEqual(first.calls, [false]);
});

test("pagehide releases a pending concealment and BFCache return does not call again", async (t) => {
    const f = fixture(t);
    const n = f.notice({ closes: "manual" });
    n.mount();
    f.options(true);
    assert.equal(n.concealed(), true);
    f.w.dispatchEvent(new f.w.PageTransitionEvent("pagehide", { persisted: true }));
    assert.equal(n.visible(), true, "a page leaving the document keeps no hidden notice");
    assert.equal(f.result().last, "cancelled");
    f.w.dispatchEvent(new f.w.PageTransitionEvent("pageshow", { persisted: true }));
    f.advance(REMOVAL_WAIT_MS * 2);
    f.frame();
    await flush();
    assert.deepEqual(n.calls, [false]);
    assert.equal(n.concealed(), false);
    assert.equal(f.requests.length, 1);
});

test("the generic close path's frame restore never reveals a notice awaiting removal", async (t) => {
    const f = fixture(t);
    const closable = f.w.document.createElement("div");
    closable.setAttribute("role", "alertdialog");
    closable.innerHTML = '<strong>광고 차단 안내</strong><button type="button" aria-label="닫기">닫기</button>';
    closable.getBoundingClientRect = () => ({ width: 300, height: 200 });
    let closeClicks = 0;
    closable.querySelector("button").addEventListener("click", () => closeClicks++);
    f.w.document.body.append(closable);
    const n = f.notice({ closes: "manual" });
    n.mount();
    f.options(true);
    assert.equal(closeClicks, 1);
    assert.equal(closable.getAttribute(CLOSING_ATTR), "1");
    assert.equal(n.concealed(), true);
    f.frame();
    assert.equal(closable.hasAttribute(CLOSING_ATTR), false, "the generic popup keeps its next-frame restore");
    assert.equal(n.concealed(), true, "the exact notice keeps waiting for its own removal");
    n.commit();
    await flush();
    assert.equal(f.result().last, "removed");
});

test("chat focus, other dialogs and the existing close path are preserved", async (t) => {
    const f = fixture(t);
    const chat = f.w.document.createElement("div");
    chat.contentEditable = "true";
    chat.tabIndex = 0;
    f.w.document.body.append(chat);
    chat.focus();
    const other = f.w.document.createElement("div");
    other.setAttribute("role", "dialog");
    other.innerHTML = '<p>로그인이 필요합니다</p><button type="button">확인</button>';
    other.getBoundingClientRect = () => ({ width: 300, height: 200 });
    let otherClicks = 0;
    other.querySelector("button").addEventListener("click", () => otherClicks++);
    f.w.document.body.append(other);
    const closable = f.w.document.createElement("div");
    closable.setAttribute("role", "alertdialog");
    closable.innerHTML = '<strong>광고 차단 안내</strong><button type="button" aria-label="닫기">닫기</button>';
    closable.getBoundingClientRect = () => ({ width: 300, height: 200 });
    let closeClicks = 0;
    closable.querySelector("button").addEventListener("click", () => {
        closeClicks++;
        closable.remove();
    });
    f.w.document.body.append(closable);
    const n = f.notice();
    n.mount();
    f.options(true);
    await flush();
    assert.deepEqual(n.calls, [false]);
    assert.equal(closeClicks, 1, "notices with a close control keep the click path");
    assert.equal(otherClicks, 0);
    assert.equal(f.requests.length, 1, "only the exact notice is requested");
    assert.equal(f.w.document.activeElement, chat);
    assert.equal(other.isConnected, true);
});

test("the MAIN helper installs once, needs no extension globals and acts only on requests", async (t) => {
    const dom = new JSDOM("<!doctype html><body></body>", {
        url: `https://chzzk.naver.com${LIVE}`,
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    w.HTMLButtonElement.prototype.getBoundingClientRect = () => ({ width: 402, height: 46 });
    const source = read("features/adblockPopupPage.js");
    assert.doesNotMatch(
        source,
        /CheeseSpanner|chrome\.|\bisTrusted\s*=|Event\.prototype|addEventListener\(\s*["']click/
    );
    w.eval(source);
    w.eval(source);
    const backdrop = w.document.createElement("div");
    backdrop.className = "_dimmed_jao35_2";
    backdrop.innerHTML = NOTICE_HTML;
    const el = backdrop.firstElementChild;
    el.getBoundingClientRect = () => ({ width: 450, height: 300 });
    const button = el.querySelector("button");
    const calls = [];
    el.__reactProps$x = { role: "alertdialog", "data-nlog-area": "ad_blocking_info_layer" };
    button.__reactProps$x = { type: "button", onClick: w.eval(`(xe) => ${MEASURED_HANDLER}`)((v) => calls.push(v)) };
    w.document.body.append(backdrop);
    // MAIN judges identity and the current callback, not visibility (the notice is concealed before the call).
    backdrop.style.display = "none";
    await flush();
    assert.deepEqual(calls, [], "MAIN never scans or acts without a request");
    assert.equal(button.dispatchEvent(new w.Event(REQUEST, { cancelable: true })), false);
    assert.equal(button.dispatchEvent(new w.Event(REQUEST, { cancelable: true })), true);
    assert.deepEqual(calls, [false], "a duplicate install or request does not call twice");
});
