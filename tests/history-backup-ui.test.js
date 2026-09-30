const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { webcrypto } = require("node:crypto");
const {
    createDom,
    createFakeChrome,
    readRepoFile,
    evalRepoScript,
    dispatch,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");
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

const KEY = "betterChzzkLiveWatchHistory";
const TYPE = "betterchzzk:watch-history-backup";

async function openBackup(t, initialHistory = {}) {
    const { context, store, backup } = load({ crypto: webcrypto, TextEncoder });
    vm.runInContext(fs.readFileSync(path.join(root, "shared/watchHistoryBackupController.js"), "utf8"), context);
    const chrome = createFakeChrome({ local: { [KEY]: initialHistory } });
    chrome.runtime.getURL = (file) => `chrome-extension://better-chzzk/${file}`;
    chrome.runtime.getManifest = () => ({ version: "1.4.0" });
    const state = {
        writes: 0,
        now: NOW,
        requests: [],
        responses: [],
        failWrite: false,
        loseResponse: false,
        holdResponse: false,
        heldResponses: [],
    };
    let queue = Promise.resolve();
    const controller = context.BetterChzzkWatchHistoryBackupController.createController({
        runtime: chrome.runtime,
        now: () => state.now,
        enqueue(task) {
            const result = queue.then(task, task);
            queue = result.catch(() => {});
            return result;
        },
        readHistory: async () => plain(chrome.testState.local[KEY]),
        writeHistory: async (history) => {
            if (state.failWrite) throw new Error("Write failed");
            state.writes++;
            chrome.testState.local[KEY] = plain(history);
        },
    });
    const originalSend = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (message, callback) => {
        if (message.type !== TYPE) return originalSend(message, callback);
        state.requests.push(plain(message));
        controller
            .handle(plain(message), {
                id: chrome.runtime.id,
                url: chrome.runtime.getURL("history.html"),
                documentId: "history-ui-document",
                frameId: 0,
            })
            .then((response) => {
                state.responses.push(plain(response));
                if (state.holdResponse) {
                    state.heldResponses.push(() => callback(plain(response)));
                } else if (state.loseResponse) {
                    chrome.runtime.lastError = { message: "The message port closed." };
                    callback(undefined);
                    chrome.runtime.lastError = undefined;
                } else callback(plain(response));
            });
    };
    const dom = createDom("history.html", "history.html", chrome);
    const { window } = dom;
    window.Date.now = () => NOW;
    const downloads = [];
    const revoked = [];
    window.URL.createObjectURL = (blob) => {
        downloads.push({ blob });
        return `blob:backup-${downloads.length}`;
    };
    window.URL.revokeObjectURL = (url) => revoked.push(url);
    window.HTMLAnchorElement.prototype.click = function () {
        downloads.at(-1).name = this.download;
    };
    for (const script of window.document.querySelectorAll("script[src]"))
        evalRepoScript(dom, script.getAttribute("src"));
    await waitForCondition(() => window.document.getElementById("notice").textContent !== "불러오는 중");
    t.after(async () => {
        window.dispatchEvent(new window.Event("pagehide"));
        await queue;
        await new Promise((resolve) => setTimeout(resolve, 0));
        window.close();
    });
    const element = (id) => {
        const node = window.document.getElementById(id);
        assert.ok(node, `Missing backup control: ${id}`);
        return node;
    };
    const source = store.applyMutation({}, snapshot({ activities: [chat(1), chat(2, "donation")] }), NOW).history;
    const file = createFile(backup, source);
    const choose = (value = file) => {
        const input = element("historyBackupFile");
        const selected =
            value && typeof value.text === "function"
                ? value
                : new window.File([JSON.stringify(value)], "backup.json", { type: "application/json" });
        Object.defineProperty(input, "files", { configurable: true, value: [selected] });
        dispatch(dom, input, "change");
    };
    const preview = async (value = file) => {
        choose(value);
        await waitForCondition(() => !element("historyBackupPreview").hidden);
    };
    const idle = () => waitForCondition(() => element("historyBackupPreview").getAttribute("aria-busy") === "false");
    return {
        dom,
        window,
        chrome,
        state,
        store,
        backup,
        source,
        file,
        element,
        choose,
        preview,
        idle,
        downloads,
        revoked,
    };
}

test("choosing a backup only previews; confirmation writes once and reloads the real history views", async (t) => {
    const h = await openBackup(t);
    await h.preview();
    assert.equal(h.state.writes, 0);
    assert.deepEqual(
        h.state.requests.map((request) => request.action),
        ["preview"]
    );
    assert.equal(h.element("historyBackupFile").value, "");
    assert.match(h.element("historyBackupSummary").textContent, /방송.*1/);
    assert.match(h.element("historyBackupSummary").textContent, /보관된 채팅.*1/);
    assert.match(h.element("historyBackupSummary").textContent, /누적 채팅.*1/);
    assert.equal(h.window.document.activeElement, h.element("historyBackupPreviewTitle"));
    h.element("historyBackupApply").click();
    h.element("historyBackupApply").click();
    await h.idle();
    assert.match(h.element("historyBackupStatus").textContent, /합쳤어요/);
    assert.equal(h.state.writes, 1);
    assert.deepEqual(
        h.state.requests.map((request) => request.action),
        ["preview", "import"]
    );
    assert.ok(h.state.requests[1].confirmationToken);
    assert.equal(h.window.document.querySelectorAll(".history-item").length, 1);
    assert.match(h.element("totalWatchTime").textContent, /1분/);
    assert.ok(h.element("calendarDays").querySelector(`[data-date="${DAY}"]`));
    h.element("rankingViewTab").click();
    assert.match(h.element("channelRanking").textContent, /채널/);
    h.element("activityViewTab").click();
    assert.match(h.element("activityList").textContent, /같은 내용/);
    assert.equal(
        h.chrome.testState.local[KEY].entries["live:100"].activities.some((row) => row.kind === "donation"),
        false
    );
});

test("cancel and Escape discard previews without writes, restore focus, and allow the same file again", async (t) => {
    const h = await openBackup(t);
    await h.preview();
    h.element("historyBackupPreviewTitle").dispatchEvent(
        new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
    assert.equal(h.state.writes, 0);
    assert.equal(h.element("historyBackupPreview").hidden, true);
    assert.equal(h.window.document.activeElement, h.element("historyBackupImport"));
    assert.match(h.element("historyBackupStatus").textContent, /취소/);
    await h.preview();
    assert.equal(h.state.requests.filter((request) => request.action === "preview").length, 2);
    h.element("historyBackupCancel").click();
    assert.equal(h.state.writes, 0);
    Object.defineProperty(h.element("historyBackupFile"), "files", { configurable: true, value: [] });
    dispatch(h.dom, h.element("historyBackupFile"), "change");
    assert.equal(h.element("historyBackupPreview").hidden, true);
    assert.equal(h.state.requests.length, 2);
});

test("a late file read cannot replace a newer file or reopen a cancelled preview", async (t) => {
    const h = await openBackup(t);
    let completeFirst;
    h.choose({
        name: "first.json",
        size: 10,
        text: () =>
            new Promise((resolve) => {
                completeFirst = resolve;
            }),
    });
    await waitForCondition(() => Boolean(completeFirst));
    assert.match(h.element("historyBackupStatus").textContent, /읽고 있어요/);
    assert.equal(h.element("historyBackupExport").disabled, true);
    assert.equal(h.element("historyBackupImport").disabled, true);
    h.element("historyBackupCancel").click();
    await h.preview(createFile(h.backup, {}));
    completeFirst(JSON.stringify(h.file));
    // Flush the deliberately delayed file promise, which must not send a preview request.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.state.requests.length, 1);
    assert.equal(h.state.requests[0].backup.records.length, 0);
    assert.match(h.element("historyBackupStatus").textContent, /빈 백업/);
    assert.equal(h.state.writes, 0);
});

test("cancel and page exit suppress delayed worker preview responses", async (t) => {
    const h = await openBackup(t);
    h.state.holdResponse = true;
    h.choose();
    await waitForCondition(() => h.state.heldResponses.length === 1);
    h.element("historyBackupCancel").click();
    h.state.heldResponses.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.element("historyBackupPreview").hidden, true);
    assert.match(h.element("historyBackupStatus").textContent, /취소/);
    h.choose();
    await waitForCondition(() => h.state.heldResponses.length === 1);
    h.window.dispatchEvent(new h.window.Event("pagehide"));
    h.state.heldResponses.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.element("historyBackupPreview").hidden, true);
    assert.equal(h.state.writes, 0);
});

