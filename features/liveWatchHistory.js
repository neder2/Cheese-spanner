/**
 * features/liveWatchHistory.js — 라이브 재생 시간을 세션 단위로 추적한다.
 *
 * 실행 컨텍스트: https://chzzk.naver.com/live/{channelId}의 isolated content script.
 * 하는 일: 실제 media time이 전진한 구간만 누적하고 15초 간격·가시성 변경·pagehide에 flush한다.
 * 의존: BetterChzzkSettings와 BetterChzzk.utils의 DOM, 날짜, 범위 병합, runtime 메시지 유틸.
 * 통신: 누적 절대값 세션 스냅샷과 provisional→live ID migration을 background 단일 writer에 보낸다.
 * 삭제 barrier 응답을 받으면 기존 세션을 버리고 현재 시각부터 새 세션으로 다시 추적한다.
 */
(() => {
    const WATCH_HISTORY_MESSAGE_TYPE = "betterChzzk:watch-history-mutation";
    const WATCH_HISTORY_MESSAGE_VERSION = 1;
    const LIVE_DETAIL_API_BASE = "https://api.chzzk.naver.com/service/v2/channels";
    const TRACK_TICK_MS = 5000;
    const FLUSH_MS = 15000;
    const FLUSH_RETRY_BASE_MS = 5000;
    const FLUSH_RETRY_MAX_ATTEMPTS = 5;
    const FLUSH_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
    const METADATA_REFRESH_MS = 60000;
    const FETCH_TIMEOUT_MS = 10000;
    const MAX_TICK_SECONDS = 10;
    const HISTORY_MAX_WATCHED_RANGES_PER_SESSION = 200;

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
        mergeWatchRanges,
        mutationMatchesSelector,
        onReady,
        pickString,
        runtimeSendMessage,
        startPageChangeDetection,
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
    const pendingClosedSessions = new Set();

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
        const mediaTime = getVideoMediaTime(video);
        const previousMediaTime = current.lastMediaTime;
        if (mediaTime !== null) current.lastMediaTime = mediaTime;

        if (!isVideoActive(video) || deltaSeconds <= 0) return false;
        if (mediaTime === null || previousMediaTime === null) return false;
        return mediaTime > previousMediaTime + 0.05;
    }

    function addPendingRange(current, startAt, endAt) {
        if (!current || endAt <= startAt) return;
        current.pendingRanges = mergeWatchRanges([...(current.pendingRanges || []), { startAt, endAt }]);
        current.watchedRanges = mergeWatchRanges([...(current.watchedRanges || []), { startAt, endAt }]).slice(
            -HISTORY_MAX_WATCHED_RANGES_PER_SESSION
        );

        let cursor = startAt;
        while (cursor < endAt) {
            const dateKey = getKstDateKey(cursor);
            const next = Math.min(endAt, getNextKstDayStartMs(cursor));
            const seconds = Math.max(0, (next - cursor) / 1000);
            if (seconds > 0) {
                current.pendingByDate[dateKey] = (Number(current.pendingByDate[dateKey]) || 0) + seconds;
                current.dailySeconds[dateKey] = (Number(current.dailySeconds[dateKey]) || 0) + seconds;
            }
            cursor = next;
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
            channelId: pickString(content.channelId, live.channelId, channel.channelId, channelId),
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
        };
    }

    function mergeMetadata(target, metadata, { persistThumbnail = false, persistTitle = false } = {}) {
        if (!target || !metadata) return;
        const nextChannelName = pickString(metadata.channelName, target.channelName);
        for (const key of ["channelId", "liveId", "channelName", "title", "thumbnailUrl", "liveOpenDate"]) {
            const value = compactSpaces(metadata[key]);
            if (!value) continue;
            if (key === "title") {
                const title = cleanEntryTitle(value, nextChannelName);
                if (title && persistTitle) {
                    target.title = title;
                    target.titleVerified = true;
                    addTitleHistory(target, title);
                } else if (title) {
                    target.provisionalTitle = title;
                }
                continue;
            }
            if (key === "thumbnailUrl" && !persistThumbnail) {
                target.provisionalThumbnailUrl = value;
                continue;
            }
            target[key] = value;
        }
    }

    function createEmptyMetadata(channelId) {
        return {
            channelId,
            liveId: "",
            title: "",
            channelName: "",
            thumbnailUrl: "",
            liveOpenDate: "",
        };
    }

    function isCurrentMetadataRequest(current, requestId, channelId) {
        return (
            requestId === metadataRequestSeq &&
            session === current &&
            getLiveChannelIdFromUrl() === channelId &&
            (!current.channelId || current.channelId === channelId)
        );
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
        const channelId = getLiveChannelIdFromUrl();
        if (!channelId || (current.channelId && current.channelId !== channelId)) return;
        const pageMetadata = inferMetadataFromPage(channelId);

        try {
            const url = `${LIVE_DETAIL_API_BASE}/${encodeURIComponent(channelId)}/live-detail`;
            const json = await fetchJson(url, { timeoutMs: FETCH_TIMEOUT_MS });
            if (!isCurrentMetadataRequest(current, requestId, channelId)) return;
            const nextMetadata = extractMetadataFromLiveDetail(json, channelId);
            if (nextMetadata.channelId !== channelId) return;
            const pinnedLiveId = getPinnedLiveId(current);
            if (pinnedLiveId && nextMetadata.liveId && nextMetadata.liveId !== pinnedLiveId) {
                endSession();
                startSession(nextMetadata);
                return;
            }
            mergeMetadata(current, pageMetadata);
            mergeMetadata(current, nextMetadata, { persistThumbnail: true, persistTitle: true });
            await promoteSessionRecordId(current);
        } catch (_) {
            if (isCurrentMetadataRequest(current, requestId, channelId)) mergeMetadata(current, pageMetadata);
        } finally {
            if (session === current) scheduleMetadataRefresh();
        }
    }

    function getRecordId(current) {
        if (current.recordId) return current.recordId;
        if (current.liveId) return `live:${current.liveId}`;
        return `channel:${current.channelId}:provisional:${current.sessionId}`;
    }

    function getPinnedLiveId(current) {
        for (const recordId of [current?.pendingRecordMigrationTarget, current?.recordId]) {
            if (String(recordId || "").startsWith("live:")) return recordId.slice("live:".length);
        }
        return "";
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

    function buildSessionSnapshot(current) {
        const dailySeconds = {};
        for (const [dateKey, seconds] of Object.entries(current.dailySeconds || {})) {
            const value = Math.max(0, Math.round(Number(seconds) || 0));
            if (value > 0) dailySeconds[dateKey] = value;
        }
        const storedTitle = current.titleVerified ? current.title || "" : "";
        const storedTitleHistory = current.titleVerified ? current.titleHistory || [] : [];
        return {
            kind: "upsertSessionSnapshot",
            recordId: getRecordId(current),
            entry: {
                channelId: current.channelId || "",
                liveId: current.liveId || "",
                title: storedTitle,
                channelName: current.channelName || "",
                thumbnailUrl: current.thumbnailUrl || "",
                liveOpenDate: current.liveOpenDate || "",
                firstWatchedAt: current.startedAt,
                lastWatchedAt: current.lastSeenAt || current.lastWatchedAt || Date.now(),
                titleHistory: storedTitleHistory,
            },
            session: {
                id: current.sessionId,
                title: storedTitle,
                enteredAt: current.enteredAt || current.startedAt,
                leftAt: current.lastSeenAt || current.lastWatchedAt || Date.now(),
                watchedSeconds: Math.max(0, Math.floor(current.watchedSeconds)),
                dailySeconds,
                watchedRanges: mergeWatchRanges(current.watchedRanges).slice(-HISTORY_MAX_WATCHED_RANGES_PER_SESSION),
                closed: current.closed === true,
            },
        };
    }

    async function sendWatchHistoryMutation(operation) {
        const response = await runtimeSendMessage({
            type: WATCH_HISTORY_MESSAGE_TYPE,
            version: WATCH_HISTORY_MESSAGE_VERSION,
            operation,
        });
        if (!response?.ok) throw new Error(response?.error || "Watch history mutation failed");
        return response.result || {};
    }

    async function promoteSessionRecordId(current) {
        if (!current?.liveId) return;
        const pendingSourceRecordId = current.pendingRecordMigrationSource || "";
        const pendingTargetRecordId = current.pendingRecordMigrationTarget || "";
        const existingRecordId = getRecordId(current);
        if (!pendingSourceRecordId && existingRecordId.startsWith("live:")) {
            current.liveId = existingRecordId.slice("live:".length);
            return;
        }

        const sourceRecordId = pendingSourceRecordId || existingRecordId;
        if (!sourceRecordId.startsWith("channel:") || !sourceRecordId.includes(":provisional:")) return;
        const targetRecordId = pendingTargetRecordId || `live:${current.liveId}`;
        const shouldMigrate =
            Boolean(pendingSourceRecordId) || current.storageSessionRecorded || current.flushInProgress;
        current.liveId = targetRecordId.slice("live:".length);
        if (!shouldMigrate) {
            current.recordId = targetRecordId;
            return;
        }

        current.pendingRecordMigrationSource = sourceRecordId;
        current.pendingRecordMigrationTarget = targetRecordId;
        try {
            await sendWatchHistoryMutation({
                kind: "migrateRecordId",
                sourceRecordId,
                targetRecordId,
            });
            if (
                current.pendingRecordMigrationSource === sourceRecordId &&
                current.pendingRecordMigrationTarget === targetRecordId
            ) {
                current.recordId = targetRecordId;
                current.pendingRecordMigrationSource = "";
                current.pendingRecordMigrationTarget = "";
            }
        } catch (_) {
            if (
                current.pendingRecordMigrationSource === sourceRecordId &&
                current.pendingRecordMigrationTarget === targetRecordId
            ) {
                current.recordId = sourceRecordId;
            }
            // 다음 metadata refresh에서 같은 직렬 migration을 다시 시도한다.
        }
    }

    function resetSessionAfterBarrier(current, barrier = 0) {
        if (!current || current.closed === true || session !== current) return;
        const now = Math.max(Date.now(), Math.round(Number(barrier) || 0) + 1);
        current.sessionId = createSessionId();
        current.enteredAt = now;
        current.startedAt = now;
        current.lastWatchedAt = now;
        current.lastSeenAt = now;
        current.watchedSeconds = 0;
        current.dailySeconds = {};
        current.watchedRanges = [];
        current.pendingSeconds = 0;
        current.pendingByDate = {};
        current.pendingRanges = [];
        current.storageSessionRecorded = false;
        current.storageClosed = false;
        current.storageLeftAt = 0;
        current.closed = false;
        current.lastTickAt = performance.now();
        current.lastMediaTime = getVideoMediaTime(attachedVideo);
        current.titleHistory = [];
        current.pendingRecordMigrationSource = "";
        current.pendingRecordMigrationTarget = "";
        if (current.titleVerified) addTitleHistory(current, current.title, now);
        current.recordId = "";
        current.recordId = getRecordId(current);
    }

    function clearFlushRetryTimer(current) {
        if (!current?.flushRetryTimer) return;
        clearTimeout(current.flushRetryTimer);
        current.flushRetryTimer = 0;
    }

    function resetFlushRetryState(current) {
        if (!current) return;
        clearFlushRetryTimer(current);
        current.flushRetryAttempts = 0;
    }

    function finalizeClosedSession(current) {
        if (!current) return;
        resetFlushRetryState(current);
        current.flushFinalized = true;
        pendingClosedSessions.delete(current);
    }

    function scheduleFlushRetry(current, retryForce) {
        if (!current || current.flushFinalized || current.flushRetryTimer) return;
        const burstExhausted = current.flushRetryAttempts >= FLUSH_RETRY_MAX_ATTEMPTS;
        const delayMs = burstExhausted
            ? FLUSH_RETRY_COOLDOWN_MS
            : FLUSH_RETRY_BASE_MS * 2 ** Math.max(0, current.flushRetryAttempts - 1);
        current.flushRetryTimer = setTimeout(() => {
            current.flushRetryTimer = 0;
            if (!current.flushFinalized) {
                if (burstExhausted) current.flushRetryAttempts = 0;
                void flushSession({
                    force: retryForce || current.closed === true,
                    retryAttempt: true,
                    target: current,
                });
            }
        }, delayMs);
    }

    async function flushSession({ force = false, retryAttempt = false, target = session } = {}) {
        const current = target;
        if (!current || current.flushFinalized) return;
        if (current.flushInProgress) {
            current.flushAgainRequested = true;
            current.flushAgainForce = current.flushAgainForce || force || current.closed === true;
            return;
        }
        if (!retryAttempt) resetFlushRetryState(current);

        if (session === current && current.closed !== true) accrueWatchTime();

        const totalWatched = Math.floor(current.watchedSeconds);
        if (totalWatched < getMinSessionSeconds()) {
            if (force && current.closed === true) finalizeClosedSession(current);
            return;
        }

        const snapshot = takePendingSnapshot(current);
        const rangeSnapshot = takePendingRangeSnapshot(current);
        const deltaSeconds = pendingTotal(snapshot);
        const shouldUpdateSession = (force || current.closed === true) && hasStoredSessionStateChange(current);
        if (deltaSeconds <= 0 && !shouldUpdateSession && !current.pendingRecordMigrationSource) {
            if (current.closed === true && current.storageSessionRecorded && current.storageClosed === true) {
                finalizeClosedSession(current);
            }
            return;
        }

        current.flushInProgress = true;
        current.flushAgainRequested = false;
        current.flushAgainForce = false;
        let discardedByBarrier = false;
        let flushFailed = false;
        if (current.pendingRecordMigrationSource) await promoteSessionRecordId(current);
        const operation = buildSessionSnapshot(current);

        try {
            const result = await sendWatchHistoryMutation(operation);
            discardedByBarrier =
                result.status === "ignored" && (result.reason === "deleted" || result.reason === "retired");
            if (discardedByBarrier && operation.recordId === getRecordId(current)) {
                resetSessionAfterBarrier(current, result.barrier);
            } else if (discardedByBarrier) {
                restorePendingSnapshot(current, snapshot);
                restorePendingRangeSnapshot(current, rangeSnapshot);
                current.flushAgainRequested = true;
                current.flushAgainForce = current.flushAgainForce || force;
            } else {
                current.storageSessionRecorded = true;
                current.storageLeftAt = operation.session.leftAt;
                current.storageClosed = operation.session.closed;
                flushFailed = Boolean(current.pendingRecordMigrationSource);
            }
        } catch (_) {
            flushFailed = true;
            restorePendingSnapshot(current, snapshot);
            restorePendingRangeSnapshot(current, rangeSnapshot);
        } finally {
            current.flushInProgress = false;
            const needsFollowUp = current.flushAgainRequested;
            const followUpForce = current.flushAgainForce || current.closed === true;
            current.flushAgainRequested = false;
            current.flushAgainForce = false;
            if (flushFailed) {
                if (needsFollowUp && followUpForce) {
                    void flushSession({ force: true, target: current });
                } else if (force || current.closed === true) {
                    current.flushRetryAttempts = (Number(current.flushRetryAttempts) || 0) + 1;
                    scheduleFlushRetry(current, force);
                } else {
                    resetFlushRetryState(current);
                }
            } else {
                resetFlushRetryState(current);
                if (needsFollowUp) {
                    void flushSession({ force: followUpForce, target: current });
                } else if (current.closed === true) {
                    finalizeClosedSession(current);
                }
            }
        }
    }

    function accrueWatchTime() {
        const current = session;
        if (!current || current.closed === true) return;

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

    function startSession(initialMetadata = null) {
        if (session || !isEnabledForCurrentPage()) return;

        const channelId = getLiveChannelIdFromUrl();
        const pageMetadata = initialMetadata ? null : inferMetadataFromPage(channelId);
        const now = Date.now();

        session = {
            ...createEmptyMetadata(channelId),
            provisionalThumbnailUrl: "",
            provisionalTitle: "",
            titleVerified: false,
            sessionId: createSessionId(),
            enteredAt: now,
            startedAt: now,
            lastWatchedAt: now,
            lastSeenAt: now,
            watchedSeconds: 0,
            dailySeconds: {},
            watchedRanges: [],
            pendingSeconds: 0,
            pendingByDate: {},
            pendingRanges: [],
            storageSessionRecorded: false,
            lastTickAt: performance.now(),
            lastMediaTime: getVideoMediaTime(attachedVideo),
            titleHistory: [],
        };
        if (pageMetadata) mergeMetadata(session, pageMetadata);
        if (initialMetadata) {
            mergeMetadata(session, initialMetadata, { persistThumbnail: true, persistTitle: true });
        }
        session.recordId = getRecordId(session);

        ensureTimers();
        scheduleMetadataRefresh(0);
    }

    function endSession() {
        if (!session) return;
        const current = session;
        accrueWatchTime();
        current.closed = true;
        current.lastSeenAt = Date.now();
        session = null;
        pendingClosedSessions.add(current);
        void flushSession({ force: true, target: current });
        if (metadataTimer) {
            clearTimeout(metadataTimer);
            metadataTimer = 0;
        }
    }

    function ensureTimers() {
        if (!tickTimer) tickTimer = setInterval(runTrackingTick, TRACK_TICK_MS);
        if (!flushTimer) flushTimer = setInterval(() => flushSession({ force: session?.closed === true }), FLUSH_MS);
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

    function onVideoEnded() {
        endSession();
    }

    function detachVideo() {
        if (!attachedVideo) return;
        attachedVideo.removeEventListener("play", onVideoPlay, true);
        attachedVideo.removeEventListener("playing", onVideoPlay, true);
        attachedVideo.removeEventListener("pause", onVideoPause, true);
        attachedVideo.removeEventListener("ended", onVideoEnded, true);
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
        attachedVideo.addEventListener("ended", onVideoEnded, true);
        attachedVideo.addEventListener("waiting", onVideoPause, true);

        if (session) scheduleMetadataRefresh(0);
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

    function installRuntime() {
        if (runtimeInstalled) return;
        runtimeInstalled = true;
        installLifecycleListeners();
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
        for (const current of pendingClosedSessions) {
            void flushSession({ force: true, target: current });
        }
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
