const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const MODEL_SOURCE = fs.readFileSync(path.join(ROOT, "features/vodComments/model.js"), "utf8");

function createModelFixture() {
    const dom = new JSDOM("<!doctype html><html></html>", {
        runScripts: "outside-only",
        url: "https://chzzk.naver.com/video/123",
    });
    dom.window.eval(MODEL_SOURCE);
    return {
        dom,
        model: dom.window.BetterChzzk.vodComments.model,
    };
}

function apiComment(id, content = `댓글 ${id}`, overrides = {}) {
    return {
        comment: {
            attaches: null,
            commentId: id,
            content,
            createdDate: "20260101003000",
            deleted: false,
            hideByCleanBot: false,
            ...overrides.comment,
        },
        user: {
            userIdHash: `user-${id}`,
            userNickname: `작성자 ${id}`,
            ...overrides.user,
        },
        ...overrides.row,
    };
}

function apiContent({ best = [], next = null, rows = [], totalCount = rows.length } = {}) {
    return {
        bestComments: best,
        commentActive: true,
        comments: {
            data: rows,
            page: { next },
            totalCount,
        },
    };
}

test("parseTimecodeSeconds accepts MM:SS and HH:MM:SS while rejecting invalid fields", (t) => {
    const fixture = createModelFixture();
    t.after(() => fixture.dom.window.close());
    const { parseTimecodeSeconds } = fixture.model;

    assert.equal(parseTimecodeSeconds("19:10"), 19 * 60 + 10);
    assert.equal(parseTimecodeSeconds("1:41:55"), 1 * 3600 + 41 * 60 + 55);
    assert.equal(parseTimecodeSeconds(" 09:05 "), 9 * 60 + 5);
    assert.equal(Number.isNaN(parseTimecodeSeconds("10:60")), true);
    assert.equal(Number.isNaN(parseTimecodeSeconds("1:60:00")), true);
    assert.equal(Number.isNaN(parseTimecodeSeconds("1:02:60")), true);
    assert.equal(Number.isNaN(parseTimecodeSeconds("1:2")), true);
    assert.equal(Number.isNaN(parseTimecodeSeconds("100:00:00")), true);
});

test("comment and reply keys are stable without mutating API rows", (t) => {
    const fixture = createModelFixture();
    t.after(() => fixture.dom.window.close());
    const { getCommentKey, getReplyKey } = fixture.model;
    const identified = apiComment(17, "식별 댓글");
    const fallback = apiComment(null, "식별자 없는 댓글", {
        comment: { createdDate: "20260102123456" },
        user: { userIdHash: "fallback-user" },
    });
    const before = JSON.parse(JSON.stringify(fallback));

    assert.equal(getCommentKey(identified, 99), "id:17");
    assert.equal(getCommentKey(fallback, 3), "fallback:20260102123456:fallback-user:식별자 없는 댓글:3");
    assert.equal(getReplyKey("id:1", identified, 0), "reply:id:1:id:17");
    assert.deepEqual(fallback, before);
});

test("comment dates parse as KST and format deterministically with an injected clock", (t) => {
    const fixture = createModelFixture();
    t.after(() => fixture.dom.window.close());
    const { formatCommentDate, parseCommentDate } = fixture.model;
    const parsed = parseCommentDate("20260101003000");

    assert.equal(parsed.getTime(), Date.UTC(2025, 11, 31, 15, 30, 0));
    assert.equal(parseCommentDate("20260231010101"), null);
    assert.equal(parseCommentDate("20260101246000"), null);
    assert.equal(formatCommentDate("20260101003000", parsed.getTime() + 30_000), "방금 전");
    assert.equal(formatCommentDate("20260101003000", parsed.getTime() + 5 * 60_000), "5분 전");
    assert.equal(formatCommentDate("20260101003000", parsed.getTime() + 3 * 3_600_000), "3시간 전");
    assert.equal(formatCommentDate("20260101003000", Date.UTC(2026, 0, 2, 0, 30)), "01.01");
    assert.equal(formatCommentDate("20260101003000", Date.UTC(2027, 0, 2, 0, 30)), "2026.01.01");
    assert.equal(formatCommentDate("잘못된 날짜", parsed.getTime()), "잘못된 날짜");
});

test("BEST and ordinary comment rows deduplicate without modifying the response", (t) => {
    const fixture = createModelFixture();
    t.after(() => fixture.dom.window.close());
    const best = apiComment(1, "BEST 댓글");
    const duplicate = apiComment(1, "일반 목록 중복");
    const ordinary = apiComment(2, "일반 댓글");
    const content = apiContent({ best: [best], rows: [duplicate, ordinary], totalCount: 2 });
    const before = JSON.parse(JSON.stringify(content));

    const result = fixture.model.applyCommentPage([], content, { offset: 0 });

    assert.deepEqual(
        Array.from(result.items, ({ best: isBest, key }) => ({ best: isBest, key })),
        [
            { best: true, key: "id:1" },
            { best: false, key: "id:2" },
        ]
    );
    assert.equal(result.added.length, 2);
    assert.equal(result.totalCount, 2);
    assert.deepEqual(content, before);
});

