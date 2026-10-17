/**
 * shared/chatMultiview.js — 채팅 멀티뷰 구성의 순수 형식·검증·변경 (globalThis.BetterChzzkChatMultiview)
 *
 * 실행 컨텍스트: DOM·chrome 비의존. isolated 콘텐츠(features/chatMultiview.js 앞), 옵션 페이지의 설정 파일
 *   검증, 워커 importScripts의 설정 저장 검증에서 함께 로드한다.
 * 저장 형식(local `betterchzzk:chat-multiview:v1`, 키 이름은 호환 식별자): 정확히
 *   {version:2, channels:[{channelId, channelName}], chatWidth, chatHeight, corner, x, y, input, scale}.
 *   channels는 최대 4개·중복 없음, channelId는 소문자 32자리 16진수, channelName은 앞뒤 공백이 없는
 *   0~100 code point 문자열이다. chatWidth 240~1600·chatHeight 180~2160은 채팅 한 칸의 CSS px 정수이고
 *   패널 크기는 칸 수에 맞춰 화면에서 계산한다(2026-10-12 사용자 요청: 칸이 넓게 늘어나지 않게).
 *   칸 크기는 scale을 적용한 뒤 화면에 보이는 크기이며 배율 적용 전 값이 아니다. 콘텐츠의 크기 손잡이도 이
 *   범위 안에서만 움직여 끄는 동안 보인 크기와 저장 뒤 크기가 같다(2026-10-17).
 *   corner는 패널을 붙인 화면 모서리(bottom-right/bottom-left/top-right/top-left), x·y는 그 모서리에서
 *   패널까지의 CSS px 거리(0~7680 정수), input은 칸의 채팅 입력창 표시 여부, scale은 채팅 크기 퍼센트(70~150)다.
 *   같은 날 이전 형식(version 1: 패널 width·height, 아래 모서리 corner, 선택 input·scale)은 채널·위치 모서리·
 *   입력창·채팅 크기를 옮기고 칸 크기와 거리는 기본값으로 읽는다.
 * parseConfig는 엄격 검증이며 잘못된 값을 잘라 성공으로 만들지 않는다. normalizeConfig는 읽기 전용이며
 *   형식이 맞지 않으면 기본 구성을 돌려줄 뿐 저장하지 않는다.
 * 프레임 주소는 frameUrl만 만들며 검증한 채널 ID의 치지직 네이티브 채팅 경로 외에는 빈 문자열이다.
 */
