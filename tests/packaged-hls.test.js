const assert = require("node:assert/strict");
const test = require("node:test");
const { createDom, evalRepoScript } = require("./helpers/extension-page-fixture.js");
const {
    createCategoryExclusionsStorage,
    createCategoryExclusionsWorker,
} = require("./helpers/category-exclusions-worker.js");

test("a document requests the packaged HLS library only on demand, shares the pending load and retries a failure", async (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "data.js");
    evalRepoScript(dom, "content.js");
    const { utils } = dom.window.CheeseSpanner;
    const calls = [];
    utils.runtimeSendMessage = (message) => new Promise((resolve) => calls.push({ message, resolve }));
    assert.equal(calls.length, 0);
    const first = utils.loadPackagedHls();
    assert.equal(utils.loadPackagedHls(), first);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].message.type, "cheese-spanner:load-hls");
    calls[0].resolve({ ok: false });
    assert.equal(await first, null);
    const retry = utils.loadPackagedHls();
    dom.window.Hls = class {};
    calls[1].resolve({ ok: true });
    assert.equal(await retry, dom.window.Hls);
    assert.equal(await utils.loadPackagedHls(), dom.window.Hls);
    assert.equal(calls.length, 2);
});

test("the worker can load only its packaged library into the requesting CHZZK top document", async () => {
    const storage = createCategoryExclusionsStorage();
    const injected = [];
    storage.chrome.scripting = { executeScript: async (args) => injected.push(structuredClone(args)) };
    const worker = createCategoryExclusionsWorker(storage);
    const sender = {
        id: storage.chrome.runtime.id,
        url: "https://chzzk.naver.com/lives",
        origin: "https://chzzk.naver.com",
        tab: { id: 7 },
        frameId: 0,
        documentId: "document-7",
    };
    const message = { type: "cheese-spanner:load-hls" };
    for (const from of [
        { ...sender, frameId: 1 },
        { ...sender, documentId: "" },
        { ...sender, id: "foreign" },
        { ...sender, url: "https://example.org/" },
        { ...sender, origin: "null" },
    ]) {
        assert.equal((await worker.send(message, from)).ok, false);
    }
    for (const extra of [{ files: ["unexpected.js"] }, { tabId: 3 }, { world: "MAIN" }]) {
        assert.equal((await worker.send({ ...message, ...extra }, sender)).ok, false);
    }
    assert.equal(injected.length, 0);
    assert.equal((await worker.send(message, sender)).ok, true);
    assert.deepEqual(injected, [
        { target: { tabId: 7, documentIds: ["document-7"] }, world: "ISOLATED", files: ["vendor/hls.light.min.js"] },
    ]);
});
