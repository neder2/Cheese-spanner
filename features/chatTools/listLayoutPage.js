/** 문구 숨김으로 빠진 행만큼 네이티브 채팅 목록의 표시 개수를 보충한다. MAIN, DOM 요청 전용. */
(() => {
    "use strict";
    const FLAG = "CheeseSpannerChatListLayoutInstalled";
    if (window[FLAG]) return;
    window[FLAG] = true;

    const REQUEST = "cheese-spanner:chat-list-layout-request";
    const COUNT_ATTR = "data-bcct-hidden-count";
    const MAX_MESSAGES = 500;
    // The 2026-11-11 and 2026-11-12 bundles use ceil(content height / 31), including chat scaling.
    const ROW_HEIGHT = 31;
    const states = new WeakMap();
    const own = (object, key) =>
        object && typeof object === "object" ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;

    function getList(target) {
        if (!(target instanceof HTMLElement) || !target.isConnected) return null;
        const selector = /^\/live\/[^/]+(?:\/(?:chat|simple))?\/?$/.test(location.pathname)
            ? 'aside#aside-chatting [role="log"] > [class*="_wrapper_"]'
            : /^\/video\/\d+\/?$/.test(location.pathname)
              ? 'aside#vod-aside [role="log"] > [class*="_list_"]'
              : "";
        return selector && target.matches(selector) && target.querySelector(':scope > [class*="_list_bottom_"]')
            ? target
            : null;
    }

    function isCurrent(fiber) {
        const seen = new Set();
        for (let node = fiber; node && seen.size < 80; node = own(node, "return")) {
            if (seen.has(node)) return false;
            seen.add(node);
            if (own(node, "tag") === 3) return own(own(node, "stateNode"), "current") === node;
        }
        return false;
    }

    function getCurrentFiber(list) {
        for (const name of Object.getOwnPropertyNames(list)) {
            if (!name.startsWith("__reactFiber$")) continue;
            const fiber = own(list, name);
            const candidates = [fiber, own(fiber, "alternate")].filter(
                (candidate) => candidate && own(candidate, "stateNode") === list && isCurrent(candidate)
            );
            if (candidates.length === 1) return candidates[0];
        }
        return null;
    }

    function getHooks(fiber) {
        const hooks = [];
        const seen = new Set();
        for (let hook = own(fiber, "memoizedState"); hook; hook = own(hook, "next")) {
            if (seen.has(hook) || hooks.length >= 512) return [];
            seen.add(hook);
            hooks.push(hook);
        }
        return hooks;
    }

    function getBinding(list) {
        const seen = new Set();
        for (let fiber = getCurrentFiber(list); fiber && seen.size < 12; fiber = own(fiber, "return")) {
            if (seen.has(fiber)) return null;
            seen.add(fiber);
            const hooks = getHooks(fiber);
            if (!hooks.some((hook) => own(own(hook, "memoizedState"), "current") === list)) continue;
            const stateHooks = hooks.filter((hook) => typeof own(own(hook, "queue"), "dispatch") === "function");
            const bindings = [];
            // Both measured components keep [backlog, row limit, paused] on their slice effect.
            // Match references and a unique numeric state, never a positional hook index.
            for (const hook of hooks) {
                const effect = own(hook, "memoizedState");
                const deps = own(effect, "deps");
                if (!Array.isArray(deps) || deps.length !== 3 || typeof own(effect, "create") !== "function") continue;
                const [messages, limit, paused] = deps;
                if (
                    !Array.isArray(messages) ||
                    messages.length > MAX_MESSAGES ||
                    !Number.isSafeInteger(limit) ||
                    limit <= 0 ||
                    limit > MAX_MESSAGES ||
                    typeof paused !== "boolean" ||
                    !messages.every((message) => typeof own(message, "key") === "string") ||
                    !stateHooks.some((state) => own(state, "memoizedState") === messages)
                )
                    continue;
                const limitHooks = stateHooks.filter((state) => own(state, "memoizedState") === limit);
                if (limitHooks.length !== 1) continue;
                const renderedLength = paused ? messages.length : Math.min(limit, messages.length);
                const rendered = stateHooks.some((state) => {
                    const rows = own(state, "memoizedState");
                    return (
                        Array.isArray(rows) &&
                        (rows !== messages || paused) &&
                        rows.length === renderedLength &&
                        rows.every((message, index) => message === messages[index])
                    );
                });
                if (!rendered) continue;
                bindings.push({
                    limit,
                    paused,
                    size: messages.length,
                    dispatch: own(own(limitHooks[0], "queue"), "dispatch"),
                });
            }
            // An unrecognized owner must not fall through to an unrelated ancestor's state.
            return bindings.length === 1 ? bindings[0] : null;
        }
        return null;
    }

    function sync(event) {
        const list = getList(event.target);
        if (!list) return;
        const raw = list.getAttribute(COUNT_ATTR);
        const previous = states.get(list);
        if (raw === null && !previous) return;
        if (raw !== null && !/^[1-9]\d{0,2}$/.test(raw)) return;
        const hidden = raw === null ? 0 : Number(raw);
        if (hidden > MAX_MESSAGES) return;
        const style = getComputedStyle(list);
        const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
        const borders = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
        const styledHeight = parseFloat(style.height);
        const height = Number.isFinite(styledHeight)
            ? styledHeight - (style.boxSizing === "border-box" ? padding + borders : 0)
            : list.clientHeight - padding;
        const base = Math.ceil(height / ROW_HEIGHT);
        if (base <= 0 || base > MAX_MESSAGES) return;
        const binding = getBinding(list);
        if (!binding || (binding.paused && hidden > 0)) return;
        const { limit, dispatch } = binding;
        const owned = previous?.dispatch === dispatch ? previous : null;
        if (!owned && (hidden === 0 || limit !== base)) return;
        const wanted = Math.max(base, Math.min(base + hidden, binding.size, MAX_MESSAGES));
        if (owned?.wanted === wanted && owned.observed === limit) return;
        states.set(list, { dispatch, wanted, observed: limit });
        // A restore also cancels a previous request that React has not committed yet.
        if (limit !== wanted || (owned && owned.wanted !== wanted && owned.observed === limit)) dispatch(wanted);
    }

    document.addEventListener(REQUEST, (event) => {
        try {
            sync(event);
        } catch (_) {
            // Native ownership can change during a render; leave an unknown list alone.
        }
    });
    window.dispatchEvent(new Event("cheese-spanner:chat-list-layout-page-ready"));
})();
