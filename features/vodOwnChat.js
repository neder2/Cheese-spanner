/**
 * features/vodOwnChat.js — 다시보기 채팅에서 지금 로그인한 계정이 쓴 채팅을 강조한다.
 *
 * 실행 컨텍스트: isolated world. React 값은 직접 읽지 않고 MAIN 브리지(features/chatTimestampPage.js)가
 *   요청받은 메시지의 chatMessage.user를 data-bcoc-source-user로 넘긴다.
 * 동작 위치: /video/* 의 aside#vod-aside [role='log'].
 * 하는 일: getUserStatus로 로그인 계정의 userIdHash를 받아 메모리에만 두고, 메시지의 작성 계정 해시와 같으면
 *   data-bcoc-own을 붙여 강조한다. 다시보기 채팅은 작성 당시 닉네임을 보여 주므로(2026-10-21 실측) 닉네임은
 *   비교하지 않는다. 로그인하지 않았거나 확인에 실패하면 아무것도 표시하지 않고, 아무것도 저장하지 않는다.
 * 수명주기: 옵션 OFF·다시보기 밖으로 이동하면 observer·요청·표식을 정리하고, 계정 변경 신호에 다시 확인한다.
 * 옵션 키: vodOwnChatHighlightEnabled(기본 true).
 * DOM 마커: #betterchzzk-vod-own-chat-style, data-bcoc-own, data-bcoc-source-user.
 */
