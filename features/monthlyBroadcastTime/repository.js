/** Owns shared page/detail requests and bounded caches; callers own query cancellation. */
(() => {
    const root = (globalThis.CheeseSpanner = globalThis.CheeseSpanner || {});
    function createRepository({ fetchJson }) {
        const { touchMapEntry, pickArray, isLastPage } = root.utils;
        const {
            extractVideos,
            mergeVideoDetail,
            shouldFetchStartDetail,
            replayOnly,
            summarizeWindowOverlap,
            getVideoSegmentEndMs,
            getKstMonthInfo,
            addMonthStart,
            finalizeMonthInfo,
            pageIsOlderThan,
        } = root.monthlyBroadcastModel;
        const API_BASE = "https://api.chzzk.naver.com/service/v1/channels";
        const PAGE_SIZE = 30;
        const REFRESH_MS = 10 * 60 * 1000;
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

        // Offset pages shift when a replay is added, so every walk starts at page 0 and later pages are
        // reused only from the same page-0 generation; per-page TTLs would otherwise mix list snapshots.
        const channelPageGenerations = new WeakMap();

        async function fetchVideoPageCached(channelId, page, { signal } = {}) {
            const cache = getChannelPageCache(channelId);
            let generation = channelPageGenerations.get(cache) || 0;
            if (page === 0 && !isReusableCacheEntry(cache.get(0))) {
                generation += 1;
                channelPageGenerations.set(cache, generation);
            }
            return fetchCachedRequest(
                cache,
                page,
                (requestSignal) => fetchVideoPage(channelId, page, { signal: requestSignal }),
                {
                    signal,
                    maxEntries: MAX_PAGES_PER_CHANNEL_CACHE,
                    generation,
                }
            );
        }

        function isReusableCacheEntry(entry, generation) {
            return Boolean(
                entry &&
                !entry.controller.signal.aborted &&
                !(entry.settled && Date.now() - entry.fetchedAt >= REFRESH_MS) &&
                (generation === undefined || entry.generation === generation)
            );
        }

        function fetchCachedRequest(cache, key, request, { signal, maxEntries, generation }) {
            if (signal?.aborted) return Promise.reject(createAbortError());
            let entry = cache.get(key);
            if (!isReusableCacheEntry(entry, generation)) {
                entry = { controller: new AbortController(), consumers: 0, settled: false, fetchedAt: 0, generation };
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

        async function hydrateVideoStartDetails(videos, ranges, isCurrent, { signal, details = null } = {}) {
            // Each range is { startMs, nextStartMs }: the calendar month, and for the recent total its window too.
            const rangeList = Array.isArray(ranges) ? ranges : [ranges];
            const targets = videos.filter((video) => rangeList.some((range) => shouldFetchStartDetail(video, range)));
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
                        if (details && detail) details.set(video.videoNo, detail);
                    } catch (_) {
                        // Fall back to publishDate - duration when the detail endpoint is unavailable.
                    }
                    if (signal?.aborted || !isCurrent()) return;
                    // A requested detail that gave no start leaves only the publish estimate; the window total
                    // leaves such a replay out instead of trusting it, whatever its length.
                    if (!video.startIsExact) video.startDetailUnresolved = true;
                }
            });

            await Promise.all(workers);
        }

        async function resolveSegmentOffsets(videos, details, isCurrent, { signal, linkedRequests } = {}) {
            // A split segment's own detail only carries the broadcast start; walk its confirmed older-segment
            // links (shared detail cache) instead of assuming the first segment seen is the first one aired.
            // One walk asks for each linked detail once, so a failing link is not retried per later segment.
            const fetchLinkedDetail = (videoNo, options) => {
                if (!linkedRequests.has(videoNo)) linkedRequests.set(videoNo, fetchVideoDetail(videoNo, options));
                return linkedRequests.get(videoNo);
            };
            let incomplete = false;
            for (const video of videos) {
                const detail = details.get(video.videoNo);
                if (!detail || !video.startIsExact) continue;
                if (signal?.aborted) throw createAbortError();
                if (!isCurrent()) return incomplete;
                const info = await root.vodTimeline.resolveSegmentStartInfo(detail, {
                    fetchDetail: fetchLinkedDetail,
                    signal,
                });
                if (!isCurrent()) return incomplete;
                // Without an older full-length link this is not a later segment; a publish-delay inference
                // alone must not move an ordinary replay by 17 hours.
                const linked = info.linkedVideoNos?.length > 0 || info.linkedChainIncomplete;
                video.segmentOffsetMs = linked && Number.isFinite(info.segmentOffsetMs) ? info.segmentOffsetMs : 0;
                if (info.linkedChainIncomplete) incomplete = true;
            }
            return incomplete;
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
            const statsVideos = [];
            let pagesLoaded = 0;
            let statsComplete = false;
            let segmentOffsetsIncomplete = false;
            const linkedRequests = new Map();
            let monthComplete = false;
            const monthInfo = getKstMonthInfo(now);
            monthInfo.pagesLoaded = 0;
            // A publish estimate ends at or after the true end, so one ending before the window start is outside it.
            const statsDetailRange = { startMs: windowStart, nextStartMs: Infinity };

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
                const details = new Map();
                // The recent window can start in an earlier month; its replays need their own detail start too,
                // or a publish estimate (later than the broadcast by the publish delay) would be counted as exact.
                const detailRanges = collectStats ? [monthInfo, statsDetailRange] : [monthInfo];
                await hydrateVideoStartDetails(videos, detailRanges, isCurrent, { signal, details });
                if (signal?.aborted) throw createAbortError();
                if (!isCurrent()) return null;
                if (
                    collectStats &&
                    (await resolveSegmentOffsets(videos, details, isCurrent, { signal, linkedRequests }))
                ) {
                    segmentOffsetsIncomplete = true;
                }
                if (signal?.aborted) throw createAbortError();
                if (!isCurrent()) return null;
                if (collectStats) pagesLoaded++;
                if (collectMonth) monthInfo.pagesLoaded++;

                for (const video of videos) {
                    if (seen.has(video.videoNo) || !replayOnly(video)) continue;
                    seen.add(video.videoNo);

                    if (collectStats) statsVideos.push(video);

                    if (collectMonth) addMonthStart(video, monthInfo, now);
                }

                const last = isLastPage(json, rows, PAGE_SIZE);
                if (collectStats) {
                    statsComplete =
                        last || (page > 0 && pageIsOlderThan(videos, rows, windowStart, getVideoSegmentEndMs));
                }
                if (collectMonth)
                    monthComplete = last || (page > 0 && pageIsOlderThan(videos, rows, monthInfo.startMs));
            }

            monthInfo.partial = !monthComplete;
            finalizeMonthInfo(monthInfo);
            const {
                totalSeconds,
                replayCount,
                incomplete: overlapIncomplete,
            } = summarizeWindowOverlap(statsVideos, windowStart, now);

            return {
                totalSeconds,
                averageSecondsPerDay: totalSeconds / windowDays,
                replayCount,
                pagesLoaded,
                // A segment whose earlier links could not be read, or a replay left out because its own detail
                // failed, makes the total only a lower bound.
                complete: statsComplete && !segmentOffsetsIncomplete && !overlapIncomplete,
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
