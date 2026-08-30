const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repoRoot = path.join(__dirname, "..");
const candidateSelector = 'button, [role="button"], a[href]';
const productionClickDelayMs = 800;
const activeDoms = new Set();

test.afterEach(() => {
    for (const dom of activeDoms) {
        dom.window.chrome?.testState?.emitSyncChange({ rewardAutoCollectEnabled: false });
        dom.window.close();
    }
    activeDoms.clear();
});

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

function createJsonResponse(data, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        async json() {
            return data;
        },
    };
}

function createRewardDom(syncOptions = {}, { fetchImpl, clickDelayMs = 0 } = {}) {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
        url: "https://chzzk.naver.com/live/test-channel",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });

    dom.window.chrome = createFakeChrome({
        sync: {
            rewardAutoCollectEnabled: true,
            ...syncOptions,
        },
    });
    const nativeSetTimeout = dom.window.setTimeout.bind(dom.window);
    dom.window.setTimeout = (callback, delay = 0, ...args) =>
        nativeSetTimeout(callback, delay === productionClickDelayMs ? clickDelayMs : delay, ...args);
    dom.window.fetch =
        fetchImpl || (async () => createJsonResponse({ content: { active: true, amount: 0, claims: [] } }));
    activeDoms.add(dom);

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

function trackButton(button) {
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

function createTrackedButton(dom, text) {
    const button = dom.window.document.createElement("button");
    button.textContent = text;
    return trackButton(button);
}

function createScreenshotRewardButton(dom, { hours = 1, amount = 100 } = {}) {
    const button = dom.window.document.createElement("button");
    button.type = "button";
    button.className = "_button_3fvos_21";

    const label = dom.window.document.createElement("span");
    label.className = "_text_3fvos_13";
    label.textContent = `${hours}시간 시청 통나무 파워 배달 완료!`;

    const icon = dom.window.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", "icon_power_3fvos_17");
    icon.setAttribute("width", "16");
    icon.setAttribute("height", "16");

    button.append(label, icon, `${amount} 받기`);
    return trackButton(button);
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

test("reward auto collect clicks a visible enabled 통나무 claim button once", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const tracked = createTrackedButton(dom, "통나무 받기");

    scope.appendChild(tracked.button);

    await waitForCondition(() => tracked.clicks === 1 && tracked.button.getAttribute("data-bcra-clicked") === "1");
    await wait(350);

    assert.equal(tracked.clicks, 1);
});

test("reward auto collect rejects executable URL schemes hidden by ASCII whitespace", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const anchor = dom.window.document.createElement("a");
    anchor.setAttribute("href", "java\nscript:globalThis.__betterChzzkRemoteCodeRan = true");
    anchor.setAttribute("role", "button");
    anchor.textContent = "통나무 받기";
    anchor.addEventListener("click", (event) => event.preventDefault());
    const tracked = trackButton(anchor);

    scope.appendChild(tracked.button);
    await wait(650);

    assert.equal(tracked.clicks, 0);
    assert.equal(dom.window.__betterChzzkRemoteCodeRan, undefined);
});

test("reward auto collect completes the real two-step watch reward flow", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const opener = createScreenshotRewardButton(dom);
    let balance = 3650;
    let powerClicks = 0;
    let powerButton = null;

    opener.button.addEventListener("click", () => {
        opener.button.remove();

        const dialog = dom.window.document.createElement("div");
        dialog.setAttribute("role", "alertdialog");
        const list = dom.window.document.createElement("ul");
        const row = dom.window.document.createElement("li");
        const label = dom.window.document.createElement("span");
        label.textContent = "1시간 시청 보상";
        powerButton = dom.window.document.createElement("button");
        powerButton.type = "button";
        powerButton.className = "_button_nsb6t_140";
        powerButton.textContent = "100 파워";
        makeVisible(powerButton);
        powerButton.addEventListener("click", () => {
            powerClicks += 1;
            balance += 100;
            dialog.remove();
        });
        row.append(label, powerButton);
        list.appendChild(row);
        dialog.appendChild(list);
        scope.appendChild(dialog);
    });

    scope.appendChild(opener.button);

    await waitForCondition(() => balance === 3750);
    assert.equal(opener.clicks, 1, "the chat reward button should open the power dialog once");
    assert.equal(powerClicks, 1, "the nested 100 파워 button should perform the actual claim once");
    assert.equal(powerButton.getAttribute("data-bcra-clicked"), "1");
});

