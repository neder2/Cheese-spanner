/** 카테고리 메타데이터 페이지와 팔로워 조회·캐시·배치·재시도 수명주기를 소유한다. DOM에는 의존하지 않는다. */
(() => {
    const root = (globalThis.BetterChzzk = globalThis.BetterChzzk || {});
    const API_BASE = "https://api.chzzk.naver.com/service";
    const API_PAGE_SIZE = 50;
    const MAX_FOLLOWER_CACHE_ENTRIES = 1000;
    const FOLLOWER_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
    const METADATA_RETRY_INITIAL_MS = 1000;
    const METADATA_RETRY_MAX_MS = 30000;

    function routeKey(route) {
        if (!route) return "";
        if (route.scope === "global-lives") return "global-lives/lives";
        return `${route.categoryType}/${route.categoryId}/${route.tab}`;
    }

    function apiUrl(route, cursor = null) {
        if (route.scope === "global-lives") {
            const params = new URLSearchParams({ size: String(API_PAGE_SIZE) });
            if (cursor?.concurrentUserCount !== undefined && cursor?.concurrentUserCount !== null) {
                params.set("concurrentUserCount", String(cursor.concurrentUserCount));
            }
            if (cursor?.liveId !== undefined && cursor?.liveId !== null) {
                params.set("liveId", String(cursor.liveId));
            }
            return `${API_BASE}/v1/lives?${params.toString()}`;
        }

        const type = encodeURIComponent(route.categoryType);
        const id = encodeURIComponent(route.categoryId);
        const params = new URLSearchParams({ size: String(API_PAGE_SIZE) });
        if (route.tab === "clips") {
            params.set("clipUID", cursor?.clipUID ? String(cursor.clipUID) : "");
            params.set("filterType", "WITHIN_THIRTY_DAYS");
            params.set("orderType", "POPULAR");
            params.set(
                "readCount",
                cursor?.readCount !== undefined && cursor?.readCount !== null ? String(cursor.readCount) : ""
            );
            return `${API_BASE}/v1/categories/${type}/${id}/clips?${params.toString()}`;
        }
        if (route.tab === "videos" && cursor) {
            if (cursor.publishDateAt !== undefined && cursor.publishDateAt !== null)
                params.set("publishDateAt", String(cursor.publishDateAt));
            if (cursor.readCount !== undefined && cursor.readCount !== null)
                params.set("readCount", String(cursor.readCount));
        }
        if (route.tab === "lives" && cursor) {
            if (cursor.concurrentUserCount !== undefined && cursor.concurrentUserCount !== null) {
                params.set("concurrentUserCount", String(cursor.concurrentUserCount));
            }
            if (cursor.liveId !== undefined && cursor.liveId !== null) params.set("liveId", String(cursor.liveId));
        }
        return `${API_BASE}/v2/categories/${type}/${id}/${route.tab}?${params.toString()}`;
    }

    function mapApiItem(route, item) {
        if (route.tab === "lives") {
            const channel = item.channel || {};
            return {
                id: String(channel.channelId || ""),
                channelId: String(channel.channelId || ""),
                title: item.liveTitle || "",
                channelName: channel.channelName || "",
                channelImageUrl: channel.channelImageUrl || "",
                thumb: item.liveImageUrl || item.defaultThumbnailImageUrl || "",
                duration: null,
                publishDate: item.openDate || "",
                views: Number(item.concurrentUserCount) || 0,
                categoryName: item.liveCategoryValue || "",
                tags: item.tags || [],
                liveId: Number(item.liveId) || 0,
                adult: Boolean(item.adult),
            };
        }
        if (route.tab === "videos") {
            const channel = item.channel || {};
            return {
                id: String(item.videoNo || ""),
                channelId: String(channel.channelId || ""),
                title: item.videoTitle || "",
                channelName: channel.channelName || "",
                channelImageUrl: channel.channelImageUrl || "",
                thumb: item.thumbnailImageUrl || "",
                duration: typeof item.duration === "number" ? item.duration : null,
                publishDate: item.publishDate || "",
                views: Number(item.readCount) || 0,
                tags: item.tags || [],
            };
        }
        const channel = item.ownerChannel || {};
        return {
            id: String(item.clipUID || ""),
            channelId: String(item.ownerChannelId || channel.channelId || ""),
            title: item.clipTitle || "",
            channelName: channel.channelName || "",
            channelImageUrl: channel.channelImageUrl || "",
            thumb: item.thumbnailImageUrl || "",
            duration: typeof item.duration === "number" ? item.duration : null,
            publishDate: item.createdDate || "",
            views: Number(item.readCount) || 0,
            tags: [],
        };
    }

    function createRepository({
        fetchJson,
        touchMapEntry,
        onRetryReady = () => {},
        onHydrationNeeded = () => {},
        onFollowerLoading = () => {},
    }) {
        let metadataKey = "";
        let metadataMap = new Map();
        let metadataNext = null;
        let metadataComplete = false;
        let metadataPagesLoaded = 0;
        let metadataLoading = null;
        let liveViewerCounts = new Map();
        let liveCountBoundary = false;
        let liveCountInvalid = false;
        let liveCountRequest = null;
        let liveCountCache = null;
        let metadataGeneration = 0;
        let metadataRetryAt = 0;
        let metadataRetryDelayMs = METADATA_RETRY_INITIAL_MS;
        let metadataRetryTimer = 0;
        const followerCache = new Map();
        const followerInflight = new Map();
        let followerGeneration = 0;
        let followerHydrateTimer = 0;
        let lastFollowerHydrateAt = 0;
        let followerRefresh = null;

        function metadataState() {
            return {
                key: metadataKey,
                size: metadataMap.size,
                complete: metadataComplete,
                pagesLoaded: metadataPagesLoaded,
                next: metadataNext,
                loading: Boolean(metadataLoading),
                retryAt: metadataRetryAt,
                retryDelayMs: metadataRetryDelayMs,
            };
        }

        function clearMetadataRetryState() {
            if (metadataRetryTimer) clearTimeout(metadataRetryTimer);
            metadataRetryTimer = 0;
            metadataRetryAt = 0;
            metadataRetryDelayMs = METADATA_RETRY_INITIAL_MS;
        }

        function isMetadataRetryCoolingDown(key) {
            return metadataKey === key && Date.now() < metadataRetryAt;
        }

        function scheduleMetadataRetry(key) {
            const generation = metadataGeneration;
            const delayMs = metadataRetryDelayMs;
            metadataRetryAt = Date.now() + delayMs;
            metadataRetryDelayMs = Math.min(METADATA_RETRY_MAX_MS, delayMs * 2);
            if (metadataRetryTimer) clearTimeout(metadataRetryTimer);
            metadataRetryTimer = setTimeout(() => {
                metadataRetryTimer = 0;
                if (generation === metadataGeneration) onRetryReady(key);
            }, delayMs);
        }

        function resetMetadata(key = "") {
            metadataGeneration++;
            metadataLoading?.controller.abort();
            clearMetadataRetryState();
            metadataKey = key;
            metadataMap = new Map();
            metadataNext = null;
            metadataComplete = false;
            metadataPagesLoaded = 0;
            metadataLoading = null;
            liveViewerCounts = new Map();
            liveCountBoundary = false;
            liveCountInvalid = false;
            liveCountRequest = null;
        }

        function mergeMetadataPage(route, json) {
            if (route.scope === "global-lives") {
                const rows = json?.content?.data;
                if (
                    (json.code !== undefined && json.code !== 200) ||
                    !Array.isArray(rows) ||
                    rows.some((item) => !Number.isFinite(item.concurrentUserCount) || !item.liveId)
                )
                    liveCountInvalid = true;
                for (const item of rows || []) {
                    if (item.concurrentUserCount >= 10) liveViewerCounts.set(item.liveId, item.concurrentUserCount);
                    else {
                        liveViewerCounts.delete(item.liveId);
                        liveCountBoundary = true;
                    }
                }
                if (!rows?.length) liveCountBoundary = true;
            }
            clearMetadataRetryState();
            const data = json?.content?.data || [];
            for (const item of data) {
                const mapped = mapApiItem(route, item);
                if (!mapped.id) continue;
                delete mapped._bcgtSearchText;
                if (!metadataMap.has(mapped.id)) {
                    mapped.order = metadataMap.size;
                    metadataMap.set(mapped.id, mapped);
                } else {
                    const merged = { ...metadataMap.get(mapped.id), ...mapped };
                    delete merged._bcgtSearchText;
                    metadataMap.set(mapped.id, merged);
                }
            }
            metadataNext = json?.content?.page?.next || null;
            metadataComplete = !metadataNext;
            metadataPagesLoaded++;
            return metadataMap;
        }

        async function loadMetadataPage(route, cursor = null) {
            const key = routeKey(route);
            if (metadataKey !== key || isMetadataRetryCoolingDown(key)) return metadataMap;
            if (metadataLoading) return metadataLoading.promise;
            const request = { generation: metadataGeneration, controller: new AbortController(), promise: null };
            metadataLoading = request;
            request.promise = fetchJson(apiUrl(route, cursor), {
                headers: { Accept: "application/json" },
                signal: request.controller.signal,
            })
                .then((json) => {
                    if (request.generation !== metadataGeneration) return metadataMap;
                    return mergeMetadataPage(route, json);
                })
                .catch(() => {
                    // A request timeout is a retryable failure; only our own lifecycle abort cancels the lookup.
                    if (request.generation === metadataGeneration && !request.controller.signal.aborted) {
                        scheduleMetadataRetry(key);
                    }
                    return metadataMap;
                })
                .finally(() => {
                    if (metadataLoading === request) metadataLoading = null;
                });
            return request.promise;
        }

        async function ensureMetadata(route) {
            const key = routeKey(route);
            if (metadataKey !== key) resetMetadata(key);
            if (metadataMap.size || metadataComplete) return metadataMap;
            return loadMetadataPage(route);
        }

        async function countGlobalLives() {
            if (liveCountCache && Date.now() - liveCountCache.measuredAt < 5 * 60 * 1000) return liveCountCache;
            if (liveCountRequest) return liveCountRequest;
            const route = { scope: "global-lives", tab: "lives" };
            const initial = ensureMetadata(route);
            const generation = metadataGeneration;
            const pending = (async () => {
                await initial;
                const cursors = new Set();
                for (let pages = 0; pages < 200; pages++) {
                    if (generation !== metadataGeneration) throw new Error("Live count cancelled");
                    if (metadataRetryAt || liveCountInvalid) throw new Error("Live count unavailable");
                    if (liveCountBoundary || metadataComplete) {
                        liveCountCache = {
                            count: liveViewerCounts.size,
                            totalViewers: [...liveViewerCounts.values()].reduce((sum, viewers) => sum + viewers, 0),
                            measuredAt: Date.now(),
                        };
                        return liveCountCache;
                    }
                    const key = JSON.stringify(metadataNext);
                    if (!metadataNext || cursors.has(key)) throw new Error("Invalid live list cursor");
                    cursors.add(key);
                    await loadNextMetadata(route);
                }
                throw new Error("Live count page limit reached");
            })();
            liveCountRequest = pending;
            try {
                return await pending;
            } finally {
                if (liveCountRequest === pending) liveCountRequest = null;
            }
        }

        async function loadNextMetadata(route) {
            if (metadataKey !== routeKey(route) || metadataComplete || !metadataNext) return metadataMap;
            return loadMetadataPage(route, metadataNext);
        }

        async function ensureRenderedMetadata(route, ids, { maxPages, isCurrent = () => true }) {
            const key = routeKey(route);
            const initial = ensureMetadata(route);
            const generation = metadataGeneration;
            await initial;
            const missingIds = new Set(ids.filter((id) => id && !metadataMap.has(id)));
            while (
                missingIds.size &&
                metadataKey === key &&
                generation === metadataGeneration &&
                isCurrent() &&
                !metadataComplete &&
                metadataPagesLoaded < maxPages &&
                !isMetadataRetryCoolingDown(key)
            ) {
                if (!metadataNext) break;
                const pagesBefore = metadataPagesLoaded;
                await loadNextMetadata(route);
                if (metadataPagesLoaded === pagesBefore) break;
                for (const id of missingIds) {
                    if (metadataMap.has(id)) missingIds.delete(id);
                }
            }
            return metadataMap;
        }

        function isFollowerFetchMiss(value) {
            return Boolean(
                value && typeof value === "object" && value.type === "miss" && Number.isFinite(value.expiresAt)
            );
        }

        function rememberFollowerFetchMiss(channelId) {
            const miss = { type: "miss", expiresAt: Date.now() + FOLLOWER_NEGATIVE_CACHE_TTL_MS };
            touchMapEntry(followerCache, channelId, miss, MAX_FOLLOWER_CACHE_ENTRIES);
            return null;
        }

        function readFollowerCache(channelId) {
            if (!channelId || !followerCache.has(channelId)) return { hit: false, count: null };
            const cached = followerCache.get(channelId);
            if (isFollowerFetchMiss(cached)) {
                if (cached.expiresAt > Date.now()) {
                    touchMapEntry(followerCache, channelId, cached, MAX_FOLLOWER_CACHE_ENTRIES);
                    return { hit: true, count: null };
                }
                followerCache.delete(channelId);
                return { hit: false, count: null };
            }
            touchMapEntry(followerCache, channelId, cached, MAX_FOLLOWER_CACHE_ENTRIES);
            return { hit: true, count: cached };
        }

        async function getFollowerCount(channelId) {
            if (!channelId) return 0;
            const cached = readFollowerCache(channelId);
            if (cached.hit) return cached.count;
            if (followerInflight.has(channelId)) return followerInflight.get(channelId).promise;
            const request = { generation: followerGeneration, controller: new AbortController(), promise: null };
            request.promise = fetchJson(`${API_BASE}/v1/channels/${encodeURIComponent(channelId)}/followers/count`, {
                headers: { Accept: "application/json" },
                signal: request.controller.signal,
            })
                .then((json) => {
                    if (request.generation !== followerGeneration) return null;
                    const rawCount = json?.content?.followerCount;
                    if (rawCount === null || rawCount === undefined || rawCount === "") {
                        return rememberFollowerFetchMiss(channelId);
                    }
                    const count = Number(rawCount);
                    if (!Number.isFinite(count)) return rememberFollowerFetchMiss(channelId);
                    const safeCount = Math.max(0, Math.floor(count));
                    touchMapEntry(followerCache, channelId, safeCount, MAX_FOLLOWER_CACHE_ENTRIES);
                    return safeCount;
                })
                .catch(() => {
                    if (request.generation !== followerGeneration || request.controller.signal.aborted) return null;
                    return rememberFollowerFetchMiss(channelId);
                })
                .finally(() => {
                    if (followerInflight.get(channelId) === request) followerInflight.delete(channelId);
                });
            followerInflight.set(channelId, request);
            return request.promise;
        }

        function clearFollowerHydrationTimer() {
            if (followerHydrateTimer) clearTimeout(followerHydrateTimer);
            followerHydrateTimer = 0;
        }

        function queueFollowerHydrationPass(delayMs) {
            if (followerHydrateTimer) return;
            followerHydrateTimer = setTimeout(() => {
                followerHydrateTimer = 0;
                onHydrationNeeded();
            }, delayMs);
        }

        async function hydrateFollowers(ids, { maxPerPass, concurrency, delayMs, clearWhenDone, shouldContinue }) {
            const generation = followerGeneration;
            const unique = Array.from(new Set(ids.filter((id) => id && !readFollowerCache(id).hit)));
            if (!unique.length) {
                if (clearWhenDone) onFollowerLoading(false);
                return false;
            }
            const now = Date.now();
            if (now - lastFollowerHydrateAt < delayMs) {
                queueFollowerHydrationPass(delayMs);
                return true;
            }
            lastFollowerHydrateAt = now;
            const batch = unique.slice(0, maxPerPass);
            onFollowerLoading(true);
            try {
                for (let i = 0; i < batch.length && generation === followerGeneration; i += concurrency) {
                    await Promise.all(batch.slice(i, i + concurrency).map((id) => getFollowerCount(id)));
                }
            } finally {
                if (generation === followerGeneration) {
                    if (unique.length > batch.length && shouldContinue()) queueFollowerHydrationPass(delayMs);
                    else if (clearWhenDone) onFollowerLoading(false);
                }
            }
            return generation === followerGeneration && unique.length > batch.length;
        }

        async function refreshFollowers(ids, options) {
            if (followerRefresh) {
                followerRefresh.queued = true;
                return false;
            }
            const refresh = { generation: followerGeneration, queued: false };
            followerRefresh = refresh;
            try {
                await hydrateFollowers(ids, options);
                return refresh.generation === followerGeneration;
            } finally {
                if (followerRefresh === refresh) {
                    followerRefresh = null;
                    if (refresh.queued) queueFollowerHydrationPass(options.delayMs);
                }
            }
        }

        function cancelFollowers() {
            followerGeneration++;
            clearFollowerHydrationTimer();
            lastFollowerHydrateAt = 0;
            followerRefresh = null;
            for (const request of followerInflight.values()) request.controller.abort();
            followerInflight.clear();
            // Channel counts are route independent. Keep the bounded positive/negative cache across routes.
        }

        return Object.freeze({
            countGlobalLives,
            metadataState,
            isMetadataRetryCoolingDown,
            resetMetadata,
            ensureMetadata,
            ensureRenderedMetadata,
            loadNextMetadata,
            readFollowerCache,
            getFollowerCount,
            hydrateFollowers,
            refreshFollowers,
            clearFollowerHydrationTimer,
            cancelFollowers,
        });
    }

    root.categoryToolsRepository = Object.freeze({ routeKey, createRepository });
})();
