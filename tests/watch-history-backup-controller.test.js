const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const {
    root,
    NOW,
    DAY,
    load,
    snapshot,
    chat,
    createFile,
    plain,
} = require("./helpers/watch-history-backup-fixture.js");

function harness() {
    const local = {};
    const listeners = [];
    let writes = 0;
    let reads = 0;
    let failRead = false;
    let failWrite = false;
    let now = NOW;
    class ClockDate extends Date {
        static now() {
            return now;
        }
    }
    const runtime = {
        id: "extension-id",
        lastError: null,
        getURL: (file) => `chrome-extension://extension-id/${file}`,
        getManifest: () => ({ version: "1.4.0" }),
        onInstalled: { addListener() {} },
        onMessage: {
            addListener(fn) {
                listeners.push(fn);
            },
        },
    };
    const chrome = {
        runtime,
        storage: {
            local: {
                get(key, callback) {
                    reads++;
                    queueMicrotask(() => {
                        if (failRead) {
                            failRead = false;
                            runtime.lastError = { message: "read failed" };
                            callback({});
                            runtime.lastError = null;
                        } else callback(Object.hasOwn(local, key) ? { [key]: plain(local[key]) } : {});
                    });
                },
                set(values, callback) {
                    queueMicrotask(() => {
                        if (failWrite) {
                            failWrite = false;
                            runtime.lastError = { message: "write failed" };
                            callback();
                            runtime.lastError = null;
                        } else {
                            writes++;
                            Object.assign(local, plain(values));
                            callback();
                        }
                    });
                },
            },
            sync: {
                get(_key, callback) {
                    callback({});
                },
                set(_value, callback) {
                    callback();
                },
            },
            onChanged: { addListener() {} },
        },
    };
    const context = vm.createContext({
        chrome,
        URL,
        console,
        setTimeout,
        clearTimeout,
        TextEncoder,
        crypto: webcrypto,
        Date: ClockDate,
    });
    context.importScripts = (...files) =>
        files.forEach((file) =>
            vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file })
        );
    vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), context, { filename: "background.js" });
    const sender = {
        id: runtime.id,
        url: runtime.getURL("history.html"),
        documentId: "history-document-a",
        tab: { id: 7 },
        frameId: 0,
    };
    const send = (message, origin = sender) =>
        new Promise((resolve) => {
            let async = false;
            for (const fn of listeners) if (fn(message, origin, resolve) === true) async = true;
            if (!async) queueMicrotask(() => resolve(undefined));
        });
    return {
        local,
        context,
        sender,
        send,
        counts: () => ({ writes, reads }),
        setNow(value) {
            now = value;
        },
        failRead() {
            failRead = true;
        },
        failWrite() {
            failWrite = true;
        },
    };
}
function request(action, extra = {}) {
    return { type: "betterchzzk:watch-history-backup", version: 1, action, ...extra };
}
function mutation(operation) {
    return { type: "betterChzzk:watch-history-mutation", version: 1, operation };
}
function file() {
    const { store, backup } = load();
    return createFile(backup, store.applyMutation({}, snapshot({ activities: [chat(1)] }), NOW).history);
}
const key = "betterChzzkLiveWatchHistory";

test("only the exact history document can export, preview and import; a different extension origin is not trusted", async () => {
    const h = harness();
    for (const sender of [
        { ...h.sender, id: "other" },
        { ...h.sender, url: "chrome-extension://other/history.html" },
        { ...h.sender, url: "https://example.test/history.html" },
        { ...h.sender, url: "chrome-extension://extension-id/options.html" },
        { ...h.sender, documentId: undefined },
        { ...h.sender, frameId: 1 },
    ])
        for (const action of ["export", "preview", "import"]) {
            const response = await h.send(request(action, action === "export" ? {} : { backup: file() }), sender);
            assert.equal(response.ok, false);
            assert.equal(response.error.code, "UNTRUSTED_SENDER");
        }
    assert.deepEqual(h.counts(), { writes: 0, reads: 0 });
    assert.equal((await h.send(request("export"))).result.backup.records.length, 0);
});

test("preview is read-only and applying once performs exactly one write; a lost-response retry remains idempotent", async () => {
    const h = harness();
    const backup = file();
    const preview = await h.send(request("preview", { backup }));
    assert.equal(preview.result.summary.added, 1);
    assert.equal(h.counts().writes, 0);
    const applied = await h.send(request("import", { backup, confirmationToken: preview.result.confirmationToken }));
    assert.equal(applied.result.status, "applied");
    assert.equal(h.counts().writes, 1);
    const repeat = await h.send(request("import", { backup, confirmationToken: preview.result.confirmationToken }));
    assert.equal(repeat.result.status, "reconfirm");
    assert.equal(
        (await h.send(request("import", { backup, confirmationToken: repeat.result.confirmationToken }))).result.status,
        "unchanged"
    );
    assert.equal(h.counts().writes, 1);
});

