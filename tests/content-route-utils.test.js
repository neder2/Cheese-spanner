const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repoRoot = path.join(__dirname, "..");

function readRepoFile(...parts) {
    return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

test("live route parsing rejects malformed URI escapes without throwing", () => {
    const dom = new JSDOM("<!doctype html><body></body>", {
        url: "https://chzzk.naver.com/",
        runScripts: "outside-only",
    });
    dom.window.eval(readRepoFile("content.js"));

    const { getLiveChannelIdFromPath } = dom.window.BetterChzzk.utils;
    assert.equal(getLiveChannelIdFromPath("/live/%E0%A4%A"), "");
    assert.equal(getLiveChannelIdFromPath("/live/%"), "");
    assert.equal(getLiveChannelIdFromPath("/live/%ED%85%8C%EC%8A%A4%ED%8A%B8"), "테스트");
    dom.window.close();
});
