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
for (const file of ["data.js", "vodTimeline.js"]) {
    dom.window.eval(fs.readFileSync(path.join(repoRoot, "shared", file), "utf8"));
}
test.after(() => dom.window.close());

const { resolveSegmentStartInfo } = dom.window.CheeseSpanner.vodTimeline;
const SPLIT_SECONDS = 17 * 60 * 60;
const SPLIT_MS = SPLIT_SECONDS * 1000;
const START_TEXT = "2026-07-10T19:01:32+09:00";
const START_MS = Date.parse(START_TEXT);

// Third segment of a 51 hour broadcast: its own end/duration infers a 34 hour offset.
function thirdSegment() {
    const durationSeconds = 60 * 60;
    return {
        videoNo: "p3",
        liveOpenDate: START_TEXT,
        duration: durationSeconds,
        liveCloseDate: new Date(START_MS + SPLIT_MS * 2 + durationSeconds * 1000).toISOString(),
        nextVideo: { videoNo: "p2", duration: SPLIT_SECONDS },
    };
}

const secondSegment = {
    videoNo: "p2",
    liveOpenDate: START_TEXT,
    duration: SPLIT_SECONDS,
    nextVideo: { videoNo: "p1", duration: SPLIT_SECONDS },
};

for (const [label, failure] of [
    ["an ordinary error", () => Promise.reject(new Error("HTTP 500"))],
    [
        "its own timeout AbortError",
        () => {
            const error = new Error("detail request timed out");
            error.name = "AbortError";
            return Promise.reject(error);
        },
    ],
    ["an unreadable detail", () => Promise.resolve(null)],
]) {
    test(`resolveSegmentStartInfo keeps the inferred offset when the second linked detail fails with ${label}`, async () => {
        const calls = [];
        const result = await resolveSegmentStartInfo(thirdSegment(), {
            fetchDetail: (videoNo) => {
                calls.push(videoNo);
                return videoNo === "p2" ? Promise.resolve(secondSegment) : failure();
            },
        });

        assert.deepEqual(calls, ["p2", "p1"]);
        assert.equal(result.segmentOffsetMs, SPLIT_MS * 2, "one confirmed link is only a lower bound");
        assert.equal(result.segmentStartMs, START_MS + SPLIT_MS * 2);
        // Consumers that cannot infer from the current detail learn that the chain stopped unconfirmed.
        assert.equal(result.linkedChainIncomplete, true);
        assert.deepEqual(Array.from(result.linkedVideoNos), ["p2"]);
    });
}

test("resolveSegmentStartInfo still trusts a confirmed chain end over a larger inference", async () => {
    // Contrast: the older detail belongs to another broadcast, so the confirmed link count is exact.
    const result = await resolveSegmentStartInfo(thirdSegment(), {
        fetchDetail: async (videoNo) =>
            videoNo === "p2"
                ? secondSegment
                : { videoNo: "p1", liveOpenDate: "2026-07-08T10:00:00+09:00", duration: SPLIT_SECONDS },
    });

    assert.equal(result.segmentOffsetMs, SPLIT_MS);
    assert.equal(result.linkedChainIncomplete, false);
    assert.deepEqual(Array.from(result.linkedVideoNos), ["p2"], "only segments of the same broadcast are linked");
});

// R1-25 (r3): stopping at the eight-link cap is not a confirmed chain end.
function tenthSegment({ olderCount }) {
    // The tenth segment of a ten-segment broadcast, published five minutes after it ended.
    const durationSeconds = 60 * 60;
    const current = {
        videoNo: "s10",
        liveOpenDate: START_TEXT,
        duration: durationSeconds,
        publishDate: new Date(START_MS + SPLIT_MS * 9 + durationSeconds * 1000 + 5 * 60000).toISOString(),
        nextVideo: { videoNo: "s9", duration: SPLIT_SECONDS },
    };
    const details = {};
    for (let index = 9; index > 9 - olderCount; index--) {
        details[`s${index}`] = {
            videoNo: `s${index}`,
            liveOpenDate: START_TEXT,
            duration: SPLIT_SECONDS,
            nextVideo:
                index > 1 ? { videoNo: `s${index - 1}`, duration: SPLIT_SECONDS } : { videoNo: "x", duration: 169 },
        };
    }
    return { current, details };
}

test("resolveSegmentStartInfo reports a chain cut by the link cap as incomplete and keeps the larger inference", async () => {
    const { current, details } = tenthSegment({ olderCount: 9 });
    const calls = [];
    const result = await resolveSegmentStartInfo(current, {
        fetchDetail: async (videoNo) => {
            calls.push(videoNo);
            return details[videoNo];
        },
    });

    assert.equal(calls.length, 8, "the cap still bounds the requests");
    assert.equal(result.linkedChainIncomplete, true);
    assert.equal(result.linkedVideoNos.length, 8);
    assert.equal(result.segmentOffsetMs, SPLIT_MS * 9, "the eight links are a lower bound below the inference");
});

test("resolveSegmentStartInfo keeps a chain that ends exactly at the cap complete", async () => {
    // Contrast: the eighth older segment is the first one, whose own link is not a full-length segment.
    const { current, details } = tenthSegment({ olderCount: 9 });
    current.nextVideo = { videoNo: "s8", duration: SPLIT_SECONDS };
    current.publishDate = new Date(START_MS + SPLIT_MS * 8 + 60 * 60 * 1000 + 5 * 60000).toISOString();
    const shifted = {};
    for (let index = 8; index >= 1; index--) {
        shifted[`s${index}`] = {
            ...details[`s${index + 1}`],
            videoNo: `s${index}`,
            nextVideo:
                index > 1 ? { videoNo: `s${index - 1}`, duration: SPLIT_SECONDS } : { videoNo: "x", duration: 169 },
        };
    }
    const result = await resolveSegmentStartInfo(current, { fetchDetail: async (videoNo) => shifted[videoNo] });

    assert.equal(result.linkedChainIncomplete, false);
    assert.equal(result.segmentOffsetMs, SPLIT_MS * 8);
});