test("tokens bind the exact file and document, expire, and are bounded", async () => {
    const h = harness();
    const backup = file();
    let preview = await h.send(request("preview", { backup }));
    const otherFile = plain(backup);
    otherFile.records[0].title = "다른 파일";
    assert.equal(
        (await h.send(request("import", { backup: otherFile, confirmationToken: preview.result.confirmationToken })))
            .result.status,
        "reconfirm"
    );
    preview = await h.send(request("preview", { backup }));
    assert.equal(
        (
            await h.send(request("import", { backup, confirmationToken: preview.result.confirmationToken }), {
                ...h.sender,
                documentId: "other-document",
            })
        ).result.status,
        "reconfirm"
    );
    preview = await h.send(request("preview", { backup }));
    h.setNow(NOW + 300001);
    assert.equal(
        (await h.send(request("import", { backup, confirmationToken: preview.result.confirmationToken }))).result
            .status,
        "reconfirm"
    );
    const first = await h.send(request("preview", { backup }));
    for (let n = 0; n < 8; n++) await h.send(request("preview", { backup }));
    assert.equal(
        (await h.send(request("import", { backup, confirmationToken: first.result.confirmationToken }))).result.status,
        "reconfirm"
    );
    assert.equal(h.counts().writes, 0);
});

test("a deletion after preview requires a new confirmation while ordinary growth preserves the latest snapshot", async () => {
    const h = harness();
    const backup = file();
    const { store } = load();
    h.local[key] = plain(store.applyMutation({}, snapshot(), NOW).history);
    const preview = await h.send(request("preview", { backup }));
    const deletion = await h.send(mutation({ kind: "deleteEntries", entryIds: ["live:100"], cutoffAt: NOW }));
    assert.equal(deletion.ok, true, JSON.stringify(deletion));
    assert.equal(h.local[key].entries["live:100"], undefined);
    const reconfirm = await h.send(request("import", { backup, confirmationToken: preview.result.confirmationToken }));
    assert.equal(reconfirm.result.status, "reconfirm");
    assert.equal(reconfirm.result.summary.restored, 1);
    assert.equal(h.local[key].entries["live:100"], undefined);
    const h2 = harness();
    h2.local[key] = plain(store.applyMutation({}, snapshot(), NOW).history);
    const preview2 = await h2.send(request("preview", { backup }));
    await h2.send(mutation(snapshot({ seconds: 90 })), {
        id: "extension-id",
        url: "https://chzzk.naver.com/live/channel-a",
        tab: { id: 1 },
    });
    const applied = await h2.send(request("import", { backup, confirmationToken: preview2.result.confirmationToken }));
    assert.equal(applied.result.status, "applied");
    assert.equal(h2.local[key].entries["live:100"].watchedSeconds, 90);
});

test("read and write failures are distinct, never partially apply, and leave the shared queue usable", async () => {
    const h = harness();
    const backup = file();
    h.failRead();
    assert.equal((await h.send(request("export"))).error.code, "STORAGE_READ_FAILED");
    const preview = await h.send(request("preview", { backup }));
    h.failWrite();
    assert.equal(
        (await h.send(request("import", { backup, confirmationToken: preview.result.confirmationToken }))).error.code,
        "STORAGE_WRITE_FAILED"
    );
    assert.equal(h.local[key], undefined);
    const next = await h.send(request("preview", { backup }));
    assert.equal(
        (await h.send(request("import", { backup, confirmationToken: next.result.confirmationToken }))).result.status,
        "applied"
    );
    assert.equal(h.local[key].entries["live:100"].activityDaily[DAY].chatCount, 1);
});

test("backup apply shares the donation writer queue and an export after both sees the complete latest history", async () => {
    const h = harness();
    const backup = file();
    const preview = await h.send(request("preview", { backup }));
    const donation = h.context.enqueueWatchHistoryMutation({
        kind: "replaceDonationMonths",
        snapshot: {
            owner: "viewer",
            startedAt: NOW - 1000,
            startMonth: "2026-09",
            endMonth: "2026-09",
            months: {
                "2026-09": [
                    { at: NOW - 10000, channelId: "channel-a", channelName: "채널", amount: 1000, text: "보존할 후원" },
                ],
            },
        },
    });
    const [donationResult, imported, exported] = await Promise.all([
        donation,
        h.send(request("import", { backup, confirmationToken: preview.result.confirmationToken })),
        h.send(request("export")),
    ]);
    assert.equal(donationResult.status, "applied");
    assert.equal(imported.result.status, "applied");
    assert.equal(exported.result.backup.records.length, 1);
    assert.equal(h.local[key].donationImport.months["2026-09"][0].text, "보존할 후원");
    assert.equal(h.counts().writes, 2);
    assert.doesNotMatch(JSON.stringify(exported.result.backup), /보존할 후원|donationImport/);
});
