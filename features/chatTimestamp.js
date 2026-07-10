/**
 * features/chatTimestamp.js — 라이브 채팅 닉네임 왼쪽에 서버 작성 시각을 붙인다.
 *
 * 실행 컨텍스트: isolated world. 옵션·DOM 관찰·표시를 담당하며 React 내부 값은 직접 읽지 않는다.
 * 동작 위치: chzzk.naver.com/live/* 의 aside#aside-chatting 내부.
 * 하는 일:
 *   - 현재 표시된 채팅과 새로 추가·재사용된 채팅마다 MAIN-world 브리지에 원본 시각을 요청한다.
 *   - 검증된 millisecond epoch를 브라우저 현지 HH:MM으로 바꿔 data-bcmt-time + ::before로 표시한다.
 *   - 원본 서버 시각이 없거나 잘못된 행에는 현재 시각을 대신 붙이지 않는다.
 * 의존: BetterChzzkSettings.normalizeOptions, BetterChzzk.utils(bindFeatureOptions, createMutationObserverSync,
 *   injectStyleOnce, isLiveRoute, startPageChangeDetection).
 * 옵션 키: chatTimestampEnabled(기본값 false).
 * 통신: betterchzzk:chat-timestamp-source-request/page-ready 이벤트와 data-bcmt-source-time DOM 속성.
 * DOM 마커: data-bcmt-time(표시용 HH:MM), data-bcmt-source-time(검증된 원본 millisecond epoch).
 */
