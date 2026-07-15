const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");

function evalRepoScript(dom, ...parts) {
    dom.window.eval(fs.readFileSync(path.join(ROOT, ...parts), "utf8"));
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}

function apiComment(
    id,
    content,
    {
        attaches = null,
        buffCount = null,
        createdDate = "20260104225405",
        hideByCleanBot = false,
        nickname = `작성자 ${id}`,
        profileImageUrl = null,
        writer = false,
    } = {}
) {
    const row = {
        comment: {
            attaches,
            commentId: id,
            content,
            createdDate,
            deleted: false,
            hideByCleanBot,
        },
        user: {
            profileImageUrl,
            userIdHash: `user-${id}`,
            userNickname: nickname,
            writer,
        },
    };
    if (Number.isFinite(buffCount)) row.buffNerf = { buffCount, nerfCount: 0 };
    return row;
}

function apiContent({ active = true, best = [], next = null, rows = [], totalCount = rows.length } = {}) {
    return {
        bestComments: best,
        commentActive: active,
        comments: {
            commentCount: totalCount,
            data: rows,
            page: { next, prev: null },
            totalCount,
        },
    };
}

function chatAsideHtml({ includeLog = true } = {}) {
    return [
        '<aside id="vod-aside">',
        '<div class="native-chat-container">',
        '<div class="native-chat-header" style="height:44px">',
        '<h2 style="font-family:Arial,sans-serif;font-size:17px;font-weight:700;line-height:22px;letter-spacing:-0.2px">라이브 채팅 다시보기</h2>',
        '<button id="native-close" type="button">닫기</button>',
        "</div>",
        includeLog ? '<div class="native-chat-log" role="log">현재 채팅</div>' : "",
        "</div>",
        "</aside>",
    ].join("");
}

