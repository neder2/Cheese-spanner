const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const source = fs.readFileSync(path.join(__dirname, "..", "features", "chatTimestampPage.js"), "utf8");
const PROPS_KEY = "__reactProps$nativeSourceTest";
const FIBER_KEY = "__reactFiber$nativeSourceTest";
const REQUEST_EVENT = "cheese-spanner:chat-blind-source-request";
const MESSAGE_ATTR = "data-bcct-source-message";
const ORIGINAL_ATTR = "data-bcct-source-original";
const BLIND_NOTICE = "메시지가 블라인드 처리되었습니다.";

function fixture(t, { vod = false } = {}) {
    const dom = new JSDOM(
        `<!doctype html><body><aside id="${vod ? "vod-aside" : "aside-chatting"}"><div role="log">
        <div class="row"><div class="host"><div class="chatting_message">
        <span class="nickname">viewer</span><span class="text">현재 본문</span>
        </div></div></div></div></aside></body>`,
        {
            url: `https://chzzk.naver.com/${vod ? "video/123" : "live/test-channel"}`,
            runScripts: "outside-only",
        }
    );
    t.after(() => dom.window.close());
    const { document } = dom.window;
    const container = document.querySelector(".chatting_message");
    const host = document.querySelector(".host");
    const body = document.querySelector(".text");
    const native = {
        key: "message-1",
        user: "author-1",
        time: Date.now(),
        status: "NORMAL",
        originalContent: "현재 본문",
        profile: { userIdHash: "author-1", nickname: "viewer" },
    };
    const props = { children: { props: { chatMessage: native } } };
    host[PROPS_KEY] = props;
    dom.window.eval(source);
    function request({ keepOriginal = false, detail } = {}) {
        container.removeAttribute(MESSAGE_ATTR);
        container.removeAttribute(ORIGINAL_ATTR);
        container.dispatchEvent(
            new dom.window.CustomEvent(REQUEST_EVENT, {
                bubbles: true,
                detail:
                    detail === undefined
                        ? JSON.stringify([
                              document.querySelector(".nickname").textContent,
                              body.textContent,
                              keepOriginal,
                          ])
                        : detail,
            })
        );
        const raw = container.getAttribute(MESSAGE_ATTR);
        const result = {
            message: raw === null ? null : JSON.parse(raw),
            original: container.getAttribute(ORIGINAL_ATTR),
            raw,
        };
        container.removeAttribute(MESSAGE_ATTR);
        container.removeAttribute(ORIGINAL_ATTR);
        return result;
    }
    return { dom, document, container, host, body, native, props, request };
}

test("native metadata and the full normal body belong to the same validated message", (t) => {
    const f = fixture(t);
    Object.assign(f.native.profile, {
        userRoleCode: "streaming_chat_manager",
        verifiedMarkType: "PARTNER",
        verifiedMark: true,
        unrelatedProfileData: "must not cross the bridge",
    });
    f.native.originalContent = "  새 공지\n<원문은 문자입니다>  ";
    f.body.textContent = f.native.originalContent;
    const reply = f.request();
    assert.equal(reply.message.key, f.native.key);
    assert.equal(reply.message.user, f.native.user);
    assert.equal(reply.message.nickname, "viewer");
    assert.equal(reply.message.roleCode, "streaming_chat_manager");
    assert.equal(reply.message.roleState, "known");
    assert.equal(reply.message.verifiedMarkType, "PARTNER");
    assert.equal(reply.message.verifiedMark, true);
    assert.equal(reply.message.verifiedState, "known");
    assert.equal(reply.message.normalText, f.native.originalContent);
    assert.deepEqual(reply.message.normalEmojis, {});
    assert.equal(reply.original, null);
    assert.equal(reply.raw.includes("unrelatedProfileData"), false);
    assert.equal(Object.hasOwn(reply.message, "profile"), false);
});

test("known room roles are distinct from absent and unsupported role metadata", (t) => {
    const f = fixture(t);
    for (const role of ["streamer", "streaming_channel_manager", "streaming_chat_manager", "manager", "common_user"]) {
        f.native.profile.userRoleCode = role;
        assert.equal(f.request().message.roleCode, role);
        assert.equal(f.request().message.roleState, "known");
    }
    f.native.profile.userRoleCode = "STREAMER";
    assert.equal(f.request().message.roleCode, "streamer");
    for (const role of [undefined, null, "", "  "]) {
        f.native.profile.userRoleCode = role;
        const reply = f.request().message;
        assert.equal(reply.roleState, "missing");
        assert.equal(reply.roleCode, null);
    }
    for (const role of ["explicitmanager", "future_manager", "owner", " STREAMER ", "manager ", 1, true, {}]) {
        f.native.profile.userRoleCode = role;
        const reply = f.request().message;
        assert.equal(reply.roleState, "invalid");
        assert.equal(reply.roleCode, null);
        assert.equal(reply.key, f.native.key);
    }
});