(() => {
    "use strict";

    const root = (window.BetterChzzk = window.BetterChzzk || {});
    if (root.chatTimestamp) return;

    const { normalizeOptions } = BetterChzzkSettings;
    const { bindFeatureOptions, createMutationObserverSync, injectStyleOnce, isLiveRoute, startPageChangeDetection } =
        root.utils;
    const SOURCE_REQUEST_EVENT = "betterchzzk:chat-timestamp-source-request";
    const PAGE_READY_EVENT = "betterchzzk:chat-timestamp-page-ready";
    const SOURCE_TIME_ATTR = "data-bcmt-source-time";
    const TIMESTAMP_ATTR = "data-bcmt-time";
    const STYLE_ID = "betterchzzk-chat-timestamp-style";
    const CHAT_LOG_SELECTOR = "aside#aside-chatting [role='log']";
    const NICKNAME_BUTTON_SELECTOR = "button[aria-haspopup='true']";
    const MESSAGE_CONTAINER_SELECTOR = "[class*='chatting_message'], [class*='chat-message']";
    const EARLIEST_MESSAGE_TIME_MS = Date.UTC(2020, 0, 1);
    const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
    const OBSERVED_ATTRIBUTES = [
        "data-chat-id",
        "data-message-id",
        "data-id",
        "data-key",
        "data-index",
        "data-position",
        "data-virtual-key",
        "data-virtual-index",
        "data-virtual-position",
        "data-row-key",
        "data-row-index",
        "data-row-position",
        "data-item-key",
        "data-item-index",
        "data-item-position",
        "data-list-key",
        "data-list-index",
        "data-list-position",
        "aria-posinset",
    ];
    const STYLE_TEXT = `
[${TIMESTAMP_ATTR}]::before {
    content: attr(${TIMESTAMP_ATTR});
    display: inline-block;
    margin-right: 4px;
    color: var(--Content-Neutral-Cool-Base, #9da5b6);
    font-size: inherit;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    line-height: inherit;
    white-space: nowrap;
    vertical-align: baseline;
    user-select: none;
}
`;

    let featureOptions = normalizeOptions();
    let observer = null;
    let installPending = false;
    let removePageChangeDetection = null;

    function normalizeSourceTime(rawValue) {
        if (!/^\d{13}$/.test(rawValue || "")) return null;
        const value = Number(rawValue);
        if (!Number.isSafeInteger(value)) return null;
        if (value < EARLIEST_MESSAGE_TIME_MS || value > Date.now() + MAX_FUTURE_SKEW_MS) return null;
        return value;
    }

    function formatMessageTime(messageTime) {
        const date = new Date(messageTime);
        if (!Number.isFinite(date.getTime())) return "";
        const hours = String(date.getHours()).padStart(2, "0");
        const minutes = String(date.getMinutes()).padStart(2, "0");
        return `${hours}:${minutes}`;
    }

    function isEnabled() {
        return featureOptions.chatTimestampEnabled === true;
    }

    function getChatLog() {
        if (typeof isLiveRoute === "function" && !isLiveRoute()) return null;
        return document.querySelector(CHAT_LOG_SELECTOR);
    }

    function isNicknameButton(button, messageContainer = button?.parentElement) {
        if (!(button instanceof HTMLButtonElement) || button.getAttribute("aria-haspopup") !== "true") return false;
        if (!(messageContainer instanceof Element) || !messageContainer.matches(MESSAGE_CONTAINER_SELECTOR)) {
            return false;
        }

        const ownClass = typeof button.className === "string" ? button.className : "";
        if (/nickname/i.test(ownClass)) return true;
        return Boolean(button.querySelector("[class*='nickname']"));
    }

    function getNicknameButton(messageContainer) {
        if (!(messageContainer instanceof Element)) return null;
        return Array.from(messageContainer.querySelectorAll(NICKNAME_BUTTON_SELECTOR)).find((button) =>
            isNicknameButton(button, messageContainer)
        );
    }

    function collectMessageContainers(node, chatLog, containers) {
        const element = node instanceof Element ? node : node?.parentElement;
        if (!(element instanceof Element) || !chatLog.contains(element)) return;

        collectClosestMessageContainer(element, chatLog, containers);

        for (const button of element.querySelectorAll(NICKNAME_BUTTON_SELECTOR)) {
            const messageContainer = button.parentElement;
            if (isNicknameButton(button, messageContainer) && chatLog.contains(messageContainer)) {
                containers.add(messageContainer);
            }
        }
    }

    function collectClosestMessageContainer(node, chatLog, containers) {
        const element = node instanceof Element ? node : node?.parentElement;
        if (!(element instanceof Element) || !chatLog.contains(element)) return;

        const closestContainer = element.closest(MESSAGE_CONTAINER_SELECTOR);
        if (closestContainer && chatLog.contains(closestContainer) && getNicknameButton(closestContainer)) {
            containers.add(closestContainer);
        }
    }

    function syncMessageContainer(messageContainer, chatLog) {
        if (!(messageContainer instanceof Element) || !chatLog.contains(messageContainer)) return;
        if (!getNicknameButton(messageContainer)) return;

        messageContainer.dispatchEvent(new Event(SOURCE_REQUEST_EVENT, { bubbles: true }));
        const messageTime = normalizeSourceTime(messageContainer.getAttribute(SOURCE_TIME_ATTR));
        const formattedTime = messageTime === null ? "" : formatMessageTime(messageTime);

        if (formattedTime && messageContainer.getAttribute(TIMESTAMP_ATTR) !== formattedTime) {
            messageContainer.setAttribute(TIMESTAMP_ATTR, formattedTime);
        } else if (!formattedTime && messageContainer.hasAttribute(TIMESTAMP_ATTR)) {
            messageContainer.removeAttribute(TIMESTAMP_ATTR);
        }
    }

    function syncChatLog(chatLog) {
        if (!(chatLog instanceof Element)) return;
        const containers = new Set();
        collectMessageContainers(chatLog, chatLog, containers);
        for (const messageContainer of containers) syncMessageContainer(messageContainer, chatLog);
    }

    function handleChatMutations(mutations) {
        const chatLog = getChatLog();
        if (!(chatLog instanceof Element)) return;

        const containers = new Set();
        for (const mutation of mutations) {
            if (mutation.type === "attributes") {
                collectMessageContainers(mutation.target, chatLog, containers);
                continue;
            }

            collectClosestMessageContainer(mutation.target, chatLog, containers);
            if (mutation.type === "childList") {
                for (const addedNode of mutation.addedNodes) {
                    collectMessageContainers(addedNode, chatLog, containers);
                }
            }
        }

        for (const messageContainer of containers) syncMessageContainer(messageContainer, chatLog);
    }

    function startObserver() {
        observer = createMutationObserverSync({
            target: getChatLog,
            options: {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
                attributeFilter: OBSERVED_ATTRIBUTES,
            },
            onMutations: handleChatMutations,
            onObserved: (_observer, chatLog) => syncChatLog(chatLog),
            onBodyReady: (_observer, chatLog) => syncChatLog(chatLog),
        });
    }

    function stopObserver() {
        observer?.disconnectAll?.();
        observer = null;
    }

    function clearTimestampMarkers() {
        for (const messageContainer of document.querySelectorAll(`[${TIMESTAMP_ATTR}], [${SOURCE_TIME_ATTR}]`)) {
            messageContainer.removeAttribute(TIMESTAMP_ATTR);
            messageContainer.removeAttribute(SOURCE_TIME_ATTR);
        }
    }

    function restartRuntime() {
        stopObserver();
        clearTimestampMarkers();
        if (isEnabled()) startObserver();
    }

    function installRuntime() {
        if (!isEnabled() || observer) return;
        if (!document.documentElement) {
            if (!installPending) {
                installPending = true;
                document.addEventListener("DOMContentLoaded", installRuntime, { once: true });
            }
            return;
        }

        installPending = false;
        injectStyleOnce(STYLE_ID, STYLE_TEXT);
        startObserver();
        if (!removePageChangeDetection) {
            removePageChangeDetection = startPageChangeDetection(restartRuntime);
        }
    }

    function teardownRuntime() {
        stopObserver();
        removePageChangeDetection?.();
        removePageChangeDetection = null;
        clearTimestampMarkers();
        document.getElementById(STYLE_ID)?.remove();
    }

    function applyOptions(options) {
        featureOptions = options;
        if (isEnabled()) installRuntime();
        else teardownRuntime();
    }

    window.addEventListener(PAGE_READY_EVENT, () => {
        if (isEnabled()) restartRuntime();
    });
    root.chatTimestamp = { formatMessageTime, teardownRuntime };
    bindFeatureOptions(applyOptions);
})();
