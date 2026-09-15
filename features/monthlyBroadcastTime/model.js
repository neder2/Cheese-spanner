/** Broadcast data normalization and calendar arithmetic; no UI or request state. */
(() => {
    const root = (globalThis.BetterChzzk = globalThis.BetterChzzk || {});
    const {
        pickArray,
        pickChzzkVideoNo,
        pickVideoStartDateText,
        pickVideoEndDateText,
        parseChzzkDate,
        normSpace,
        getKstParts,
        getKstDateKey,
        formatKstTime: formatKstClock,
    } = root.utils;
    const {
        formatKstDateKey: formatDateKey,
        getUniqueWatchTotals,
        normalizeSessionWatchRanges,
        normalizeDailySeconds: normalizeWatchDailySeconds,
        sumWatchRanges,
    } = root.utils;
    const WATCH_MATCH_START_TOLERANCE_MS = 60 * 60 * 1000;
    const WATCH_MATCH_OVERLAP_GRACE_MS = 10 * 60 * 1000;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
    const MINUTE_SECONDS = 60;
    function extractVideos(json) {
        const content = json?.content ?? json;
        const rows = pickArray(content);
        if (!rows) return [];

        return rows
            .map((row) => {
                const videoNo = pickChzzkVideoNo(row);
                const type = row.videoType || row.type || "";
                const duration = Number(row.duration);
                const startDateText = pickVideoStartDateText(row);
                const endDateText = pickVideoEndDateText(row);

                if (!videoNo || !Number.isFinite(duration) || duration <= 0) return null;
                return {
                    videoNo,
                    type: String(type || ""),
                    title: normSpace(row.videoTitle || row.title || row.liveTitle || ""),
                    duration,
                    startedAt: parseChzzkDate(startDateText),
                    startIsExact: Boolean(startDateText),
                    endedAt: parseChzzkDate(endDateText),
                };
            })
            .filter(Boolean);
    }

    function normalizeMatchText(value) {
        return normSpace(value)
            .toLowerCase()
            .replace(/\s*[-|]\s*(?:chzzk|치지직).*$/i, "")
            .replace(/[^\p{L}\p{N}]+/gu, "");
    }

    function mergeVideoDetail(video, detail) {
        if (!video || !detail) return;

        const normalized = BetterChzzk.vodTimeline.normalizeVideoDetail(detail);
        if (Number.isFinite(normalized.durationSeconds)) {
            video.duration = normalized.durationSeconds;
        }

        const title = normSpace(detail.videoTitle || detail.title || detail.liveTitle || "");
        if (title) video.title = title;

        if (Number.isFinite(normalized.startMs)) {
            video.startedAt = new Date(normalized.startMs);
            video.startIsExact = true;
        }
        if (Number.isFinite(normalized.endMs)) video.endedAt = new Date(normalized.endMs);
    }

    function shouldFetchStartDetail(video, monthInfo) {
        if (!video || video.startIsExact || !replayOnly(video)) return false;

        const startMs = getVideoStartMs(video);
        const endMs = getVideoEndMs(video);
        if (startMs === null && endMs === null) return true;

        const lower = startMs ?? endMs;
        const upper = endMs ?? startMs;
        return upper >= monthInfo.startMs && lower < monthInfo.nextStartMs;
    }

    function replayOnly(video) {
        return !video.type || video.type.toUpperCase() === "REPLAY";
    }

    function getVideoEndMs(video) {
        if (!video) return null;
        // publishDate는 VOD 처리 완료 시각이라 지연될 수 있으므로, 방송 시작과 길이가 있으면 이를 우선한다.
        if (video.startedAt && Number.isFinite(video.duration)) {
            const startMs = video.startedAt.getTime();
            if (Number.isFinite(startMs)) return startMs + video.duration * 1000;
        }
        if (video.endedAt) {
            const endMs = video.endedAt.getTime();
            if (Number.isFinite(endMs)) return endMs;
        }
        return null;
    }

    function getVideoStartMs(video) {
        if (!video) return null;
        if (video.startedAt) {
            const startMs = video.startedAt.getTime();
            if (Number.isFinite(startMs)) return startMs;
        }
        const endMs = getVideoEndMs(video);
        if (endMs === null || !Number.isFinite(video.duration)) return null;
        return endMs - video.duration * 1000;
    }

    function estimateOverlapSeconds(video, windowStart, windowEnd) {
        const startMs = getVideoStartMs(video);
        const endMs = getVideoEndMs(video);
        if (startMs === null || endMs === null) return 0;

        const overlapStart = Math.max(startMs, windowStart);
        const overlapEnd = Math.min(endMs, windowEnd);
        const overlapMs = overlapEnd - overlapStart;

        if (overlapMs <= 0) return 0;
        return Math.min(video.duration, Math.round(overlapMs / 1000));
    }

    function getKstMonthInfo(nowMs = Date.now(), targetYear = null, targetMonth = null) {
        const nowParts = getKstParts(nowMs);
        const year = targetYear || nowParts.year;
        const month = targetMonth || nowParts.month;
        const nextYear = month === 12 ? year + 1 : year;
        const nextMonth = month === 12 ? 1 : month + 1;
        const startMs = Date.UTC(year, month - 1, 1) - KST_OFFSET_MS;
        const nextStartMs = Date.UTC(nextYear, nextMonth - 1, 1) - KST_OFFSET_MS;
        const daysInMonth = Math.round((nextStartMs - startMs) / DAY_MS);
        const isCurrentMonth = year === nowParts.year && month === nowParts.month;

        return {
            year,
            month,
            today: isCurrentMonth ? nowParts.day : 0,
            startMs,
            nextStartMs,
            firstWeekday: getKstParts(startMs).weekday,
            daysInMonth,
            dailySeconds: {},
            broadcastSecondsByDate: {},
            startsByDate: {},
            startKeyIndex: {},
        };
    }

    function addMonthStart(video, monthInfo, nowMs) {
        const startMs = getVideoStartMs(video);
        if (startMs === null || startMs >= monthInfo.nextStartMs || startMs > nowMs) {
            return;
        }

        const key = getKstDateKey(startMs);
        const startKey = `${key}-${Math.floor(startMs / 60000)}`;
        const duration = Number(video.duration) || 0;
        if (duration <= 0) return;
        const endMs = getVideoEndMs(video) ?? startMs + duration * 1000;
        const title = normSpace(video.title);
        const titleKey = normalizeMatchText(title);
        const incoming = {
            time: formatKstClock(startMs),
            startMs,
            endMs,
            duration,
            exact: video.startIsExact === true,
            videoNo: video.videoNo,
            title,
            titleKey,
        };

        const existing = monthInfo.startKeyIndex[startKey];
        const entry = BetterChzzk.vodTimeline.mergeBroadcastSegment(existing, incoming);
        monthInfo.startKeyIndex[startKey] = entry;
        // Earlier starts can cover this month; their duration total stays in the start month.
        if (startMs < monthInfo.startMs) return;

        monthInfo.dailySeconds[key] = (monthInfo.dailySeconds[key] || 0) + duration;
        monthInfo.startsByDate[key] = monthInfo.startsByDate[key] || [];
        if (existing) {
            const existingIndex = monthInfo.startsByDate[key].indexOf(existing);
            if (existingIndex >= 0) monthInfo.startsByDate[key][existingIndex] = entry;
            else monthInfo.startsByDate[key].push(entry);
            return;
        }

        monthInfo.startsByDate[key].push(entry);
    }

    function finalizeMonthInfo(monthInfo, nowMs = Date.now()) {
        const coverage = {};
        // Split VODs must be merged before spreading their covered interval across KST dates.
        for (const start of Object.values(monthInfo.startKeyIndex)) {
            const from = Math.max(start.startMs, monthInfo.startMs);
            const to = Math.min(start.endMs, monthInfo.nextStartMs, nowMs);
            if (to <= from) continue;
            const firstDayMs = Math.floor((from + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
            for (let dayMs = firstDayMs; dayMs < to; dayMs += DAY_MS) {
                const seconds = (Math.min(to, dayMs + DAY_MS) - Math.max(from, dayMs)) / 1000;
                const key = getKstDateKey(dayMs);
                coverage[key] = (coverage[key] || 0) + seconds;
            }
        }
        monthInfo.broadcastSecondsByDate = coverage;
        monthInfo.broadcastDayCount = Object.values(coverage).filter((seconds) => seconds >= MINUTE_SECONDS).length;
        return monthInfo;
    }

    function pageIsOlderThan(videos, rows, startMs) {
        // Filtered-out rows cannot prove that the entire source page is older.
        return (
            videos.length > 0 &&
            videos.length === rows.length &&
            videos.every((video) => {
                const endMs = getVideoEndMs(video);
                return endMs !== null && endMs < startMs;
            })
        );
    }
    function getNumericMs(value) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : 0;
    }

    function normalizeWatchSessionDetails(value) {
        if (!Array.isArray(value)) return [];
        const sessions = value
            .filter((session) => session && typeof session === "object")
            .map((session) => {
                const enteredAt = Number(session.enteredAt) || Number(session.startedAt) || 0;
                const leftAt = Number(session.leftAt) || Number(session.endedAt) || Number(session.lastWatchedAt) || 0;
                const watchedRanges = normalizeSessionWatchRanges(session);
                return {
                    id: normSpace(session.id) || `${enteredAt}:${leftAt}`,
                    enteredAt,
                    leftAt,
                    watchedSeconds: Math.max(0, Number(session.watchedSeconds) || sumWatchRanges(watchedRanges)),
                    dailySeconds: normalizeWatchDailySeconds(session.dailySeconds),
                    watchedRanges,
                };
            })
            .filter((session) => session.id && session.enteredAt > 0 && session.watchedSeconds >= MINUTE_SECONDS);

        return sessions;
    }

    function getWatchSessionFirstWatchedAt(sessionDetails) {
        const values = (sessionDetails || [])
            .map((session) => Number(session.enteredAt) || 0)
            .filter((value) => value > 0);
        return values.length ? Math.min(...values) : 0;
    }

    function getWatchSessionLastWatchedAt(sessionDetails) {
        const values = (sessionDetails || [])
            .map((session) => Number(session.leftAt) || Number(session.enteredAt) || 0)
            .filter((value) => value > 0);
        return values.length ? Math.max(...values) : 0;
    }

    function normalizeWatchHistory(raw) {
        const source = raw && typeof raw === "object" ? raw : {};
        const rows = Array.isArray(source.entries)
            ? source.entries
            : source.entries && typeof source.entries === "object"
              ? Object.values(source.entries)
              : [];

        return rows
            .filter((row) => row && typeof row === "object")
            .map((row) => {
                const hasSessionDetails = Array.isArray(row.sessionDetails);
                const sessionDetails = normalizeWatchSessionDetails(row.sessionDetails);
                const storedDailySeconds = normalizeWatchDailySeconds(row.dailySeconds);
                const storedWatchedSeconds = Math.max(0, Number(row.watchedSeconds) || 0);
                const uniqueTotals = hasSessionDetails
                    ? getUniqueWatchTotals(
                          { watchedSeconds: storedWatchedSeconds, dailySeconds: storedDailySeconds },
                          sessionDetails
                      )
                    : { watchedSeconds: storedWatchedSeconds, dailySeconds: storedDailySeconds };
                const storedFirstWatchedAt = getNumericMs(row.firstWatchedAt);
                const storedLastWatchedAt = getNumericMs(row.lastWatchedAt);
                const sessionFirstWatchedAt = hasSessionDetails ? getWatchSessionFirstWatchedAt(sessionDetails) : 0;
                const sessionLastWatchedAt = hasSessionDetails ? getWatchSessionLastWatchedAt(sessionDetails) : 0;
                const firstWatchedAt =
                    storedFirstWatchedAt && sessionFirstWatchedAt
                        ? Math.min(storedFirstWatchedAt, sessionFirstWatchedAt)
                        : storedFirstWatchedAt || sessionFirstWatchedAt;
                const lastWatchedAt = Math.max(storedLastWatchedAt, sessionLastWatchedAt);
                return {
                    id: normSpace(row.id),
                    channelId: normSpace(row.channelId),
                    liveId: normSpace(row.liveId),
                    replayVideoNo: normSpace(row.replayVideoNo),
                    title: normSpace(row.title),
                    titleKey: normalizeMatchText(row.title),
                    liveOpenMs: parseChzzkDate(row.liveOpenDate)?.getTime() || 0,
                    firstWatchedAt,
                    lastWatchedAt,
                    watchedSeconds: uniqueTotals.watchedSeconds,
                    dailySeconds: uniqueTotals.dailySeconds,
                };
            })
            .filter((entry) => entry.id && entry.channelId && entry.watchedSeconds >= MINUTE_SECONDS);
    }

    function getEntryDailySeconds(entry, dateKey) {
        return Math.max(0, Number(entry?.dailySeconds?.[dateKey]) || 0);
    }

    function entryOverlapsStart(entry, start) {
        if (!entry?.firstWatchedAt || !entry?.lastWatchedAt || !start?.startMs) return false;
        const startMs = start.startMs - WATCH_MATCH_OVERLAP_GRACE_MS;
        const endMs = (start.endMs || start.startMs + start.duration * 1000) + WATCH_MATCH_OVERLAP_GRACE_MS;
        return entry.firstWatchedAt <= endMs && entry.lastWatchedAt >= startMs;
    }

    function entryHasSameLiveOpen(entry, start) {
        return Boolean(
            entry?.liveOpenMs &&
            start?.startMs &&
            Math.abs(entry.liveOpenMs - start.startMs) <= WATCH_MATCH_START_TOLERANCE_MS
        );
    }

    function entryMatchesStartDate(entry, start) {
        if (!start?.startMs) return false;
        const startKey = formatDateKey(getKstParts(start.startMs));
        const endKey = start.endMs ? formatDateKey(getKstParts(start.endMs)) : startKey;
        return getEntryDailySeconds(entry, startKey) > 0 || getEntryDailySeconds(entry, endKey) > 0;
    }

    function entryMatchesStartTitle(entry, start) {
        if (!entry?.titleKey || !start?.titleKey) return false;
        return entry.titleKey === start.titleKey;
    }

    function getWatchMatchScore(entry, start) {
        if (!entry || !start) return 0;
        if (entry.replayVideoNo && start.videoNos?.includes(entry.replayVideoNo)) return 120;

        let score = 0;
        if (entryHasSameLiveOpen(entry, start)) score += 80;
        if (entryOverlapsStart(entry, start)) score += 60;
        if (entryMatchesStartTitle(entry, start)) score += 30;
        if (entryMatchesStartDate(entry, start)) score += 15;
        return score;
    }

    function getStartWatchInfo(watchHistoryEntries, channelId, start) {
        const duration = Math.max(0, Number(start?.duration) || 0);
        if (!channelId || !start || duration <= 0) return null;

        const seen = new Set();
        let watchedSeconds = 0;
        for (const entry of watchHistoryEntries) {
            if (entry.channelId !== channelId || seen.has(entry.id)) continue;
            if (entry.watchedSeconds < MINUTE_SECONDS) continue;
            const score = getWatchMatchScore(entry, start);
            if (score < 60) continue;
            seen.add(entry.id);
            watchedSeconds += entry.watchedSeconds;
        }

        const clampedSeconds = Math.min(watchedSeconds, duration);
        const percent = duration > 0 ? Math.min(100, (clampedSeconds / duration) * 100) : 0;
        return {
            seconds: clampedSeconds,
            percent,
        };
    }

    function getChannelWatchSeconds(watchHistoryEntries, channelId) {
        if (!channelId) return 0;
        return watchHistoryEntries.reduce((sum, entry) => {
            if (entry.channelId !== channelId) return sum;
            return sum + Math.max(0, Number(entry.watchedSeconds) || 0);
        }, 0);
    }

    function getMonthBroadcastSeconds(month) {
        return Object.values(month?.dailySeconds || {}).reduce(
            (sum, seconds) => sum + Math.max(0, Number(seconds) || 0),
            0
        );
    }

    function getMonthReplayCount(month) {
        return Object.values(month?.startsByDate || {}).reduce(
            (sum, starts) => sum + (Array.isArray(starts) ? starts.length : 0),
            0
        );
    }

    function getMonthAverageSeconds(month) {
        const broadcastDays = Math.max(0, Number(month?.broadcastDayCount) || 0);
        if (broadcastDays <= 0) return 0;
        return getMonthBroadcastSeconds(month) / broadcastDays;
    }

    function getMonthCalendarAverageSeconds(month) {
        const calendarDays = Math.max(0, Number(month?.today || month?.daysInMonth) || 0);
        if (calendarDays <= 0) return 0;
        return getMonthBroadcastSeconds(month) / calendarDays;
    }

    function shiftMonth(year, month, delta) {
        const index = year * 12 + (month - 1) + delta;
        return {
            year: Math.floor(index / 12),
            month: (index % 12) + 1,
        };
    }

    function compareMonth(aYear, aMonth, bYear, bMonth) {
        return aYear * 12 + aMonth - (bYear * 12 + bMonth);
    }

    function isFutureMonth(year, month, nowMs = Date.now()) {
        const nowParts = getKstParts(nowMs);
        return compareMonth(year, month, nowParts.year, nowParts.month) > 0;
    }
    root.monthlyBroadcastModel = Object.freeze({
        getNumericMs,
        normalizeWatchSessionDetails,
        getWatchSessionFirstWatchedAt,
        getWatchSessionLastWatchedAt,
        normalizeWatchHistory,
        getEntryDailySeconds,
        entryOverlapsStart,
        entryHasSameLiveOpen,
        entryMatchesStartDate,
        entryMatchesStartTitle,
        getWatchMatchScore,
        getStartWatchInfo,
        getChannelWatchSeconds,
        getMonthBroadcastSeconds,
        getMonthReplayCount,
        getMonthAverageSeconds,
        getMonthCalendarAverageSeconds,
        shiftMonth,
        compareMonth,
        isFutureMonth,
        extractVideos,
        normalizeMatchText,
        mergeVideoDetail,
        shouldFetchStartDetail,
        replayOnly,
        getVideoEndMs,
        getVideoStartMs,
        estimateOverlapSeconds,
        getKstMonthInfo,
        addMonthStart,
        finalizeMonthInfo,
        pageIsOlderThan,
    });
})();
