/**
 * features/routeBridgePage.js — SPA 라우트 변경을 감지해 페이지 컨텍스트 전역에 이벤트로 알린다.
 *
 * 실행 컨텍스트: MAIN world(페이지) — content_scripts에서 document_start에 로드된다.
 * 동작 위치: https://chzzk.naver.com/* 전체(모든 라우트).
 * 하는 일: history.pushState/replaceState를 래핑하고 popstate/hashchange/pageshow를 수신해
 *   location.href 변경을 감지한다. 변경이 감지되면 window에 CustomEvent를 디스패치한다.
 *   같은 스크립트가 중복 실행되는 것을 INSTALL_FLAG로 막는다.
 *   팔로잉 보충 행의 이동 요청은 현재 사이드바의 React Router navigator에 전달한다.
 * 의존: window.history, DOM 이벤트, 이동 요청 시 현재 React Router의 NavigationContext.
 * 통신: window에 CustomEvent betterchzzk:routechange를 detail: { href, source } 형태로 디스패치한다.
 *   같은 MAIN world의 features/autoQualityPage.js와, isolated world의 content.js(BetterChzzk.utils의
 *   라우트 변경 감지)가 각각 이 이벤트를 window addEventListener로 직접 수신한다.
 *   sidebarCustomization.js는 링크에서 betterchzzk:following-navigate를 보내며, 처리 성공 시 취소로 응답한다.
 */
(() => {
    const INSTALL_FLAG = "__betterChzzkRouteBridgeInstalled";
    const EVENT_NAME = "betterchzzk:routechange";
    const WRAP_FLAG = "__betterChzzkRouteBridgeWrapped";
    const WRAP_NATIVE = "__betterChzzkRouteBridgeNative";
    const FOLLOWING_NAVIGATE_EVENT = "betterchzzk:following-navigate";

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

    function getSidebarNavigator(sidebar) {
        const key = Object.getOwnPropertyNames(sidebar).find((name) => name.startsWith("__reactFiber$"));
        let fiber = key ? sidebar[key] : null;
        // 2026-09-05 치지직 common-vendor-C8-rxCMl.js의 NavigationContext:
        // { basename, navigator }. push/replace는 history 갱신과 라우터 통지를 함께 처리한다.
        for (let depth = 0; fiber && depth < 100; depth += 1, fiber = fiber.return) {
            const value = fiber.memoizedProps?.value;
            const navigator = value?.navigator;
            if (
                value?.basename === "/" &&
                typeof navigator?.push === "function" &&
                typeof navigator.replace === "function" &&
                typeof navigator.go === "function" &&
                typeof navigator.createHref === "function"
            ) {
                return navigator;
            }
        }
        return null;
    }

    function handleFollowingNavigate(event) {
        const link = event.target;
        if (event.defaultPrevented || !event.cancelable || !(link instanceof HTMLAnchorElement)) return;
        const sidebar = document.getElementById("sidebar");
        const row = link.closest('[data-bcsf-source-row="1"]');
        if (
            !sidebar?.contains(link) ||
            !row ||
            row.closest('[data-bcsf-pin-mode="1"]') ||
            (link.target && link.target !== "_self") ||
            link.hasAttribute("download")
        ) {
            return;
        }
        const channelId = row.getAttribute("data-bcsf-channel-id");
        if (!channelId) return;
        try {
            const url = new URL(link.getAttribute("href"), location.origin);
            const channelPath = `/${encodeURIComponent(channelId)}`;
            if (
                url.origin !== location.origin ||
                (url.pathname !== channelPath && url.pathname !== `/live${channelPath}`)
            ) {
                return;
            }
            const navigator = getSidebarNavigator(sidebar);
            if (!navigator) return;
            const method = url.href === location.href ? "replace" : "push";
            navigator[method]({ pathname: url.pathname, search: url.search, hash: url.hash });
            event.preventDefault();
        } catch (error) {
            console.warn("[Better Chzzk] 팔로잉 채널 페이지 내부 이동 실패", error);
        }
    }

    function handleMultiviewNavigate(event) {
        const link = event.target;
        if (event.defaultPrevented || !event.cancelable || !(link instanceof HTMLAnchorElement)) return;
        if (
            !link.closest("#betterchzzk-multiview") ||
            link.dataset.action !== "main" ||
            (link.target && link.target !== "_self") ||
            link.hasAttribute("download")
        )
            return;
        const channelId = link.dataset.channel;
        if (!/^[a-f0-9]{32}$/.test(channelId || "")) return;
        try {
            const url = new URL(link.getAttribute("href"), location.origin);
            if (url.origin !== location.origin || url.pathname !== "/live/" + channelId || url.search || url.hash)
                return;
            const sidebar = document.getElementById("sidebar");
            if (!sidebar) return;
            const navigator = getSidebarNavigator(sidebar);
            if (!navigator) return;
            navigator.push({ pathname: url.pathname, search: "", hash: "" });
            event.preventDefault();
        } catch (error) {
            console.warn("[Better Chzzk] 멀티뷰 방송 이동 실패", error);
        }
    }

    wrapHistoryMethod("pushState");
    wrapHistoryMethod("replaceState");
    window.addEventListener("popstate", () => dispatchRouteChange("popstate"), true);
    window.addEventListener("hashchange", () => dispatchRouteChange("hashchange"), true);
    window.addEventListener("pageshow", () => dispatchRouteChange("pageshow"), true);
    window.addEventListener(FOLLOWING_NAVIGATE_EVENT, handleFollowingNavigate, true);
    window.addEventListener("betterchzzk:multiview-navigate", handleMultiviewNavigate, true);
})();