(() => {
    "use strict";

    const root = (window.BetterChzzk = window.BetterChzzk || {});
    if (root.vodOwnChat) return;

    const { bindFeatureOptions, createMutationObserverSync, fetchJson, injectStyleOnce, isVodRoute } = root.utils;
    const USER_URL = "https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus";
    const USER_REQUEST_EVENT = "betterchzzk:chat-user-source-request";
    const PAGE_READY_EVENT = "betterchzzk:chat-timestamp-page-ready";
    const SOURCE_USER_ATTR = "data-bcoc-source-user";
    const OWN_ATTR = "data-bcoc-own";
    const STYLE_ID = "betterchzzk-vod-own-chat-style";
    const VOD_CHAT_LOG_SELECTOR = "aside#vod-aside [role='log']";
    const MESSAGE_CONTAINER_SELECTOR = "[class*='chatting_message'], [class*='chat-message']";
    const USER_HASH_RE = /^[A-Za-z0-9_-]{1,128}$/;
    // 채팅 행은 가상 목록에서 재사용돼요. 같은 노드에 다른 메시지가 들어오는 신호를 받아 다시 비교해요.
    const OBSERVED_ATTRIBUTES = [
        "data-chat-id",
        "data-message-id",
        "data-id",
        "data-key",
        "data-index",
        "data-virtual-key",
        "data-virtual-index",
        "data-row-key",
        "data-row-index",
        "data-item-key",
        "data-item-index",
        "aria-posinset",
    ];

    let enabled = false;
    let userId = "";
    let generation = 0;
    let controller = null;
    let observer = null;
    let removePageChangeDetection = null;

    function getChatLog() {
        return isVodRoute() ? document.querySelector(VOD_CHAT_LOG_SELECTOR) : null;
    }

    function syncContainer(container) {
        if (!userId) {
            container.removeAttribute(OWN_ATTR);
            return;
        }
        container.dispatchEvent(new Event(USER_REQUEST_EVENT, { bubbles: true }));
        const own = container.getAttribute(SOURCE_USER_ATTR) === userId;
        if (own && !container.hasAttribute(OWN_ATTR)) container.setAttribute(OWN_ATTR, "");
        else if (!own && container.hasAttribute(OWN_ATTR)) container.removeAttribute(OWN_ATTR);
    }

    function collect(node, chatLog, containers) {
        const element = node instanceof Element ? node : node?.parentElement;
        if (!(element instanceof Element) || !chatLog.contains(element)) return;
        const closest = element.closest(MESSAGE_CONTAINER_SELECTOR);
        if (closest && chatLog.contains(closest)) containers.add(closest);
        for (const container of element.querySelectorAll(MESSAGE_CONTAINER_SELECTOR)) containers.add(container);
    }

    function syncAll(chatLog = getChatLog()) {
        if (!(chatLog instanceof Element)) return;
        for (const container of chatLog.querySelectorAll(MESSAGE_CONTAINER_SELECTOR)) syncContainer(container);
    }

    function handleMutations(mutations) {
        const chatLog = getChatLog();
        if (!(chatLog instanceof Element)) return;
        const containers = new Set();
        for (const mutation of mutations) {
            collect(mutation.target, chatLog, containers);
            if (mutation.type === "childList") {
                for (const node of mutation.addedNodes) collect(node, chatLog, containers);
            }
        }
        for (const container of containers) syncContainer(container);
    }

    function clearMarkers() {
        for (const container of document.querySelectorAll(`[${OWN_ATTR}], [${SOURCE_USER_ATTR}]`)) {
            container.removeAttribute(OWN_ATTR);
            container.removeAttribute(SOURCE_USER_ATTR);
        }
    }

    // 로그인 계정만 비교 기준이에요. 실패·비로그인·늦은 응답은 강조를 모두 지운 상태로 둬요.
    async function identifyUser() {
        controller?.abort();
        controller = new AbortController();
        const currentGeneration = ++generation;
        userId = "";
        syncAll();
        if (!enabled || !isVodRoute()) return;
        try {
            const json = await fetchJson(USER_URL, {
                credentials: "include",
                signal: controller.signal,
                timeoutMs: 8000,
            });
            if (!enabled || currentGeneration !== generation) return;
            const user = json?.content;
            if (json?.code !== 200 || user?.loggedIn !== true || !USER_HASH_RE.test(user.userIdHash || "")) return;
            userId = user.userIdHash;
            syncAll();
        } catch (_) {
            // Logged-out or network failure leaves the replay unmarked.
        }
    }

    function handleIdentityChange(event) {
        if (event.type === "storage" && event.key !== "userStatus.idhash") return;
        if (event.type === "visibilitychange" && document.hidden) return;
        void identifyUser();
    }

    function stopRoute() {
        generation += 1;
        controller?.abort();
        controller = null;
        userId = "";
        observer?.disconnectAll?.();
        observer = null;
        clearMarkers();
    }

    function startRoute() {
        stopRoute();
        if (!enabled || !isVodRoute()) return;
        observer = createMutationObserverSync({
            target: getChatLog,
            options: {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true,
                attributeFilter: OBSERVED_ATTRIBUTES,
            },
            onMutations: handleMutations,
            onObserved: (_observer, chatLog) => syncAll(chatLog),
        });
        void identifyUser();
    }

    function install() {
        if (removePageChangeDetection) return;
        // Colors come from shared/uiTheme.js (--bct-*), which follows CHZZK's light and dark themes.
        root.utils.ensureUiTheme?.();
        injectStyleOnce(
            STYLE_ID,
            `
[${OWN_ATTR}]{border-radius:var(--bct-radius-sm);background-color:var(--bct-brand-weak);box-shadow:inset 3px 0 0 var(--bct-brand-text)}
`
        );
        removePageChangeDetection = root.utils.startPageChangeDetection(startRoute);
        window.addEventListener("storage", handleIdentityChange);
        document.addEventListener("visibilitychange", handleIdentityChange);
        window.addEventListener(PAGE_READY_EVENT, startRoute);
        startRoute();
    }

    function teardown() {
        stopRoute();
        removePageChangeDetection?.();
        removePageChangeDetection = null;
        window.removeEventListener("storage", handleIdentityChange);
        document.removeEventListener("visibilitychange", handleIdentityChange);
        window.removeEventListener(PAGE_READY_EVENT, startRoute);
        document.getElementById(STYLE_ID)?.remove();
    }

    root.vodOwnChat = { teardown };
    bindFeatureOptions((options) => {
        const next = options.vodOwnChatHighlightEnabled === true;
        if (next === enabled) return;
        enabled = next;
        if (enabled) install();
        else teardown();
    });
})();
