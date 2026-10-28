const assert = require("node:assert/strict");
const test = require("node:test");
const {
    createDom,
    createFakeChrome,
    dispatch,
    evalRepoScript,
    queryOption,
    waitForAsyncCallbacks,
    waitForCondition,
} = require("./helpers/extension-page-fixture.js");

const BACKUP = "cheese-spanner:settings-backup";
// Page objects come from the JSDOM realm; compare their JSON values.
const plain = (value) => JSON.parse(JSON.stringify(value));
const PANEL_KEYS = [
    "betterchzzk:panel-resize:sidebar-width:v1",
    "betterchzzk:panel-resize:chat-width:v1",
    "betterchzzk:panel-resize:chat-height:v1",
];

function summary(overrides = {}) {
    return {
        options: { changed: 2, total: 5 },
        pinnedChannelIds: { changed: true, count: 3 },
        followingFolders: null,
        panelSizes: { changed: false, count: 3 },
        liveStartChannels: { changed: true, count: 1 },
        multiview: null,
        chatMultiview: null,
        permissions: { notifications: false, previewHosts: false },
        permissionOptionKeys: [],
        keptOffOptionKeys: [],
        ...overrides,
    };
}

// JSDOM lets focus() land inside a closed <details>; Chrome does not, so check what a user can actually see.
function assertVisibleFocus(document, label) {
    const active = document.activeElement;
    assert.ok(active && active !== document.body, `${label}: focus stays on a control`);
    for (let node = active; node && node !== document.body; node = node.parentElement) {
        assert.equal(node.hidden, false, `${label}: focus is not inside a hidden element`);
        const details = node.parentElement;
        if (details?.localName === "details" && !details.open)
            assert.equal(node, details.querySelector(":scope > summary"), `${label}: inside a closed menu`);
    }
}

async function setup(t, { sync = {}, local = {}, permissionGranted = true } = {}) {
    const chrome = createFakeChrome({ sync, local, permissionGranted });
    const backupMessages = [];
    const replies = [];
    const forward = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (message, callback) => {
        if (message?.type !== BACKUP) return forward(message, callback);
        backupMessages.push(message);
        const reply = replies.shift();
        setTimeout(() => callback(typeof reply === "function" ? reply(message) : reply), 0);
    };
    const dom = createDom("options.html", "options.html", chrome);
    t.after(() => dom.window.close());
    const downloads = [];
    dom.window.URL.createObjectURL = (blob) => {
        downloads.push({ blob });
        return "blob:settings";
    };
    dom.window.URL.revokeObjectURL = () => {};
    dom.window.HTMLAnchorElement.prototype.click = function () {
        downloads.at(-1).name = this.download;
        downloads.at(-1).href = this.href;
    };
    for (const file of [
        ["shared", "settings.js"],
        ["options.js"],
        ["shared", "data.js"],
        ["shared", "liveStart.js"],
        ["shared", "settingsBackup.js"],
        ["optionsSettingsBackup.js"],
    ])
        evalRepoScript(dom, ...file);
    await waitForAsyncCallbacks();
    const { document } = dom.window;
    const input = document.getElementById("settingsFileInput");
    let pickerOpened = 0;
    input.click = () => pickerOpened++;
    async function chooseFile(value, name = "settings.json") {
        const file = new dom.window.File([typeof value === "string" ? value : JSON.stringify(value)], name, {
            type: "application/json",
        });
        Object.defineProperty(input, "files", { value: [file], configurable: true });
        dispatch(dom, input, "change");
        await waitForAsyncCallbacks();
    }
    return {
        chrome,
        dom,
        document,
        backupMessages,
        replies,
        downloads,
        chooseFile,
        picker: () => pickerOpened,
        panel: document.getElementById("settingsBackupPanel"),
        message: () => document.getElementById("message").textContent,
    };
}

const fileValue = {
    kind: "cheese-spanner.settings-backup",
    formatVersion: 1,
    extensionVersion: "1.4.3",
    createdAt: 1700000000000,
    sync: { options: { chatPosition: "left" } },
    local: {},
};

