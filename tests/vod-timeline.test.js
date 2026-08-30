const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repoRoot = path.join(__dirname, "..");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "outside-only",
    url: "https://chzzk.naver.com/video/current",
});

function evalRepoScript(...parts) {
    dom.window.eval(fs.readFileSync(path.join(repoRoot, ...parts), "utf8"));
}

evalRepoScript("shared", "data.js");
evalRepoScript("shared", "vodTimeline.js");

const { mergeBroadcastSegment, normalizeVideoDetail, resolveSegmentStartInfo } = dom.window.BetterChzzk.vodTimeline;
const SPLIT_SECONDS = 17 * 60 * 60;
const SPLIT_MS = SPLIT_SECONDS * 1000;
const START_TEXT = "2026-07-10T19:01:32+09:00";
const START_MS = Date.parse(START_TEXT);

test.after(() => dom.window.close());

function makeCurrentDetail({ offsetMs = 0, durationSeconds = 60 * 60, nextVideo, videoNo = "current" } = {}) {
    return {
        videoNo,
        liveOpenDate: START_TEXT,
        duration: durationSeconds,
        liveCloseDate: new Date(START_MS + offsetMs + durationSeconds * 1000).toISOString(),
        nextVideo,
    };
}

function makeOlderDetail(videoNo, nextVideo) {
    return {
        videoNo,
        liveOpenDate: START_TEXT,
        duration: SPLIT_SECONDS,
        nextVideo,
    };
}

function makeLinkedFixture(count) {
    const details = {};
    for (let index = 1; index <= count; index += 1) {
        const nextVideo = index < count ? { videoNo: `segment-${index + 1}`, duration: SPLIT_SECONDS } : undefined;
        details[`segment-${index}`] = makeOlderDetail(`segment-${index}`, nextVideo);
    }
    return {
        current: makeCurrentDetail({
            nextVideo: count > 0 ? { videoNo: "segment-1", duration: SPLIT_SECONDS } : undefined,
        }),
        details,
    };
}

test("normalizeVideoDetail returns the public normalized shape without mutating the source", () => {
    const input = {
        videoNo: 12345,
        videoTitle: "  분할 방송  ",
        duration: "61200",
        liveOpenDate: START_TEXT,
        publishDate: new Date(START_MS + SPLIT_MS).toISOString(),
        nextVideo: {
            videoNo: 12344,
            duration: "61199",
        },
    };
    const snapshot = structuredClone(input);

    const normalized = normalizeVideoDetail(input);

    assert.equal(normalized.videoNo, "12345");
    assert.equal(normalized.title, "분할 방송");
    assert.equal(normalized.durationSeconds, SPLIT_SECONDS);
    assert.equal(normalized.startMs, START_MS);
    assert.equal(normalized.endMs, START_MS + SPLIT_MS);
    assert.equal(normalized.olderVideoNo, "12344");
    assert.equal(normalized.olderDurationSeconds, SPLIT_SECONDS - 1);
    assert.deepEqual(input, snapshot);
});

test("resolveSegmentStartInfo keeps a normal VOD at offset zero", async () => {
    const result = await resolveSegmentStartInfo(makeCurrentDetail());

    assert.equal(result.originalStartMs, START_MS);
    assert.equal(result.segmentOffsetMs, 0);
    assert.equal(result.segmentStartMs, START_MS);
});

test("resolveSegmentStartInfo aligns an inferred second segment to a 17 hour offset", async () => {
    const result = await resolveSegmentStartInfo(makeCurrentDetail({ offsetMs: SPLIT_MS }));

    assert.equal(result.segmentOffsetMs, SPLIT_MS);
    assert.equal(result.segmentStartMs, START_MS + SPLIT_MS);
});

test("resolveSegmentStartInfo ignores an inferred offset beyond the 45 minute tolerance", async () => {
    const result = await resolveSegmentStartInfo(makeCurrentDetail({ offsetMs: SPLIT_MS + 45 * 60 * 1000 + 1 }));

    assert.equal(result.segmentOffsetMs, 0);
    assert.equal(result.segmentStartMs, START_MS);
});

test("resolveSegmentStartInfo follows one linked full-length older segment", async () => {
    const { current, details } = makeLinkedFixture(1);
    const calls = [];
    const result = await resolveSegmentStartInfo(current, {
        fetchDetail: async (videoNo) => {
            calls.push(videoNo);
            return details[videoNo];
        },
    });

    assert.deepEqual(calls, ["segment-1"]);
    assert.equal(result.segmentOffsetMs, SPLIT_MS);
});

test("resolveSegmentStartInfo follows two linked full-length older segments", async () => {
    const { current, details } = makeLinkedFixture(2);
    const calls = [];
    const result = await resolveSegmentStartInfo(current, {
        fetchDetail: async (videoNo) => {
            calls.push(videoNo);
            return details[videoNo];
        },
    });

    assert.deepEqual(calls, ["segment-1", "segment-2"]);
    assert.equal(result.segmentOffsetMs, SPLIT_MS * 2);
});

test("resolveSegmentStartInfo stops a cyclic nextVideo chain", async () => {
    const calls = [];
    const result = await resolveSegmentStartInfo(
        makeCurrentDetail({ nextVideo: { videoNo: "older", duration: SPLIT_SECONDS } }),
        {
            fetchDetail: async (videoNo) => {
                calls.push(videoNo);
                return makeOlderDetail("older", { videoNo: "current", duration: SPLIT_SECONDS });
            },
        }
    );

    assert.deepEqual(calls, ["older"]);
    assert.equal(result.segmentOffsetMs, SPLIT_MS);
});

