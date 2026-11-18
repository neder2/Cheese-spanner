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
 *   채팅 도구가 요청하면 가장 가까운 chatMessage의 key·user·time·profile을 검증해 제한된 식별값을
 *   data-bcct-source-message에, 지원되는 블라인드 상태의 originalContent를 data-bcct-source-original에 기록한다.
 *   라이브 안내가 표시된 행은 같은 방송의 네이티브 채팅 목록에서 같은 메시지의 최신 상태와 원문을 확인한다.
 *   같은 스냅샷의 역할·인증 메타데이터와 NORMAL 본문·참조 이모티콘만 제한해 전달한다.
 *   불완전한 메시지는 null로 답하고 블라인드 원문 속성은 라이브의 지원 상태에서만 기록한다.
 *   블라인드 옵션이 켜졌을 때만 화면과 일치하는 일반 채팅 원문을 MAIN 메모리에 보관한다.
 * 통신: cheese-spanner:chat-timestamp-source-request·cheese-spanner:chat-user-source-request·
 *   cheese-spanner:chat-blind-source-request 이벤트의 target,
 *   data-bcmt-source-time·data-bcoc-source-user·data-bcct-source-message·data-bcct-source-original DOM 속성,
 *   isolated-first 로드를 복구하는 cheese-spanner:chat-timestamp-page-ready 이벤트.
 * 참고: cheese-knife의 chatMessage.time 활용 방식(MIT). 고지는 THIRD_PARTY_NOTICES.md를 따른다.
 */
