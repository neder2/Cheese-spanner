/** 전체 방송의 현재 활성 목록만 사이트 QueryClient로 다시 조회한다. MAIN, 권한·직접 요청 없음. */
(() => {
    const FLAG = "__cheeseSpannerLiveListRefreshInstalled";
    const ID = "cheese-spanner-live-list-refresh";
    if (window[FLAG]) return;
    window[FLAG] = true;
    let button = null;
    let anchor = null;
    let frame = 0;
    let observer = null;
    let generation = 0;
    let busy = false;
    let cooldown = 0;

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

    async function refresh() {
        if (busy || location.pathname !== "/lives" || !anchor?.isConnected) return;
        const current = button;
        const token = generation;
        busy = true;
        current.disabled = true;
        current.setAttribute("data-refreshing", "1");
        cooldown = window.setTimeout(() => {
            cooldown = 0;
            if (token === generation) {
                busy = false;
                current.disabled = false;
                current.removeAttribute("data-refreshing");
            }
        }, 1000);
        try {
            const client = getClient(anchor);
            const queries = client
                ?.getQueryCache()
                .findAll({ type: "active" })
                .filter(
                    (query) =>
                        Array.isArray(query.queryKey) &&
                        query.queryKey.length === 3 &&
                        query.queryKey[0] === "all-lives"
                );
            if (queries?.length !== 1) throw new Error("Current live list unavailable");
            await client.refetchQueries(
                { queryKey: queries[0].queryKey, exact: true, type: "active" },
                { throwOnError: true, cancelRefetch: false }
            );
            if (token !== generation || location.pathname !== "/lives" || !current.isConnected) return;
            window.dispatchEvent(new CustomEvent("cheese-spanner:live-list-refreshed"));
            current.title = "방송 목록을 새로 불러왔습니다";
        } catch (_) {
            if (token === generation && current.isConnected) {
                current.title = "목록을 새로 불러오지 못했습니다. 다시 시도해 주세요";
            }
        }
    }

    function remove() {
        generation++;
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
            button.title = "현재 정렬로 방송 목록과 시청자 수를 다시 불러옵니다";
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
            if (records.some((record) => !button?.contains(record.target))) schedule();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        schedule();
    }

    window.addEventListener("cheese-spanner:routechange", syncRoute);
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