test("cancellation aborts FileReader and ignores its late load callback", async (t) => {
    const h = await openBackup(t);
    let reader;
    let aborts = 0;
    h.window.FileReader = class {
        constructor() {
            reader = this;
        }
        readAsText() {}
        abort() {
            aborts++;
            this.onabort();
        }
    };
    const file = new h.window.File([JSON.stringify(h.file)], "backup.json");
    Object.defineProperty(file, "text", { value: undefined });
    Object.defineProperty(h.element("historyBackupFile"), "files", { configurable: true, value: [file] });
    dispatch(h.dom, h.element("historyBackupFile"), "change");
    assert.ok(reader);
    h.element("historyBackupCancel").click();
    assert.equal(aborts, 1);
    reader.result = JSON.stringify(h.file);
    reader.onload();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(h.element("historyBackupStatus").textContent, /취소/);
    assert.equal(h.state.requests.length, 0);
    assert.equal(h.element("historyBackupPreview").hidden, true);
});

test("oversized files are refused before reading; malformed and unreadable files never reach storage", async (t) => {
    const h = await openBackup(t);
    let reads = 0;
    h.choose({
        name: "large.json",
        size: h.backup.LIMITS.maxBytes + 1,
        text() {
            reads++;
            return Promise.resolve("");
        },
    });
    await h.idle();
    assert.equal(reads, 0);
    assert.match(h.element("historyBackupStatus").textContent, /16 MiB/);
    for (const text of [
        "",
        "{broken",
        JSON.stringify({ ...h.file, formatVersion: 500 }),
        JSON.stringify({ ...h.file, donationImport: {} }),
    ]) {
        h.choose({ name: "bad.json", size: text.length, text: async () => text });
        await h.idle();
        assert.equal(h.element("historyBackupStatus").dataset.error, "true");
        assert.equal(h.element("historyBackupPreview").hidden, true);
    }
    h.choose({
        name: "unreadable.json",
        size: 10,
        text: async () => {
            throw new Error("I/O error");
        },
    });
    await h.idle();
    assert.match(h.element("historyBackupStatus").textContent, /파일을 읽지 못했어요/);
    assert.equal(h.state.requests.length, 0);
    assert.equal(h.state.writes, 0);
});

