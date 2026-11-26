const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { waitForCondition } = require("./helpers/wait-for-condition.js");

const repoRoot = path.join(__dirname, "..");
const CHANNEL_A = "a".repeat(32);
const CHANNEL_B = "b".repeat(32);
const MESSAGE_TIME = 1794700800000;
const NATIVE_ROLE = "data-bcct-native-nickname-role";
const FILTERED = "data-bcct-keyword-filtered";
const STYLE_ID = "cheese-spanner-chat-nickname-style";
const BLIND_NOTICE = "메시지가 블라인드 처리되었습니다.";
const read = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");

// Keep the measured author/body structure, but vary the generated CSS module hash.
// Neither a known mark class nor a collection record is required by these fixtures.
function nativeRow({
    id,
    nickname = `작성자 ${id}`,
    text = `금지 ${id}`,
    badge = "구독 배지",
    mark = "",
    module = "nextbuild",
}) {
    const verified = mark
        ? `<i class="_mark_${module}_81 _is_${mark}_${module}_81"><span class="blind">인증 마크</span></i>`
        : "";
    return [
        '<div class="_item_8lqsk_7"><div class="_container_w9pvh_1"><div class="_chatting_message_w9pvh_21">',
        '<button class="_nickname_w9pvh_33" type="button" aria-haspopup="true" aria-expanded="false">',
        '<span class="_container_a6uv5_2 _is_message_a6uv5_5">',
        `<span class="_wrapper_a6uv5_31"><span class="_icon_a6uv5_15"><span class="_container_14814_2"><img alt="${badge}" src="https://ssl.pstatic.net/badge/${id}.png"></span></span></span>`,
        `<span class="_nickname_a6uv5_43"><span class="_ellipsis_${module}_6"><span class="_text_${module}_2">${nickname}</span>${verified}</span></span>`,
        "</span></button>",
        `<span class="_text_w9pvh_1">${text}</span>`,
        "</div></div></div>",
    ].join("");
}

function nativeMessage(
    { id, nickname = `작성자 ${id}`, text = `금지 ${id}`, role = "common_user", grade = null, status = "NORMAL" },
    index = 0
) {
    const user = role === "streamer" ? CHANNEL_A : (index + 1).toString(16).padStart(32, "0");
    return {
        key: id,
        user,
        time: MESSAGE_TIME + index,
        type: 1,
        status,
        content: text,
        originalContent: text,
        profile: { userIdHash: user, nickname, userRoleCode: role, verifiedMarkType: grade },
    };
}

function attachMessage(row, source) {
    row.querySelector('[class*="chatting_message"]').__reactProps$nativeDisplay = {
        children: { props: { chatMessage: source } },
    };
}

const buttonOf = (row) => row.querySelector('button[class*="_nickname_"]');
const nameOf = (row) => buttonOf(row).querySelector('[class*="_ellipsis_"] > [class*="_text_"]');
const bodyOf = (row) => row.querySelector("._text_w9pvh_1");
const hidden = (row) => row.hasAttribute(FILTERED);
const clipped = (window, row) => window.getComputedStyle(nameOf(row)).clipPath === "inset(50%)";

function captureNativeContent(row) {
    const body = bodyOf(row);
    const badges = Array.from(buttonOf(row).querySelectorAll("img, i"));
    return { row, body, html: body.outerHTML, badges, badgeHtml: badges.map((badge) => badge.outerHTML) };
}

function assertNativeContentUnchanged(captured, window) {
    assert.equal(bodyOf(captured.row), captured.body, "the native body node is preserved");
    assert.equal(captured.body.outerHTML, captured.html, "the native body markup is preserved");
    assert.deepEqual(Array.from(buttonOf(captured.row).querySelectorAll("img, i")), captured.badges);
    assert.deepEqual(
        captured.badges.map((badge) => badge.outerHTML),
        captured.badgeHtml
    );
    for (const badge of captured.badges)
        assert.notEqual(window.getComputedStyle(badge).clipPath, "inset(50%)", "badges stay outside the name clip");
}

