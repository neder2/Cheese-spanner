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

test("main video selection excludes native ad media and extension previews during replacement", (t) => {
    const dom = new JSDOM(
        '<!doctype html><video id="main"></video><div data-role="gvAdContainerEl"><video id="gv"></video></div><div data-role="imaAdContainerEl"><video id="ima"></video></div><div id="midAdPlayerWrapper"><video id="midPlayer"></video></div><div data-bcfp-tooltip="1"><video></video></div>',
        { url: "https://chzzk.naver.com/video/123", runScripts: "outside-only" }
    );
    t.after(() => dom.window.close());
    const w = dom.window;
    const main = w.document.getElementById("main");
    for (const video of w.document.querySelectorAll("video"))
        video.getBoundingClientRect = () => ({ width: video === main ? 320 : 1920, height: 1080 });
    w.eval(readRepoFile("content.js"));
    assert.equal(w.BetterChzzk.utils.getMainVideoElement(), main);
    main.remove();
    assert.equal(w.BetterChzzk.utils.getMainVideoElement(), null, "ads never become the fallback main video");
    const replacement = w.document.createElement("video");
    w.document.body.append(replacement);
    assert.equal(w.BetterChzzk.utils.getMainVideoElement(), replacement);
});
