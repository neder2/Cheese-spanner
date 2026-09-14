const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("retired grid metadata rewriting is absent from the package and option schema", (t) => {
    const manifest = JSON.parse(read("manifest.json"));
    const scripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
    for (const name of ["features/gridBypass.js", "features/gridBypassPage.js"]) {
        assert.equal(fs.existsSync(path.join(root, name)), false);
        assert.equal(scripts.includes(name), false);
    }
    const dom = new JSDOM(read("options.html"), { runScripts: "outside-only" });
    t.after(() => dom.window.close());
    dom.window.eval(read("shared/settings.js"));
    const settings = dom.window.BetterChzzkSettings;
    for (const saved of [true, false]) {
        const normalized = settings.normalizeOptions({
            gridBypassEnabled: saved,
            autoQualityEnabled: false,
            autoQualityPreferred: "720p",
        });
        assert.equal(Object.hasOwn(normalized, "gridBypassEnabled"), false);
        assert.equal(normalized.autoQualityEnabled, false);
        assert.equal(normalized.autoQualityPreferred, "720p");
    }
    assert.equal(dom.window.document.querySelector('[data-option="gridBypassEnabled"]'), null);
    assert.equal(settings.FEATURE_KEYS.includes("gridBypassEnabled"), false);
});

test("auto quality does not rewrite JSON playback metadata even with a stale grid marker", (t) => {
    const dom = new JSDOM("<!doctype html><body></body>", {
        url: "https://chzzk.naver.com/live/measured",
        runScripts: "outside-only",
    });
    const w = dom.window;
    t.after(() => {
        w.document.documentElement.setAttribute("data-betterchzzk-auto-quality-state", '{"enabled":false}');
        w.dispatchEvent(new w.Event("betterchzzk:auto-quality:state"));
        dom.window.close();
    });
    w.document.documentElement.setAttribute("data-betterchzzk-grid-bypass-state", "1");
    const original = w.JSON.parse;
    w.eval(read("features/autoQualityPage.js"));
    assert.equal(w.JSON.parse, original);
    const playback = {
        meta: { p2p: true },
        media: [
            {
                mediaId: "HLS",
                path: "https://livecloud.pstatic.net/master.m3u8",
                p2pPath: "nliveconnector://master",
                encodingTrack: [{ encodingTrackId: "1080p", p2pPath: "nliveconnector://1080p" }],
            },
        ],
    };
    assert.deepEqual(JSON.parse(JSON.stringify(w.JSON.parse(JSON.stringify(playback)))), playback);
});