test("resolveSegmentStartInfo fetches at most eight linked older details", async () => {
    const { current, details } = makeLinkedFixture(8);
    details["segment-8"].nextVideo = { videoNo: "segment-9", duration: SPLIT_SECONDS };
    const calls = [];
    const result = await resolveSegmentStartInfo(current, {
        fetchDetail: async (videoNo) => {
            calls.push(videoNo);
            return details[videoNo];
        },
    });

    assert.deepEqual(
        calls,
        Array.from({ length: 8 }, (_, index) => `segment-${index + 1}`)
    );
    assert.equal(result.segmentOffsetMs, SPLIT_MS * 8);
});

test("resolveSegmentStartInfo falls back to inference after an ordinary linked fetch error", async () => {
    const result = await resolveSegmentStartInfo(
        makeCurrentDetail({
            offsetMs: SPLIT_MS * 2,
            nextVideo: { videoNo: "older", duration: SPLIT_SECONDS },
        }),
        {
            fetchDetail: async () => {
                throw new Error("temporary detail failure");
            },
        }
    );

    assert.equal(result.segmentOffsetMs, SPLIT_MS * 2);
});

test("resolveSegmentStartInfo propagates AbortError and performs no later linked fetch", async () => {
    const { current, details } = makeLinkedFixture(2);
    const controller = new dom.window.AbortController();
    const calls = [];

    await assert.rejects(
        resolveSegmentStartInfo(current, {
            signal: controller.signal,
            fetchDetail: async (videoNo, { signal } = {}) => {
                calls.push(videoNo);
                assert.equal(signal, controller.signal);
                controller.abort();
                return details[videoNo];
            },
        }),
        (error) => error?.name === "AbortError"
    );
    assert.deepEqual(calls, ["segment-1"]);
});

test("resolveSegmentStartInfo falls back to inference after a fetch AbortError without external cancellation", async () => {
    const controller = new dom.window.AbortController();
    const calls = [];
    const result = await resolveSegmentStartInfo(
        makeCurrentDetail({
            offsetMs: SPLIT_MS * 2,
            nextVideo: { videoNo: "older", duration: SPLIT_SECONDS },
        }),
        {
            signal: controller.signal,
            fetchDetail: async (videoNo, { signal } = {}) => {
                calls.push(videoNo);
                assert.equal(signal, controller.signal);
                assert.equal(signal.aborted, false);
                const abortError = new Error("detail request timed out");
                abortError.name = "AbortError";
                throw abortError;
            },
        }
    );

    assert.deepEqual(calls, ["older"]);
    assert.equal(controller.signal.aborted, false);
    assert.equal(result.originalStartMs, START_MS);
    assert.equal(result.segmentOffsetMs, SPLIT_MS * 2);
    assert.equal(result.segmentStartMs, START_MS + SPLIT_MS * 2);
});

test("mergeBroadcastSegment sums duration, recomputes end, and preserves first-entry fields", () => {
    const existing = {
        startMs: START_MS,
        endMs: START_MS + SPLIT_MS,
        duration: SPLIT_SECONDS,
        exact: true,
        time: "19:01",
        videoNos: ["segment-1"],
        title: "처음 제목",
        titleKey: "처음제목",
        auxiliary: "keep",
    };
    const incoming = {
        startMs: START_MS + SPLIT_MS,
        endMs: START_MS + SPLIT_MS * 2,
        duration: SPLIT_SECONDS,
        exact: false,
        time: "12:01",
        videoNo: "segment-2",
        title: "나중 제목",
        titleKey: "나중제목",
    };

    const result = mergeBroadcastSegment(existing, incoming);

    assert.equal(result.startMs, START_MS);
    assert.equal(result.duration, SPLIT_SECONDS * 2);
    assert.equal(result.endMs, START_MS + SPLIT_MS * 2);
    assert.equal(result.exact, true);
    assert.equal(result.time, "19:01");
    assert.equal(result.title, "처음 제목");
    assert.equal(result.titleKey, "처음제목");
    assert.equal(result.auxiliary, "keep");
    assert.deepEqual(Array.from(result.videoNos), ["segment-1", "segment-2"]);
});

test("mergeBroadcastSegment deduplicates video numbers, fills only blank titles, and mutates no input", () => {
    const existing = {
        startMs: START_MS,
        duration: 10,
        videoNos: ["same"],
        videoNo: "same",
        title: "   ",
        titleKey: "",
    };
    const incoming = {
        duration: 20,
        videoNos: ["same", "next"],
        videoNo: "next",
        title: "채운 제목",
        titleKey: "채운제목",
    };
    const existingSnapshot = structuredClone(existing);
    const incomingSnapshot = structuredClone(incoming);

    const result = mergeBroadcastSegment(existing, incoming);

    assert.deepEqual(Array.from(result.videoNos), ["same", "next"]);
    assert.equal(result.title, "채운 제목");
    assert.equal(result.titleKey, "채운제목");
    assert.equal(result.duration, 30);
    assert.equal(result.endMs, START_MS + 30000);
    assert.deepEqual(existing, existingSnapshot);
    assert.deepEqual(incoming, incomingSnapshot);
});

test("vodTimeline public API is frozen and duplicate evaluation is idempotent", () => {
    const api = dom.window.BetterChzzk.vodTimeline;
    evalRepoScript("shared", "vodTimeline.js");

    assert.equal(Object.isFrozen(api), true);
    assert.equal(dom.window.BetterChzzk.vodTimeline, api);
});
