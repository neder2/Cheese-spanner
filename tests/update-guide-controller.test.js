const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const KEY = "betterchzzk:update-guide-state";
const TYPE = "betterchzzk:update-guide";
const plain = (value) => JSON.parse(JSON.stringify(value));
const state = (version = "1.4.1", status = "pending") => ({ schemaVersion: 1, version, status });

function harness(initial = {}, initialVersion = "1.4.1", additionalGuideVersions = []) {
    const local = plain(initial);
    const sync = {};
    const writes = [];
    const opened = [];
    let version = initialVersion;
    let now = 1000;
    let failure = "";
    let pauseWrite = false;
    let resumeWrite;
    class ClockDate extends Date {
        static now() {
            return now;
        }
    }
    const runtime = {
        id: "extension-id",
        lastError: null,
        getManifest: () => ({ version }),
        getURL: (file) => `chrome-extension://extension-id/${file}`,
    };
    function callback(operation, cb, value) {
        if (failure === operation) {
            failure = "";
            runtime.lastError = { message: `${operation} failed` };
            cb(value);
            runtime.lastError = null;
            return false;
        }
        cb(value);
        return true;
    }
    const chrome = {
        runtime,
        storage: {
            local: {
                get(key, cb) {
                    queueMicrotask(() =>
                        callback("read", cb, Object.hasOwn(local, key) ? { [key]: plain(local[key]) } : {})
                    );
                },
                set(values, cb) {
                    const finish = () => {
                        if (failure !== "write") {
                            Object.assign(local, plain(values));
                            writes.push(plain(values));
                        }
                        callback("write", cb);
                    };
                    if (pauseWrite) {
                        pauseWrite = false;
                        resumeWrite = finish;
                    } else queueMicrotask(finish);
                },
            },
            sync: {
                get(key, cb) {
                    queueMicrotask(() => callback("options", cb, Object.hasOwn(sync, key) ? { [key]: sync[key] } : {}));
                },
            },
        },
        tabs: {
            create(values, cb) {
                if (failure !== "tabs") opened.push(plain(values));
                callback("tabs", cb, { id: 10 });
            },
        },
    };
    const context = vm.createContext({ chrome, URL, Date: ClockDate, crypto: webcrypto });
    for (const file of ["shared/updateGuide.js", "shared/updateGuideController.js"])
        vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
    const catalog = {
        ...context.BetterChzzkUpdateGuide,
        getGuide(value) {
            return (
                context.BetterChzzkUpdateGuide.getGuide(value) ||
                (additionalGuideVersions.includes(value) ? { version: value } : null)
            );
        },
    };
    let controller = context.BetterChzzkUpdateGuideController.createController({ chrome, catalog });
    const sender = {
        id: runtime.id,
        tab: { id: 3, active: true },
        frameId: 0,
        documentId: "document-1",
        documentLifecycle: "active",
        url: "https://chzzk.naver.com/live/abc",
    };
    return {
        local,
        sync,
        writes,
        opened,
        sender,
        get controller() {
            return controller;
        },
        message(action, extra = {}, from = sender) {
            return controller
                .handleMessage(
                    { type: TYPE, protocol: 1, action, guideVersion: version, clientId: "client-1", ...extra },
                    from
                )
                .then(plain);
        },
        installed(details = { reason: "update", previousVersion: "1.4.0" }) {
            return controller.onInstalled(details);
        },
        async option(enabled) {
            const oldValue = sync.updateGuideEnabled;
            sync.updateGuideEnabled = enabled;
            return controller.onOptionsChanged({ updateGuideEnabled: { oldValue, newValue: enabled } }, "sync");
        },
        fail(operation) {
            failure = operation;
        },
        tick(ms) {
            now += ms;
        },
        version(value) {
            version = value;
        },
        restart() {
            controller = context.BetterChzzkUpdateGuideController.createController({ chrome, catalog });
        },
        holdWrite() {
            pauseWrite = true;
        },
        async waitForWrite() {
            for (let i = 0; i < 50 && !resumeWrite; i++) await Promise.resolve();
            assert.ok(resumeWrite, "write must be pending");
        },
        finishWrite() {
            resumeWrite();
            resumeWrite = null;
        },
    };
}

test("an actual upgrade prepares only the current guide in local storage", async () => {
    const h = harness({ unrelated: "preserved" });
    await h.installed({ reason: "update", previousVersion: "1.2.9" });
    assert.deepEqual(h.local, { unrelated: "preserved", [KEY]: state() });
    assert.equal(h.writes.length, 1);
});

