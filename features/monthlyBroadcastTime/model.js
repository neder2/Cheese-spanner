/** Broadcast data normalization and calendar arithmetic; no UI or request state. */
(() => {
    const root = (globalThis.CheeseSpanner = globalThis.CheeseSpanner || {});
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
    // A start read from the replay detail is the broadcast's own open time; only list estimates
    // (publishDate - duration) need the wider tolerance.
    const WATCH_MATCH_EXACT_START_TOLERANCE_MS = 20 * 60 * 1000;
    // Same rule shared/vodTimeline.js uses to confirm split segments of one broadcast. Only an exact replay
    // start this close to the record's own live open time is the same broadcast; a restart can follow in minutes.
    const WATCH_MATCH_SAME_BROADCAST_OPEN_MS = 60 * 1000;
    // Only list estimates get a grace: their start can be off by the publish delay.
    const WATCH_MATCH_OVERLAP_GRACE_MS = 10 * 60 * 1000;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
    const MINUTE_SECONDS = 60;
    // Same split rule as shared/vodTimeline.js: every segment but the newest is a full 17 hours.
    const SPLIT_SEGMENT_SECONDS = 17 * 60 * 60;
    const SPLIT_DURATION_TOLERANCE_SECONDS = 2 * 60;
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

        const normalized = CheeseSpanner.vodTimeline.normalizeVideoDetail(detail);
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

    function getPublishedMs(video) {
        const publishedMs = video?.endedAt?.getTime();
        return Number.isFinite(publishedMs) ? publishedMs : NaN;
    }

    function compareSplitSegments(a, b) {
        const aPublishedMs = getPublishedMs(a.video);
        const bPublishedMs = getPublishedMs(b.video);
        if (Number.isFinite(aPublishedMs) && Number.isFinite(bPublishedMs) && aPublishedMs !== bPublishedMs) {
            return aPublishedMs - bPublishedMs;
        }
        // The channel list is newest first, so a later row is the earlier segment.
        return b.order - a.order;
    }

    function isSplitSegmentRun(segments) {
        return (
            segments.length > 1 &&
            segments
                .slice(0, -1)
                .every(
                    ({ video }) =>
                        Math.abs((Number(video.duration) || 0) - SPLIT_SEGMENT_SECONDS) <=
                        SPLIT_DURATION_TOLERANCE_SECONDS
                )
        );
    }

    function getResolvedSegmentOffsetMs(video) {
        const offsetMs = Number(video?.segmentOffsetMs);
        return Number.isFinite(offsetMs) && offsetMs > 0 ? offsetMs : 0;
    }

    function getVideoSegmentEndMs(video) {
        // The repository resolves a later split segment's offset from its confirmed segment links.
        const offsetMs = getResolvedSegmentOffsetMs(video);
        const startMs = getVideoStartMs(video);
        const duration = Number(video?.duration);
        if (offsetMs > 0 && startMs !== null && Number.isFinite(duration)) return startMs + offsetMs + duration * 1000;
        return getVideoEndMs(video);
    }

    function isUnplacedEstimate(video) {
        // A replay whose own detail could not be read has no proven start: its publish estimate
        // (publishDate - duration) is only an upper bound on its position, since a replay ends no later than its
        // publish time but the publish delay can be hours. Nothing bounds how much earlier it aired, so no part of
        // the estimate is proven to fall inside a window. This holds for any length: a short last split segment
        // or an ordinary replay published hours later can lie wholly before the window its estimate reaches.
        return video?.startIsExact !== true && video?.startDetailUnresolved === true;
    }

    function shiftBeforeConfirmedIntervals(placement, confirmed) {
        // A publish estimate is never earlier than the broadcast and a channel airs one broadcast at a time, so
        // an estimate that overlaps a detail-placed interval aired before it: move it to end there. This only
        // removes that double count; it does not prove the estimate's remaining position (see
        // isUnplacedEstimate for the estimates that are left out instead).
        for (let pass = 0; pass <= confirmed.length; pass++) {
            const blocker = confirmed.find(
                (interval) => placement.startMs < interval.endMs && placement.endMs > interval.startMs
            );
            if (!blocker) return;
            const shiftMs = placement.endMs - blocker.startMs;
            placement.startMs -= shiftMs;
            placement.endMs -= shiftMs;
        }
    }

    function summarizeWindowOverlap(videos, windowStart, windowEnd) {
        // Split VODs all report the broadcast start. Place each segment at its resolved offset, or end to end
        // after the earlier segments of the same start that were seen; measuring each from the broadcast start
        // would push later segments out of a window boundary. The first seen segment need not be the first one.
        const groups = new Map();
        (videos || []).forEach((video, order) => {
            const startMs = getVideoStartMs(video);
            if (startMs === null) return;
            const key = Math.floor(startMs / 60000);
            const group = groups.get(key) || { startMs, segments: [] };
            group.segments.push({ video, order });
            groups.set(key, group);
        });

        const placements = [];
        for (const group of groups.values()) {
            const segments = group.segments.sort(compareSplitSegments);
            const splitRun = isSplitSegmentRun(segments);
            let sequentialOffsetMs = 0;
            for (const { video } of segments) {
                const duration = Math.max(0, Number(video.duration) || 0);
                // Earlier seen segments are a lower bound; a resolved offset also counts unseen earlier ones.
                const offsetMs = Math.max(getResolvedSegmentOffsetMs(video), splitRun ? sequentialOffsetMs : 0);
                sequentialOffsetMs = offsetMs + duration * 1000;
                const startMs = getVideoStartMs(video);
                if (offsetMs <= 0) {
                    const endMs = getVideoEndMs(video);
                    if (startMs === null || endMs === null) continue;
                    placements.push({ video, duration, startMs, endMs });
                    continue;
                }
                const segmentStartMs = startMs + offsetMs;
                placements.push({ video, duration, startMs: segmentStartMs, endMs: segmentStartMs + duration * 1000 });
            }
        }

        // Only replays placed from their own detail (and its segment links) are evidence; a list row's start
        // alone cannot place a later split segment.
        const confirmed = placements.filter(
            ({ video, startMs, endMs }) =>
                video.startIsExact === true && typeof video.segmentOffsetMs === "number" && endMs > startMs
        );
        let totalSeconds = 0;
        let replayCount = 0;
        // Set when an estimate that may reach the window was left out, so the total is only a lower bound.
        let incomplete = false;
        for (const placement of placements) {
            if (isUnplacedEstimate(placement.video)) {
                // Its true end is no later than the estimate's end (the publish time): one before the window
                // start proves no window time is lost.
                if (placement.endMs > windowStart) incomplete = true;
                continue;
            }
            if (placement.video.startIsExact !== true) shiftBeforeConfirmedIntervals(placement, confirmed);
            const overlapMs = Math.min(placement.endMs, windowEnd) - Math.max(placement.startMs, windowStart);
            const seconds = overlapMs > 0 ? Math.min(placement.duration, Math.round(overlapMs / 1000)) : 0;
            if (seconds < MINUTE_SECONDS) continue;
            totalSeconds += seconds;
            replayCount++;
        }
        return { totalSeconds, replayCount, incomplete };
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
        const entry = CheeseSpanner.vodTimeline.mergeBroadcastSegment(existing, incoming);
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

    function pageIsOlderThan(videos, rows, startMs, getEndMs = getVideoEndMs) {
        // Filtered-out rows cannot prove that the entire source page is older.
        return (
            videos.length > 0 &&
            videos.length === rows.length &&
            videos.every((video) => {
                const endMs = getEndMs(video);
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
        const broadcastEndMs = start.endMs || start.startMs + start.duration * 1000;
        if (start.exact === true) {
            // An exact start is the broadcast's own open time, and a record can only have watched it while it
            // was live. Any grace would let a record that ended seconds before a quick restart count as watching
            // it, so only a real overlap is evidence.
            return entry.firstWatchedAt < broadcastEndMs && entry.lastWatchedAt > start.startMs;
        }
        // List estimates (publishDate - duration) can be off by the publish delay.
        const startMs = start.startMs - WATCH_MATCH_OVERLAP_GRACE_MS;
        const endMs = broadcastEndMs + WATCH_MATCH_OVERLAP_GRACE_MS;
        return entry.firstWatchedAt <= endMs && entry.lastWatchedAt >= startMs;
    }

    function getLiveOpenToleranceMs(start) {
        return start?.exact === true ? WATCH_MATCH_EXACT_START_TOLERANCE_MS : WATCH_MATCH_START_TOLERANCE_MS;
    }

    function entryHasSameLiveOpen(entry, start) {
        return Boolean(
            entry?.liveOpenMs &&
            start?.startMs &&
            Math.abs(entry.liveOpenMs - start.startMs) <= getLiveOpenToleranceMs(start)
        );
    }

    function entryOpensAtExactStart(entry, start) {
        return Boolean(
            start?.exact === true &&
            entry?.liveOpenMs &&
            start?.startMs &&
            Math.abs(entry.liveOpenMs - start.startMs) <= WATCH_MATCH_SAME_BROADCAST_OPEN_MS
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

        // A record's own live open time or replay link that points at another broadcast outweighs the
        // loose watch-time overlap, which also spans a restart within the overlap grace.
        const sameLiveOpen = entryHasSameLiveOpen(entry, start);
        if (entry.liveOpenMs && start.startMs && !sameLiveOpen) return 0;
        // A link to a replay outside this start is kept only when the record opened at this exact start, as
        // a split segment the list did not reach would. A nearby start is a restart, not the same broadcast.
        if (entry.replayVideoNo && start.videoNos?.length && !entryOpensAtExactStart(entry, start)) return 0;

        let score = 0;
        // An exact start within the wider tolerance but not at the record's open time is no evidence alone.
        if (start.exact === true ? entryOpensAtExactStart(entry, start) : sameLiveOpen) score += 80;
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
        entryOpensAtExactStart,
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
        getVideoSegmentEndMs,
        summarizeWindowOverlap,
        getKstMonthInfo,
        addMonthStart,
        finalizeMonthInfo,
        pageIsOlderThan,
    });
})();
