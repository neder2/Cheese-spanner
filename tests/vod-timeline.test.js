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
const HOUR_MS = 60 * 60 * 1000;
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

test("normalizeVideoDetail uses empty strings and NaN for unavailable values", () => {
    const normalized = normalizeVideoDetail({
        duration: "unknown",
        liveOpenDate: "not-a-date",
        nextVideo: { duration: 0 },
    });

    assert.equal(normalized.videoNo, "");
    assert.equal(normalized.title, "");
    assert.equal(Number.isNaN(normalized.durationSeconds), true);
    assert.equal(Number.isNaN(normalized.startMs), true);
    assert.equal(Number.isNaN(normalized.endMs), true);
    assert.equal(normalized.olderVideoNo, "");
    assert.equal(Number.isNaN(normalized.olderDurationSeconds), true);
});

test("resolveSegmentStartInfo reports an unavailable start without fetching links", async () => {
    let fetchCount = 0;
    const result = await resolveSegmentStartInfo(
        {
            duration: 3600,
            nextVideo: { videoNo: "older", duration: SPLIT_SECONDS },
        },
        {
            fetchDetail: async () => {
                fetchCount += 1;
                return makeOlderDetail("older");
            },
        }
    );

    assert.equal(Number.isNaN(result.originalStartMs), true);
    assert.equal(result.segmentOffsetMs, 0);
    assert.equal(Number.isNaN(result.segmentStartMs), true);
    assert.equal(fetchCount, 0);
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

test("resolveSegmentStartInfo aligns an inferred third segment to a 34 hour offset", async () => {
    const result = await resolveSegmentStartInfo(makeCurrentDetail({ offsetMs: SPLIT_MS * 2 }));

    assert.equal(result.segmentOffsetMs, SPLIT_MS * 2);
    assert.equal(result.segmentStartMs, START_MS + SPLIT_MS * 2);
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

test("resolveSegmentStartInfo prefers a positive linked offset over an inferred offset", async () => {
    const { current, details } = makeLinkedFixture(1);
    current.liveCloseDate = new Date(START_MS + SPLIT_MS * 2 + HOUR_MS).toISOString();

    const result = await resolveSegmentStartInfo(current, {
        fetchDetail: async (videoNo) => details[videoNo],
    });

    assert.equal(result.segmentOffsetMs, SPLIT_MS);
});

test("resolveSegmentStartInfo stops before fetching a summary that is not about 17 hours", async () => {
    let fetchCount = 0;
    const result = await resolveSegmentStartInfo(
        makeCurrentDetail({ nextVideo: { videoNo: "short", duration: SPLIT_SECONDS - 121 } }),
        {
            fetchDetail: async () => {
                fetchCount += 1;
                return makeOlderDetail("short");
            },
        }
    );

    assert.equal(fetchCount, 0);
    assert.equal(result.segmentOffsetMs, 0);
});

test("resolveSegmentStartInfo stops when an older detail start differs by more than one minute", async () => {
    const result = await resolveSegmentStartInfo(
        makeCurrentDetail({ nextVideo: { videoNo: "older", duration: SPLIT_SECONDS } }),
        {
            fetchDetail: async () => ({
                ...makeOlderDetail("older"),
                liveOpenDate: new Date(START_MS + 60 * 1000 + 1).toISOString(),
            }),
        }
    );

    assert.equal(result.segmentOffsetMs, 0);
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

test("resolveSegmentStartInfo rejects an already aborted signal before fetching", async () => {
    const controller = new dom.window.AbortController();
    controller.abort();
    let fetchCount = 0;

    await assert.rejects(
        resolveSegmentStartInfo(makeLinkedFixture(1).current, {
            signal: controller.signal,
            fetchDetail: async () => {
                fetchCount += 1;
            },
        }),
        (error) => error?.name === "AbortError"
    );
    assert.equal(fetchCount, 0);
});

test("resolveSegmentStartInfo propagates a fetch AbortError even without an aborted signal", async () => {
    const abortError = new Error("aborted by fetch");
    abortError.name = "AbortError";

    await assert.rejects(
        resolveSegmentStartInfo(makeLinkedFixture(1).current, {
            fetchDetail: async () => {
                throw abortError;
            },
        }),
        (error) => error === abortError
    );
});

test("mergeBroadcastSegment creates a new first entry and a new ordered videoNos array", () => {
    const incoming = {
        startMs: START_MS,
        endMs: START_MS + HOUR_MS,
        duration: 3600,
        videoNos: ["first"],
        videoNo: "second",
        title: "첫 방송",
    };
    const snapshot = structuredClone(incoming);

    const result = mergeBroadcastSegment(null, incoming);

    assert.notEqual(result, incoming);
    assert.notEqual(result.videoNos, incoming.videoNos);
    assert.deepEqual(Array.from(result.videoNos), ["first", "second"]);
    assert.deepEqual(incoming, snapshot);
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