test("fresh install, browser update, reload and downgrade cannot create pending state", async () => {
    for (const details of [
        { reason: "install" },
        { reason: "chrome_update" },
        { reason: "update", previousVersion: "1.4.1" },
        { reason: "update", previousVersion: "1.4.1.0" },
        { reason: "update", previousVersion: "1.10.0" },
        { reason: "update", previousVersion: "broken" },
    ]) {
        const h = harness();
        await h.installed(details);
        assert.notEqual(h.local[KEY]?.status, "pending");
        assert.equal((await h.message("claim")).show, false);
    }
});

test("same-version reload preserves genuine pending and consumed update states", async () => {
    for (const status of ["pending", "seen", "suppressed"]) {
        const h = harness({ [KEY]: state("1.4.1", status) });
        await h.installed({ reason: "update", previousVersion: "1.4.1" });
        assert.deepEqual(h.local[KEY], state("1.4.1", status));
        assert.equal(h.writes.length, 0);
    }
});

test("a downgrade preserves the greatest version record and cannot reannounce it", async () => {
    const h = harness({ [KEY]: state("1.10.0", "seen") });
    await h.installed({ reason: "update", previousVersion: "1.10.0" });
    assert.deepEqual(h.local[KEY], state("1.10.0", "seen"));
    assert.equal((await h.message("claim")).show, false);
    h.version("1.10.0");
    await h.installed({ reason: "update", previousVersion: "1.4.1" });
    assert.equal(h.writes.length, 0);
});

test("missing guide data is never replaced by an older guide", async () => {
    const h = harness({}, "1.4.2");
    await h.installed();
    assert.equal((await h.message("claim")).show, false);
    assert.equal((await h.message("claim", { guideVersion: "1.4.1" })).show, false);
});

test("version ordering compares numeric components including fourth components", async () => {
    for (const [current, previous, expected] of [
        ["1.10.0", "1.9.9", "pending"],
        ["1.4.1.10", "1.4.1.9", "pending"],
        ["1.4.1.9", "1.4.1.10", "suppressed"],
        ["1.4.1", "1.4.1.0", "suppressed"],
    ]) {
        const h = harness({}, current, [current]);
        await h.installed({ reason: "update", previousVersion: previous });
        assert.deepEqual(h.local[KEY], state(current, expected));
    }
});

test("claim is not display permission; durable commit grants exactly one display", async () => {
    const h = harness({ [KEY]: state() });
    const claim = await h.message("claim");
    assert.equal(claim.ok, true);
    assert.equal(claim.show, false);
    assert.equal(typeof claim.token, "string");
    assert.equal(h.writes.length, 0);
    h.holdWrite();
    let settled = false;
    const result = h.message("commit", { token: claim.token }).then((value) => {
        settled = true;
        return value;
    });
    await h.waitForWrite();
    assert.equal(settled, false);
    h.finishWrite();
    assert.deepEqual(await result, { ok: true, show: true });
    assert.deepEqual(h.local[KEY], state("1.4.1", "seen"));
    assert.equal((await h.message("commit", { token: claim.token })).show, false);
    assert.equal((await h.message("claim")).show, false);
    assert.equal(h.writes.length, 1);
});

test("simultaneous tabs receive one reservation and one consumed write", async () => {
    const h = harness({ [KEY]: state() });
    const senders = Array.from({ length: 12 }, (_, i) => ({
        ...h.sender,
        tab: { id: i, active: true },
        documentId: `doc-${i}`,
    }));
    const claims = await Promise.all(senders.map((sender) => h.message("claim", {}, sender)));
    const winner = claims.findIndex((value) => value.token);
    assert.notEqual(winner, -1);
    assert.equal(claims.filter((value) => value.token).length, 1);
    const commits = await Promise.all(
        Array.from({ length: 8 }, () => h.message("commit", { token: claims[winner].token }, senders[winner]))
    );
    assert.equal(commits.filter((value) => value.show).length, 1);
    assert.equal(h.writes.length, 1);
});

test("release frees only its own unconsumed token and expiry never resets seen", async () => {
    const h = harness({ [KEY]: state() });
    const first = await h.message("claim");
    await h.message("release", { token: first.token }, { ...h.sender, documentId: "other-doc" });
    assert.equal((await h.message("claim", {}, { ...h.sender, documentId: "other-doc" })).token, undefined);
    await h.message("release", { token: first.token });
    const second = await h.message("claim");
    assert.ok(second.token);
    h.tick(30_000);
    assert.equal((await h.message("commit", { token: second.token })).show, false);
    const third = await h.message("claim");
    assert.ok(third.token);
    await h.message("commit", { token: third.token });
    h.tick(60_000);
    await h.message("release", { token: third.token });
    assert.equal((await h.message("claim")).token, undefined);
});

test("tab and document identity protect a token from stale documents", async () => {
    const h = harness({ [KEY]: state() });
    const { token } = await h.message("claim");
    for (const sender of [
        { ...h.sender, documentId: "reloaded-doc" },
        { ...h.sender, tab: { id: 4, active: true } },
        { ...h.sender, frameId: 2 },
        { ...h.sender, documentLifecycle: "prerender" },
    ])
        assert.equal((await h.message("commit", { token }, sender)).show, false);
    assert.equal((await h.message("commit", { token })).show, true);
});

