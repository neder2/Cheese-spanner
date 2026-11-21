const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const {
    createDom,
    createFakeChrome,
    evalRepoScript,
    readRepoFile,
    waitForCondition,
    waitForAsyncCallbacks,
} = require("./helpers/extension-page-fixture.js");
require("../shared/recordingDirectory.js");

test("directory files use a fresh name and never open an existing recording for writing", async () => {
    const calls = [];
    const writer = {};
    let collisions = 1;
    const handle = {
        async queryPermission() {
            return "granted";
        },
        async getFileHandle(name, options) {
            calls.push({ name, create: options?.create });
            if (!options?.create) {
                if (collisions-- > 0) return {};
                throw Object.assign(new Error("missing"), { name: "NotFoundError" });
            }
            return {
                async getFile() {
                    return { size: 0 };
                },
                async createWritable() {
                    return writer;
                },
            };
        },
    };
    const file = await globalThis.CheeseSpannerRecordingDirectory.openFile(handle, "방송.mp4");
    assert.equal(file.writer, writer);
    assert.equal(file.fileName, "방송 (1).mp4");
    assert.equal(calls.length, 3);
    assert.notEqual(calls[0].name, calls[2].name);
    assert.equal(calls[1].name, calls[2].name);
    assert.equal(calls[2].create, true);
    handle.queryPermission = async () => "denied";
    await assert.rejects(
        globalThis.CheeseSpannerRecordingDirectory.openFile(handle, "방송.mp4"),
        /directory-permission/
    );
    assert.equal(calls.length, 3);
});

function directoryModule(locks) {
    const realm = vm.createContext({ navigator: { locks } });
    vm.runInContext(readRepoFile("shared", "recordingDirectory.js"), realm);
    return realm.CheeseSpannerRecordingDirectory;
}

function recordingFolder() {
    const files = new Map();
    return {
        files,
        queryPermission: async () => "granted",
        async getFileHandle(name, options) {
            if (!files.has(name)) {
                if (!options?.create) throw new DOMException("Missing", "NotFoundError");
                files.set(name, { content: "", writing: false });
            }
            const entry = files.get(name);
            return {
                getFile: async () => ({ size: entry.content.length }),
                async createWritable({ mode }) {
                    assert.equal(mode, "exclusive");
                    if (entry.writing) throw new DOMException("Locked", "NoModificationAllowedError");
                    entry.writing = true;
                    let pending = "";
                    return {
                        write: async (text) => (pending += text),
                        close: async () => {
                            entry.content = pending;
                            entry.writing = false;
                        },
                        abort: async () => (entry.writing = false),
                    };
                },
            };
        },
    };
}

test("two tabs that select the same local folder reserve distinct file names, even for empty recordings", async () => {
    let queue = Promise.resolve();
    const locks = {
        request(_name, acquire) {
            const next = queue.then(acquire);
            queue = next.catch(() => {});
            return next;
        },
    };
    const folder = recordingFolder();
    const files = await Promise.all(
        [directoryModule(locks), directoryModule(locks)].map((tab) => tab.openFile(folder, "방송.mp4"))
    );
    assert.deepEqual(files.map((file) => file.fileName).sort(), ["방송 (1).mp4", "방송.mp4"]);
    await Promise.all(files.map((file) => file.writer.close()));
    assert.equal(folder.files.size, 2);
});

test("competing origins cannot overwrite a recording while its writer is open or after it commits", async () => {
    for (const closeBeforeCompetingWriter of [false, true]) {
        const folder = recordingFolder();
        const witness = Promise.withResolvers();
        const resume = Promise.withResolvers();
        const lateReader = {
            ...folder,
            async getFileHandle(name, options) {
                if (name === "방송.mp4" && !options?.create) {
                    // The second origin has observed the file missing, then stalls before creating it.
                    witness.resolve();
                    await resume.promise;
                    throw new DOMException("Missing at lookup", "NotFoundError");
                }
                return folder.getFileHandle(name, options);
            },
        };
        const secondOpening = directoryModule().openFile(lateReader, "방송.mp4");
        await witness.promise;
        const first = await directoryModule().openFile(folder, "방송.mp4");
        await first.writer.write("first");
        if (closeBeforeCompetingWriter) await first.writer.close();
        resume.resolve();
        const second = await secondOpening;
        await second.writer.write("second");
        await second.writer.close();
        if (!closeBeforeCompetingWriter) await first.writer.close();
        assert.equal(second.fileName, "방송 (1).mp4");
        assert.equal(folder.files.get("방송.mp4").content, "first");
        assert.equal(folder.files.get("방송 (1).mp4").content, "second");
    }
});