test("verified metadata preserves explicit none and never turns a boolean into a partner grade", (t) => {
    const f = fixture(t);
    assert.equal(f.request().message.verifiedState, "missing");
    f.native.profile.verifiedMarkType = null;
    assert.equal(f.request().message.verifiedState, "known");
    assert.equal(f.request().message.verifiedMarkType, null);
    delete f.native.profile.verifiedMarkType;
    for (const value of [false, true]) {
        f.native.profile.verifiedMark = value;
        const reply = f.request().message;
        assert.equal(reply.verifiedState, "known");
        assert.equal(reply.verifiedMark, value);
        assert.equal(reply.verifiedMarkType, null);
    }
    delete f.native.profile.verifiedMark;
    for (const grade of ["PARTNER", "CHALLENGER", "OFFICIAL"]) {
        f.native.profile.verifiedMarkType = grade;
        const reply = f.request().message;
        assert.equal(reply.verifiedState, "known");
        assert.equal(reply.verifiedMarkType, grade);
    }
});

test("conflicting or malformed verified metadata is reported without borrowing DOM evidence", (t) => {
    const f = fixture(t);
    for (const metadata of [
        { verifiedMarkType: "PARTNER", verifiedMark: false },
        { verifiedMarkType: "FUTURE_GRADE" },
        { verifiedMarkType: "partner" },
        { verifiedMarkType: " PARTNER " },
        { verifiedMarkType: 1 },
        { verifiedMark: "true" },
        { verifiedMark: {} },
    ]) {
        f.native.profile = { userIdHash: f.native.user, nickname: "viewer", ...metadata };
        const reply = f.request().message;
        assert.equal(reply.verifiedState, "invalid");
        assert.equal(reply.verifiedMarkType, null);
        assert.equal(reply.verifiedMark, null);
    }
});

test("native metadata accessors are not executed", (t) => {
    const f = fixture(t);
    let reads = 0;
    Object.defineProperty(f.native.profile, "userRoleCode", {
        get() {
            reads += 1;
            return "streamer";
        },
    });
    Object.defineProperty(f.native.profile, "verifiedMarkType", {
        get() {
            reads += 1;
            return "PARTNER";
        },
    });
    const reply = f.request().message;
    assert.equal(reads, 0);
    assert.equal(reply.roleState, "invalid");
    assert.equal(reply.verifiedState, "invalid");
});

test("normal bodies above the limit are unavailable rather than truncated into another message", (t) => {
    const f = fixture(t);
    f.native.originalContent = "가".repeat(2000);
    assert.equal(f.request().message.normalText, f.native.originalContent);
    f.native.originalContent += "나";
    const reply = f.request().message;
    assert.equal(reply.key, f.native.key);
    assert.equal(reply.normalText, null);
    assert.equal(reply.normalEmojis, null);
    for (const value of [undefined, null, {}, 1]) {
        f.native.originalContent = value;
        assert.equal(f.request().message.normalText, null);
    }
    f.native.originalContent = BLIND_NOTICE;
    assert.equal(f.request().message.normalText, BLIND_NOTICE);
    assert.equal(f.request().original, null);
});

test("normal emoji replies include only referenced own token URLs for the current message", (t) => {
    const f = fixture(t);
    const url = "https://ssl.pstatic.net/static/nng/glive/icon/test.png";
    f.native.originalContent = "공지 {:wave:} {:wave:}";
    f.native.extras = { emojis: { wave: url, unused: "https://example.test/unrelated.png" } };
    f.body.innerHTML = `공지 <button><img alt="" src="${url}"></button><button><img alt="" src="${url}"></button>`;
    const reply = f.request().message;
    assert.equal(reply.normalText, "공지 {:wave:} {:wave:}");
    assert.deepEqual(reply.normalEmojis, { "{:wave:}": url });
    assert.equal(Object.hasOwn(reply, "extras"), false);
});

