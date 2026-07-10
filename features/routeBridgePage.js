/**
 * features/routeBridgePage.js — SPA 라우트 변경을 감지해 페이지 컨텍스트 전역에 이벤트로 알린다.
 *
 * 실행 컨텍스트: MAIN world(페이지) — content_scripts에서 document_start에 로드된다.
 * 동작 위치: https://chzzk.naver.com/* 전체(모든 라우트).
 * 하는 일: history.pushState/replaceState를 래핑하고 popstate/hashchange/pageshow를 수신해
 *   location.href 변경을 감지한다. 변경이 감지되면 window에 CustomEvent를 디스패치한다.
 *   같은 스크립트가 중복 실행되는 것을 INSTALL_FLAG로 막는다.
 * 의존: 없음 (window.history, DOM 이벤트만 사용).
 * 통신: window에 CustomEvent betterchzzk:routechange를 detail: { href, source } 형태로 디스패치한다.
 *   같은 MAIN world의 features/autoQualityPage.js와, isolated world의 content.js(BetterChzzk.utils의
 *   라우트 변경 감지)가 각각 이 이벤트를 window addEventListener로 직접 수신한다.
 */
(() => {
    const INSTALL_FLAG = "__betterChzzkRouteBridgeInstalled";
    const EVENT_NAME = "betterchzzk:routechange";
    const WRAP_FLAG = "__betterChzzkRouteBridgeWrapped";
    const WRAP_NATIVE = "__betterChzzkRouteBridgeNative";

    if (window[INSTALL_FLAG]) return;
    try {
        Object.defineProperty(window, INSTALL_FLAG, { value: true });
    } catch (_) {
        window[INSTALL_FLAG] = true;
    }

    let lastHref = location.href;

    function dispatchRouteChange(source) {
        const href = location.href;
        if (href === lastHref) return;
        lastHref = href;
        window.dispatchEvent(
            new CustomEvent(EVENT_NAME, {
                detail: { href, source },
            })
        );
    }

    function queueRouteCheck(source) {
        if (typeof queueMicrotask === "function") {
            queueMicrotask(() => dispatchRouteChange(source));
            return;
        }
        setTimeout(() => dispatchRouteChange(source), 0);
    }

    // pushState/replaceState를 감싸서 호출 직후 라우트 변경 여부를 큐잉된 마이크로태스크로 확인한다.
    function wrapHistoryMethod(name) {
        const original = history?.[name];
        if (typeof original !== "function" || original[WRAP_FLAG]) return;

        const wrapped = function (...args) {
            const result = original.apply(this, args);
            queueRouteCheck(name);
            return result;
        };

        try {
            Object.defineProperty(wrapped, WRAP_FLAG, { value: true });
            Object.defineProperty(wrapped, WRAP_NATIVE, { value: original });
        } catch (_) {
            wrapped[WRAP_FLAG] = true;
            wrapped[WRAP_NATIVE] = original;
        }

        try {
            history[name] = wrapped;
        } catch (_) {
            // If the page blocks history patching, popstate/hashchange/pageshow still report route changes.
        }
    }

    wrapHistoryMethod("pushState");
    wrapHistoryMethod("replaceState");
    window.addEventListener("popstate", () => dispatchRouteChange("popstate"), true);
    window.addEventListener("hashchange", () => dispatchRouteChange("hashchange"), true);
    window.addEventListener("pageshow", () => dispatchRouteChange("pageshow"), true);
})();