test("documentId fallback requires the same client, URL, tab and top frame", async () => {
    const h = harness({ [KEY]: state() });
    const sender = { ...h.sender, documentId: undefined };
    assert.equal((await h.message("claim", { clientId: undefined }, sender)).ok, false);
    const { token } = await h.message("claim", {}, sender);
    assert.ok(token);
    for (const [extra, from] of [
        [{ token, clientId: undefined }, sender],
        [{ token, clientId: "next-document" }, sender],
        [{ token }, { ...sender, url: "https://chzzk.naver.com/live/other" }],
        [{ token }, { ...sender, tab: { id: 8, active: true } }],
    ])
        assert.equal((await h.message("commit", extra, from)).show, false);
    assert.equal((await h.message("commit", { token }, sender)).show, true);
});

test("worker restart loses reservations but preserves durable consumed state", async () => {
    const h = harness({ [KEY]: state() });
    const first = await h.message("claim");
    h.restart();
    assert.equal((await h.message("commit", { token: first.token })).show, false);
    const second = await h.message("claim");
    assert.ok(second.token);
    await h.message("commit", { token: second.token });
    h.restart();
    assert.equal((await h.message("claim")).token, undefined);
});

test("a commit finishing after token expiry cannot grant late display permission", async () => {
    const h = harness({ [KEY]: state() });
    const { token } = await h.message("claim");
    h.holdWrite();
    const committing = h.message("commit", { token });
    await h.waitForWrite();
    h.tick(30_000);
    h.finishWrite();
    assert.equal((await committing).show, false);
    assert.deepEqual(h.local[KEY], state("1.4.1", "seen"));
    assert.equal((await h.message("claim")).token, undefined);
});

test("malformed state and storage read failures fail closed without overwriting data", async () => {
    for (const value of [
        null,
        [],
        {},
        { ...state(), schemaVersion: 2 },
        { ...state(), version: "1.04.1" },
        { ...state(), status: "new" },
    ]) {
        const h = harness({ [KEY]: value });
        await h.installed();
        assert.equal((await h.message("claim")).show, false);
        assert.deepEqual(h.local[KEY], value);
        assert.equal(h.writes.length, 0);
    }
    const h = harness({ [KEY]: state("1.3.9", "seen") });
    h.fail("read");
    await h.installed();
    assert.deepEqual(h.local[KEY], state("1.3.9", "seen"));
    assert.equal(h.writes.length, 0);
    h.fail("read");
    assert.deepEqual(await h.message("claim"), { ok: false, show: false });
});

test("sync read or consumed write failure never grants display", async () => {
    const h = harness({ [KEY]: state() });
    h.fail("options");
    assert.deepEqual(await h.message("claim"), { ok: false, show: false });
    const { token } = await h.message("claim");
    h.fail("write");
    assert.deepEqual(await h.message("commit", { token }), { ok: false, show: false });
    assert.equal((await h.message("commit", { token })).show, false);
    assert.deepEqual(h.local[KEY], state());
});

test("OFF before upgrade suppresses the version, independent of retired settings", async () => {
    const h = harness({ updateNotificationsEnabled: false });
    h.sync.updateGuideEnabled = false;
    await h.installed();
    assert.deepEqual(h.local[KEY], state("1.4.1", "suppressed"));
    await h.option(true);
    assert.equal((await h.message("claim")).token, undefined);
    const legacy = harness({ updateNotificationsEnabled: false });
    legacy.sync.updateNotificationsEnabled = false;
    await legacy.installed();
    assert.deepEqual(legacy.local[KEY], state());
});

test("OFF invalidates reserved pending state and ON cannot resurrect it", async () => {
    const h = harness({ [KEY]: state() });
    const { token } = await h.message("claim");
    await h.option(false);
    assert.deepEqual(h.local[KEY], state("1.4.1", "suppressed"));
    await h.option(true);
    assert.equal((await h.message("commit", { token })).show, false);
    assert.equal((await h.message("claim")).token, undefined);
});

test("OFF arriving during durable commit prevents its delayed display response", async () => {
    const h = harness({ [KEY]: state() });
    const { token } = await h.message("claim");
    h.holdWrite();
    const committing = h.message("commit", { token });
    await h.waitForWrite();
    const turningOff = h.option(false);
    h.finishWrite();
    assert.equal((await committing).show, false);
    await turningOff;
    await h.option(true);
    assert.equal((await h.message("claim")).token, undefined);
});

test("rapid OFF then ON still consumes the pending automatic opportunity", async () => {
    const h = harness({ [KEY]: state() });
    await Promise.all([h.option(false), h.option(true)]);
    assert.deepEqual(h.local[KEY], state("1.4.1", "suppressed"));
    assert.equal((await h.message("claim")).token, undefined);
});