function fixture(t, cases, { url = `/live/${CHANNEL_A}`, options = {}, extra = "", nativeBridge = true } = {}) {
    const aside = url.startsWith("/video/") ? "vod-aside" : "aside-chatting";
    const dom = new JSDOM(
        `<!doctype html><body>${extra}<aside id="${aside}" class="live_chatting_area"><header class="chat-header"><strong>채팅</strong><button type="button" aria-label="더보기">⋮</button></header><div class="chat-list" role="log">${cases.map(nativeRow).join("")}</div></aside></body>`,
        { url: `https://chzzk.naver.com${url}`, runScripts: "outside-only", pretendToBeVisual: true }
    );
    const { window } = dom;
    const document = window.document;
    const root = document.querySelector(`aside#${aside} [role="log"]`);
    const rows = Array.from(root.children);
    cases.forEach((item, index) => attachMessage(rows[index], nativeMessage(item, index)));
    const listeners = [];
    const sync = {
        chatToolsModeratorBoxEnabled: false,
        chatToolsShowBlindEnabled: false,
        chatKeywordFilterEnabled: true,
        chatKeywordFilterWords: "금지",
        chatNicknameHidden: true,
        ...options,
    };
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
    window.chrome = {
        runtime: {},
        storage: {
            sync: area(sync),
            local: area(),
            onChanged: {
                addListener: (listener) => listeners.push(listener),
                removeListener: (listener) => listeners.splice(listeners.indexOf(listener), 1),
            },
        },
    };
    window.fetch = async () => {
        assert.fail("native display exceptions must not fetch chat messages");
    };
    const published = [];
    for (const file of [
        "features/routeBridgePage.js",
        "features/chatTimestampPage.js",
        "shared/settings.js",
        "shared/data.js",
        "content.js",
        "shared/uiTheme.js",
        "features/chatTools/parser.js",
        "features/chatTools/messageStore.js",
        "features/chatTools/panel.js",
        "features/chatTools.js",
        // Preserve the manifest order: the controller receives option changes before this module.
        "features/chatNicknameDisplay.js",
    ]) {
        if (!nativeBridge && file === "features/chatTimestampPage.js") continue;
        window.eval(read(file));
        if (file === "features/chatTools/messageStore.js") {
            const namespace = window.CheeseSpanner.chatTools;
            const createStore = namespace.createMessageStore;
            namespace.createMessageStore = (config) =>
                createStore({
                    ...config,
                    onChange(messages) {
                        published.push(messages);
                        config.onChange?.(messages);
                    },
                });
        }
    }
    document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
    t.after(() => {
        window.dispatchEvent(new window.Event("pagehide"));
        window.close();
    });
    return {
        window,
        document,
        root,
        rows,
        published,
        writes,
        set(values) {
            const changes = Object.fromEntries(
                Object.entries(values).map(([key, value]) => [key, { oldValue: sync[key], newValue: value }])
            );
            Object.assign(sync, values);
            for (const listener of listeners) listener(changes, "sync");
        },
    };
}

const roleCases = [
    { id: "streamer", role: "streamer", expected: "broadcaster" },
    { id: "channel-manager", role: "streaming_channel_manager", expected: "manager" },
    { id: "chat-manager", role: "streaming_chat_manager", expected: "manager" },
    { id: "partner", grade: "PARTNER", mark: "partner", expected: "partner" },
    { id: "challenger", grade: "CHALLENGER", mark: "challenger", expected: "challenger" },
    { id: "viewer", expected: "none" },
    { id: "platform-manager", role: "manager", badge: "채팅 운영자", expected: "none" },
    { id: "official", grade: "OFFICIAL", mark: "official", expected: "none" },
    { id: "stale-manager", badge: "채팅 운영자", module: "1pcsq", expected: "none" },
    { id: "stale-partner", mark: "partner", module: "1pcsq", expected: "none" },
];

for (const url of [`/live/${CHANNEL_A}`, `/live/${CHANNEL_A}/chat`, "/video/123"]) {
    test(`native role exceptions agree for keyword filtering and nickname hiding with collection OFF on ${url}`, async (t) => {
        const f = fixture(t, roleCases, { url });
        const captured = f.rows.map(captureNativeContent);
        await waitForCondition(() => f.rows.every((row) => buttonOf(row).hasAttribute(NATIVE_ROLE)));
        for (let index = 0; index < roleCases.length; index++) {
            const item = roleCases[index];
            const row = f.rows[index];
            const ordinary = item.expected === "none";
            assert.equal(buttonOf(row).getAttribute(NATIVE_ROLE), item.expected, item.id);
            assert.equal(hidden(row), ordinary, `${item.id}: keyword exception follows native metadata`);
            assert.equal(clipped(f.window, row), ordinary, `${item.id}: only the native nickname is clipped`);
            assert.equal(nameOf(row).textContent, `작성자 ${item.id}`, "accessible author text is unchanged");
            assertNativeContentUnchanged(captured[index], f.window);
        }
        assert.equal(f.document.querySelector(".bcct-moderator-trigger"), null);
        assert.ok(
            f.published.every((messages) => messages.length === 0),
            "display exceptions do not collect messages"
        );
        assert.deepEqual(f.writes, [], "display exceptions do not save chat records or settings");
    });
}