function ui(t, hash = "") {
    const chrome = createFakeChrome({ sync: { videoRecorderEnabled: true } });
    const dom = createDom("options.html", `options.html${hash}`, chrome);
    t.after(async () => {
        await waitForAsyncCallbacks();
        dom.window.close();
    });
    const state = { handle: null, writes: 0 };
    dom.window.CheeseSpannerRecordingDirectory = {
        async get() {
            return state.handle;
        },
        async set(handle) {
            state.handle = handle;
            state.writes++;
        },
    };
    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "options.js");
    evalRepoScript(dom, "optionsRecordingDirectory.js");
    const doc = dom.window.document;
    return {
        dom,
        chrome,
        state,
        doc,
        choose: doc.getElementById("videoRecorderChooseDirectory"),
        clear: doc.getElementById("videoRecorderClearDirectory"),
        status: doc.getElementById("videoRecorderDirectoryStatus"),
    };
}

test("native directory selection is immediate, remembered on reopen, cancellable and removable", async (t) => {
    const h = ui(t);
    await waitForCondition(() => !h.choose.disabled);
    const selected = { name: "녹화 모음", queryPermission: async () => "granted" };
    let pickerOptions;
    h.dom.window.showDirectoryPicker = async (options) => {
        pickerOptions = options;
        return selected;
    };
    h.choose.click();
    assert.equal(pickerOptions.mode, "readwrite", "picker is invoked synchronously from the click");
    await waitForCondition(() => h.status.textContent.includes("녹화 모음"));
    assert.equal(h.state.handle, selected);
    assert.equal(h.doc.getElementById("videoRecorderDownloadSettings").hidden, true);
    assert.equal(h.chrome.testState.permissionRequests.length, 0);
    h.dom.window.showDirectoryPicker = async () => {
        throw Object.assign(new Error(), { name: "AbortError" });
    };
    h.choose.click();
    await waitForAsyncCallbacks();
    assert.equal(h.state.writes, 1);
    assert.match(h.status.textContent, /녹화 모음/);
    const reopened = ui(t);
    reopened.state.handle = h.state.handle;
    reopened.dom.window.dispatchEvent(new reopened.dom.window.Event("focus"));
    await waitForCondition(() => reopened.status.textContent.includes("녹화 모음"));
    h.clear.click();
    await waitForCondition(() => h.state.handle === null);
    await waitForAsyncCallbacks();
    assert.equal(h.doc.getElementById("videoRecorderDownloadSettings").hidden, false);
});

test("picker permission and persistence errors leave the saved directory intact", async (t) => {
    const h = ui(t);
    await waitForCondition(() => !h.choose.disabled);
    const old = { name: "기존", queryPermission: async () => "granted" };
    h.state.handle = old;
    h.dom.window.showDirectoryPicker = async () => ({ name: "새 폴더", queryPermission: async () => "denied" });
    h.choose.click();
    await waitForCondition(() => /폴더 선택 실패/.test(h.status.textContent));
    assert.equal(h.state.handle, old);
    assert.equal(h.state.writes, 0);
    h.dom.window.CheeseSpannerRecordingDirectory.set = async () => {
        throw new Error("storage-failed");
    };
    h.dom.window.showDirectoryPicker = async () => ({ name: "새 폴더", queryPermission: async () => "granted" });
    h.choose.click();
    await waitForAsyncCallbacks();
    assert.equal(h.state.handle, old);
});

test("the action popup opens stable folder settings without invoking a native picker in the popup", async (t) => {
    const h = ui(t);
    await waitForCondition(() => !h.choose.disabled);
    h.chrome.extension = { getViews: () => [h.dom.window] };
    h.chrome.runtime.getURL = (path) => `chrome-extension://${h.chrome.runtime.id}/${path}`;
    let url;
    h.chrome.tabs = {
        create: async (options) => {
            url = options.url;
        },
    };
    h.dom.window.showDirectoryPicker = () => assert.fail("picker cannot outlive the popup");
    h.choose.click();
    await waitForAsyncCallbacks();
    assert.match(url, /options.html#recording-folder$/);
});

test("the folder-settings link reveals its group and enables the chooser only after settings load", async (t) => {
    const h = ui(t, "#recording-folder");
    assert.equal(h.choose.disabled, true);
    await waitForCondition(() => !h.choose.disabled);
    assert.equal(h.doc.querySelector('[data-option-group="player-recorder"]').open, true);
    assert.equal(h.doc.querySelector('.tab[aria-selected="true"]').dataset.tab, "player");
    const toggle = h.doc.querySelector('[data-option="videoRecorderEnabled"]');
    toggle.checked = false;
    toggle.dispatchEvent(new h.dom.window.Event("change", { bubbles: true }));
    assert.equal(h.choose.disabled, true);
    assert.equal(h.clear.disabled, true);
});