test("export downloads the worker's file and import shows a preview before any write", async (t) => {
    const h = await setup(t);
    h.replies.push({ ok: true, backup: { ...fileValue, createdAt: Date.UTC(2026, 9, 8, 3, 4) }, omitted: [] });
    h.document.getElementById("exportSettingsFile").click();
    await waitForCondition(() => h.downloads[0]?.name);
    assert.deepEqual(plain(h.backupMessages[0]), { type: BACKUP, version: 1, action: "export" });
    assert.match(h.downloads[0].name, /^cheese-spanner-settings-\d{8}-\d{4}\.json$/);
    assert.equal(JSON.parse(await h.downloads[0].blob.text()).kind, "cheese-spanner.settings-backup");
    assert.match(h.message(), /시청 기록·로그인 정보는 들어 있지 않아요/);

    const toggle = queryOption(h.document, "chatTimestampEnabled");
    toggle.checked = !toggle.checked;
    dispatch(h.dom, toggle, "change");
    h.document.getElementById("importSettingsFile").click();
    assert.equal(h.picker(), 0, "unsaved option edits block the file picker");
    assert.match(h.message(), /저장하지 않은 변경/);
    h.document.getElementById("discardChanges").click();

    h.document.getElementById("importSettingsFile").click();
    assert.equal(h.picker(), 1);
    h.replies.push({
        ok: true,
        fingerprint: "fp-1",
        summary: summary(),
        ignoredOptionKeys: ["futureOption"],
        changes: 4,
    });
    await h.chooseFile(fileValue);
    await waitForCondition(() => !h.panel.hidden);
    assert.deepEqual(plain(h.backupMessages[1]), { type: BACKUP, version: 1, action: "preview", backup: fileValue });
    assert.equal(h.document.activeElement.id, "settingsBackupTitle");
    const text = h.panel.textContent;
    assert.match(text, /settings\.json/);
    assert.match(text, /파일 5개 중 2개 바뀜/);
    assert.match(text, /방송 알림 대상1개 채널 · 바뀜/);
    assert.match(text, /이 버전에 없는 옵션 1개는 무시해요/);
    assert.match(text, /알림·자동 입장 없이 기준으로만/);
    assert.equal(h.chrome.testState.sync.chatPosition, undefined, "previewing writes nothing");
    const locked = queryOption(h.document, "chatTimestampEnabled");
    assert.equal(locked.disabled, true, "option editing is locked while the restore owns the stored options");
    assert.equal(h.document.getElementById("save").disabled, true);
    locked.checked = !locked.checked;
    dispatch(h.dom, locked, "change");
    assert.equal(h.document.getElementById("discardChanges").disabled, true, "forced edits are ignored");
    locked.checked = !locked.checked;

    h.replies.push({ ok: true, result: { status: "applied", summary: summary(), conflicts: [] } });
    h.chrome.testState.sync.chatPosition = "left";
    h.panel.querySelector(".primary-button").click();
    await waitForCondition(() => h.panel.hidden);
    assert.deepEqual(plain(h.backupMessages[2]), {
        type: BACKUP,
        version: 1,
        action: "apply",
        backup: fileValue,
        fingerprint: "fp-1",
    });
    assert.equal(h.chrome.testState.permissionRequests.length, 0, "no permission is requested when none is needed");
    await waitForCondition(() => queryOption(h.document, "chatPosition").value === "left");
    assert.match(h.message(), /설정 파일을 불러왔어요/);
    assert.equal(h.document.activeElement, h.document.querySelector("#headerMenu > summary"));
    assertVisibleFocus(h.document, "after applying");
    assert.equal(queryOption(h.document, "chatTimestampEnabled").disabled, false, "editing resumes after closing");
});

test("an edit made while the file picker is open stops the import before it locks or previews", async (t) => {
    const h = await setup(t);
    h.document.getElementById("importSettingsFile").click();
    assert.equal(h.picker(), 1);
    const toggle = queryOption(h.document, "chatTimestampEnabled");
    toggle.checked = !toggle.checked;
    dispatch(h.dom, toggle, "change");
    await h.chooseFile(fileValue);
    assert.equal(h.backupMessages.length, 0);
    assert.equal(h.panel.hidden, true);
    assert.equal(toggle.disabled, false);
    assert.match(h.message(), /저장하지 않은 변경/);
});