(() => {
    const STORAGE_KEY = "betterchzzk:chat-multiview:v1";
    const VERSION = 2;
    const MAX_CHANNELS = 4;
    const MAX_NAME_LENGTH = 100;
    const MIN_CHAT_WIDTH = 240;
    const MAX_CHAT_WIDTH = 1600;
    const MIN_CHAT_HEIGHT = 180;
    const MAX_CHAT_HEIGHT = 2160;
    const MAX_OFFSET = 7680;
    const DEFAULT_OFFSET = 16;
    const CORNERS = Object.freeze(["bottom-right", "bottom-left", "top-right", "top-left"]);
    const MIN_SCALE = 70;
    const MAX_SCALE = 150;
    const SCALE_STEP = 10;
    const DEFAULT_SCALE = 100;
    // 채팅 한 칸의 크기예요. 보통 너비는 치지직 라이브 채팅 칸(353px)에 가깝게 맞췄어요.
    const SIZE_PRESETS = Object.freeze({
        small: Object.freeze({ chatWidth: 280, chatHeight: 480 }),
        medium: Object.freeze({ chatWidth: 340, chatHeight: 600 }),
        large: Object.freeze({ chatWidth: 420, chatHeight: 760 }),
    });
    const FRAME_ORIGIN = "https://chzzk.naver.com";
    const CHANNEL_ID = /^[a-f0-9]{32}$/;
    // 정확한 키 비교를 위해 정렬된 순서로 둔다.
    const CHANNEL_KEYS = ["channelId", "channelName"];
    const ROOT_KEYS = ["channels", "chatHeight", "chatWidth", "corner", "input", "scale", "version", "x", "y"];
    const LEGACY_KEYS = ["channels", "corner", "height", "version", "width"];
    const LEGACY_OPTIONAL_KEYS = ["input", "scale"];

    function createDefaultConfig() {
        return {
            version: VERSION,
            channels: [],
            chatWidth: SIZE_PRESETS.medium.chatWidth,
            chatHeight: SIZE_PRESETS.medium.chatHeight,
            corner: CORNERS[0],
            x: DEFAULT_OFFSET,
            y: DEFAULT_OFFSET,
            input: false,
            scale: DEFAULT_SCALE,
        };
    }
    const DEFAULT_CONFIG = Object.freeze({ ...createDefaultConfig(), channels: Object.freeze([]) });

    // 저장소 값은 다른 realm에서 만들어질 수 있으므로 prototype 동일성 대신 일반 객체 형태를 확인한다.
    function isPlainObject(value) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
        const proto = Object.getPrototypeOf(value);
        return proto === null || Object.getPrototypeOf(proto) === null;
    }
    function hasExactKeys(value, sortedKeys) {
        const keys = Object.keys(value).sort();
        return keys.length === sortedKeys.length && keys.every((key, index) => key === sortedKeys[index]);
    }
    function hasLegacyKeys(value) {
        const keys = Object.keys(value);
        return (
            LEGACY_KEYS.every((key) => Object.hasOwn(value, key)) &&
            keys.every((key) => LEGACY_KEYS.includes(key) || LEGACY_OPTIONAL_KEYS.includes(key))
        );
    }
    function codePointLength(value) {
        return Array.from(value).length;
    }
    function isChannelId(value) {
        return typeof value === "string" && CHANNEL_ID.test(value);
    }
    function isIntegerIn(value, min, max) {
        return Number.isSafeInteger(value) && value >= min && value <= max;
    }

    function parseChannels(list) {
        if (!Array.isArray(list)) return { ok: false, error: "invalid-channels" };
        if (list.length > MAX_CHANNELS) return { ok: false, error: "too-many-channels" };
        const seen = new Set();
        const channels = [];
        for (const channel of list) {
            if (!isPlainObject(channel) || !hasExactKeys(channel, CHANNEL_KEYS))
                return { ok: false, error: "invalid-channel" };
            const { channelId, channelName } = channel;
            if (!isChannelId(channelId)) return { ok: false, error: "invalid-channel-id" };
            if (
                typeof channelName !== "string" ||
                channelName !== channelName.trim() ||
                codePointLength(channelName) > MAX_NAME_LENGTH
            )
                return { ok: false, error: "invalid-channel-name" };
            if (seen.has(channelId)) return { ok: false, error: "duplicate-channel" };
            seen.add(channelId);
            channels.push({ channelId, channelName });
        }
        return { ok: true, channels };
    }
    function parseDisplay(input, scale) {
        if (typeof input !== "boolean") return { ok: false, error: "invalid-input" };
        if (!isIntegerIn(scale, MIN_SCALE, MAX_SCALE)) return { ok: false, error: "invalid-scale" };
        return { ok: true };
    }

    // 2026-10-12 같은 날 쓰던 version 1(패널 크기)을 읽는다. 칸 크기·거리는 뜻이 달라 기본값으로 둔다.
    function parseLegacyConfig(value) {
        if (!hasLegacyKeys(value)) return { ok: false, error: "unexpected-fields" };
        const parsed = parseChannels(value.channels);
        if (!parsed.ok) return parsed;
        if (!isIntegerIn(value.width, 320, 3840)) return { ok: false, error: "invalid-width" };
        if (!isIntegerIn(value.height, 240, 2160)) return { ok: false, error: "invalid-height" };
        if (value.corner !== "bottom-right" && value.corner !== "bottom-left")
            return { ok: false, error: "invalid-corner" };
        const input = Object.hasOwn(value, "input") ? value.input : false;
        const scale = Object.hasOwn(value, "scale") ? value.scale : DEFAULT_SCALE;
        const display = parseDisplay(input, scale);
        if (!display.ok) return display;
        return {
            ok: true,
            config: { ...createDefaultConfig(), channels: parsed.channels, corner: value.corner, input, scale },
        };
    }

    function parseConfig(value) {
        if (!isPlainObject(value)) return { ok: false, error: "not-object" };
        if (value.version === 1) return parseLegacyConfig(value);
        if (!hasExactKeys(value, ROOT_KEYS)) return { ok: false, error: "unexpected-fields" };
        if (value.version !== VERSION) return { ok: false, error: "invalid-version" };
        const parsed = parseChannels(value.channels);
        if (!parsed.ok) return parsed;
        if (!isIntegerIn(value.chatWidth, MIN_CHAT_WIDTH, MAX_CHAT_WIDTH)) return { ok: false, error: "invalid-width" };
        if (!isIntegerIn(value.chatHeight, MIN_CHAT_HEIGHT, MAX_CHAT_HEIGHT))
            return { ok: false, error: "invalid-height" };
        if (!CORNERS.includes(value.corner)) return { ok: false, error: "invalid-corner" };
        if (!isIntegerIn(value.x, 0, MAX_OFFSET) || !isIntegerIn(value.y, 0, MAX_OFFSET))
            return { ok: false, error: "invalid-position" };
        const display = parseDisplay(value.input, value.scale);
        if (!display.ok) return display;
        return {
            ok: true,
            config: {
                version: VERSION,
                channels: parsed.channels,
                chatWidth: value.chatWidth,
                chatHeight: value.chatHeight,
                corner: value.corner,
                x: value.x,
                y: value.y,
                input: value.input,
                scale: value.scale,
            },
        };
    }

    function normalizeConfig(value) {
        const parsed = parseConfig(value);
        return parsed.ok ? parsed.config : createDefaultConfig();
    }

    // 워커의 expected 비교와 같은 의미의 구조 비교. 키 순서는 무시하고 JSON 값만 다룬다.
    function isSameStoredValue(a, b) {
        if (Object.is(a, b)) return true;
        if (Array.isArray(a) || Array.isArray(b)) {
            return (
                Array.isArray(a) &&
                Array.isArray(b) &&
                a.length === b.length &&
                a.every((item, index) => isSameStoredValue(item, b[index]))
            );
        }
        if (!isPlainObject(a) || !isPlainObject(b)) return false;
        const keys = Object.keys(a);
        return (
            keys.length === Object.keys(b).length &&
            keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && isSameStoredValue(a[key], b[key]))
        );
    }

    // API 응답의 표시 이름을 저장 형식에 맞춘다. 이름은 표시용 사본이며 채널 정체성은 channelId다.
    function normalizeChannelName(value) {
        if (typeof value !== "string") return "";
        const trimmed = value.trim();
        if (codePointLength(trimmed) <= MAX_NAME_LENGTH) return trimmed;
        return Array.from(trimmed).slice(0, MAX_NAME_LENGTH).join("").trim();
    }

    // 사용자가 입력한 채널 주소·ID·채널명을 구분한다. 주소처럼 보이지만 허용 경로가 아니면 검색하지 않는다.
    function parseChannelInput(value) {
        const text = typeof value === "string" ? value.trim() : "";
        if (!text) return { kind: "empty" };
        if (/^[a-f0-9]{32}$/i.test(text)) return { kind: "id", channelId: text.toLowerCase() };
        const schemeLike = /^[a-z][a-z\d+.-]*:/i.test(text) || text.startsWith("//");
        const hostLike = /^(?:[a-z\d-]+\.)*chzzk\.naver\.com(?:[/?#]|$)/i.test(text);
        if (!schemeLike && !hostLike) return { kind: "keyword", keyword: text };
        let url;
        try {
            url = new URL(hostLike ? "https://" + text : text);
        } catch {
            return { kind: "invalid" };
        }
        if (
            !["https:", "http:"].includes(url.protocol) ||
            url.hostname.toLowerCase() !== "chzzk.naver.com" ||
            url.port ||
            url.username ||
            url.password
        )
            return { kind: "invalid" };
        const match = url.pathname.match(/^\/(?:live\/)?([a-f0-9]{32})(?:\/[a-z-]*)?\/?$/i);
        return match ? { kind: "id", channelId: match[1].toLowerCase() } : { kind: "invalid" };
    }

    function frameUrl(channelId) {
        return isChannelId(channelId) ? FRAME_ORIGIN + "/live/" + channelId + "/chat" : "";
    }

    function isFramePath(pathname, channelId) {
        return (
            isChannelId(channelId) &&
            (pathname === "/live/" + channelId + "/chat" || pathname === "/live/" + channelId + "/chat/")
        );
    }

    function withChannels(config, channels) {
        return { ...config, channels: channels.map((channel) => ({ ...channel })) };
    }

    function addChannel(config, channel) {
        const channelId = channel?.channelId;
        if (!isChannelId(channelId)) return { ok: false, error: "invalid-channel" };
        if (config.channels.some((item) => item.channelId === channelId)) return { ok: false, error: "duplicate" };
        if (config.channels.length >= MAX_CHANNELS) return { ok: false, error: "limit" };
        const entry = { channelId, channelName: normalizeChannelName(channel.channelName) };
        return { ok: true, config: withChannels(config, [...config.channels, entry]) };
    }

    function removeChannel(config, channelId) {
        if (!config.channels.some((item) => item.channelId === channelId)) return { ok: true, unchanged: true, config };
        const channels = config.channels.filter((item) => item.channelId !== channelId);
        return { ok: true, config: withChannels(config, channels) };
    }

    function moveChannel(config, channelId, offset) {
        const from = config.channels.findIndex((item) => item.channelId === channelId);
        const to = from + (offset < 0 ? -1 : 1);
        if (from < 0 || to < 0 || to >= config.channels.length) return { ok: true, unchanged: true, config };
        const channels = [...config.channels];
        [channels[from], channels[to]] = [channels[to], channels[from]];
        return { ok: true, config: withChannels(config, channels) };
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, Math.round(value)));
    }

    // 칸 하나의 크기를 범위 안으로 맞춘다. 패널 크기는 칸 수와 화면에서 계산하므로 저장하지 않는다.
    function withChatSize(config, chatWidth, chatHeight) {
        if (!Number.isFinite(chatWidth) || !Number.isFinite(chatHeight)) return { ok: false, error: "invalid-size" };
        const next = {
            chatWidth: clamp(chatWidth, MIN_CHAT_WIDTH, MAX_CHAT_WIDTH),
            chatHeight: clamp(chatHeight, MIN_CHAT_HEIGHT, MAX_CHAT_HEIGHT),
        };
        if (next.chatWidth === config.chatWidth && next.chatHeight === config.chatHeight)
            return { ok: true, unchanged: true, config };
        return { ok: true, config: { ...withChannels(config, config.channels), ...next } };
    }

    // 패널을 붙일 화면 모서리와 그 모서리에서의 거리를 바꾼다.
    function withPosition(config, corner, x, y) {
        if (!CORNERS.includes(corner)) return { ok: false, error: "invalid-corner" };
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "invalid-position" };
        const next = { corner, x: clamp(x, 0, MAX_OFFSET), y: clamp(y, 0, MAX_OFFSET) };
        if (next.corner === config.corner && next.x === config.x && next.y === config.y)
            return { ok: true, unchanged: true, config };
        return { ok: true, config: { ...withChannels(config, config.channels), ...next } };
    }

    function withInput(config, input) {
        if (typeof input !== "boolean") return { ok: false, error: "invalid-input" };
        if (config.input === input) return { ok: true, unchanged: true, config };
        return { ok: true, config: { ...withChannels(config, config.channels), input } };
    }

    // 채팅 크기를 SCALE_STEP 눈금의 바로 옆 값으로 옮긴다. 범위 끝에서는 바뀌지 않는다.
    function stepScale(config, direction) {
        const current = isIntegerIn(config.scale, MIN_SCALE, MAX_SCALE) ? config.scale : DEFAULT_SCALE;
        const target =
            direction < 0
                ? Math.ceil(current / SCALE_STEP) * SCALE_STEP - SCALE_STEP
                : Math.floor(current / SCALE_STEP) * SCALE_STEP + SCALE_STEP;
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, target));
        if (next === config.scale) return { ok: true, unchanged: true, config };
        return { ok: true, config: { ...withChannels(config, config.channels), scale: next } };
    }

    function sizePresetOf(config) {
        for (const [name, size] of Object.entries(SIZE_PRESETS)) {
            if (size.chatWidth === config.chatWidth && size.chatHeight === config.chatHeight) return name;
        }
        return "";
    }

    globalThis.BetterChzzkChatMultiview = Object.freeze({
        STORAGE_KEY,
        VERSION,
        MAX_CHANNELS,
        MAX_NAME_LENGTH,
        MIN_CHAT_WIDTH,
        MAX_CHAT_WIDTH,
        MIN_CHAT_HEIGHT,
        MAX_CHAT_HEIGHT,
        MAX_OFFSET,
        DEFAULT_OFFSET,
        CORNERS,
        MIN_SCALE,
        MAX_SCALE,
        SCALE_STEP,
        DEFAULT_SCALE,
        SIZE_PRESETS,
        FRAME_ORIGIN,
        DEFAULT_CONFIG,
        createDefaultConfig,
        parseConfig,
        normalizeConfig,
        isSameStoredValue,
        normalizeChannelName,
        parseChannelInput,
        frameUrl,
        isFramePath,
        addChannel,
        removeChannel,
        moveChannel,
        withChatSize,
        withPosition,
        withInput,
        stepScale,
        sizePresetOf,
    });
})();
