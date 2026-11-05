/** Owns channel indexes, request generations and comment search scheduling; reports data changes to the view. */
(() => {
    const root = (globalThis.CheeseSpanner = globalThis.CheeseSpanner || {});
    function createRepository({
        fetchJson,
        fetchChzzkCommentPage,
        onLoading: setLoading,
        onIndexStart,
        onIndexProgress,
        onIndexSettled,
        onCommentProgress,
    }) {
        const { isLastPage, sleep, normalizeCompact: normalize } = root.utils;
        const {
            extractVideos,
            extractCommentTexts,
            uniqueCommentTexts,
            buildCommentNorm,
            shouldFetchCommentsForQuery,
        } = root.videoSearchModel;
        let featureOptions = {};
        let currentChannelId = null;
        let currentQuery = "";
        const API_BASE = "https://api.chzzk.naver.com/service/v1/channels";
        const PAGE_SIZE = 30;
        const COMMENT_PAGE_SIZE = 30;
        const COMMENT_FETCH_CONCURRENCY = 3;
        const INDEX_CACHE_TTL_MS = 5 * 60 * 1000;
        const MAX_INDEX_CACHE_CHANNELS = 8;
        // fetchJson aborts its own request on timeout with the same AbortError a caller's signal produces.
        const REQUEST_TIMEOUT_MESSAGE = "조회 시간이 초과됐어요";
        const channelIndex = new Map();
        let activeFetchToken = 0;
        let commentSearchTimer = 0;
        let commentSearchToken = 0;
        let commentSearchRunning = false;
        // Generation whose delay timer fired while an older run was still busy; 0 when none is waiting.
        let commentSearchPendingToken = 0;
        let activeIndexAbortController = null;
        let activeCommentAbortController = null;
        function isFeatureEnabled() {
            return featureOptions.videoSearchEnabled;
        }

        function isCommentSearchEnabled() {
            return isFeatureEnabled() && featureOptions.videoSearchCommentEnabled;
        }

        function getMaxPages() {
            return featureOptions.videoSearchMaxPages;
        }

        function getCommentDelayMs() {
            return featureOptions.videoSearchCommentDelayMs;
        }

        function getCommentMaxVideos() {
            return featureOptions.videoSearchCommentMaxVideos;
        }

        function getCommentMaxPagesPerVideo() {
            return featureOptions.videoSearchCommentMaxPagesPerVideo;
        }

        function abortController(controller) {
            try {
                controller?.abort();
            } catch (_) {
                // Already aborted or unavailable.
            }
        }

        function isCompleteIndexFresh(entry, now = Date.now()) {
            const completedAt = Number(entry?.completedAt) || 0;
            const age = now - completedAt;
            return Boolean(entry?.complete && completedAt > 0 && age >= 0 && age < INDEX_CACHE_TTL_MS);
        }

        function shouldStartIndexBuild(entry) {
            return (
                !entry || (!isCompleteIndexFresh(entry) && (!entry.loading || entry.loadingToken !== activeFetchToken))
            );
        }

        function touchChannelIndex(channelId, entry) {
            if (!channelId || !entry) return;
            channelIndex.delete(channelId);
            channelIndex.set(channelId, entry);
            while (channelIndex.size > MAX_INDEX_CACHE_CHANNELS) {
                const oldestKey = channelIndex.keys().next().value;
                if (!oldestKey) break;
                channelIndex.delete(oldestKey);
            }
        }

        async function fetchPage(channelId, page, signal = undefined) {
            const url = `${API_BASE}/${encodeURIComponent(channelId)}/videos?sortType=LATEST&pagingType=PAGE&page=${page}&size=${PAGE_SIZE}`;
            return fetchJson(url, {
                headers: { Accept: "application/json" },
                signal,
            });
        }

        async function fetchCommentPage(videoNo, offset, signal = undefined) {
            return fetchChzzkCommentPage({
                limit: COMMENT_PAGE_SIZE,
                objectId: videoNo,
                offset,
                orderType: "POPULAR",
                signal,
            });
        }

        async function hydrateVideoComments(video, token, signal = undefined) {
            if (!isCommentSearchEnabled()) return;
            if (!video || video.commentFetched || video.commentLoading || video.commentActive === false) return;

            video.commentLoading = true;
            let shouldMarkFetched = true;
            try {
                const texts = [];
                for (let page = 0; page < getCommentMaxPagesPerVideo(); page++) {
                    if (token !== commentSearchToken || signal?.aborted) {
                        shouldMarkFetched = false;
                        return;
                    }
                    const content = await fetchCommentPage(video.videoNo, page * COMMENT_PAGE_SIZE, signal);
                    if (token !== commentSearchToken || signal?.aborted) {
                        shouldMarkFetched = false;
                        return;
                    }
                    const pageTexts = extractCommentTexts(content);
                    texts.push(...pageTexts);

                    const rows = content?.comments?.data;
                    if (!Array.isArray(rows) || rows.length < COMMENT_PAGE_SIZE) break;
                }
                video.commentTexts = uniqueCommentTexts(texts);
                video.commentNorm = buildCommentNorm(video.commentTexts);
                video.commentError = null;
                video.commentErrorToken = 0;
            } catch (e) {
                // Only the caller's cancellation is silent; an internal timeout is a failure like any other.
                if (token !== commentSearchToken || signal?.aborted) {
                    shouldMarkFetched = false;
                    return;
                }
                video.commentError = e?.name === "AbortError" ? REQUEST_TIMEOUT_MESSAGE : e?.message || String(e);
                // Stays fetched for this generation so one run does not loop on a failing video; the next
                // search generation retries it.
                video.commentErrorToken = token;
            } finally {
                if (shouldMarkFetched) video.commentFetched = true;
                video.commentLoading = false;
            }
        }

        async function buildIndex(channelId) {
            const existing = channelIndex.get(channelId);
            if (isCompleteIndexFresh(existing)) {
                touchChannelIndex(channelId, existing);
                return existing;
            }
            if (existing && existing.loading && existing.loadingToken === activeFetchToken) return existing;

            abortController(activeIndexAbortController);
            activeIndexAbortController = new AbortController();
            const signal = activeIndexAbortController.signal;
            const token = ++activeFetchToken;
            const entry =
                existing && !existing.complete
                    ? existing
                    : {
                          videos: [],
                          seen: new Set(),
                          complete: false,
                          completedAt: 0,
                          error: null,
                          limitReached: false,
                          loading: false,
                          loadingToken: 0,
                      };
            let reachedBoundary = false;
            let failed = false;
            entry.complete = false;
            entry.completedAt = 0;
            entry.error = null;
            entry.limitReached = false;
            entry.failedAt = 0;
            entry.loading = true;
            entry.loadingToken = token;
            touchChannelIndex(channelId, entry);

            setLoading(true);
            onIndexStart();
            try {
                for (let page = 0; page < getMaxPages(); page++) {
                    if (token !== activeFetchToken) return entry;
                    let json;
                    try {
                        json = await fetchPage(channelId, page, signal);
                    } catch (e) {
                        if (signal.aborted || token !== activeFetchToken) return entry;
                        entry.error = e?.name === "AbortError" ? REQUEST_TIMEOUT_MESSAGE : e?.message || String(e);
                        entry.failedAt = Date.now();
                        failed = true;
                        break;
                    }
                    if (token !== activeFetchToken || !normalize(currentQuery)) return entry;
                    const videos = extractVideos(json);
                    if (!videos.length && page === 0) {
                        entry.error = "no-data";
                        reachedBoundary = true;
                        break;
                    }
                    for (const v of videos) {
                        if (entry.seen.has(v.videoNo)) continue;
                        entry.seen.add(v.videoNo);
                        entry.videos.push(v);
                    }
                    onIndexProgress();
                    if (isLastPage(json, videos, PAGE_SIZE)) {
                        reachedBoundary = true;
                        break;
                    }
                    if (page === getMaxPages() - 1) {
                        // Cached as complete for the TTL, but marked so the view does not present it as the whole channel.
                        reachedBoundary = true;
                        entry.limitReached = true;
                    }
                }
                entry.complete = !failed && reachedBoundary;
                entry.completedAt = entry.complete ? Date.now() : 0;
            } finally {
                if (entry.loadingToken === token) {
                    entry.loading = false;
                    entry.loadingToken = 0;
                }
                if (activeIndexAbortController?.signal === signal) {
                    activeIndexAbortController = null;
                }
                if (token === activeFetchToken) {
                    setLoading(false);
                    onIndexSettled();
                }
            }
            return entry;
        }

        function stopActiveFetch() {
            activeFetchToken++;
            abortController(activeIndexAbortController);
            activeIndexAbortController = null;
            // The stopped build settles later without callbacks; do not leave its entry reading as still loading.
            for (const entry of channelIndex.values()) {
                if (!entry.loading) continue;
                entry.loading = false;
                entry.loadingToken = 0;
            }
            setLoading(false, "index");
            cancelCommentSearch();
        }

        function getEntry() {
            return currentChannelId ? channelIndex.get(currentChannelId) : null;
        }

        function cancelCommentSearch() {
            commentSearchToken++;
            commentSearchPendingToken = 0;
            if (commentSearchTimer) {
                clearTimeout(commentSearchTimer);
                commentSearchTimer = 0;
            }
            abortController(activeCommentAbortController);
            activeCommentAbortController = null;
            setLoading(false, "comments");
        }

        function scheduleCommentSearch() {
            if (!isCommentSearchEnabled()) {
                cancelCommentSearch();
                return;
            }

            const query = normalize(currentQuery);
            if (!query) {
                cancelCommentSearch();
                return;
            }

            if (commentSearchTimer) clearTimeout(commentSearchTimer);
            const token = ++commentSearchToken;
            // A start queued by an older generation is superseded; the new one starts from its own timer.
            commentSearchPendingToken = 0;
            abortController(activeCommentAbortController);
            activeCommentAbortController = null;
            commentSearchTimer = setTimeout(() => {
                commentSearchTimer = 0;
                startCommentSearch(token);
            }, getCommentDelayMs());
        }

        function startCommentSearch(token) {
            if (commentSearchRunning) {
                commentSearchPendingToken = token;
                return;
            }
            runCommentSearch(token).catch(() => {});
        }

        async function runCommentSearch(token) {
            commentSearchRunning = true;
            abortController(activeCommentAbortController);
            activeCommentAbortController = new AbortController();
            const signal = activeCommentAbortController.signal;
            setLoading(true, "comments");
            let fetchedCount = 0;

            try {
                while (
                    token === commentSearchToken &&
                    currentChannelId &&
                    isCommentSearchEnabled() &&
                    fetchedCount < getCommentMaxVideos()
                ) {
                    const query = normalize(currentQuery);
                    if (!query) break;

                    const entry = getEntry();
                    if (!entry) break;

                    for (const video of entry.videos) {
                        if (video.commentError && video.commentErrorToken !== token && !video.commentLoading) {
                            video.commentFetched = false;
                        }
                    }
                    const remaining = getCommentMaxVideos() - fetchedCount;
                    const targets = entry.videos
                        .filter((video) => shouldFetchCommentsForQuery(video, query))
                        .slice(0, remaining);

                    if (!targets.length) {
                        if (entry.loading && !entry.complete) {
                            await sleep(250);
                            continue;
                        }
                        break;
                    }

                    for (let i = 0; i < targets.length; i += COMMENT_FETCH_CONCURRENCY) {
                        if (token !== commentSearchToken || !normalize(currentQuery)) return;
                        if (signal.aborted) return;
                        const batch = targets.slice(i, i + COMMENT_FETCH_CONCURRENCY);
                        await Promise.all(batch.map((video) => hydrateVideoComments(video, token, signal)));
                        if (token !== commentSearchToken || signal.aborted) return;
                        fetchedCount += batch.length;
                        onCommentProgress();
                        if (fetchedCount >= getCommentMaxVideos()) break;
                    }
                }
            } finally {
                if (token === commentSearchToken && normalize(currentQuery)) {
                    onCommentProgress({ force: true });
                }
                if (activeCommentAbortController?.signal === signal) activeCommentAbortController = null;
                commentSearchRunning = false;
                setLoading(false, "comments");
                // Restart only the current generation, and only when its own delay timer already fired while this
                // run was busy. A newer generation that is still waiting for its delay starts from that timer.
                const pendingToken = commentSearchPendingToken;
                commentSearchPendingToken = 0;
                if (
                    pendingToken &&
                    pendingToken === commentSearchToken &&
                    isCommentSearchEnabled() &&
                    normalize(currentQuery)
                ) {
                    startCommentSearch(pendingToken);
                }
            }
        }
        function setContext(channelId, query, options) {
            currentChannelId = channelId;
            currentQuery = query;
            featureOptions = { ...options };
        }
        function clearIndex() {
            channelIndex.clear();
            activeFetchToken++;
        }
        function resetComments() {
            for (const entry of channelIndex.values()) {
                for (const video of entry.videos || []) {
                    video.commentTexts = [];
                    video.commentNorm = "";
                    video.commentFetched = video.commentActive === false;
                    video.commentLoading = false;
                    video.commentError = null;
                    video.commentErrorToken = 0;
                }
            }
        }
        return Object.freeze({
            setContext,
            buildIndex,
            shouldStartIndexBuild,
            getIndex: (channelId) => channelIndex.get(channelId),
            clearIndex,
            resetComments,
            stopActiveFetch,
            cancelCommentSearch,
            scheduleCommentSearch,
        });
    }
    root.videoSearchRepository = Object.freeze({ createRepository });
})();
