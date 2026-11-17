const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repoRoot = path.join(__dirname, "..");
const REQUEST_EVENT = "cheese-spanner:chat-blind-source-request";
const RESPONSE_ATTR = "data-bcct-source-message";
const ORIGINAL_ATTR = "data-bcct-source-original";
const READY_ATTR = "data-cheese-spanner-chat-timestamp-page-ready";
const BLIND_NOTICE = "메시지가 블라인드 처리되었습니다.";

function verifiedMark(grade = "partner") {
    return `<i class="_mark_1pcsq_81 _is_${grade}_1pcsq_81"><span class="blind">인증 마크</span></i>`;
}

function createParser(t, { badge = "", mark = "", body = "안내", extra = "" } = {}) {
    const dom = new JSDOM(
        `<aside id="aside-chatting"><div role="log"><div class="_item_future_7"><div class="_chatting_message_future_21">${badge}<button class="_nickname_future_33" style="color:rgb(10, 20, 30)"><span class="_nickname_other_43">작성자${mark}</span></button><span class="_text_future_1">${body}</span>${extra}</div></div></div></aside>`,
        {
            url: `https://chzzk.naver.com/live/${"a".repeat(32)}`,
            runScripts: "outside-only",
            pretendToBeVisual: true,
        }
    );
    t.after(() => dom.window.close());
    for (const filename of ["shared/settings.js", "shared/data.js", "content.js", "features/chatTools/parser.js"])
        dom.window.eval(fs.readFileSync(path.join(repoRoot, filename), "utf8"));
    const row = dom.window.document.querySelector("._item_future_7");
    return {
        dom,
        row,
        container: row.querySelector("._chatting_message_future_21"),
        body: row.querySelector("._text_future_1"),
        author: row.querySelector("button"),
        parser: dom.window.CheeseSpanner.chatTools.parser,
    };
}

function nativeMessage(overrides = {}) {
    return {
        key: "native-message-1",
        user: "current-author",
        time: Date.now() - 1000,
        status: "NORMAL",
        nickname: "작성자",
        roleCode: "common_user",
        roleState: "known",
        verifiedMarkType: null,
        verifiedMark: null,
        verifiedState: "known",
        normalText: "안내",
        normalEmojis: {},
        ...overrides,
    };
}

function readNative(h, message, { duringRequest, keepOriginal = false, parsed: previousParsed } = {}) {
    const parsed = previousParsed || h.parser.parseChatRow(h.row);
    let detail;
    h.container.addEventListener(
        REQUEST_EVENT,
        (event) => {
            detail = JSON.parse(event.detail);
            h.container.setAttribute(RESPONSE_ATTR, JSON.stringify(message));
            duringRequest?.();
        },
        { once: true }
    );
    const source = h.parser.readPageMessage(h.row, parsed, keepOriginal);
    const result = h.parser.enrichChatRole(parsed, source);
    assert.equal(h.container.hasAttribute(RESPONSE_ATTR), false);
    assert.equal(h.container.hasAttribute(ORIGINAL_ATTR), false);
    return { parsed, source, result, detail };
}

const managerBadge = '<span class="badge" aria-label="매니저"></span>';

test("native room roles use exact enums and keep platform operators out of channel managers", (t) => {
    const h = createParser(t, { badge: managerBadge });
    const cases = [
        ["streamer", "broadcaster", "broadcaster"],
        ["streaming_channel_manager", "manager", "manager"],
        ["streaming_chat_manager", "manager", "manager"],
        ["manager", "operator", ""],
        ["common_user", "viewer", ""],
    ];
    for (const [roleCode, roomRole, role] of cases) {
        const { result } = readNative(h, nativeMessage({ roleCode }));
        assert.equal(result.roomRole, roomRole, roleCode);
        assert.equal(result.role, role, roleCode);
        assert.equal(result.roleSource, "native");
        assert.equal(result.nativeTextMatches, true);
        assert.equal(result.nativeCoherent, true);
    }
});

test("unsupported role strings never regain the old DOM manager badge", (t) => {
    const h = createParser(t, { badge: managerBadge });
    for (const roleCode of ["explicitmanager", "submanager", "admin", "operator", "STREAMER", "streamer-extra"]) {
        const { result } = readNative(h, nativeMessage({ roleCode }));
        assert.equal(result.role, "", roleCode);
        assert.equal(result.roomRole, "unknown", roleCode);
    }
    const { result } = readNative(h, nativeMessage({ roleCode: null, roleState: "invalid" }));
    assert.equal(result.role, "");
});

