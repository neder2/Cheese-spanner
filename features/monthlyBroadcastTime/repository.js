/** Owns shared page/detail requests and bounded caches; callers own query cancellation. */
(() => {
    const root = (globalThis.BetterChzzk = globalThis.BetterChzzk || {});
    function createRepository({ fetchJson }) {
        const { touchMapEntry, pickArray, isLastPage } = root.utils;
        const {
            extractVideos,
            mergeVideoDetail,
            shouldFetchStartDetail,
            replayOnly,
            estimateOverlapSeconds,
            getKstMonthInfo,
            addMonthStart,
            finalizeMonthInfo,
            pageIsOlderThan,
        } = root.monthlyBroadcastModel;
        const API_BASE = "https://api.chzzk.naver.com/service/v1/channels";
        const PAGE_SIZE = 30;
        const REFRESH_MS = 10 * 60 * 1000;
        const MINUTE_SECONDS = 60;
        const VIDEO_DETAIL_API_BASE = "https://api.chzzk.naver.com/service/v2/videos";
        const DETAIL_FETCH_CONCURRENCY = 5;
        const FETCH_TIMEOUT_MS = 15000;
        const MAX_PAGE_CACHE_CHANNELS = 8;
        const MAX_PAGES_PER_CHANNEL_CACHE = 120;
        const MAX_VIDEO_DETAIL_CACHE_ENTRIES = 600;
        const PAGE_FETCH_DELAY_MS = 80;
        const channelVideoPageCache = new Map();
        const videoDetailCache = new Map();
        function getChannelPageCache(channelId) {
            let cache = channelVideoPageCache.get(channelId);
            if (!cache) {
                cache = new Map();
                touchMapEntry(channelVideoPageCache, channelId, cache, MAX_PAGE_CACHE_CHANNELS);
            } else {
                touchMapEntry(channelVideoPageCache, channelId, cache, MAX_PAGE_CACHE_CHANNELS);
            }
            return cache;
        }

        function createAbortError() {
            try {
                return new DOMException("Aborted", "AbortError");
            } catch (_) {
                const error = new Error("Aborted");
                error.name = "AbortError";
                return error;
            }
        }

        function waitWithAbort(ms, signal) {
            if (!ms) return signal?.aborted ? Promise.reject(createAbortError()) : Promise.resolve();
            if (signal?.aborted) return Promise.reject(createAbortError());
            return new Promise((resolve, reject) => {
                const timer = setTimeout(done, ms);

                function done() {
                    signal?.removeEventListener("abort", abort);
                    resolve();
                }

                function abort() {
                    clearTimeout(timer);
                    reject(createAbortError());
                }

                signal?.addEventListener("abort", abort, { once: true });
            });
        }

        async function waitBeforeVideoPage(page, signal) {
            if (page <= 0) return;
            await waitWithAbort(PAGE_FETCH_DELAY_MS, signal);
        }

        async function fetchVideoPage(channelId, page, { signal } = {}) {
            await waitBeforeVideoPage(page, signal);
            const params = new URLSearchParams({
                sortType: "LATEST",
                pagingType: "PAGE",
                page: String(page),
                size: String(PAGE_SIZE),
            });
            const url = `${API_BASE}/${encodeURIComponent(channelId)}/videos?${params.toString()}`;
            return fetchJson(url, {
                headers: { Accept: "application/json" },
                signal,
                timeoutMs: FETCH_TIMEOUT_MS,
            });
        }

        async function fetchVideoPageCached(channelId, page, { signal } = {}) {
            const cache = getChannelPageCache(channelId);
            return fetchCachedRequest(
                cache,
                page,
                (requestSignal) => fetchVideoPage(channelId, page, { signal: requestSignal }),
                {
                    signal,
                    maxEntries: MAX_PAGES_PER_CHANNEL_CACHE,
                }
            );
        }

        function fetchCachedRequest(cache, key, request, { signal, maxEntries }) {
            if (signal?.aborted) return Promise.reject(createAbortError());
            let entry = cache.get(key);
            if (
                !entry ||
                entry.controller.signal.aborted ||
                (entry.settled && Date.now() - entry.fetchedAt >= REFRESH_MS)
            ) {
                entry = { controller: new AbortController(), consumers: 0, settled: false, fetchedAt: 0 };
                const pending = entry;
                pending.promise = Promise.resolve()
                    .then(() => {
                        if (pending.controller.signal.aborted) throw createAbortError();
                        return request(pending.controller.signal);
                    })
                    .then((value) => {
                        pending.settled = true;
                        pending.fetchedAt = Date.now();
                        return value;
                    })
                    .catch((error) => {
                        pending.settled = true;
                        if (cache.get(key) === pending) cache.delete(key);
                        throw error;
                    });
            }
            touchMapEntry(cache, key, entry, maxEntries);
            entry.consumers++;
            return new Promise((resolve, reject) => {
                let finished = false;
                const finish = (callback, value) => {
                    if (finished) return;
                    finished = true;
                    signal?.removeEventListener("abort", abort);
                    entry.consumers--;
                    if (!entry.settled && entry.consumers === 0) {
                        if (cache.get(key) === entry) cache.delete(key);
                        entry.controller.abort();
                    }
                    callback(value);
                };
                const abort = () => finish(reject, createAbortError());
                signal?.addEventListener("abort", abort, { once: true });
                entry.promise.then(
                    (value) => finish(resolve, value),
                    (error) => finish(reject, error)
                );
            });
        }

        async function fetchVideoDetail(videoNo, { signal } = {}) {
            return fetchCachedRequest(
                videoDetailCache,
                videoNo,
                (requestSignal) =>
                    fetchJson(`${VIDEO_DETAIL_API_BASE}/${encodeURIComponent(videoNo)}`, {
                        headers: { Accept: "application/json" },
                        signal: requestSignal,
                        timeoutMs: FETCH_TIMEOUT_MS,
                    }).then((json) => json?.content || null),
                { signal, maxEntries: MAX_VIDEO_DETAIL_CACHE_ENTRIES }
            );
        }

        async function hydrateVideoStartDetails(videos, monthInfo, isCurrent, { signal } = {}) {
            const targets = videos.filter((video) => shouldFetchStartDetail(video, monthInfo));
            if (!targets.length) return;

            let index = 0;
            const workers = Array.from({ length: Math.min(DETAIL_FETCH_CONCURRENCY, targets.length) }, async () => {
                while (index < targets.length) {
                    if (signal?.aborted) return;
                    if (!isCurrent()) return;
                    const video = targets[index++];
                    try {
                        const detail = await fetchVideoDetail(video.videoNo, { signal });
                        if (!isCurrent()) return;
                        mergeVideoDetail(video, detail);
                    } catch (_) {
                        // Fall back to publishDate - duration when the detail endpoint is unavailable.
                    }
                }
            });

            await Promise.all(workers);
        }

        async function calculateCalendarMonth(
            channelId,
            year,
            month,
            { maxCalendarPages },
            { signal, isCurrent = () => true } = {}
        ) {
            const now = Date.now();
            const monthInfo = getKstMonthInfo(now, year, month);
            const seen = new Set();
            let pagesLoaded = 0;
            let complete = false;

            for (let page = 0; page < maxCalendarPages; page++) {
                if (signal?.aborted) throw createAbortError();
                if (!isCurrent()) return null;
                const json = await fetchVideoPageCached(channelId, page, { signal });
                const rows = pickArray(json?.content ?? json) || [];
                const videos = extractVideos(json);
                await hydrateVideoStartDetails(videos, monthInfo, isCurrent, { signal });
                if (signal?.aborted) throw createAbortError();
                if (!isCurrent()) return null;
                pagesLoaded++;

                for (const video of videos) {
                    if (seen.has(video.videoNo) || !replayOnly(video)) continue;
                    seen.add(video.videoNo);
                    addMonthStart(video, monthInfo, now);
                }

                complete =
                    isLastPage(json, rows, PAGE_SIZE) || (page > 0 && pageIsOlderThan(videos, rows, monthInfo.startMs));
                if (complete) break;
            }

            monthInfo.pagesLoaded = pagesLoaded;
            monthInfo.partial = !complete;
            return finalizeMonthInfo(monthInfo);
        }

        async function calculateStats(
            channelId,
            { windowDays, maxPages, maxCalendarPages, calendarEnabled },
            { signal, isCurrent = () => true } = {}
        ) {
            const now = Date.now();
            const windowStart = now - windowDays * 24 * 60 * 60 * 1000;
            const maxMonthPages = calendarEnabled ? maxCalendarPages : maxPages;
            const seen = new Set();
            let totalSeconds = 0;
            let replayCount = 0;
            let pagesLoaded = 0;
            let statsComplete = false;
            let monthComplete = false;
            const monthInfo = getKstMonthInfo(now);
            monthInfo.pagesLoaded = 0;

            // Walk the list once, but stop each aggregation at its own boundary and cap.
            for (let page = 0; page < Math.max(maxPages, maxMonthPages); page++) {
                const collectStats = !statsComplete && page < maxPages;
                const collectMonth = !monthComplete && page < maxMonthPages;
                if (!collectStats && !collectMonth) break;
                if (signal?.aborted) throw createAbortError();
                if (!isCurrent()) return null;
                const json = await fetchVideoPageCached(channelId, page, { signal });
                const rows = pickArray(json?.content ?? json) || [];
                const videos = extractVideos(json);
                await hydrateVideoStartDetails(videos, monthInfo, isCurrent, { signal });
                if (signal?.aborted) throw createAbortError();
                if (!isCurrent()) return null;
                if (collectStats) pagesLoaded++;
                if (collectMonth) monthInfo.pagesLoaded++;

                for (const video of videos) {
                    if (seen.has(video.videoNo) || !replayOnly(video)) continue;
                    seen.add(video.videoNo);

                    if (collectStats) {
                        const overlapSeconds = estimateOverlapSeconds(video, windowStart, now);
                        if (overlapSeconds >= MINUTE_SECONDS) {
                            totalSeconds += overlapSeconds;
                            replayCount++;
                        }
                    }

                    if (collectMonth) addMonthStart(video, monthInfo, now);
                }

                const last = isLastPage(json, rows, PAGE_SIZE);
                if (collectStats) statsComplete = last || (page > 0 && pageIsOlderThan(videos, rows, windowStart));
                if (collectMonth)
                    monthComplete = last || (page > 0 && pageIsOlderThan(videos, rows, monthInfo.startMs));
            }

            monthInfo.partial = !monthComplete;
            finalizeMonthInfo(monthInfo);

            return {
                totalSeconds,
                averageSecondsPerDay: totalSeconds / windowDays,
                replayCount,
                pagesLoaded,
                complete: statsComplete,
                month: {
                    ...monthInfo,
                },
                fetchedAt: Date.now(),
            };
        }
        return Object.freeze({
            fetchVideoPageCached,
            fetchVideoDetail,
            calculateStats,
            calculateCalendarMonth,
            clearPages() {
                channelVideoPageCache.clear();
            },
        });
    }
    root.monthlyBroadcastRepository = Object.freeze({ createRepository });
})();