test("empty and already identical backups explain no change and cannot be applied", async (t) => {
    const h = await openBackup(t);
    await h.preview(createFile(h.backup, {}));
    assert.equal(h.element("historyBackupApply").disabled, true);
    assert.match(h.element("historyBackupSummary").textContent, /기록 없음/);
    assert.match(h.element("historyBackupStatus").textContent, /빈 백업/);
    h.chrome.testState.local[KEY] = plain(h.source);
    h.element("historyBackupCancel").click();
    await h.preview();
    assert.equal(h.element("historyBackupApply").disabled, true);
    assert.match(h.element("historyBackupSummary").textContent, /동일 1개/);
    assert.match(h.element("historyBackupStatus").textContent, /모든 기록이 현재 기록과 같아요/);
    assert.equal(h.state.writes, 0);
});

test("preview distinguishes retained chat bodies from cumulative chat counts", async (t) => {
    const h = await openBackup(t);
    h.source.entries["live:100"].activityDaily[DAY].chatCount = 20;
    await h.preview(createFile(h.backup, h.source));
    assert.match(h.element("historyBackupSummary").textContent, /보관된 채팅 본문1개/);
    assert.match(h.element("historyBackupSummary").textContent, /누적 채팅20개/);
    assert.equal(h.state.writes, 0);
});

test("ambiguous and identity-conflicting records show the escaped title, channel and skip reason", async (t) => {
    const h = await openBackup(t);
    const current = h.store.applyMutation({}, snapshot({ activities: [chat(2, "donation")] }), NOW).history;
    delete current.entries["live:100"].sessionDetails;
    h.chrome.testState.local[KEY] = plain(current);
    const incoming = plain(h.file);
    incoming.records[0].title = "<img src=x onerror=alert(1)>";
    await h.preview(incoming);
    assert.equal(h.element("historyBackupSkipped").hidden, false);
    assert.match(h.element("historyBackupSkippedList").textContent, /<img src=x onerror=alert\(1\)> · 채널/);
    assert.match(h.element("historyBackupSkippedList").textContent, /상세 정보가 부족/);
    assert.equal(h.element("historyBackupSkippedList").querySelector("img"), null);
    assert.equal(h.element("historyBackupApply").disabled, true);
    assert.match(h.element("historyBackupStatus").textContent, /현재 기록은 변경하지 않아요/);
    h.element("historyBackupCancel").click();
    h.chrome.testState.local[KEY] = plain(h.source);
    incoming.records[0].chat.messages[0].text = "다른 본문";
    await h.preview(incoming);
    assert.match(h.element("historyBackupSkippedList").textContent, /식별 정보가 충돌/);
    assert.equal(h.state.writes, 0);
});