test("verified type is separate from room role and preserves the existing collection scope", (t) => {
    const h = createParser(t);
    for (const [verifiedMarkType, expected] of [
        ["PARTNER", "partner"],
        ["CHALLENGER", "challenger"],
        ["OFFICIAL", ""],
        [null, ""],
    ]) {
        const { result } = readNative(h, nativeMessage({ verifiedMarkType }));
        assert.equal(result.roomRole, "viewer");
        assert.equal(result.verifiedMarkType, verifiedMarkType);
        assert.equal(result.role, expected);
    }
    const { result: channelManager } = readNative(
        h,
        nativeMessage({ roleCode: "streaming_chat_manager", verifiedMarkType: "PARTNER" })
    );
    assert.equal(channelManager.role, "manager");
    assert.equal(channelManager.verifiedMarkType, "PARTNER");
    const { result: operatorPartner } = readNative(
        h,
        nativeMessage({ roleCode: "manager", verifiedMarkType: "PARTNER" })
    );
    assert.equal(operatorPartner.roomRole, "operator");
    assert.equal(operatorPartner.role, "partner");
});

test("unknown, conflicting, explicit-none and boolean-only verification do not inherit a DOM grade", (t) => {
    const h = createParser(t, { mark: verifiedMark() });
    const cases = [
        { verifiedMarkType: "FUTURE_TYPE" },
        { verifiedState: "invalid", verifiedMarkType: null },
        { verifiedMarkType: "PARTNER", verifiedMark: false },
        { verifiedMarkType: null, verifiedMark: false },
        { verifiedMarkType: null, verifiedMark: true },
        { verifiedMarkType: "OFFICIAL" },
    ];
    for (const fields of cases) {
        const { result } = readNative(h, nativeMessage(fields));
        assert.equal(result.role, "", JSON.stringify(fields));
        assert.notEqual(result.verifiedMarkType, "PARTNER");
    }
});

test("metadata falls back independently only for the missing role or verified axis", (t) => {
    const h = createParser(t, { badge: managerBadge, mark: verifiedMark() });
    const { result: ordinary } = readNative(h, nativeMessage({ verifiedState: "missing", verifiedMarkType: null }));
    assert.equal(ordinary.roomRole, "viewer", "known ordinary users cannot inherit a channel role");
    assert.equal(ordinary.role, "partner", "a missing grade may use the current author mark");

    const { result: missingRole } = readNative(h, nativeMessage({ roleState: "missing", roleCode: null }));
    assert.equal(missingRole.roomRole, "manager");
    assert.equal(missingRole.verifiedMarkType, null, "explicit absence overrides the old verified mark");
    assert.equal(missingRole.role, "manager");

    const { result: bothMissing } = readNative(
        h,
        nativeMessage({ roleState: "missing", roleCode: null, verifiedState: "missing" })
    );
    assert.equal(bothMissing.roleSource, "dom");
    assert.equal(bothMissing.role, "manager");
    assert.equal(bothMissing.verifiedMarkType, "PARTNER");
});

test("legacy snapshots without new fields keep DOM roles while a ready but unavailable bridge does not", (t) => {
    const h = createParser(t, { badge: managerBadge });
    const legacy = { key: "legacy", user: "author", time: Date.now() - 1000, status: "NORMAL", nickname: "작성자" };
    const { result: legacyResult } = readNative(h, legacy);
    assert.equal(legacyResult.role, "manager");
    assert.equal(legacyResult.nativeCoherent, null);
    const parsed = h.parser.parseChatRow(h.row);
    const notReady = h.parser.readPageMessage(h.row, parsed);
    assert.equal(notReady, null);
    assert.equal(h.parser.enrichChatRole(parsed, notReady).role, "manager");
    h.dom.window.document.documentElement.setAttribute(READY_ATTR, "1");
    const unavailable = h.parser.readPageMessage(h.row, parsed);
    assert.equal(unavailable.message, null);
    const result = h.parser.enrichChatRole(parsed, unavailable);
    assert.equal(result.role, "");
    assert.equal(result.roleSource, "unavailable");
    assert.equal(result.nativeCoherent, false);
});

test("unknown CSS hashes still collect validated metadata without changing DOM text or assigning state", (t) => {
    const h = createParser(t, { mark: '<i class="_mark_future_81 _is_partner_future_81"></i>' });
    const initialMarkup = h.row.outerHTML;
    const { parsed, result, detail } = readNative(h, nativeMessage({ verifiedMarkType: "PARTNER" }));
    assert.equal(parsed.role, "");
    assert.equal(result.role, "partner");
    assert.equal(result.authorEl, h.author);
    assert.equal(result.authorColor, "rgb(10, 20, 30)");
    assert.equal(result.text, parsed.text);
    assert.equal(result.textKey, parsed.textKey);
    assert.equal(result.id, undefined);
    assert.equal(h.row.outerHTML, initialMarkup);
    assert.deepEqual(detail, ["작성자", "안내", false]);
    const requested = readNative(h, nativeMessage(), { keepOriginal: true });
    assert.deepEqual(requested.detail, ["작성자", "안내", true]);
});

