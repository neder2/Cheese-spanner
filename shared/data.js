/**
 * shared/data.js — DOM에 의존하지 않는 데이터 유틸 (BetterChzzk.utils에 병합 등록)
 *
 * 실행 컨텍스트: isolated world 콘텐츠 스크립트 + 확장 페이지(history.html) + background service worker.
 *   content.js보다 먼저 로드되고, content.js는 여기 등록된 동명 유틸(compactSpaces, normalizeCompact,
 *   isLastPage)을 재사용한다. service worker에서도 쓰므로 DOM 전역을 무가드로 참조하지 않는다.
 * 하는 일:
 *   - 치지직 API 응답 파싱: pickArray, pickChzzkVideoNo, pickVideoStartDateText/pickVideoEndDateText,
 *     isLastPage(페이지네이션 종료 판정), parseChzzkDate(KST 가정 날짜 파싱).
 *   - 제목 정리·매칭: cleanTitle/cleanEntryTitle(채널명 접두 제거), normalizeForMatch.
 *   - KST 날짜 계산: getKstParts, getKstDateKey, getKstDateScopeBounds, formatKstDateTime 등.
 *   - 시청 구간 집계: mergeWatchRanges, getWatchSessionRanges(watchedRanges 없으면 dailySeconds로 폴백),
 *     collectWatchSessionRanges, addWatchRangeToRangesByDate, sumWatchRangesByDate.
 *   - 제목 이력: normalizeTitleHistory, addTitleHistory.
 *   - 인프라: fetchJson(타임아웃+credentials include), storageGet/storageSet/storageRemove 프라미스 래퍼,
 *     getCommentDeviceId/fetchChzzkCommentPage(공용 댓글 읽기), startStorageChangeListener,
 *     touchMapEntry(LRU 캐시 헬퍼).
 * 소비자: background.js, liveWatchHistory.js, vodBroadcastClock.js, monthlyBroadcastTime.js, history.js 등
 *   시청 기록 계열 중심.
 */