test("manifest-order nickname activation applies native roles without changing the chat DOM", async (t) => {
    const f = fixture(
        t,
        [
            { id: "quiet-manager", role: "streaming_chat_manager", module: "1pcsq" },
            { id: "quiet-viewer", mark: "partner", module: "1pcsq" },
        ],
        { options: { chatKeywordFilterEnabled: false } }
    );
    const [manager, ordinary] = f.rows;
    const captured = f.rows.map(captureNativeContent);
    const rolesApplied = () =>
        buttonOf(manager).getAttribute(NATIVE_ROLE) === "manager" &&
        buttonOf(ordinary).getAttribute(NATIVE_ROLE) === "none";
    await waitForCondition(rolesApplied);
    assert.equal(clipped(f.window, manager), false, "the initially enabled native manager exception is visible");
    assert.equal(clipped(f.window, ordinary), true, "the native viewer overrides the stale DOM partner mark");

    f.set({ chatNicknameHidden: false });
    await waitForCondition(() => f.rows.every((row) => !buttonOf(row).hasAttribute(NATIVE_ROLE)));
    assert.equal(f.document.getElementById(STYLE_ID), null);
    for (const row of f.rows) assert.equal(clipped(f.window, row), false);

    // No row, author, body or badge mutation accompanies either option change.
    f.set({ chatNicknameHidden: true });
    await waitForCondition(rolesApplied);
    assert.equal(clipped(f.window, manager), false, "OFF to ON restores the native manager exception");
    assert.equal(clipped(f.window, ordinary), true);
    captured.forEach((item) => assertNativeContentUnchanged(item, f.window));
    assert.ok(f.rows.every((row) => !hidden(row)));
    assert.ok(f.published.every((messages) => messages.length === 0));
});

test("late MAIN readiness refreshes native exceptions with only the nickname and keyword consumers enabled", async (t) => {
    const f = fixture(
        t,
        [
            { id: "late-manager", role: "streaming_chat_manager" },
            { id: "late-viewer", mark: "partner", module: "1pcsq" },
        ],
        { nativeBridge: false }
    );
    const [manager, ordinary] = f.rows;
    const captured = f.rows.map(captureNativeContent);
    await waitForCondition(() => hidden(manager));
    assert.equal(hidden(ordinary), false, "the initial legacy DOM partner mark is an exception");
    assert.equal(clipped(f.window, ordinary), false);
    for (const row of f.rows) assert.equal(buttonOf(row).hasAttribute(NATIVE_ROLE), false);

    // MAIN readiness must refresh the already mounted rows without another chat DOM mutation.
    f.window.eval(read("features/chatTimestampPage.js"));
    await waitForCondition(
        () =>
            buttonOf(manager).getAttribute(NATIVE_ROLE) === "manager" &&
            buttonOf(ordinary).getAttribute(NATIVE_ROLE) === "none"
    );
    assert.equal(hidden(manager), false);
    assert.equal(hidden(ordinary), true);
    assert.equal(clipped(f.window, manager), false);
    assert.equal(clipped(f.window, ordinary), true);
    captured.forEach((item) => assertNativeContentUnchanged(item, f.window));
    assert.equal(f.document.querySelector(".bcct-moderator-trigger"), null);
    assert.ok(f.published.every((messages) => messages.length === 0));
});