test("reward auto collect claims non-watch API rewards and leaves WATCH_1_HOUR to the page button", async () => {
    const requests = [];
    const dom = createRewardDom(
        {},
        {
            fetchImpl: async (url, options = {}) => {
                const method = options.method || "GET";
                requests.push({ credentials: options.credentials, method, url: String(url) });
                if (method === "GET") {
                    return createJsonResponse({
                        content: {
                            active: true,
                            amount: 100,
                            claims: [
                                { amount: 100, claimId: "watch-claim", claimType: "WATCH_1_HOUR" },
                                { amount: 300, claimId: "follow-claim", claimType: "FOLLOW" },
                            ],
                        },
                    });
                }
                return createJsonResponse({ content: { amount: 400 } });
            },
        }
    );

    await waitForCondition(() => requests.some((request) => request.method === "PUT"));

    const getRequests = requests.filter((request) => request.method === "GET");
    const putRequests = requests.filter((request) => request.method === "PUT");
    assert.equal(getRequests.length, 1);
    assert.equal(getRequests[0].url, "https://api.chzzk.naver.com/service/v1/channels/test-channel/log-power");
    assert.equal(putRequests.length, 1);
    assert.equal(
        putRequests[0].url,
        "https://api.chzzk.naver.com/service/v1/channels/test-channel/log-power/claims/follow-claim"
    );
    assert.equal(putRequests[0].credentials, "include");
    assert.equal(
        requests.some((request) => request.url.includes("watch-claim")),
        false
    );

    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await wait(250);
    assert.equal(
        requests.filter((request) => request.method === "PUT").length,
        1,
        "the same successful claim must not be submitted twice"
    );
});

test("reward auto collect discards an in-flight API result after the option is disabled", async () => {
    let resolveGet;
    const requests = [];
    const dom = createRewardDom(
        {},
        {
            fetchImpl: (url, options = {}) => {
                const method = options.method || "GET";
                requests.push({ method, url: String(url) });
                if (method !== "GET") return Promise.resolve(createJsonResponse({ content: { amount: 300 } }));
                return new Promise((resolve) => {
                    resolveGet = resolve;
                });
            },
        }
    );

    await waitForCondition(() => typeof resolveGet === "function");
    dom.window.chrome.testState.emitSyncChange({ rewardAutoCollectEnabled: false });
    resolveGet(
        createJsonResponse({
            content: {
                claims: [{ amount: 300, claimId: "follow-after-disable", claimType: "FOLLOW" }],
            },
        })
    );
    await wait(100);

    assert.equal(
        requests.some((request) => request.method === "PUT"),
        false
    );
});

test("reward auto collect observes a reward added after the initial empty aside scan", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const originalQuerySelectorAll = scope.querySelectorAll.bind(scope);
    let initialFullScans = 0;
    scope.querySelectorAll = (selector) => {
        if (selector === candidateSelector) initialFullScans += 1;
        return originalQuerySelectorAll(selector);
    };

    await waitForCondition(() => initialFullScans >= 1);

    const tracked = createScreenshotRewardButton(dom);
    scope.appendChild(tracked.button);

    await waitForCondition(() => tracked.clicks === 1);
});

test("reward auto collect follows the latest button when it is re-rendered during the click delay", async () => {
    const dom = createRewardDom({}, { clickDelayMs: 500 });
    const scope = createRewardScope(dom);
    const first = createScreenshotRewardButton(dom);
    const originalQuerySelectorAll = scope.querySelectorAll.bind(scope);
    let initialFullScans = 0;
    scope.querySelectorAll = (selector) => {
        if (selector === candidateSelector) initialFullScans += 1;
        return originalQuerySelectorAll(selector);
    };

    scope.appendChild(first.button);
    await waitForCondition(() => initialFullScans >= 1);

    const replacement = createScreenshotRewardButton(dom);
    first.button.replaceWith(replacement.button);

    await waitForCondition(() => replacement.clicks === 1, { timeoutMs: 1800 });
    assert.equal(first.clicks, 0);
    assert.equal(replacement.button.getAttribute("data-bcra-clicked"), "1");
});