(() => {
    const root = (globalThis.BetterChzzk = globalThis.BetterChzzk || {});
    const ARRAY_RESPONSE_KEYS = Object.freeze(["data", "videos", "list", "items", "content"]);
    const DEFAULT_WATCH_RANGE_MERGE_GAP_MS = 2000;
    const COMMENT_API_BASE = "https://apis.naver.com/nng_main/nng_comment_api/v1";
    const COMMENT_DEVICE_ID_STORAGE_KEY = "betterchzzkCommentDeviceId";
    const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
    const DAY_MS = 24 * 60 * 60 * 1000;
    let commentDeviceId = "";
    let commentDeviceIdPromise = null;

    function pickArray(obj, keys = ARRAY_RESPONSE_KEYS) {
        if (!obj || typeof obj !== "object") return null;
        if (Array.isArray(obj)) return obj;

        for (const key of keys) {
            if (Array.isArray(obj[key])) return obj[key];
        }

        for (const value of Object.values(obj)) {
            if (Array.isArray(value) && value.length && typeof value[0] === "object") return value;
        }

        return null;
    }

    function isLastPage(json, rows, pageSize) {
        const content = json?.content ?? json;
        if (!content) return true;
        if (typeof content.totalPages === "number" && typeof content.page?.number === "number") {
            return content.page.number >= content.totalPages - 1;
        }
        if (typeof content.last === "boolean") return content.last;
        return rows.length < pageSize;
    }

    function compactSpaces(value) {
        return String(value || "")
            .replace(/\s+/g, " ")
            .trim();
    }

    function normalizeCompact(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/\s+/g, "");
    }

    function pickString(...values) {
        for (const value of values) {
            const text = compactSpaces(value);
            if (text) return text;
        }
        return "";
    }

    function pickChzzkVideoNo(value) {
        return pickString(value?.videoNo, value?.videoId, value?.id);
    }

    function pickVideoStartDateText(value) {
        return pickString(
            value?.liveOpenDate,
            value?.openDate,
            value?.broadcastOpenDate,
            value?.liveStartDate,
            value?.startDate,
            value?.broadcastStartDate,
            value?.live?.liveOpenDate,
            value?.live?.openDate,
            value?.live?.liveStartDate,
            value?.live?.startDate
        );
    }

    function pickVideoEndDateText(value) {
        return pickString(
            value?.liveCloseDate,
            value?.closeDate,
            value?.broadcastCloseDate,
            value?.liveEndDate,
            value?.endDate,
            value?.broadcastEndDate,
            value?.live?.liveCloseDate,
            value?.live?.closeDate,
            value?.live?.liveEndDate,
            value?.live?.endDate,
            value?.publishDateAt,
            value?.publishDate,
            value?.createdDate
        );
    }

    function cleanTitle(value) {
        return compactSpaces(value)
            .replace(/\s*[-|]\s*CHZZK.*$/i, "")
            .replace(/\s*[-|]\s*\uCE58\uC9C0\uC9C1.*$/i, "")
            .trim();
    }

    function escapeRegExp(value) {
        return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function cleanEntryTitle(value, channelName = "") {
        const title = cleanTitle(value);
        const channel = cleanTitle(channelName);
        if (!title || !channel) return title;

        const match = title.match(new RegExp(`^${escapeRegExp(channel)}\\s*[-|:\u00B7]\\s*(.+)$`, "i"));
        return match ? cleanTitle(match[1]) || title : title;
    }

    function normalizeForMatch(value) {
        return compactSpaces(value)
            .toLowerCase()
            .replace(/[^\p{Letter}\p{Number}]+/gu, "");
    }

    function parseChzzkDate(value) {
        if (!value) return null;
        if (typeof value === "number") {
            const ms = value > 100000000000 ? value : value * 1000;
            const date = new Date(ms);
            return Number.isNaN(date.getTime()) ? null : date;
        }

        const raw = String(value).trim();
        if (!raw) return null;

        const isoLike = raw.includes("T") ? raw : raw.replace(" ", "T");
        const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(isoLike) ? isoLike : `${isoLike}+09:00`;
        const date = new Date(withZone);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    function pad2(value) {
        return String(value).padStart(2, "0");
    }

    function getKstParts(ms = Date.now()) {
        const date = new Date(Number(ms) + KST_OFFSET_MS);
        return {
            year: date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate(),
            weekday: date.getUTCDay(),
            hours: date.getUTCHours(),
            minutes: date.getUTCMinutes(),
            seconds: date.getUTCSeconds(),
        };
    }

    function formatKstDateKey(parts) {
        return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
    }

    function getKstDateKey(ms = Date.now()) {
        return formatKstDateKey(getKstParts(ms));
    }

    function formatKstMonthKey(year, month) {
        return `${year}-${pad2(month)}`;
    }

    function parseKstDateKeyParts(dateKey) {
        const parts = String(dateKey || "")
            .split("-")
            .map(Number);
        if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) return null;
        return { year: parts[0], month: parts[1], day: parts[2] };
    }

    function getKstDayStartMsFromParts(parts) {
        if (!parts) return NaN;
        return Date.UTC(parts.year, parts.month - 1, parts.day) - KST_OFFSET_MS;
    }

    function getKstDayStartMs(dateKey) {
        return getKstDayStartMsFromParts(parseKstDateKeyParts(dateKey));
    }

    function getKstDateScopeBounds(dateKey) {
        const startMs = getKstDayStartMs(dateKey);
        return Number.isFinite(startMs) ? { startMs, endMs: startMs + DAY_MS } : null;
    }

    function getKstMonthStartMs(year, month) {
        return Date.UTC(year, month - 1, 1) - KST_OFFSET_MS;
    }

    function getNextKstDayStartMs(ms) {
        const parts = getKstParts(ms);
        return Date.UTC(parts.year, parts.month - 1, parts.day + 1) - KST_OFFSET_MS;
    }

    function isSameKstDate(a, b) {
        const first = getKstParts(a);
        const second = getKstParts(b);
        return first.year === second.year && first.month === second.month && first.day === second.day;
    }

    function formatKstDateTime(ms, { seconds = false } = {}) {
        const parts = getKstParts(ms);
        const secondText = seconds ? `:${pad2(parts.seconds)}` : "";
        return `${parts.year}.${pad2(parts.month)}.${pad2(parts.day)} ${pad2(parts.hours)}:${pad2(parts.minutes)}${secondText}`;
    }

    function formatKstTime(ms, { seconds = false } = {}) {
        const parts = getKstParts(ms);
        const secondText = seconds ? `:${pad2(parts.seconds)}` : "";
        return `${pad2(parts.hours)}:${pad2(parts.minutes)}${secondText}`;
    }

    function mergeWatchRanges(ranges, mergeGapMs = DEFAULT_WATCH_RANGE_MERGE_GAP_MS) {
        const normalized = (Array.isArray(ranges) ? ranges : [])
            .map((range) => {
                const startAt = Math.round(Number(range?.startAt) || Number(range?.start) || 0);
                const endAt = Math.round(Number(range?.endAt) || Number(range?.end) || 0);
                return startAt > 0 && endAt > startAt ? { startAt, endAt } : null;
            })
            .filter(Boolean)
            .sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt);

        const merged = [];
        for (const range of normalized) {
            const last = merged[merged.length - 1];
            if (last && range.startAt <= last.endAt + mergeGapMs) {
                last.endAt = Math.max(last.endAt, range.endAt);
            } else {
                merged.push({ ...range });
            }
        }
        return merged;
    }

    function sumWatchRanges(ranges, mergeGapMs = DEFAULT_WATCH_RANGE_MERGE_GAP_MS) {
        return mergeWatchRanges(ranges, mergeGapMs).reduce(
            (sum, range) => sum + Math.max(0, range.endAt - range.startAt) / 1000,
            0
        );
    }

    function normalizeDailySeconds(value) {
        return Object.fromEntries(
            Object.entries(value && typeof value === "object" ? value : {})
                .map(([key, seconds]) => [key, Math.max(0, Number(seconds) || 0)])
                .filter(([, seconds]) => seconds > 0)
        );
    }

    function mergeDailySeconds(target, source, { round = false } = {}) {
        const next = target && typeof target === "object" ? target : {};
        for (const [dateKey, seconds] of Object.entries(source && typeof source === "object" ? source : {})) {
            const number = Number(seconds) || 0;
            const value = round ? Math.round(number) : Math.max(0, number);
            if (value <= 0) continue;
            next[dateKey] = Math.max(0, Number(next[dateKey]) || 0) + value;
        }
        return next;
    }

    function mergeDailySecondsMax(target, source, { round = false } = {}) {
        const next = target && typeof target === "object" ? target : {};
        for (const [dateKey, seconds] of Object.entries(source && typeof source === "object" ? source : {})) {
            const number = Math.max(0, Number(seconds) || 0);
            const value = round ? Math.round(number) : number;
            if (value <= 0) continue;
            next[dateKey] = Math.max(Math.max(0, Number(next[dateKey]) || 0), value);
        }
        return next;
    }

    function getFallbackWatchSessionRange(session, mergeGapMs = DEFAULT_WATCH_RANGE_MERGE_GAP_MS) {
        const watchedSeconds = Math.max(0, Number(session?.watchedSeconds) || 0);
        if (watchedSeconds <= 0) return null;

        const durationMs = watchedSeconds * 1000;
        let startAt = Number(session?.enteredAt) || Number(session?.startedAt) || 0;
        let endAt = Number(session?.leftAt) || Number(session?.endedAt) || Number(session?.lastWatchedAt) || 0;

        if (!endAt && startAt) endAt = startAt + durationMs;
        if (!startAt && endAt) startAt = Math.max(0, endAt - durationMs);
        if (!startAt || !endAt) return null;
        if (endAt <= startAt) endAt = startAt + durationMs;
        if (endAt - startAt > durationMs + mergeGapMs) {
            startAt = Math.max(startAt, endAt - durationMs);
        }
        return endAt > startAt ? { startAt: Math.round(startAt), endAt: Math.round(endAt) } : null;
    }

    function getFallbackWatchSessionRangeForDate(session, dateKey, seconds) {
        const bounds = getKstDateScopeBounds(dateKey);
        const watchedSeconds = Math.max(0, Number(seconds) || 0);
        if (!bounds || watchedSeconds <= 0) return null;

        const durationMs = watchedSeconds * 1000;
        const enteredAt = Number(session?.enteredAt) || Number(session?.startedAt) || 0;
        const leftAt = Number(session?.leftAt) || Number(session?.endedAt) || Number(session?.lastWatchedAt) || 0;
        let startAt = bounds.startMs;
        let endAt = Math.min(bounds.endMs, startAt + durationMs);

        if (leftAt >= bounds.startMs && leftAt <= bounds.endMs) {
            endAt = leftAt;
            startAt = Math.max(bounds.startMs, endAt - durationMs);
        } else if (enteredAt >= bounds.startMs && enteredAt < bounds.endMs) {
            startAt = enteredAt;
            endAt = Math.min(bounds.endMs, startAt + durationMs);
        }

        return endAt > startAt ? { startAt: Math.round(startAt), endAt: Math.round(endAt) } : null;
    }

    function getFallbackWatchSessionRanges(session, mergeGapMs = DEFAULT_WATCH_RANGE_MERGE_GAP_MS) {
        const dailyEntries = Object.entries(normalizeDailySeconds(session?.dailySeconds));
        if (dailyEntries.length) {
            return mergeWatchRanges(
                dailyEntries
                    .map(([dateKey, seconds]) => getFallbackWatchSessionRangeForDate(session, dateKey, seconds))
                    .filter(Boolean),
                mergeGapMs
            );
        }

        const fallback = getFallbackWatchSessionRange(session, mergeGapMs);
        return fallback ? [fallback] : [];
    }

    function getWatchSessionRanges(session, mergeGapMs = DEFAULT_WATCH_RANGE_MERGE_GAP_MS) {
        const ranges = mergeWatchRanges(session?.watchedRanges, mergeGapMs);
        if (ranges.length) return ranges;
        return getFallbackWatchSessionRanges(session, mergeGapMs);
    }

    function collectWatchSessionRanges(
        sessionDetails,
        { scopeStartMs = -Infinity, scopeEndMs = Infinity, mergeGapMs = DEFAULT_WATCH_RANGE_MERGE_GAP_MS } = {}
    ) {
        const ranges = [];
        for (const session of sessionDetails || []) {
            for (const range of getWatchSessionRanges(session, mergeGapMs)) {
                const startAt = Math.max(range.startAt, scopeStartMs);
                const endAt = Math.min(range.endAt, scopeEndMs);
                if (endAt > startAt) ranges.push({ startAt, endAt });
            }
        }
        return ranges;
    }

    function addWatchRangeToRangesByDate(
        rangesByDate,
        range,
        { scopeStartMs = -Infinity, scopeEndMs = Infinity } = {}
    ) {
        let cursor = Math.max(range.startAt, scopeStartMs);
        const endAt = Math.min(range.endAt, scopeEndMs);
        while (cursor < endAt) {
            const dateKey = getKstDateKey(cursor);
            const next = Math.min(endAt, getNextKstDayStartMs(cursor));
            if (next > cursor) {
                if (!rangesByDate[dateKey]) rangesByDate[dateKey] = [];
                rangesByDate[dateKey].push({ startAt: cursor, endAt: next });
            }
            cursor = next;
        }
    }

    function sumWatchRangesByDate(rangesByDate, mergeGapMs = DEFAULT_WATCH_RANGE_MERGE_GAP_MS) {
        const dailySeconds = {};
        for (const [dateKey, ranges] of Object.entries(rangesByDate || {})) {
            const seconds = sumWatchRanges(ranges, mergeGapMs);
            if (seconds > 0) dailySeconds[dateKey] = seconds;
        }
        return dailySeconds;
    }

    /**
     * 여러 탭의 시청 구간은 한 번만 세되, 범위 상한·legacy/retired 세션 때문에 구간으로 표현되지
     * 않은 누적값은 보존한다. 반드시 UI용 연속 세션 병합 전의 원본 세션 배열을 전달해야 한다.
     */
    function getUniqueWatchTotals(record, sessionDetails) {
        const sessions = (Array.isArray(sessionDetails) ? sessionDetails : []).filter(
            (session) => session && typeof session === "object"
        );
        const allRanges = [];
        const exactRangesByDate = {};
        const representedDailySeconds = {};
        const residualDailySeconds = {};
        let representedSeconds = 0;
        let residualSeconds = 0;

        for (const session of sessions) {
            const storedSeconds = Math.max(0, Number(session.watchedSeconds) || 0);
            const ranges = mergeWatchRanges(session.watchedRanges);
            const rangeSeconds = sumWatchRanges(ranges);
            representedSeconds += Math.max(storedSeconds, rangeSeconds);
            residualSeconds += Math.max(0, storedSeconds - rangeSeconds);
            allRanges.push(...ranges);

            const sessionRangesByDate = {};
            for (const range of ranges) {
                addWatchRangeToRangesByDate(exactRangesByDate, range);
                addWatchRangeToRangesByDate(sessionRangesByDate, range);
            }
            const sessionRangeDailySeconds = sumWatchRangesByDate(sessionRangesByDate);
            const sessionDailySeconds = normalizeDailySeconds(session.dailySeconds);
            const sessionDateKeys = new Set([
                ...Object.keys(sessionDailySeconds),
                ...Object.keys(sessionRangeDailySeconds),
            ]);
            for (const dateKey of sessionDateKeys) {
                const seconds = Number(sessionDailySeconds[dateKey]) || 0;
                const rangeDailySeconds = Number(sessionRangeDailySeconds[dateKey]) || 0;
                representedDailySeconds[dateKey] =
                    (Number(representedDailySeconds[dateKey]) || 0) + Math.max(seconds, rangeDailySeconds);
                residualDailySeconds[dateKey] =
                    (Number(residualDailySeconds[dateKey]) || 0) + Math.max(0, seconds - rangeDailySeconds);
            }
        }

        const storedSeconds = Math.max(0, Number(record?.watchedSeconds) || 0);
        const legacyOrRetiredSeconds = Math.max(0, storedSeconds - representedSeconds);
        const watchedSeconds = sumWatchRanges(allRanges) + residualSeconds + legacyOrRetiredSeconds;
        const exactDailySeconds = sumWatchRangesByDate(exactRangesByDate);
        const storedDailySeconds = normalizeDailySeconds(record?.dailySeconds);
        const dailySeconds = {};
        const dateKeys = new Set([
            ...Object.keys(exactDailySeconds),
            ...Object.keys(residualDailySeconds),
            ...Object.keys(storedDailySeconds),
        ]);

        for (const dateKey of dateKeys) {
            const legacyOrRetiredDailySeconds = Math.max(
                0,
                (Number(storedDailySeconds[dateKey]) || 0) - (Number(representedDailySeconds[dateKey]) || 0)
            );
            const seconds =
                (Number(exactDailySeconds[dateKey]) || 0) +
                (Number(residualDailySeconds[dateKey]) || 0) +
                legacyOrRetiredDailySeconds;
            if (seconds > 0) dailySeconds[dateKey] = seconds;
        }

        return { watchedSeconds, dailySeconds };
    }

    function trimMapToSize(map, maxSize) {
        while (map.size > maxSize) {
            const oldestKey = map.keys().next().value;
            if (oldestKey === undefined) break;
            map.delete(oldestKey);
        }
    }

    function touchMapEntry(map, key, value, maxSize) {
        map.delete(key);
        map.set(key, value);
        trimMapToSize(map, maxSize);
        return value;
    }

    function normalizeTitleHistory(value, channelName = "", maxSize = 20) {
        const rows = Array.isArray(value) ? value : [];
        const byTitle = new Map();

        for (const row of rows) {
            let title = "";
            let firstSeenAt = 0;
            let lastSeenAt = 0;

            if (typeof row === "string") {
                title = cleanEntryTitle(row, channelName);
            } else if (row && typeof row === "object") {
                title = cleanEntryTitle(pickString(row.title, row.name, row.value), channelName);
                firstSeenAt = Number(row.firstSeenAt) || Number(row.seenAt) || Number(row.createdAt) || 0;
                lastSeenAt = Number(row.lastSeenAt) || Number(row.updatedAt) || firstSeenAt;
            }

            if (!title || title === "\uC81C\uBAA9 \uC5C6\uB294 \uB77C\uC774\uBE0C") continue;
            if (!firstSeenAt) firstSeenAt = lastSeenAt || Date.now();
            if (!lastSeenAt) lastSeenAt = firstSeenAt;

            const existing = byTitle.get(title);
            if (existing) {
                existing.firstSeenAt = Math.min(existing.firstSeenAt, firstSeenAt);
                existing.lastSeenAt = Math.max(existing.lastSeenAt, lastSeenAt);
            } else {
                byTitle.set(title, { title, firstSeenAt, lastSeenAt });
            }
        }

        return Array.from(byTitle.values())
            .sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.lastSeenAt - b.lastSeenAt)
            .slice(-maxSize);
    }

    function addTitleHistory(target, title, firstSeenAt = Date.now(), lastSeenAt = firstSeenAt, maxSize = 20) {
        if (!target) return;

        const clean = cleanEntryTitle(title, target.channelName);
        if (!clean || clean === "\uC81C\uBAA9 \uC5C6\uB294 \uB77C\uC774\uBE0C") return;

        const first = Number(firstSeenAt) || Date.now();
        const last = Number(lastSeenAt) || first;
        const history = normalizeTitleHistory(target.titleHistory, target.channelName, maxSize);
        const existing = history.find((row) => row.title === clean);

        if (existing) {
            existing.firstSeenAt = Math.min(existing.firstSeenAt, first);
            existing.lastSeenAt = Math.max(existing.lastSeenAt, last);
        } else {
            history.push({ title: clean, firstSeenAt: first, lastSeenAt: last });
        }

        target.titleHistory = history
            .sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.lastSeenAt - b.lastSeenAt)
            .slice(-maxSize);
    }

    async function fetchJson(url, { signal, timeoutMs = 12000, ...init } = {}) {
        const controller = new AbortController();
        const onExternalAbort = () => controller.abort();

        if (signal) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener("abort", onExternalAbort, { once: true });
        }

        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(url, {
                credentials: "include",
                ...init,
                signal: controller.signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener("abort", onExternalAbort);
        }
    }

    function createCommentDeviceId() {
        return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    }

    async function getCommentDeviceId() {
        if (commentDeviceId) return commentDeviceId;
        if (commentDeviceIdPromise) return commentDeviceIdPromise;

        commentDeviceIdPromise = (async () => {
            const storage = globalThis.chrome?.storage?.local;
            try {
                const data = await storageGet(storage, COMMENT_DEVICE_ID_STORAGE_KEY);
                const existing = compactSpaces(data?.[COMMENT_DEVICE_ID_STORAGE_KEY]);
                if (existing) return existing;

                const next = createCommentDeviceId();
                await storageSet(storage, { [COMMENT_DEVICE_ID_STORAGE_KEY]: next });
                return next;
            } catch (_) {
                return createCommentDeviceId();
            }
        })()
            .then((value) => {
                commentDeviceId = value;
                return value;
            })
            .finally(() => {
                commentDeviceIdPromise = null;
            });

        return commentDeviceIdPromise;
    }

    async function fetchChzzkCommentPage({
        objectId,
        objectType = "STREAMING_VIDEO",
        limit = 10,
        offset = 0,
        orderType = "ASC",
        originalLoungeId = "",
        signal,
    } = {}) {
        const normalizedObjectId = compactSpaces(objectId);
        if (!normalizedObjectId) throw new Error("댓글 대상이 없습니다.");

        const deviceId = await getCommentDeviceId();
        const params = new URLSearchParams({
            limit: String(Math.max(1, Math.trunc(Number(limit) || 10))),
            offset: String(Math.max(0, Math.trunc(Number(offset) || 0))),
            orderType: compactSpaces(orderType) || "ASC",
        });
        if (originalLoungeId) params.set("originalLoungeId", compactSpaces(originalLoungeId));

        const url = `${COMMENT_API_BASE}/type/${encodeURIComponent(objectType)}/id/${encodeURIComponent(
            normalizedObjectId
        )}/comments?${params.toString()}`;
        const json = await fetchJson(url, {
            headers: {
                Accept: "application/json",
                "Cache-Control": "no-cache",
                "Front-Client-Platform-Type": "PC",
                "Front-Client-Product-Type": "web",
                "If-Modified-Since": "Mon, 26 Jul 1997 05:00:00 GMT",
                Pragma: "no-cache",
                deviceId,
            },
            signal,
        });
        if (json?.code && json.code !== 200) throw new Error(json.message || `code ${json.code}`);
        return json?.content || null;
    }

    function getStorageError() {
        return globalThis.chrome?.runtime?.lastError || null;
    }

    function storageGet(area, key, fallback = {}) {
        return new Promise((resolve, reject) => {
            if (!area) {
                resolve(fallback);
                return;
            }
            area.get(key, (data) => {
                const error = getStorageError();
                if (error) reject(error);
                else resolve(data || fallback);
            });
        });
    }

    function storageSet(area, value) {
        return new Promise((resolve, reject) => {
            if (!area) {
                resolve();
                return;
            }
            area.set(value, () => {
                const error = getStorageError();
                if (error) reject(error);
                else resolve();
            });
        });
    }

    function storageRemove(area, key) {
        return new Promise((resolve, reject) => {
            if (!area) {
                resolve();
                return;
            }
            area.remove(key, () => {
                const error = getStorageError();
                if (error) reject(error);
                else resolve();
            });
        });
    }

    function runtimeSendMessage(message) {
        return new Promise((resolve, reject) => {
            const runtime = globalThis.chrome?.runtime;
            if (typeof runtime?.sendMessage !== "function") {
                reject(new Error("Extension messaging is unavailable"));
                return;
            }
            runtime.sendMessage(message, (response) => {
                const error = getStorageError();
                if (error) reject(error);
                else resolve(response);
            });
        });
    }

    function startStorageChangeListener(listener) {
        const onChanged = globalThis.chrome?.storage?.onChanged;
        if (!onChanged || typeof listener !== "function") return null;
        onChanged.addListener(listener);
        return () => onChanged.removeListener?.(listener);
    }

    root.utils = {
        ...(root.utils || {}),
        addTitleHistory,
        addWatchRangeToRangesByDate,
        cleanEntryTitle,
        cleanTitle,
        collectWatchSessionRanges,
        compactSpaces,
        fetchChzzkCommentPage,
        fetchJson,
        formatKstDateKey,
        formatKstDateTime,
        formatKstMonthKey,
        formatKstTime,
        getKstDateKey,
        getKstDateScopeBounds,
        getKstDayStartMs,
        getKstMonthStartMs,
        getKstParts,
        getCommentDeviceId,
        getNextKstDayStartMs,
        getWatchSessionRanges,
        getUniqueWatchTotals,
        isLastPage,
        isSameKstDate,
        mergeDailySeconds,
        mergeDailySecondsMax,
        mergeWatchRanges,
        normalizeDailySeconds,
        normalizeCompact,
        normalizeForMatch,
        normalizeTitleHistory,
        pad2,
        parseChzzkDate,
        pickArray,
        pickChzzkVideoNo,
        pickString,
        pickVideoEndDateText,
        pickVideoStartDateText,
        storageGet,
        storageRemove,
        storageSet,
        runtimeSendMessage,
        startStorageChangeListener,
        sumWatchRanges,
        sumWatchRangesByDate,
        touchMapEntry,
    };
})();
