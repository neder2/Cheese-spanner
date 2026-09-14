const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness({ failRemoval = false, version = "1.3.7", noticeState } = {}) {
    const local = {
        betterchzzkUpdateNotice: { version: "1.3.5" },
        betterchzzkUpdateReadVersion: "1.3.4",
        "betterChzzkOptionsGroupOpen:popup-updates": true,
        unrelated: 123,
    };
    if (noticeState) local["betterchzzk:quality-update-notice"] = noticeState;
    const sync = {
        updateNotificationsEnabled: true,
        gridBypassEnabled: true,
        autoQualityDismissInstallGuide: true,
        adblockPopupEnabled: false,
        holdSpeedEnabled: false,
    };
    const listeners = [];
    const badges = [];
    const titles = [];
    let installed;
    let messageHandler;
    const injections = [];
    let lastError;
    let errorReads = 0;
    const chrome = {
        runtime: {
            id: "fixture-extension",
            getURL: (name) => `chrome-extension://fixture-extension/${name}`,
            get lastError() {
                errorReads++;
                return lastError;
            },
            getManifest: () => ({ version }),
            onInstalled: {
                addListener(fn) {
                    installed = fn;
                },
            },
            onMessage: {
                addListener(fn) {
                    messageHandler = fn;
                },
            },
        },
        tabs: {
            async query(query) {
                assert.deepEqual(JSON.parse(JSON.stringify(query)), { url: "https://chzzk.naver.com/*" });
                return [{ id: 1 }, { id: 2 }];
            },
        },
        scripting: {
            async executeScript(details) {
                injections.push(details);
            },
        },
        action: {
            async setBadgeText({ text }) {
                badges.push(text);
            },
            async setTitle({ title }) {
                titles.push(title);
            },
        },
        storage: {
            onChanged: {
                addListener(fn) {
                    listeners.push(fn);
                },
            },
        },
    };
    for (const [name, data] of [
        ["local", local],
        ["sync", sync],
    ]) {
        chrome.storage[name] = {
            get(keys, cb) {
                cb(Object.fromEntries(keys.map((key) => [key, data[key]])));
            },
            set(values, cb) {
                Object.assign(data, values);
                cb();
            },
            remove(keys, cb) {
                if (failRemoval) lastError = { message: "removal failed" };
                else for (const key of keys) delete data[key];
                cb();
                lastError = undefined;
            },
        };
    }
    const context = vm.createContext({ chrome, URL, console, setTimeout, clearTimeout });
    context.importScripts = (...files) => files.forEach((file) => vm.runInContext(read(file), context));
    vm.runInContext(read("background.js"), context);
    return {
        local,
        sync,
        badges,
        titles,
        injections,
        message: (
            message,
            sender = { id: chrome.runtime.id, frameId: 0, tab: { id: 1 }, url: "https://chzzk.naver.com/live/measured" }
        ) => new Promise((resolve) => messageHandler(message, sender, resolve)),
        install: (details) => installed(details),
        get errorReads() {
            return errorReads;
        },
        change: (changes, area) => listeners.forEach((fn) => fn(changes, area)),
    };
}

test("startup removes legacy notice state and clears NEW without touching other data", async () => {
    const h = harness();
    await flush();
    assert.deepEqual(h.local, { unrelated: 123 });
    assert.deepEqual(h.sync, { adblockPopupEnabled: false, holdSpeedEnabled: false });
    assert.deepEqual(h.badges, [""]);
    assert.deepEqual(h.titles, ["치즈 스패너 설정"]);
});

test("install, same-version reload and browser updates never recreate legacy update UI", async () => {
    const h = harness();
    for (const details of [
        { reason: "install" },
        { reason: "update", previousVersion: "1.3.7" },
        { reason: "update", previousVersion: "1.4.0" },
        { reason: "chrome_update" },
    ]) {
        h.install(details);
        await flush();
        assert.equal(h.local.betterchzzkUpdateNotice, undefined);
        assert.equal(h.sync.updateNotificationsEnabled, undefined);
        assert.equal(h.sync.holdSpeedEnabled, false);
        assert.equal(h.local["betterchzzk:quality-update-notice"], undefined);
    }
    h.change({ betterchzzkUpdateNotice: { newValue: { version: "1.3.6" } } }, "local");
    h.change({ updateNotificationsEnabled: { newValue: true } }, "sync");
    await flush();
    assert.ok(h.badges.every((text) => text === ""));
    assert.ok(h.titles.every((title) => title === "치즈 스패너 설정"));
});

