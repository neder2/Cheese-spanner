/**
 * MAIN world / document_start. 광고 옵션을 켠 경우에만 동적으로 주입한다.
 * 과거 실측의 구형 두 boolean과 배포 코드에서 확인한 명시적 광고 판단을 구분한다.
 * 명시적 playerAdDisplayResponse는 부가 필드를 유지하며 preRoll/midRoll만 끈다.
 * 현재 CHZZK 소유와 광고 API·서비스가 맞는 라이브/VOD 요청은 새 ID도 처리한다.
 * 직접 소스는 최초 네이티브 초기화 전에만 비우며 NLiveCast 바깥 객체는 보존한다.
 * 라이브 일정은 등록·React 소유·현재 표시 정보를 확인하고 adSources만 비운다.
 * 일정 항목·순서·시간·원본과 네이티브 완료, 본영상 소스·암호화 바이트는 유지한다.
 * 지원 경계에 도달하지 않거나 현재 소유를 확인할 수 없으면 원본을 통과시킨다.
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
    const previousWeakMapGet = WeakMap.prototype.get;
    let active = false;
    let stopped = false;
    let changedParses = 0;
    let reloadRequired = false;
    let blockedVodSources = 0;
    let blockedLiveSources = 0;
    let blockedLiveSchedules = 0;
    let blockedLivePreRollSchedules = 0;
    let blockedWrappedLiveRequests = 0;
    const wrappedLiveRequests = new WeakMap();
    const sourceInitializations = new WeakMap();
    const initializedSources = new WeakSet();
    const scheduleManagers = new WeakMap();
    const EXPLICIT_DECISION_LIMIT = 65536;
    const LEGACY_DECISION_LIMIT = 2048;

    function publishStatus() {
        document.documentElement?.setAttribute(
            STATUS_ATTR,
            JSON.stringify({
                active,
                changedParses,
                blockedVodSources,
                blockedLiveSources,
                blockedLiveSchedules,
                blockedLivePreRollSchedules,
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

    function ownData(object, key) {
        return object && (typeof object === "object" || typeof object === "function")
            ? Object.getOwnPropertyDescriptor(object, key)?.value
            : undefined;
    }

    function isRecord(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function isNonemptyString(value) {
        return typeof value === "string" && value.trim().length > 0;
    }

    function matchesKnownAdSchedule(info, pathname) {
        if (!isRecord(info) || !isRecord(ownData(info, "adScheduleParam")) || !isRecord(ownData(info, "customParam")))
            return false;
        const id = ownData(ownData(info, "adScheduleParam"), "adScheduleId");
        const service = ownData(ownData(info, "customParam"), "svc");
        return (
            isNonemptyString(id) &&
            ((/^\/video\//.test(pathname) && service === "chzzk_video") ||
                (/^\/live\//.test(pathname) && service === "chzzk_live"))
        );
    }

    function isKnownAdSource(controller, source) {
        const info = ownData(source, "_videoScheduleInfo");
        return (
            active &&
            isAdController(controller) &&
            isRecord(source) &&
            typeof source?.setVideoScheduleInfo === "function" &&
            typeof source.handshakeVersion === "function" &&
            typeof source.initAd === "function" &&
            matchesKnownAdSchedule(info, location.pathname)
        );
    }

    function getControllerVideo(controller) {
        let element = controller.videoSlot;
        if (!(element instanceof Element)) {
            // 2026-09-19 CHZZK's media adapter owns a video inside an Element-valued shadowRoot.
            const slot = element;
            if (!slot || typeof slot !== "object" || controller.contentVideoElement !== slot) return false;
            const video = Object.getOwnPropertyDescriptor(slot, "_videoElement")?.value;
            const root = Object.getOwnPropertyDescriptor(slot, "shadowRoot")?.value;
            if (
                !(video instanceof HTMLVideoElement) ||
                !(root instanceof Element) ||
                !root.contains(video) ||
                slot.video !== video ||
                ownData(slot, "_videoElement") !== video ||
                ownData(slot, "shadowRoot") !== root ||
                controller.contentVideoElement !== slot
            )
                return null;
            element = video;
        }
        return element instanceof HTMLVideoElement && element.ownerDocument === document ? element : null;
    }

    function getChzzkPlayerRoot(video) {
        if (!(video instanceof HTMLVideoElement) || !video.isConnected) return null;
        let element = video;
        for (let depth = 0; element instanceof Element && depth < 16; depth++) {
            if (element.matches(".chzzk_player")) return element;
            element = element.parentElement || element.getRootNode()?.host;
        }
        return null;
    }

    function hasChzzkPlayerSlot(controller) {
        return Boolean(getChzzkPlayerRoot(getControllerVideo(controller)));
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

    function isWrappedLiveSource(source) {
        return (
            source?.constructor?.Constants?.NLIVECAST_ID === "ncast.advertisement" &&
            Object.getPrototypeOf(source) === source.constructor.prototype &&
            typeof source.handshakeVersion === "function" &&
            typeof source.initAd === "function"
        );
    }

    function getWrappedLiveInit(controller, source) {
        if (
            !active ||
            !/^\/live\//.test(location.pathname) ||
            !isAdController(controller) ||
            !isWrappedLiveSource(source) ||
            !hasChzzkPlayerSlot(controller)
        )
            return null;
        const init = Object.getOwnPropertyDescriptor(source, "_init")?.value;
        if (!init || typeof init !== "object" || Array.isArray(init)) return null;
        const fields = Object.getOwnPropertyDescriptors(init);
        return matchesWrappedLiveInit(fields) ? init : null;
    }

    function matchesWrappedLiveInit(fields) {
        return (
            fields.playerType?.value === "LIVE_PW" &&
            Array.isArray(fields.uiElements?.value) &&
            typeof fields.disableTrackingCors?.value === "boolean" &&
            Boolean(fields.linearAdRequest)
        );
    }

    function canOmitWrappedLiveRequest(state, source, receiver) {
        return (
            receiver === state.init &&
            getWrappedLiveInit(state.controller, source) === state.init &&
            state.controller.srcObject === source &&
            typeof state.request?.initAd === "function" &&
            isKnownAdSource(state.controller, state.request)
        );
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
                if (canOmitWrappedLiveRequest(state, source, this)) {
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

    const LIVE_PRE_ROLL_UNITS = new Set(["w_live_chzzk_naver_va", "event_w_live_chzzk_naver_va"]);

    // 입력 변환만 계산한다. 호출 문맥 확인과 처리 집계는 연결부가 소유한다.
    function getLiveScheduleChange(schedule) {
        let removed = false;
        let removedPreRoll = false;
        const adBreaks = schedule.adBreaks.map((entry) => {
            const preRoll = LIVE_PRE_ROLL_UNITS.has(entry?.adUnitId);
            if (
                !isRecord(entry) ||
                !isNonemptyString(entry.adUnitId) ||
                !Array.isArray(entry.adSources) ||
                entry.adSources.length === 0
            )
                return entry;
            removed = true;
            removedPreRoll ||= preRoll;
            return { ...entry, adSources: [] };
        });
        return removed ? { schedule: { ...schedule, adBreaks }, preRoll: removedPreRoll } : null;
    }

    function recordBlockedSchedule(preRoll) {
        blockedLiveSchedules++;
        if (preRoll) blockedLivePreRollSchedules++;
        publishStatus();
    }

    function hasScheduleApi(manager) {
        return (
            typeof manager?.loadWithAdSchedule === "function" &&
            typeof manager.startAdSchedule === "function" &&
            typeof manager.getAdDisplayContainerInfo === "function"
        );
    }

    function getHostFiber(element) {
        const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactFiber$"));
        const fiber = key && ownData(element, key);
        return ownData(fiber, "stateNode") === element ? { key, fiber } : null;
    }

    function hasLiveOwnerProps(props, channelId) {
        if (ownData(props, "channelId") !== channelId || !Number.isSafeInteger(ownData(props, "liveId"))) return false;
        if (ownData(props, "liveId") <= 0) return false;
        const playerDescriptor = Object.getOwnPropertyDescriptor(props, "player");
        if (playerDescriptor && !Object.hasOwn(playerDescriptor, "value")) return false;
        const parameterDescriptor = Object.getOwnPropertyDescriptor(props, "adParameter");
        if (parameterDescriptor && !Object.hasOwn(parameterDescriptor, "value")) return false;
        const parameter = parameterDescriptor?.value;
        if (parameter == null) return true;
        if (!isRecord(parameter)) return false;
        const service = Object.getOwnPropertyDescriptor(parameter, "svc");
        return !service || (Object.hasOwn(service, "value") && service.value === "chzzk_live");
    }

    function getPipSchedulePlayer(container, props) {
        const controller = ownData(props, "player")?.adsController;
        if (!isAdController(controller)) return null;
        const video = getControllerVideo(controller);
        const root = getChzzkPlayerRoot(video);
        // 네이티브 PiP는 본영상과 중간 광고 wrapper를 같은 부모 아래 유지한다.
        // 중간 광고의 miniMode는 스크롤 축소용이므로 PiP의 판별 값으로 사용하지 않는다.
        if (!root?.matches(".type_live.pip_mode") || root.parentElement !== container.parentElement?.parentElement)
            return null;
        return { controller, video, root };
    }

    function hasCurrentPipSchedulePlayer(owner) {
        const current = getPipSchedulePlayer(owner.container, owner.props);
        return (
            current &&
            current.controller === owner.pip.controller &&
            current.video === owner.pip.video &&
            current.root === owner.pip.root
        );
    }

    function getScheduleOwner(container) {
        const route = location.pathname;
        const routeChannelId = /^\/live\/([^/]+)\/?$/.exec(route)?.[1];
        const host = getHostFiber(container);
        if (
            (!routeChannelId && route.startsWith("/live/")) ||
            !host ||
            !container.isConnected ||
            container.ownerDocument !== document
        )
            return null;
        let found = null;
        const candidates = [];
        const chain = [];
        let owner = ownData(host.fiber, "return");
        for (let depth = 0; owner && depth < 8; depth++, owner = ownData(owner, "return")) {
            const alternate = ownData(owner, "alternate");
            chain.push({ fiber: owner, parent: ownData(owner, "return"), alternate });
            const peers = (alternate ? [owner, alternate] : [owner]).map((fiber) => {
                const first = ownData(fiber, "memoizedState");
                return {
                    fiber,
                    videoRef: ownData(first, "memoizedState"),
                    containerRef: ownData(ownData(first, "next"), "memoizedState"),
                };
            });
            if (!peers.some(({ containerRef }) => ownData(containerRef, "current") === container)) continue;
            // 어느 쪽이 최신인지 추측하지 않는다. 같은 컴포넌트의 후보가 모순되면 모두 통과시킨다.
            for (const { fiber, videoRef, containerRef } of peers) {
                if (ownData(containerRef, "current") !== container) return null;
                const video = ownData(videoRef, "current");
                const props = ownData(fiber, "memoizedProps");
                const channelId = routeChannelId || ownData(props, "channelId");
                if (
                    !(video instanceof HTMLVideoElement) ||
                    !video.isConnected ||
                    video.ownerDocument !== document ||
                    video.parentElement !== container.parentElement ||
                    !isNonemptyString(channelId) ||
                    !hasLiveOwnerProps(props, channelId)
                )
                    return null;
                const videoHost = getHostFiber(video);
                if (
                    !videoHost ||
                    ownData(ownData(videoHost.fiber, "return"), "stateNode") !== container.parentElement ||
                    ownData(ownData(host.fiber, "return"), "stateNode") !== container.parentElement
                )
                    return null;
                const liveId = ownData(props, "liveId");
                const player = ownData(props, "player");
                const pip = routeChannelId ? null : getPipSchedulePlayer(container, props);
                if (!routeChannelId && !pip) return null;
                if (
                    found &&
                    (found.video !== video ||
                        found.channelId !== channelId ||
                        found.liveId !== liveId ||
                        found.player !== player ||
                        found.pip?.controller !== pip?.controller ||
                        found.pip?.video !== pip?.video ||
                        found.pip?.root !== pip?.root)
                )
                    return null;
                candidates.push({ fiber, props, videoRef, containerRef });
                found ||= {
                    container,
                    video,
                    host,
                    videoHost,
                    fiber,
                    props,
                    videoRef,
                    containerRef,
                    channelId,
                    liveId,
                    player,
                    pip,
                    route,
                    candidates,
                    chain,
                };
            }
        }
        return found;
    }

    function isCurrentScheduleOwner(owner) {
        return (
            (!owner.pip || hasCurrentPipSchedulePlayer(owner)) &&
            active &&
            location.pathname === owner.route &&
            owner.container.isConnected &&
            owner.video.isConnected &&
            owner.container.parentElement === owner.video.parentElement &&
            ownData(owner.container, owner.host.key) === owner.host.fiber &&
            ownData(owner.video, owner.videoHost.key) === owner.videoHost.fiber &&
            ownData(owner.host.fiber, "return") === owner.chain[0]?.fiber &&
            owner.chain.every(
                ({ fiber, parent, alternate }) =>
                    ownData(fiber, "return") === parent && ownData(fiber, "alternate") === alternate
            ) &&
            owner.candidates.every(({ fiber, props, videoRef, containerRef }) => {
                const first = ownData(fiber, "memoizedState");
                return (
                    ownData(first, "memoizedState") === videoRef &&
                    ownData(ownData(first, "next"), "memoizedState") === containerRef &&
                    ownData(videoRef, "current") === owner.video &&
                    ownData(containerRef, "current") === owner.container &&
                    ownData(fiber, "memoizedProps") === props &&
                    ownData(props, "liveId") === owner.liveId &&
                    ownData(props, "player") === owner.player &&
                    hasLiveOwnerProps(props, owner.channelId)
                );
            })
        );
    }

    function getRegisteredScheduleManager(container) {
        const registration = scheduleManagers.get(container);
        return registration && Reflect.apply(previousWeakMapGet, registration.map, [container]) === registration.manager
            ? registration.manager
            : null;
    }

    function hasSharedDisplayOwner(owner, manager, info) {
        const player = ownData(owner.props, "player");
        const controller = player?.adsController;
        const viewSlot = controller?.viewSlot;
        if (
            !isAdController(controller) ||
            !(viewSlot instanceof Element) ||
            viewSlot.ownerDocument !== document ||
            !viewSlot.isConnected ||
            ownData(info, "adVideoContainer") !== viewSlot ||
            !hasChzzkPlayerSlot(controller)
        )
            return false;
        const video = getControllerVideo(controller);
        if (ownData(info, "contentVideo") !== video && ownData(info, "contentVideo") !== controller.videoSlot)
            return false;
        const shared = getRegisteredScheduleManager(viewSlot);
        return shared && shared !== manager && shared.getAdDisplayContainerInfo() === info;
    }

    function ownsScheduleDisplay(owner, manager, info) {
        if (!isCurrentScheduleOwner(owner) || getRegisteredScheduleManager(owner.container) !== manager) return false;
        if (ownData(info, "adVideoContainer") === owner.container && ownData(info, "contentVideo") === owner.video)
            return true;
        return hasSharedDisplayOwner(owner, manager, info) && isCurrentScheduleOwner(owner);
    }

    function wrapLiveSchedule(container, manager) {
        const load = manager?.loadWithAdSchedule;
        if (typeof load !== "function" || load.__betterChzzkLiveAdSchedule || !hasScheduleApi(manager)) return;
        const wrappedLoad = function (schedule, ...rest) {
            let filtered = schedule;
            try {
                if (active && this === manager && Array.isArray(schedule?.adBreaks)) {
                    const owner = getScheduleOwner(container);
                    const info = owner && manager.getAdDisplayContainerInfo();
                    const change =
                        owner && ownsScheduleDisplay(owner, manager, info) && getLiveScheduleChange(schedule);
                    if (
                        change &&
                        manager.getAdDisplayContainerInfo() === info &&
                        ownsScheduleDisplay(owner, manager, info)
                    ) {
                        filtered = change.schedule;
                        recordBlockedSchedule(change.preRoll);
                    }
                }
            } catch (_) {
                // SDK 소유 관계나 스케줄을 확인할 수 없으면 원래 입력을 전달한다.
                filtered = schedule;
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
    // 공유 표시 정보의 출처는 이 경계에서 관측한 등록만 약한 참조로 보관한다.
    const wrappedWeakMapSet = function (key, value) {
        const result = Reflect.apply(previousWeakMapSet, this, arguments);
        try {
            if (active && key instanceof Element) {
                if (hasScheduleApi(value) && value.getAdDisplayContainerInfo()?.adVideoContainer === key) {
                    const registration = scheduleManagers.get(key);
                    if (!registration || registration.map === this || !getRegisteredScheduleManager(key)) {
                        Reflect.apply(previousWeakMapSet, scheduleManagers, [key, { map: this, manager: value }]);
                        wrapLiveSchedule(key, value);
                    }
                }
            }
        } catch (_) {
            // 지원하지 않는 스케줄러는 원래 등록 결과를 유지한다.
        }
        return result;
    };

    function prepareSourceInitialization(controller) {
        let state = sourceInitializations.get(controller);
        if (state) return state;
        const originalInit = controller.initAd;
        const descriptor = Object.getOwnPropertyDescriptor(controller, "initAd");
        if (descriptor && (!Object.hasOwn(descriptor, "value") || !descriptor.configurable || !descriptor.writable))
            return null;
        state = { pending: null, wrapper: null, observed: new WeakSet() };
        state.wrapper = function (...args) {
            let pendingToBlock = null;
            if (this === controller) {
                const pending = state.pending;
                state.pending = null;
                try {
                    const current = controller.srcObject;
                    if (isRecord(current)) {
                        const entered = initializedSources.has(current);
                        initializedSources.add(current);
                        const pathname = location.pathname;
                        if (
                            !entered &&
                            pending?.source === current &&
                            controller.initAd === state.wrapper &&
                            isKnownAdSource(controller, current) &&
                            !isWrappedLiveSource(current) &&
                            hasChzzkPlayerSlot(controller) &&
                            active &&
                            location.pathname === pathname
                        ) {
                            pendingToBlock = pending;
                            initializedSources.delete(current);
                        }
                    }
                } catch (_) {
                    // 소유를 확인하지 못한 최초 초기화는 그대로 진행하고 후보를 종료한다.
                    if (pending) initializedSources.add(pending.source);
                }
            } else {
                try {
                    if (isRecord(this?.srcObject)) initializedSources.add(this.srcObject);
                } catch (_) {
                    // 다른 receiver의 원래 호출과 예외는 아래에서 유지한다.
                }
            }
            if (pendingToBlock) {
                Reflect.apply(pendingToBlock.setter, controller, [null]);
                recordBlockedSource();
            }
            return Reflect.apply(originalInit, this, args);
        };
        previousDefineProperty(controller, "initAd", {
            configurable: true,
            writable: true,
            enumerable: descriptor?.enumerable ?? false,
            value: state.wrapper,
        });
        sourceInitializations.set(controller, state);
        return state;
    }

    function applySourceAssignment(controller, key, value, originalSet) {
        let block = false;
        let wrapped = false;
        let initialization = null;
        try {
            if (key === "srcObject") {
                wrapped = isWrappedLiveSource(value);
                initialization = sourceInitializations.get(controller);
                if (initialization && initialization.pending?.source !== value) initialization.pending = null;
                if (
                    !wrapped &&
                    isAdController(controller) &&
                    typeof value?.setVideoScheduleInfo === "function" &&
                    typeof value.handshakeVersion === "function" &&
                    typeof value.initAd === "function" &&
                    getControllerVideo(controller)
                ) {
                    const pathname = location.pathname;
                    const current = controller.srcObject;
                    initialization ||= prepareSourceInitialization(controller);
                    if (current !== value) initialization?.observed.add(value);
                    const observed =
                        initialization?.observed.has(value) && controller.initAd === initialization.wrapper;
                    if (!initializedSources.has(value) && isKnownAdSource(controller, value)) {
                        if (
                            hasChzzkPlayerSlot(controller) &&
                            active &&
                            location.pathname === pathname &&
                            (current !== value || observed)
                        ) {
                            block = true;
                            if (initialization) initialization.pending = null;
                        } else {
                            if (initialization && controller.initAd === initialization.wrapper) {
                                // 이미 연결된 출처 불명의 소스를 처음 보는 경우 지연 차단을 새로 예약하지 않는다.
                                if (current !== value || observed)
                                    initialization.pending = { source: value, setter: originalSet };
                            }
                        }
                    }
                }
            } else block = isNativeAdUri(controller, value);
        } catch (_) {
            // 확인할 수 없는 소스는 원래 setter로 전달한다.
        }
        if (block && key === "src") {
            // src setter가 광고 팩토리를 실행하기 전에 동일한 소스 해제 경로로 전달한다.
            controller._attachSourceObject(null);
            controller._srcUri = "";
            recordBlockedSource();
            return;
        }
        const result = Reflect.apply(originalSet, controller, [block ? null : value]);
        if (block) {
            recordBlockedSource();
        } else if (key === "srcObject" && wrapped) {
            // 바깥 연결을 보존한 뒤 내부 요청의 독립된 처리 경로를 설치한다.
            try {
                guardWrappedLiveRequest(controller, value);
            } catch (_) {
                // 쓰기 불가 등 미확인 구조는 연결된 원래 소스를 유지한다.
            }
        }
        return result;
    }

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
                    return applySourceAssignment(this, key, value, originalSet);
                };
            },
        });
        return Reflect.apply(previousDefineProperty, this, [target, key, view]);
    };
    previousDefineProperty(wrappedDefineProperty, "__betterChzzkAdVideoDefinePatch", { value: true });

    function getAdDecisionChange(value, length) {
        if (value?.code !== 200 || value.message !== null) return null;
        const content = value.content;
        if (!isRecord(content)) return null;
        const explicit = Object.hasOwn(content, "playerAdDisplayResponse");
        if (!explicit && (length > LEGACY_DECISION_LIMIT || Object.keys(content).length !== 1)) return null;
        const key = explicit ? "playerAdDisplayResponse" : "livePlaybackJson";
        const preKey = explicit ? "preRoll" : "liveId";
        const midKey = explicit ? "midRoll" : "chatChannelId";
        const flags = content[key];
        if (
            !isRecord(flags) ||
            (!explicit && Object.keys(flags).length !== 2) ||
            typeof flags[preKey] !== "boolean" ||
            typeof flags[midKey] !== "boolean" ||
            (!flags[preKey] && !flags[midKey])
        ) {
            return null;
        }
        return { content, flags, key, preKey, midKey };
    }

    function applyAdDecision(value, change) {
        const { content, flags, key, preKey, midKey } = change;
        changedParses += 1;
        publishStatus();
        return { ...value, content: { ...content, [key]: { ...flags, [preKey]: false, [midKey]: false } } };
    }

    const wrappedParse = function (...args) {
        const value = Reflect.apply(previousParse, this, args);
        if (
            !active ||
            !/^\/(?:live|video)\//.test(location.pathname) ||
            typeof args[0] !== "string" ||
            args[0].length > EXPLICIT_DECISION_LIMIT ||
            typeof args[1] === "function"
        ) {
            return value;
        }
        try {
            const change = getAdDecisionChange(value, args[0].length);
            return change ? applyAdDecision(value, change) : value;
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
