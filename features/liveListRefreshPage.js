/** 전체 방송의 현재 활성 목록만 사이트 QueryClient로 다시 조회한다. MAIN, 권한·직접 요청 없음. */
(() => {
    const FLAG = "__cheeseSpannerLiveListRefreshInstalled";
    const ID = "cheese-spanner-live-list-refresh";
    const LABEL = "현재 정렬 기준으로 방송 목록과 시청자 수 새로고침";
    const SORT_SELECTOR = ':is(#POPULAR, #LATEST, #RECOMMEND)[role="tab"]';
    if (window[FLAG]) return;
    window[FLAG] = true;
    let button = null;
    let anchor = null;
    let frame = 0;
    let observer = null;
    let generation = 0;
    let busy = false;
    let cooldown = 0;
    let listRevision = 0;
    let stopQueryWatch = null;

    // 2026-11-08 공개 index-BcgE118t.js: all-lives, [queryName, routeKey, filters].
    // QueryClientProvider의 client를 현재 정렬 버튼의 조상에서만 찾는다.
    function getClient(node) {
        const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactFiber$"));
        let fiber = key ? node[key] : null;
        for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
            const client = fiber.memoizedProps?.client;
            if (typeof client?.getQueryCache === "function" && typeof client.refetchQueries === "function")
                return client;
        }
        return null;
    }

    function activeListQuery(cache) {
        const matches = cache
            ?.findAll({ type: "active" })
            .filter(
                (query) =>
                    Array.isArray(query.queryKey) && query.queryKey.length === 3 && query.queryKey[0] === "all-lives"
            );
        return matches?.length === 1 ? matches[0] : null;
    }

    function queryIdentity(query) {
        return query ? (query.queryHash ?? JSON.stringify(query.queryKey)) : "";
    }

    function selectedSort() {
        return anchor?.closest('[role="tablist"]')?.querySelector(`${SORT_SELECTOR}[aria-selected="true"]`)?.id;
    }

    function clearRefreshFeedback() {
        listRevision++;
        stopQueryWatch?.();
        stopQueryWatch = null;
        if (button) button.title = LABEL;
    }

    function onSortClick(event) {
        const sort = event.target.closest?.(SORT_SELECTOR);
        if (
            sort &&
            anchor?.closest('[role="tablist"]') === sort.closest('[role="tablist"]') &&
            sort.id !== selectedSort()
        )
            clearRefreshFeedback();
    }

    async function refresh() {
        if (busy || location.pathname !== "/lives" || !anchor?.isConnected) return;
        clearRefreshFeedback();
        const current = button;
        const token = generation;
        const listToken = listRevision;
        const sort = selectedSort();
        let stillActive = () => true;
        const canReport = () =>
            token === generation &&
            listToken === listRevision &&
            sort === selectedSort() &&
            location.pathname === "/lives" &&
            current.isConnected &&
            stillActive();
        let settled = false;
        const release = () => {
            if (token !== generation || !settled || cooldown) return;
            busy = false;
            current.disabled = false;
            current.removeAttribute("data-refreshing");
        };
        busy = true;
        current.disabled = true;
        current.setAttribute("data-refreshing", "1");
        cooldown = window.setTimeout(() => {
            cooldown = 0;
            release();
        }, 1000);
        try {
            const client = getClient(anchor);
            const cache = client?.getQueryCache();
            const query = activeListQuery(cache);
            if (!query) throw new Error("Current live list unavailable");
            const identity = queryIdentity(query);
            stillActive = () => {
                try {
                    return queryIdentity(activeListQuery(cache)) === identity;
                } catch (_) {
                    return false;
                }
            };
            // The displayed result still belongs to this query after the request settles.
            stopQueryWatch = cache.subscribe?.((event) => {
                if (token !== generation || listToken !== listRevision) return;
                if (!["observerAdded", "observerRemoved", "observerOptionsUpdated"].includes(event?.type)) return;
                if (event.query && event.query.queryKey?.[0] !== "all-lives") return;
                if (!stillActive()) clearRefreshFeedback();
            });
            await client.refetchQueries(
                { queryKey: query.queryKey, exact: true, type: "active" },
                { throwOnError: true, cancelRefetch: false }
            );
            if (!canReport()) return;
            current.title = "방송 목록 새로고침 완료";
            window.dispatchEvent(new CustomEvent("cheese-spanner:live-list-refreshed"));
        } catch (_) {
            if (canReport()) {
                current.title = "방송 목록 새로고침 실패. 다시 시도";
            }
        } finally {
            settled = true;
            release();
        }
    }

    function remove() {
        generation++;
        clearRefreshFeedback();
        if (cooldown) clearTimeout(cooldown);
        cooldown = 0;
        busy = false;
        button?.remove();
        button = anchor = null;
    }

    function mount() {
        frame = 0;
        if (location.pathname !== "/lives") return;
        const next = document.querySelector('button#RECOMMEND[role="tab"]');
        const group = next?.closest('[role="tablist"]');
        if (!next || !group?.querySelector("button#POPULAR") || !group.querySelector("button#LATEST")) {
            if (button) remove();
            return;
        }
        if (anchor !== next) remove();
        anchor = next;
        if (!button) {
            if (!document.getElementById(`${ID}-style`)) {
                const style = document.createElement("style");
                style.id = `${ID}-style`;
                style.textContent = `
                    #${ID}{display:inline-flex;align-items:center;gap:4px;margin-left:8px;vertical-align:middle}
                    #${ID} svg{width:14px;height:14px;flex:none}
                    #${ID}[data-refreshing="1"] svg{animation:cheese-spanner-list-refresh-spin 1s linear infinite}
                    @keyframes cheese-spanner-list-refresh-spin{to{transform:rotate(360deg)}}
                    @media(prefers-reduced-motion:reduce){#${ID}[data-refreshing="1"] svg{animation:none}}
                `;
                document.head.appendChild(style);
            }
            button = document.createElement("button");
            button.id = ID;
            button.type = "button";
            button.innerHTML =
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 7a8 8 0 0 1 13 0L20 12M4 12l1.5 5a8 8 0 0 0 13 0"/></svg><span>새로고침</span>';
            button.setAttribute("aria-label", "방송 목록 새로고침");
            button.title = LABEL;
            button.addEventListener("click", refresh);
        }
        // 원본 정렬 버튼의 스타일을 따르되 선택 상태와 tab 역할은 복제하지 않는다.
        if (button.className !== next.className) button.className = next.className;
        if (next.nextSibling !== button) next.after(button);
    }

    function schedule() {
        if (!frame) frame = requestAnimationFrame(mount);
    }

    function syncRoute() {
        observer?.disconnect();
        observer = null;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        remove();
        if (location.pathname !== "/lives" || !document.body) return;
        observer = new MutationObserver((records) => {
            if (
                records.some(
                    (record) =>
                        record.type === "attributes" &&
                        record.target.matches(SORT_SELECTOR) &&
                        anchor?.closest('[role="tablist"]')?.contains(record.target) &&
                        record.oldValue !== record.target.getAttribute("aria-selected")
                )
            )
                clearRefreshFeedback();
            if (records.some((record) => record.type === "childList" && !button?.contains(record.target))) schedule();
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributeFilter: ["aria-selected"],
            attributeOldValue: true,
        });
        schedule();
    }

    window.addEventListener("cheese-spanner:routechange", syncRoute);
    document.addEventListener("click", onSortClick, true);
    window.addEventListener("pagehide", () => {
        observer?.disconnect();
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        remove();
    });
    window.addEventListener("pageshow", syncRoute);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", syncRoute, { once: true });
    else syncRoute();
})();
