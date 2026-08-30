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
    includeAside = true,
    includeLog = true,
    initialOptions = {},
    nativeCommentsHtml = null,
    trackLifecycle = false,
    withIdleCallback = true,
    withIntersectionObserver = false,
} = {}) {
    const pageHtml = includeAside
        ? [
              '<section id="player-layout"><video id="video"></video>',
              chatAsideHtml({ includeLog }),
              "</section>",
              `<main id="below-player">${nativeCommentsHtml ?? "하단 댓글 DOM 없음"}</main>`,
          ]
        : [
              '<section id="player-layout"><div class="native-vod-wrapper">',
              '<div class="native-player-row"><div id="player_layout"><video id="video"></video></div></div>',
              '<div class="native-content-row">',
              `<main class="native-content-left" id="below-player">${
                  nativeCommentsHtml ?? "하단 댓글 DOM 없음"
              }</main>`,
              '<div class="native-vod-column" style="margin-top:-378px">',
              '<div class="native-vod-list"><div class="native-vod-header"><h2 style="font-family:Verdana,sans-serif;font-size:18px;font-weight:650;line-height:24px;letter-spacing:-0.4px">영상 더보기</h2></div>',
              "<ul><li>다음 VOD</li></ul></div></div></div>",
              "</div></section>",
          ];
    const dom = new JSDOM(["<!doctype html><html><head></head><body>", ...pageHtml, "</body></html>"].join(""), {
        url: "https://chzzk.naver.com/video/12345",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
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
    if (aside && container && header) {
        aside.getBoundingClientRect = () => ({
            bottom: 540,
            height: 540,
            left: 0,
            right: 353,
            top: 0,
            width: 353,
        });
        container.getBoundingClientRect = () => ({
            bottom: 1803,
            height: 1803,
            left: 0,
            right: 353,
            top: 0,
            width: 353,
        });
        header.getBoundingClientRect = () => ({
            bottom: 44,
            height: 44,
            left: 0,
            right: 353,
            top: 0,
            width: 353,
        });
    }

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

test("VOD comments mount a comment-only side panel when replay chat is unavailable", async (t) => {
    const fixture = createFixture({
        fetchComments: async () => apiContent({ rows: [apiComment(1, "채팅 없이 보는 댓글")], totalCount: 1 }),
        includeAside: false,
        nativeCommentsHtml: '<div id="commentArea"></div>',
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    await waitForCondition(() => /채팅 없이 보는 댓글/.test(document.body.textContent));
    const ownedAside = document.getElementById("betterchzzk-vod-comment-aside");
    const commentTab = document.getElementById("betterchzzk-vod-comment-comment-tab");
    const tablist = document.getElementById("betterchzzk-vod-comment-tabs");
    const panel = document.getElementById("betterchzzk-vod-comment-panel");
    let vodColumn = document.querySelector(".native-vod-column");
    const vodColumnParent = vodColumn.parentElement;
    assert.ok(ownedAside);
    assert.equal(ownedAside.parentElement, document.querySelector(".native-player-row"));
    assert.equal(document.getElementById("betterchzzk-vod-comment-chat-tab"), null);
    assert.equal(commentTab.getAttribute("aria-selected"), "true");
    assert.equal(panel.hidden, false);
    assert.equal(tablist.style.getPropertyValue("--bcvc-heading-font-family"), "Verdana, sans-serif");
    assert.equal(tablist.style.getPropertyValue("--bcvc-heading-font-size"), "18px");
    assert.equal(tablist.style.getPropertyValue("--bcvc-heading-font-weight"), "650");
    assert.equal(tablist.style.getPropertyValue("--bcvc-heading-line-height"), "24px");
    assert.equal(tablist.style.getPropertyValue("--bcvc-heading-letter-spacing"), "-0.4px");
    const css = document.getElementById("betterchzzk-vod-comment-tabs-style").textContent;
    assert.match(
        css,
        /#betterchzzk-vod-comment-aside #betterchzzk-vod-comment-comment-tab\{[^}]*justify-content:center[^}]*text-align:center[^}]*cursor:default/s
    );
    assert.doesNotMatch(
        css,
        /#betterchzzk-vod-comment-aside #betterchzzk-vod-comment-comment-tab::after\{\s*display:none;\s*\}/
    );
    assert.match(css, /html\[dark\] #betterchzzk-vod-comment-aside/);
    assert.match(css, /body\[theme="dark"\] #betterchzzk-vod-comment-aside/);
    assert.equal(vodColumn.getAttribute("data-bcvc-comment-only-vod-column"), "1");
    assert.equal(fixture.window.getComputedStyle(vodColumn).marginTop, "0px");
    assert.equal(vodColumn.parentElement, vodColumnParent, "the native VOD column must stay in its React-owned tree");
    assert.equal(fixture.requests.length, 1);

    const oldVodColumn = vodColumn;
    vodColumn = document.createElement("div");
    vodColumn.className = "native-vod-column";
    vodColumn.style.marginTop = "-378px";
    vodColumn.innerHTML =
        '<div><h2 style="font-family:Tahoma,sans-serif;font-size:16px;font-weight:600;line-height:22px;letter-spacing:-0.2px">영상 더보기</h2><ul><li>교체된 다음 VOD</li></ul></div>';
    oldVodColumn.replaceWith(vodColumn);
    await waitForCondition(() => vodColumn.getAttribute("data-bcvc-comment-only-vod-column") === "1");
    await waitForCondition(() => tablist.style.getPropertyValue("--bcvc-heading-font-family") === "Tahoma, sans-serif");
    assert.equal(oldVodColumn.getAttribute("data-bcvc-comment-only-vod-column"), null);
    assert.equal(fixture.window.getComputedStyle(vodColumn).marginTop, "0px");
    assert.equal(vodColumn.parentElement, vodColumnParent);
    assert.equal(tablist.style.getPropertyValue("--bcvc-heading-font-size"), "16px");

    document.querySelector(".native-player-row").insertAdjacentHTML("beforeend", chatAsideHtml());
    await waitForCondition(
        () =>
            !document.getElementById("betterchzzk-vod-comment-aside") &&
            document.getElementById("betterchzzk-vod-comment-chat-tab")
    );

    assert.equal(document.querySelector(".native-player-row").hasAttribute("data-bcvc-comment-only-host"), false);
    assert.equal(vodColumn.getAttribute("data-bcvc-comment-only-vod-column"), null);
    assert.equal(vodColumn.style.marginTop, "-378px");
    assert.equal(vodColumn.parentElement, vodColumnParent);
    assert.equal(document.getElementById("betterchzzk-vod-comment-comment-tab").getAttribute("aria-selected"), "true");
    assert.match(document.getElementById("betterchzzk-vod-comment-panel").textContent, /채팅 없이 보는 댓글/);
    assert.equal(document.querySelector("[role='log']").getAttribute("data-bcvc-tab-hidden"), "1");
    assert.equal(fixture.requests.length, 1, "native chat appearing later must reuse the loaded comment state");
});

test("VOD comments do not replace temporarily hidden native chat with the comment-only panel", async (t) => {
    const fixture = createFixture({
        fetchComments: async () => apiContent({ rows: [apiComment(1, "숨김 전 댓글")], totalCount: 1 }),
    });
    t.after(() => {
        fixture.emitOptions({ vodCommentTabsEnabled: false });
        fixture.dom.window.close();
    });
    const { document } = fixture;

    await waitForCondition(() => document.getElementById("betterchzzk-vod-comment-tabs"));
    const section = document.getElementById("player-layout");
    const playerRow = document.createElement("div");
    playerRow.className = "native-player-row";
    const player = document.createElement("div");
    player.id = "player_layout";
    playerRow.appendChild(player);
    section.insertBefore(playerRow, section.firstChild);
    document.getElementById("vod-aside").remove();

    await delay(750);
    assert.equal(
        document.getElementById("betterchzzk-vod-comment-aside"),
        null,
        "a collapsed native chat must not be mistaken for a chatless VOD"
    );

    section.insertAdjacentHTML("beforeend", chatAsideHtml());
    await waitForCondition(() => document.getElementById("betterchzzk-vod-comment-chat-tab"));

    assert.equal(document.getElementById("betterchzzk-vod-comment-aside"), null);
    assert.equal(fixture.requests.length, 0, "restoring native chat must not fetch comments before the tab is opened");
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
