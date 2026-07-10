/**
 * features/liveWatchHistory.js — 라이브 시청 시간을 추적해 chrome.storage.local에 기록하는 기능.
 *
 * 동작 위치: https://chzzk.naver.com/live/{channelId} 라이브 시청 페이지 (isolated content script).
 * 하는 일: video 엘리먼트의 재생 상태를 감시해 시청 세션을 시작/누적/종료하고, 5초 간격으로
 *   watchedSeconds를 집계하며 15초 간격/가시성 변경/pagehide 시점에 storage로 flush한다.
 *   채널/방송 메타데이터는 DOM(og:title 등)에서 우선 추론하고 live-detail API로 보강한다.
 *   channel:{channelId}:{date} 임시 레코드를 liveId 확보 시 live:{liveId}로 승격한다.
 * 의존: BetterChzzkSettings.normalizeOptions, BetterChzzk.utils (addTitleHistory, bindFeatureOptions,
 *   createMutationObserverSync, createThrottledDomSync, fetchJson, getLiveChannelIdFromPath,
 *   mergeWatchRanges, onReady, startPageChangeDetection, storageGet/storageSet 등), chrome.storage.local.
 * 옵션 키: liveWatchHistoryEnabled, liveWatchHistoryMinMinutes.
 * 통신: chrome.storage.local 키 "betterChzzkLiveWatchHistory"에 { version, updatedAt, entries }를 쓴다.
 *   같은 키를 features/vodBroadcastClock.js가 읽어 다시보기 페이지에서 방제 이력을 매칭하고,
 *   history.html/history.js가 시청 기록 조회에 사용한다. chrome.storage.onChanged로 자신이 쓴
 *   updatedAt과 다르면 내부 캐시를 무효화한다.
 * 구조: STORAGE_KEY 등 상수 → 옵션/세션 상태 변수 → 세션 판정 유틸(isVideoActive 등) →
 *   메타데이터 추론/API 보강(inferMetadataFromPage, refreshMetadata) →
 *   히스토리 정규화/정리(normalizeHistory, pruneHistory) →
 *   캐시된 히스토리 읽기/쓰기(getHistoryCache, mutateHistory) →
 *   세션 시작/누적/종료(startSession, accrueWatchTime, flushSession, endSession) →
 *   video 엘리먼트 부착(attachVideo/detachVideo) → 라우트/DOM 변경 동기화(syncTrackingState) →
 *   생명주기 리스너 설치(visibilitychange, pagehide, storage.onChanged) →
 *   런타임 설치/해제(installRuntime, teardownRuntime) → 옵션 바인딩(applyOptions).
 */