test("native emoji mappings known to be absent keep literal tokens distinct from unreadable mappings", (t) => {
    const f = fixture(t);
    f.native.originalContent = "{:wave:} {:literal:}";
    for (const extras of [
        undefined,
        null,
        {},
        { emojis: undefined },
        { emojis: null },
        { emojis: {} },
        { emojis: { wave: "" } },
    ]) {
        f.native.extras = extras;
        const reply = f.request().message;
        assert.equal(reply.normalText, f.native.originalContent);
        assert.deepEqual(reply.normalEmojis, {});
    }
    const url = "https://nng-phinf.pstatic.net/wave.png";
    f.native.extras = { emojis: { wave: url } };
    assert.deepEqual(f.request().message.normalEmojis, { "{:wave:}": url });
});

test("inherited, malformed, unsafe and oversized emoji URLs remain unresolved", (t) => {
    const f = fixture(t);
    f.native.originalContent = "{:wave:}";
    const safe = "https://nng-phinf.pstatic.net/path/image.png";
    for (const emojis of [
        Object.create({ wave: safe }),
        { wave: undefined },
        { wave: null },
        { wave: 1 },
        { wave: "https://example.test/wave.png" },
        { wave: "https://nng-phinf.pstatic.net.evil.test/wave.png" },
        { wave: `${safe}\u0000` },
        { wave: `${safe}\n` },
        { wave: `${safe} ` },
        { wave: `${safe}\u007f` },
        { wave: `https://nng-phinf.pstatic.net/${"a".repeat(2048)}` },
    ]) {
        f.native.extras = { emojis };
        assert.equal(f.request().message.normalEmojis, null);
    }
    let reads = 0;
    f.native.extras = { emojis: {} };
    Object.defineProperty(f.native.extras.emojis, "wave", {
        get() {
            reads += 1;
            return safe;
        },
    });
    assert.equal(f.request().message.normalEmojis, null);
    assert.equal(reads, 0);
});

test("unreadable or inherited emoji containers cannot be reported as known empty mappings", (t) => {
    const safe = "https://nng-phinf.pstatic.net/wave.png";
    for (const inheritedAt of ["extras", "emojis"]) {
        const f = fixture(t);
        f.native.originalContent = "{:wave:}";
        if (inheritedAt === "extras") Object.setPrototypeOf(f.native, { extras: { emojis: { wave: safe } } });
        else f.native.extras = Object.create({ emojis: { wave: safe } });
        assert.equal(f.request().message.normalEmojis, null);
    }
    for (const field of ["extras", "emojis"]) {
        const f = fixture(t);
        f.native.originalContent = "{:wave:}";
        let reads = 0;
        const target = field === "extras" ? f.native : (f.native.extras = {});
        Object.defineProperty(target, field, {
            get() {
                reads += 1;
                return field === "extras" ? { emojis: { wave: safe } } : { wave: safe };
            },
        });
        assert.equal(f.request().message.normalEmojis, null);
        assert.equal(reads, 0);
    }
});

test("emoji count and serialized reply limits preserve identity without a partial body", (t) => {
    const f = fixture(t);
    const codes = Array.from({ length: 65 }, (_, i) => `emoji${i}`);
    f.native.originalContent = codes.map((code) => `{:${code}:}`).join("");
    f.native.extras = {
        emojis: Object.fromEntries(codes.map((code) => [code, `https://ssl.pstatic.net/static/nng/glive/${code}.png`])),
    };
    assert.equal(f.request().message.normalEmojis, null);
    const largeCodes = codes.slice(0, 20);
    f.native.originalContent = largeCodes.map((code) => `{:${code}:}`).join("");
    f.native.extras.emojis = Object.fromEntries(
        largeCodes.map((code) => [code, `https://nng-phinf.pstatic.net/${code}/${"a".repeat(1900)}.png`])
    );
    const reply = f.request();
    assert.equal(reply.message.key, f.native.key);
    assert.equal(reply.message.normalText, null);
    assert.equal(reply.message.normalEmojis, null);
    assert.ok(reply.raw.length <= 32768);
});

test("role, normal body and emoji changes during a synchronous read invalidate the whole snapshot", (t) => {
    const changes = [
        (native) => (native.profile.userRoleCode = "common_user"),
        (native) => (native.originalContent = "다음 메시지 본문"),
        (native) => (native.extras.emojis.wave = "https://nng-phinf.pstatic.net/another.png"),
        (native) => (native.profile = { userIdHash: "another-account", nickname: "viewer" }),
    ];
    for (const change of changes) {
        const f = fixture(t);
        f.native.profile.userRoleCode = "streamer";
        f.native.originalContent = "{:wave:}";
        f.native.extras = { emojis: { wave: "https://nng-phinf.pstatic.net/wave.png" } };
        let reads = 0;
        Object.defineProperty(f.host, PROPS_KEY, {
            get() {
                if (++reads === 2) change(f.native);
                return f.props;
            },
        });
        const reply = f.request();
        assert.equal(reply.message, null);
        assert.equal(reply.original, null);
    }
});