test("deleted records are explicitly previewed for restoration before any write", async (t) => {
    const h = await openBackup(t);
    h.chrome.testState.local[KEY] = plain(
        h.store.applyMutation(h.source, { kind: "clearHistory", cutoffAt: NOW }, NOW).history
    );
    await h.preview();
    assert.match(h.element("historyBackupRestore").textContent, /삭제했던 기록이 있는 방송 1개/);
    assert.match(h.element("historyBackupRestore").textContent, /복원해요/);
    assert.equal(h.state.writes, 0);
    h.element("historyBackupApply").click();
    await h.idle();
    assert.equal(h.state.writes, 1);
    assert.equal(h.chrome.testState.local[KEY].clearedAt, NOW);
    assert.equal(h.chrome.testState.local[KEY].entries["live:100"].watchedSeconds, 60);
});

test("expiry and a deletion after preview require a fresh user confirmation", async (t) => {
    const h = await openBackup(t);
    await h.preview();
    h.state.now += 6 * 60 * 1000;
    h.element("historyBackupApply").click();
    await h.idle();
    assert.equal(h.state.writes, 0);
    assert.equal(h.element("historyBackupPreview").hidden, false);
    assert.match(h.element("historyBackupStatus").textContent, /새 미리보기/);
    assert.equal(h.window.document.activeElement, h.element("historyBackupPreviewTitle"));
    h.chrome.testState.local[KEY] = plain(
        h.store.applyMutation({}, { kind: "clearHistory", cutoffAt: NOW }, NOW).history
    );
    h.element("historyBackupApply").click();
    await h.idle();
    assert.equal(h.state.writes, 0);
    assert.match(h.element("historyBackupRestore").textContent, /방송 1개/);
    h.element("historyBackupApply").click();
    await h.idle();
    assert.equal(h.state.writes, 1);
});

test("saving preserves current donations and disables cancellation until the response arrives", async (t) => {
    const h = await openBackup(t);
    const initial = h.store.applyMutation({}, snapshot({ activities: [chat(2, "donation")] }), NOW).history;
    h.chrome.testState.local[KEY] = plain(initial);
    await h.preview();
    h.state.holdResponse = true;
    h.element("historyBackupApply").click();
    await waitForCondition(() => h.state.heldResponses.length === 1);
    assert.equal(h.element("historyBackupCancel").hidden, true);
    assert.equal(h.element("historyBackupImport").disabled, true);
    h.element("historyBackupPreviewTitle").dispatchEvent(
        new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
    assert.match(h.element("historyBackupStatus").textContent, /합치고/);
    h.state.heldResponses.shift()();
    await h.idle();
    const saved = h.chrome.testState.local[KEY].entries["live:100"];
    assert.deepEqual(
        saved.activities.filter((row) => row.kind === "donation"),
        plain(initial.entries["live:100"].activities)
    );
    assert.equal(saved.activityDaily[DAY].donationCount, 1);
    assert.equal(saved.activityDaily[DAY].chatCount, 1);
});

test("a lost save response reports uncertainty and reselecting the file does not duplicate the write", async (t) => {
    const h = await openBackup(t);
    await h.preview();
    h.state.loseResponse = true;
    h.element("historyBackupApply").click();
    await h.idle();
    assert.equal(h.state.writes, 1);
    assert.match(h.element("historyBackupStatus").textContent, /결과를 확인하지 못했어요/);
    assert.doesNotMatch(h.element("historyBackupStatus").textContent, /저장하지 못|합쳤어요/);
    h.state.loseResponse = false;
    await h.preview();
    assert.equal(h.element("historyBackupApply").disabled, true);
    assert.equal(h.state.writes, 1);
});

test("a missing response times out without assuming save failure, and ignores the late reply", async (t) => {
    const h = await openBackup(t);
    await h.preview();
    const originalTimer = h.window.setTimeout.bind(h.window);
    let expire;
    h.window.setTimeout = (callback, duration) =>
        duration === 30000 ? ((expire = callback), -1) : originalTimer(callback, duration);
    h.state.holdResponse = true;
    h.element("historyBackupApply").click();
    await waitForCondition(() => h.state.heldResponses.length === 1);
    expire();
    await h.idle();
    assert.match(h.element("historyBackupStatus").textContent, /결과를 확인하지 못했어요/);
    h.state.heldResponses.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(h.element("historyBackupStatus").textContent, /결과를 확인하지 못했어요/);
    assert.equal(h.state.writes, 1);
});

test("storage failure preserves current data; a successful save with a failed reload stays a saved result", async (t) => {
    const h = await openBackup(t);
    const initial = plain(h.chrome.testState.local[KEY]);
    await h.preview();
    h.state.failWrite = true;
    h.element("historyBackupApply").click();
    await h.idle();
    assert.equal(h.state.writes, 0);
    assert.deepEqual(h.chrome.testState.local[KEY], initial);
    assert.match(h.element("historyBackupStatus").textContent, /저장하지 못했어요/);
    h.state.failWrite = false;
    await h.preview();
    h.chrome.storage.local.get = (_keys, callback) => {
        h.chrome.runtime.lastError = { message: "read failed" };
        callback({});
        h.chrome.runtime.lastError = undefined;
    };
    h.element("historyBackupApply").click();
    await h.idle();
    assert.equal(h.state.writes, 1);
    assert.match(h.element("historyBackupStatus").textContent, /기록을 합쳤어요.*화면을 다시 읽지 못했어요/);
    assert.doesNotMatch(h.element("historyBackupStatus").textContent, /저장하지 못/);
});

test("export uses the latest worker snapshot, excludes donations, and releases its download URL", async (t) => {
    const h = await openBackup(t);
    // The displayed entries are still empty; exporting must read the worker's latest raw data.
    h.chrome.testState.local[KEY] = plain(h.source);
    h.element("historySearch").value = "없는 방송";
    dispatch(h.dom, h.element("historySearch"), "input");
    h.element("historyBackupExport").click();
    h.element("historyBackupExport").click();
    await h.idle();
    assert.equal(h.state.requests.length, 1);
    assert.equal(h.state.requests[0].action, "export");
    assert.equal(h.downloads.length, 1);
    assert.match(h.downloads[0].name, /^cheese-spanner-history-20260928-120000\.json$/);
    const reader = new h.window.FileReader();
    const text = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(h.downloads[0].blob);
    });
    assert.equal(text, JSON.stringify(JSON.parse(text)), "compact output remains within the validator's byte limit");
    assert.deepEqual(plain(h.backup.parseBackup(text, { now: NOW })), plain(h.file));
    assert.doesNotMatch(text, /donation|donationImport/);
    assert.match(h.element("historyBackupStatus").textContent, /다운로드를 시작했어요/);
    assert.doesNotMatch(h.element("historyBackupStatus").textContent, /저장했어요/);
    await waitForCondition(() => h.revoked.length === 1, { timeoutMs: 2000 });
    assert.deepEqual(h.revoked, ["blob:backup-1"]);
});