(() => {
    const STORAGE_KEY = "betterChzzkLiveWatchHistory";
    const LIVE_DETAIL_API_BASE = "https://api.chzzk.naver.com/service/v2/channels";
    const TRACK_TICK_MS = 5000;
    const FLUSH_MS = 15000;
    const METADATA_REFRESH_MS = 60000;
    const FETCH_TIMEOUT_MS = 10000;
    const MAX_TICK_SECONDS = 10;
    const STORAGE_MIN_SESSION_SECONDS = 60;
    const HISTORY_MAX_ENTRIES = 2000;
    const HISTORY_MAX_SESSION_DETAILS_PER_ENTRY = 300;
    const HISTORY_MAX_WATCHED_RANGES_PER_SESSION = 200;
    const SESSION_MERGE_GAP_MS = 60 * 1000;

    const storage = globalThis.chrome?.storage?.local;
    const { normalizeOptions } = BetterChzzkSettings;
    const {
        addTitleHistory,
        bindFeatureOptions,
        cleanEntryTitle,
        compactSpaces,
        createMutationObserverSync,
        createThrottledDomSync,
        fetchJson,
        getLiveChannelIdFromPath,
        getKstDateKey,
        getMainVideoElement,
        getNextKstDayStartMs,
        mergeDailySeconds,
        mergeWatchRanges,
        mutationMatchesSelector,
        normalizeTitleHistory,
        onReady,
        pickString,
        startPageChangeDetection,
        storageGet,
        storageSet,
    } = BetterChzzk.utils;

    let featureOptions = normalizeOptions();
    let lastUrl = location.href;
    let attachedVideo = null;
    let session = null;
    let tickTimer = 0;
    let flushTimer = 0;
    let metadataTimer = 0;
    let metadataRequestSeq = 0;
    let domObserver = null;
    let removePageChangeDetection = null;
    let runtimeInstalled = false;
    let lifecycleListenersInstalled = false;
    let flushInProgress = false;
    let flushAgainRequested = false;
    let historyCache = null;
    let historyCachePromise = null;
    let historyCacheUpdatedAt = 0;
    let historyStorageListenerInstalled = false;

    const scheduleDomSync = createThrottledDomSync(syncTrackingState, 250);

    function isFeatureEnabled() {
        return Boolean(featureOptions.liveWatchHistoryEnabled);
    }

    function getMinSessionSeconds() {
        return Math.max(1, Number(featureOptions.liveWatchHistoryMinMinutes) || 1) * 60;
    }

    function getLiveChannelIdFromUrl() {
        return getLiveChannelIdFromPath();
    }

    function isLiveRoute() {
        return Boolean(getLiveChannelIdFromUrl());
    }

    function isEnabledForCurrentPage() {
        return isFeatureEnabled() && isLiveRoute();
    }

    function isVideoActive(video) {
        return (
            video instanceof HTMLVideoElement &&
            video.isConnected &&
            !video.paused &&
            !video.ended &&
            Number(video.playbackRate) > 0
        );
    }

    function getVideoMediaTime(video) {
        const value = Number(video?.currentTime);
        return Number.isFinite(value) ? value : null;
    }

    function shouldCountWatchTime(video, current, deltaSeconds) {
        if (!isVideoActive(video) || deltaSeconds <= 0) return false;

        const mediaTime = getVideoMediaTime(video);
        const previousMediaTime = current.lastMediaTime;
        if (mediaTime !== null) current.lastMediaTime = mediaTime;

        if (video.readyState >= 2) return true;
        if (mediaTime === null || previousMediaTime === null) return true;
        return mediaTime > previousMediaTime + 0.05;
    }

    function mergeContinuousSessionDetails(sessionDetails, preferredSessionId = "") {
        const merged = [];
        const rows = (Array.isArray(sessionDetails) ? sessionDetails : [])
            .filter((row) => row && typeof row === "object")
            .map((row) => ({
                ...row,
                enteredAt: Number(row.enteredAt) || 0,
                leftAt: Number(row.leftAt) || Number(row.enteredAt) || 0,
                watchedSeconds: Math.max(0, Number(row.watchedSeconds) || 0),
                dailySeconds: row.dailySeconds && typeof row.dailySeconds === "object" ? { ...row.dailySeconds } : {},
                watchedRanges: mergeWatchRanges(row.watchedRanges),
            }))
            .filter((row) => row.enteredAt > 0 && row.watchedSeconds > 0)
            .sort((a, b) => a.enteredAt - b.enteredAt || a.leftAt - b.leftAt);

        for (const row of rows) {
            const last = merged[merged.length - 1];
            const lastLeftAt = Number(last?.leftAt) || Number(last?.enteredAt) || 0;
            const shouldMerge = last && lastLeftAt > 0 && row.enteredAt <= lastLeftAt + SESSION_MERGE_GAP_MS;

            if (!shouldMerge) {
                merged.push(row);
                continue;
            }

            if (row.id === preferredSessionId) last.id = row.id;
            if (row.title) last.title = row.title;
            last.leftAt = Math.max(lastLeftAt, Number(row.leftAt) || row.enteredAt);
            last.watchedSeconds = Math.max(0, Number(last.watchedSeconds) || 0) + row.watchedSeconds;
            last.dailySeconds = mergeDailySeconds(last.dailySeconds, row.dailySeconds, { round: true });
            last.watchedRanges = mergeWatchRanges([...(last.watchedRanges || []), ...(row.watchedRanges || [])]);
            last.closed = last.closed === true && row.closed === true;
        }

        return merged.sort((a, b) => Number(b.enteredAt || 0) - Number(a.enteredAt || 0));
    }

    function addPendingRange(current, startAt, endAt) {
        if (!current || endAt <= startAt) return;
        current.pendingRanges = mergeWatchRanges([...(current.pendingRanges || []), { startAt, endAt }]);

        let cursor = startAt;
        while (cursor < endAt) {
            const dateKey = getKstDateKey(cursor);
            const next = Math.min(endAt, getNextKstDayStartMs(cursor));
            const seconds = Math.max(0, (next - cursor) / 1000);
            if (seconds > 0) {
                current.pendingByDate[dateKey] = (Number(current.pendingByDate[dateKey]) || 0) + seconds;
            }
            cursor = next;
        }
    }

    function mergeTitleHistory(target, sourceHistory) {
        for (const row of normalizeTitleHistory(sourceHistory, target?.channelName)) {
            addTitleHistory(target, row.title, row.firstSeenAt, row.lastSeenAt);
        }
    }

    function inferChannelNameFromDom(channelId) {
        if (!channelId) return "";
        const selectors = [
            `a[href="/${channelId}"]`,
            `a[href^="/${channelId}?"]`,
            `a[href^="https://chzzk.naver.com/${channelId}"]`,
        ];

        for (const el of document.querySelectorAll(selectors.join(", "))) {
            const text = compactSpaces(el.textContent);
            if (text && text.length <= 60) return text;
        }

        return "";
    }

    function inferMetadataFromPage(channelId) {
        const ogTitle = document.querySelector('meta[property="og:title"], meta[name="twitter:title"]')?.content;
        const channelName = inferChannelNameFromDom(channelId);
        const title = cleanEntryTitle(pickString(ogTitle, document.title), channelName);
        const thumbnailUrl = pickString(
            document.querySelector('meta[property="og:image"], meta[name="twitter:image"]')?.content
        );

        return {
            channelId,
            liveId: "",
            title,
            channelName,
            thumbnailUrl,
            liveOpenDate: "",
            liveUrl: `${location.origin}${location.pathname}`,
        };
    }

    function normalizeApiContent(json) {
        return json?.content ?? json?.data ?? json ?? {};
    }

    function extractMetadataFromLiveDetail(json, channelId) {
        const content = normalizeApiContent(json);
        const live = content.live || content.liveDetail || {};
        const channel = content.channel || live.channel || {};
        const channelName = pickString(content.channelName, channel.channelName, channel.name);

        return {
            channelId,
            liveId: pickString(content.liveId, content.liveNo, live.liveId, live.liveNo, content.id),
            title: cleanEntryTitle(
                pickString(content.liveTitle, content.title, live.liveTitle, live.title),
                channelName
            ),
            channelName,
            thumbnailUrl: pickString(
                content.liveImageUrl,
                content.defaultThumbnailImageUrl,
                content.thumbnailImageUrl,
                live.liveImageUrl,
                live.thumbnailImageUrl
            ),
            liveOpenDate: pickString(content.openDate, content.liveOpenDate, live.openDate, live.liveOpenDate),
            liveUrl: `${location.origin}${location.pathname}`,
        };
    }

    function mergeMetadata(target, metadata) {
        if (!target || !metadata) return;
        const nextChannelName = pickString(metadata.channelName, target.channelName);
        for (const key of ["channelId", "liveId", "channelName", "title", "thumbnailUrl", "liveOpenDate", "liveUrl"]) {
            const value = compactSpaces(metadata[key]);
            if (!value) continue;
            if (key === "title") {
                const title = cleanEntryTitle(value, nextChannelName);
                if (title) {
                    target.title = title;
                    addTitleHistory(target, title);
                }
                continue;
            }
            target[key] = value;
        }
    }

    function scheduleMetadataRefresh(delayMs = METADATA_REFRESH_MS) {
        if (metadataTimer) clearTimeout(metadataTimer);
        if (!session || !isEnabledForCurrentPage()) return;
        metadataTimer = setTimeout(refreshMetadata, delayMs);
    }

    async function refreshMetadata() {
        metadataTimer = 0;
        const current = session;
        if (!current || !isEnabledForCurrentPage()) return;

        const requestId = ++metadataRequestSeq;
        const channelId = current.channelId || getLiveChannelIdFromUrl();
        mergeMetadata(current, inferMetadataFromPage(channelId));

        try {
            const url = `${LIVE_DETAIL_API_BASE}/${encodeURIComponent(channelId)}/live-detail`;
            const json = await fetchJson(url, { timeoutMs: FETCH_TIMEOUT_MS });
            if (requestId !== metadataRequestSeq || session !== current) return;
            mergeMetadata(current, extractMetadataFromLiveDetail(json, channelId));
            if (
                !current.storageSessionRecorded &&
                current.liveId &&
                String(current.recordId || "").startsWith("channel:")
            ) {
                current.recordId = `live:${current.liveId}`;
            }
        } catch (_) {
            // DOM metadata is enough to keep recording when the detail API is unavailable.
        } finally {
            if (session === current) scheduleMetadataRefresh();
        }
    }

    function getRecordId(current) {
        if (current.recordId) return current.recordId;
        if (current.liveId) return `live:${current.liveId}`;
        return `channel:${current.channelId}:${getKstDateKey(current.startedAt)}`;
    }

    function normalizeHistory(raw) {
        const source = raw && typeof raw === "object" ? raw : {};
        const entries = {};
        const rawEntries = Array.isArray(source.entries)
            ? source.entries
            : source.entries && typeof source.entries === "object"
              ? Object.values(source.entries)
              : [];

        for (const row of rawEntries) {
            if (!row || typeof row !== "object") continue;
            const id = pickString(row.id);
            if (!id) continue;
            const channelName = pickString(row.channelName) || "알 수 없는 채널";
            const entry = {
                id,
                channelId: pickString(row.channelId),
                liveId: pickString(row.liveId),
                title: cleanEntryTitle(pickString(row.title), channelName) || "제목 없는 라이브",
                channelName,
                thumbnailUrl: pickString(row.thumbnailUrl),
                liveOpenDate: pickString(row.liveOpenDate),
                liveUrl: pickString(row.liveUrl),
                firstWatchedAt: Number(row.firstWatchedAt) || Date.now(),
                lastWatchedAt: Number(row.lastWatchedAt) || Number(row.firstWatchedAt) || Date.now(),
                watchedSeconds: Math.max(0, Number(row.watchedSeconds) || 0),
                sessions: Math.max(1, Math.round(Number(row.sessions) || 1)),
                dailySeconds: row.dailySeconds && typeof row.dailySeconds === "object" ? { ...row.dailySeconds } : {},
                sessionDetails: normalizeSessionDetails(row.sessionDetails, channelName),
                titleHistory: normalizeTitleHistory(row.titleHistory, channelName),
            };
            const hasSessionDetails = Array.isArray(row.sessionDetails);
            if (hasSessionDetails) {
                entry.watchedSeconds = sumSessionSeconds(entry.sessionDetails);
                entry.dailySeconds = buildDailySecondsFromSessions(entry.sessionDetails);
                entry.firstWatchedAt = getSessionFirstWatchedAt(entry.sessionDetails) || entry.firstWatchedAt;
                entry.lastWatchedAt = getSessionLastWatchedAt(entry.sessionDetails) || entry.lastWatchedAt;
            }
            for (const detail of entry.sessionDetails) {
                addTitleHistory(entry, detail.title, detail.enteredAt, detail.leftAt || detail.enteredAt);
            }
            addTitleHistory(entry, entry.title, entry.firstWatchedAt || entry.lastWatchedAt);
            if (entry.watchedSeconds < STORAGE_MIN_SESSION_SECONDS) {
                continue;
            }
            pruneHistoryEntry(entry);
            entries[id] = entry;
        }

        return {
            version: 1,
            updatedAt: Number(source.updatedAt) || 0,
            entries,
        };
    }

    function normalizeSessionDetails(value, channelName = "") {
        if (!Array.isArray(value)) return [];

        const sessions = value
            .filter((row) => row && typeof row === "object")
            .map((row) => {
                const id = pickString(row.id);
                const title = cleanEntryTitle(
                    pickString(row.title, row.videoTitle, row.liveTitle, row.name),
                    channelName
                );
                const watchedSeconds = Math.max(0, Number(row.watchedSeconds) || 0);
                const dailySeconds =
                    row.dailySeconds && typeof row.dailySeconds === "object" ? { ...row.dailySeconds } : {};
                return {
                    id,
                    title,
                    enteredAt: Number(row.enteredAt) || Number(row.startedAt) || 0,
                    leftAt: Number(row.leftAt) || Number(row.endedAt) || Number(row.lastWatchedAt) || 0,
                    watchedSeconds,
                    dailySeconds,
                    watchedRanges: mergeWatchRanges(row.watchedRanges),
                    closed: row.closed === true,
                };
            })
            .filter((row) => row.id && row.enteredAt > 0 && row.watchedSeconds >= STORAGE_MIN_SESSION_SECONDS);

        return mergeContinuousSessionDetails(sessions);
    }

    function sumSessionSeconds(sessionDetails) {
        return (sessionDetails || []).reduce((sum, row) => sum + Math.max(0, Number(row.watchedSeconds) || 0), 0);
    }

    function buildDailySecondsFromSessions(sessionDetails) {
        const dailySeconds = {};
        for (const row of sessionDetails || []) {
            const dailyEntries = Object.entries(row.dailySeconds || {});
            if (dailyEntries.length) {
                mergePending(dailySeconds, row.dailySeconds);
                continue;
            }

            if (row.enteredAt > 0 && row.watchedSeconds > 0) {
                mergePending(dailySeconds, { [getKstDateKey(row.enteredAt)]: row.watchedSeconds });
            }
        }
        return dailySeconds;
    }

    function getSessionFirstWatchedAt(sessionDetails) {
        const values = (sessionDetails || []).map((row) => Number(row.enteredAt) || 0).filter((value) => value > 0);
        return values.length ? Math.min(...values) : 0;
    }

    function getSessionLastWatchedAt(sessionDetails) {
        const values = (sessionDetails || [])
            .map((row) => Number(row.leftAt) || Number(row.enteredAt) || 0)
            .filter((value) => value > 0);
        return values.length ? Math.max(...values) : 0;
    }

    function pruneHistoryEntry(entry) {
        if (!entry || typeof entry !== "object") return;
        if (!Array.isArray(entry.sessionDetails)) entry.sessionDetails = [];
        if (entry.sessionDetails.length > HISTORY_MAX_SESSION_DETAILS_PER_ENTRY) {
            entry.sessionDetails = entry.sessionDetails
                .sort((a, b) => Number(b.enteredAt || 0) - Number(a.enteredAt || 0))
                .slice(0, HISTORY_MAX_SESSION_DETAILS_PER_ENTRY);
        }
        entry.sessions = Math.max(Number(entry.sessions) || 0, entry.sessionDetails.length || 0);
    }

    function pruneHistory(history, updatedEntry = null) {
        pruneHistoryEntry(updatedEntry);

        const entryCount = Object.keys(history.entries).length;
        if (entryCount <= HISTORY_MAX_ENTRIES) return;

        const rows = Object.values(history.entries);
        if (rows.length <= HISTORY_MAX_ENTRIES) return;

        rows.sort((a, b) => Number(b.lastWatchedAt || 0) - Number(a.lastWatchedAt || 0));
        history.entries = Object.fromEntries(rows.slice(0, HISTORY_MAX_ENTRIES).map((entry) => [entry.id, entry]));
    }

    function invalidateHistoryCache() {
        historyCache = null;
        historyCachePromise = null;
        historyCacheUpdatedAt = 0;
    }

    async function getHistoryCache() {
        if (historyCache) return historyCache;
        if (!historyCachePromise) {
            historyCachePromise = storageGet(storage, STORAGE_KEY)
                .then((data) => {
                    historyCache = normalizeHistory(data[STORAGE_KEY]);
                    historyCacheUpdatedAt = Number(historyCache.updatedAt) || 0;
                    return historyCache;
                })
                .finally(() => {
                    historyCachePromise = null;
                });
        }
        return historyCachePromise;
    }

    async function mutateHistory(updater) {
        const history = await getHistoryCache();
        const updatedEntry = updater(history);
        history.updatedAt = Date.now();
        pruneHistory(history, updatedEntry);
        historyCache = history;
        historyCacheUpdatedAt = history.updatedAt;
        try {
            await storageSet(storage, { [STORAGE_KEY]: history });
        } catch (error) {
            invalidateHistoryCache();
            throw error;
        }
    }

    function mergePending(target, pendingByDate) {
        for (const [dateKey, seconds] of Object.entries(pendingByDate || {})) {
            const value = Math.round(Number(seconds) || 0);
            if (value <= 0) continue;
            target[dateKey] = Math.max(0, Number(target[dateKey]) || 0) + value;
        }
    }

    function createEntry(id, current) {
        const channelName = current.channelName || "알 수 없는 채널";
        const entry = {
            id,
            channelId: current.channelId || "",
            liveId: current.liveId || "",
            title: cleanEntryTitle(current.title, channelName) || "제목 없는 라이브",
            channelName,
            thumbnailUrl: current.thumbnailUrl || "",
            liveOpenDate: current.liveOpenDate || "",
            liveUrl: current.liveUrl || `${location.origin}${location.pathname}`,
            firstWatchedAt: current.startedAt,
            lastWatchedAt: current.lastWatchedAt || Date.now(),
            watchedSeconds: 0,
            sessions: 0,
            dailySeconds: {},
            sessionDetails: [],
            titleHistory: normalizeTitleHistory(current.titleHistory, channelName),
        };
        addTitleHistory(entry, entry.title, current.enteredAt || current.startedAt);
        return entry;
    }

    function takePendingSnapshot(current) {
        const snapshot = {};
        for (const [dateKey, seconds] of Object.entries(current.pendingByDate || {})) {
            const value = Math.round(Number(seconds) || 0);
            if (value > 0) snapshot[dateKey] = value;
        }
        current.pendingByDate = {};
        current.pendingSeconds = 0;
        return snapshot;
    }

    function takePendingRangeSnapshot(current) {
        const snapshot = mergeWatchRanges(current.pendingRanges);
        current.pendingRanges = [];
        return snapshot;
    }

    function restorePendingSnapshot(current, snapshot) {
        if (!current || !snapshot) return;
        for (const [dateKey, seconds] of Object.entries(snapshot)) {
            current.pendingByDate[dateKey] = (Number(current.pendingByDate[dateKey]) || 0) + seconds;
            current.pendingSeconds += seconds;
        }
    }

    function restorePendingRangeSnapshot(current, snapshot) {
        if (!current || !snapshot?.length) return;
        current.pendingRanges = mergeWatchRanges([...(snapshot || []), ...(current.pendingRanges || [])]);
    }

    function pendingTotal(snapshot) {
        return Object.values(snapshot || {}).reduce((sum, seconds) => sum + Math.max(0, Number(seconds) || 0), 0);
    }

    function getSessionLeftAt(current) {
        return current?.lastSeenAt || current?.lastWatchedAt || Date.now();
    }

    function hasStoredSessionStateChange(current) {
        if (!current?.storageSessionRecorded) return false;
        if ((current.closed === true) !== (current.storageClosed === true)) return true;
        return getSessionLeftAt(current) > (Number(current.storageLeftAt) || 0);
    }

    function createSessionId() {
        return `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    }

    function upsertSessionDetail(entry, current, deltaSeconds, snapshot, rangeSnapshot) {
        entry.sessionDetails = Array.isArray(entry.sessionDetails) ? entry.sessionDetails : [];

        let detail = entry.sessionDetails.find((row) => row.id === current.sessionId);
        if (!detail) {
            detail = {
                id: current.sessionId,
                title: current.title || "",
                enteredAt: current.enteredAt || current.startedAt,
                leftAt: current.lastSeenAt || current.lastWatchedAt || Date.now(),
                watchedSeconds: 0,
                dailySeconds: {},
                watchedRanges: [],
                closed: false,
            };
            entry.sessionDetails.push(detail);
        }

        if (current.title && !detail.title) detail.title = current.title;
        detail.leftAt = Math.max(Number(detail.leftAt) || 0, current.lastSeenAt || current.lastWatchedAt || Date.now());
        detail.closed = current.closed === true;
        detail.watchedRanges = mergeWatchRanges(detail.watchedRanges);
        if (deltaSeconds > 0) {
            detail.watchedSeconds = Math.max(0, Number(detail.watchedSeconds) || 0) + deltaSeconds;
            detail.dailySeconds =
                detail.dailySeconds && typeof detail.dailySeconds === "object" ? detail.dailySeconds : {};
            mergePending(detail.dailySeconds, snapshot);
            detail.watchedRanges = mergeWatchRanges([...detail.watchedRanges, ...(rangeSnapshot || [])]);
            if (detail.watchedRanges.length > HISTORY_MAX_WATCHED_RANGES_PER_SESSION) {
                detail.watchedRanges = detail.watchedRanges.slice(-HISTORY_MAX_WATCHED_RANGES_PER_SESSION);
            }
        }

        entry.sessionDetails = mergeContinuousSessionDetails(entry.sessionDetails, current.sessionId);
        for (const row of entry.sessionDetails) {
            if (Array.isArray(row.watchedRanges) && row.watchedRanges.length > HISTORY_MAX_WATCHED_RANGES_PER_SESSION) {
                row.watchedRanges = row.watchedRanges.slice(-HISTORY_MAX_WATCHED_RANGES_PER_SESSION);
            }
        }
    }

    async function flushSession({ force = false } = {}) {
        if (flushInProgress) {
            flushAgainRequested = true;
            return;
        }

        accrueWatchTime();

        const current = session;
        if (!current) return;
        if (!storage) {
            if (force && current.closed === true && session === current) {
                session = null;
            }
            return;
        }

        const totalWatched = Math.floor(current.watchedSeconds);
        if (totalWatched < getMinSessionSeconds()) {
            if (force && current.closed === true && session === current) {
                session = null;
            }
            return;
        }

        const snapshot = takePendingSnapshot(current);
        const rangeSnapshot = takePendingRangeSnapshot(current);
        const deltaSeconds = pendingTotal(snapshot);
        const shouldUpdateSession = force && hasStoredSessionStateChange(current);
        if (deltaSeconds <= 0 && !shouldUpdateSession) return;

        flushInProgress = true;
        flushAgainRequested = false;

        try {
            const id = getRecordId(current);
            await mutateHistory((history) => {
                const entry = history.entries[id] || createEntry(id, current);

                entry.channelId = current.channelId || entry.channelId;
                entry.liveId = current.liveId || entry.liveId;
                entry.channelName = current.channelName || entry.channelName;
                mergeTitleHistory(entry, current.titleHistory);
                if (current.title) {
                    const title = cleanEntryTitle(current.title, entry.channelName);
                    addTitleHistory(entry, title, current.lastSeenAt || current.lastWatchedAt || Date.now());
                    entry.title = title || entry.title;
                }
                entry.thumbnailUrl = current.thumbnailUrl || entry.thumbnailUrl;
                entry.liveOpenDate = current.liveOpenDate || entry.liveOpenDate;
                entry.liveUrl = current.liveUrl || entry.liveUrl;
                entry.firstWatchedAt = Math.min(Number(entry.firstWatchedAt) || current.startedAt, current.startedAt);
                entry.lastWatchedAt = Math.max(
                    Number(entry.lastWatchedAt) || 0,
                    current.lastSeenAt || current.lastWatchedAt || Date.now()
                );
                if (deltaSeconds > 0)
                    entry.watchedSeconds = Math.max(0, Number(entry.watchedSeconds) || 0) + deltaSeconds;
                entry.dailySeconds =
                    entry.dailySeconds && typeof entry.dailySeconds === "object" ? entry.dailySeconds : {};
                if (deltaSeconds > 0) mergePending(entry.dailySeconds, snapshot);
                upsertSessionDetail(entry, current, deltaSeconds, snapshot, rangeSnapshot);
                entry.sessions = Math.max(Number(entry.sessions) || 0, entry.sessionDetails.length);

                history.entries[id] = entry;
                return entry;
            });

            if (session === current) {
                current.storageSessionRecorded = true;
                current.storageLeftAt = getSessionLeftAt(current);
                current.storageClosed = current.closed === true;
            }
        } catch (_) {
            restorePendingSnapshot(current, snapshot);
            restorePendingRangeSnapshot(current, rangeSnapshot);
        } finally {
            flushInProgress = false;
            const needsFollowUp = flushAgainRequested || (force && current.closed !== true);
            if (needsFollowUp) {
                flushAgainRequested = false;
                if (session === current) flushSession({ force: current.closed === true });
            } else if (current.closed === true && session === current) {
                session = null;
            }
        }
    }

    function accrueWatchTime() {
        const current = session;
        if (!current) return;

        const now = performance.now();
        const deltaSeconds = Math.min(Math.max(0, (now - current.lastTickAt) / 1000), MAX_TICK_SECONDS);
        current.lastTickAt = now;

        if (!shouldCountWatchTime(attachedVideo, current, deltaSeconds)) return;

        const watchedAt = Date.now();
        const rangeStartAt = Math.max(0, Math.round(watchedAt - deltaSeconds * 1000));
        current.watchedSeconds += deltaSeconds;
        current.pendingSeconds += deltaSeconds;
        addPendingRange(current, rangeStartAt, watchedAt);
        current.lastWatchedAt = watchedAt;
        current.lastSeenAt = current.lastWatchedAt;
    }

    function startSession() {
        if (session || !isEnabledForCurrentPage()) return;

        const channelId = getLiveChannelIdFromUrl();
        const metadata = inferMetadataFromPage(channelId);
        const now = Date.now();

        session = {
            ...metadata,
            sessionId: createSessionId(),
            enteredAt: now,
            startedAt: now,
            lastWatchedAt: now,
            lastSeenAt: now,
            watchedSeconds: 0,
            pendingSeconds: 0,
            pendingByDate: {},
            pendingRanges: [],
            storageSessionRecorded: false,
            lastTickAt: performance.now(),
            lastMediaTime: getVideoMediaTime(attachedVideo),
        };
        addTitleHistory(session, session.title, now);
        session.recordId = getRecordId(session);

        ensureTimers();
        scheduleMetadataRefresh(0);
    }

    function endSession() {
        if (!session) return;
        const current = session;
        current.closed = true;
        current.lastSeenAt = Date.now();
        accrueWatchTime();
        void flushSession({ force: true });
        if (metadataTimer) {
            clearTimeout(metadataTimer);
            metadataTimer = 0;
        }
    }

    function ensureTimers() {
        if (!tickTimer) tickTimer = setInterval(runTrackingTick, TRACK_TICK_MS);
        if (!flushTimer) flushTimer = setInterval(() => flushSession(), FLUSH_MS);
    }

    function clearTimers() {
        if (tickTimer) {
            clearInterval(tickTimer);
            tickTimer = 0;
        }
        if (flushTimer) {
            clearInterval(flushTimer);
            flushTimer = 0;
        }
        if (metadataTimer) {
            clearTimeout(metadataTimer);
            metadataTimer = 0;
        }
    }

    function onVideoPlay() {
        if (!isEnabledForCurrentPage()) return;
        if (!session) startSession();
        accrueWatchTime();
    }

    function onVideoPause() {
        accrueWatchTime();
        void flushSession({ force: true });
    }

    function detachVideo() {
        if (!attachedVideo) return;
        attachedVideo.removeEventListener("play", onVideoPlay, true);
        attachedVideo.removeEventListener("playing", onVideoPlay, true);
        attachedVideo.removeEventListener("pause", onVideoPause, true);
        attachedVideo.removeEventListener("ended", onVideoPause, true);
        attachedVideo.removeEventListener("waiting", onVideoPause, true);
        attachedVideo = null;
    }

    function attachVideo(video) {
        if (attachedVideo === video) return;
        detachVideo();
        if (!(video instanceof HTMLVideoElement)) return;

        attachedVideo = video;
        attachedVideo.addEventListener("play", onVideoPlay, true);
        attachedVideo.addEventListener("playing", onVideoPlay, true);
        attachedVideo.addEventListener("pause", onVideoPause, true);
        attachedVideo.addEventListener("ended", onVideoPause, true);
        attachedVideo.addEventListener("waiting", onVideoPause, true);

        if (isVideoActive(video)) startSession();
    }

    function syncTrackingState() {
        handlePageChange();

        if (!isEnabledForCurrentPage()) {
            endSession();
            detachVideo();
            clearTimers();
            return;
        }

        ensureTimers();
        const video = getMainVideoElement?.();
        attachVideo(video);
        if (isVideoActive(video)) {
            if (!session) startSession();
            else accrueWatchTime();
        }
    }

    function runTrackingTick() {
        if (!isEnabledForCurrentPage()) {
            endSession();
            detachVideo();
            clearTimers();
            return;
        }

        if (!attachedVideo || !attachedVideo.isConnected) {
            attachVideo(getMainVideoElement?.());
        }

        if (isVideoActive(attachedVideo)) {
            if (!session) startSession();
            accrueWatchTime();
            return;
        }

        accrueWatchTime();
    }

    function handlePageChange() {
        if (location.href === lastUrl) return;
        const wasLive = Boolean(getLiveChannelIdFromPath(new URL(lastUrl).pathname));
        lastUrl = location.href;
        const channelChanged = session?.channelId && session.channelId !== getLiveChannelIdFromUrl();

        if (wasLive || channelChanged || !isEnabledForCurrentPage()) {
            endSession();
            detachVideo();
        }
    }

    function startDomObserver() {
        if (domObserver) return;
        domObserver = createMutationObserverSync({
            options: { childList: true, subtree: true },
            onMutations: handlePageChange,
            shouldSchedule: (mutations) =>
                isFeatureEnabled() && mutations.some((mutation) => mutationMatchesSelector(mutation, "video")),
            schedule: scheduleDomSync,
            onBodyReady: syncTrackingState,
        });
    }

    function stopDomObserver() {
        if (domObserver) {
            domObserver.disconnectAll?.();
            domObserver.disconnect();
            domObserver = null;
        }
    }

    function handleVisibilityChange() {
        accrueWatchTime();
        if (document.visibilityState === "hidden") void flushSession({ force: true });
    }

    function handlePageHide() {
        accrueWatchTime();
        void flushSession({ force: true });
    }

    function installLifecycleListeners() {
        if (lifecycleListenersInstalled) return;
        lifecycleListenersInstalled = true;
        document.addEventListener("visibilitychange", handleVisibilityChange, true);
        window.addEventListener("pagehide", handlePageHide, true);
    }

    function uninstallLifecycleListeners() {
        if (!lifecycleListenersInstalled) return;
        lifecycleListenersInstalled = false;
        document.removeEventListener("visibilitychange", handleVisibilityChange, true);
        window.removeEventListener("pagehide", handlePageHide, true);
    }

    function handleHistoryStorageChange(changes, areaName) {
        if (areaName !== "local" || !changes?.[STORAGE_KEY]) return;
        const nextUpdatedAt = Number(changes[STORAGE_KEY].newValue?.updatedAt) || 0;
        if (nextUpdatedAt && nextUpdatedAt === historyCacheUpdatedAt) return;
        invalidateHistoryCache();
    }

    function installHistoryStorageListener() {
        if (historyStorageListenerInstalled || !globalThis.chrome?.storage?.onChanged) return;
        historyStorageListenerInstalled = true;
        chrome.storage.onChanged.addListener(handleHistoryStorageChange);
    }

    function uninstallHistoryStorageListener() {
        if (!historyStorageListenerInstalled || !globalThis.chrome?.storage?.onChanged) return;
        historyStorageListenerInstalled = false;
        chrome.storage.onChanged.removeListener(handleHistoryStorageChange);
    }

    function installRuntime() {
        if (runtimeInstalled) return;
        runtimeInstalled = true;
        installLifecycleListeners();
        installHistoryStorageListener();
        if (!removePageChangeDetection) {
            removePageChangeDetection = startPageChangeDetection(syncTrackingState);
        }
        startDomObserver();
    }

    function teardownRuntime() {
        runtimeInstalled = false;
        endSession();
        detachVideo();
        clearTimers();
        stopDomObserver();
        uninstallLifecycleListeners();
        uninstallHistoryStorageListener();
        invalidateHistoryCache();
        if (removePageChangeDetection) {
            removePageChangeDetection();
            removePageChangeDetection = null;
        }
    }

    function applyOptions(options) {
        featureOptions = options;
        if (!isFeatureEnabled()) {
            teardownRuntime();
            return;
        }

        installRuntime();
        syncTrackingState();
    }

    bindFeatureOptions(applyOptions);

    onReady(() => {
        if (isFeatureEnabled()) {
            installRuntime();
            syncTrackingState();
        }
    });
})();
