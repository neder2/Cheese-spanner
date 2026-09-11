/**
 * MAIN world / document_start. 광고 옵션을 켠 경우에만 동적으로 주입한다.
 * 2026-09-08 seoraksan 실측의 광고 판단 응답만 처리한다. 이 응답에서는
 * livePlaybackJson.liveId/chatChannelId가 각각 프리롤/미드롤 boolean이다.
 * 2026-09-11 배포 클라이언트에서 확인한 playerAdDisplayResponse.preRoll/midRoll도 처리한다.
 * 일반 재생 정보와 구분하기 위해 확인한 키와 타입이 모두 맞을 때만 바꾼다.
 * 확인한 VOD 광고 소스는 연결 전에 비운다. 본영상 srcObject와 암호화 바이트는 건드리지 않는다.
 */
(() => {
    "use strict";

    const INSTALLED = "__betterChzzkAdVideoPageInstalled";
    const STATE_ATTR = "data-betterchzzk-ad-video-state";
    const STATUS_ATTR = "data-betterchzzk-ad-video-status";
    const STATE_EVENT = "betterchzzk:ad-video:state";
    if (window[INSTALLED]) return;

    const previousParse = JSON.parse;
    const previousDefineProperty = Object.defineProperty;
    let active = false;
    let stopped = false;
    let changedParses = 0;
    let reloadRequired = false;
    let blockedVodSources = 0;

    function publishStatus() {
        document.documentElement?.setAttribute(
            STATUS_ATTR,
            JSON.stringify({ active, changedParses, blockedVodSources, reloadRequired })
        );
    }

    function isVodAdSource(controller, source) {
        const info = source?._videoScheduleInfo;
        return (
            active &&
            /^\/video\//.test(location.pathname) &&
            typeof controller?._attachSourceObject === "function" &&
            typeof controller.initAd === "function" &&
            typeof controller.stopAd === "function" &&
            typeof source?.setVideoScheduleInfo === "function" &&
            info?.adScheduleParam?.adScheduleId === "CHZZK_NDP_SCH" &&
            info?.customParam?.svc === "chzzk_video"
        );
    }

    // 배포 플레이어의 AdsPlayer는 null을 광고 소스 없음으로 처리하고 initAd에서 반환한다.
    // 정의 시점에 잡아 광고 준비·AdBreakReady·암전보다 먼저 소스 연결을 막는다.
    const wrappedDefineProperty = function (target, key, descriptor) {
        if (key !== "srcObject" || typeof descriptor?.set !== "function" || typeof descriptor.get !== "function") {
            return Reflect.apply(previousDefineProperty, this, arguments);
        }
        const originalSet = descriptor.set;
        return Reflect.apply(previousDefineProperty, this, [
            target,
            key,
            {
                ...descriptor,
                set(value) {
                    let block = false;
                    try {
                        block = isVodAdSource(this, value);
                    } catch (_) {
                        // 확인할 수 없는 소스는 원래 setter로 전달한다.
                    }
                    const result = Reflect.apply(originalSet, this, [block ? null : value]);
                    if (block) {
                        blockedVodSources += 1;
                        publishStatus();
                    }
                    return result;
                },
            },
        ]);
    };

    function rewriteAdDecision(value) {
        if (value?.code !== 200 || value.message !== null) return value;
        const content = value.content;
        if (!content || Array.isArray(content) || Object.keys(content).length !== 1) return value;
        const explicit = Object.hasOwn(content, "playerAdDisplayResponse");
        const key = explicit ? "playerAdDisplayResponse" : "livePlaybackJson";
        const preKey = explicit ? "preRoll" : "liveId";
        const midKey = explicit ? "midRoll" : "chatChannelId";
        const flags = content[key];
        if (
            !flags ||
            Array.isArray(flags) ||
            Object.keys(flags).length !== 2 ||
            typeof flags[preKey] !== "boolean" ||
            typeof flags[midKey] !== "boolean" ||
            (!flags[preKey] && !flags[midKey])
        ) {
            return value;
        }
        changedParses += 1;
        publishStatus();
        return { ...value, content: { ...content, [key]: { [preKey]: false, [midKey]: false } } };
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
            if (Object.defineProperty === wrappedDefineProperty) Object.defineProperty = previousDefineProperty;
            reloadRequired = changedParses > 0 || blockedVodSources > 0;
        } else if (state === "1") {
            if (stopped) reloadRequired = true;
            else active = true;
        }
        publishStatus();
    }

    try {
        JSON.parse = wrappedParse;
        if (JSON.parse !== wrappedParse) return;
        Object.defineProperty = wrappedDefineProperty;
        if (Object.defineProperty !== wrappedDefineProperty) {
            JSON.parse = previousParse;
            return;
        }
        Object.defineProperty(window, INSTALLED, { value: true });
        document.addEventListener(STATE_EVENT, syncState);
        syncState();
        if (!document.documentElement) document.addEventListener("DOMContentLoaded", syncState, { once: true });
    } catch (_) {
        active = false;
        reloadRequired = true;
        if (JSON.parse === wrappedParse) JSON.parse = previousParse;
        if (Object.defineProperty === wrappedDefineProperty) Object.defineProperty = previousDefineProperty;
        publishStatus();
    }
})();
