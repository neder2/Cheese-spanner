const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repoRoot = path.join(__dirname, "..");
const candidateSelector = 'button, [role="button"], a[href]';
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

function createRewardDom(syncOptions = {}, { fetchImpl } = {}) {
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

test("reward auto collect never clicks executable URL anchors", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const anchor = dom.window.document.createElement("a");
    anchor.href = "javascript:globalThis.__betterChzzkRemoteCodeRan = true";
    anchor.className = "reward-claim-button";
    anchor.textContent = "통나무 받기";
    anchor.addEventListener("click", (event) => event.preventDefault());
    const tracked = trackButton(anchor);

    scope.appendChild(tracked.button);
    await wait(650);

    assert.equal(tracked.clicks, 0);
    assert.equal(dom.window.__betterChzzkRemoteCodeRan, undefined);
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

test("reward auto collect ignores non-reward attribute changes after a completed claim", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const tracked = createTrackedButton(dom, "통나무 받기");

    scope.appendChild(tracked.button);
    await waitForCondition(() => tracked.clicks === 1);

    tracked.button.title = "already claimed";
    tracked.button.setAttribute("role", "menuitem");
    tracked.button.type = "submit";
    tracked.button.id = "claimed-reward";

    await wait(650);
    assert.equal(tracked.clicks, 1);
});

test("reward auto collect matches the real split-text 통나무 reward button", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const tracked = createScreenshotRewardButton(dom);

    scope.appendChild(tracked.button);

    await waitForCondition(() => tracked.clicks === 1 && tracked.button.getAttribute("data-bcra-clicked") === "1");
    assert.match(tracked.button.textContent, /1시간 시청 통나무 파워 배달 완료!/);
    assert.match(tracked.button.textContent, /100 받기/);
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

test("reward auto collect ignores a generic power button outside the 1-hour watch row", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const dialog = dom.window.document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    const row = dom.window.document.createElement("li");
    const label = dom.window.document.createElement("span");
    label.textContent = "팔로우 보상";
    const tracked = createTrackedButton(dom, "100 파워");
    row.append(label, tracked.button);
    dialog.appendChild(row);
    scope.appendChild(dialog);

    await wait(450);

    assert.equal(tracked.clicks, 0);
    assert.equal(tracked.button.hasAttribute("data-bcra-clicked"), false);
});

test("reward auto collect matches the current 1-hour live verification button copy", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const tracked = createTrackedButton(dom, "1시간 라이브 시청 후 인증하기 100");

    scope.appendChild(tracked.button);

    await waitForCondition(() => tracked.clicks === 1);
    assert.equal(tracked.button.getAttribute("data-bcra-clicked"), "1");
});