test("reloading saved options keeps fields edited during the read and refreshes untouched fields", async (t) => {
    const h = await setup(t, { sync: { chatPosition: "right", sidebarPosition: "left" } });
    const chat = queryOption(h.document, "chatPosition");
    chat.value = "left";
    dispatch(h.dom, chat, "change");
    h.chrome.testState.sync.sidebarPosition = "right";
    h.chrome.testState.sync.chatPosition = "right";
    assert.equal(await h.dom.window.CheeseSpannerOptionsPage.reloadSavedOptions(), true);
    assert.equal(chat.value, "left", "the in-flight edit survives");
    assert.equal(queryOption(h.document, "sidebarPosition").value, "right");
    assert.equal(h.document.getElementById("notice").dataset.state, "dirty");
});

test("denied permissions write nothing and offer importing with only those features off", async (t) => {
    const h = await setup(t, { permissionGranted: false });
    h.document.getElementById("importSettingsFile").click();
    h.replies.push({
        ok: true,
        fingerprint: "fp-1",
        summary: summary({
            permissions: { notifications: true, previewHosts: false },
            permissionOptionKeys: ["liveStartNotificationsEnabled"],
        }),
        ignoredOptionKeys: [],
        changes: 2,
    });
    await h.chooseFile(fileValue);
    await waitForCondition(() => !h.panel.hidden);
    h.panel.querySelector(".primary-button").click();
    assert.deepEqual(plain(h.chrome.testState.permissionRequests), [{ permissions: ["notifications"] }]);
    await waitForCondition(() => /권한이 거부되어/.test(h.panel.textContent));
    assert.equal(h.backupMessages.filter((message) => message.action === "apply").length, 0);
    const fallback = [...h.panel.querySelectorAll("button")].find((button) =>
        button.textContent.includes("기능은 켜지 않고 불러오기")
    );
    assert.equal(fallback.textContent, "방송 시작 데스크톱 알림 기능은 켜지 않고 불러오기");
    assert.equal(h.document.activeElement, fallback);
    h.replies.push({
        ok: true,
        result: {
            status: "applied",
            summary: summary({ keptOffOptionKeys: ["liveStartNotificationsEnabled"] }),
            conflicts: [],
        },
    });
    fallback.click();
    await waitForCondition(() => h.panel.hidden);
    assert.deepEqual(plain(h.backupMessages.at(-1).disabledOptionKeys), ["liveStartNotificationsEnabled"]);
    assert.equal(h.chrome.testState.permissionRequests.length, 1, "the fallback does not ask again");
    assert.match(h.message(), /권한을 받지 못한 방송 시작 데스크톱 알림 기능은 켜지 않았어요/);
});

test("permissions follow only the features the file turns on, and denial keeps just those off", async (t) => {
    const h = await setup(t, { permissionGranted: false });
    h.document.getElementById("importSettingsFile").click();
    // The worker found the preview tooltip already on, so only the multiview this file turns on needs a host.
    h.replies.push({
        ok: true,
        fingerprint: "fp-1",
        summary: summary({
            permissions: { notifications: false, previewHosts: true },
            permissionOptionKeys: ["liveMultiviewEnabled"],
        }),
        ignoredOptionKeys: [],
        changes: 2,
    });
    await h.chooseFile(fileValue);
    await waitForCondition(() => !h.panel.hidden);
    assert.match(h.panel.textContent, /미리보기·멀티뷰 영상 권한을 요청할 수 있어요/);
    assert.doesNotMatch(h.panel.textContent, /데스크톱 알림 권한/);
    h.panel.querySelector(".primary-button").click();
    assert.deepEqual(plain(h.chrome.testState.permissionRequests), [{ origins: ["https://*.pstatic.net/*"] }]);
    await waitForCondition(() => /권한이 거부되어/.test(h.panel.textContent));
    const fallback = [...h.panel.querySelectorAll("button")].find((button) =>
        button.textContent.includes("켜지 않고 불러오기")
    );
    assert.equal(fallback.textContent, "라이브 멀티뷰 기능은 켜지 않고 불러오기");
    h.replies.push({
        ok: true,
        result: { status: "applied", summary: summary({ keptOffOptionKeys: ["liveMultiviewEnabled"] }), conflicts: [] },
    });
    fallback.click();
    await waitForCondition(() => h.panel.hidden);
    assert.deepEqual(
        plain(h.backupMessages.at(-1).disabledOptionKeys),
        ["liveMultiviewEnabled"],
        "a preview feature that is already on is not sent to be kept off"
    );
    assert.match(h.message(), /권한을 받지 못한 라이브 멀티뷰 기능은 켜지 않았어요/);
    assert.doesNotMatch(h.message(), /호버 미리보기/);

    h.document.getElementById("importSettingsFile").click();
    h.replies.push({
        ok: true,
        fingerprint: "fp-2",
        summary: summary({ permissions: { notifications: false, previewHosts: false } }),
        ignoredOptionKeys: [],
        changes: 1,
    });
    await h.chooseFile(fileValue);
    await waitForCondition(() => !h.panel.hidden);
    assert.doesNotMatch(h.panel.textContent, /권한을 요청할 수 있어요/);
    h.replies.push({ ok: true, result: { status: "applied", summary: summary(), conflicts: [] } });
    h.panel.querySelector(".primary-button").click();
    await waitForCondition(() => h.panel.hidden);
    assert.equal(h.chrome.testState.permissionRequests.length, 1, "a file that turns nothing on asks for nothing");
    assert.equal(h.backupMessages.at(-1).disabledOptionKeys, undefined);
});