test("idless BEST and ordinary rows deduplicate by their stable fallback fields", (t) => {
    const fixture = createModelFixture();
    t.after(() => fixture.dom.window.close());
    const best = apiComment(null, "식별자 없는 BEST", {
        comment: { createdDate: "20260102123456" },
        user: { userIdHash: "fallback-user" },
    });
    const duplicate = JSON.parse(JSON.stringify(best));
    const distinctSameFields = JSON.parse(JSON.stringify(best));

    const result = fixture.model.applyCommentPage(
        [],
        apiContent({ best: [best], rows: [duplicate, distinctSameFields] }),
        {
            offset: 0,
        }
    );

    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].best, true);
    assert.equal(result.items[1].best, false);
    assert.match(result.items[0].key, /^fallback:/);
});

test("malformed comment pages are rejected instead of being treated as empty", (t) => {
    const fixture = createModelFixture();
    t.after(() => fixture.dom.window.close());

    assert.throws(() => fixture.model.validateCommentResponse(null), /응답 형식/);
    assert.throws(() => fixture.model.validateCommentResponse({ comments: { data: null } }), /목록 응답/);
    assert.throws(
        () => fixture.model.validateCommentResponse({ bestComments: {}, comments: { data: [] } }),
        /인기 댓글/
    );
});

test("reply sources normalize, deduplicate by commentId, and report the cap", (t) => {
    const fixture = createModelFixture();
    t.after(() => fixture.dom.window.close());
    const direct = {
        commentId: 7,
        commentType: "COMMENT",
        content: "직접 답글",
        user: { userIdHash: "reply-7", userNickname: "답글 작성자" },
    };
    const nested = apiComment(8, "중첩 답글");
    const row = apiComment(1, "부모", {
        comment: { replyComments: [{ ...direct }, nested] },
        row: { replyComments: [direct] },
    });
    const before = JSON.parse(JSON.stringify(row));

    const result = fixture.model.collectReplyRows(row, { maxReplies: 1 });

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].comment.commentId, 7);
    assert.equal(result.rows[0].user.userNickname, "답글 작성자");
    assert.equal(result.truncated, true);
    assert.deepEqual(row, before);
});

test("long comment collapsing keeps exact boundaries and line limits", (t) => {
    const fixture = createModelFixture();
    t.after(() => fixture.dom.window.close());
    const { getCollapsedCommentText } = fixture.model;

    assert.equal(getCollapsedCommentText("가".repeat(420)), "");
    assert.equal(getCollapsedCommentText("가".repeat(421)), `${"가".repeat(420)}…`);
    const lines = Array.from({ length: 13 }, (_, index) => `줄 ${index + 1}`).join("\n");
    const collapsed = getCollapsedCommentText(lines);
    assert.match(collapsed, /줄 12…$/);
    assert.doesNotMatch(collapsed, /줄 13/);
});

test("image and attachment normalization accepts web URLs and drops unsafe data", (t) => {
    const fixture = createModelFixture();
    t.after(() => fixture.dom.window.close());
    const comment = {
        attaches: [
            { attachType: "PHOTO", attachValue: "https://example.com/photo.jpg" },
            { attachType: "STICKER", attachValue: "/sticker.png" },
            { attachType: "EMOTICON", attachValue: "http://example.com/emote.png" },
            { attachType: "PHOTO", attachValue: "javascript:alert(1)" },
            { attachType: "PHOTO", attachValue: "data:image/png;base64,abc" },
            { attachType: "FILE", attachValue: "https://example.com/file.zip" },
        ],
    };
    const before = JSON.parse(JSON.stringify(comment));

    assert.equal(fixture.model.normalizeImageUrl("javascript:alert(1)"), "");
    assert.equal(fixture.model.normalizeImageUrl("data:image/png;base64,abc"), "");
    assert.equal(
        fixture.model.normalizeImageUrl("/avatar.png", "https://chzzk.naver.com/video/123"),
        "https://chzzk.naver.com/avatar.png"
    );
    assert.deepEqual(
        Array.from(fixture.model.normalizeAttachments(comment), ({ src, type }) => ({ src, type })),
        [
            { src: "https://example.com/photo.jpg", type: "PHOTO" },
            { src: "https://chzzk.naver.com/sticker.png", type: "STICKER" },
            { src: "http://example.com/emote.png", type: "EMOTICON" },
        ]
    );
    assert.deepEqual(comment, before);
});
