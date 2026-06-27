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
