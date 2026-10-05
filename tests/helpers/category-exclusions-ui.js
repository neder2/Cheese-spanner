const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { createCategoryExclusionsWorker } = require("./category-exclusions-worker.js");

const ROOT = path.resolve(__dirname, "../..");
const CATEGORY_KEY = "betterchzzkCategoryExclusionsV1";
const category = (categoryType = "GAME", categoryId = "A", categoryValue = "게임 하나") => ({
    categoryType,
    categoryId,
    categoryValue,
});
const state = (revision, categories = []) => ({ version: 1, revision, categories });
async function settle() {
    await new Promise((resolve) => setImmediate(resolve));
}

async function createCategoryUI(
    t,
    {
        worker = createCategoryExclusionsWorker(),
        pathname = "/lives",
        options = {},
        metadata,
        categoryCounts = {},
        bootstrapOptions = false,
    } = {}
) {
    await worker.ready();
    const dom = new JSDOM(
        '<body><nav id="sort"><button aria-selected="true">인기</button><button>최신</button><button>추천</button></nav><main id="grid"><article id="a"><a class="thumbnail" href="/live/channel-a"><img width="320" height="180" src="https://example.com/a.jpg" /></a><a class="title" href="/live/channel-a">게임 하나 Alpha</a><a class="category" href="/category/GAME/A/lives">게임 하나</a><span>100명 시청</span></article><article id="b"><a class="thumbnail" href="/live/channel-b"><img width="320" height="180" src="https://example.com/b.jpg" /></a><a class="title" href="/live/channel-b">게임 하나 Beta</a><a class="category" href="/category/SPORTS/A/lives">게임 하나</a><span>200명 시청</span></article><article id="c"><a class="thumbnail" href="/live/channel-c"><img width="320" height="180" src="https://example.com/c.jpg" /></a><a class="title" href="/live/channel-c">게임 하나 Gamma</a><span>300명 시청</span></article></main></body>',
        { url: `https://chzzk.naver.com${pathname}`, runScripts: "outside-only", pretendToBeVisual: true }
    );
    const { window } = dom;
    const buttons = new WeakMap();
    const keyListeners = new WeakMap();
    const addListener = window.EventTarget.prototype.addEventListener;
    window.EventTarget.prototype.addEventListener = function (type, callback, ...rest) {
        if (type === "click") {
            const callbacks = buttons.get(this) || [];
            callbacks.push(callback);
            buttons.set(this, callbacks);
        }
        if (type === "keydown") {
            const callbacks = keyListeners.get(this) || [];
            callbacks.push(callback);
            keyListeners.set(this, callbacks);
        }
        return addListener.call(this, type, callback, ...rest);
    };
    const timers = new Map();
    const frames = new Map();
    let timerId = 0;
    let closed = false;
    let observer;
    let schedules = 0;
    let currentMetadata = metadata;
    let yieldHook = null;
    const messages = [];
    const responseGates = [];
    const optionsReads = [];
    const optionsReadReleases = [];
    const searches = [];
    const listeners = new Set();
    const sender = { id: worker.storage.chrome.runtime.id, tab: { id: 101 }, frameId: 0, url: window.location.href };
    window.chrome = {
        runtime: {
            id: sender.id,
            get lastError() {
                return worker.storage.chrome.runtime.lastError;
            },
            sendMessage(message, callback) {
                messages.push(structuredClone(message));
                sender.url = window.location.href;
                void worker.send(message, { ...sender }).then((response) => {
                    const gate = responseGates.shift();
                    if (gate) {
                        gate.operation = structuredClone(message.operation);
                        gate.response = structuredClone(response);
                        gate.release = () => callback(response);
                    } else callback(response);
                });
            },
        },
        storage: {
            onChanged: {
                addListener(listener) {
                    listeners.add(listener);
                    worker.storage.listeners.changed.push(listener);
                },
                removeListener(listener) {
                    listeners.delete(listener);
                    const index = worker.storage.listeners.changed.indexOf(listener);
                    if (index >= 0) worker.storage.listeners.changed.splice(index, 1);
                },
            },
        },
    };
    if (bootstrapOptions) {
        Object.assign(worker.storage.sync, {
            categoryToolsFollowerBadgesEnabled: false,
            categoryToolsLiveElapsedEnabled: false,
            categoryToolsHideGlobalTagSearch: false,
            ...options,
        });
        window.chrome.storage.local = worker.storage.chrome.storage.local;
        window.chrome.storage.sync = {
            ...worker.storage.chrome.storage.sync,
            get(keys, callback) {
                optionsReads.push(structuredClone(keys));
                worker.storage.chrome.storage.sync.get(keys, (data) => {
                    optionsReadReleases.push(() => callback(data));
                });
            },
        };
    }
    const rect = (element, width = 320, height = 180, left = 20, top = 100) => {
        element.getBoundingClientRect = () => ({
            width,
            height,
            left,
            top,
            right: left + width,
            bottom: top + height,
            x: left,
            y: top,
        });
    };
    rect(window.document.getElementById("sort"), 420, 40, 20, 20);
    window.document.querySelectorAll("#sort button").forEach((button, i) => rect(button, 60, 30, 20 + i * 80, 25));
    rect(window.document.getElementById("grid"), 800, 400);
    window.document.querySelectorAll("article, article a, article img").forEach((element) => rect(element));
    window.setTimeout = (callback, delay) => {
        const id = ++timerId;
        timers.set(id, { callback, delay });
        return id;
    };
    window.clearTimeout = (id) => timers.delete(id);
    window.requestAnimationFrame = (callback) => {
        const id = ++timerId;
        frames.set(id, callback);
        return id;
    };
    window.cancelAnimationFrame = (id) => frames.delete(id);
    const load = (file) => window.eval(fs.readFileSync(path.join(ROOT, file), "utf8"));
    load("shared/settings.js");
    if (!bootstrapOptions) window.BetterChzzkSettings.getOptions = () => {};
    load("shared/data.js");
    load("shared/categoryExclusions.js");
    if (bootstrapOptions) load("content.js");
    const defaultMetadata = ["a", "b", "c"].map((id, i) => ({
        liveId: i + 1,
        liveTitle: `게임 하나 ${id}`,
        concurrentUserCount: (i + 1) * 100,
        liveImageUrl: `https://example.com/${id}.jpg`,
        categoryType: id === "b" ? "SPORTS" : "GAME",
        liveCategory: id === "c" ? "C" : "A",
        liveCategoryValue: "게임 하나",
        channel: { channelId: `channel-${id}`, channelName: id },
    }));
    const fetches = [];
    Object.assign(window.BetterChzzk.utils, {
        ...(!bootstrapOptions ? { bindFeatureOptions() {}, onReady() {} } : {}),
        normSpace: window.BetterChzzk.utils.compactSpaces,
        injectStyleOnce(id, css) {
            const style = window.document.createElement("style");
            style.id = id;
            style.textContent = css;
            window.document.head.appendChild(style);
        },
        createMutationObserverSync(config) {
            observer = config;
            return { disconnect() {}, disconnectAll() {} };
        },
        createThrottledDomSync() {
            const schedule = () => schedules++;
            schedule.cancel = () => {};
            return schedule;
        },
        startPageChangeDetection: () => () => {},
        sleep: async () => {
            if (yieldHook) yieldHook();
        },
        setLoadingReason(reasons, on, reason, apply) {
            if (on) reasons.add(reason);
            else reasons.delete(reason);
            apply();
        },
        fetchJson(url, config = {}) {
            fetches.push({ url, ...config });
            const info = url.match(/\/categories\/([^/]+)\/([^/]+)\/info$/);
            if (info)
                return Promise.resolve({
                    code: 200,
                    content: {
                        categoryType: decodeURIComponent(info[1]),
                        categoryId: decodeURIComponent(info[2]),
                        concurrentUserCount: categoryCounts[decodeURIComponent(info[2])] ?? 1,
                    },
                });
            if (url.includes("auto-complete/categories"))
                return new Promise((resolve, reject) => searches.push({ url, ...config, resolve, reject }));
            return Promise.resolve({ content: { data: currentMetadata || defaultMetadata, page: { next: null } } });
        },
    });
    for (const module of ["filterModel", "repository", "searchController"]) load(`features/categoryTools/${module}.js`);
    const source = fs.readFileSync(path.join(ROOT, "features/categoryTools.js"), "utf8");
    const end = source.lastIndexOf("})();");
    window.eval(`${source.slice(0, end)}
        globalThis.categoryUIHooks = {
            apply: applyTools,
            options: (value) => applyInitialOptions(BetterChzzkSettings.normalizeOptions(value)),
            pageChange: handlePageChange,
            numeric: (kind, min, max = 0) => { setFilterValue(kind, min, "", max, ""); updateUiState(); },
            refresh: refreshFollowerHydrationRows,
            appliedQuery: () => currentQuery,
            listSearch: (query) => { currentQuery = query; updateUiState(); },
            resetMetadata: () => dataRepository.resetSearchMetadata(routeKey(getRoute())),
            metadataState: () => dataRepository.metadataState(),
        };
        ${source.slice(end)}`);
    const optionsListenerCount = bootstrapOptions ? listeners.size : 0;
    const hooks = window.categoryUIHooks;
    const appliedOptions = {
        categoryToolsFollowerBadgesEnabled: false,
        categoryToolsLiveElapsedEnabled: false,
        categoryToolsHideGlobalTagSearch: false,
        ...options,
    };
    if (!bootstrapOptions) hooks.options(appliedOptions);
    function cleanup() {
        if (closed) return;
        hooks.options({ ...appliedOptions, categoryToolsEnabled: false, globalLiveCountEnabled: false });
        window.dispatchEvent(new window.Event("pagehide"));
        for (const listener of listeners) window.chrome.storage.onChanged.removeListener(listener);
        closed = true;
        dom.window.close();
    }
    t.after(cleanup);
    if (!bootstrapOptions) await hooks.apply();
    await settle();
    return {
        dom,
        window,
        hooks,
        worker,
        searches,
        fetches,
        timers,
        frames,
        messages,
        listeners,
        optionsReads,
        categorySubscriptions: () => listeners.size - optionsListenerCount,
        optionsReadPending: () => optionsReadReleases.length,
        releaseOptionsRead() {
            assert.ok(optionsReadReleases.length, "the real settings get callback is pending");
            optionsReadReleases.shift()();
        },
        fireDOMReady() {
            window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
        },
        schedules: () => schedules,
        onYield(callback) {
            yieldHook = callback;
        },
        options(value) {
            hooks.options({ ...appliedOptions, ...value });
        },
        metadata(value) {
            currentMetadata = value;
            hooks.resetMetadata();
        },
        open() {
            window.document.querySelector("[data-category-add-open]").click();
            return window.document.getElementById("betterchzzk-category-add-panel");
        },
        input(value, type = "input") {
            const input = window.document.querySelector("[data-category-search]");
            assert.ok(input);
            input.value = value;
            input.dispatchEvent(new window.Event(type, { bubbles: true }));
            return input;
        },
        runDelay() {
            const found = [...timers].find(([, timer]) => timer.delay === 300);
            assert.ok(found, "category input owns a 300 ms debounce");
            timers.delete(found[0]);
            found[1].callback();
        },
        outsideClick(target = window.document.body, isTrusted = true) {
            for (const callback of buttons.get(window.document) || [])
                callback.call(window.document, { target, isTrusted });
        },
        trustedClick(button) {
            assert.ok(
                button && button.isConnected && !button.disabled,
                "a user can activate only the current enabled button"
            );
            // JSDOM cannot create trusted browser events. Invoke the registered listener with an explicit user-input fixture.
            const event = {
                isTrusted: true,
                target: button,
                currentTarget: button,
                button: 0,
                preventDefault() {},
                stopPropagation() {},
            };
            for (const callback of buttons.get(button) || []) callback.call(button, event);
        },
        trustedKey(element, key = "Enter", fields = {}) {
            assert.ok(element && element.isConnected, "a user can type only into the current input");
            // JSDOM cannot create trusted keyboard events. Invoke the input's own listeners with a user-input fixture.
            const event = {
                isTrusted: true,
                key,
                keyCode: 13,
                repeat: false,
                isComposing: false,
                target: element,
                currentTarget: element,
                defaultPrevented: false,
                preventDefault() {
                    this.defaultPrevented = true;
                },
                stopPropagation() {},
                ...fields,
            };
            for (const callback of keyListeners.get(element) || []) callback.call(element, event);
            return event;
        },
        emit(value, area = "local") {
            for (const listener of [...listeners]) listener({ [CATEGORY_KEY]: { newValue: value } }, area);
        },
        pauseResponse() {
            const gate = {};
            responseGates.push(gate);
            return gate;
        },
        mutation(record) {
            observer.onMutations([record]);
            if (!observer.shouldIgnoreMutations([record]) && observer.shouldSchedule()) observer.schedule();
        },
        observer: () => observer,
        cleanup,
    };
}

module.exports = { createCategoryUI, category, state, settle, CATEGORY_KEY };