test("choosing to import without permissions survives a re-confirmation in the same flow", async (t) => {
    const h = await setup(t, { permissionGranted: false });
    h.document.getElementById("importSettingsFile").click();
    const needs = summary({
        permissions: { notifications: true, previewHosts: false },
        permissionOptionKeys: ["liveStartNotificationsEnabled"],
    });
    // What the worker reports once the same file is planned with that feature kept off.
    const keptOff = summary({ keptOffOptionKeys: ["liveStartNotificationsEnabled"] });
    h.replies.push({ ok: true, fingerprint: "fp-1", summary: needs, ignoredOptionKeys: [], changes: 2 });
    await h.chooseFile(fileValue);
    await waitForCondition(() => !h.panel.hidden);
    h.panel.querySelector(".primary-button").click();
    await waitForCondition(() => /권한이 거부되어/.test(h.panel.textContent));
    h.replies.push({ ok: true, result: { status: "reconfirm", fingerprint: "fp-2", summary: keptOff } });
    [...h.panel.querySelectorAll("button")].find((button) => button.textContent.includes("켜지 않고 불러오기")).click();
    await waitForCondition(() => /다시 확인/.test(h.panel.textContent));
    assert.match(h.panel.textContent, /권한을 받지 못한 방송 시작 데스크톱 알림 기능은 켜지 않고 불러와요/);
    assert.doesNotMatch(h.panel.textContent, /권한을 요청할 수 있어요/);
    h.replies.push({ ok: true, result: { status: "applied", summary: keptOff, conflicts: [] } });
    h.panel.querySelector(".primary-button").click();
    await waitForCondition(() => h.panel.hidden);
    assert.equal(h.chrome.testState.permissionRequests.length, 1, "the confirmed choice does not ask again");
    const applies = h.backupMessages.filter((message) => message.action === "apply");
    assert.deepEqual(plain(applies.map((message) => [message.fingerprint, message.disabledOptionKeys])), [
        ["fp-1", ["liveStartNotificationsEnabled"]],
        ["fp-2", ["liveStartNotificationsEnabled"]],
    ]);
});

test("failed and conflicted keys are reported as different outcomes by section", async (t) => {
    const h = await setup(t);
    h.document.getElementById("importSettingsFile").click();
    h.replies.push({ ok: true, fingerprint: "fp-1", summary: summary(), ignoredOptionKeys: [], changes: 2 });
    await h.chooseFile(fileValue);
    await waitForCondition(() => !h.panel.hidden);
    h.replies.push({
        ok: true,
        result: {
            status: "failed",
            stage: "live-start",
            rolledBack: false,
            failed: ["sync:skipSeconds"],
            conflicted: ["sync:betterchzzkPinnedFollowingChannelIds", "local:betterchzzk:panel-resize:chat-width:v1"],
            summary: summary(),
        },
    });
    h.panel.querySelector(".primary-button").click();
    await waitForCondition(() => /저장하지 못했어요/.test(h.panel.textContent));
    const text = h.panel.querySelector(".settings-backup-status").textContent;
    assert.match(text, /되돌리기도 실패해 불러온 값이 남은 구역: 옵션\./);
    assert.match(text, /다른 곳에서 바뀌어 되돌리지 않은 구역: 팔로잉 고정·채팅·사이드바 크기\./);
    assert.doesNotMatch(text, /모두 되돌려/);
    h.panel.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    h.document.getElementById("importSettingsFile").click();
    h.replies.push({ ok: true, fingerprint: "fp-2", summary: summary(), ignoredOptionKeys: [], changes: 2 });
    await h.chooseFile(fileValue);
    await waitForCondition(() => !h.panel.hidden);
    h.replies.push({
        ok: true,
        result: { status: "applied", summary: summary(), conflicts: ["local:betterchzzk:panel-resize:chat-width:v1"] },
    });
    h.panel.querySelector(".primary-button").click();
    await waitForCondition(() => h.panel.hidden);
    assert.match(h.message(), /감지된 구역\(채팅·사이드바 크기\)은 확인해 주세요/);
    assert.doesNotMatch(h.message(), /유지했어요/);
});