test("an enriched parse can request the bridge again while retaining its original DOM role snapshot", (t) => {
    const h = createParser(t, { badge: managerBadge, mark: verifiedMark("challenger") });
    const message = nativeMessage({ verifiedMarkType: "PARTNER" });
    const { result: enriched } = readNative(h, message);
    assert.equal(enriched.roomRole, "viewer");
    assert.equal(enriched.domRoomRole, "manager");
    assert.equal(enriched.verifiedMarkType, "PARTNER");
    assert.equal(enriched.domVerifiedMarkType, "CHALLENGER");

    const repeated = readNative(h, message, { parsed: enriched, keepOriginal: true });
    assert.equal(repeated.source.message.key, message.key);
    assert.equal(repeated.result.role, "partner");
    assert.equal(repeated.result.domRoomRole, "manager");
    assert.equal(repeated.result.domVerifiedMarkType, "CHALLENGER");

    h.author.querySelector("i").className = "_mark_1pcsq_81 _is_partner_1pcsq_81";
    const changed = readNative(h, message, { parsed: enriched });
    assert.equal(changed.source.message, null, "re-reading cannot replace the earlier DOM snapshot with a fresh one");
    assert.equal(changed.result.role, "");
});

test("a new native role never classifies an earlier DOM body, including profiles without role metadata", (t) => {
    const h = createParser(t, { badge: managerBadge, body: "이전 메시지" });
    for (const fields of [
        { roleCode: "streaming_chat_manager" },
        { roleCode: null, roleState: "missing", verifiedState: "missing" },
    ]) {
        const { parsed, result } = readNative(h, nativeMessage({ normalText: "새 메시지", ...fields }));
        assert.equal(result.role, "");
        assert.equal(result.nativeTextMatches, false);
        assert.equal(result.nativeCoherent, false);
        assert.equal(parsed.role, "manager", "enrichment must not mutate a prior DOM parse");
        assert.equal(result.text, "이전 메시지");
    }
    h.body.textContent = "새 메시지";
    const { result } = readNative(h, nativeMessage({ normalText: "새 메시지", roleCode: "streaming_chat_manager" }));
    assert.equal(result.role, "manager");
    assert.equal(result.nativeCoherent, true);
});

test("new native metadata without a NORMAL body waits for a coherent snapshot", (t) => {
    const h = createParser(t, { badge: managerBadge });
    const { result } = readNative(h, nativeMessage({ normalText: null, roleCode: "streaming_chat_manager" }));
    assert.equal(result.role, "");
    assert.equal(result.nativeTextMatches, null);
    assert.equal(result.nativeCoherent, false);
    h.body.textContent = BLIND_NOTICE;
    const { result: blind } = readNative(
        h,
        nativeMessage({ status: "BLIND", normalText: null, roleCode: "streaming_chat_manager" })
    );
    assert.equal(blind.role, "manager");
    assert.equal(blind.nativeCoherent, true);
});

test("a new blinded native message waits for its notice without blocking its original-text response", (t) => {
    const h = createParser(t);
    for (const status of ["BLIND", "HIDDEN"]) {
        h.body.textContent = "이전 일반 본문";
        const message = nativeMessage({
            key: `new-${status}`,
            user: "new-author",
            status,
            normalText: null,
            normalEmojis: null,
            roleCode: "streaming_chat_manager",
        });
        const originalRequest = {
            keepOriginal: true,
            duringRequest: () => h.container.setAttribute(ORIGINAL_ATTR, "새 메시지의 검증된 원문"),
        };
        const pending = readNative(h, message, originalRequest);
        assert.equal(pending.source.message.key, message.key);
        assert.equal(pending.source.original, "새 메시지의 검증된 원문");
        assert.equal(pending.result.text, "이전 일반 본문");
        assert.equal(pending.result.nativeCoherent, false);
        assert.equal(pending.result.role, "");

        h.body.textContent = BLIND_NOTICE;
        const settled = readNative(h, message, originalRequest);
        assert.equal(settled.result.isBlind, true);
        assert.equal(settled.result.nativeCoherent, true);
        assert.equal(settled.result.role, "manager");
        assert.equal(settled.source.original, "새 메시지의 검증된 원문");
    }

    h.body.textContent = "일반 메시지";
    const { result: normal } = readNative(
        h,
        nativeMessage({ normalText: "일반 메시지", roleCode: "streaming_chat_manager" })
    );
    assert.equal(normal.nativeTextMatches, true);
    assert.equal(normal.nativeCoherent, true);
    assert.equal(normal.role, "manager");
});