test("export failure and page exit before export completion cannot start a download", async (t) => {
    const h = await openBackup(t);
    h.state.loseResponse = true;
    h.element("historyBackupExport").click();
    await h.idle();
    assert.equal(h.downloads.length, 0);
    assert.equal(h.element("historyBackupStatus").dataset.error, "true");
    h.state.loseResponse = false;
    h.state.holdResponse = true;
    h.element("historyBackupExport").click();
    await waitForCondition(() => h.state.heldResponses.length === 1);
    h.window.dispatchEvent(new h.window.Event("pagehide"));
    h.state.heldResponses.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.downloads.length, 0);
});

test("backup controls keep keyboard/status semantics, local script order and responsive theme tokens", async (t) => {
    const h = await openBackup(t);
    const { document } = h.window;
    assert.match(document.querySelector(".history-management > summary").textContent, /백업/);
    assert.equal(h.element("historyBackupStatus").getAttribute("role"), "status");
    assert.equal(h.element("historyBackupStatus").getAttribute("aria-live"), "polite");
    assert.equal(h.element("historyBackupFile").multiple, false);
    for (const suffix of ["Export", "Import", "Apply", "Cancel"]) {
        assert.equal(h.element(`historyBackup${suffix}`).type, "button");
        assert.equal(h.element(`historyBackup${suffix}`).tabIndex, 0);
    }
    assert.match(h.element("historyBackupScope").textContent, /전체 기간/);
    assert.match(h.element("historyBackupScope").textContent, /수집을 꺼도/);
    assert.match(h.element("historyBackupPrivacy").textContent, /암호화 없이/);
    assert.match(document.querySelector(".history-storage-guide").textContent, /Local Extension Settings/);
    const scripts = Array.from(document.scripts, (script) => script.getAttribute("src"));
    for (const [before, after] of [
        ["shared/data.js", "shared/watchHistoryBackup.js"],
        ["shared/watchHistoryBackup.js", "historyBackup.js"],
        ["historyBackup.js", "history.js"],
    ])
        assert.ok(scripts.indexOf(before) < scripts.indexOf(after));
    const css = readRepoFile("history-layout.css");
    assert.match(css, /\.history-backup-actions\s*\{[^}]*flex-wrap: wrap/s);
    assert.match(css, /\.history-backup\s*\{[^}]*var\(--surface\)[^}]*var\(--text\)/s);
    assert.match(css, /\.history-backup \[hidden\]\s*\{\s*display: none/);
});