test("re-confirmation, failures and invalid files keep current settings and explain the state", async (t) => {
    const h = await setup(t);
    h.document.getElementById("importSettingsFile").click();
    await h.chooseFile("{not json");
    assert.equal(h.backupMessages.length, 0);
    assert.match(h.message(), /JSON 형식/);
    h.replies.push({ ok: false, error: "unsupported-version" });
    await h.chooseFile({ ...fileValue, formatVersion: 2 });
    await waitForCondition(() => /업데이트/.test(h.message()));
    assert.equal(h.panel.hidden, true);

    h.replies.push({ ok: true, fingerprint: "fp-1", summary: summary(), ignoredOptionKeys: [], changes: 2 });
    await h.chooseFile(fileValue);
    await waitForCondition(() => !h.panel.hidden);
    h.replies.push({
        ok: true,
        result: { status: "reconfirm", fingerprint: "fp-2", summary: summary({ options: { changed: 1, total: 5 } }) },
    });
    h.panel.querySelector(".primary-button").click();
    await waitForCondition(() => /다시 확인/.test(h.panel.textContent));
    assert.match(h.panel.textContent, /파일 5개 중 1개 바뀜/);
    h.replies.push({
        ok: true,
        result: { status: "failed", stage: "local", rolledBack: true, residual: [], summary: summary() },
    });
    h.panel.querySelector(".primary-button").click();
    await waitForCondition(() => /모두 되돌려/.test(h.panel.textContent));
    assert.equal(h.backupMessages.at(-1).fingerprint, "fp-2");
    assert.equal(h.panel.hidden, false);
    h.panel.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(h.panel.hidden, true);
    assert.equal(h.document.activeElement, h.document.querySelector("#headerMenu > summary"));
    assertVisibleFocus(h.document, "after Escape");
    h.replies.push({ ok: true, fingerprint: "fp-3", summary: summary(), ignoredOptionKeys: [], changes: 0 });
    await h.chooseFile(fileValue);
    await waitForCondition(() => !h.panel.hidden);
    assert.equal(h.panel.querySelector(".primary-button").disabled, true);
    assert.match(h.panel.textContent, /바꿀 내용이 없어요/);
});

test("saved size reset clears only the three profile-local size choices", async (t) => {
    const h = await setup(t, {
        local: {
            [PANEL_KEYS[0]]: 300,
            [PANEL_KEYS[1]]: 420,
            [PANEL_KEYS[2]]: 500,
            betterChzzkLiveWatchHistory: { keep: true },
        },
    });
    const button = h.document.getElementById("resetPanelSizes");
    assert.equal(button.type, "button");
    assert.ok(h.document.getElementById(button.getAttribute("aria-describedby")));
    button.click();
    await waitForCondition(() => /크기를 초기화했어요/.test(h.message()));
    for (const key of PANEL_KEYS) assert.equal(h.chrome.testState.local[key], null);
    assert.deepEqual(h.chrome.testState.local.betterChzzkLiveWatchHistory, { keep: true });
});

