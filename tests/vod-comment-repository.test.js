const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const MODEL_SOURCE = fs.readFileSync(path.join(ROOT, "features/vodComments/model.js"), "utf8");
const REPOSITORY_SOURCE = fs.readFileSync(path.join(ROOT, "features/vodComments/repository.js"), "utf8");

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}

function apiComment(id, content = `댓글 ${id}`, overrides = {}) {
    return {
        comment: {
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

function apiContent({ active = true, best = [], next = null, rows = [], totalCount = rows.length } = {}) {
    return {
        bestComments: best,
        commentActive: active,
        comments: {
            data: rows,
            page: { next },
            totalCount,
        },
    };
}

function apiContentWithoutPage(rows, totalCount = rows.length) {
    return {
        bestComments: [],
        commentActive: true,
        comments: { data: rows, totalCount },
    };
}

function createRepositoryFixture(options = {}) {
    const dom = new JSDOM("<!doctype html><html></html>", {
        runScripts: "outside-only",
        url: "https://chzzk.naver.com/video/123",
    });
    dom.window.eval(MODEL_SOURCE);
    dom.window.eval(REPOSITORY_SOURCE);
    const { createCommentRepository } = dom.window.BetterChzzk.vodComments.repository;
    return {
        createCommentRepository,
        dom,
        model: dom.window.BetterChzzk.vodComments.model,
        repository: options.fetchPage ? createCommentRepository(options) : null,
    };
}

test("states are isolated by VOD and sort order", async (t) => {
    const requests = [];
    const fixture = createRepositoryFixture({
        fetchPage(request) {
            requests.push(request);
            return apiContent({ rows: [apiComment(requests.length, `${request.objectId}-${request.orderType}`)] });
        },
    });
    t.after(() => fixture.dom.window.close());
    const repository = fixture.repository;

    await Promise.all([
        repository.loadInitial({ videoNo: "vod-a", order: "POPULAR" }),
        repository.loadInitial({ videoNo: "vod-a", order: "DESC" }),
        repository.loadInitial({ videoNo: "vod-b", order: "POPULAR" }),
    ]);

    const popularA = repository.getState("vod-a", "POPULAR");
    const descA = repository.getState("vod-a", "DESC");
    const popularB = repository.getState("vod-b", "POPULAR");
    assert.notEqual(popularA, descA);
    assert.notEqual(popularA, popularB);
    assert.equal(popularA.items[0].row.comment.content, "vod-a-POPULAR");
    assert.equal(descA.items[0].row.comment.content, "vod-a-DESC");
    assert.equal(popularB.items[0].row.comment.content, "vod-b-POPULAR");
    const renderedVersion = popularA.version;
    repository.setScrollTop(81, { videoNo: "vod-a", order: "POPULAR" });
    assert.equal(popularA.scrollTop, 81);
    assert.equal(popularA.version, renderedVersion, "scroll position must not invalidate rendered comment rows");
    assert.equal(requests.length, 3);
});

test("first-page prefetch and foreground load share one in-flight promise", async (t) => {
    const pending = deferred();
    const requests = [];
    const fixture = createRepositoryFixture({
        fetchPage(request) {
            requests.push(request);
            return pending.promise;
        },
    });
    t.after(() => fixture.dom.window.close());
    const repository = fixture.repository;
    const state = repository.setVideo("123");
    const startingVersion = state.version;

    const prefetch = repository.prefetchInitial();
    assert.equal(state.loading, true);
    assert.ok(state.version > startingVersion);
    assert.equal(state.inFlight, prefetch);
    assert.equal(requests.length, 1);

    const foreground = repository.loadInitial();
    assert.equal(foreground, prefetch);
    pending.resolve(apiContent({ rows: [apiComment(1, "공유된 요청")] }));
    const result = await foreground;

    assert.equal(result.status, "loaded");
    assert.equal(result.state, state);
    assert.equal(result.added.length, 1);
    assert.equal(result.added[0], state.items[0]);
    assert.equal(state.loading, false);
    assert.equal(state.inFlight, null);
    assert.equal(requests.length, 1);
});

test("a hidden prefetch failure stays silent and foreground load retries", async (t) => {
    let calls = 0;
    const fixture = createRepositoryFixture({
        fetchPage() {
            calls += 1;
            if (calls === 1) throw new Error("숨은 실패");
            return apiContent({ rows: [apiComment(1, "재시도 성공")] });
        },
    });
    t.after(() => fixture.dom.window.close());
    const repository = fixture.repository;
    const state = repository.setVideo("123");

    const hiddenResult = await repository.prefetchInitial();
    assert.equal(hiddenResult.status, "error");
    assert.equal(state.error, "");
    assert.equal(state.loaded, false);

    const foregroundResult = await repository.loadInitial();
    assert.equal(foregroundResult.status, "loaded");
    assert.equal(state.items[0].row.comment.content, "재시도 성공");
    assert.equal(calls, 2);
});

test("pagination uses page.next and coalesces duplicate load-more requests", async (t) => {
    const nextPage = deferred();
    const requests = [];
    const fixture = createRepositoryFixture({
        fetchPage(request) {
            requests.push(request);
            if (request.offset === 0) {
                return apiContent({ next: 25, rows: [apiComment(1), apiComment(2)], totalCount: 3 });
            }
            return nextPage.promise;
        },
        pageSize: 2,
    });
    t.after(() => fixture.dom.window.close());
    const repository = fixture.repository;
    const state = repository.setVideo("123");

    await repository.loadInitial();
    assert.equal(state.nextOffset, 25);
    assert.equal(state.hasMore, true);

    const first = repository.loadMore();
    const second = repository.loadMore();
    assert.equal(first, second);
    assert.equal(state.loadingMore, true);
    assert.equal(requests[1].offset, 25);
    nextPage.resolve(apiContent({ next: null, rows: [apiComment(2, "중복"), apiComment(3)], totalCount: 3 }));
    const result = await first;

    assert.equal(result.added.length, 1);
    assert.equal(result.added[0].key, "id:3");
    assert.equal(state.items.length, 3);
    assert.equal(state.hasMore, false);
    assert.equal(requests.length, 2);
});

test("pagination falls back to offset plus row count when page.next is absent", async (t) => {
    const requests = [];
    const fixture = createRepositoryFixture({
        fetchPage(request) {
            requests.push(request);
            return request.offset === 0
                ? apiContentWithoutPage([apiComment(1), apiComment(2)], 3)
                : apiContentWithoutPage([apiComment(3)], 3);
        },
        pageSize: 2,
    });
    t.after(() => fixture.dom.window.close());
    const repository = fixture.repository;
    const state = repository.setVideo("123");

    await repository.loadInitial();
    assert.equal(state.nextOffset, 2);
    assert.equal(state.hasMore, true);
    await repository.loadMore();

    assert.equal(requests[1].offset, 2);
    assert.equal(state.nextOffset, 3);
    assert.equal(state.hasMore, false);
});

test("the comment cap stops pagination and prevents another request", async (t) => {
    let calls = 0;
    const fixture = createRepositoryFixture({
        fetchPage() {
            calls += 1;
            return apiContent({ next: 2, rows: [apiComment(1), apiComment(2)], totalCount: 10 });
        },
        maxCommentsPerOrder: 2,
        pageSize: 2,
    });
    t.after(() => fixture.dom.window.close());
    const repository = fixture.repository;
    const state = repository.setVideo("123");

    await repository.loadInitial();
    const result = await repository.loadMore();

    assert.equal(state.items.length, 2);
    assert.equal(state.capped, true);
    assert.equal(state.hasMore, false);
    assert.equal(result.status, "skipped");
    assert.equal(calls, 1);
});

test("initial and additional page failures remain distinguishable", async (t) => {
    let calls = 0;
    const fixture = createRepositoryFixture({
        fetchPage() {
            calls += 1;
            if (calls === 1) return apiContent({ next: 1, rows: [apiComment(1)] });
            if (calls === 2) throw new Error("다음 페이지 실패");
            return null;
        },
        pageSize: 1,
    });
    t.after(() => fixture.dom.window.close());
    const repository = fixture.repository;
    const state = repository.setVideo("123");

    await repository.loadInitial();
    const moreResult = await repository.loadMore();
    assert.equal(moreResult.status, "error");
    assert.equal(state.error, "");
    assert.equal(state.moreError, "다음 페이지 실패");
    assert.equal(state.items.length, 1);

    const sameState = state;
    const refreshResult = await repository.refresh();
    assert.equal(refreshResult.status, "error");
    assert.equal(repository.getActiveState(), sameState);
    assert.match(state.error, /응답 형식/);
    assert.equal(state.moreError, "");
});

test("reset aborts requests and stale responses cannot update the next VOD", async (t) => {
    const pending = deferred();
    let requestSignal;
    const fixture = createRepositoryFixture({
        fetchPage(request) {
            requestSignal = request.signal;
            return pending.promise;
        },
    });
    t.after(() => fixture.dom.window.close());
    const repository = fixture.repository;
    const oldState = repository.setVideo("old-vod");
    const request = repository.loadInitial();

    const nextState = repository.reset({ videoNo: "new-vod" });
    assert.equal(requestSignal.aborted, true);
    assert.notEqual(nextState, oldState);
    pending.resolve(apiContent({ rows: [apiComment(1, "늦은 댓글")] }));
    const result = await request;

    assert.equal(result.status, "stale");
    assert.equal(oldState.loaded, false);
    assert.equal(oldState.items.length, 0);
    assert.equal(nextState.items.length, 0);
    assert.equal(repository.getVideoNo(), "new-vod");
});

test("BEST dedupe and embedded reply caps bound retained state without mutating input", async (t) => {
    const parentOne = apiComment(1, "첫 부모");
    parentOne.replyComments = [1, 2, 3].map((id) => ({
        commentId: 100 + id,
        commentType: "COMMENT",
        content: `첫 답글 ${id}`,
        user: { userIdHash: `reply-a-${id}`, userNickname: "답글 작성자" },
    }));
    const parentTwo = apiComment(2, "둘째 부모");
    parentTwo.comment.replyComments = [1, 2, 3].map((id) => ({
        commentId: 200 + id,
        commentType: "COMMENT",
        content: `둘째 답글 ${id}`,
        user: { userIdHash: `reply-b-${id}`, userNickname: "답글 작성자" },
    }));
    const parentThree = apiComment(3, "셋째 부모");
    parentThree.replyComments = [1, 2].map((id) => ({
        commentId: 300 + id,
        commentType: "COMMENT",
        content: `셋째 답글 ${id}`,
        user: { userIdHash: `reply-c-${id}`, userNickname: "답글 작성자" },
    }));
    const content = apiContent({
        best: [parentOne],
        rows: [parentOne, parentTwo, parentThree],
        totalCount: 3,
    });
    const before = JSON.parse(JSON.stringify(content));
    const fixture = createRepositoryFixture({
        fetchPage: () => content,
        maxRepliesPerComment: 2,
        maxRepliesPerOrder: 3,
    });
    t.after(() => fixture.dom.window.close());
    const repository = fixture.repository;
    const state = repository.setVideo("123");

    await repository.loadInitial();

    assert.equal(state.items.length, 3);
    assert.equal(state.items[0].best, true);
    assert.equal(state.items[0].row.replyComments.length, 2);
    assert.equal(state.items[1].row.replyComments.length, 1);
    assert.equal(state.items[2].row.replyComments.length, 0);
    assert.equal(state.items[0].row.comment.replyComments.length, 0);
    assert.equal(state.items[1].row.comment.replyComments.length, 0);
    assert.equal(
        state.items.reduce((total, item) => total + item.replyCount, 0),
        3
    );
    assert.equal(state.items[0].repliesCapped, true);
    assert.equal(state.items[1].repliesCapped, true);
    assert.equal(state.items[2].repliesCapped, true);
    assert.equal(fixture.model.collectReplyRows(state.items[0].row).truncated, true);
    assert.equal(fixture.model.collectReplyRows(state.items[1].row).truncated, true);
    assert.equal(fixture.model.collectReplyRows(state.items[2].row).truncated, true);
    assert.deepEqual(content, before);
});