test("reward auto collect ignores the static 1-hour acquisition-method row", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const item = dom.window.document.createElement("li");
    item.textContent = "1시간 라이브 시청 후 인증하기 100";
    makeVisible(item);
    let clicks = 0;
    item.addEventListener("click", () => {
        clicks += 1;
    });

    scope.appendChild(item);
    await wait(450);

    assert.equal(clicks, 0);
    assert.equal(item.hasAttribute("data-bcra-clicked"), false);
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

test("reward auto collect observes a reward inside a late-mounted live chat aside", async () => {
    const dom = createRewardDom();
    await wait(400);

    const scope = createRewardScope(dom);
    const tracked = createScreenshotRewardButton(dom);
    scope.appendChild(tracked.button);

    await waitForCondition(() => tracked.clicks === 1);
    assert.equal(tracked.button.getAttribute("data-bcra-clicked"), "1");
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

test("reward auto collect does not depend on animation frames to flush a late reward", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const originalQuerySelectorAll = scope.querySelectorAll.bind(scope);
    let initialFullScans = 0;
    scope.querySelectorAll = (selector) => {
        if (selector === candidateSelector) initialFullScans += 1;
        return originalQuerySelectorAll(selector);
    };

    await waitForCondition(() => initialFullScans >= 1);
    dom.window.requestAnimationFrame = () => 0;

    const tracked = createScreenshotRewardButton(dom);
    scope.appendChild(tracked.button);

    await waitForCondition(() => tracked.clicks === 1);
});

test("reward auto collect reconnects when the live chat aside is replaced", async () => {
    const dom = createRewardDom();
    const firstScope = createRewardScope(dom);
    const originalQuerySelectorAll = firstScope.querySelectorAll.bind(firstScope);
    let initialFullScans = 0;
    firstScope.querySelectorAll = (selector) => {
        if (selector === candidateSelector) initialFullScans += 1;
        return originalQuerySelectorAll(selector);
    };

    await waitForCondition(() => initialFullScans >= 1);

    firstScope.remove();
    const replacementScope = createRewardScope(dom);
    const tracked = createScreenshotRewardButton(dom);
    replacementScope.appendChild(tracked.button);

    await waitForCondition(() => tracked.clicks === 1);
});

test("reward auto collect follows the latest button when it is re-rendered during the click delay", async () => {
    const dom = createRewardDom({ rewardAutoCollectDelayMs: 500 });
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

test("reward auto collect treats an accessible-label reward change as a new claim", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const tracked = createTrackedButton(dom, "받기");
    tracked.button.setAttribute("aria-label", "1시간 시청 통나무 파워 배달 완료 100 받기");

    scope.appendChild(tracked.button);
    await waitForCondition(() => tracked.clicks === 1);

    tracked.button.setAttribute("aria-label", "2시간 시청 통나무 파워 배달 완료 200 받기");

    await waitForCondition(() => tracked.clicks === 2);
    await wait(400);
    assert.equal(tracked.clicks, 2);
});

test("reward auto collect claims every distinct reward shown in the same scan", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const first = createScreenshotRewardButton(dom);
    const second = createScreenshotRewardButton(dom, { hours: 2, amount: 200 });

    scope.append(first.button, second.button);

    await waitForCondition(() => first.clicks === 1 && second.clicks === 1);
    assert.equal(first.button.getAttribute("data-bcra-clicked"), "1");
    assert.equal(second.button.getAttribute("data-bcra-clicked"), "1");
});

test("reward auto collect allows the same reward text on a different live route", async () => {
    const dom = createRewardDom();
    const firstScope = createRewardScope(dom);
    const first = createScreenshotRewardButton(dom);

    firstScope.appendChild(first.button);
    await waitForCondition(() => first.clicks === 1);

    dom.window.history.pushState({}, "", "/live/other-channel");
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    firstScope.remove();

    const nextScope = createRewardScope(dom);
    const next = createScreenshotRewardButton(dom);
    nextScope.appendChild(next.button);

    await waitForCondition(() => next.clicks === 1);
});

test("reward auto collect reschedules a pending reward when the live route changes in place", async () => {
    const dom = createRewardDom({ rewardAutoCollectDelayMs: 500 });
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

test("reward auto collect allows the same reward after the previous state has disappeared", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const first = createScreenshotRewardButton(dom);

    scope.appendChild(first.button);
    await waitForCondition(() => first.clicks === 1);

    first.button.remove();
    await wait(900);

    const next = createScreenshotRewardButton(dom);
    scope.appendChild(next.button);

    await waitForCondition(() => next.clicks === 1);
});

test("reward auto collect keeps the same reward completed when it reappears inside the grace period", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const first = createScreenshotRewardButton(dom);

    scope.appendChild(first.button);
    await waitForCondition(() => first.clicks === 1);

    first.button.remove();
    await wait(600);

    const replacement = createScreenshotRewardButton(dom);
    scope.appendChild(replacement.button);
    await wait(800);

    assert.equal(first.clicks, 1);
    assert.equal(replacement.clicks, 0);
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

test("reward auto collect releases a hidden replacement after it stays hidden past the grace period", async () => {
    const dom = createRewardDom();
    const scope = createRewardScope(dom);
    const first = createScreenshotRewardButton(dom);

    scope.appendChild(first.button);
    await waitForCondition(() => first.clicks === 1);

    const replacement = createScreenshotRewardButton(dom);
    replacement.button.hidden = true;
    first.button.replaceWith(replacement.button);
    await wait(900);
    replacement.button.hidden = false;

    await waitForCondition(() => replacement.clicks === 1);
    assert.equal(first.clicks, 1);
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
    const dom = createRewardDom({ rewardAutoCollectDelayMs: 500 });
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
