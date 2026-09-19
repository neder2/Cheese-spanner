/** Collect only current user's confirmed live chat rows; persistence belongs to liveWatchHistory. */
(() => {
    "use strict";

    const root = (window.BetterChzzk = window.BetterChzzk || {});
    if (root.watchActivity) return;
    const { createMutationObserverSync, fetchJson, getLiveChannelIdFromPath } = root.utils;
    const USER_URL = "https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus";
    const LOG_SELECTOR = "aside#aside-chatting [role='log']";
    const ROW_SELECTOR = ":scope > [class*='_wrapper_'] > [class*='_item_']";
    const REQUEST_EVENT = "betterchzzk:watch-activity-source";
    const READY_EVENT = "betterchzzk:watch-activity-ready";
    const SOURCE_ATTR = "data-bcwa-source";
    const USER_ATTR = "data-bcwa-user";

    function createCollector(onActivity) {
        let config = null;
        let configKey = "";
        let observer = null;
        let controller = null;
        let generation = 0;
        let userId = "";
        let log = null;
        let scheduled = false;
        const dirtyRows = new Set();

        function processRows() {
            scheduled = false;
            const rows = Array.from(dirtyRows);
            dirtyRows.clear();
            if (!config || !userId || getLiveChannelIdFromPath() !== config.channelId) return;
            for (const row of rows) {
                if (!row.isConnected || !log?.contains(row)) continue;
                row.setAttribute(USER_ATTR, userId);
                row.dispatchEvent(new Event(REQUEST_EVENT, { bubbles: true }));
                const source = row.getAttribute(SOURCE_ATTR);
                row.removeAttribute(SOURCE_ATTR);
                row.removeAttribute(USER_ATTR);
                if (!source || source.length > 4000) continue;
                try {
                    const activity = JSON.parse(source);
                    if (!Number.isSafeInteger(activity.at) || activity.at < config.since) continue;
                    if (activity.kind === "chat" ? !config.chat : activity.kind !== "donation" || !config.donations)
                        continue;
                    onActivity(activity, config.channelId);
                } catch (_) {
                    // Missing/invalid source data is not a recorded activity.
                }
            }
        }

        function schedule() {
            if (scheduled) return;
            scheduled = true;
            queueMicrotask(processRows);
        }

        function findRow(node) {
            let element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
            while (element && element !== log) {
                if (element.parentElement?.parentElement === log && element.matches("[class*='_item_']"))
                    return element;
                element = element.parentElement;
            }
            return null;
        }

        function scan() {
            if (!log || !userId) return;
            for (const row of log.querySelectorAll(ROW_SELECTOR)) dirtyRows.add(row);
            schedule();
        }

        async function identifyUser() {
            if (!config) return;
            controller?.abort();
            controller = new AbortController();
            const currentGeneration = ++generation;
            userId = "";
            try {
                const json = await fetchJson(USER_URL, {
                    credentials: "include",
                    signal: controller.signal,
                    timeoutMs: 8000,
                });
                if (!config || currentGeneration !== generation) return;
                const user = json?.content;
                if (
                    json.code !== 200 ||
                    user?.loggedIn !== true ||
                    !/^[A-Za-z0-9_-]{1,128}$/.test(user.userIdHash || "")
                )
                    return;
                userId = user.userIdHash;
                scan();
            } catch (_) {
                // Authentication or network failure leaves collection inactive.
            }
        }

        function handleIdentityChange(event) {
            if (event.type === "storage" && event.key !== "userStatus.idhash") return;
            if (event.type === "visibilitychange" && document.hidden) return;
            void identifyUser();
        }

        function stop() {
            config = null;
            configKey = "";
            generation += 1;
            controller?.abort();
            controller = null;
            observer?.disconnectAll();
            observer = null;
            log = null;
            userId = "";
            dirtyRows.clear();
            window.removeEventListener(READY_EVENT, scan);
            window.removeEventListener("storage", handleIdentityChange);
            document.removeEventListener("visibilitychange", handleIdentityChange);
        }

        function configure(next) {
            const enabled = next?.channelId && (next.chat || next.donations);
            const key = JSON.stringify(next);
            if (enabled && key === configKey) return;
            stop();
            if (!enabled) return;
            config = { ...next, since: Math.max(next.since || 0, Date.now()) };
            configKey = key;
            observer = createMutationObserverSync({
                target: () => document.querySelector(LOG_SELECTOR),
                options: { childList: true, subtree: true, characterData: true },
                onObserved: (_observer, target) => {
                    log = target;
                    scan();
                },
                onMutations: (mutations) => {
                    for (const mutation of mutations) {
                        const row = findRow(mutation.target);
                        if (row) dirtyRows.add(row);
                        for (const node of mutation.addedNodes || []) {
                            const addedRow = findRow(node);
                            if (addedRow) dirtyRows.add(addedRow);
                            else if (node.nodeType === Node.ELEMENT_NODE) {
                                for (const candidate of node.querySelectorAll("[class*='_item_']")) {
                                    const nestedRow = findRow(candidate);
                                    if (nestedRow) dirtyRows.add(nestedRow);
                                }
                            }
                        }
                    }
                    schedule();
                },
            });
            window.addEventListener(READY_EVENT, scan);
            window.addEventListener("storage", handleIdentityChange);
            document.addEventListener("visibilitychange", handleIdentityChange);
            void identifyUser();
        }

        return { configure, stop };
    }

    root.watchActivity = { createCollector };
})();
