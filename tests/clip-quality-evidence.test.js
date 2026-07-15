const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const fixtureDir = path.join(__dirname, "fixtures", "clip-quality");
const cardFixturePath = path.join(fixtureDir, "observed-card-playback-2026-07-14.json");
const masterFixturePath = path.join(fixtureDir, "observed-master-2026-07-14.m3u8");

function parseMasterStreams(source) {
    return Array.from(source.matchAll(/^#EXT-X-STREAM-INF:(.+)$/gm), (match) => {
        const attributes = Object.fromEntries(
            match[1].split(",").map((entry) => {
                const [key, value] = entry.split("=", 2);
                return [key, value];
            })
        );
        return {
            bandwidth: Number(attributes.BANDWIDTH),
            averageBandwidth: Number(attributes["AVERAGE-BANDWIDTH"]),
            resolution: attributes.RESOLUTION,
        };
    });
}

test("observed clip fixtures preserve only the measured 720p and 480p variants", () => {
    const card = JSON.parse(fs.readFileSync(cardFixturePath, "utf8"));
    const master = fs.readFileSync(masterFixturePath, "utf8");
    const adaptationSets = card.body.card.content.vod.playback.MPD[0].Period[0].AdaptationSet;
    const hlsSet = adaptationSets.find((set) => set["@mimeType"] === "video/mp2t");

    assert.ok(hlsSet, "the observed HLS adaptation set must stay in the fixture");
    assert.deepEqual(
        hlsSet.Representation.map((representation) => ({
            width: Number(representation["@width"]),
            height: Number(representation["@height"]),
            bandwidth: Number(representation["@bandwidth"]),
        })),
        [
            { width: 1280, height: 720, bandwidth: 1496000 },
            { width: 854, height: 480, bandwidth: 878000 },
        ]
    );

    assert.deepEqual(parseMasterStreams(master), [
        { bandwidth: 1754792, averageBandwidth: 1561496, resolution: "1280x720" },
        { bandwidth: 1060696, averageBandwidth: 930321, resolution: "854x480" },
    ]);
});

test("observed clip fixtures contain no original hosts, identifiers, or signed query names", () => {
    const combined = [fs.readFileSync(cardFixturePath, "utf8"), fs.readFileSync(masterFixturePath, "utf8")].join("\n");

    assert.doesNotMatch(combined, /(?:pstatic\.net|creatorhub-api\.naver\.com|chzzk\.naver\.com)/i);
    assert.doesNotMatch(combined, /\b(?:hdnts|hdntl|mediaId|clipUID|seedClipUID|sessionId)\b/i);
    assert.match(combined, /media\.example\.invalid/);
    assert.match(combined, /signature=REDACTED/);
});
