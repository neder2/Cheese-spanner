/** Collect only current user's confirmed live chat rows; persistence belongs to liveWatchHistory. */
(() => {
    "use strict";

    const root = (window.CheeseSpanner = window.CheeseSpanner || {});
    if (root.watchActivity) return;
    const { createMutationObserverSync, fetchJson, getLiveChannelIdFromPath } = root.utils;
    const USER_URL = "https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus";
    const LOG_SELECTOR = "aside#aside-chatting [role='log']";
    const ROW_SELECTOR = ":scope > [class*='_wrapper_'] > [class*='_item_']";
    const REQUEST_EVENT = "cheese-spanner:watch-activity-source";
    const READY_EVENT = "cheese-spanner:watch-activity-ready";
    const SOURCE_ATTR = "data-bcwa-source";
    const USER_ATTR = "data-bcwa-user";
    // Set by watchActivityPage.js once its MAIN-world reader listens; before that every read is empty.
    const BRIDGE_READY_ATTR = "data-cheese-spanner-watch-activity-page-ready";
    // Collection stays off while the account is unconfirmed; a failed check is retried a few times, not trusted.
    const IDENTITY_RETRY_DELAYS_MS = [2000, 10000, 30000, 60000];
    // Message identities are kept in memory only, within these bounds. The retired set holds the identities carried
    // from earlier channels plus those read at the move, so it is larger than the per-channel observation sets.
    const RETIRED_ID_LIMIT = 2000;
    const OBSERVED_ID_LIMIT = 500;
    // Reads the rows left at a move when no account was confirmed: it matches nobody, so the reader reports every
    // readable message as another author's together with its identity, never its content.
    const BASELINE_ONLY_USER = "-cheese-spanner-baseline-";

    function createCollector(onActivity) {
        let config = null;
        let configKey = "";
        let observer = null;
        let controller = null;
        let generation = 0;
        let userId = "";
        // The last account confirmed in this document. It survives stop() only to recognize the previous channel's
        // messages at the next channel's start; collection always waits for a fresh check of the account.
        let lastConfirmedUserId = "";
        let log = null;
        let scheduled = false;
        let identityRetryTimer = 0;
        let identityRetries = 0;
        const dirtyRows = new Set();
        // Messages already in the log when this channel's collection began can belong to the previous channel after
        // an SPA move. They are retired by message identity, not by DOM node, because React reuses rows for new
        // messages. Their server times mark the boundary, so a later redraw of an older message is not taken either.
        let retiredIds = new Set();
        let baselineAt = 0;
        let baselineChannelId = "";
        // Every message identity in the log at the move is retired whoever wrote it, so the previous channel's
        // messages stay out by identity even when React redraws them as new nodes before the next account check
        // answers, and even when that check confirms a different account than the one the rows were read for.
        // The DOM at the move is not the only source: the identities the collector already read on the previous
        // channel (own messages collected or not, and other authors' messages) and the latest own message time are
        // carried into the next channel's retired set and boundary. A message the collector once read stays out even
        // when its row is unreadable at the move and React redraws it as a new node before that row reads again.
        // Rows present at the move whose message could not be placed are held by node: unread rows (no reader
        // yet), rows the reader could not read (an own message whose React data is briefly missing reads the same
        // way), another author's rows without an identity (their fields can still fill in), and, without a confirmed
        // account, every row. A row's content can change for the same message, so such a row stays apart until its
        // first own readable message, which is retired and never collected. That message is lost when React reuses
        // the row for the user's genuinely new chat first; mixing the previous channel's chat in is the worse error.
        // Left only to the since check: a message never read before the move, newer than every own message read
        // before it, unreadable at the move, and redrawn as a new node before its held row reads.
        let pendingBaselineRows = new WeakSet();
        // Identities read on the current channel, carried to the next channel at a move; they survive stop().
        let observedOwnIds = new Set();
        let observedOtherIds = new Set();
        let observedOwnAt = 0;

        // Returns the user's activity, { otherAuthor, id } when the reader confirmed another author's message (id is
        // its identity in activity-ID form, empty when the fields read do not form one yet), or null
        // when nothing could be read (no reader, no React data, or the user's message in a state that is not
        // collected).
        function readRow(row, user) {
            row.setAttribute(USER_ATTR, user);
            row.dispatchEvent(new Event(REQUEST_EVENT, { bubbles: true }));
            const source = row.getAttribute(SOURCE_ATTR);
            row.removeAttribute(SOURCE_ATTR);
            row.removeAttribute(USER_ATTR);
            if (!source || source.length > 4000) return null;
            try {
                const activity = JSON.parse(source);
                if (activity?.otherAuthor === true)
                    return { otherAuthor: true, id: typeof activity.id === "string" ? activity.id : "" };
                return Number.isSafeInteger(activity?.at) && typeof activity.id === "string" ? activity : null;
            } catch (_) {
                // Missing/invalid source data is not a recorded activity.
                return null;
            }
        }

        // Keeps the newest identities: one already present moves to the newest end, the oldest leaves at the limit.
        function remember(set, id, limit) {
            set.delete(id);
            set.add(id);
            if (set.size > limit) set.delete(set.values().next().value);
        }

        function retireId(id) {
            remember(retiredIds, id, RETIRED_ID_LIMIT);
        }

        // Reads the row for the confirmed account and remembers the message identity for the next channel's baseline.
        function readActivity(row, user) {
            const result = readRow(row, user);
            if (result?.otherAuthor) {
                if (result.id) remember(observedOtherIds, result.id, OBSERVED_ID_LIMIT);
                return null;
            }
            if (result) {
                remember(observedOwnIds, result.id, OBSERVED_ID_LIMIT);
                observedOwnAt = Math.max(observedOwnAt, result.at);
            }
            return result;
        }

        function retire(activity) {
            retireId(activity.id);
            baselineAt = Math.max(baselineAt, activity.at);
        }

        // Sorts a row present at the move by what the reader returns for the previous channel's account, if any.
        // Another author's message is retired by identity only: its time does not move the own-message boundary.
        // Another author's message without an identity is held like an unreadable row.
        function classifyBaselineRow(row, user, readable) {
            const result = readable ? readRow(row, user || BASELINE_ONLY_USER) : null;
            if (result?.otherAuthor && result.id) {
                retireId(result.id);
                // Without a confirmed account "another author" can still be the user's own message.
                if (user) return;
            } else if (result && !result.otherAuthor) {
                retire(result);
                return;
            }
            pendingBaselineRows.add(row);
        }

        function processRows() {
            scheduled = false;
            // Baseline rows set the boundary before any newer row of the same pass is judged.
            const rows = Array.from(dirtyRows).sort((a, b) => pendingBaselineRows.has(b) - pendingBaselineRows.has(a));
            dirtyRows.clear();
            if (!config || !userId || getLiveChannelIdFromPath() !== config.channelId) return;
            for (const row of rows) {
                if (!row.isConnected || !log?.contains(row)) continue;
                const activity = readActivity(row, userId);
                if (pendingBaselineRows.has(row)) {
                    if (activity) {
                        pendingBaselineRows.delete(row);
                        retire(activity);
                    }
                    continue;
                }
                if (!activity || retiredIds.has(activity.id)) continue;
                if (activity.at < config.since || activity.at <= baselineAt) continue;
                if (activity.kind === "chat" ? !config.chat : activity.kind !== "donation" || !config.donations)
                    continue;
                onActivity(activity, config.channelId);
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

        function clearIdentityRetry() {
            if (identityRetryTimer) clearTimeout(identityRetryTimer);
            identityRetryTimer = 0;
        }

        function scheduleIdentityRetry(currentGeneration) {
            if (identityRetries >= IDENTITY_RETRY_DELAYS_MS.length) return;
            identityRetryTimer = setTimeout(() => {
                identityRetryTimer = 0;
                if (config && currentGeneration === generation) void identifyUser({ retry: true });
            }, IDENTITY_RETRY_DELAYS_MS[identityRetries++]);
        }

        async function identifyUser({ retry = false } = {}) {
            if (!config) return;
            clearIdentityRetry();
            if (!retry) identityRetries = 0;
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
                if (json?.code !== 200) {
                    scheduleIdentityRetry(currentGeneration);
                    return;
                }
                // A logged-out answer is definite; a later account change signal checks again.
                if (user?.loggedIn !== true || !/^[A-Za-z0-9_-]{1,128}$/.test(user.userIdHash || "")) return;
                userId = user.userIdHash;
                lastConfirmedUserId = userId;
                identityRetries = 0;
                scan();
            } catch (_) {
                // A newer check or stop owns the generation; only this check's own failure is retried.
                if (config && currentGeneration === generation) scheduleIdentityRetry(currentGeneration);
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
            clearIdentityRetry();
            identityRetries = 0;
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
            // The account confirmed for the previous channel only marks messages as old; it never collects. The owner
            // stops the collector before the next channel starts, so the account is kept apart from userId.
            const previousUserId = userId || lastConfirmedUserId;
            stop();
            if (!enabled) return;
            config = { ...next, since: Math.max(next.since || 0, Date.now()) };
            configKey = key;
            if (config.channelId !== baselineChannelId) {
                // The first channel of the document has no previous channel whose rows could be left in the log.
                const moved = Boolean(baselineChannelId);
                baselineChannelId = config.channelId;
                // Carried oldest first, so the limit drops earlier channels' identities before the last channel's.
                const carried = [...retiredIds, ...observedOtherIds, ...observedOwnIds];
                retiredIds = new Set();
                for (const id of carried) retireId(id);
                baselineAt = Math.max(baselineAt, observedOwnAt);
                observedOwnIds = new Set();
                observedOtherIds = new Set();
                observedOwnAt = 0;
                pendingBaselineRows = new WeakSet();
                // Without a listening reader an empty read says nothing about the row.
                const readable = document.documentElement.hasAttribute(BRIDGE_READY_ATTR);
                const rows = moved ? document.querySelector(LOG_SELECTOR)?.querySelectorAll(ROW_SELECTOR) : null;
                for (const row of rows || []) classifyBaselineRow(row, previousUserId, readable);
            }
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
