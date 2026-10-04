/** 목록 메타데이터·전체 방송 집계·카테고리 검색의 공유 조회와 독립 취소, 팔로워 캐시·배치·재시도를 소유한다. DOM에는 의존하지 않는다. */
(() => {
    const root = (globalThis.BetterChzzk = globalThis.BetterChzzk || {});
    const API_BASE = "https://api.chzzk.naver.com/service";
    const API_PAGE_SIZE = 50;
    const MAX_FOLLOWER_CACHE_ENTRIES = 1000;
    const FOLLOWER_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
    const METADATA_RETRY_INITIAL_MS = 1000;
    const METADATA_RETRY_MAX_MS = 30000;
    const LIVE_COUNT_CACHE_TTL_MS = 5 * 60 * 1000;
    const MAX_SHARED_PAGES = 200;
    const CATEGORY_SEARCH_URL = "https://api.chzzk.naver.com/manage/v1/auto-complete/categories";
    const CATEGORY_SEARCH_RESULT_LIMIT = 50;
    const MAX_CATEGORY_SEARCH_KEYWORD_LENGTH = 100;
    const MAX_CATEGORY_SEARCH_CACHE_ENTRIES = 20;
    const CATEGORY_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;

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
            const categoryKey = root.categoryExclusions?.categoryKey(item.categoryType, item.liveCategory);
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
                categoryType: categoryKey ? item.categoryType : "",
                categoryId: categoryKey ? item.liveCategory : "",
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
        let liveCountRequest = null;
        let liveCountCache = null;
        let liveCountGeneration = 0;
        const pageRequests = new Map();
        const pageCache = new Map();
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
        const categorySearchCache = new Map();
        const categorySearchRequests = new Map();
        const categoryViewerCache = new Map();
        let categorySearchGeneration = 0;

        function categorySearchAbortError() {
            const error = new Error("Category search cancelled");
            error.name = "AbortError";
            return error;
        }

        function normalizeCategoryResults(json) {
            const rows = json?.content?.results;
            if (json?.code !== 200 || !Array.isArray(rows)) throw new Error("Category search unavailable");
            const results = [];
            const seen = new Set();
            for (const row of rows) {
                if (
                    !row ||
                    typeof row !== "object" ||
                    Array.isArray(row) ||
                    !["categoryType", "categoryId", "categoryValue"].every((field) => Object.hasOwn(row, field))
                )
                    continue;
                const category = root.categoryExclusions.normalizeCategory({
                    categoryType: row.categoryType,
                    categoryId: row.categoryId,
                    categoryValue: row.categoryValue,
                });
                if (!category) continue;
                const key = root.categoryExclusions.categoryKey(category);
                if (seen.has(key)) continue;
                seen.add(key);
                results.push(Object.freeze(category));
                if (results.length >= CATEGORY_SEARCH_RESULT_LIMIT) break;
            }
            if (rows.length && !results.length) throw new Error("Category search unavailable");
            return Object.freeze(results);
        }

        function copyCategoryResults(results) {
            return results.map((category) => ({ ...category }));
        }

        async function rankCategoryResults(results, request) {
            const ranked = copyCategoryResults(results);
            const deadline = Date.now() + 5000;
            request.measuredAt = Date.now();
            let next = 0;
            await Promise.all(
                Array.from({ length: Math.min(4, ranked.length) }, async () => {
                    while (next < ranked.length) {
                        if (request.controller.signal.aborted || request.generation !== categorySearchGeneration)
                            throw categorySearchAbortError();
                        const category = ranked[next++];
                        const key = root.categoryExclusions.categoryKey(category);
                        const cached = categoryViewerCache.get(key);
                        if (cached && Date.now() - cached.measuredAt < CATEGORY_SEARCH_CACHE_TTL_MS) {
                            category.concurrentUserCount = cached.count;
                            request.measuredAt = Math.min(request.measuredAt, cached.measuredAt);
                            continue;
                        }
                        const remainingMs = deadline - Date.now();
                        if (remainingMs <= 0) continue;
                        try {
                            const json = await fetchJson(
                                `${API_BASE}/v1/categories/${encodeURIComponent(category.categoryType)}/${encodeURIComponent(category.categoryId)}/info`,
                                {
                                    headers: { Accept: "application/json" },
                                    signal: request.controller.signal,
                                    timeoutMs: Math.min(3000, remainingMs),
                                }
                            );
                            if (request.controller.signal.aborted || request.generation !== categorySearchGeneration)
                                throw categorySearchAbortError();
                            const info = json?.content;
                            if (
                                json?.code === 200 &&
                                info?.categoryType === category.categoryType &&
                                info?.categoryId === category.categoryId &&
                                Number.isSafeInteger(info?.concurrentUserCount) &&
                                info.concurrentUserCount >= 0
                            ) {
                                category.concurrentUserCount = info.concurrentUserCount;
                                touchMapEntry(
                                    categoryViewerCache,
                                    key,
                                    { count: info.concurrentUserCount, measuredAt: Date.now() },
                                    200
                                );
                            }
                        } catch {
                            if (request.controller.signal.aborted || request.generation !== categorySearchGeneration)
                                throw categorySearchAbortError();
                        }
                    }
                })
            );
            // Unknown counts remain searchable; measured zero only removes search candidates.
            return ranked
                .filter((category) => category.concurrentUserCount !== 0)
                .sort((a, b) => (b.concurrentUserCount ?? -1) - (a.concurrentUserCount ?? -1));
        }

        function consumeCategorySearch(keyword, request, signal) {
            return new Promise((resolve, reject) => {
                let active = true;
                const release = () => {
                    if (!active) return false;
                    active = false;
                    signal?.removeEventListener("abort", consumer.cancel);
                    request.consumers.delete(consumer);
                    return true;
                };
                const consumer = {
                    cancel() {
                        if (!release()) return;
                        reject(categorySearchAbortError());
                        if (request.consumers.size) return;
                        if (categorySearchRequests.get(keyword) === request) categorySearchRequests.delete(keyword);
                        request.controller.abort();
                    },
                };
                request.consumers.add(consumer);
                signal?.addEventListener("abort", consumer.cancel, { once: true });
                request.promise.then(
                    (results) => {
                        if (release()) resolve(copyCategoryResults(results));
                    },
                    (error) => {
                        if (release()) reject(error);
                    }
                );
                if (signal?.aborted) consumer.cancel();
            });
        }

        function searchCategories(keyword, { signal } = {}) {
            if (signal?.aborted) return Promise.reject(categorySearchAbortError());
            if (typeof keyword !== "string") return Promise.reject(new Error("Invalid category search keyword"));
            const query = keyword.trim();
            if (query.length > MAX_CATEGORY_SEARCH_KEYWORD_LENGTH)
                return Promise.reject(new Error("Category search keyword limit exceeded"));
            if (!query) return Promise.resolve([]);
            const cached = categorySearchCache.get(query);
            if (cached && Date.now() - cached.measuredAt < CATEGORY_SEARCH_CACHE_TTL_MS) {
                touchMapEntry(categorySearchCache, query, cached, MAX_CATEGORY_SEARCH_CACHE_ENTRIES);
                return Promise.resolve(copyCategoryResults(cached.results));
            }
            categorySearchCache.delete(query);
            let request = categorySearchRequests.get(query);
            if (!request) {
                request = {
                    generation: categorySearchGeneration,
                    controller: new AbortController(),
                    consumers: new Set(),
                    promise: null,
                };
                categorySearchRequests.set(query, request);
                const params = new URLSearchParams({ keyword: query, size: String(CATEGORY_SEARCH_RESULT_LIMIT) });
                request.promise = (async () => {
                    const json = await fetchJson(`${CATEGORY_SEARCH_URL}?${params.toString()}`, {
                        headers: { Accept: "application/json" },
                        signal: request.controller.signal,
                    });
                    if (
                        request.controller.signal.aborted ||
                        request.generation !== categorySearchGeneration ||
                        categorySearchRequests.get(query) !== request
                    )
                        throw categorySearchAbortError();
                    const results = await rankCategoryResults(normalizeCategoryResults(json), request);
                    if (request.controller.signal.aborted || request.generation !== categorySearchGeneration)
                        throw categorySearchAbortError();
                    if (results.every((category) => Number.isSafeInteger(category.concurrentUserCount)))
                        touchMapEntry(
                            categorySearchCache,
                            query,
                            { results, measuredAt: request.measuredAt },
                            MAX_CATEGORY_SEARCH_CACHE_ENTRIES
                        );
                    return results;
                })().finally(() => {
                    if (categorySearchRequests.get(query) === request) categorySearchRequests.delete(query);
                });
            }
            return consumeCategorySearch(query, request, signal);
        }

        function cancelCategorySearch() {
            categorySearchGeneration++;
            const requests = [...categorySearchRequests.values()];
            categorySearchRequests.clear();
            for (const request of requests) {
                for (const consumer of [...request.consumers]) consumer.cancel();
                request.controller.abort();
            }
        }

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
            resetSearchMetadata(key);
            cancelGlobalLiveCount();
            pageCache.clear();
        }

        function resetSearchMetadata(key = metadataKey) {
            cancelMetadataSearch();
            metadataKey = key;
            metadataMap = new Map();
            metadataNext = null;
            metadataComplete = false;
            metadataPagesLoaded = 0;
            metadataLoading = null;
        }

        function cancelPageConsumer(consumer) {
            for (const [url, request] of pageRequests) {
                request.consumers.delete(consumer);
                if (request.consumers.size) continue;
                pageRequests.delete(url);
                request.controller.abort();
            }
        }

        function cancelMetadataSearch() {
            metadataGeneration++;
            metadataLoading = null;
            clearMetadataRetryState();
            cancelPageConsumer("search");
        }

        function cancelGlobalLiveCount() {
            liveCountGeneration++;
            if (liveCountRequest) pageCache.clear();
            liveCountRequest = null;
            cancelPageConsumer("count");
        }

        function validPage(route, json) {
            const rows = json?.content?.data;
            return (
                (json?.code === undefined || json.code === 200) &&
                Array.isArray(rows) &&
                (route.scope !== "global-lives" ||
                    rows.every((item) => item && Number.isFinite(item.concurrentUserCount) && item.liveId))
            );
        }

        function loadSharedPage(route, cursor, consumer) {
            const url = apiUrl(route, cursor);
            const cached = pageCache.get(url);
            if (cached && Date.now() - cached.measuredAt < LIVE_COUNT_CACHE_TTL_MS) return Promise.resolve(cached.json);
            pageCache.delete(url);
            const existing = pageRequests.get(url);
            if (existing) {
                existing.consumers.add(consumer);
                return existing.promise;
            }
            const request = { controller: new AbortController(), consumers: new Set([consumer]), promise: null };
            pageRequests.set(url, request);
            request.promise = fetchJson(url, {
                headers: { Accept: "application/json" },
                signal: request.controller.signal,
            })
                .then((json) => {
                    if (request.controller.signal.aborted) throw new Error("Live count cancelled");
                    if (route.scope === "global-lives" && validPage(route, json)) {
                        touchMapEntry(pageCache, url, { json, measuredAt: Date.now() }, MAX_SHARED_PAGES);
                    }
                    return json;
                })
                .finally(() => {
                    if (pageRequests.get(url) === request) pageRequests.delete(url);
                });
            return request.promise;
        }

        function mergeMetadataPage(route, json) {
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
            const request = { generation: metadataGeneration, pagesLoaded: metadataPagesLoaded, promise: null };
            metadataLoading = request;
            request.promise = loadSharedPage(route, cursor, "search")
                .then((json) => {
                    if (request.generation !== metadataGeneration) return metadataMap;
                    if (request.pagesLoaded !== metadataPagesLoaded) return metadataMap;
                    return mergeMetadataPage(route, json);
                })
                .catch(() => {
                    // A request timeout is a retryable failure; only our own lifecycle abort cancels the lookup.
                    if (request.generation === metadataGeneration) {
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
            if (liveCountCache && Date.now() - liveCountCache.measuredAt < LIVE_COUNT_CACHE_TTL_MS)
                return liveCountCache;
            if (liveCountRequest) return liveCountRequest;
            const route = { scope: "global-lives", tab: "lives" };
            if (metadataKey !== routeKey(route)) resetMetadata(routeKey(route));
            const generation = liveCountGeneration;
            const pending = (async () => {
                const cursors = new Set();
                const viewers = new Map();
                let cursor = null;
                for (let pages = 0; pages < 200; pages++) {
                    let json;
                    try {
                        json = await loadSharedPage(route, cursor, "count");
                    } catch (_) {
                        if (generation !== liveCountGeneration) throw new Error("Live count cancelled");
                        throw new Error("Live count unavailable");
                    }
                    if (generation !== liveCountGeneration) throw new Error("Live count cancelled");
                    if (!validPage(route, json)) throw new Error("Live count unavailable");
                    // Count pages extend the same contiguous metadata prefix used by search.
                    // The search waiter skips its merge if another consumer already advanced that page.
                    if (
                        !metadataComplete &&
                        metadataKey === routeKey(route) &&
                        JSON.stringify(metadataNext) === JSON.stringify(cursor)
                    )
                        mergeMetadataPage(route, json);
                    const rows = json.content.data;
                    let boundary = !rows.length;
                    for (const item of rows) {
                        if (item.concurrentUserCount >= 10) viewers.set(item.liveId, item.concurrentUserCount);
                        else {
                            viewers.delete(item.liveId);
                            boundary = true;
                        }
                    }
                    cursor = json.content.page?.next || null;
                    if (boundary || !cursor) {
                        liveCountCache = {
                            count: viewers.size,
                            totalViewers: [...viewers.values()].reduce((sum, count) => sum + count, 0),
                            measuredAt: Date.now(),
                        };
                        return liveCountCache;
                    }
                    const key = JSON.stringify(cursor);
                    if (cursors.has(key)) throw new Error("Invalid live list cursor");
                    cursors.add(key);
                }
                throw new Error("Live count page limit reached");
            })();
            liveCountRequest = pending;
            try {
                return await pending;
            } catch (error) {
                if (generation === liveCountGeneration) pageCache.clear();
                throw error;
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
            searchCategories,
            cancelCategorySearch,
            countGlobalLives,
            cancelGlobalLiveCount,
            cancelMetadataSearch,
            metadataState,
            isMetadataRetryCoolingDown,
            resetMetadata,
            resetSearchMetadata,
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
