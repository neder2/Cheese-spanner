/**
 * MAIN world / document_start. 광고 옵션을 켠 경우에만 동적으로 주입한다.
 * 2026-09-08 seoraksan 실측의 광고 판단 응답만 처리한다. 이 응답에서는
 * livePlaybackJson.liveId/chatChannelId가 각각 프리롤/미드롤 boolean이다.
 * 일반 재생 정보와 구분하기 위해 확인한 키와 타입이 모두 맞을 때만 바꾼다.
 * 암호화 바이트, 광고 SDK, 네트워크 요청, 본방송 미디어에는 개입하지 않는다.
 */
(() => {
    "use strict";

    const INSTALLED = "__betterChzzkAdVideoPageInstalled";
    const STATE_ATTR = "data-betterchzzk-ad-video-state";
    const STATUS_ATTR = "data-betterchzzk-ad-video-status";
    const STATE_EVENT = "betterchzzk:ad-video:state";
    if (window[INSTALLED]) return;

    const previousParse = JSON.parse;
    let active = false;
    let stopped = false;
    let changedParses = 0;
    let reloadRequired = false;

    function publishStatus() {
        document.documentElement?.setAttribute(STATUS_ATTR, JSON.stringify({ active, changedParses, reloadRequired }));
    }

    function rewriteAdDecision(value) {
        if (value?.code !== 200 || value.message !== null) return value;
        const content = value.content;
        if (!content || Array.isArray(content) || Object.keys(content).length !== 1) return value;
        const flags = content.livePlaybackJson;
        if (
            !flags ||
            Array.isArray(flags) ||
            Object.keys(flags).length !== 2 ||
            typeof flags.liveId !== "boolean" ||
            typeof flags.chatChannelId !== "boolean" ||
            (!flags.liveId && !flags.chatChannelId)
        ) {
            return value;
        }
        changedParses += 1;
        publishStatus();
        return { ...value, content: { ...content, livePlaybackJson: { liveId: false, chatChannelId: false } } };
    }

    const wrappedParse = function (...args) {
        const value = Reflect.apply(previousParse, this, args);
        if (
            !active ||
            !/^\/(?:live|video)\//.test(location.pathname) ||
            typeof args[0] !== "string" ||
            args[0].length > 2048 ||
            typeof args[1] === "function"
        ) {
            return value;
        }
        try {
            return rewriteAdDecision(value);
        } catch (_) {
            return value;
        }
    };

    function syncState() {
        const state = document.documentElement?.getAttribute(STATE_ATTR);
        if (state === "0") {
            active = false;
            stopped = true;
            // 나중에 다른 처리가 덧씌워졌으면 그 함수를 덮어쓰지 않고 원본을 통과시킨다.
            if (JSON.parse === wrappedParse) JSON.parse = previousParse;
            reloadRequired = changedParses > 0;
        } else if (state === "1") {
            if (stopped) reloadRequired = true;
            else active = true;
        }
        publishStatus();
    }

    try {
        JSON.parse = wrappedParse;
        if (JSON.parse !== wrappedParse) return;
        Object.defineProperty(window, INSTALLED, { value: true });
        document.addEventListener(STATE_EVENT, syncState);
        syncState();
        if (!document.documentElement) document.addEventListener("DOMContentLoaded", syncState, { once: true });
    } catch (_) {
        active = false;
        reloadRequired = true;
        publishStatus();
    }
})();