test("visible body comparison joins native DOM fragments without changing the existing display text", (t) => {
    const h = createParser(t, { body: '연결<a href="https://example.com">주소</a>입니다' });
    const { parsed, result } = readNative(h, nativeMessage({ normalText: "연결주소입니다", roleCode: "streamer" }));
    assert.equal(result.nativeTextMatches, true);
    assert.equal(result.role, "broadcaster");
    assert.equal(result.text, parsed.text);
    assert.equal(result.textKey, parsed.textKey);
});

test("native emoji URLs match the displayed image while display tokens and textKey remain DOM-owned", (t) => {
    const src = "https://ssl.pstatic.net/static/nng/glive/icon/f_32.png";
    const h = createParser(t, { body: `안녕<button><img src="${src}" alt=""></button>하세요` });
    const { parsed, result } = readNative(
        h,
        nativeMessage({ normalText: "안녕{:hello:}하세요", normalEmojis: { "{:hello:}": src }, roleCode: "streamer" })
    );
    assert.equal(result.nativeTextMatches, true);
    assert.equal(result.role, "broadcaster");
    assert.match(result.text, /\[이모티콘:f_32\]/);
    assert.equal(result.text, parsed.text);
    assert.equal(result.textKey, parsed.textKey);
    assert.notEqual(result.textKey, result.text);
});

test("native phinf emojis use the current renderer's f60_60 URL transformation", (t) => {
    const raw = "https://nng-phinf.pstatic.net/20261116/hello.png?type=original#old";
    const h = createParser(t, {
        body: '<button><img src="https://nng-phinf.pstatic.net/20261116/hello.png?type=f60_60" alt="안녕"></button>',
    });
    const { result } = readNative(
        h,
        nativeMessage({ normalText: "{:hello:}", normalEmojis: { "{:hello:}": raw }, verifiedMarkType: "CHALLENGER" })
    );
    assert.equal(result.nativeTextMatches, true);
    assert.equal(result.role, "challenger");
});

test("emoji order, count and image URL must match even when their display names are equal", (t) => {
    const a = "https://ssl.pstatic.net/static/nng/glive/a/same.png";
    const b = "https://ssl.pstatic.net/static/nng/glive/b/same.png";
    const h = createParser(t, { body: `<img src="${a}" alt="같음"><img src="${b}" alt="같음">` });
    const message = nativeMessage({
        normalText: "{:one:}{:two:}",
        normalEmojis: { "{:one:}": a, "{:two:}": b },
        roleCode: "streaming_chat_manager",
    });
    assert.equal(readNative(h, message).result.nativeTextMatches, true);
    for (const body of [
        `<img src="${b}" alt="같음"><img src="${a}" alt="같음">`,
        `<img src="${a}" alt="같음">`,
        `<img src="${a}" alt="같음"><img src="${a}" alt="같음">`,
    ]) {
        h.body.innerHTML = body;
        const { result } = readNative(h, message);
        assert.equal(result.nativeTextMatches, false);
        assert.equal(result.role, "");
    }
});

test("unmapped emoji codes only match literal text and never an arbitrary image", (t) => {
    const h = createParser(t, { body: "{:unknown:}" });
    const message = nativeMessage({ normalText: "{:unknown:}", normalEmojis: {}, roleCode: "streamer" });
    assert.equal(readNative(h, message).result.nativeTextMatches, true);
    h.body.innerHTML = '<img src="https://ssl.pstatic.net/static/nng/glive/icon/unknown.png" alt="unknown">';
    const { result } = readNative(h, message);
    assert.equal(result.nativeTextMatches, false);
    assert.equal(result.role, "");
});