function createFixture({
    fetchComments,
    includeLog = true,
    initialOptions = {},
    nativeCommentsHtml = null,
    trackLifecycle = false,
    withIdleCallback = true,
    withIntersectionObserver = false,
} = {}) {
    const dom = new JSDOM(
        [
            "<!doctype html><html><head></head><body>",
            '<section id="player-layout"><video id="video"></video>',
            chatAsideHtml({ includeLog }),
            "</section>",
            `<main id="below-player">${nativeCommentsHtml ?? "하단 댓글 DOM 없음"}</main>`,
            "</body></html>",
        ].join(""),
        {
            url: "https://chzzk.naver.com/video/12345",
            runScripts: "outside-only",
            pretendToBeVisual: true,
        }
    );
    const { window } = dom;
    const { document } = window;
    const options = { vodCommentTabsEnabled: true, ...initialOptions };
    const optionListeners = [];
    const routeListeners = [];
    const requests = [];
    const intersectionObservers = [];
    const idleCallbacks = [];
    const lifecycle = {
        adapterAttach: 0,
        adapterDetach: 0,
        adapterRefresh: 0,
        idleCancel: 0,
        viewDestroy: 0,
    };
    const video = document.getElementById("video");
    const mediaState = { currentTime: 100, paused: false };

    if (withIdleCallback) {
        let nextIdleId = 1;
        window.requestIdleCallback = (callback) => {
            const record = { callback, cancelled: false, id: nextIdleId };
            nextIdleId += 1;
            idleCallbacks.push(record);
            return record.id;
        };
        window.cancelIdleCallback = (id) => {
            const record = idleCallbacks.find((entry) => entry.id === id);
            if (record && !record.cancelled) {
                record.cancelled = true;
                lifecycle.idleCancel += 1;
            }
        };
    }

    Object.defineProperty(video, "currentTime", {
        configurable: true,
        get: () => mediaState.currentTime,
        set: (value) => {
            mediaState.currentTime = Number(value);
        },
    });
    Object.defineProperty(video, "duration", { configurable: true, get: () => 7200 });
    Object.defineProperty(video, "paused", { configurable: true, get: () => mediaState.paused });

    const aside = document.getElementById("vod-aside");
    const container = document.querySelector(".native-chat-container");
    const header = document.querySelector(".native-chat-header");
    aside.getBoundingClientRect = () => ({ bottom: 540, height: 540, left: 0, right: 353, top: 0, width: 353 });
    container.getBoundingClientRect = () => ({
        bottom: 1803,
        height: 1803,
        left: 0,
        right: 353,
        top: 0,
        width: 353,
    });
    header.getBoundingClientRect = () => ({ bottom: 44, height: 44, left: 0, right: 353, top: 0, width: 353 });

    if (withIntersectionObserver) {
        window.IntersectionObserver = class FakeIntersectionObserver {
            constructor(callback, observerOptions) {
                this.callback = callback;
                this.options = observerOptions;
                this.targets = [];
                this.disconnected = false;
                intersectionObservers.push(this);
            }
            observe(target) {
                this.targets.push(target);
            }
            disconnect() {
                this.disconnected = true;
                this.targets = [];
            }
            trigger(isIntersecting = true) {
                this.callback(this.targets.map((target) => ({ isIntersecting, target })));
            }
        };
    }

    window.BetterChzzkSettings = {
        normalizeOptions: () => ({ ...options }),
    };
    window.BetterChzzk = {
        utils: {
            bindFeatureOptions(callback) {
                optionListeners.push(callback);
                callback({ ...options });
                return () => {};
            },
            async fetchChzzkCommentPage(request) {
                requests.push(request);
                if (fetchComments) return fetchComments(request, requests.length - 1);
                return apiContent();
            },
            getMainVideoElement: () => document.querySelector("video"),
            getVodVideoNoFromPath(pathname = window.location.pathname) {
                return pathname.match(/^\/video\/([^/?#]+)/)?.[1] || "";
            },
            injectStyleOnce(id, css) {
                if (document.getElementById(id)) return;
                const style = document.createElement("style");
                style.id = id;
                style.textContent = css;
                document.head.appendChild(style);
            },
            isVodRoute: () => /^\/video(?:\/|$)/.test(window.location.pathname),
            startPageChangeDetection(callback) {
                routeListeners.push(callback);
                return () => {};
            },
        },
    };

    evalRepoScript(dom, "features", "vodComments", "model.js");
    evalRepoScript(dom, "features", "vodComments", "repository.js");
    evalRepoScript(dom, "features", "vodComments", "nativeAdapter.js");
    evalRepoScript(dom, "features", "vodComments", "view.js");
    if (trackLifecycle) {
        const nativeAdapterModule = window.BetterChzzk.vodComments.nativeAdapter;
        const viewModule = window.BetterChzzk.vodComments.view;
        window.BetterChzzk.vodComments.nativeAdapter = Object.freeze({
            createNativeAdapter(config) {
                const adapter = nativeAdapterModule.createNativeAdapter(config);
                return Object.freeze({
                    ...adapter,
                    attach(...args) {
                        lifecycle.adapterAttach += 1;
                        return adapter.attach(...args);
                    },
                    detach(...args) {
                        lifecycle.adapterDetach += 1;
                        return adapter.detach(...args);
                    },
                    refresh(...args) {
                        lifecycle.adapterRefresh += 1;
                        return adapter.refresh(...args);
                    },
                });
            },
        });
        window.BetterChzzk.vodComments.view = Object.freeze({
            createCommentView(config) {
                const view = viewModule.createCommentView(config);
                return Object.freeze({
                    ...view,
                    destroy(...args) {
                        lifecycle.viewDestroy += 1;
                        return view.destroy(...args);
                    },
                });
            },
        });
    }
    evalRepoScript(dom, "features", "vodCommentTabs.js");

    return {
        document,
        dom,
        intersectionObservers,
        lifecycle,
        mediaState,
        options,
        requests,
        video,
        window,
        runIdleCallbacks() {
            const pending = idleCallbacks.splice(0);
            for (const record of pending) {
                if (!record.cancelled) record.callback({ didTimeout: false, timeRemaining: () => 50 });
            }
            return pending.filter((record) => !record.cancelled).length;
        },
        emitOptions(patch) {
            Object.assign(options, patch);
            optionListeners.forEach((listener) => listener({ ...options }));
        },
        emitRoute(pathname) {
            window.history.pushState({}, "", pathname);
            routeListeners.forEach((listener) => listener());
        },
    };
}

function delay(ms = 0) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(predicate, { timeoutMs = 1000, intervalMs = 10 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
        if (predicate()) return;
        await delay(intervalMs);
    }
    assert.fail("Timed out waiting for condition");
}

function clickCommentTab(document) {
    document.getElementById("betterchzzk-vod-comment-comment-tab").click();
}

test("VOD comment support factories avoid duplicate attach syncs and keep private helpers private", async (t) => {
    const fixture = createFixture({
        initialOptions: { vodCommentTabsEnabled: false },
        nativeCommentsHtml: '<div id="commentArea"><div id="commentBox-1"></div></div>',
    });
    t.after(() => fixture.dom.window.close());
    const { document, window } = fixture;
    const panel = document.createElement("div");
    panel.innerHTML = '<article data-bcvc-comment-id="1"></article>';
    document.body.appendChild(panel);
    let measurementCount = 0;
    const adapter = window.BetterChzzk.vodComments.nativeAdapter.createNativeAdapter({
        onMeasurements: () => {
            measurementCount += 1;
        },
    });
    const view = window.BetterChzzk.vodComments.view.createCommentView();

    assert.equal(adapter.scheduleSync, undefined);
    assert.equal(typeof adapter.syncCommentIds, "function");
    assert.equal(view.isRenderedStateCurrent, undefined);
    assert.equal(view.setScrollTop, undefined);

    adapter.attach({ panel });
    assert.equal(measurementCount, 1, "attach must perform its full native sync immediately");
    await delay(50);
    assert.equal(measurementCount, 1, "attach must not repeat the same full sync in a queued animation frame");

    const originalGetElementById = document.getElementById;
    let nativeRowLookups = 0;
    document.getElementById = function (id) {
        if (id === "commentBox-1") nativeRowLookups += 1;
        return originalGetElementById.call(this, id);
    };
    adapter.syncCommentIds([]);
    adapter.syncCommentIds(new Set());
    adapter.syncCommentIds([null, "", "   "]);
    await delay(30);
    assert.equal(nativeRowLookups, 0, "empty comment IDs must not schedule row synchronization");

    adapter.syncCommentIds(["1", 1, "1"]);
    adapter.syncCommentIds(new Set(["1"]));
    await delay(30);
    assert.equal(nativeRowLookups, 1, "duplicate row IDs must coalesce into one scheduled synchronization");
    assert.equal(measurementCount, 1, "row synchronization must not remeasure global native typography");

    adapter.detach();
    adapter.syncCommentIds(["1"]);
    await delay(30);
    assert.equal(nativeRowLookups, 1, "adapter synchronization must be a no-op after detach");
    assert.equal(measurementCount, 1, "detached row synchronization must not publish new measurements");
    document.getElementById = originalGetElementById;
    view.destroy();
    panel.remove();
});

test("VOD comment tabs preserve the native chat heading treatment and defer prefetch until after mount", async (t) => {
    const fixture = createFixture();
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;
    const heading = document.querySelector(".native-chat-header h2");
    const close = document.getElementById("native-close");
    const chatLog = document.querySelector("[role='log']");
    const tablist = document.getElementById("betterchzzk-vod-comment-tabs");
    const commentPanel = document.getElementById("betterchzzk-vod-comment-panel");
    const container = document.querySelector(".native-chat-container");

    assert.ok(tablist);
    assert.equal(document.getElementById("betterchzzk-vod-comment-chat-tab").textContent, "라이브 채팅 다시보기");
    assert.equal(document.getElementById("betterchzzk-vod-comment-comment-tab").textContent, "댓글");
    assert.equal(
        heading.parentElement.querySelector("h2"),
        heading,
        "native heading must stay in its React-owned tree"
    );
    assert.equal(document.getElementById("native-close"), close, "native header controls must be preserved");
    assert.equal(chatLog.getAttribute("data-bcvc-tab-hidden"), null);
    assert.equal(fixture.requests.length, 0, "comment prefetch must not block the synchronous native mount");

    assert.equal(tablist.style.getPropertyValue("--bcvc-heading-font-family"), "Arial, sans-serif");
    assert.equal(tablist.style.getPropertyValue("--bcvc-heading-font-size"), "17px");
    assert.equal(tablist.style.getPropertyValue("--bcvc-heading-font-weight"), "700");
    assert.equal(commentPanel.style.getPropertyValue("--bcvc-font-family"), "Arial, sans-serif");
    assert.equal(commentPanel.style.getPropertyValue("--bcvc-toolbar-font-family"), "Arial, sans-serif");
    assert.equal(container.style.getPropertyValue("--bcvc-panel-height"), "496px");
    const css = document.getElementById("betterchzzk-vod-comment-tabs-style").textContent;
    assert.match(css, /--Content-Neutral-Cool-Strong/);
    assert.match(css, /--Surface-Brand-Alpha-Weaker/);
    assert.match(css, /html\[dark\] #betterchzzk-vod-comment-panel/);
    assert.match(css, /body\[theme="dark"\] #betterchzzk-vod-comment-panel/);
    assert.match(css, /\.theme_dark #betterchzzk-vod-comment-panel/);
    assert.match(css, /font-family:var\(--bcvc-font-family,inherit\)/);
    assert.match(
        css,
        /\.bcvc-count\{[^}]*font-family:var\(--bcvc-toolbar-font-family,var\(--bcvc-font-family,inherit\)\)/s
    );
    assert.match(
        css,
        /\.bcvc-sort-button\{font-family:var\(--bcvc-toolbar-font-family,var\(--bcvc-font-family,inherit\)\)\}/
    );
    assert.doesNotMatch(css, /"Malgun Gothic"|"맑은 고딕"/);
    assert.match(css, /button\[aria-selected="true"\]\{\s*color:var\(--bcvc-text/);
    assert.match(css, /container-type:inline-size/);
    assert.match(css, /@container\s*\(max-width:300px\)/);
    assert.match(css, /#betterchzzk-vod-comment-chat-tab,\s*#betterchzzk-vod-comment-comment-tab\{[^}]*flex:1 1 50%/s);
    assert.match(css, /container-name:bcvc-tabs/);
    assert.match(css, /@container bcvc-tabs\s*\(max-width:240px\)/);
    assert.match(
        css,
        /#betterchzzk-vod-comment-chat-tab\{[^}]*flex:1 1 auto[^}]*justify-content:flex-start[^}]*padding-right:2px[^}]*padding-left:2px/s
    );
    assert.match(css, /#betterchzzk-vod-comment-comment-tab\{[^}]*flex:0 0 52px/s);
    assert.match(css, /height:var\(--bcvc-panel-height/);
    assert.doesNotMatch(css, /\[data-bcvc-container="1"\]\{[^}]*position:relative!important/s);
    assert.doesNotMatch(css, /\[data-bcvc-container="1"\]\{[^}]*height:100%!important/s);
    assert.match(css, /\[data-bcvc-native-log="1"\]\{[^}]*min-height:0!important/s);
    assert.doesNotMatch(css, /#betterchzzk-vod-comment-panel\{[^}]*bottom:0/s);
    assert.doesNotMatch(css, /font:\s*\d/);

    assert.equal(fixture.runIdleCallbacks(), 1);
    await waitForCondition(() => fixture.requests.length === 1);
    assert.equal(document.getElementById("betterchzzk-vod-comment-chat-tab").getAttribute("aria-selected"), "true");
    assert.equal(document.getElementById("betterchzzk-vod-comment-panel").hidden, true);
});

test("VOD comment option updates only run lifecycle work on enabled transitions", async (t) => {
    const fixture = createFixture({ trackLifecycle: true });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });

    await waitForCondition(() => fixture.document.getElementById("betterchzzk-vod-comment-tabs"));
    const initialPanel = fixture.document.getElementById("betterchzzk-vod-comment-panel");
    const afterInitialMount = { ...fixture.lifecycle };

    fixture.emitOptions({ autoQualityEnabled: false });

    assert.strictEqual(fixture.document.getElementById("betterchzzk-vod-comment-panel"), initialPanel);
    assert.deepEqual(
        fixture.lifecycle,
        afterInitialMount,
        "an unrelated option update must not refresh or rebuild the VOD comment lifecycle"
    );

    fixture.emitOptions({ vodCommentTabsEnabled: false });

    assert.equal(fixture.document.getElementById("betterchzzk-vod-comment-tabs"), null);
    assert.equal(fixture.lifecycle.adapterDetach, afterInitialMount.adapterDetach + 1);
    assert.equal(fixture.lifecycle.viewDestroy, afterInitialMount.viewDestroy + 1);
    assert.equal(fixture.lifecycle.idleCancel, afterInitialMount.idleCancel + 1);

    const afterDisable = { ...fixture.lifecycle };
    fixture.emitOptions({ autoQualityEnabled: true });
    assert.deepEqual(fixture.lifecycle, afterDisable, "unrelated updates while disabled must not repeat teardown work");

    fixture.emitOptions({ vodCommentTabsEnabled: true });
    await waitForCondition(() => fixture.document.getElementById("betterchzzk-vod-comment-tabs"));
    assert.notStrictEqual(fixture.document.getElementById("betterchzzk-vod-comment-panel"), initialPanel);
    assert.equal(fixture.lifecycle.adapterAttach, afterDisable.adapterAttach + 1);
});

test("VOD comment typography follows the measured native author, date, and message styles", (t) => {
    const fixture = createFixture({
        nativeCommentsHtml: [
            '<div id="commentArea"><button type="button" style="font-family:Sandoll Nemony2,sans-serif">인기순</button><div id="commentBox-1" style="font-family:Trebuchet MS,sans-serif">',
            '<button class="_information_fixture_101" type="button">',
            '<strong style="font-size:13px;font-weight:650;line-height:19px;letter-spacing:-0.1px"><span class="_show_tooltip_fixture_51"><span class="_content_tooltip_fixture_2"><span class="_text_tooltip_fixture_3" style="font-size:9px;font-weight:900;line-height:11px">작성자</span></span></span></strong>',
            '<span style="font-size:11px;font-weight:450;line-height:17px;letter-spacing:0.2px">01.04</span>',
            "</button>",
            '<div class="_content_fixture_40"><div class="_text_fixture_192" style="font-size:16px;font-weight:350;line-height:22px;letter-spacing:0.1px">원본 댓글</div></div>',
            "</div></div>",
        ].join(""),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const panel = fixture.document.getElementById("betterchzzk-vod-comment-panel");

    assert.equal(panel.style.getPropertyValue("--bcvc-font-family"), '"Trebuchet MS", sans-serif');
    assert.equal(panel.style.getPropertyValue("--bcvc-toolbar-font-family"), '"Sandoll Nemony2", sans-serif');
    assert.equal(panel.style.getPropertyValue("--bcvc-author-font-size"), "13px");
    assert.equal(panel.style.getPropertyValue("--bcvc-author-font-weight"), "650");
    assert.equal(panel.style.getPropertyValue("--bcvc-author-line-height"), "19px");
    assert.equal(panel.style.getPropertyValue("--bcvc-date-font-size"), "11px");
    assert.equal(panel.style.getPropertyValue("--bcvc-date-line-height"), "17px");
    assert.equal(panel.style.getPropertyValue("--bcvc-message-font-size"), "16px");
    assert.equal(panel.style.getPropertyValue("--bcvc-message-line-height"), "22px");
});

test("VOD comment typography remeasures when the first native row mounts later", async (t) => {
    const fixture = createFixture();
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;
    const panel = document.getElementById("betterchzzk-vod-comment-panel");
    assert.equal(panel.style.getPropertyValue("--bcvc-message-font-size"), "");

    const commentArea = document.createElement("div");
    commentArea.id = "commentArea";
    commentArea.innerHTML = [
        '<div id="commentBox-1" style="font-family:Verdana,sans-serif">',
        '<button class="_information_fixture_101" type="button"><strong style="font-size:13px;line-height:19px">작성자</strong><span style="font-size:11px;line-height:17px">01.04</span></button>',
        '<div class="_content_fixture_40"><div class="_text_fixture_192" style="font-size:16px;line-height:22px">늦게 마운트된 댓글</div></div>',
        "</div>",
    ].join("");
    document.getElementById("below-player").appendChild(commentArea);

    await waitForCondition(() => panel.style.getPropertyValue("--bcvc-message-font-size") === "16px");
    assert.equal(panel.style.getPropertyValue("--bcvc-font-family"), "Verdana, sans-serif");
    assert.equal(panel.style.getPropertyValue("--bcvc-author-line-height"), "19px");
    assert.equal(panel.style.getPropertyValue("--bcvc-date-line-height"), "17px");
    assert.equal(panel.style.getPropertyValue("--bcvc-message-line-height"), "22px");
});

test("VOD comment typography remeasures when the first native row fills in and restyles later", async (t) => {
    const fixture = createFixture({
        nativeCommentsHtml:
            '<div id="commentArea"><div id="commentBox-1" style="font-family:Verdana,sans-serif"></div></div>',
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;
    const panel = document.getElementById("betterchzzk-vod-comment-panel");
    const nativeRow = document.getElementById("commentBox-1");
    assert.equal(panel.style.getPropertyValue("--bcvc-message-font-size"), "");

    nativeRow.insertAdjacentHTML(
        "beforeend",
        [
            '<button class="_information_fixture_101" type="button"><strong id="late-native-author" style="font-size:13px;line-height:19px">작성자</strong><span style="font-size:11px;line-height:17px">01.04</span></button>',
            '<div class="_content_fixture_40"><div id="late-native-message" class="_text_fixture_192" style="font-size:16px;line-height:22px">늦게 완성된 댓글</div></div>',
        ].join("")
    );

    await waitForCondition(() => panel.style.getPropertyValue("--bcvc-message-font-size") === "16px");
    assert.equal(panel.style.getPropertyValue("--bcvc-author-line-height"), "19px");
    assert.equal(panel.style.getPropertyValue("--bcvc-date-line-height"), "17px");
    assert.equal(panel.style.getPropertyValue("--bcvc-message-line-height"), "22px");

    const originalQuerySelector = document.querySelector;
    let firstNativeRowQueries = 0;
    document.querySelector = function (selector) {
        if (selector === "#commentArea [id^='commentBox-']") firstNativeRowQueries += 1;
        return originalQuerySelector.call(this, selector);
    };
    document.getElementById("late-native-author").style.lineHeight = "21px";
    document.getElementById("late-native-message").style.fontSize = "18px";

    await waitForCondition(
        () =>
            panel.style.getPropertyValue("--bcvc-author-line-height") === "21px" &&
            panel.style.getPropertyValue("--bcvc-message-font-size") === "18px"
    );
    document.querySelector = originalQuerySelector;
    assert.equal(
        firstNativeRowQueries,
        2,
        "a native mutation batch must resolve the first row once before the single typography measurement"
    );
});

test("VOD comment first-page prefetch makes the initial tab open render from memory", async (t) => {
    const pending = deferred();
    const fixture = createFixture({ fetchComments: () => pending.promise });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    assert.equal(fixture.runIdleCallbacks(), 1);
    await waitForCondition(() => fixture.requests.length === 1);
    const panel = document.getElementById("betterchzzk-vod-comment-panel");
    assert.equal(panel.hidden, true);
    assert.equal(panel.querySelector(".bcvc-skeleton-list"), null);

    pending.resolve(apiContent({ rows: [apiComment(1, "미리 받은 댓글")], totalCount: 1 }));
    await delay();
    clickCommentTab(document);

    assert.match(panel.textContent, /미리 받은 댓글/);
    assert.equal(panel.querySelector(".bcvc-skeleton-list"), null);
    assert.equal(fixture.requests.length, 1, "opening the prefetched tab must not request page zero again");
});

test("VOD comment tab shares an in-flight first-page prefetch instead of starting a duplicate request", async (t) => {
    const pending = deferred();
    const fixture = createFixture({ fetchComments: () => pending.promise });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });

    assert.equal(fixture.runIdleCallbacks(), 1);
    await waitForCondition(() => fixture.requests.length === 1);
    clickCommentTab(fixture.document);

    const panel = fixture.document.getElementById("betterchzzk-vod-comment-panel");
    assert.ok(panel.querySelector(".bcvc-skeleton-list"));
    assert.equal(fixture.requests.length, 1, "tab open must share the prefetch request already in progress");

    pending.resolve(apiContent({ rows: [apiComment(1, "진행 중 프리페치")], totalCount: 1 }));
    await waitForCondition(() => /진행 중 프리페치/.test(panel.textContent));
    assert.equal(fixture.requests.length, 1);
});

test("VOD comment hidden prefetch failures retry normally when the tab is opened", async (t) => {
    const firstRequest = deferred();
    const fixture = createFixture({
        fetchComments: (_request, index) => {
            if (index === 0) return firstRequest.promise;
            return apiContent({ rows: [apiComment(1, "클릭 재시도 성공")], totalCount: 1 });
        },
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });

    assert.equal(fixture.runIdleCallbacks(), 1);
    await waitForCondition(() => fixture.requests.length === 1);
    firstRequest.reject(new Error("prefetch failed"));
    await delay();
    await delay();

    clickCommentTab(fixture.document);
    await waitForCondition(() =>
        /클릭 재시도 성공/.test(fixture.document.getElementById("betterchzzk-vod-comment-panel").textContent)
    );
    assert.equal(fixture.requests.length, 2, "a hidden speculative failure must not block the foreground retry");
});

test("VOD comments keep click-to-load when requestIdleCallback is unavailable", async (t) => {
    const fixture = createFixture({
        fetchComments: async () => apiContent({ rows: [apiComment(1, "클릭 로드")], totalCount: 1 }),
        withIdleCallback: false,
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });

    await delay();
    assert.equal(fixture.requests.length, 0);
    clickCommentTab(fixture.document);
    await waitForCondition(() =>
        /클릭 로드/.test(fixture.document.getElementById("betterchzzk-vod-comment-panel").textContent)
    );
    assert.equal(fixture.requests.length, 1);
});

test("VOD comment tabs mount after a delayed chat log and reuse cached comments after an aside remount", async (t) => {
    const fixture = createFixture({
        fetchComments: async () => apiContent({ rows: [apiComment(1, "유지할 댓글")], totalCount: 1 }),
        includeLog: false,
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    assert.equal(document.getElementById("betterchzzk-vod-comment-tabs"), null);
    const log = document.createElement("div");
    log.className = "native-chat-log";
    log.setAttribute("role", "log");
    log.textContent = "뒤늦게 마운트된 채팅";
    document.querySelector(".native-chat-container").appendChild(log);
    await waitForCondition(() => document.getElementById("betterchzzk-vod-comment-tabs"));

    clickCommentTab(document);
    await waitForCondition(() =>
        /유지할 댓글/.test(document.getElementById("betterchzzk-vod-comment-panel").textContent)
    );
    assert.equal(fixture.requests.length, 1);

    const oldPanel = document.getElementById("betterchzzk-vod-comment-panel");
    const oldRow = document.querySelector("[data-bcvc-comment-key='id:1']");
    oldPanel.scrollTop = 137;

    const oldAside = document.getElementById("vod-aside");
    const host = document.createElement("div");
    host.innerHTML = chatAsideHtml();
    oldAside.replaceWith(host.firstElementChild);
    await waitForCondition(
        () =>
            document.getElementById("vod-aside") !== oldAside &&
            document.getElementById("betterchzzk-vod-comment-comment-tab")?.getAttribute("aria-selected") === "true"
    );

    assert.match(document.getElementById("betterchzzk-vod-comment-panel").textContent, /유지할 댓글/);
    assert.equal(
        document.getElementById("betterchzzk-vod-comment-panel"),
        oldPanel,
        "same-VOD timeline shell replacement must move the existing comment panel"
    );
    assert.equal(
        document.querySelector("[data-bcvc-comment-key='id:1']"),
        oldRow,
        "same-VOD timeline shell replacement must preserve existing comment rows"
    );
    assert.equal(fixture.requests.length, 1, "same-VOD remount must reuse the loaded order state");
    assert.equal(document.getElementById("betterchzzk-vod-comment-panel").scrollTop, 137);
    assert.equal(document.querySelector("#vod-aside [role='log']").getAttribute("data-bcvc-tab-hidden"), "1");
    assert.equal(oldAside.hasAttribute("data-bcvc-mounted"), false);
});

test("VOD comments keep the same panel and in-flight request across a staged timeline shell gap", async (t) => {
    const pending = deferred();
    const fixture = createFixture({ fetchComments: () => pending.promise });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    clickCommentTab(document);
    await waitForCondition(() => document.querySelector(".bcvc-skeleton-list"));
    const panel = document.getElementById("betterchzzk-vod-comment-panel");
    const skeleton = panel.querySelector(".bcvc-skeleton-list");
    const oldAside = document.getElementById("vod-aside");

    oldAside.remove();
    await delay(120);
    assert.equal(panel.isConnected, false);
    assert.equal(fixture.requests.length, 1);

    const host = document.createElement("div");
    host.innerHTML = chatAsideHtml();
    document.getElementById("player-layout").appendChild(host.firstElementChild);
    await waitForCondition(
        () =>
            document.getElementById("betterchzzk-vod-comment-panel") === panel &&
            document.getElementById("betterchzzk-vod-comment-comment-tab")?.getAttribute("aria-selected") === "true"
    );

    assert.equal(panel.querySelector(".bcvc-skeleton-list"), skeleton);
    assert.equal(fixture.requests.length, 1, "timeline shell recovery must not restart the pending first page");

    pending.resolve(apiContent({ rows: [apiComment(1, "느린 댓글 유지")], totalCount: 1 }));
    await waitForCondition(() => /느린 댓글 유지/.test(panel.textContent));
    assert.equal(document.getElementById("betterchzzk-vod-comment-panel"), panel);
    assert.equal(fixture.requests.length, 1);
});

test("VOD comments release a permanently detached shell and remount cleanly when it returns", async (t) => {
    const firstRequest = deferred();
    const fixture = createFixture({
        fetchComments: (_request, index) =>
            index === 0 ? firstRequest.promise : apiContent({ rows: [apiComment(2, "재마운트 댓글")], totalCount: 1 }),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    clickCommentTab(document);
    await waitForCondition(() => document.querySelector(".bcvc-skeleton-list"));
    const oldPanel = document.getElementById("betterchzzk-vod-comment-panel");
    const oldTablist = document.getElementById("betterchzzk-vod-comment-tabs");
    const oldSignal = fixture.requests[0].signal;
    document.getElementById("vod-aside").remove();

    await waitForCondition(() => oldSignal.aborted, { timeoutMs: 1200 });
    assert.equal(oldPanel.isConnected, false);
    assert.equal(oldTablist.isConnected, false);

    const host = document.createElement("div");
    host.innerHTML = chatAsideHtml();
    document.getElementById("player-layout").appendChild(host.firstElementChild);
    await waitForCondition(() =>
        /재마운트 댓글/.test(document.getElementById("betterchzzk-vod-comment-panel")?.textContent || "")
    );

    assert.notEqual(document.getElementById("betterchzzk-vod-comment-panel"), oldPanel);
    assert.equal(fixture.requests.length, 2);
});

test("VOD comments reattach extension-owned nodes removed by a native timeline render", async (t) => {
    const fixture = createFixture({
        fetchComments: async () => apiContent({ rows: [apiComment(1, "노드 유지")], totalCount: 1 }),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    clickCommentTab(document);
    await waitForCondition(() => document.querySelector("[data-bcvc-comment-key='id:1']"));
    const panel = document.getElementById("betterchzzk-vod-comment-panel");
    const row = document.querySelector("[data-bcvc-comment-key='id:1']");
    const tablist = document.getElementById("betterchzzk-vod-comment-tabs");

    panel.remove();
    tablist.remove();
    await waitForCondition(
        () =>
            document.getElementById("betterchzzk-vod-comment-panel") === panel &&
            document.getElementById("betterchzzk-vod-comment-tabs") === tablist
    );

    assert.equal(document.querySelector("[data-bcvc-comment-key='id:1']"), row);
    assert.equal(fixture.requests.length, 1);
});

test("VOD comments load from the API without a lower comment DOM and render safe mobile-style rows", async (t) => {
    const pending = deferred();
    const best = apiComment(1, "첫 골 19:10", {
        attaches: [
            { attachType: "PHOTO", attachValue: "https://example.com/photo.jpg" },
            { attachType: "PHOTO", attachValue: "javascript:alert(1)" },
        ],
        buffCount: 2,
        createdDate: "20260101003000",
        nickname: "방송자",
        profileImageUrl: "https://example.com/avatar.jpg",
        writer: true,
    });
    const fixture = createFixture({ fetchComments: () => pending.promise });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;
    fixture.dom.window.Date.now = () => Date.UTC(2026, 0, 2, 0, 30, 0);

    assert.equal(document.getElementById("commentArea"), null);
    clickCommentTab(document);
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(
        {
            limit: fixture.requests[0].limit,
            objectId: fixture.requests[0].objectId,
            offset: fixture.requests[0].offset,
            orderType: fixture.requests[0].orderType,
        },
        { limit: 10, objectId: "12345", offset: 0, orderType: "POPULAR" }
    );
    assert.ok(document.querySelector(".bcvc-skeleton-list"));
    assert.equal(document.getElementById("betterchzzk-vod-comment-panel").getAttribute("aria-busy"), "true");

    pending.resolve(
        apiContent({
            best: [best],
            rows: [best, apiComment(2, "일반 댓글", { buffCount: 0, hideByCleanBot: true })],
            totalCount: 2,
        })
    );
    await waitForCondition(() => document.querySelectorAll("[data-bcvc-comment-key]").length === 2);

    assert.match(document.querySelector("[data-bcvc-count='1']").textContent, /댓글 2/);
    assert.equal(document.querySelectorAll(".bcvc-best").length, 1, "BEST and page duplicates must be merged");
    assert.ok(
        document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-message > .bcvc-best:first-child"),
        "BEST badge must lead the message like the native Chzzk comment row"
    );
    assert.equal(document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-meta .bcvc-best"), null);
    assert.equal(document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-date").textContent, "01.01");
    assert.match(document.querySelector("[data-bcvc-comment-key='id:1']").textContent, /방송자/);
    assert.ok(document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-writer"));
    assert.equal(document.querySelectorAll(".bcvc-attachment").length, 1, "unsafe attachment URLs must be dropped");
    assert.equal(
        document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-avatar > .bcvc-avatar-image")?.src,
        "https://example.com/avatar.jpg",
        "profile images must use the same framed image structure as native Chzzk comments"
    );
    assert.equal(document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-avatar").disabled, true);
    assert.equal(document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-author").disabled, true);
    assert.equal(document.querySelectorAll(".bcvc-buff").length, 1, "CleanBot-hidden rows must not expose actions");
    assert.equal(
        document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-buff").getAttribute("aria-label"),
        "버프 2"
    );
    assert.equal(document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-buff-count").textContent, "2");
    assert.equal(document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-buff").disabled, true);
    assert.equal(document.querySelector("[data-bcvc-comment-key='id:2'] .bcvc-buff-count"), null);
    const fallbackAvatar = document.querySelector("[data-bcvc-comment-key='id:2'] .bcvc-avatar-fallback");
    assert.equal(fallbackAvatar.textContent, "");
    const injectedStyle = document.getElementById("betterchzzk-vod-comment-tabs-style").textContent;
    assert.match(injectedStyle, /default_profile_light\.png/);
    assert.match(injectedStyle, /default_profile_dark\.png/);
    assert.doesNotMatch(injectedStyle, /\.bcvc-avatar-fallback::before/);
    assert.equal(document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-buff-label").textContent, "버프");
    assert.match(document.querySelector("[data-bcvc-comment-key='id:2']").textContent, /클린봇/);

    const panel = document.getElementById("betterchzzk-vod-comment-panel");
    const firstRow = document.querySelector("[data-bcvc-comment-key='id:1']");
    let bubbledClicks = 0;
    const onBubbledClick = () => {
        bubbledClicks += 1;
    };
    document.getElementById("vod-aside").addEventListener("click", onBubbledClick);
    panel.scrollTop = 91;
    document.querySelector(".bcvc-timecode").click();
    document.getElementById("vod-aside").removeEventListener("click", onBubbledClick);
    assert.equal(fixture.mediaState.currentTime, 1150);
    assert.equal(fixture.mediaState.paused, false);
    assert.equal(panel.scrollTop, 91);
    assert.equal(bubbledClicks, 0, "timecode controls must not bubble into the native React tree");
    assert.equal(document.querySelector("[data-bcvc-comment-key='id:1']"), firstRow);

    document.getElementById("betterchzzk-vod-comment-chat-tab").click();
    document.getElementById("betterchzzk-vod-comment-comment-tab").click();
    assert.equal(document.querySelector("[data-bcvc-comment-key='id:1']"), firstRow);
    assert.equal(panel.scrollTop, 91);
    document.getElementById("betterchzzk-vod-comment-comment-tab").click();
    assert.equal(document.querySelector("[data-bcvc-comment-key='id:1']"), firstRow);
});

test("VOD comment rows reuse native Chzzk profile and buff visuals without cloning native controls", async (t) => {
    const nativeProfileUrl = "https://example.com/native-avatar.jpg";
    const fixture = createFixture({
        fetchComments: async () =>
            apiContent({
                rows: [
                    apiComment(1, "원본 자산", {
                        buffCount: 3,
                        profileImageUrl: "https://example.com/api-avatar.jpg",
                    }),
                ],
                totalCount: 1,
            }),
        nativeCommentsHtml: [
            '<style>._buff_icon_fixture_5{display:block;width:47px;height:23px;background-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27/%3E")}</style>',
            '<div id="commentArea">',
            '<div id="commentBox-1">',
            '<button id="native-avatar-1" class="_thumbnail_fixture_76" type="button">',
            `<span style="display:inline-block;width:36px;height:36px;background-image:url('${nativeProfileUrl}');background-position:center;background-repeat:no-repeat;background-size:cover"></span>`,
            "</button>",
            '<button id="native-author-1" class="_information_fixture_101" type="button"><strong>작성자 1</strong><span>01.04</span></button>',
            '<button id="native-more-1" class="_button_more_fixture_53" type="button">더보기</button>',
            '<button id="native-time-1" class="_time_fixture_108" type="button">00:01</button>',
            '<button id="native-reply-1" class="_button_reply_fixture_275" type="button">답글 쓰기</button>',
            '<div class="_status_fixture_306"><button id="native-buff-1" class="_buff_button_fixture_1" type="button" aria-pressed="false"><i class="_buff_icon_fixture_5"><span class="blind">버프</span></i></button><span id="native-buff-count-1" class="_buff_count_fixture_27">3</span></div>',
            "</div>",
            "</div>",
        ].join(""),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document, window } = fixture;
    const nativeAvatarButton = document.getElementById("native-avatar-1");
    const nativeAuthorButton = document.getElementById("native-author-1");
    const nativeBuffButton = document.getElementById("native-buff-1");
    let avatarClicks = 0;
    let authorClicks = 0;
    let buffClicks = 0;
    nativeAvatarButton.addEventListener("click", () => {
        avatarClicks += 1;
    });
    nativeAuthorButton.addEventListener("click", () => {
        authorClicks += 1;
    });
    nativeBuffButton.addEventListener("click", () => {
        buffClicks += 1;
        nativeBuffButton.setAttribute("aria-pressed", "true");
        window.setTimeout(() => {
            document.getElementById("native-buff-count-1").firstChild.nodeValue = "4";
        }, 20);
        window.setTimeout(() => nativeBuffButton.setAttribute("aria-pressed", "false"), 80);
    });

    clickCommentTab(document);
    await waitForCondition(() => document.querySelector("[data-bcvc-comment-key='id:1']"));

    const nativeAvatar = document.querySelector("#native-avatar-1 > span");
    const mirroredAvatar = document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-avatar");
    const mirroredAuthor = document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-author");
    const reusedAvatar = document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-avatar-native-visual");
    assert.equal(mirroredAvatar.tagName, "BUTTON");
    assert.equal(mirroredAvatar.disabled, false);
    assert.equal(mirroredAuthor.tagName, "BUTTON");
    assert.equal(mirroredAuthor.disabled, false);
    assert.equal(
        window.getComputedStyle(reusedAvatar).backgroundImage,
        window.getComputedStyle(nativeAvatar).backgroundImage
    );
    assert.notEqual(reusedAvatar, nativeAvatar);
    assert.equal(nativeAvatar.closest("#commentBox-1")?.id, "commentBox-1");

    const nativeRow = document.getElementById("commentBox-1");
    const originalNativeRowQuerySelectorAll = nativeRow.querySelectorAll;
    let profileControlScans = 0;
    nativeRow.querySelectorAll = function (selector) {
        if (selector === "button, a[href], [role='button']") profileControlScans += 1;
        return originalNativeRowQuerySelectorAll.call(this, selector);
    };
    nativeAvatarButton.setAttribute("aria-disabled", "true");
    await waitForCondition(() => mirroredAvatar.disabled);
    nativeRow.querySelectorAll = originalNativeRowQuerySelectorAll;
    assert.equal(profileControlScans, 1, "each dirty mirrored row sync must resolve native profile controls only once");

    nativeAvatarButton.removeAttribute("aria-disabled");
    await waitForCondition(() => !mirroredAvatar.disabled);
    nativeAvatar.style.backgroundImage = "none";
    await waitForCondition(() => mirroredAvatar.querySelector(".bcvc-avatar-image"));
    assert.equal(
        mirroredAvatar.querySelector(".bcvc-avatar-image").src,
        "https://example.com/api-avatar.jpg",
        "a removed native background must fall back to the API profile image instead of staying stale"
    );

    const nativeBuffIcon = document.querySelector("#commentBox-1 i");
    const mirroredBuff = document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-buff");
    const reusedBuffIcon = document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-buff-native-icon");
    assert.equal(mirroredBuff.tagName, "BUTTON");
    assert.equal(mirroredBuff.disabled, false);
    assert.equal(mirroredBuff.getAttribute("aria-pressed"), "false");
    assert.ok(mirroredBuff.classList.contains("_buff_button_fixture_1"));
    assert.ok(reusedBuffIcon);
    assert.notEqual(reusedBuffIcon, nativeBuffIcon);
    assert.ok(reusedBuffIcon.classList.contains("_buff_icon_fixture_5"));
    assert.equal(reusedBuffIcon.children.length, 0);
    assert.equal(reusedBuffIcon.closest("button"), mirroredBuff);
    assert.equal(nativeBuffIcon.closest("button").getAttribute("aria-pressed"), "false");
    assert.equal(
        window.getComputedStyle(reusedBuffIcon).backgroundImage,
        window.getComputedStyle(nativeBuffIcon).backgroundImage
    );

    mirroredAvatar.click();
    mirroredAuthor.click();
    mirroredBuff.click();
    assert.equal(avatarClicks, 1, "the avatar must delegate only to the native thumbnail control");
    assert.equal(authorClicks, 1, "the author must delegate only to the native information control");
    assert.equal(buffClicks, 1, "the mirrored buff control must delegate exactly one native action");
    await waitForCondition(() => mirroredBuff.getAttribute("aria-pressed") === "true");
    await waitForCondition(() => mirroredBuff.getAttribute("aria-label") === "버프 4");
    await waitForCondition(() => mirroredBuff.getAttribute("aria-pressed") === "false");
    assert.equal(mirroredBuff.getAttribute("aria-label"), "버프 4");
    assert.equal(mirroredBuff.querySelector(".bcvc-buff-count").textContent, "4");
    assert.equal(mirroredBuff.title, "버프 4");
    assert.equal(nativeAvatarButton.closest("#commentBox-1")?.id, "commentBox-1");
    assert.equal(nativeAuthorButton.closest("#commentBox-1")?.id, "commentBox-1");
    assert.equal(nativeBuffButton.closest("#commentBox-1")?.id, "commentBox-1");

    nativeAvatarButton.setAttribute("aria-disabled", "true");
    await waitForCondition(() => mirroredAvatar.disabled);
    assert.equal(mirroredAuthor.disabled, false, "the author control must remain independently available");
    assert.equal(mirroredAvatar.getAttribute("aria-describedby"), "betterchzzk-vod-comment-native-action-hint");
    document.getElementById("commentArea").remove();
    await waitForCondition(() => mirroredAuthor.disabled && mirroredBuff.disabled);
    assert.equal(mirroredBuff.getAttribute("aria-describedby"), "betterchzzk-vod-comment-native-action-hint");

    const replacementArea = document.createElement("div");
    replacementArea.id = "commentArea";
    replacementArea.innerHTML = [
        '<div id="commentBox-1">',
        '<button id="replacement-avatar-1" class="_thumbnail_fixture_76" type="button"><span style="background-image:url(\'https://example.com/replacement-avatar.jpg\')"></span></button>',
        '<button id="replacement-author-1" class="_information_fixture_101" type="button"><strong>작성자 1</strong></button>',
        '<button id="replacement-buff-1" type="button" aria-pressed="false" aria-label="버프 5"><i class="_buff_icon_fixture_5"></i></button>',
        "</div>",
    ].join("");
    let replacementClicks = 0;
    for (const control of replacementArea.querySelectorAll("button")) {
        control.addEventListener("click", () => {
            replacementClicks += 1;
        });
    }
    document.getElementById("below-player").appendChild(replacementArea);

    await waitForCondition(() => !mirroredAvatar.disabled && !mirroredAuthor.disabled && !mirroredBuff.disabled);
    mirroredAvatar.click();
    mirroredAuthor.click();
    mirroredBuff.click();
    assert.equal(replacementClicks, 3, "replacement native controls must receive the next delegated actions");
    await waitForCondition(() => mirroredBuff.getAttribute("aria-label") === "버프 5");
    assert.match(
        window.getComputedStyle(mirroredAvatar.querySelector(".bcvc-avatar-native-visual")).backgroundImage,
        /replacement-avatar/
    );
    assert.equal(fixture.requests.length, 1, "native control remounts must not reload API comments");
});

test("VOD comment native actions stay isolated to the matching native comment row", async (t) => {
    const fixture = createFixture({
        fetchComments: async () =>
            apiContent({
                rows: [apiComment(1, "원본 있음", { buffCount: 1 }), apiComment(2, "원본 없음", { buffCount: 2 })],
                totalCount: 2,
            }),
        nativeCommentsHtml: [
            '<div id="commentArea"><div id="commentBox-1">',
            '<button id="native-avatar-isolated" class="_thumbnail_fixture_76" type="button"><span></span></button>',
            '<button id="native-author-isolated" class="_information_fixture_101" type="button"><strong>작성자 1</strong></button>',
            '<button id="native-buff-isolated" type="button" aria-pressed="false"><span class="blind">버프</span></button>',
            "</div></div>",
        ].join(""),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;
    let nativeClicks = 0;
    for (const control of document.querySelectorAll("#commentBox-1 button")) {
        control.addEventListener("click", () => {
            nativeClicks += 1;
        });
    }

    clickCommentTab(document);
    await waitForCondition(() => document.querySelector("[data-bcvc-comment-key='id:2']"));

    const firstRow = document.querySelector("[data-bcvc-comment-key='id:1']");
    const secondRow = document.querySelector("[data-bcvc-comment-key='id:2']");
    assert.equal(firstRow.querySelector(".bcvc-avatar").disabled, false);
    assert.equal(firstRow.querySelector(".bcvc-author").disabled, false);
    assert.equal(firstRow.querySelector(".bcvc-buff").disabled, false);
    assert.equal(secondRow.querySelector(".bcvc-avatar").disabled, true);
    assert.equal(secondRow.querySelector(".bcvc-author").disabled, true);
    assert.equal(secondRow.querySelector(".bcvc-buff").disabled, true);

    secondRow.querySelector(".bcvc-avatar").click();
    secondRow.querySelector(".bcvc-author").click();
    secondRow.querySelector(".bcvc-buff").click();
    assert.equal(nativeClicks, 0, "an API-only row must never borrow another comment's native actions");
});

test("VOD comment native actions resync every mirrored row when a native row id is assigned or reused", async (t) => {
    const fixture = createFixture({
        fetchComments: async () =>
            apiContent({
                rows: [apiComment(1, "첫 댓글", { buffCount: 1 }), apiComment(2, "둘째 댓글", { buffCount: 2 })],
                totalCount: 2,
            }),
        nativeCommentsHtml: [
            '<div id="commentArea"><div id="pending-native-row">',
            '<button class="_thumbnail_fixture_76" type="button"><span></span></button>',
            '<button class="_information_fixture_101" type="button"><strong>원본 작성자</strong></button>',
            '<button type="button" aria-pressed="false"><span class="blind">버프</span></button>',
            "</div></div>",
        ].join(""),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    clickCommentTab(document);
    await waitForCondition(() => document.querySelector("[data-bcvc-comment-key='id:2']"));
    const firstMirror = document.querySelector("[data-bcvc-comment-key='id:1']");
    const secondMirror = document.querySelector("[data-bcvc-comment-key='id:2']");
    const pendingNativeRow = document.getElementById("pending-native-row");
    const mirroredControls = (row) => [
        row.querySelector(".bcvc-avatar"),
        row.querySelector(".bcvc-author"),
        row.querySelector(".bcvc-buff"),
    ];

    assert.ok(mirroredControls(firstMirror).every((control) => control.disabled));
    assert.ok(mirroredControls(secondMirror).every((control) => control.disabled));

    pendingNativeRow.id = "commentBox-1";
    await waitForCondition(() => mirroredControls(firstMirror).every((control) => !control.disabled));
    assert.ok(mirroredControls(secondMirror).every((control) => control.disabled));

    pendingNativeRow.id = "commentBox-2";
    await waitForCondition(
        () =>
            mirroredControls(firstMirror).every((control) => control.disabled) &&
            mirroredControls(secondMirror).every((control) => !control.disabled)
    );
    assert.equal(fixture.requests.length, 1, "native id changes must not reload API comments");
});

test("VOD comment native actions do not cross nested commentBox boundaries", async (t) => {
    const fixture = createFixture({
        fetchComments: async () =>
            apiContent({
                rows: [apiComment(1, "부모 원본 없음", { buffCount: 1 }), apiComment(2, "중첩 원본", { buffCount: 2 })],
                totalCount: 2,
            }),
        nativeCommentsHtml: [
            '<div id="commentArea"><div id="commentBox-1"><div id="commentBox-2">',
            '<button class="_thumbnail_fixture_76" type="button"><span></span></button>',
            '<button class="_information_fixture_101" type="button"><strong>작성자 2</strong></button>',
            '<button type="button" aria-pressed="false"><span class="blind">버프</span></button>',
            "</div></div></div>",
        ].join(""),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    clickCommentTab(document);
    await waitForCondition(() => document.querySelector("[data-bcvc-comment-key='id:2']"));
    const parent = document.querySelector("[data-bcvc-comment-key='id:1']");
    const nested = document.querySelector("[data-bcvc-comment-key='id:2']");

    assert.equal(parent.querySelector(".bcvc-avatar").disabled, true);
    assert.equal(parent.querySelector(".bcvc-author").disabled, true);
    assert.equal(parent.querySelector(".bcvc-buff").disabled, true);
    assert.equal(nested.querySelector(".bcvc-avatar").disabled, false);
    assert.equal(nested.querySelector(".bcvc-author").disabled, false);
    assert.equal(nested.querySelector(".bcvc-buff").disabled, false);
});

test("VOD buff mirrors text-node-only count updates from the scoped native observer", async (t) => {
    const fixture = createFixture({
        fetchComments: async () => apiContent({ rows: [apiComment(1, "버프 갱신", { buffCount: 3 })] }),
        nativeCommentsHtml: [
            '<div id="commentArea"><div id="commentBox-1">',
            '<div class="_status_fixture_306"><button class="_buff_button_fixture_1" type="button" aria-pressed="false">',
            '<i class="_buff_icon_fixture_5"><span class="blind">버프</span></i>',
            '</button><span id="native-buff-count-1" class="_buff_count_fixture_27">3</span></div></div></div>',
        ].join(""),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    clickCommentTab(document);
    await waitForCondition(() => document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-buff"));
    const mirroredBuff = document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-buff");
    assert.equal(mirroredBuff.getAttribute("aria-label"), "버프 3");

    document.getElementById("native-buff-count-1").firstChild.nodeValue = "4";
    await waitForCondition(() => mirroredBuff.getAttribute("aria-label") === "버프 4");
    assert.equal(mirroredBuff.querySelector(".bcvc-buff-count").textContent, "4");
    assert.equal(mirroredBuff.getAttribute("data-bcvc-confirmed"), null);
});

test("VOD comment rows render observed replies and tolerate nullable or deleted API rows", async (t) => {
    const parent = apiComment(1, "부모 댓글");
    const directReply = {
        buffNerf: { buffCount: 2, nerfCount: 0 },
        commentId: 7,
        commentType: "COMMENT",
        content: "직접 답글 00:45",
        createdDate: "20260104225505",
        deleted: false,
        hideByCleanBot: false,
        user: {
            profileImageUrl: null,
            userIdHash: "user-7",
            userNickname: "직접 답글 작성자",
            writer: false,
        },
    };
    parent.replyComments = [apiComment(2, "답글 00:30", { buffCount: 1 }), directReply];
    parent.comment.replyComments = [{ ...directReply, user: { ...directReply.user } }];
    const nullUser = apiComment(3, "탈퇴 사용자 댓글");
    nullUser.user = null;
    const nullComment = apiComment(4, "사용되지 않는 본문");
    nullComment.comment = null;
    const deleted = apiComment(5, "삭제 전 본문", { buffCount: 9 });
    deleted.comment.deleted = true;
    const invalidDate = apiComment(6, "잘못된 날짜", { createdDate: "20260231010101" });
    const cappedReplies = apiComment(8, "답글 제한 확인");
    cappedReplies.replyComments = Array.from({ length: 51 }, (_, index) => ({
        commentId: 100 + index,
        commentType: "COMMENT",
        content: `제한 답글 ${index + 1}`,
        createdDate: "20260104225605",
        deleted: false,
        hideByCleanBot: false,
        user: { userIdHash: `reply-user-${index}`, userNickname: `답글 ${index + 1}` },
    }));

    const fixture = createFixture({
        fetchComments: async () =>
            apiContent({ rows: [parent, nullUser, nullComment, deleted, invalidDate, cappedReplies], totalCount: 6 }),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    clickCommentTab(document);
    await waitForCondition(() => document.querySelector("[data-bcvc-reply='1']"));

    const replyToggle = document.querySelector("[data-bcvc-comment-key='id:1'] [data-bcvc-action='reply-toggle']");
    const replyList = document.querySelector("[data-bcvc-comment-key='id:1'] > .bcvc-replies");
    assert.equal(
        replyToggle.closest(".bcvc-comment-footer")?.parentElement?.getAttribute("data-bcvc-comment-key"),
        "id:1"
    );
    assert.equal(replyToggle.textContent.trim(), "답글 2");
    assert.equal(replyToggle.querySelector("svg")?.getAttribute("viewBox"), "0 0 14 14");
    assert.equal(replyToggle.querySelector("path")?.getAttribute("d"), "M10 8.2002L7 5.2002L4 8.2002");
    assert.equal(replyToggle.getAttribute("aria-expanded"), "false");
    assert.equal(replyList.hidden, true);
    replyToggle.click();
    assert.equal(replyToggle.getAttribute("aria-expanded"), "true");
    assert.equal(replyToggle.textContent.trim(), "답글 2");
    assert.equal(replyList.hidden, false);

    const reply = document.querySelector("[data-bcvc-reply='1']");
    assert.match(reply.textContent, /답글 00:30/);
    assert.equal(reply.closest(".bcvc-replies")?.getAttribute("role"), "list");
    assert.equal(reply.querySelector(".bcvc-mention")?.textContent, "작성자 1");
    assert.equal(reply.querySelector(".bcvc-message")?.textContent.trim(), "작성자 1답글 00:30");
    const injectedStyle = document.getElementById("betterchzzk-vod-comment-tabs-style").textContent;
    assert.match(injectedStyle, /\.bcvc-replies\{[^}]*margin:4px 0 0 12px[^}]*\}/s);
    assert.match(injectedStyle, /\.bcvc-replies \.bcvc-comment\{[^}]*padding:9px 0 5px 30px[^}]*\}/s);
    assert.match(injectedStyle, /\.bcvc-replies \.bcvc-avatar\{[^}]*width:22px[^}]*height:22px[^}]*\}/s);
    const directReplyRow = document.querySelector("[data-bcvc-comment-id='7']");
    assert.match(directReplyRow.textContent, /직접 답글 00:45/);
    assert.equal(directReplyRow.querySelector(".bcvc-mention")?.textContent, "작성자 1");
    assert.match(directReplyRow.textContent, /직접 답글 작성자/);
    assert.ok(directReplyRow.querySelector("[data-bcvc-seconds='45']"));
    assert.equal(
        document.querySelectorAll("[data-bcvc-comment-id='7']").length,
        1,
        "separately materialized reply sources must deduplicate by commentId"
    );
    const cappedRow = document.querySelector("[data-bcvc-comment-key='id:8']");
    assert.equal(cappedRow.querySelectorAll("[data-bcvc-reply='1']").length, 50);
    assert.match(cappedRow.querySelector(".bcvc-reply-limit").textContent, /50개까지만/);
    assert.match(document.querySelector("[data-bcvc-comment-key='id:3']").textContent, /알 수 없음/);
    assert.match(document.querySelector("[data-bcvc-comment-key*='fallback:']").textContent, /표시할 수 없는 댓글/);
    assert.equal(document.querySelector("[data-bcvc-comment-key='id:5'] .bcvc-avatar"), null);
    assert.equal(document.querySelector("[data-bcvc-comment-key='id:5'] .bcvc-buff"), null);
    assert.equal(document.querySelector("[data-bcvc-comment-key='id:6'] .bcvc-date").textContent, "20260231010101");

    replyToggle.click();
    assert.equal(replyToggle.getAttribute("aria-expanded"), "false");
    assert.equal(replyToggle.textContent.trim(), "답글 2");
    assert.equal(replyList.hidden, true);
});

test("VOD long comments start collapsed and can be expanded and collapsed in place", async (t) => {
    const longText = Array.from(
        { length: 30 },
        (_, index) => `${String(index + 1).padStart(2, "0")}:00 긴 댓글 줄`
    ).join("\n");
    const fixture = createFixture({
        fetchComments: async () => apiContent({ rows: [apiComment(1, longText)], totalCount: 1 }),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    clickCommentTab(document);
    await waitForCondition(() => document.querySelector("[data-bcvc-action='message-toggle']"));
    const toggle = document.querySelector("[data-bcvc-action='message-toggle']");
    const content = document.querySelector(".bcvc-message-content");

    assert.equal(toggle.textContent, "더보기");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.ok(content.textContent.length < longText.length);
    assert.doesNotMatch(content.textContent, /30:00/);

    toggle.click();
    assert.equal(toggle.textContent, "접기");
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.match(content.textContent, /30:00/);

    toggle.click();
    assert.equal(toggle.textContent, "더보기");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.doesNotMatch(content.textContent, /30:00/);
});

test("VOD long-comment toggles synchronize only the changed native row", async (t) => {
    const firstLongText = Array.from({ length: 30 }, (_, index) => {
        if (index === 0) return "00:01 첫 번째 댓글 시작";
        if (index === 29) return "30:00 첫 번째 댓글 끝";
        return `첫 번째 댓글 ${index + 1}`;
    }).join("\n");
    const secondLongText = Array.from({ length: 30 }, (_, index) => {
        if (index === 0) return "00:02 두 번째 댓글 시작";
        if (index === 29) return "31:00 두 번째 댓글 끝";
        return `두 번째 댓글 ${index + 1}`;
    }).join("\n");
    const fixture = createFixture({
        fetchComments: async () =>
            apiContent({
                rows: [apiComment(1, firstLongText), apiComment(2, secondLongText)],
                totalCount: 2,
            }),
        nativeCommentsHtml: [
            '<div id="commentArea">',
            '<div id="commentBox-1"><button id="native-time-1a" type="button">19:11</button><button id="native-time-1b" type="button">19:12</button></div>',
            '<div id="commentBox-2"><button id="native-time-2a" type="button">20:21</button><button id="native-time-2b" type="button">20:22</button></div>',
            "</div>",
        ].join(""),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document, window } = fixture;
    let nativeSecondTimecodeClicks = 0;
    document.getElementById("native-time-1b").addEventListener("click", () => {
        nativeSecondTimecodeClicks += 1;
    });

    clickCommentTab(document);
    await waitForCondition(() => document.querySelectorAll("[data-bcvc-action='message-toggle']").length === 2);
    await waitForCondition(
        () =>
            document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-timecode")?.textContent === "19:11" &&
            document.querySelector("[data-bcvc-comment-key='id:2'] .bcvc-timecode")?.textContent === "20:21"
    );

    const firstRow = document.querySelector("[data-bcvc-comment-key='id:1']");
    const firstToggle = firstRow.querySelector("[data-bcvc-action='message-toggle']");
    const originalGetElementById = document.getElementById;
    const originalGetComputedStyle = window.getComputedStyle;
    let firstNativeRowLookups = 0;
    let secondNativeRowLookups = 0;
    let nativeStyleReads = 0;
    document.getElementById = function (id) {
        if (id === "commentBox-1") firstNativeRowLookups += 1;
        if (id === "commentBox-2") secondNativeRowLookups += 1;
        return originalGetElementById.call(this, id);
    };
    window.getComputedStyle = function (...args) {
        nativeStyleReads += 1;
        return originalGetComputedStyle.apply(this, args);
    };

    firstToggle.click();
    await waitForCondition(
        () =>
            firstRow.querySelectorAll(".bcvc-timecode").length === 2 &&
            firstRow.querySelectorAll(".bcvc-timecode")[1].textContent === "19:12"
    );
    firstToggle.click();
    await waitForCondition(() => firstNativeRowLookups === 2);
    firstToggle.click();
    await waitForCondition(
        () => firstNativeRowLookups === 3 && firstRow.querySelectorAll(".bcvc-timecode")[1]?.textContent === "19:12"
    );

    assert.equal(secondNativeRowLookups, 0, "long-comment toggles must not look up an unchanged native row");
    assert.equal(nativeStyleReads, 0, "long-comment toggles must not remeasure global native styles");
    firstRow.querySelectorAll(".bcvc-timecode")[1].click();
    assert.equal(nativeSecondTimecodeClicks, 1, "a newly rendered timecode must retain native control forwarding");
    assert.equal(
        fixture.mediaState.currentTime,
        100,
        "successful native forwarding must not also perform a direct seek"
    );

    document.getElementById = originalGetElementById;
    window.getComputedStyle = originalGetComputedStyle;
});

test("VOD comment rendering caps total nested replies without hiding the limit", async (t) => {
    const parents = Array.from({ length: 7 }, (_, parentIndex) => {
        const parent = apiComment(parentIndex + 1, `부모 ${parentIndex + 1}`);
        parent.replyComments = Array.from({ length: 50 }, (_, replyIndex) => ({
            commentId: 1000 + parentIndex * 50 + replyIndex,
            commentType: "COMMENT",
            content: `답글 ${parentIndex + 1}-${replyIndex + 1}`,
            createdDate: "20260104225605",
            deleted: false,
            hideByCleanBot: false,
            user: { userIdHash: `reply-${parentIndex}-${replyIndex}`, userNickname: "답글 작성자" },
        }));
        return parent;
    });
    const fixture = createFixture({
        fetchComments: async () => apiContent({ rows: parents, totalCount: parents.length }),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    clickCommentTab(document);
    await waitForCondition(() => document.querySelectorAll("[data-bcvc-reply='1']").length === 300);
    assert.equal(document.querySelectorAll("[data-bcvc-reply='1']").length, 300);
    assert.match(document.querySelector("[data-bcvc-comment-key='id:7'] .bcvc-reply-limit").textContent, /300개까지만/);
});

test("VOD buff fallback upgrades in place when native lower comments mount later", async (t) => {
    const fixture = createFixture({
        fetchComments: async () => apiContent({ rows: [apiComment(1, "지연 원본", { buffCount: 1 })] }),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    clickCommentTab(document);
    await waitForCondition(() => document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-buff-label"));
    const renderedRow = document.querySelector("[data-bcvc-comment-key='id:1']");

    const style = document.createElement("style");
    style.textContent =
        '._buff_icon_delayed_5{display:block;width:47px;height:23px;background-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27/%3E")}';
    const commentArea = document.createElement("div");
    commentArea.id = "commentArea";
    commentArea.innerHTML = [
        '<div id="commentBox-1">',
        '<button type="button" aria-pressed="false"><i class="_buff_icon_delayed_5"><span>버프</span></i></button>',
        "</div>",
    ].join("");
    document.head.appendChild(style);
    document.getElementById("below-player").appendChild(commentArea);

    await waitForCondition(() => renderedRow.querySelector(".bcvc-buff-native-icon"));
    assert.equal(document.querySelector("[data-bcvc-comment-key='id:1']"), renderedRow);
    assert.equal(renderedRow.querySelector(".bcvc-buff-label"), null);
    assert.ok(renderedRow.querySelector(".bcvc-buff-native-icon").classList.contains("_buff_icon_delayed_5"));
    assert.equal(renderedRow.querySelector(".bcvc-buff").disabled, false);
    assert.equal(fixture.requests.length, 1, "asset synchronization must not reload comments");
});

test("VOD mirrored timecodes invoke the matching native comment control", async (t) => {
    const fixture = createFixture({
        fetchComments: async () => apiContent({ rows: [apiComment(1, "원본 이동 19:10")], totalCount: 1 }),
        nativeCommentsHtml: [
            '<div id="commentArea"><div id="commentBox-1">',
            '<button id="native-time-1" class="_time_fixture_108" type="button">19:12</button>',
            "</div></div>",
        ].join(""),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;
    let nativeClicks = 0;
    document.getElementById("native-time-1").addEventListener("click", () => {
        nativeClicks += 1;
    });

    clickCommentTab(document);
    await waitForCondition(() => document.querySelector(".bcvc-timecode"));
    const mirrored = document.querySelector(".bcvc-timecode");
    assert.equal(mirrored.textContent, "19:12");
    assert.equal(mirrored.getAttribute("data-bcvc-seconds"), String(19 * 60 + 12));

    mirrored.click();
    assert.equal(nativeClicks, 1);
    assert.equal(fixture.mediaState.currentTime, 100, "native control ownership must avoid a competing direct seek");
});

test("VOD timecode seek retargets a replaced native chat log without refreshing comments", async (t) => {
    const fixture = createFixture({
        fetchComments: async () => apiContent({ rows: [apiComment(1, "이동 19:10", { buffCount: 1 })], totalCount: 1 }),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    clickCommentTab(document);
    await waitForCondition(() => document.querySelector("[data-bcvc-comment-key='id:1']"));
    const panel = document.getElementById("betterchzzk-vod-comment-panel");
    const row = document.querySelector("[data-bcvc-comment-key='id:1']");
    const oldLog = document.querySelector("#vod-aside [role='log']");
    panel.scrollTop = 73;

    Object.defineProperty(fixture.video, "currentTime", {
        configurable: true,
        get: () => fixture.mediaState.currentTime,
        set: (value) => {
            fixture.mediaState.currentTime = Number(value);
            const nextLog = document.createElement("div");
            nextLog.className = "native-chat-log";
            nextLog.setAttribute("role", "log");
            nextLog.textContent = "탐색 후 다시 마운트된 채팅";
            document.querySelector("#vod-aside [role='log']").replaceWith(nextLog);
        },
    });

    document.querySelector(".bcvc-timecode").click();
    await waitForCondition(() => {
        const nextLog = document.querySelector("#vod-aside [role='log']");
        return nextLog !== oldLog && nextLog.getAttribute("data-bcvc-native-log") === "1";
    });

    assert.equal(document.getElementById("betterchzzk-vod-comment-panel"), panel);
    assert.equal(document.querySelector("[data-bcvc-comment-key='id:1']"), row);
    assert.equal(panel.scrollTop, 73);
    assert.equal(document.querySelector("#vod-aside [role='log']").getAttribute("data-bcvc-tab-hidden"), "1");
    assert.equal(fixture.requests.length, 1);
});

test("VOD comment initial errors expose retry and distinguish empty or disabled comments", async (t) => {
    let call = 0;
    const fixture = createFixture({
        fetchComments: async () => {
            call += 1;
            if (call === 1) throw new Error("temporary");
            if (call === 2) return apiContent({ rows: [], totalCount: 0 });
            return apiContent({ active: false, rows: [], totalCount: 0 });
        },
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    clickCommentTab(document);
    await waitForCondition(() => document.querySelector("[data-bcvc-action='retry-initial']"));
    assert.match(document.getElementById("betterchzzk-vod-comment-panel").textContent, /불러오지 못했습니다/);

    document.querySelector("[data-bcvc-action='retry-initial']").click();
    await waitForCondition(() =>
        /아직 등록된 댓글/.test(document.getElementById("betterchzzk-vod-comment-panel").textContent)
    );
    document.querySelector("[data-bcvc-action='refresh']").click();
    await waitForCondition(() =>
        /댓글을 사용할 수 없습니다/.test(document.getElementById("betterchzzk-vod-comment-panel").textContent)
    );
    assert.equal(call, 3);
});

test("VOD comment timeout aborts and malformed responses stay retryable instead of looking empty", async (t) => {
    let call = 0;
    const fixture = createFixture({
        fetchComments: async () => {
            call += 1;
            if (call === 1) {
                const error = new Error("request timed out");
                error.name = "AbortError";
                throw error;
            }
            if (call === 2) return null;
            return apiContent({ rows: [apiComment(1, "복구된 댓글")], totalCount: 1 });
        },
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    clickCommentTab(document);
    await waitForCondition(() => document.querySelector("[data-bcvc-action='retry-initial']"));
    assert.match(document.getElementById("betterchzzk-vod-comment-panel").textContent, /불러오지 못했습니다/);

    let retry = document.querySelector("[data-bcvc-action='retry-initial']");
    retry.focus();
    retry.click();
    await waitForCondition(() => call === 2 && document.querySelector("[data-bcvc-action='retry-initial']"));
    retry = document.querySelector("[data-bcvc-action='retry-initial']");
    assert.equal(document.activeElement, retry);
    assert.doesNotMatch(document.getElementById("betterchzzk-vod-comment-panel").textContent, /등록된 댓글이 없습니다/);

    retry.click();
    await waitForCondition(() =>
        /복구된 댓글/.test(document.getElementById("betterchzzk-vod-comment-panel").textContent)
    );
    assert.equal(document.activeElement, document.querySelector("[data-bcvc-action='refresh']"));
    assert.equal(call, 3);
});

test("VOD comment pagination coalesces observer requests and appends without replacing existing rows", async (t) => {
    const secondPage = deferred();
    const firstRows = Array.from({ length: 10 }, (_, index) => apiComment(index + 1, `댓글 ${index + 1}`));
    const fixture = createFixture({
        withIntersectionObserver: true,
        fetchComments: ({ offset }) =>
            offset === 0 ? apiContent({ next: 10, rows: firstRows, totalCount: 11 }) : secondPage.promise,
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    clickCommentTab(document);
    await waitForCondition(() => document.querySelectorAll("[data-bcvc-comment-key]").length === 10);
    const firstRow = document.querySelector("[data-bcvc-comment-key='id:1']");
    const panel = document.getElementById("betterchzzk-vod-comment-panel");
    const focusTarget = document.querySelector("[data-bcvc-action='refresh']");
    panel.scrollTop = 80;
    focusTarget.focus();
    await delay(30);
    const originalPanelQuerySelectorAll = panel.querySelectorAll;
    let mirroredRowScans = 0;
    panel.querySelectorAll = function (selector) {
        if (selector === "[data-bcvc-comment-id]") mirroredRowScans += 1;
        return originalPanelQuerySelectorAll.call(this, selector);
    };

    const activeObserver = fixture.intersectionObservers.find((observer) => observer.targets.length);
    assert.ok(activeObserver);
    activeObserver.trigger();
    activeObserver.trigger();
    document.querySelector("[data-bcvc-action='load-more']")?.click();
    assert.equal(fixture.requests.filter((request) => request.offset === 10).length, 1);
    assert.equal(mirroredRowScans, 0, "a loading-only footer update must not rescan mirrored native assets");

    secondPage.resolve(
        apiContent({
            next: null,
            rows: [apiComment(10, "중복"), apiComment(11, "추가 댓글 1:41:55")],
            totalCount: 11,
        })
    );
    await waitForCondition(() => document.querySelectorAll("[data-bcvc-comment-key]").length === 11);
    assert.equal(document.querySelector("[data-bcvc-comment-key='id:1']"), firstRow);
    assert.equal(document.activeElement, focusTarget);
    assert.equal(panel.scrollTop, 80);
    assert.equal(document.querySelector("[data-bcvc-action='load-more']"), null);
    panel.querySelectorAll = originalPanelQuerySelectorAll;
    assert.equal(mirroredRowScans, 1, "appending a page must sync native assets once for the new rows");
});

test("VOD comment load-more restores focus to the first appended row when pagination ends", async (t) => {
    const firstRows = Array.from({ length: 10 }, (_, index) => apiComment(index + 1, `댓글 ${index + 1}`));
    const fixture = createFixture({
        fetchComments: ({ offset }) =>
            offset === 0
                ? apiContent({ next: 10, rows: firstRows, totalCount: 11 })
                : apiContent({ next: null, rows: [apiComment(11, "마지막 댓글")], totalCount: 11 }),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    clickCommentTab(document);
    await waitForCondition(() => document.querySelector("[data-bcvc-action='load-more']"));
    const more = document.querySelector("[data-bcvc-action='load-more']");
    more.focus();
    more.click();

    await waitForCondition(() => document.querySelector("[data-bcvc-comment-key='id:11']"));
    const appended = document.querySelector("[data-bcvc-comment-key='id:11']");
    assert.equal(document.activeElement, appended);
    assert.equal(appended.tabIndex, -1);
});

test("VOD comment load-more falls back to refresh focus when the last page contains only duplicates", async (t) => {
    const firstRows = Array.from({ length: 10 }, (_, index) => apiComment(index + 1, `댓글 ${index + 1}`));
    const fixture = createFixture({
        fetchComments: ({ offset }) =>
            offset === 0
                ? apiContent({ next: 10, rows: firstRows, totalCount: 10 })
                : apiContent({ next: null, rows: [apiComment(10, "중복 마지막 댓글")], totalCount: 10 }),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    clickCommentTab(document);
    await waitForCondition(() => document.querySelector("[data-bcvc-action='load-more']"));
    const more = document.querySelector("[data-bcvc-action='load-more']");
    more.focus();
    more.click();

    await waitForCondition(() => !document.querySelector("[data-bcvc-action='load-more']"));
    await waitForCondition(() => document.activeElement === document.querySelector("[data-bcvc-action='refresh']"));
    const refresh = document.querySelector("[data-bcvc-action='refresh']");
    assert.equal(document.activeElement, refresh);
});

test("VOD comment sorts cache loaded rows while refresh reloads only the active order", async (t) => {
    const fixture = createFixture({
        fetchComments: ({ orderType }, index) =>
            apiContent({ rows: [apiComment(index + 1, `${orderType} 댓글`)], totalCount: 1 }),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    clickCommentTab(document);
    await waitForCondition(() =>
        /POPULAR 댓글/.test(document.getElementById("betterchzzk-vod-comment-panel").textContent)
    );
    assert.deepEqual(
        Array.from(document.querySelectorAll("[data-bcvc-action='sort']")).map((button) => ({
            label: button.textContent,
            order: button.getAttribute("data-bcvc-order"),
            pressed: button.getAttribute("aria-pressed"),
        })),
        [
            { label: "인기순", order: "POPULAR", pressed: "true" },
            { label: "최신순", order: "DESC", pressed: "false" },
            { label: "등록순", order: "ASC", pressed: "false" },
        ]
    );
    const desc = document.querySelector("[data-bcvc-action='sort'][data-bcvc-order='DESC']");
    desc.focus();
    desc.click();
    await waitForCondition(() =>
        /DESC 댓글/.test(document.getElementById("betterchzzk-vod-comment-panel").textContent)
    );
    assert.equal(document.activeElement, document.querySelector("[data-bcvc-action='sort'][data-bcvc-order='DESC']"));
    const popular = document.querySelector("[data-bcvc-action='sort'][data-bcvc-order='POPULAR']");
    popular.focus();
    popular.click();
    assert.match(document.getElementById("betterchzzk-vod-comment-panel").textContent, /POPULAR 댓글/);
    assert.equal(
        document.activeElement,
        document.querySelector("[data-bcvc-action='sort'][data-bcvc-order='POPULAR']")
    );
    assert.equal(fixture.requests.length, 2, "returning to a loaded sort must use memory state");

    const refresh = document.querySelector("[data-bcvc-action='refresh']");
    refresh.focus();
    refresh.click();
    await waitForCondition(() => fixture.requests.length === 3);
    await waitForCondition(() => document.activeElement === document.querySelector("[data-bcvc-action='refresh']"));
    assert.equal(fixture.requests[2].orderType, "POPULAR");
    assert.equal(fixture.requests[2].offset, 0);
});

test("VOD comment tabs abort stale VOD work and clean up on route exit or disable", async (t) => {
    const firstRequest = deferred();
    const fixture = createFixture({
        fetchComments: ({ objectId }) =>
            objectId === "12345"
                ? firstRequest.promise
                : apiContent({ rows: [apiComment(9, "새 VOD 댓글")], totalCount: 1 }),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    clickCommentTab(document);
    const oldSignal = fixture.requests[0].signal;
    fixture.emitRoute("/video/67890");
    assert.equal(oldSignal.aborted, true);
    await waitForCondition(() => document.getElementById("betterchzzk-vod-comment-chat-tab"));
    assert.equal(document.getElementById("betterchzzk-vod-comment-chat-tab").getAttribute("aria-selected"), "true");
    assert.equal(document.querySelector("[role='log']").getAttribute("data-bcvc-tab-hidden"), null);

    clickCommentTab(document);
    await waitForCondition(() =>
        /새 VOD 댓글/.test(document.getElementById("betterchzzk-vod-comment-panel").textContent)
    );
    firstRequest.resolve(apiContent({ rows: [apiComment(1, "늦은 이전 댓글")] }));
    await delay();
    assert.doesNotMatch(document.getElementById("betterchzzk-vod-comment-panel").textContent, /늦은 이전 댓글/);

    fixture.emitRoute("/lives");
    assert.equal(document.getElementById("betterchzzk-vod-comment-tabs"), null);
    assert.equal(document.getElementById("vod-aside").hasAttribute("data-bcvc-mounted"), false);
    fixture.emitRoute("/video/99999");
    await waitForCondition(() => document.getElementById("betterchzzk-vod-comment-tabs"));
    fixture.emitOptions({ vodCommentTabsEnabled: false });
    assert.equal(document.getElementById("betterchzzk-vod-comment-tabs"), null);
    assert.equal(document.getElementById("betterchzzk-vod-comment-panel"), null);
    assert.equal(document.querySelector("[role='log']").getAttribute("aria-hidden"), null);
});

test("VOD comment tab keyboard navigation keeps roving tabindex", (t) => {
    const fixture = createFixture();
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document, window } = fixture;
    const chat = document.getElementById("betterchzzk-vod-comment-chat-tab");
    const comments = document.getElementById("betterchzzk-vod-comment-comment-tab");

    chat.focus();
    chat.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    assert.equal(document.activeElement, comments);
    assert.equal(comments.tabIndex, 0);
    comments.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Home" }));
    assert.equal(document.activeElement, chat);
    assert.equal(chat.tabIndex, 0);
    chat.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }));
    assert.equal(document.activeElement, comments, "ArrowLeft from the first tab must wrap to the last tab");
    comments.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    assert.equal(document.activeElement, chat, "ArrowRight from the last tab must wrap to the first tab");
    chat.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "End" }));
    assert.equal(document.activeElement, comments);
});