for (const url of [`/live/${CHANNEL_A}`, "/video/123"]) {
    test(`nickname-only activation follows native roles when a row is reused on ${url}`, async (t) => {
        const initial = { id: "only-partner", grade: "PARTNER", mark: "partner", module: "1pcsq" };
        const f = fixture(t, [initial], { url, options: { chatKeywordFilterEnabled: false } });
        const row = f.rows[0];
        await waitForCondition(() => buttonOf(row).getAttribute(NATIVE_ROLE) === "partner");
        assert.equal(clipped(f.window, row), false);

        const ordinary = { id: "reused-viewer", nickname: "일반 시청자", text: "새 일반 본문" };
        attachMessage(row, nativeMessage(ordinary, 1));
        nameOf(row).textContent = ordinary.nickname;
        bodyOf(row).textContent = ordinary.text;
        await waitForCondition(() => buttonOf(row).getAttribute(NATIVE_ROLE) === "none");
        assert.equal(clipped(f.window, row), true, "a stale partner mark cannot keep the former native exception");

        const manager = {
            id: "reused-manager",
            nickname: "새 진행담당",
            text: "새 운영 공지",
            role: "streaming_chat_manager",
        };
        attachMessage(row, nativeMessage(manager, 2));
        nameOf(row).textContent = manager.nickname;
        bodyOf(row).textContent = manager.text;
        await waitForCondition(() => buttonOf(row).getAttribute(NATIVE_ROLE) === "manager");
        assert.equal(clipped(f.window, row), false);
        assert.equal(hidden(row), false);
        assert.equal(f.document.querySelector(".bcct-moderator-trigger"), null);
        assert.ok(f.published.every((messages) => messages.length === 0));
        assert.equal(buttonOf(row).querySelector("i").className, "_mark_1pcsq_81 _is_partner_1pcsq_81");
        assert.equal(bodyOf(row).textContent, manager.text);
    });
}

test("nickname OFF and page lifecycle clear native markers while the keyword consumer keeps its own state", async (t) => {
    const f = fixture(t, [
        { id: "ordinary", mark: "partner", module: "1pcsq" },
        { id: "partner", grade: "PARTNER", mark: "partner" },
    ]);
    const captured = f.rows.map(captureNativeContent);
    await waitForCondition(() => f.rows.every((row) => buttonOf(row).hasAttribute(NATIVE_ROLE)));
    f.set({ chatNicknameHidden: false });
    await waitForCondition(() => f.rows.every((row) => !buttonOf(row).hasAttribute(NATIVE_ROLE)));
    assert.equal(f.document.getElementById(STYLE_ID), null);
    assert.equal(hidden(f.rows[0]), true);
    assert.equal(hidden(f.rows[1]), false);
    for (const row of f.rows) assert.equal(clipped(f.window, row), false);

    f.set({ chatNicknameHidden: true, chatKeywordFilterEnabled: false });
    await waitForCondition(() => f.rows.every((row) => buttonOf(row).hasAttribute(NATIVE_ROLE) && !hidden(row)));
    assert.equal(clipped(f.window, f.rows[0]), true);
    assert.equal(clipped(f.window, f.rows[1]), false);
    f.window.dispatchEvent(new f.window.Event("pagehide"));
    for (const row of f.rows) assert.equal(buttonOf(row).hasAttribute(NATIVE_ROLE), false);
    f.window.dispatchEvent(new f.window.Event("pageshow"));
    await waitForCondition(() => f.rows.every((row) => buttonOf(row).hasAttribute(NATIVE_ROLE)));
    assert.equal(clipped(f.window, f.rows[0]), true);
    assert.equal(clipped(f.window, f.rows[1]), false);
    captured.forEach((item) => assertNativeContentUnchanged(item, f.window));
});

test("native nickname markers follow the active chat root and are cleared across SPA exit and reentry", async (t) => {
    const f = fixture(t, [{ id: "old-partner", grade: "PARTNER", mark: "partner" }], {
        options: { chatKeywordFilterEnabled: false },
    });
    const oldRow = f.rows[0];
    const oldContent = captureNativeContent(oldRow);
    await waitForCondition(() => buttonOf(oldRow).getAttribute(NATIVE_ROLE) === "partner");
    const replacement = f.root.cloneNode(false);
    const next = { id: "new-viewer", mark: "partner", module: "1pcsq" };
    replacement.innerHTML = nativeRow(next);
    const current = replacement.firstElementChild;
    attachMessage(current, nativeMessage(next, 1));
    const currentContent = captureNativeContent(current);
    f.root.replaceWith(replacement);
    await waitForCondition(() => buttonOf(current).getAttribute(NATIVE_ROLE) === "none");
    assert.equal(buttonOf(oldRow).hasAttribute(NATIVE_ROLE), false, "the replaced root releases its native markers");
    assert.equal(clipped(f.window, current), true);
    assertNativeContentUnchanged(oldContent, f.window);

    f.window.history.pushState({}, "", "/category");
    await waitForCondition(() => !buttonOf(current).hasAttribute(NATIVE_ROLE));
    assertNativeContentUnchanged(currentContent, f.window);
    const returned = { id: "new-channel-manager", role: "streaming_channel_manager" };
    replacement.innerHTML = nativeRow(returned);
    const fresh = replacement.firstElementChild;
    attachMessage(fresh, nativeMessage(returned, 2));
    f.window.history.pushState({}, "", `/live/${CHANNEL_B}`);
    await waitForCondition(() => buttonOf(fresh).getAttribute(NATIVE_ROLE) === "manager");
    assert.equal(clipped(f.window, fresh), false);
    assert.equal(buttonOf(current).hasAttribute(NATIVE_ROLE), false);
    assert.equal(f.document.querySelector(".bcct-moderator-trigger"), null);
});

