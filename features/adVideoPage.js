/**
 * MAIN world / document_start. 광고 옵션을 켠 경우에만 동적으로 주입한다.
 * 2026-09-08 seoraksan 실측의 광고 판단 응답만 처리한다. 이 응답에서는
 * livePlaybackJson.liveId/chatChannelId가 각각 프리롤/미드롤 boolean이다.
 * 2026-09-11 배포 클라이언트에서 확인한 playerAdDisplayResponse.preRoll/midRoll도 처리한다.
 * 일반 재생 정보와 구분하기 위해 확인한 키와 타입이 모두 맞을 때만 바꾼다.
 * 확인한 라이브/VOD 소스는 연결 전에 비우고 라이브 중간 광고 스케줄에서 광고 항목을 제외한다.
 * NLiveCast 래퍼는 유지하고 확인된 라이브 내부 요청만 전달하지 않는다.
 * 본영상 srcObject와 암호화 바이트는 건드리지 않는다.
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
    const previousWeakMapSet = WeakMap.prototype.set;
    let active = false;
    let stopped = false;
    let changedParses = 0;
    let reloadRequired = false;
    let blockedVodSources = 0;
    let blockedLiveSources = 0;
    let blockedLiveSchedules = 0;
    let blockedWrappedLiveRequests = 0;
    const wrappedLiveRequests = new WeakMap();

    function publishStatus() {
        document.documentElement?.setAttribute(
            STATUS_ATTR,
            JSON.stringify({
                active,
                changedParses,
                blockedVodSources,
                blockedLiveSources,
                blockedLiveSchedules,
                blockedWrappedLiveRequests,
                reloadRequired,
            })
        );
    }

    function isAdController(controller) {
        return (
            typeof controller?._attachSourceObject === "function" &&
            typeof controller.initAd === "function" &&
            typeof controller.stopAd === "function"
        );
    }

    function isKnownAdSource(controller, source) {
        const info = source?._videoScheduleInfo;
        return (
            active &&
            isAdController(controller) &&
            typeof source?.setVideoScheduleInfo === "function" &&
            ((/^\/video\//.test(location.pathname) &&
                info?.adScheduleParam?.adScheduleId === "CHZZK_NDP_SCH" &&
                info?.customParam?.svc === "chzzk_video") ||
                (/^\/live\//.test(location.pathname) &&
                    ["LIVE_CHZZK_NDP_SCH", "LIVE_CHZZK_NDP_SCH_EVENT"].includes(info?.adScheduleParam?.adScheduleId) &&
                    info?.customParam?.svc === "chzzk_live"))
        );
    }

    function hasChzzkPlayerSlot(controller) {
        let element = controller.videoSlot;
        for (let depth = 0; element instanceof Element && depth < 16; depth++) {
            if (element.matches(".chzzk_player")) return true;
            element = element.parentElement || element.getRootNode()?.host;
        }
        return false;
    }

    function isNativeAdUri(controller, value) {
        return (
            active &&
            /^\/(?:live|video)\//.test(location.pathname) &&
            isAdController(controller) &&
            typeof value === "string" &&
            value.startsWith("glad:") &&
            hasChzzkPlayerSlot(controller)
        );
    }

    function getWrappedLiveInit(controller, source) {
        if (
            !active ||
            !/^\/live\//.test(location.pathname) ||
            !isAdController(controller) ||
            source?.constructor?.Constants?.NLIVECAST_ID !== "ncast.advertisement" ||
            Object.getPrototypeOf(source) !== source.constructor.prototype ||
            typeof source.handshakeVersion !== "function" ||
            typeof source.initAd !== "function" ||
            !controller.videoSlot?.isConnected ||
            !hasChzzkPlayerSlot(controller)
        )
            return null;
        const init = Object.getOwnPropertyDescriptor(source, "_init")?.value;
        if (!init || typeof init !== "object" || Array.isArray(init)) return null;
        const fields = Object.getOwnPropertyDescriptors(init);
        if (
            Reflect.ownKeys(fields).length !== 4 ||
            fields.playerType?.value !== "LIVE_PW" ||
            !Array.isArray(fields.uiElements?.value) ||
            typeof fields.disableTrackingCors?.value !== "boolean" ||
            !fields.linearAdRequest
        )
            return null;
        return init;
    }

    // 2026-09-14 배포 NLiveCastAdRequest는 내부 요청이 없으면 바깥 클라이언트 초기화를 계속한다.
    // 외부 객체·메서드와 원래 요청은 유지한다. WeakMap은 살아 있는 래퍼의 중복 등록만 구분한다.
    function guardWrappedLiveRequest(controller, source) {
        const init = getWrappedLiveInit(controller, source);
        if (!init) return;
        const descriptor = Object.getOwnPropertyDescriptor(init, "linearAdRequest");
        const existing = wrappedLiveRequests.get(source);
        if (existing?.init === init && descriptor.get === existing.get) {
            existing.controller = controller;
            return;
        }
        if (
            !Object.hasOwn(descriptor, "value") ||
            !descriptor.configurable ||
            !descriptor.writable ||
            typeof descriptor.value?.initAd !== "function" ||
            !isKnownAdSource(controller, descriptor.value)
        )
            return;
        const state = { init, controller, request: descriptor.value };
        state.get = function () {
            try {
                if (
                    this === init &&
                    getWrappedLiveInit(state.controller, source) === init &&
                    state.controller.srcObject === source &&
                    typeof state.request?.initAd === "function" &&
                    isKnownAdSource(state.controller, state.request)
                ) {
                    blockedWrappedLiveRequests++;
                    publishStatus();
                    return null;
                }
            } catch (_) {
                // 조건이 달라진 래퍼는 원래 요청을 전달한다.
            }
            return state.request;
        };
        previousDefineProperty(init, "linearAdRequest", {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            get: state.get,
            set(value) {
                if (this === init) state.request = value;
                else
                    previousDefineProperty(this, "linearAdRequest", {
                        value,
                        writable: true,
                        enumerable: true,
                        configurable: true,
                    });
            },
        });
        wrappedLiveRequests.set(source, state);
    }

    function recordBlockedSource() {
        if (/^\/video\//.test(location.pathname)) blockedVodSources++;
        else blockedLiveSources++;
        publishStatus();
    }

    function wrapLiveSchedule(container, manager) {
        const load = manager?.loadWithAdSchedule;
        if (
            typeof load !== "function" ||
            load.__betterChzzkLiveAdSchedule ||
            typeof manager.startAdSchedule !== "function" ||
            typeof manager.getAdDisplayContainerInfo !== "function"
        )
            return;
        const wrappedLoad = function (schedule, ...rest) {
            let filtered = schedule;
            if (
                active &&
                /^\/live\//.test(location.pathname) &&
                container.isConnected &&
                container.closest("#midAdPlayerWrapper") &&
                Array.isArray(schedule?.adBreaks)
            ) {
                let removed = false;
                const adBreaks = schedule.adBreaks.map((entry) => {
                    if (
                        !["w_live_chzzk_naver_va_mid", "event_w_live_chzzk_naver_va_mid"].includes(entry?.adUnitId) ||
                        !Array.isArray(entry.adSources) ||
                        entry.adSources.length === 0
                    )
                        return entry;
                    removed = true;
                    return { ...entry, adSources: [] };
                });
                if (removed) {
                    filtered = { ...schedule, adBreaks };
                    blockedLiveSchedules++;
                    publishStatus();
                }
            }
            // 빈 광고 항목의 완료 처리는 네이티브 스케줄러가 수행한다.
            return Reflect.apply(load, this, [filtered, ...rest]);
        };
        previousDefineProperty(wrappedLoad, "__betterChzzkLiveAdSchedule", { value: true });
        previousDefineProperty(manager, "loadWithAdSchedule", {
            value: wrappedLoad,
            configurable: true,
            writable: true,
        });
    }

    // 현재 GFP는 광고 컨테이너를 키로 WeakMap에 스케줄러를 등록한 후 loadWithAdSchedule을 호출한다.
    // DOM 탐색은 실측한 단일 ID에 해당할 때만 수행한다. 별도 맵이나 타이머는 유지하지 않는다.
    const wrappedWeakMapSet = function (key, value) {
        const result = Reflect.apply(previousWeakMapSet, this, arguments);
        try {
            if (
                active &&
                key instanceof Element &&
                key.id === "midAdVideoContainer" &&
                key.closest("#midAdPlayerWrapper")
            )
                wrapLiveSchedule(key, value);
        } catch (_) {
            // 지원하지 않는 스케줄러는 원래 등록 결과를 유지한다.
        }
        return result;
    };

    // 배포 플레이어의 AdsPlayer는 null을 광고 소스 없음으로 처리하고 initAd에서 반환한다.
    // 정의 시점에 잡아 광고 준비·AdBreakReady·암전보다 먼저 소스 연결을 막는다.
    const wrappedDefineProperty = function (target, key, descriptor) {
        if (
            (key !== "srcObject" && key !== "src") ||
            !descriptor ||
            (typeof descriptor !== "object" && typeof descriptor !== "function")
        ) {
            return Reflect.apply(previousDefineProperty, this, arguments);
        }
        const view = new Proxy(descriptor, {
            get(source, field) {
                const originalSet = Reflect.get(source, field, source);
                if (field !== "set" || typeof originalSet !== "function") return originalSet;
                const own = Object.getOwnPropertyDescriptor(source, field);
                if (own && "value" in own && !own.configurable && !own.writable) return originalSet;
                return function (value) {
                    let block = false;
                    try {
                        block = key === "srcObject" ? isKnownAdSource(this, value) : isNativeAdUri(this, value);
                    } catch (_) {
                        // 확인할 수 없는 소스는 원래 setter로 전달한다.
                    }
                    if (block && key === "src") {
                        // src setter가 광고 팩토리를 실행하기 전에 동일한 소스 해제 경로로 전달한다.
                        this._attachSourceObject(null);
                        this._srcUri = "";
                        recordBlockedSource();
                        return;
                    }
                    const result = Reflect.apply(originalSet, this, [block ? null : value]);
                    if (block) {
                        recordBlockedSource();
                    } else if (key === "srcObject") {
                        try {
                            guardWrappedLiveRequest(this, value);
                        } catch (_) {
                            // 쓰기 불가 등 미확인 구조는 연결된 원래 소스를 유지한다.
                        }
                    }
                    return result;
                };
            },
        });
        return Reflect.apply(previousDefineProperty, this, [target, key, view]);
    };
    previousDefineProperty(wrappedDefineProperty, "__betterChzzkAdVideoDefinePatch", { value: true });

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
            if (WeakMap.prototype.set === wrappedWeakMapSet) WeakMap.prototype.set = previousWeakMapSet;
            reloadRequired =
                changedParses > 0 ||
                blockedVodSources > 0 ||
                blockedLiveSources > 0 ||
                blockedLiveSchedules > 0 ||
                blockedWrappedLiveRequests > 0;
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
        WeakMap.prototype.set = wrappedWeakMapSet;
        if (Object.defineProperty !== wrappedDefineProperty || WeakMap.prototype.set !== wrappedWeakMapSet)
            throw new Error("Ad hooks unavailable");
        Object.defineProperty(window, INSTALLED, { value: true });
        document.addEventListener(STATE_EVENT, syncState);
        syncState();
        if (!document.documentElement) document.addEventListener("DOMContentLoaded", syncState, { once: true });
    } catch (_) {
        active = false;
        reloadRequired = true;
        if (JSON.parse === wrappedParse) JSON.parse = previousParse;
        if (Object.defineProperty === wrappedDefineProperty) Object.defineProperty = previousDefineProperty;
        if (WeakMap.prototype.set === wrappedWeakMapSet) WeakMap.prototype.set = previousWeakMapSet;
        publishStatus();
    }
})();