test("normal metadata reads do not populate the optional blind-original cache", (t) => {
    const f = fixture(t);
    assert.equal(f.request({ keepOriginal: false }).message.normalText, "현재 본문");
    f.native.status = "HIDDEN";
    f.native.originalContent = "";
    f.body.textContent = BLIND_NOTICE;
    const reply = f.request({ keepOriginal: true });
    assert.equal(reply.original, null);
    assert.equal(reply.message.normalText, null);
});

test("a route or row change during native validation cannot return an earlier snapshot", (t) => {
    for (const move of [
        (f) => f.dom.window.history.replaceState({}, "", "/live/another-channel"),
        (f) => f.host.remove(),
    ]) {
        const f = fixture(t);
        f.native.profile.userRoleCode = "streamer";
        let reads = 0;
        Object.defineProperty(f.host, PROPS_KEY, {
            get() {
                if (++reads === 2) move(f);
                return f.props;
            },
        });
        assert.equal(f.request().message, null);
    }
});

test("legacy two-field requests retain the live blind-original cache contract", (t) => {
    const f = fixture(t);
    f.request({ detail: JSON.stringify(["viewer", "현재 본문"]) });
    f.native.status = "HIDDEN";
    f.native.originalContent = "";
    f.body.textContent = BLIND_NOTICE;
    assert.equal(f.request({ keepOriginal: true }).original, "현재 본문");
});

test("VOD exposes native role metadata without exposing or caching blind originals", (t) => {
    const f = fixture(t, { vod: true });
    f.native.profile.userRoleCode = "streamer";
    f.native.profile.verifiedMarkType = "PARTNER";
    const normal = f.request({ keepOriginal: true });
    assert.equal(normal.message.roleCode, "streamer");
    assert.equal(normal.message.verifiedMarkType, "PARTNER");
    assert.equal(normal.message.normalText, "현재 본문");
    assert.equal(normal.original, null);
    f.native.status = "HIDDEN";
    f.body.textContent = BLIND_NOTICE;
    const blinded = f.request({ keepOriginal: true });
    assert.equal(blinded.message.roleCode, "streamer");
    assert.equal(blinded.message.normalText, null);
    assert.equal(blinded.original, null);
});

test("a live notice reads role and original from the same current list message", (t) => {
    const f = fixture(t);
    f.native.profile.userRoleCode = "streamer";
    f.body.textContent = BLIND_NOTICE;
    const latest = {
        ...f.native,
        status: "HIDDEN",
        originalContent: "목록 원문",
        profile: { ...f.native.profile, userRoleCode: "common_user", verifiedMarkType: null },
    };
    f.document.querySelector("[role='log']")[FIBER_KEY] = {
        return: {
            memoizedProps: {
                gameChatClient: { config: { streamingChannelId: "test-channel" }, messageList: [latest] },
            },
        },
    };
    const reply = f.request({ keepOriginal: true });
    assert.equal(reply.message.roleCode, "common_user");
    assert.equal(reply.message.status, "HIDDEN");
    assert.equal(reply.message.normalText, null);
    assert.equal(reply.original, "목록 원문");
});

test("visible-author mismatches and malformed requests cannot return native role or body metadata", (t) => {
    const f = fixture(t);
    f.native.profile.userRoleCode = "streamer";
    for (const detail of [
        JSON.stringify(["another author", "현재 본문", false]),
        JSON.stringify(["viewer", "현재 본문", "false"]),
        JSON.stringify(["viewer", "현재 본문", false, "unexpected"]),
        "malformed-json",
    ]) {
        const reply = f.request({ detail });
        assert.equal(reply.message, null);
        assert.equal(reply.original, null);
    }
});

test("literal emoji names shared with ordinary Object keys remain readable", (t) => {
    const f = fixture(t);
    f.native.originalContent = "{:toString:} {:constructor:}";
    f.native.extras = { emojis: new f.dom.window.Object() };
    const reply = f.request().message;
    assert.equal(reply.normalText, f.native.originalContent);
    assert.deepEqual(reply.normalEmojis, {});
});