test("placement, height and list controls save normalized choices with their dependencies", async (t) => {
    const h = await setup(t);
    const chatPosition = queryOption(h.document, "chatPosition");
    const sidebarPosition = queryOption(h.document, "sidebarPosition");
    const rows = queryOption(h.document, "followingListMaxRows");
    const boxHeight = queryOption(h.document, "chatToolsModeratorBoxHeight");
    assert.equal(chatPosition.value, "right");
    assert.equal(sidebarPosition.value, "left");
    assert.equal(rows.value, "0");
    assert.equal(boxHeight.disabled, true, "the moderator height follows the moderator box option");
    for (const control of [chatPosition, sidebarPosition, rows, boxHeight])
        assert.ok(
            h.document.getElementById(control.getAttribute("aria-describedby") || "") || control.closest("label")
        );
    chatPosition.value = "left";
    dispatch(h.dom, chatPosition, "change");
    sidebarPosition.value = "right";
    dispatch(h.dom, sidebarPosition, "change");
    rows.value = "50";
    dispatch(h.dom, rows, "change");
    assert.equal(rows.value, "30");
    const moderator = queryOption(h.document, "chatToolsModeratorBoxEnabled");
    moderator.checked = true;
    dispatch(h.dom, moderator, "change");
    assert.equal(boxHeight.disabled, false);
    boxHeight.value = "100";
    dispatch(h.dom, boxHeight, "change");
    assert.equal(boxHeight.value, "240");
    for (const key of ["followingFoldersEnabled", "chatMultiviewEnabled"]) {
        const toggle = queryOption(h.document, key);
        assert.equal(toggle.checked, false, `${key} stays off until the user opts in`);
        toggle.checked = true;
        dispatch(h.dom, toggle, "change");
    }
    h.document.getElementById("save").click();
    await waitForCondition(() => h.document.getElementById("notice").dataset.state === "saved");
    assert.equal(h.chrome.testState.sync.chatPosition, "left");
    assert.equal(h.chrome.testState.sync.sidebarPosition, "right");
    assert.equal(h.chrome.testState.sync.followingListMaxRows, 30);
    assert.equal(h.chrome.testState.sync.chatToolsModeratorBoxHeight, 240);
    assert.equal(h.chrome.testState.sync.followingFoldersEnabled, true);
    assert.equal(h.chrome.testState.sync.chatMultiviewEnabled, true);
});

test("every way out of the file flows leaves focus on a control outside the closed menu", async (t) => {
    const h = await setup(t);
    const menu = h.document.getElementById("headerMenu");
    const menuSummary = menu.querySelector(":scope > summary");
    const exportButton = h.document.getElementById("exportSettingsFile");
    const importButton = h.document.getElementById("importSettingsFile");

    menu.open = true;
    exportButton.focus();
    h.replies.push({ ok: true, backup: { ...fileValue }, omitted: [] });
    exportButton.click();
    await waitForCondition(() => h.downloads[0]?.name && !exportButton.disabled);
    assert.equal(menu.open, false);
    assert.equal(h.document.activeElement, menuSummary);
    assertVisibleFocus(h.document, "export");

    for (const leave of ["cancel", "Escape", "apply"]) {
        menu.open = true;
        importButton.focus();
        importButton.click();
        assert.equal(menu.open, false);
        assertVisibleFocus(h.document, `${leave}: picker open`);
        h.replies.push({ ok: true, fingerprint: "fp", summary: summary(), ignoredOptionKeys: [], changes: 1 });
        await h.chooseFile(fileValue);
        await waitForCondition(() => !h.panel.hidden);
        if (leave === "cancel")
            [...h.panel.querySelectorAll("button")].find((button) => button.textContent === "취소").click();
        else if (leave === "Escape")
            h.panel.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        else {
            h.replies.push({ ok: true, result: { status: "applied", summary: summary(), conflicts: [] } });
            h.panel.querySelector(".primary-button").click();
        }
        await waitForCondition(() => h.panel.hidden);
        assert.equal(h.document.activeElement, menuSummary, leave);
        assertVisibleFocus(h.document, leave);
    }

    const toggle = queryOption(h.document, "chatTimestampEnabled");
    toggle.checked = !toggle.checked;
    dispatch(h.dom, toggle, "change");
    menu.open = true;
    importButton.focus();
    importButton.click();
    assert.match(h.message(), /저장하지 않은 변경/);
    assertVisibleFocus(h.document, "blocked import");
});

test("an export that leaves out a section names it and the reason", async (t) => {
    const h = await setup(t);
    h.replies.push({
        ok: true,
        backup: { ...fileValue },
        omitted: ["pinnedChannelIds", "multiviewQualities"],
    });
    h.document.getElementById("exportSettingsFile").click();
    await waitForCondition(() => h.downloads[0]?.name);
    assert.match(h.message(), /저장값을 읽지 못한 팔로잉 고정 구역은 빠졌어요/);
    const max = h.dom.window.CheeseSpannerSettingsBackup.MAX_MULTIVIEW_CHANNELS.toLocaleString("ko-KR");
    assert.ok(h.message().includes(`멀티뷰 화질 구역은 저장한 채널이 ${max}개를 넘어 파일에 넣지 않았어요`));
    assert.doesNotMatch(h.message(), /멀티뷰 딜레이/);
});