test("failed OFF persistence stays suppressed in this worker after turning ON", async () => {
    const h = harness({ [KEY]: state() });
    h.fail("write");
    await h.option(false);
    await h.option(true);
    assert.equal((await h.message("claim")).token, undefined);
    assert.deepEqual(h.local[KEY], state("1.4.1", "suppressed"));
});

test("turning ON retries failed suppression before a worker restart without any claim", async () => {
    for (const failure of ["read", "write"]) {
        const h = harness({ [KEY]: state() });
        h.fail(failure);
        assert.equal((await h.option(false)).ok, false);
        await h.option(true);
        h.restart();
        assert.equal((await h.message("claim")).token, undefined);
        assert.deepEqual(h.local[KEY], state("1.4.1", "suppressed"));
        assert.equal(h.writes.length, 1);
    }
});

test("OFF to ON after a worker restart suppresses a pending version using the old option value", async () => {
    const h = harness({ [KEY]: state() });
    h.fail("write");
    await h.option(false);
    h.restart();
    await h.option(true);
    h.restart();
    assert.equal((await h.message("claim")).token, undefined);
    assert.deepEqual(h.local[KEY], state("1.4.1", "suppressed"));
    assert.equal(h.writes.length, 1);
});

test("ON suppression retries preserve consumed or malformed data and never overwrite a failed read", async () => {
    for (const value of [state("1.4.1", "seen"), state("1.4.1", "suppressed"), { ...state(), schemaVersion: 2 }]) {
        const h = harness({ [KEY]: value });
        h.sync.updateGuideEnabled = false;
        await h.option(true);
        assert.deepEqual(h.local[KEY], value);
        assert.equal(h.writes.length, 0);
    }
    const h = harness({ [KEY]: state() });
    h.sync.updateGuideEnabled = false;
    h.fail("read");
    assert.equal((await h.option(true)).ok, false);
    assert.deepEqual(h.local[KEY], state());
    assert.equal(h.writes.length, 0);
    assert.equal((await h.message("claim")).token, undefined);
});

test("unrelated/local option changes do not change guide state", async () => {
    const h = harness({ [KEY]: state() });
    await h.controller.onOptionsChanged({ updateGuideEnabled: { newValue: false } }, "local");
    await h.controller.onOptionsChanged({ otherOption: { newValue: false } }, "sync");
    assert.deepEqual(h.local[KEY], state());
    assert.equal(h.writes.length, 0);
});

test("invalid protocol, versions, actions, caller URLs and senders cause no writes", async () => {
    const h = harness({ [KEY]: state() });
    for (const extra of [
        { type: "other" },
        { protocol: 2 },
        { guideVersion: "1.4.0" },
        { action: "other" },
        { url: "https://example.com" },
        { tabId: 17 },
        { token: "unexpected" },
    ])
        assert.equal((await h.message("claim", extra)).ok, false);
    for (const sender of [
        { ...h.sender, id: "other-extension" },
        { ...h.sender, tab: undefined },
        { ...h.sender, tab: { id: -1, active: true } },
        { ...h.sender, frameId: 1 },
        { ...h.sender, url: "http://chzzk.naver.com/" },
        { ...h.sender, url: "https://chzzk.naver.com.evil/" },
        { ...h.sender, url: "https://user@chzzk.naver.com/" },
        { ...h.sender, tab: { id: 3, active: false } },
    ])
        assert.equal((await h.message("claim", {}, sender)).show, false);
    assert.equal(h.writes.length, 0);
});

test("stale installed version invalidates an outstanding reservation", async () => {
    const h = harness({ [KEY]: state() });
    const { token } = await h.message("claim");
    h.version("1.4.2");
    assert.equal((await h.message("commit", { token, guideVersion: "1.4.1" })).show, false);
    assert.equal(h.writes.length, 0);
});

test("settings navigation opens only allowlisted extension hashes after explicit request", async () => {
    const h = harness();
    await h.option(false);
    for (const target of ["panels", "history", "stream", "categories"])
        assert.equal((await h.message("open-settings", { target })).ok, true);
    assert.deepEqual(
        h.opened,
        ["panels", "history", "stream", "categories"].map((target) => ({
            url: `chrome-extension://extension-id/options.html#update-guide-${target}`,
        }))
    );
    for (const target of ["", "https://example.com", "../history.html", "__proto__"])
        assert.equal((await h.message("open-settings", { target })).ok, false);
    assert.equal((await h.message("open-settings", { target: "panels", url: "https://example.com" })).ok, false);
    assert.equal(h.opened.length, 4);
    h.fail("tabs");
    assert.equal((await h.message("open-settings", { target: "history" })).ok, false);
});