test("a late blind original keeps native manager keyword exceptions and rejects stale viewer badges", async (t) => {
    const cases = [
        {
            id: "delayed-blind-manager",
            role: "streaming_chat_manager",
            text: BLIND_NOTICE,
            status: "BLIND",
            module: "1pcsq",
        },
        {
            id: "delayed-blind-viewer",
            text: BLIND_NOTICE,
            status: "BLIND",
            mark: "partner",
            module: "1pcsq",
        },
    ];
    const f = fixture(t, cases, { options: { chatToolsShowBlindEnabled: true } });
    const sources = cases.map((item, index) => nativeMessage({ ...item, text: "" }, index));
    f.rows.forEach((row, index) => attachMessage(row, sources[index]));
    const [manager, ordinary] = f.rows;
    const bodies = f.rows.map(bodyOf);
    await waitForCondition(
        () =>
            buttonOf(manager).getAttribute(NATIVE_ROLE) === "manager" &&
            buttonOf(ordinary).getAttribute(NATIVE_ROLE) === "none"
    );
    for (const row of f.rows) {
        assert.equal(row.querySelector(".bcct-blind-reveal"), null);
        assert.equal(hidden(row), false);
    }

    // Only MAIN data changes. The bounded notice recheck must apply the same native role decision.
    sources.forEach((source, index) => {
        source.content = `금지 원문 ${index}`;
        source.originalContent = source.content;
    });
    await waitForCondition(() =>
        f.rows.every(
            (row, index) => row.querySelector(".bcct-blind-reveal")?.textContent === sources[index].originalContent
        )
    );
    assert.equal(hidden(manager), false, "the native manager remains exempt after its original arrives");
    assert.equal(hidden(ordinary), true, "the native viewer cannot borrow the remaining partner badge");
    assert.equal(clipped(f.window, manager), false);
    assert.equal(clipped(f.window, ordinary), true);
    f.rows.forEach((row, index) => {
        assert.equal(bodyOf(row), bodies[index]);
        assert.equal(bodyOf(row).textContent, BLIND_NOTICE);
    });
    assert.ok(f.published.every((messages) => messages.length === 0));
});

test("VOD consumes native display roles without enabling live originals, collection or comment filtering", async (t) => {
    const blind = { id: "vod-blind", text: BLIND_NOTICE };
    const cases = [{ id: "vod-manager", role: "streaming_chat_manager" }, { id: "vod-viewer" }, blind];
    const comment = { id: "comment", module: "1pcsq" };
    const f = fixture(t, cases, {
        url: "/video/123",
        options: { chatToolsModeratorBoxEnabled: true, chatToolsShowBlindEnabled: true },
        extra: `<section class="comment-list" role="log">${nativeRow(comment)}</section>`,
    });
    attachMessage(f.rows[2], nativeMessage({ ...blind, text: "금지 원문은 복구하지 않음", status: "BLIND" }, 2));
    await waitForCondition(() => buttonOf(f.rows[0]).getAttribute(NATIVE_ROLE) === "manager" && hidden(f.rows[1]));
    assert.equal(hidden(f.rows[0]), false);
    assert.equal(clipped(f.window, f.rows[0]), false);
    assert.equal(clipped(f.window, f.rows[1]), true);
    assert.equal(bodyOf(f.rows[2]).textContent, BLIND_NOTICE);
    assert.equal(hidden(f.rows[2]), false, "only the native blind notice is eligible for VOD filtering");
    assert.equal(f.document.querySelector(".bcct-blind-reveal"), null);
    assert.equal(f.document.querySelector(".bcct-moderator-trigger"), null);
    assert.ok(f.published.every((messages) => messages.length === 0));
    for (const row of f.rows) assert.equal(row.hasAttribute("data-bcct-source-original"), false);
    const commentRow = f.document.querySelector("section.comment-list").firstElementChild;
    assert.equal(hidden(commentRow), false);
    assert.equal(buttonOf(commentRow).hasAttribute(NATIVE_ROLE), false);
    assert.equal(clipped(f.window, commentRow), false);
    assert.equal(bodyOf(commentRow).textContent, "금지 comment");
});