test("denying the permission again keeps a single offer to import without those features", async (t) => {
    const h = await setup(t, { permissionGranted: false });
    h.document.getElementById("importSettingsFile").click();
    h.replies.push({
        ok: true,
        fingerprint: "fp-1",
        summary: summary({
            permissions: { notifications: true, previewHosts: false },
            permissionOptionKeys: ["liveStartNotificationsEnabled"],
        }),
        ignoredOptionKeys: [],
        changes: 1,
    });
    await h.chooseFile(fileValue);
    await waitForCondition(() => !h.panel.hidden);
    const offers = () =>
        [...h.panel.querySelectorAll("button")].filter((button) => button.textContent.includes("켜지 않고 불러오기"));
    for (const attempt of [1, 2, 3]) {
        h.panel.querySelector(".primary-button").click();
        await waitForCondition(() => h.chrome.testState.permissionRequests.length === attempt);
        await waitForCondition(() => offers().length && !h.panel.querySelector(".primary-button").disabled);
        assert.equal(offers().length, 1, `denial ${attempt}`);
        assert.equal(h.document.activeElement, offers()[0]);
    }
    assert.equal(h.backupMessages.filter((message) => message.action === "apply").length, 0);
    h.replies.push({
        ok: true,
        result: {
            status: "applied",
            summary: summary({ keptOffOptionKeys: ["liveStartNotificationsEnabled"] }),
            conflicts: [],
        },
    });
    offers()[0].click();
    await waitForCondition(() => h.panel.hidden);
    assert.equal(h.backupMessages.filter((message) => message.action === "apply").length, 1);
});

test("a re-confirmation that leaves nothing to change disables applying and says so", async (t) => {
    const h = await setup(t);
    h.document.getElementById("importSettingsFile").click();
    h.replies.push({ ok: true, fingerprint: "fp-1", summary: summary(), ignoredOptionKeys: [], changes: 2 });
    await h.chooseFile(fileValue);
    await waitForCondition(() => !h.panel.hidden);
    assert.equal(h.panel.querySelector(".primary-button").disabled, false);
    h.replies.push({
        ok: true,
        result: {
            status: "reconfirm",
            fingerprint: "fp-2",
            summary: summary({ options: { changed: 0, total: 5 } }),
            changes: 0,
        },
    });
    h.panel.querySelector(".primary-button").click();
    await waitForCondition(() => /파일 5개 중 0개 바뀜/.test(h.panel.textContent));
    assert.equal(h.panel.querySelector(".primary-button").disabled, true, "nothing is left to apply");
    assert.match(h.panel.querySelector(".settings-backup-status").textContent, /바꿀 내용이 없어요/);
    assert.equal(h.document.activeElement.id, "settingsBackupTitle");
    h.panel.querySelector(".primary-button").click();
    await waitForAsyncCallbacks();
    assert.equal(h.backupMessages.filter((message) => message.action === "apply").length, 1);

    // A re-confirmation that still changes something keeps applying available with the new fingerprint.
    h.panel.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    h.document.getElementById("importSettingsFile").click();
    h.replies.push({ ok: true, fingerprint: "fp-3", summary: summary(), ignoredOptionKeys: [], changes: 2 });
    await h.chooseFile(fileValue);
    await waitForCondition(() => !h.panel.hidden);
    h.replies.push({ ok: true, result: { status: "reconfirm", fingerprint: "fp-4", summary: summary(), changes: 1 } });
    h.panel.querySelector(".primary-button").click();
    await waitForCondition(() => /다시 확인/.test(h.panel.textContent));
    assert.equal(h.panel.querySelector(".primary-button").disabled, false);
    h.replies.push({ ok: true, result: { status: "applied", summary: summary(), conflicts: [] } });
    h.panel.querySelector(".primary-button").click();
    await waitForCondition(() => h.panel.hidden);
    assert.equal(h.backupMessages.at(-1).fingerprint, "fp-4");
});