test("legacy storage cleanup consumes errors and still clears the badge and normalizes options", async () => {
    const h = harness({ failRemoval: true });
    h.install({ reason: "update", previousVersion: "1.3.5" });
    await flush();
    assert.ok(h.errorReads >= 4);
    assert.ok(h.badges.every((text) => text === ""));
    assert.equal(h.sync.holdSpeedEnabled, false);
});

test("only the dedicated version-change notice is loaded; legacy settings and tutorial stay removed", (t) => {
    const dom = new JSDOM(read("options.html"));
    t.after(() => dom.window.close());
    const document = dom.window.document;
    assert.equal(
        document.querySelector(
            '#updateNotice, [data-option="updateNotificationsEnabled"], [data-option-group="popup-updates"]'
        ),
        null
    );
    assert.doesNotMatch(document.body.textContent, /튜토리얼|새로고침해서 업데이트/);
    const manifest = JSON.parse(read("manifest.json"));
    const loaded = [
        ...manifest.content_scripts.flatMap((s) => s.js || []),
        ...Array.from(document.scripts, (s) => s.getAttribute("src")),
    ];
    assert.ok(loaded.includes("features/updateNotice.js"));
    assert.ok(loaded.includes("features/qualityInstallGuide.js"));
    // 설치 안내 닫기는 네이티브 안내 처리이며, 폐기한 확장 튜토리얼이 아니다.
    assert.ok(loaded.every((file) => file === "features/qualityInstallGuide.js" || !/tutorial|guide/i.test(file)));
    for (const file of ["shared/updateNotice.js", "optionsUpdateNotice.js"])
        assert.equal(fs.existsSync(path.join(root, file)), false);
});

test("upgrade to 1.3.7 creates one notice and concurrent tabs cannot both claim it", async () => {
    const h = harness();
    h.install({ reason: "update", previousVersion: "1.3.6" });
    await flush();
    const key = "betterchzzk:quality-update-notice";
    assert.equal(h.local[key].pending, true);
    assert.equal(h.injections.length, 2);
    assert.ok(
        h.injections.every(
            (item) =>
                item.world === "ISOLATED" && item.files.length === 1 && item.files[0] === "features/updateNotice.js"
        )
    );
    const claims = await Promise.all([
        h.message({ type: key, action: "claim" }),
        h.message({ type: key, action: "claim" }),
    ]);
    assert.equal(claims.filter((result) => result.show).length, 1);
    assert.equal(h.local[key].pending, false);
    h.install({ reason: "update", previousVersion: "1.3.6" });
    await flush();
    assert.equal((await h.message({ type: key, action: "claim" })).show, false);
    assert.equal(h.sync.gridBypassEnabled, undefined);
    assert.equal(h.sync.holdSpeedEnabled, false);
});

test("display failures can release their claim while forged senders and stale tokens cannot", async () => {
    const key = "betterchzzk:quality-update-notice";
    const h = harness({ noticeState: { version: "1.3.7", pending: true } });
    const bad = await h.message(
        { type: key, action: "claim" },
        { id: "other", frameId: 0, tab: { id: 1 }, url: "https://chzzk.naver.com/" }
    );
    assert.equal(bad.show, false);
    const claim = await h.message({ type: key, action: "claim" });
    await h.message({ type: key, action: "release", token: "stale" });
    assert.equal(h.local[key].pending, false);
    await h.message({ type: key, action: "release", token: claim.token });
    assert.equal(h.local[key].pending, true);
    assert.equal((await h.message({ type: key, action: "claim" })).show, true);
});