test("reward auto collect treats a reused button with a new reward amount as a new claim", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const tracked = createScreenshotRewardButton(dom);

    scope.appendChild(tracked.button);
    await waitForCondition(() => tracked.clicks === 1);

    tracked.button.querySelector("span").textContent = "2시간 시청 통나무 파워 배달 완료!";
    tracked.button.lastChild.nodeValue = "200 받기";

    await waitForCondition(() => tracked.clicks === 2);
    await wait(400);
    assert.equal(tracked.clicks, 2);
    assert.equal(tracked.button.getAttribute("data-bcra-clicked"), "1");
});

test("reward auto collect reschedules a pending reward when the live route changes in place", async () => {
    const dom = createRewardDom({}, { clickDelayMs: 500 });
    const scope = createRewardScope(dom);
    const tracked = createScreenshotRewardButton(dom);
    const originalQuerySelectorAll = scope.querySelectorAll.bind(scope);
    let initialFullScans = 0;
    scope.querySelectorAll = (selector) => {
        if (selector === candidateSelector) initialFullScans += 1;
        return originalQuerySelectorAll(selector);
    };

    scope.appendChild(tracked.button);
    await waitForCondition(() => initialFullScans >= 1);

    dom.window.history.pushState({}, "", "/live/other-channel");
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));

    await waitForCondition(() => tracked.clicks === 1, { timeoutMs: 1800 });
    await wait(400);
    assert.equal(tracked.clicks, 1);
});

test("reward auto collect releases a completed reward after it stays hidden past the grace period", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const wrapper = dom.window.document.createElement("div");
    const tracked = createScreenshotRewardButton(dom);

    wrapper.appendChild(tracked.button);
    scope.appendChild(wrapper);
    await waitForCondition(() => tracked.clicks === 1);

    wrapper.hidden = true;
    await wait(900);
    wrapper.hidden = false;

    await waitForCondition(() => tracked.clicks === 2);
    assert.equal(tracked.button.getAttribute("data-bcra-clicked"), "1");
});

test("reward auto collect ignores 통나무 claim buttons outside the live chat scope", async () => {
    const dom = createRewardDom();
    const tracked = createTrackedButton(dom, "통나무 받기");

    dom.window.document.body.appendChild(tracked.button);
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

test("reward auto collect scans only mutated candidates after the initial aside pass", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const wrapper = dom.window.document.createElement("div");
    wrapper.hidden = true;
    const hiddenReward = createScreenshotRewardButton(dom);
    const textContentDescriptor = Object.getOwnPropertyDescriptor(dom.window.Node.prototype, "textContent");
    let genericTextReads = 0;
    const originalQuerySelectorAll = scope.querySelectorAll.bind(scope);
    let fullCandidateScans = 0;
    scope.querySelectorAll = (selector) => {
        if (selector === candidateSelector) fullCandidateScans += 1;
        return originalQuerySelectorAll(selector);
    };

    for (let index = 0; index < 80; index += 1) {
        const genericButton = createTrackedButton(dom, `일반 채팅 버튼 ${index}`).button;
        Object.defineProperty(genericButton, "textContent", {
            configurable: true,
            get() {
                genericTextReads += 1;
                return textContentDescriptor.get.call(this);
            },
        });
        wrapper.appendChild(genericButton);
    }
    wrapper.appendChild(hiddenReward.button);
    scope.appendChild(wrapper);
    await waitForCondition(() => fullCandidateScans >= 1);
    fullCandidateScans = 0;

    const originalWrapperQuerySelectorAll = wrapper.querySelectorAll.bind(wrapper);
    let descendantCandidateScans = 0;
    wrapper.querySelectorAll = (selector) => {
        if (selector === candidateSelector) descendantCandidateScans += 1;
        return originalWrapperQuerySelectorAll(selector);
    };
    wrapper.hidden = false;
    await waitForCondition(() => hiddenReward.clicks === 1);

    assert.equal(fullCandidateScans, 0);
    assert.equal(descendantCandidateScans, 0);
    assert.equal(genericTextReads, 80);
});

test("reward auto collect does not immediately repeat the same re-rendered reward", async () => {
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
    const dom = createRewardDom({}, { clickDelayMs: 500 });
    const scope = createRewardScope(dom);
    const first = createTrackedButton(dom, "통나무 받기");
    const originalQuerySelectorAll = scope.querySelectorAll.bind(scope);
    let initialFullScans = 0;
    scope.querySelectorAll = (selector) => {
        if (selector === candidateSelector) initialFullScans += 1;
        return originalQuerySelectorAll(selector);
    };

    scope.appendChild(first.button);
    await waitForCondition(() => initialFullScans >= 1);

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
