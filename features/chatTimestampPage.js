/**
 * features/chatTimestampPage.js — 라이브·다시보기 채팅의 서버 작성 시각을 React props에서 읽는 MAIN-world 브리지.
 *
 * 실행 컨텍스트: MAIN world(페이지). isolated world에서는 볼 수 없는 DOM 요소의 __reactProps$*를 읽는다.
 * 동작 위치: /live/* 의 aside#aside-chatting, /video/* 의 aside#vod-aside [role="log"] 내부 채팅.
 * 하는 일: isolated world가 message container에서 동기 요청 이벤트를 보내면, 제한된 조상 범위에서
 *   children.props.chatMessage.time을 찾고 검증된 millisecond epoch만 data-bcmt-source-time에 기록한다.
 *   React 객체나 콜백은 호출·수정하지 않으며, 서버 시각이 없거나 잘못되면 기존 source marker를 지운다.
 *   다시보기 본인 채팅 강조(features/vodOwnChat.js)가 요청하면 같은 범위에서 chatMessage.user(작성 계정 해시)를
 *   찾아 data-bcoc-source-user에 기록한다(2026-10-21 실측: 다시보기 행의 user가 profile.userIdHash와 같음).
 * 통신: cheese-spanner:chat-timestamp-source-request·cheese-spanner:chat-user-source-request 이벤트의 target,
 *   data-bcmt-source-time·data-bcoc-source-user DOM 속성,
 *   isolated-first 로드를 복구하는 cheese-spanner:chat-timestamp-page-ready 이벤트.
 * 참고: cheese-knife의 chatMessage.time 활용 방식(MIT). 고지는 THIRD_PARTY_NOTICES.md를 따른다.
 */
(() => {
    "use strict";

    const SOURCE_REQUEST_EVENT = "cheese-spanner:chat-timestamp-source-request";
    const USER_REQUEST_EVENT = "cheese-spanner:chat-user-source-request";
    const SOURCE_USER_ATTR = "data-bcoc-source-user";
    const USER_HASH_RE = /^[A-Za-z0-9_-]{1,128}$/;
    const PAGE_READY_EVENT = "cheese-spanner:chat-timestamp-page-ready";
    const SOURCE_TIME_ATTR = "data-bcmt-source-time";
    const READY_ATTR = "data-cheese-spanner-chat-timestamp-page-ready";
    const LIVE_CHAT_LOG_SELECTOR = "aside#aside-chatting [role='log']";
    const VOD_CHAT_LOG_SELECTOR = "aside#vod-aside [role='log']";
    const MESSAGE_CONTAINER_SELECTOR = "[class*='chatting_message'], [class*='chat-message']";
    const REACT_PROPS_PREFIX = "__reactProps$";
    const MAX_ANCESTOR_DEPTH = 8;
    const EARLIEST_MESSAGE_TIME_MS = Date.UTC(2020, 0, 1);
    const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
    const LIVE_ROUTE_RE = /^\/live(?:\/|$)/;
    const VOD_ROUTE_RE = /^\/video(?:\/|$)/;

    const documentRoot = document.documentElement;
    if (documentRoot?.hasAttribute(READY_ATTR)) return;
    documentRoot?.setAttribute(READY_ATTR, "1");

    function normalizeMessageTime(value) {
        if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
        if (value < EARLIEST_MESSAGE_TIME_MS || value > Date.now() + MAX_FUTURE_SKEW_MS) return null;
        return value;
    }

    function normalizeUserHash(value) {
        return typeof value === "string" && USER_HASH_RE.test(value) ? value : null;
    }

    function getReactMessageValue(element, read) {
        let propertyNames;
        try {
            propertyNames = Object.getOwnPropertyNames(element);
        } catch (_) {
            return null;
        }

        for (const propertyName of propertyNames) {
            if (!propertyName.startsWith(REACT_PROPS_PREFIX)) continue;

            try {
                const value = read(element[propertyName]?.children?.props?.chatMessage);
                if (value !== null) return value;
            } catch (_) {
                // A private React property may disappear while the row is being replaced.
            }
        }
        return null;
    }

    function findMessageValue(messageContainer, chatLog, read) {
        let current = messageContainer;
        let depth = 0;
        while (current instanceof Element && current !== chatLog && depth < MAX_ANCESTOR_DEPTH) {
            const value = getReactMessageValue(current, read);
            if (value !== null) return value;
            current = current.parentElement;
            depth += 1;
        }
        return null;
    }

    function getRequestChatLog(messageContainer) {
        if (!(messageContainer instanceof Element)) return null;
        const chatLogSelector = LIVE_ROUTE_RE.test(location.pathname)
            ? LIVE_CHAT_LOG_SELECTOR
            : VOD_ROUTE_RE.test(location.pathname)
              ? VOD_CHAT_LOG_SELECTOR
              : "";
        if (!chatLogSelector || !messageContainer.matches(MESSAGE_CONTAINER_SELECTOR)) return null;
        const chatLog = messageContainer.closest(chatLogSelector);
        return chatLog instanceof Element ? chatLog : null;
    }

    function writeSource(messageContainer, attribute, value) {
        if (value === null) {
            messageContainer.removeAttribute(attribute);
            return;
        }
        const serialized = String(value);
        if (messageContainer.getAttribute(attribute) !== serialized) {
            messageContainer.setAttribute(attribute, serialized);
        }
    }

    function handleUserRequest(event) {
        const messageContainer = event.target;
        const chatLog = getRequestChatLog(messageContainer);
        if (!chatLog) return;
        writeSource(
            messageContainer,
            SOURCE_USER_ATTR,
            findMessageValue(messageContainer, chatLog, (message) => normalizeUserHash(message?.user))
        );
    }

    function handleSourceRequest(event) {
        const messageContainer = event.target;
        const chatLog = getRequestChatLog(messageContainer);
        if (!chatLog) return;

        writeSource(
            messageContainer,
            SOURCE_TIME_ATTR,
            findMessageValue(messageContainer, chatLog, (message) => normalizeMessageTime(message?.time))
        );
    }

    document.addEventListener(SOURCE_REQUEST_EVENT, handleSourceRequest, true);
    document.addEventListener(USER_REQUEST_EVENT, handleUserRequest, true);
    window.dispatchEvent(new Event(PAGE_READY_EVENT));
})();