test("worker startup preserves a previously displayed version notice", async () => {
    const key = "betterchzzk:quality-update-notice";
    const h = harness({ noticeState: { version: "1.3.7", pending: false, token: "old" } });
    await flush();
    assert.equal(h.local[key].pending, false);
    assert.equal((await h.message({ type: key, action: "claim" })).show, false);
});

test("version notice displays accurate copy, closes on confirmation and restores focus", (t) => {
    const dom = new JSDOM('<!doctype html><head></head><body><button id="previous">이전</button></body>', {
        url: "https://chzzk.naver.com/live/measured",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    const w = dom.window,
        key = "betterchzzk:quality-update-notice";
    let pending = true;
    w.chrome = {
        runtime: {
            sendMessage(message, cb) {
                if (message.action === "claim") {
                    const show = pending;
                    pending = false;
                    cb({ show, version: "1.3.7", token: "one" });
                } else {
                    pending = true;
                    cb({ show: false });
                }
            },
        },
        storage: {
            local: {
                get(_keys, cb) {
                    cb({ [key]: { version: "1.3.7", pending } });
                },
            },
        },
    };
    w.HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute("open", "");
    };
    w.HTMLDialogElement.prototype.close = function () {
        this.removeAttribute("open");
        this.dispatchEvent(new w.Event("close"));
    };
    const previous = w.document.getElementById("previous");
    previous.focus();
    w.eval(read("features/updateNotice.js"));
    const dialog = w.document.querySelector("dialog");
    assert.ok(dialog.open);
    assert.equal(dialog.querySelector("p").textContent, "팝업같은 거 띄워서 죄송합니다. 꼭 읽어주세요.");
    assert.match(dialog.textContent, /기존 그리드 우회 방식/);
    assert.match(dialog.textContent, /수정·변형을 제한하는 네이버 이용약관에 저촉될 소지/);
    assert.match(dialog.textContent, /배포와 지원을 계속하기 어렵다고 판단해 기존 방식의 지원을 종료/);
    assert.match(dialog.textContent, /비슷한 이유로 확장 프로그램 이름도 변경했습니다/);
    assert.match(dialog.textContent, /화질 고정 기능을 강화하고, 시청에 방해되는 팝업을 제거/);
    assert.match(dialog.textContent, /시청 방해 팝업 제거/);
    assert.match(dialog.textContent, /설치된 그리드 프로그램의 사용을 차단하지 않습니다/);
    assert.equal(w.document.getElementById(dialog.getAttribute("aria-labelledby")).textContent, "중요!!! 공지");
    assert.ok(w.document.getElementById(dialog.getAttribute("aria-describedby")));
    dialog.querySelector("button").click();
    assert.equal(w.document.querySelector("dialog"), null);
    assert.equal(w.document.activeElement, previous);
    w.eval(read("features/updateNotice.js"));
    assert.equal(w.document.querySelector("dialog"), null);
});

test("a tab hidden while claiming the notice releases it and can display it when visible again", (t) => {
    const dom = new JSDOM("<!doctype html><head></head><body></body>", {
        url: "https://chzzk.naver.com/live/measured",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    const w = dom.window,
        key = "betterchzzk:quality-update-notice";
    let hidden = false,
        pending = true,
        claimReply;
    Object.defineProperty(w.document, "hidden", { get: () => hidden });
    w.chrome = {
        runtime: {
            sendMessage(message, cb) {
                if (message.action === "claim") {
                    pending = false;
                    claimReply = cb;
                } else {
                    pending = true;
                    cb({ show: false });
                }
            },
        },
        storage: {
            local: {
                get(_keys, cb) {
                    cb({ [key]: { pending } });
                },
            },
        },
    };
    w.HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute("open", "");
    };
    w.eval(read("features/updateNotice.js"));
    hidden = true;
    claimReply({ show: true, version: "1.3.7", token: "one" });
    assert.equal(pending, true);
    assert.equal(w.document.querySelector("dialog"), null);
    hidden = false;
    w.document.dispatchEvent(new w.Event("visibilitychange"));
    claimReply({ show: true, version: "1.3.7", token: "two" });
    assert.equal(w.document.querySelector("dialog").open, true);
});
