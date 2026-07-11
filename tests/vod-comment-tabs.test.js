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
            if (record) record.cancelled = true;
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

    evalRepoScript(dom, "features", "vodCommentTabs.js");

    return {
        document,
        dom,
        intersectionObservers,
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
    assert.equal(container.style.getPropertyValue("--bcvc-panel-height"), "496px");
    const css = document.getElementById("betterchzzk-vod-comment-tabs-style").textContent;
    assert.match(css, /--Content-Neutral-Cool-Strong/);
    assert.match(css, /--Surface-Brand-Alpha-Weaker/);
    assert.match(css, /prefers-color-scheme:light/);
    assert.match(css, /#betterchzzk-vod-comment-chat-tab,\s*#betterchzzk-vod-comment-comment-tab\{[^}]*flex:1 1 50%/s);
    assert.match(css, /height:var\(--bcvc-panel-height/);
    assert.doesNotMatch(css, /#betterchzzk-vod-comment-panel\{[^}]*bottom:0/s);
    assert.doesNotMatch(css, /font:\s*\d/);

    assert.equal(fixture.runIdleCallbacks(), 1);
    await waitForCondition(() => fixture.requests.length === 1);
    assert.equal(document.getElementById("betterchzzk-vod-comment-chat-tab").getAttribute("aria-selected"), "true");
    assert.equal(document.getElementById("betterchzzk-vod-comment-panel").hidden, true);
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
        { limit: 10, objectId: "12345", offset: 0, orderType: "ASC" }
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
    assert.equal(document.querySelectorAll(".bcvc-buff").length, 2);
    assert.equal(
        document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-buff").getAttribute("aria-label"),
        "버프 2"
    );
    assert.equal(document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-buff-count").textContent, "2");
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
            `<button type="button"><img width="36" height="36" src="${nativeProfileUrl}" alt=""></button>`,
            '<button type="button" aria-pressed="false"><i class="_buff_icon_fixture_5"><span class="blind">버프</span></i></button>',
            "</div>",
            "</div>",
        ].join(""),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document, window } = fixture;

    clickCommentTab(document);
    await waitForCondition(() => document.querySelector("[data-bcvc-comment-key='id:1']"));

    const nativeAvatar = document.querySelector("#commentBox-1 img");
    const reusedAvatar = document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-avatar-image");
    assert.equal(reusedAvatar.src, nativeProfileUrl);
    assert.notEqual(reusedAvatar, nativeAvatar);
    assert.equal(nativeAvatar.parentElement.closest("#commentBox-1")?.id, "commentBox-1");

    const nativeBuffIcon = document.querySelector("#commentBox-1 i");
    const reusedBuffIcon = document.querySelector("[data-bcvc-comment-key='id:1'] .bcvc-buff-native-icon");
    assert.ok(reusedBuffIcon);
    assert.notEqual(reusedBuffIcon, nativeBuffIcon);
    assert.ok(reusedBuffIcon.classList.contains("_buff_icon_fixture_5"));
    assert.equal(reusedBuffIcon.children.length, 0);
    assert.equal(reusedBuffIcon.closest("button"), null);
    assert.equal(nativeBuffIcon.closest("button").getAttribute("aria-pressed"), "false");
    assert.equal(
        window.getComputedStyle(reusedBuffIcon).backgroundImage,
        window.getComputedStyle(nativeBuffIcon).backgroundImage
    );
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
    assert.equal(fixture.requests.length, 1, "asset synchronization must not reload comments");
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

    const activeObserver = fixture.intersectionObservers.find((observer) => observer.targets.length);
    assert.ok(activeObserver);
    activeObserver.trigger();
    activeObserver.trigger();
    document.querySelector("[data-bcvc-action='load-more']")?.click();
    assert.equal(fixture.requests.filter((request) => request.offset === 10).length, 1);

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
    await waitForCondition(() => /ASC 댓글/.test(document.getElementById("betterchzzk-vod-comment-panel").textContent));
    document.querySelector("[data-bcvc-order='DESC']").click();
    await waitForCondition(() =>
        /DESC 댓글/.test(document.getElementById("betterchzzk-vod-comment-panel").textContent)
    );
    document.querySelector("[data-bcvc-order='ASC']").click();
    assert.match(document.getElementById("betterchzzk-vod-comment-panel").textContent, /ASC 댓글/);
    assert.equal(fixture.requests.length, 2, "returning to a loaded sort must use memory state");

    document.querySelector("[data-bcvc-action='refresh']").click();
    await waitForCondition(() => fixture.requests.length === 3);
    assert.equal(fixture.requests[2].orderType, "ASC");
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
});
