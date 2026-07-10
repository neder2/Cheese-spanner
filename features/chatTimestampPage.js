/**
 * features/chatTimestampPage.js — 라이브 채팅의 서버 작성 시각을 React props에서 읽는 MAIN-world 브리지.
 *
 * 실행 컨텍스트: MAIN world(페이지). isolated world에서는 볼 수 없는 DOM 요소의 __reactProps$*를 읽는다.
 * 동작 위치: /live/* 의 aside#aside-chatting [role="log"] 내부 채팅 메시지 컨테이너.
 * 하는 일: isolated world가 message container에서 동기 요청 이벤트를 보내면, 제한된 조상 범위에서
 *   children.props.chatMessage.time을 찾고 검증된 millisecond epoch만 data-bcmt-source-time에 기록한다.
 *   React 객체나 콜백은 호출·수정하지 않으며, 서버 시각이 없거나 잘못되면 기존 source marker를 지운다.
 * 통신: betterchzzk:chat-timestamp-source-request 이벤트의 target, data-bcmt-source-time DOM 속성,
 *   isolated-first 로드를 복구하는 betterchzzk:chat-timestamp-page-ready 이벤트.
 * 참고: cheese-knife의 chatMessage.time 활용 방식(MIT). 고지는 THIRD_PARTY_NOTICES.md를 따른다.
 */
(() => {
    "use strict";

    const SOURCE_REQUEST_EVENT = "betterchzzk:chat-timestamp-source-request";
    const PAGE_READY_EVENT = "betterchzzk:chat-timestamp-page-ready";
    const SOURCE_TIME_ATTR = "data-bcmt-source-time";
    const READY_ATTR = "data-betterchzzk-chat-timestamp-page-ready";
    const CHAT_LOG_SELECTOR = "aside#aside-chatting [role='log']";
    const MESSAGE_CONTAINER_SELECTOR = "[class*='chatting_message'], [class*='chat-message']";
    const REACT_PROPS_PREFIX = "__reactProps$";
    const MAX_ANCESTOR_DEPTH = 8;
    const EARLIEST_MESSAGE_TIME_MS = Date.UTC(2020, 0, 1);
    const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
    const LIVE_ROUTE_RE = /^\/live(?:\/|$)/;

    const documentRoot = document.documentElement;
    if (documentRoot?.hasAttribute(READY_ATTR)) return;
    documentRoot?.setAttribute(READY_ATTR, "1");

    function normalizeMessageTime(value) {
        if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
        if (value < EARLIEST_MESSAGE_TIME_MS || value > Date.now() + MAX_FUTURE_SKEW_MS) return null;
        return value;
    }

    function getReactMessageTime(element) {
        let propertyNames;
        try {
            propertyNames = Object.getOwnPropertyNames(element);
        } catch (_) {
            return null;
        }

        for (const propertyName of propertyNames) {
            if (!propertyName.startsWith(REACT_PROPS_PREFIX)) continue;

            try {
                const value = element[propertyName]?.children?.props?.chatMessage?.time;
                const messageTime = normalizeMessageTime(value);
                if (messageTime !== null) return messageTime;
            } catch (_) {
                // A private React property may disappear while the row is being replaced.
            }
        }
        return null;
    }

    function findMessageTime(messageContainer, chatLog) {
        let current = messageContainer;
        let depth = 0;
        while (current instanceof Element && current !== chatLog && depth < MAX_ANCESTOR_DEPTH) {
            const messageTime = getReactMessageTime(current);
            if (messageTime !== null) return messageTime;
            current = current.parentElement;
            depth += 1;
        }
        return null;
    }

    function handleSourceRequest(event) {
        const messageContainer = event.target;
        if (!(messageContainer instanceof Element)) return;
        if (!LIVE_ROUTE_RE.test(location.pathname)) return;
        if (!messageContainer.matches(MESSAGE_CONTAINER_SELECTOR)) return;

        const chatLog = messageContainer.closest(CHAT_LOG_SELECTOR);
        if (!(chatLog instanceof Element)) return;

        const messageTime = findMessageTime(messageContainer, chatLog);
        if (messageTime === null) {
            messageContainer.removeAttribute(SOURCE_TIME_ATTR);
            return;
        }

        const serialized = String(messageTime);
        if (messageContainer.getAttribute(SOURCE_TIME_ATTR) !== serialized) {
            messageContainer.setAttribute(SOURCE_TIME_ATTR, serialized);
        }
    }

    document.addEventListener(SOURCE_REQUEST_EVENT, handleSourceRequest, true);
    window.dispatchEvent(new Event(PAGE_READY_EVENT));
})();
