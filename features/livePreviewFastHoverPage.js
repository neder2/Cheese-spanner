/**
 * features/livePreviewFastHoverPage.js — /lives의 치지직 기본 호버 미리보기 대기만 줄인다.
 *
 * 실행 컨텍스트: MAIN world, document_start. React가 소유한 기본 카드·플레이어·API 흐름은 그대로 둔다.
 * 하는 일: 실제 방송 썸네일의 React onMouseEnter가 예약하는 현재 300ms/600ms 타이머를 식별하고,
 *   해당 mouseover 이벤트가 전파되는 짧은 구간에만 같은 지연을 0ms로 바꾼다. 다른 타이머와
 *   확장 소유 HLS 플레이어에는 관여하지 않으며, React handler 구조가 다르면 아무 작업도 하지 않는다.
 * 옵션 키: followingPreviewTooltipEnabled (followingPreviewTooltip.js가 DOM attribute로 전달).
 * 통신: CONFIG_ATTR(data-betterchzzk-live-preview-fast-hover-options)를 읽고 CONFIG_EVENT를 수신한다.
 */
(() => {
    const CONFIG_EVENT = "betterchzzk:live-preview-fast-hover-options";
    const CONFIG_ATTR = "data-betterchzzk-live-preview-fast-hover-options";
    const LIVE_LINK_SELECTOR = "a[href*='/live/']";
    const NATIVE_HOVER_DELAY_SIGNATURE = "300,300,600";
    const MIN_THUMBNAIL_WIDTH = 160;
    const MIN_THUMBNAIL_HEIGHT = 90;

    let enabled = false;
    const handlerCache = new WeakMap();

    function isGlobalLiveListRoute() {
        return /^\/lives\/?$/.test(location.pathname);
    }

    function parseOptions(raw) {
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            return { enabled: parsed?.enabled === true };
        } catch {
            return null;
        }
    }

    function applyOptionsFromAttribute() {
        const parsed = parseOptions(document.documentElement?.getAttribute(CONFIG_ATTR));
        enabled = parsed?.enabled === true;
    }

    function getReactProps(element) {
        if (!(element instanceof Element)) return null;
        const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactProps"));
        return key ? element[key] : null;
    }

    function normalizeFunctionSource(value) {
        if (typeof value !== "function") return "";
        try {
            return Function.prototype.toString.call(value).replace(/\s+/g, "");
        } catch {
            return "";
        }
    }

    function getNativeHoverTimers(handler) {
        const source = normalizeFunctionSource(handler);
        const timers = Array.from(source.matchAll(/setTimeout\((async\(\)=>\{[^{}]*\}),(\d{2,4})\)/g)).map((match) => ({
            callbackSource: match[1],
            delay: Number(match[2]),
        }));
        return timers.map((timer) => timer.delay).join(",") === NATIVE_HOVER_DELAY_SIGNATURE ? timers : [];
    }

    function getNativeHoverHandler(element) {
        const props = getReactProps(element);
        const handler = props?.onMouseEnter;
        if (typeof handler !== "function" || typeof props?.onMouseLeave !== "function") return null;

        const cached = handlerCache.get(element);
        if (cached?.handler === handler) return cached.timers.length ? cached : null;

        const timers = getNativeHoverTimers(handler);
        const value = { handler, timers };
        handlerCache.set(element, value);
        return timers.length ? value : null;
    }

    function resolveNativeThumbnail(event) {
        if (!enabled || !isGlobalLiveListRoute() || !(event.target instanceof Element)) return null;

        const anchor = event.target.closest(LIVE_LINK_SELECTOR);
        if (!(anchor instanceof HTMLAnchorElement) || !anchor.querySelector("img, video, canvas")) return null;
        try {
            const url = new URL(anchor.href, location.origin);
            if (url.origin !== location.origin || !/^\/live\/[^/]+\/?$/.test(url.pathname)) return null;
        } catch {
            return null;
        }

        if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) return null;
        const rect = anchor.getBoundingClientRect();
        if (rect.width < MIN_THUMBNAIL_WIDTH || rect.height < MIN_THUMBNAIL_HEIGHT) return null;

        const hover = getNativeHoverHandler(anchor);
        return hover ? { anchor, timers: hover.timers } : null;
    }

    function installEventTimerAcceleration(target) {
        if (window.setTimeout?.__betterChzzkFastHover === true) return;

        let restored = false;
        let accelerated = false;
        const originalSetTimeout = window.setTimeout;
        const restore = () => {
            if (restored) return;
            restored = true;
            if (window.setTimeout === acceleratedSetTimeout) window.setTimeout = originalSetTimeout;
        };
        const acceleratedSetTimeout = function (callback, delay, ...args) {
            const callbackSource = normalizeFunctionSource(callback);
            const matchesNativeTimer =
                !accelerated &&
                target.timers.some((timer) => timer.delay === Number(delay) && timer.callbackSource === callbackSource);
            if (!matchesNativeTimer) return Reflect.apply(originalSetTimeout, window, [callback, delay, ...args]);

            accelerated = true;
            restore();
            return Reflect.apply(originalSetTimeout, window, [callback, 0, ...args]);
        };
        Object.defineProperty(acceleratedSetTimeout, "__betterChzzkFastHover", { value: true });
        window.setTimeout = acceleratedSetTimeout;
        queueMicrotask(restore);
    }

    function handleMouseOver(event) {
        const target = resolveNativeThumbnail(event);
        if (!target) return;
        installEventTimerAcceleration(target);
    }

    window.addEventListener(CONFIG_EVENT, applyOptionsFromAttribute, true);
    window.addEventListener("mouseover", handleMouseOver, true);
    applyOptionsFromAttribute();
})();
