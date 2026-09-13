/** 카테고리 자동 탐색의 실행·대기 수명주기. 화면은 탐색 조건과 스크롤 여유만 전달한다. */
(() => {
    const root = (globalThis.BetterChzzk = globalThis.BetterChzzk || {});
    const { routeKey } = root.categoryToolsRepository;
    const METADATA_APPLY_INTERVAL_MS = 260;
    const METADATA_BATCH_PAGES = 2;
    const AUTO_LOAD_APPLY_SETTLE_MS = 250;

    function createSearchController({ repository, onApply, onLoading, isRouteCurrent, hasScrollRoom }) {
        let requested = null;
        let running = null;
        let lastMetadataApplyAt = 0;
        const waits = new Map();

        function wait(delayMs) {
            return new Promise((resolve) => {
                const timer = setTimeout(() => {
                    waits.delete(timer);
                    resolve();
                }, delayMs);
                waits.set(timer, resolve);
            });
        }

        function isCurrent(request) {
            return requested === request && isRouteCurrent(request.route);
        }

        function canLoad(request) {
            const state = repository.metadataState();
            return (
                isCurrent(request) &&
                !state.complete &&
                state.pagesLoaded < request.maxPages &&
                !repository.isMetadataRetryCoolingDown(routeKey(request.route))
            );
        }

        async function run(request) {
            onLoading(true);
            try {
                await repository.ensureMetadata(request.route);
                let pagesThisRun = 0;
                while (canLoad(request)) {
                    if (pagesThisRun >= METADATA_BATCH_PAGES) {
                        onApply();
                        await wait(AUTO_LOAD_APPLY_SETTLE_MS);
                        if (!isCurrent(request) || hasScrollRoom()) break;
                    }
                    if (!repository.metadataState().next) break;
                    await repository.loadNextMetadata(request.route);
                    if (!isCurrent(request)) break;
                    pagesThisRun++;
                    const now = performance.now();
                    if (now - lastMetadataApplyAt >= METADATA_APPLY_INTERVAL_MS) {
                        lastMetadataApplyAt = now;
                        onApply();
                    }
                    await wait(request.pageDelayMs);
                }
                if (isCurrent(request)) onApply();
            } finally {
                if (requested === request) onLoading(false);
            }
        }

        function start() {
            if (running || !requested) return;
            const request = requested;
            running = request;
            void run(request).finally(() => {
                if (running !== request) return;
                running = null;
                if (requested && requested !== request) start();
            });
        }

        function request(route, { maxPages, pageDelayMs }) {
            const state = repository.metadataState();
            if (
                !route ||
                state.complete ||
                state.pagesLoaded >= maxPages ||
                repository.isMetadataRetryCoolingDown(routeKey(route))
            ) {
                return;
            }
            if (
                running &&
                requested &&
                routeKey(requested.route) === routeKey(route) &&
                requested.maxPages === maxPages &&
                requested.pageDelayMs === pageDelayMs
            )
                return;
            requested = { route, maxPages, pageDelayMs };
            start();
        }

        function cancel() {
            requested = null;
            running = null;
            for (const [timer, resolve] of waits) {
                clearTimeout(timer);
                resolve();
            }
            waits.clear();
            onLoading(false);
        }

        function reset() {
            cancel();
            lastMetadataApplyAt = 0;
        }

        return Object.freeze({ request, cancel, reset, isRunning: () => Boolean(running) });
    }

    root.categoryToolsSearchController = Object.freeze({ createSearchController });
})();
