(() => {
    const root = globalThis.BetterChzzk = globalThis.BetterChzzk || {};
    const ARRAY_RESPONSE_KEYS = Object.freeze(["data", "videos", "list", "items", "content"]);
    const DEFAULT_WATCH_RANGE_MERGE_GAP_MS = 2000;
    const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
    const DAY_MS = 24 * 60 * 60 * 1000;

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
        return String(value || "").replace(/\s+/g, " ").trim();
    }

    function normalizeCompact(value) {
        return String(value || "").toLowerCase().replace(/\s+/g, "");
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
        return compactSpaces(value).toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "");
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
        const parts = String(dateKey || "").split("-").map(Number);
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
        return mergeWatchRanges(ranges, mergeGapMs)
            .reduce((sum, range) => sum + Math.max(0, range.endAt - range.startAt) / 1000, 0);
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
        getNextKstDayStartMs,
        getWatchSessionRanges,
        isLastPage,
        isSameKstDate,
        mergeDailySeconds,
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
        startStorageChangeListener,
        sumWatchRanges,
        sumWatchRangesByDate,
        touchMapEntry,
    };
})();