(() => {
    "use strict";

    const SOURCE_REQUEST_EVENT = "cheese-spanner:chat-timestamp-source-request";
    const USER_REQUEST_EVENT = "cheese-spanner:chat-user-source-request";
    const SOURCE_USER_ATTR = "data-bcoc-source-user";
    const USER_HASH_RE = /^[A-Za-z0-9_-]{1,128}$/;
    const BLIND_REQUEST_EVENT = "cheese-spanner:chat-blind-source-request";
    const BLIND_ORIGINALS_CLEAR_EVENT = "cheese-spanner:chat-blind-originals-clear";
    const SOURCE_ORIGINAL_ATTR = "data-bcct-source-original";
    const SOURCE_MESSAGE_ATTR = "data-bcct-source-message";
    const NORMAL_MESSAGE_STATUS = "NORMAL";
    const BLIND_REQUEST_STATUSES = new Set([
        NORMAL_MESSAGE_STATUS,
        "BLIND",
        "CBOTBLIND",
        "HIDDEN",
        "RECLAIM",
        "FILTERED",
    ]);
    const NATIVE_BLIND_NOTICES = new Set([
        "메시지가 블라인드 처리되었습니다.",
        "클린봇이 부적절한 표현을 감지했습니다.",
    ]);
    const MAX_ORIGINAL_LENGTH = 2000;
    const MAX_SOURCE_LENGTH = 32768;
    const MAX_NORMAL_EMOJIS = 64;
    const MAX_EMOJI_URL_LENGTH = 2048;
    const MESSAGE_ROLE_CODES = new Set([
        "streamer",
        "streaming_channel_manager",
        "streaming_chat_manager",
        "manager",
        "common_user",
    ]);
    const VERIFIED_MARK_TYPES = new Set(["PARTNER", "CHALLENGER", "OFFICIAL"]);
    const EMOJI_URL_PREFIXES = [
        "https://ssl.pstatic.net/static/nng/glive/",
        "https://nng-phinf.pstatic.net/",
        "https://beta-nng.ssl.phinf.net/",
    ];
    const MAX_CACHED_ORIGINALS = 500;
    const PAGE_READY_EVENT = "cheese-spanner:chat-timestamp-page-ready";
    const SOURCE_TIME_ATTR = "data-bcmt-source-time";
    const READY_ATTR = "data-cheese-spanner-chat-timestamp-page-ready";
    const LIVE_CHAT_LOG_SELECTOR = "aside#aside-chatting [role='log']";
    const VOD_CHAT_LOG_SELECTOR = "aside#vod-aside [role='log']";
    const MESSAGE_CONTAINER_SELECTOR = "[class*='chatting_message'], [class*='chat-message']";
    const REACT_PROPS_PREFIX = "__reactProps$";
    const REACT_FIBER_PREFIX = "__reactFiber$";
    const MAX_ANCESTOR_DEPTH = 8;
    const MAX_CHAT_FIBER_DEPTH = 16;
    const MAX_LIVE_MESSAGE_LIST_SIZE = 200;
    const EARLIEST_MESSAGE_TIME_MS = Date.UTC(2020, 0, 1);
    // 기기 시계가 서버보다 늦어도(동기화 꺼짐, 시간대만큼 어긋난 시계 등) 방금 온 채팅의 서버 시각을 버리지 않아요.
    // 기기 시각보다 12시간 넘게 앞선 값만 잘못된 값으로 봐요. isolated 쪽(features/chatTimestamp.js)과 같은 상한이에요.
    const MAX_FUTURE_SKEW_MS = 12 * 60 * 60 * 1000;
    const LIVE_ROUTE_RE = /^\/live(?:\/|$)/;
    const VOD_ROUTE_RE = /^\/video(?:\/|$)/;

    const documentRoot = document.documentElement;
    if (documentRoot?.hasAttribute(READY_ATTR)) return;
    documentRoot?.setAttribute(READY_ATTR, "1");

    const cachedOriginals = new Map();
    let cachedOriginalsPath = "";

    function normalizeMessageTime(value) {
        if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
        if (value < EARLIEST_MESSAGE_TIME_MS || value > Date.now() + MAX_FUTURE_SKEW_MS) return null;
        return value;
    }

    function normalizeUserHash(value) {
        return typeof value === "string" && USER_HASH_RE.test(value) ? value : null;
    }

    function normalizeOriginal(value) {
        if (typeof value !== "string") return null;
        const text = value.trim();
        return text && !NATIVE_BLIND_NOTICES.has(text) ? text.slice(0, MAX_ORIGINAL_LENGTH) : null;
    }

    function ownValue(object, key) {
        return object && typeof object === "object" ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
    }

    function readMetadataField(profile, key) {
        const descriptor = Object.getOwnPropertyDescriptor(profile, key);
        return {
            value: descriptor?.value,
            invalid: Boolean(descriptor && !Object.prototype.hasOwnProperty.call(descriptor, "value")),
        };
    }

    function readRoleMetadata(profile) {
        const role = readMetadataField(profile, "userRoleCode");
        const code = typeof role.value === "string" ? role.value.toLowerCase() : null;
        const roleMissing = role.value == null || (typeof role.value === "string" && !role.value.trim());
        const roleState = role.invalid
            ? "invalid"
            : roleMissing
              ? "missing"
              : MESSAGE_ROLE_CODES.has(code)
                ? "known"
                : "invalid";
        const mark = readMetadataField(profile, "verifiedMark");
        const type = readMetadataField(profile, "verifiedMarkType");
        const grade = typeof type.value === "string" ? type.value : null;
        const hasGrade = VERIFIED_MARK_TYPES.has(grade);
        const invalidMark = mark.invalid || (mark.value !== undefined && typeof mark.value !== "boolean");
        const invalidType =
            type.invalid || (type.value !== undefined && type.value !== null && grade !== "" && !hasGrade);
        const verifiedState =
            invalidMark || invalidType || (hasGrade && mark.value === false)
                ? "invalid"
                : hasGrade || type.value === null || typeof mark.value === "boolean"
                  ? "known"
                  : "missing";
        return {
            roleCode: roleState === "known" ? code : null,
            roleState,
            verifiedMarkType: verifiedState === "known" && hasGrade ? grade : null,
            verifiedMark: verifiedState === "known" && typeof mark.value === "boolean" ? mark.value : null,
            verifiedState,
        };
    }

    function readEmojiField(object, key) {
        if (!object || typeof object !== "object") return { invalid: true };
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor) return { missing: true, invalid: key in object };
        if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) return { invalid: true };
        return { value: descriptor.value };
    }

    function readNormalEmojis(message, normalText) {
        if (normalText === null) return null;
        const tokens = new Set(normalText.match(/\{:\w+:\}/g) || []);
        if (tokens.size > MAX_NORMAL_EMOJIS) return null;
        const result = Object.create(null);
        if (!tokens.size) return result;
        const extras = readEmojiField(message, "extras");
        if (extras.invalid) return null;
        if (extras.value == null) return result;
        const emojis = readEmojiField(extras.value, "emojis");
        if (emojis.invalid) return null;
        if (emojis.value == null) return result;
        for (const token of tokens) {
            const field = readEmojiField(emojis.value, token.slice(2, -2));
            if (field.invalid) return null;
            // The native renderer leaves absent tokens and empty URLs as literal text.
            // Unreadable mappings remain null: they must not confirm a literal DOM body.
            if (field.missing || field.value === "") continue;
            const url = field.value;
            if (
                typeof url !== "string" ||
                url.length > MAX_EMOJI_URL_LENGTH ||
                !EMOJI_URL_PREFIXES.some((prefix) => url.startsWith(prefix))
            )
                return null;
            for (let index = 0; index < url.length; index += 1) {
                const code = url.charCodeAt(index);
                if (code <= 0x20 || code === 0x7f) return null;
            }
            result[token] = url;
        }
        return result;
    }

    function readBlindMessage(message) {
        const key = ownValue(message, "key");
        const user = normalizeUserHash(ownValue(message, "user"));
        const time = normalizeMessageTime(ownValue(message, "time"));
        const status = ownValue(message, "status");
        const profile = ownValue(message, "profile");
        const nickname = ownValue(profile, "nickname");
        if (
            typeof key !== "string" ||
            !key ||
            key.length > 256 ||
            !user ||
            time === null ||
            !BLIND_REQUEST_STATUSES.has(status) ||
            ownValue(profile, "userIdHash") !== user ||
            typeof nickname !== "string" ||
            !nickname.trim() ||
            nickname.length > 200
        )
            return null;
        const original = ownValue(message, "originalContent");
        const normalText =
            status === NORMAL_MESSAGE_STATUS && typeof original === "string" && original.length <= MAX_ORIGINAL_LENGTH
                ? original
                : null;
        return {
            key,
            user,
            time,
            status,
            nickname,
            original: normalizeOriginal(original),
            ...readRoleMetadata(profile),
            normalText,
            normalEmojis: readNormalEmojis(message, normalText),
        };
    }

    function clearBlindOriginals() {
        cachedOriginals.clear();
        cachedOriginalsPath = "";
    }

    function readVisibleChat(detail) {
        // A string crosses worlds without sharing a mutable JavaScript object.
        if (typeof detail !== "string" || detail.length > MAX_SOURCE_LENGTH) return null;
        try {
            const value = JSON.parse(detail);
            return Array.isArray(value) &&
                (value.length === 2 || (value.length === 3 && typeof value[2] === "boolean")) &&
                typeof value[0] === "string" &&
                value[0].length <= 200 &&
                typeof value[1] === "string"
                ? value
                : null;
        } catch (_) {
            return null;
        }
    }

    function matchesVisibleAuthor(snapshot, visible) {
        return visible && snapshot.nickname.trim().replace(/\s+/g, " ") === visible[0];
    }

    function originalForReply(snapshot, path, visible) {
        if (!snapshot) return null;
        const blinded = snapshot.status !== NORMAL_MESSAGE_STATUS;
        const original = blinded ? snapshot.original : null;
        if (!matchesVisibleAuthor(snapshot, visible) || visible[2] === false) return original;

        if (cachedOriginalsPath !== path) {
            clearBlindOriginals();
            cachedOriginalsPath = path;
        }
        const identity = JSON.stringify([snapshot.key, snapshot.user, snapshot.time]);
        // When props lead the DOM during row reuse, the visible body may still belong to the previous message.
        if (snapshot.original && (blinded || snapshot.original.replace(/\s+/g, " ") === visible[1])) {
            cachedOriginals.delete(identity);
            cachedOriginals.set(identity, snapshot.original);
            if (cachedOriginals.size > MAX_CACHED_ORIGINALS)
                cachedOriginals.delete(cachedOriginals.keys().next().value);
        }
        return blinded ? original || cachedOriginals.get(identity) || null : null;
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

    // 행 정체성은 가장 가까운 chatMessage로 고정한다.
    function findNearestMessage(messageContainer, chatLog) {
        return findMessageValue(messageContainer, chatLog, (message) =>
            message && typeof message === "object" ? message : null
        );
    }

    function getLiveMessageList(chatLog, channelId) {
        if (!channelId) return null;
        const fiberKey = Object.getOwnPropertyNames(chatLog).find((name) => name.startsWith(REACT_FIBER_PREFIX));
        if (!fiberKey) return null;
        let fiber = ownValue(chatLog, fiberKey);
        for (let depth = 0; fiber && depth < MAX_CHAT_FIBER_DEPTH; depth++, fiber = ownValue(fiber, "return")) {
            const client = ownValue(ownValue(fiber, "memoizedProps"), "gameChatClient");
            const alternate = ownValue(ownValue(ownValue(fiber, "alternate"), "memoizedProps"), "gameChatClient");
            if (!client && !alternate) continue;
            if (client && alternate && client !== alternate) return null;
            const owner = client || alternate;
            if (ownValue(ownValue(owner, "config"), "streamingChannelId") !== channelId) return null;
            const list = ownValue(owner, "messageList");
            return Array.isArray(list) ? list : null;
        }
        return null;
    }

    function matchesMessageIdentity(message, row) {
        return (
            ownValue(message, "key") === row.key &&
            ownValue(message, "user") === row.user &&
            ownValue(message, "time") === row.time
        );
    }

    function findLatestLiveMessage(chatLog, channelId, row) {
        const list = getLiveMessageList(chatLog, channelId);
        if (!list) return null;
        // The live client keeps the recent 200 messages in arrival order.
        const end = list.length;
        for (let index = end - 1; index >= Math.max(0, end - MAX_LIVE_MESSAGE_LIST_SIZE); index--) {
            const message = ownValue(list, index);
            if (matchesMessageIdentity(message, row)) return { list, index, message };
        }
        return null;
    }

    function getRequestChatLog(messageContainer, allowStructure = false) {
        if (!(messageContainer instanceof Element)) return null;
        const chatLogSelector = LIVE_ROUTE_RE.test(location.pathname)
            ? LIVE_CHAT_LOG_SELECTOR
            : VOD_ROUTE_RE.test(location.pathname)
              ? VOD_CHAT_LOG_SELECTOR
              : "";
        if (!chatLogSelector) return null;
        const chatLog = messageContainer.closest(chatLogSelector);
        if (!chatLog || messageContainer === chatLog) return null;
        if (messageContainer.matches(MESSAGE_CONTAINER_SELECTOR)) return chatLog;
        if (!allowStructure) return null;
        const nickname = messageContainer.querySelector(':scope > button[class*="_nickname_"][aria-haspopup="true"]');
        const body = messageContainer.querySelector(':scope > span[class*="_text_"]');
        return nickname && body && nickname.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING
            ? chatLog
            : null;
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

    function handleBlindRequest(event) {
        const messageContainer = event.target;
        const chatLog = getRequestChatLog(messageContainer, true);
        if (!chatLog) return;
        const path = location.pathname;
        const isLive = LIVE_ROUTE_RE.test(path);
        const visible = readVisibleChat(event.detail);
        const channelId = isLive && visible ? path.split("/")[2] : "";
        const message = findNearestMessage(messageContainer, chatLog);
        const row = readBlindMessage(message);
        let latest = null;
        let snapshot = row;
        if (isLive && row && matchesVisibleAuthor(row, visible) && NATIVE_BLIND_NOTICES.has(visible[1])) {
            // On a post-display blind, React can update the notice while the host props still say NORMAL.
            latest = findLatestLiveMessage(chatLog, channelId, row);
            if (latest) snapshot = readBlindMessage(latest.message);
        }
        if (
            (event.detail != null && !visible) ||
            (row && visible && !matchesVisibleAuthor(row, visible)) ||
            findNearestMessage(messageContainer, chatLog) !== message ||
            JSON.stringify(readBlindMessage(message)) !== JSON.stringify(row) ||
            (latest &&
                (!snapshot ||
                    !matchesMessageIdentity(snapshot, row) ||
                    !matchesVisibleAuthor(snapshot, visible) ||
                    getLiveMessageList(chatLog, channelId) !== latest.list ||
                    ownValue(latest.list, latest.index) !== latest.message ||
                    JSON.stringify(readBlindMessage(latest.message)) !== JSON.stringify(snapshot))) ||
            !messageContainer.isConnected ||
            getRequestChatLog(messageContainer, true) !== chatLog ||
            location.pathname !== path
        )
            snapshot = null;
        writeSource(messageContainer, SOURCE_ORIGINAL_ATTR, isLive ? originalForReply(snapshot, path, visible) : null);
        const identity = snapshot && {
            key: snapshot.key,
            user: snapshot.user,
            time: snapshot.time,
            status: snapshot.status,
            nickname: snapshot.nickname,
            roleCode: snapshot.roleCode,
            roleState: snapshot.roleState,
            verifiedMarkType: snapshot.verifiedMarkType,
            verifiedMark: snapshot.verifiedMark,
            verifiedState: snapshot.verifiedState,
            normalText: snapshot.normalText,
            normalEmojis: snapshot.normalEmojis,
        };
        if (identity && JSON.stringify(identity).length > MAX_SOURCE_LENGTH) {
            identity.normalText = null;
            identity.normalEmojis = null;
        }
        // Even an invalid page message answers explicitly, preventing fallback to unrelated DOM text.
        writeSource(messageContainer, SOURCE_MESSAGE_ATTR, JSON.stringify(identity));
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
    document.addEventListener(BLIND_REQUEST_EVENT, handleBlindRequest, true);
    window.addEventListener(BLIND_ORIGINALS_CLEAR_EVENT, clearBlindOriginals);
    window.addEventListener("pagehide", clearBlindOriginals);
    window.dispatchEvent(new Event(PAGE_READY_EVENT));
})();