test("unavailable emoji maps cannot confirm literal token bodies or oversized native token snapshots", (t) => {
    const h = createParser(t, { body: "{:unknown:}" });
    for (const normalEmojis of [null, undefined]) {
        const message = nativeMessage({ normalText: "{:unknown:}", normalEmojis, roleCode: "streamer" });
        const { source, result } = readNative(h, message);
        assert.equal(source.message.key, message.key, "unavailable body proof must preserve the validated identity");
        assert.equal(result.nativeTextMatches, false);
        assert.equal(result.nativeCoherent, false);
        assert.equal(result.role, "");
    }

    const oversizedTokens = Array.from({ length: 65 }, (_, index) => `{:token_${index}:}`).join(" ");
    h.body.textContent = oversizedTokens;
    const { result: oversized } = readNative(
        h,
        nativeMessage({ normalText: oversizedTokens, normalEmojis: null, roleCode: "streaming_chat_manager" })
    );
    assert.equal(oversized.nativeTextMatches, false);
    assert.equal(oversized.role, "");

    h.body.textContent = "안내";
    const { result: plainText } = readNative(h, nativeMessage({ normalEmojis: null, roleCode: "streamer" }));
    assert.equal(plainText.nativeTextMatches, true, "a plain text body does not require an emoji map");
    assert.equal(plainText.role, "broadcaster");
});

test("body role words, badge images and profile popup marks are not author role evidence", (t) => {
    const h = createParser(t, {
        body: `매니저 <img alt="채팅 운영자" src="https://ssl.pstatic.net/static/nng/glive/icon/manager.png"> ${verifiedMark()}`,
        extra: `<div role="dialog"><span class="nickname">다른 작성자${verifiedMark()}</span></div>`,
    });
    const parsed = h.parser.parseChatRow(h.row);
    assert.equal(parsed.role, "");
    assert.equal(h.parser.enrichChatRole(parsed, null).role, "");
    const { result } = readNative(h, nativeMessage({ normalText: "매니저" }));
    assert.equal(result.role, "");
    assert.equal(result.roomRole, "viewer");
});

test("a response for another author or malformed identity cannot supply a role", (t) => {
    const h = createParser(t, { badge: managerBadge });
    for (const fields of [
        { nickname: "다른 작성자" },
        { key: "" },
        { user: "other/author" },
        { time: 1 },
        { status: "UNKNOWN" },
    ]) {
        const { source, result } = readNative(h, nativeMessage({ roleCode: "streamer", ...fields }));
        assert.equal(source.message, null, JSON.stringify(fields));
        assert.equal(result.role, "");
        assert.equal(result.nativeCoherent, false);
    }
});

test("a changed row ID, author, route, role or body during the bridge request invalidates its snapshot", (t) => {
    const mutations = [
        (h) => h.row.setAttribute("data-message-id", "a-different-message"),
        (h) => (h.author.textContent = "다른 작성자"),
        (h) => h.dom.window.history.replaceState({}, "", `/live/${"b".repeat(32)}`),
        (h) => (h.body.textContent = "다른 본문"),
        (h) => h.row.querySelector(".badge").remove(),
        (h) => h.author.insertAdjacentHTML("beforeend", verifiedMark()),
    ];
    for (const mutate of mutations) {
        const h = createParser(t, { badge: managerBadge });
        h.row.setAttribute("data-message-id", "original-message");
        const { source, result } = readNative(h, nativeMessage({ roleCode: "streamer" }), {
            duringRequest: () => mutate(h),
        });
        assert.equal(source.message, null);
        assert.equal(result.role, "");
    }
});

test("a src-only body change during a native request is rejected even with unchanged visible text", (t) => {
    const src = "https://ssl.pstatic.net/static/nng/glive/a/same.png";
    const h = createParser(t, { body: `<img src="${src}" alt="같음">` });
    const { source, result } = readNative(
        h,
        nativeMessage({ normalText: "{:same:}", normalEmojis: { "{:same:}": src }, roleCode: "streamer" }),
        {
            duringRequest: () => {
                h.body.querySelector("img").src = "https://ssl.pstatic.net/static/nng/glive/b/same.png";
            },
        }
    );
    assert.equal(source.message, null);
    assert.equal(result.role, "");
});

test("native response limits reject malformed metadata and preserve bounded normal text", (t) => {
    const h = createParser(t);
    const invalid = [
        { roleState: "guess" },
        { roleCode: {} },
        { verifiedMark: "true" },
        { normalText: "x".repeat(2001) },
        { normalEmojis: [] },
        { normalEmojis: { "{:test:}": "https://example.com/image.png" } },
        { normalEmojis: { arbitrary: "https://ssl.pstatic.net/static/nng/glive/icon/a.png" } },
        { padding: "x".repeat(32768) },
    ];
    for (const fields of invalid) {
        const { source, result } = readNative(h, nativeMessage(fields));
        assert.equal(source.message, null, JSON.stringify(fields).slice(0, 80));
        assert.equal(result.role, "");
    }
    const text = "가".repeat(2000);
    h.body.textContent = text;
    const { source, result } = readNative(h, nativeMessage({ normalText: text, roleCode: "streamer" }));
    assert.equal(source.message.normalText.length, 2000);
    assert.equal(result.role, "broadcaster");
});
