const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repoRoot = path.join(__dirname, "..");

function readRepoFile(...parts) {
    return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

function createStorageArea(initialData = {}) {
    const data = { ...initialData };

    return {
        data,
        get(keys, callback) {
            const result = {};
            if (Array.isArray(keys)) {
                for (const key of keys) {
                    if (Object.hasOwn(data, key)) result[key] = data[key];
                }
            } else {
                Object.assign(result, data);
            }

            setTimeout(() => callback(result), 0);
        },
        set(values, callback) {
            Object.assign(data, values || {});
            setTimeout(() => callback?.(), 0);
        },
    };
}

function createFakeChrome({ sync = {} } = {}) {
    const syncArea = createStorageArea(sync);
    const storageChangeListeners = [];

    return {
        runtime: {},
        storage: {
            sync: syncArea,
            onChanged: {
                addListener(listener) {
                    storageChangeListeners.push(listener);
                },
                removeListener(listener) {
                    const index = storageChangeListeners.indexOf(listener);
                    if (index >= 0) storageChangeListeners.splice(index, 1);
                },
            },
        },
        testState: {
            emitSyncChange(values) {
                const changes = {};
                for (const [key, newValue] of Object.entries(values)) {
                    changes[key] = {
                        oldValue: syncArea.data[key],
                        newValue,
                    };
                    syncArea.data[key] = newValue;
                }
                for (const listener of [...storageChangeListeners]) listener(changes, "sync");
            },
        },
    };
}

function createRewardDom(syncOptions = {}) {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
        url: "https://chzzk.naver.com/live/test-channel",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });

    dom.window.chrome = createFakeChrome({
        sync: {
            rewardAutoCollectEnabled: true,
            rewardAutoCollectDelayMs: 0,
            ...syncOptions,
        },
    });
    dom.window.fetch = async () => {
        throw new Error("Unexpected network request in reward auto collect test");
    };

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "rewardAutoCollect.js");

    return dom;
}

function evalRepoScript(dom, ...parts) {
    dom.window.eval(readRepoFile(...parts));
}

function makeVisible(element) {
    element.getBoundingClientRect = () => ({
        width: 160,
        height: 40,
        left: 0,
        top: 0,
        right: 160,
        bottom: 40,
    });
}

function createRewardScope(dom) {
    const aside = dom.window.document.createElement("aside");
    aside.id = "aside-chatting";
    makeVisible(aside);
    dom.window.document.body.appendChild(aside);
    return aside;
}

function createTrackedButton(dom, text) {
    const button = dom.window.document.createElement("button");
    button.textContent = text;
    makeVisible(button);

    let clicks = 0;
    button.addEventListener("click", () => {
        clicks += 1;
    });

    return {
        button,
        get clicks() {
            return clicks;
        },
    };
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(predicate, { timeoutMs = 1200, intervalMs = 20 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
        if (predicate()) return;
        await wait(intervalMs);
    }
    assert.fail("Timed out waiting for reward auto collect condition");
}

test("manifest loads reward auto collect after shared settings and content utilities", () => {
    const manifest = JSON.parse(readRepoFile("manifest.json"));
    const isolatedScript = manifest.content_scripts.find((entry) =>
        entry.js?.includes("features/rewardAutoCollect.js")
    );

    assert.ok(isolatedScript);
    assert.ok(
        isolatedScript.js.indexOf("features/rewardAutoCollect.js") > isolatedScript.js.indexOf("shared/settings.js")
    );
    assert.ok(isolatedScript.js.indexOf("features/rewardAutoCollect.js") > isolatedScript.js.indexOf("content.js"));
});

test("reward auto collect clicks a visible enabled 통나무 claim button once", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const tracked = createTrackedButton(dom, "통나무 받기");

    scope.appendChild(tracked.button);

    await waitForCondition(() => tracked.clicks === 1 && tracked.button.getAttribute("data-bcra-clicked") === "1");
    await wait(350);

    assert.equal(tracked.clicks, 1);
});

test("reward auto collect ignores 통나무 claim buttons outside the live chat scope", async () => {
    const dom = createRewardDom();
    const tracked = createTrackedButton(dom, "통나무 받기");

    dom.window.document.body.appendChild(tracked.button);
    await wait(450);

    assert.equal(tracked.clicks, 0);
    assert.equal(tracked.button.hasAttribute("data-bcra-clicked"), false);
});

test("reward auto collect ignores disabled 통나무 claim buttons", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const tracked = createTrackedButton(dom, "통나무 받기");
    tracked.button.disabled = true;

    scope.appendChild(tracked.button);
    await wait(450);

    assert.equal(tracked.clicks, 0);
    assert.equal(tracked.button.hasAttribute("data-bcra-clicked"), false);
});

test("reward auto collect ignores hidden 통나무 claim buttons", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const tracked = createTrackedButton(dom, "통나무 받기");
    tracked.button.style.display = "none";

    scope.appendChild(tracked.button);
    await wait(450);

    assert.equal(tracked.clicks, 0);
    assert.equal(tracked.button.hasAttribute("data-bcra-clicked"), false);
});

test("reward auto collect ignores generic claim buttons without a 통나무 signal", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const tracked = createTrackedButton(dom, "받기");

    scope.appendChild(tracked.button);
    await wait(450);

    assert.equal(tracked.clicks, 0);
    assert.equal(tracked.button.hasAttribute("data-bcra-clicked"), false);
});

test("reward auto collect does not repeatedly click the same re-rendered button within cooldown", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const first = createTrackedButton(dom, "통나무 받기");

    scope.appendChild(first.button);
    await waitForCondition(() => first.clicks === 1);

    first.button.remove();
    const second = createTrackedButton(dom, "통나무 받기");
    scope.appendChild(second.button);
    await wait(450);

    assert.equal(first.clicks, 1);
    assert.equal(second.clicks, 0);
});

test("reward auto collect stops observer and pending clicks when the option is disabled", async () => {
    const dom = createRewardDom({ rewardAutoCollectDelayMs: 500 });
    const scope = createRewardScope(dom);
    const first = createTrackedButton(dom, "통나무 받기");

    scope.appendChild(first.button);
    await wait(320);

    dom.window.chrome.testState.emitSyncChange({ rewardAutoCollectEnabled: false });
    await wait(650);

    const second = createTrackedButton(dom, "통나무 받기");
    scope.appendChild(second.button);
    await wait(450);

    assert.equal(first.clicks, 0);
    assert.equal(second.clicks, 0);
    assert.equal(first.button.hasAttribute("data-bcra-clicked"), false);
    assert.equal(second.button.hasAttribute("data-bcra-clicked"), false);
});
