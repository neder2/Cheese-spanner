/**
 * shared/watchHistoryStore.js — background service worker가 단독으로 소유하는 시청 기록 mutation 코어.
 * DOM에 의존하지 않으며, 동일 세션의 절대값 스냅샷을 멱등 병합하고 bounded 삭제·ID migration barrier를 유지한다.
 */
(() => {
    "use strict";

    const STORAGE_KEY = "betterChzzkLiveWatchHistory";
    const MESSAGE_TYPE = "betterChzzk:watch-history-mutation";
    const MESSAGE_VERSION = 1;
    const HISTORY_VERSION = 3;
    const HISTORY_MAX_ENTRIES = 2000;
    const HISTORY_MAX_SESSION_DETAILS_PER_ENTRY = 300;
    const HISTORY_MAX_RETIRED_SESSION_CHECKPOINTS_PER_ENTRY = 1000;
    const HISTORY_MAX_TOMBSTONES = 2000;
    const HISTORY_MAX_RECORD_ALIASES = 2000;
    const HISTORY_MAX_WATCHED_RANGES_PER_SESSION = 200;
    const TITLE_HISTORY_MAX = 20;
    const MAX_ENTRY_IDS_PER_MUTATION = 2000;
    const MAX_STRING_LENGTH = 2000;
    const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
    const utils = globalThis.BetterChzzk?.utils || {};

    function compactString(value, maxLength = MAX_STRING_LENGTH) {
        return String(value ?? "")
            .trim()
            .slice(0, maxLength);
    }

    function finiteNumber(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function normalizeTimestamp(value, { required = false, now = Date.now() } = {}) {
        const parsed = Math.round(finiteNumber(value));
        if (parsed <= 0) {
            if (required) throw new Error("watch history timestamp is required");
            return 0;
        }
        if (parsed > now + MAX_FUTURE_SKEW_MS) throw new Error("watch history timestamp is in the future");
        return parsed;
    }

    function normalizeRecordId(value) {
        const id = compactString(value, 240);
        if (!id || !/^(?:live|channel):/.test(id)) throw new Error("invalid watch history record id");
        return id;
    }

    function normalizeSessionId(value) {
        const id = compactString(value, 160);
        if (!id) throw new Error("invalid watch history session id");
        return id;
    }

    function fallbackMergeWatchRanges(value) {
        const rows = (Array.isArray(value) ? value : [])
            .map((range) => ({
                startAt: Math.round(finiteNumber(range?.startAt)),
                endAt: Math.round(finiteNumber(range?.endAt)),
            }))
            .filter((range) => range.startAt > 0 && range.endAt > range.startAt)
            .sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt);
        const merged = [];
        for (const row of rows) {
            const last = merged[merged.length - 1];
            if (!last || row.startAt > last.endAt + 2000) merged.push(row);
            else last.endAt = Math.max(last.endAt, row.endAt);
        }
        return merged;
    }

    function mergeRanges(value) {
        const merge = typeof utils.mergeWatchRanges === "function" ? utils.mergeWatchRanges : fallbackMergeWatchRanges;
        return merge(value).slice(-HISTORY_MAX_WATCHED_RANGES_PER_SESSION);
    }

    function normalizeDailySeconds(value) {
        const out = {};
        if (!value || typeof value !== "object" || Array.isArray(value)) return out;
        for (const [dateKey, rawSeconds] of Object.entries(value).slice(0, 400)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
            const seconds = Math.max(0, Math.round(finiteNumber(rawSeconds)));
            if (seconds > 0) out[dateKey] = seconds;
        }
        return out;
    }

    function mergeDailyMax(target, source) {
        const out = { ...normalizeDailySeconds(target) };
        for (const [dateKey, seconds] of Object.entries(normalizeDailySeconds(source))) {
            out[dateKey] = Math.max(finiteNumber(out[dateKey]), seconds);
        }
        return out;
    }

    function normalizeTitleHistory(value, channelName = "") {
        if (typeof utils.normalizeTitleHistory === "function") {
            return utils.normalizeTitleHistory(value, channelName, TITLE_HISTORY_MAX);
        }
        return (Array.isArray(value) ? value : [])
            .map((row) => ({
                title: compactString(row?.title, 500),
                firstSeenAt: Math.max(0, Math.round(finiteNumber(row?.firstSeenAt))),
                lastSeenAt: Math.max(0, Math.round(finiteNumber(row?.lastSeenAt))),
            }))
            .filter((row) => row.title)
            .slice(-TITLE_HISTORY_MAX);
    }

    function mergeTitleHistory(existing, incoming, channelName) {
        const rows = [...normalizeTitleHistory(existing, channelName), ...normalizeTitleHistory(incoming, channelName)];
        const byTitle = new Map();
        for (const row of rows) {
            const previous = byTitle.get(row.title);
            if (!previous) {
                byTitle.set(row.title, { ...row });
                continue;
            }
            previous.firstSeenAt = Math.min(
                previous.firstSeenAt || row.firstSeenAt,
                row.firstSeenAt || previous.firstSeenAt
            );
            previous.lastSeenAt = Math.max(previous.lastSeenAt, row.lastSeenAt);
        }
        return Array.from(byTitle.values())
            .sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.lastSeenAt - b.lastSeenAt)
            .slice(-TITLE_HISTORY_MAX);
    }

    function normalizeEntryPatch(value = {}) {
        const source = value && typeof value === "object" ? value : {};
        return {
            channelId: compactString(source.channelId, 240),
            liveId: compactString(source.liveId, 240),
            title: compactString(source.title, 500),
            channelName: compactString(source.channelName, 240),
            thumbnailUrl: compactString(source.thumbnailUrl),
            liveOpenDate: compactString(source.liveOpenDate, 240),
            liveUrl: compactString(source.liveUrl),
            firstWatchedAt: Math.max(0, Math.round(finiteNumber(source.firstWatchedAt))),
            lastWatchedAt: Math.max(0, Math.round(finiteNumber(source.lastWatchedAt))),
            titleHistory: normalizeTitleHistory(source.titleHistory, source.channelName),
        };
    }

    function normalizeSessionSnapshot(value, now) {
        const source = value && typeof value === "object" ? value : {};
        const enteredAt = normalizeTimestamp(source.enteredAt, { required: true, now });
        const leftAt = Math.max(enteredAt, normalizeTimestamp(source.leftAt, { now }) || enteredAt);
        return {
            id: normalizeSessionId(source.id),
            title: compactString(source.title, 500),
            enteredAt,
            leftAt,
            watchedSeconds: Math.max(0, Math.round(finiteNumber(source.watchedSeconds))),
            dailySeconds: normalizeDailySeconds(source.dailySeconds),
            watchedRanges: mergeRanges(source.watchedRanges),
            closed: source.closed === true,
        };
    }

    function normalizeMutation(value, now = Date.now()) {
        if (!value || typeof value !== "object") throw new Error("watch history mutation is required");
        const kind = compactString(value.kind, 80);

        if (kind === "upsertSessionSnapshot") {
            return {
                kind,
                recordId: normalizeRecordId(value.recordId),
                entry: normalizeEntryPatch(value.entry),
                session: normalizeSessionSnapshot(value.session, now),
            };
        }
        if (kind === "migrateRecordId") {
            const sourceRecordId = normalizeRecordId(value.sourceRecordId);
            const targetRecordId = normalizeRecordId(value.targetRecordId);
            if (sourceRecordId === targetRecordId) throw new Error("record migration target must be different");
            if (!sourceRecordId.startsWith("channel:") || !targetRecordId.startsWith("live:")) {
                throw new Error("invalid record migration direction");
            }
            return { kind, sourceRecordId, targetRecordId };
        }
        if (kind === "setReplayVideoNo") {
            const videoNo = compactString(value.videoNo, 120);
            if (!videoNo) throw new Error("replay video number is required");
            return { kind, recordId: normalizeRecordId(value.recordId), videoNo };
        }
        if (kind === "deleteEntries") {
            const entryIds = Array.from(new Set(Array.isArray(value.entryIds) ? value.entryIds : []))
                .slice(0, MAX_ENTRY_IDS_PER_MUTATION)
                .map(normalizeRecordId);
            if (!entryIds.length) throw new Error("watch history entry ids are required");
            return {
                kind,
                entryIds,
                cutoffAt: normalizeTimestamp(value.cutoffAt, { required: true, now }),
            };
        }
        if (kind === "clearHistory") {
            return {
                kind,
                cutoffAt: normalizeTimestamp(value.cutoffAt, { required: true, now }),
            };
        }
        throw new Error("unsupported watch history mutation");
    }

    function cloneSession(value) {
        const source = value && typeof value === "object" ? value : {};
        return {
            ...source,
            dailySeconds: normalizeDailySeconds(source.dailySeconds),
            watchedRanges: mergeRanges(source.watchedRanges),
        };
    }

    function cloneRetiredSessionCheckpoint(value) {
        const source = value && typeof value === "object" ? value : {};
        const id = compactString(source.id, 160);
        if (!id) return null;
        const enteredAt = Math.max(0, Math.round(finiteNumber(source.enteredAt)));
        return {
            id,
            title: compactString(source.title, 500),
            enteredAt,
            leftAt: Math.max(enteredAt, Math.round(finiteNumber(source.leftAt))),
            watchedSeconds: Math.max(0, Math.round(finiteNumber(source.watchedSeconds))),
            dailySeconds: normalizeDailySeconds(source.dailySeconds),
            closed: source.closed === true,
            checkpointedAt: Math.max(
                enteredAt,
                Math.round(finiteNumber(source.checkpointedAt, source.leftAt || enteredAt))
            ),
        };
    }

    function mergeRetiredSessionCheckpoint(previous, incoming) {
        if (!previous) return incoming;
        return {
            ...previous,
            title: incoming.title || previous.title,
            enteredAt: Math.min(previous.enteredAt || incoming.enteredAt, incoming.enteredAt || previous.enteredAt),
            leftAt: Math.max(previous.leftAt, incoming.leftAt),
            watchedSeconds: Math.max(previous.watchedSeconds, incoming.watchedSeconds),
            dailySeconds: mergeDailyMax(previous.dailySeconds, incoming.dailySeconds),
            closed: previous.closed === true || incoming.closed === true,
            checkpointedAt: Math.max(previous.checkpointedAt, incoming.checkpointedAt),
        };
    }

    function normalizeRetiredSessionCheckpoints(value, { retainOverflow = false } = {}) {
        const byId = new Map();
        for (const rawCheckpoint of Array.isArray(value) ? value : []) {
            const checkpoint = cloneRetiredSessionCheckpoint(rawCheckpoint);
            if (!checkpoint) continue;
            byId.set(checkpoint.id, mergeRetiredSessionCheckpoint(byId.get(checkpoint.id), checkpoint));
        }
        const rows = Array.from(byId.values()).sort((a, b) => b.checkpointedAt - a.checkpointedAt);
        return retainOverflow ? rows : rows.slice(0, HISTORY_MAX_RETIRED_SESSION_CHECKPOINTS_PER_ENTRY);
    }

    function upsertRetiredSessionCheckpoint(value, session, checkpointedAt) {
        const checkpoint = cloneRetiredSessionCheckpoint({ ...session, checkpointedAt });
        if (!checkpoint) {
            return { checkpoints: normalizeRetiredSessionCheckpoints(value), evicted: [] };
        }
        const rows = normalizeRetiredSessionCheckpoints(value);
        const index = rows.findIndex((row) => row.id === checkpoint.id);
        if (index >= 0) rows[index] = mergeRetiredSessionCheckpoint(rows[index], checkpoint);
        else rows.push(checkpoint);
        rows.sort((a, b) => b.checkpointedAt - a.checkpointedAt);
        return {
            checkpoints: rows.slice(0, HISTORY_MAX_RETIRED_SESSION_CHECKPOINTS_PER_ENTRY),
            evicted: rows.slice(HISTORY_MAX_RETIRED_SESSION_CHECKPOINTS_PER_ENTRY),
        };
    }

    function extendRetiredSessionStartedAtBarrier(value, evictedSessions) {
        return (Array.isArray(evictedSessions) ? evictedSessions : []).reduce(
            (barrier, session) => Math.max(barrier, finiteNumber(session?.enteredAt)),
            Math.max(0, Math.round(finiteNumber(value)))
        );
    }

    function upsertEntryRetiredSessionCheckpoint(entry, session, checkpointedAt) {
        const outcome = upsertRetiredSessionCheckpoint(entry.retiredSessionCheckpoints, session, checkpointedAt);
        entry.retiredSessionCheckpoints = outcome.checkpoints;
        entry.retiredSessionStartedAtBarrier = extendRetiredSessionStartedAtBarrier(
            entry.retiredSessionStartedAtBarrier,
            outcome.evicted
        );
    }

    function normalizeStoredHistory(value) {
        const source = value && typeof value === "object" ? value : {};
        const rawEntries = Array.isArray(source.entries)
            ? source.entries
            : source.entries && typeof source.entries === "object"
              ? Object.values(source.entries)
              : [];
        const entries = {};
        for (const rawEntry of rawEntries) {
            if (!rawEntry || typeof rawEntry !== "object") continue;
            const id = compactString(rawEntry.id, 240);
            if (!id) continue;
            const retiredSessionRows = normalizeRetiredSessionCheckpoints(rawEntry.retiredSessionCheckpoints, {
                retainOverflow: true,
            });
            const entry = {
                ...rawEntry,
                id,
                dailySeconds: normalizeDailySeconds(rawEntry.dailySeconds),
                retiredSessionCheckpoints: retiredSessionRows.slice(
                    0,
                    HISTORY_MAX_RETIRED_SESSION_CHECKPOINTS_PER_ENTRY
                ),
                retiredSessionStartedAtBarrier: extendRetiredSessionStartedAtBarrier(
                    rawEntry.retiredSessionStartedAtBarrier,
                    retiredSessionRows.slice(HISTORY_MAX_RETIRED_SESSION_CHECKPOINTS_PER_ENTRY)
                ),
                titleHistory: Array.isArray(rawEntry.titleHistory)
                    ? rawEntry.titleHistory.map((row) => ({ ...row }))
                    : [],
            };
            if (Array.isArray(rawEntry.sessionDetails)) {
                entry.sessionDetails = rawEntry.sessionDetails.map(cloneSession);
            } else {
                delete entry.sessionDetails;
            }
            entries[id] = entry;
        }
        let compactedSessionBarrierAt = Math.max(
            0,
            Math.round(finiteNumber(source.compactedSessionBarrierAt, source.sessionResetAt))
        );
        const tombstones = {};
        const normalizedTombstones = [];
        if (source.tombstones && typeof source.tombstones === "object") {
            for (const [id, deletedAt] of Object.entries(source.tombstones)) {
                const timestamp = Math.max(0, Math.round(finiteNumber(deletedAt)));
                if (/^(?:live|channel):/.test(id) && timestamp > 0) {
                    normalizedTombstones.push([id, timestamp]);
                }
            }
        }
        normalizedTombstones.sort(([, a], [, b]) => b - a);
        for (const [id, deletedAt] of normalizedTombstones.slice(0, HISTORY_MAX_TOMBSTONES)) {
            tombstones[id] = deletedAt;
        }
        for (const [, deletedAt] of normalizedTombstones.slice(HISTORY_MAX_TOMBSTONES)) {
            compactedSessionBarrierAt = Math.max(compactedSessionBarrierAt, deletedAt);
        }
        const recordAliases = {};
        const aliases = [];
        if (source.recordAliases && typeof source.recordAliases === "object") {
            for (const [rawSourceId, rawAlias] of Object.entries(source.recordAliases)) {
                const sourceId = compactString(rawSourceId, 240);
                const targetId = compactString(
                    rawAlias && typeof rawAlias === "object" ? rawAlias.targetRecordId : rawAlias,
                    240
                );
                const migratedAt = Math.max(
                    0,
                    Math.round(
                        finiteNumber(rawAlias && typeof rawAlias === "object" ? rawAlias.migratedAt : source.updatedAt)
                    )
                );
                if (
                    !/^(?:live|channel):/.test(sourceId) ||
                    !/^(?:live|channel):/.test(targetId) ||
                    !sourceId.startsWith("channel:") ||
                    !targetId.startsWith("live:") ||
                    sourceId === targetId ||
                    migratedAt <= 0
                ) {
                    continue;
                }
                aliases.push({ sourceId, targetRecordId: targetId, migratedAt });
            }
        }
        aliases.sort((a, b) => b.migratedAt - a.migratedAt);
        for (const alias of aliases.slice(0, HISTORY_MAX_RECORD_ALIASES)) {
            recordAliases[alias.sourceId] = {
                targetRecordId: alias.targetRecordId,
                migratedAt: alias.migratedAt,
            };
        }
        for (const alias of aliases.slice(HISTORY_MAX_RECORD_ALIASES)) {
            compactedSessionBarrierAt = Math.max(compactedSessionBarrierAt, alias.migratedAt);
        }
        const flattenedRecordAliases = {};
        for (const [sourceId, alias] of Object.entries(recordAliases)) {
            const targetRecordId = resolveRecordId({ recordAliases }, sourceId);
            if (!targetRecordId || targetRecordId === sourceId) continue;
            flattenedRecordAliases[sourceId] = {
                targetRecordId,
                migratedAt: alias.migratedAt,
            };
        }
        return {
            ...source,
            version: Math.max(HISTORY_VERSION, Math.round(finiteNumber(source.version, HISTORY_VERSION))),
            updatedAt: Math.max(0, Math.round(finiteNumber(source.updatedAt))),
            clearedAt: Math.max(0, Math.round(finiteNumber(source.clearedAt))),
            compactedSessionBarrierAt,
            tombstones,
            recordAliases: flattenedRecordAliases,
            entries,
        };
    }

    function resolveRecordId(history, recordId) {
        let resolved = recordId;
        const path = [];
        const visitedIndexes = new Map();
        while (true) {
            if (visitedIndexes.has(resolved)) {
                return path.slice(visitedIndexes.get(resolved)).sort()[0] || resolved;
            }
            visitedIndexes.set(resolved, path.length);
            path.push(resolved);
            const next = compactString(history.recordAliases?.[resolved]?.targetRecordId, 240);
            if (!next || next === resolved) break;
            resolved = next;
        }
        return resolved;
    }

    function setRecordAlias(history, sourceRecordId, targetRecordId, migratedAt) {
        const before = JSON.stringify(history.recordAliases || {});
        const beforeBarrier = finiteNumber(history.compactedSessionBarrierAt);
        const previous = history.recordAliases?.[sourceRecordId];
        const alias = previous?.targetRecordId === targetRecordId ? previous : { targetRecordId, migratedAt };
        const aliases = {
            ...(history.recordAliases || {}),
            [sourceRecordId]: alias,
        };
        const rows = Object.entries(aliases).sort(
            ([, a], [, b]) => finiteNumber(b?.migratedAt) - finiteNumber(a?.migratedAt)
        );
        history.recordAliases = Object.fromEntries(rows.slice(0, HISTORY_MAX_RECORD_ALIASES));
        for (const [, alias] of rows.slice(HISTORY_MAX_RECORD_ALIASES)) {
            history.compactedSessionBarrierAt = Math.max(
                finiteNumber(history.compactedSessionBarrierAt),
                finiteNumber(alias?.migratedAt)
            );
        }
        return (
            before !== JSON.stringify(history.recordAliases) ||
            beforeBarrier !== finiteNumber(history.compactedSessionBarrierAt)
        );
    }

    function setTombstone(history, recordId, deletedAt) {
        const before = JSON.stringify(history.tombstones || {});
        const beforeBarrier = finiteNumber(history.compactedSessionBarrierAt);
        const tombstones = {
            ...(history.tombstones || {}),
            [recordId]: Math.max(finiteNumber(history.tombstones?.[recordId]), deletedAt),
        };
        const rows = Object.entries(tombstones).sort(([, a], [, b]) => finiteNumber(b) - finiteNumber(a));
        history.tombstones = Object.fromEntries(rows.slice(0, HISTORY_MAX_TOMBSTONES));
        for (const [, cutoffAt] of rows.slice(HISTORY_MAX_TOMBSTONES)) {
            history.compactedSessionBarrierAt = Math.max(
                finiteNumber(history.compactedSessionBarrierAt),
                finiteNumber(cutoffAt)
            );
        }
        return (
            before !== JSON.stringify(history.tombstones) ||
            beforeBarrier !== finiteNumber(history.compactedSessionBarrierAt)
        );
    }

    function applyRecordDeletionBarrier(history, recordId, cutoffAt) {
        if (cutoffAt <= 0) return false;
        let changed = setTombstone(history, recordId, cutoffAt);
        const entry = history.entries[recordId];
        if (!entry || getEntryStartedAt(entry) > cutoffAt) return changed;
        const retainedEntry = retainEntrySessionsAfter(entry, cutoffAt);
        if (retainedEntry) history.entries[recordId] = retainedEntry;
        else delete history.entries[recordId];
        changed = true;
        return changed;
    }

    function getEntryStartedAt(entry) {
        const sessionStarts = [
            ...(Array.isArray(entry?.sessionDetails) ? entry.sessionDetails : []),
            ...normalizeRetiredSessionCheckpoints(entry?.retiredSessionCheckpoints),
        ]
            .map((session) => finiteNumber(session?.enteredAt))
            .filter((timestamp) => timestamp > 0);
        const firstWatchedAt = finiteNumber(entry?.firstWatchedAt);
        if (firstWatchedAt > 0) sessionStarts.push(firstWatchedAt);
        return sessionStarts.length ? Math.min(...sessionStarts) : 0;
    }

    function retainEntrySessionsAfter(entry, cutoffAt) {
        const sessionDetails = (Array.isArray(entry?.sessionDetails) ? entry.sessionDetails : [])
            .map(cloneSession)
            .filter((session) => finiteNumber(session.enteredAt) > cutoffAt)
            .sort((a, b) => finiteNumber(b.enteredAt) - finiteNumber(a.enteredAt));
        const retainedDetailIds = new Set(sessionDetails.map((session) => session.id));
        const retiredSessionCheckpoints = normalizeRetiredSessionCheckpoints(entry?.retiredSessionCheckpoints).filter(
            (session) => finiteNumber(session.enteredAt) > cutoffAt && !retainedDetailIds.has(session.id)
        );
        const aggregateSessions = [...sessionDetails, ...retiredSessionCheckpoints];
        if (!aggregateSessions.length) return null;

        const dailySeconds = {};
        let watchedSeconds = 0;
        let firstWatchedAt = 0;
        let lastWatchedAt = 0;
        const titleHistory = [];
        for (const session of aggregateSessions) {
            const enteredAt = finiteNumber(session.enteredAt);
            const leftAt = Math.max(enteredAt, finiteNumber(session.leftAt));
            watchedSeconds += Math.max(0, finiteNumber(session.watchedSeconds));
            firstWatchedAt = firstWatchedAt ? Math.min(firstWatchedAt, enteredAt) : enteredAt;
            lastWatchedAt = Math.max(lastWatchedAt, leftAt);
            for (const [dateKey, seconds] of Object.entries(normalizeDailySeconds(session.dailySeconds))) {
                dailySeconds[dateKey] = finiteNumber(dailySeconds[dateKey]) + seconds;
            }
            if (session.title) {
                titleHistory.push({ title: session.title, firstSeenAt: enteredAt, lastSeenAt: leftAt });
            }
        }

        const latestSession = aggregateSessions.reduce((latest, session) =>
            finiteNumber(session.enteredAt) > finiteNumber(latest?.enteredAt) ? session : latest
        );
        const latestTitle = compactString(latestSession?.title, 500);
        return {
            ...entry,
            ...(latestTitle ? { title: latestTitle } : {}),
            watchedSeconds,
            dailySeconds,
            sessions: aggregateSessions.length,
            sessionDetails,
            retiredSessionCheckpoints,
            titleHistory: mergeTitleHistory([], titleHistory, entry.channelName),
            firstWatchedAt,
            lastWatchedAt,
        };
    }

    function mergeEntryMetadata(entry, patch) {
        for (const key of ["channelId", "liveId", "title", "channelName", "thumbnailUrl", "liveOpenDate", "liveUrl"]) {
            if (patch[key]) entry[key] = patch[key];
        }
        if (patch.firstWatchedAt > 0) {
            entry.firstWatchedAt = entry.firstWatchedAt
                ? Math.min(finiteNumber(entry.firstWatchedAt), patch.firstWatchedAt)
                : patch.firstWatchedAt;
        }
        if (patch.lastWatchedAt > 0) {
            entry.lastWatchedAt = Math.max(finiteNumber(entry.lastWatchedAt), patch.lastWatchedAt);
        }
        entry.titleHistory = mergeTitleHistory(entry.titleHistory, patch.titleHistory, entry.channelName);
    }

    function mergeStoredSession(previous, incoming) {
        if (!previous) return cloneSession(incoming);
        const next = cloneSession(incoming);
        return {
            ...previous,
            ...next,
            title: next.title || previous.title || "",
            enteredAt: Math.min(
                finiteNumber(previous.enteredAt) || finiteNumber(next.enteredAt),
                finiteNumber(next.enteredAt) || finiteNumber(previous.enteredAt)
            ),
            leftAt: Math.max(finiteNumber(previous.leftAt), finiteNumber(next.leftAt)),
            watchedSeconds: Math.max(finiteNumber(previous.watchedSeconds), finiteNumber(next.watchedSeconds)),
            dailySeconds: mergeDailyMax(previous.dailySeconds, next.dailySeconds),
            watchedRanges: mergeRanges([...(previous.watchedRanges || []), ...(next.watchedRanges || [])]),
            closed: previous.closed === true || next.closed === true,
        };
    }

    function getEntryKnownSessions(entry) {
        const byId = new Map();
        for (const checkpoint of normalizeRetiredSessionCheckpoints(entry?.retiredSessionCheckpoints)) {
            byId.set(checkpoint.id, cloneSession(checkpoint));
        }
        for (const session of Array.isArray(entry?.sessionDetails) ? entry.sessionDetails : []) {
            const cloned = cloneSession(session);
            if (!cloned.id) continue;
            byId.set(cloned.id, mergeStoredSession(byId.get(cloned.id), cloned));
        }
        return Array.from(byId.values());
    }

    function getEntryAggregateResidual(entry, knownSessions) {
        const representedSeconds = knownSessions.reduce(
            (sum, session) => sum + Math.max(0, finiteNumber(session.watchedSeconds)),
            0
        );
        const dailySeconds = {};
        for (const session of knownSessions) {
            for (const [dateKey, seconds] of Object.entries(normalizeDailySeconds(session.dailySeconds))) {
                dailySeconds[dateKey] = finiteNumber(dailySeconds[dateKey]) + seconds;
            }
        }
        const residualDailySeconds = {};
        for (const [dateKey, seconds] of Object.entries(normalizeDailySeconds(entry?.dailySeconds))) {
            const residual = Math.max(0, seconds - finiteNumber(dailySeconds[dateKey]));
            if (residual > 0) residualDailySeconds[dateKey] = residual;
        }
        return {
            watchedSeconds: Math.max(0, finiteNumber(entry?.watchedSeconds) - representedSeconds),
            dailySeconds: residualDailySeconds,
            sessions: Math.max(0, Math.round(finiteNumber(entry?.sessions)) - knownSessions.length),
        };
    }

    function mergeEntriesForMigration(sourceEntry, targetEntry, targetRecordId, now) {
        if (!sourceEntry) return targetEntry || null;
        const sourceSessions = getEntryKnownSessions(sourceEntry);
        const targetSessions = getEntryKnownSessions(targetEntry);
        const sourceResidual = getEntryAggregateResidual(sourceEntry, sourceSessions);
        const targetResidual = getEntryAggregateResidual(targetEntry, targetSessions);
        const byId = new Map();
        for (const session of [...sourceSessions, ...targetSessions]) {
            if (!session.id) continue;
            byId.set(session.id, mergeStoredSession(byId.get(session.id), session));
        }
        const allSessions = Array.from(byId.values()).sort(
            (a, b) => finiteNumber(b.enteredAt) - finiteNumber(a.enteredAt)
        );
        const sessionDetails = allSessions.slice(0, HISTORY_MAX_SESSION_DETAILS_PER_ENTRY);
        const retainedIds = new Set(sessionDetails.map((session) => session.id));
        const retiredSessionRows = normalizeRetiredSessionCheckpoints(
            allSessions
                .filter((session) => !retainedIds.has(session.id))
                .map((session) => ({ ...session, checkpointedAt: now })),
            { retainOverflow: true }
        );
        const retiredSessionCheckpoints = retiredSessionRows.slice(
            0,
            HISTORY_MAX_RETIRED_SESSION_CHECKPOINTS_PER_ENTRY
        );
        const aggregateDailySeconds = {};
        let watchedSeconds = sourceResidual.watchedSeconds + targetResidual.watchedSeconds;
        for (const session of allSessions) {
            watchedSeconds += Math.max(0, finiteNumber(session.watchedSeconds));
            for (const [dateKey, seconds] of Object.entries(normalizeDailySeconds(session.dailySeconds))) {
                aggregateDailySeconds[dateKey] = finiteNumber(aggregateDailySeconds[dateKey]) + seconds;
            }
        }
        for (const residual of [sourceResidual.dailySeconds, targetResidual.dailySeconds]) {
            for (const [dateKey, seconds] of Object.entries(residual)) {
                aggregateDailySeconds[dateKey] = finiteNumber(aggregateDailySeconds[dateKey]) + seconds;
            }
        }

        const sourceLastWatchedAt = finiteNumber(sourceEntry.lastWatchedAt);
        const targetLastWatchedAt = finiteNumber(targetEntry?.lastWatchedAt);
        const newer = targetLastWatchedAt >= sourceLastWatchedAt ? targetEntry || {} : sourceEntry;
        const older = newer === sourceEntry ? targetEntry || {} : sourceEntry;
        const firstWatchedValues = [sourceEntry.firstWatchedAt, targetEntry?.firstWatchedAt]
            .map((value) => finiteNumber(value))
            .filter((value) => value > 0);
        const entry = {
            ...older,
            ...newer,
            id: targetRecordId,
            watchedSeconds,
            dailySeconds: aggregateDailySeconds,
            sessions: allSessions.length + sourceResidual.sessions + targetResidual.sessions,
            sessionDetails,
            retiredSessionCheckpoints,
            retiredSessionStartedAtBarrier: extendRetiredSessionStartedAtBarrier(
                Math.max(
                    finiteNumber(sourceEntry.retiredSessionStartedAtBarrier),
                    finiteNumber(targetEntry?.retiredSessionStartedAtBarrier)
                ),
                retiredSessionRows.slice(HISTORY_MAX_RETIRED_SESSION_CHECKPOINTS_PER_ENTRY)
            ),
            titleHistory: mergeTitleHistory(
                sourceEntry.titleHistory,
                targetEntry?.titleHistory,
                newer.channelName || older.channelName
            ),
            firstWatchedAt: firstWatchedValues.length ? Math.min(...firstWatchedValues) : 0,
            lastWatchedAt: Math.max(sourceLastWatchedAt, targetLastWatchedAt),
        };
        if (targetRecordId.startsWith("live:")) entry.liveId = targetRecordId.slice("live:".length);
        if (!Array.isArray(sourceEntry.sessionDetails) && !Array.isArray(targetEntry?.sessionDetails)) {
            delete entry.sessionDetails;
        }
        return entry;
    }

    function pruneEntries(entries) {
        const entryCount = Object.keys(entries).length;
        if (entryCount <= HISTORY_MAX_ENTRIES) return entries;

        const rows = Object.values(entries);
        rows.sort((a, b) => finiteNumber(b.lastWatchedAt) - finiteNumber(a.lastWatchedAt));
        return Object.fromEntries(rows.slice(0, HISTORY_MAX_ENTRIES).map((entry) => [entry.id, entry]));
    }

    function applySessionSnapshot(history, operation, now) {
        const requestedRecordId = operation.recordId;
        const resolvedRecordId = resolveRecordId(history, operation.recordId);
        if (resolvedRecordId !== operation.recordId) operation = { ...operation, recordId: resolvedRecordId };
        const barrier = Math.max(
            history.clearedAt,
            finiteNumber(history.compactedSessionBarrierAt),
            finiteNumber(history.tombstones[requestedRecordId]),
            finiteNumber(history.tombstones[resolvedRecordId])
        );
        if (operation.session.enteredAt <= barrier) {
            return { changed: false, result: { status: "ignored", reason: "deleted", barrier } };
        }

        const previousEntry = history.entries[operation.recordId] || null;
        const before = JSON.stringify(previousEntry);
        const entry = previousEntry
            ? {
                  ...previousEntry,
                  dailySeconds: normalizeDailySeconds(previousEntry.dailySeconds),
                  sessionDetails: (Array.isArray(previousEntry.sessionDetails) ? previousEntry.sessionDetails : []).map(
                      cloneSession
                  ),
                  retiredSessionCheckpoints: normalizeRetiredSessionCheckpoints(
                      previousEntry.retiredSessionCheckpoints
                  ),
                  retiredSessionStartedAtBarrier: Math.max(
                      0,
                      Math.round(finiteNumber(previousEntry.retiredSessionStartedAtBarrier))
                  ),
              }
            : {
                  id: operation.recordId,
                  watchedSeconds: 0,
                  dailySeconds: {},
                  sessions: 0,
                  sessionDetails: [],
                  retiredSessionCheckpoints: [],
                  retiredSessionStartedAtBarrier: 0,
                  titleHistory: [],
              };
        const sessionIndex = entry.sessionDetails.findIndex((row) => row?.id === operation.session.id);
        const retiredSessionIndex = entry.retiredSessionCheckpoints.findIndex((row) => row.id === operation.session.id);
        if (
            sessionIndex < 0 &&
            retiredSessionIndex < 0 &&
            operation.session.enteredAt <= finiteNumber(entry.retiredSessionStartedAtBarrier)
        ) {
            return {
                changed: false,
                result: {
                    status: "ignored",
                    reason: "retired",
                    barrier: entry.retiredSessionStartedAtBarrier,
                },
            };
        }
        const previousSessionCount = Math.max(
            0,
            Math.round(finiteNumber(entry.sessions)),
            entry.sessionDetails.length + entry.retiredSessionCheckpoints.length
        );
        mergeEntryMetadata(entry, operation.entry);
        if (operation.recordId.startsWith("live:")) {
            entry.liveId = operation.recordId.slice("live:".length);
        }

        const previousSession =
            sessionIndex >= 0
                ? cloneSession(entry.sessionDetails[sessionIndex])
                : retiredSessionIndex >= 0
                  ? cloneRetiredSessionCheckpoint(entry.retiredSessionCheckpoints[retiredSessionIndex])
                  : null;
        const isNewSession = !previousSession;
        const nextSession = previousSession
            ? {
                  ...previousSession,
                  title: operation.session.title || previousSession.title || "",
                  enteredAt: Math.min(
                      finiteNumber(previousSession.enteredAt) || operation.session.enteredAt,
                      operation.session.enteredAt
                  ),
                  leftAt: Math.max(finiteNumber(previousSession.leftAt), operation.session.leftAt),
                  watchedSeconds: Math.max(
                      finiteNumber(previousSession.watchedSeconds),
                      operation.session.watchedSeconds
                  ),
                  dailySeconds: mergeDailyMax(previousSession.dailySeconds, operation.session.dailySeconds),
                  watchedRanges: mergeRanges([
                      ...(previousSession.watchedRanges || []),
                      ...operation.session.watchedRanges,
                  ]),
                  closed: previousSession.closed === true || operation.session.closed === true,
              }
            : { ...operation.session };

        const previousSeconds = finiteNumber(previousSession?.watchedSeconds);
        const secondsDelta = Math.max(0, nextSession.watchedSeconds - previousSeconds);
        entry.watchedSeconds = Math.max(0, finiteNumber(entry.watchedSeconds)) + secondsDelta;
        entry.dailySeconds = normalizeDailySeconds(entry.dailySeconds);
        for (const [dateKey, nextSeconds] of Object.entries(nextSession.dailySeconds)) {
            const previousDailySeconds = finiteNumber(previousSession?.dailySeconds?.[dateKey]);
            const delta = Math.max(0, nextSeconds - previousDailySeconds);
            if (delta > 0) entry.dailySeconds[dateKey] = finiteNumber(entry.dailySeconds[dateKey]) + delta;
        }

        if (sessionIndex >= 0) entry.sessionDetails[sessionIndex] = nextSession;
        else if (retiredSessionIndex >= 0) {
            upsertEntryRetiredSessionCheckpoint(entry, nextSession, now);
        } else entry.sessionDetails.push(nextSession);

        const sortedSessionDetails = entry.sessionDetails.sort(
            (a, b) => finiteNumber(b.enteredAt) - finiteNumber(a.enteredAt)
        );
        for (const retiredSession of sortedSessionDetails.slice(HISTORY_MAX_SESSION_DETAILS_PER_ENTRY)) {
            upsertEntryRetiredSessionCheckpoint(entry, retiredSession, now);
        }
        entry.sessionDetails = sortedSessionDetails.slice(0, HISTORY_MAX_SESSION_DETAILS_PER_ENTRY);
        const retainedSessionIds = new Set(entry.sessionDetails.map((session) => session.id));
        entry.retiredSessionCheckpoints = normalizeRetiredSessionCheckpoints(entry.retiredSessionCheckpoints).filter(
            (checkpoint) => !retainedSessionIds.has(checkpoint.id)
        );

        const sessionSeconds = entry.sessionDetails.reduce(
            (sum, session) => sum + Math.max(0, finiteNumber(session.watchedSeconds)),
            0
        );
        entry.watchedSeconds = Math.max(entry.watchedSeconds, sessionSeconds);
        const sessionDailySeconds = {};
        for (const session of entry.sessionDetails) {
            for (const [dateKey, seconds] of Object.entries(normalizeDailySeconds(session.dailySeconds))) {
                sessionDailySeconds[dateKey] = finiteNumber(sessionDailySeconds[dateKey]) + seconds;
            }
        }
        entry.dailySeconds = mergeDailyMax(entry.dailySeconds, sessionDailySeconds);
        entry.firstWatchedAt = entry.firstWatchedAt
            ? Math.min(finiteNumber(entry.firstWatchedAt), nextSession.enteredAt)
            : nextSession.enteredAt;
        entry.lastWatchedAt = Math.max(finiteNumber(entry.lastWatchedAt), nextSession.leftAt);
        entry.sessions = Math.max(
            previousSessionCount + (isNewSession ? 1 : 0),
            entry.sessionDetails.length + entry.retiredSessionCheckpoints.length
        );
        history.entries[operation.recordId] = entry;
        history.entries = pruneEntries(history.entries);

        return {
            changed: before !== JSON.stringify(entry),
            result: { status: "applied", recordId: operation.recordId },
        };
    }

    function applyMutation(value, rawOperation, now = Date.now()) {
        const operation = normalizeMutation(rawOperation, now);
        const history = normalizeStoredHistory(value);
        let outcome;

        if (operation.kind === "upsertSessionSnapshot") {
            outcome = applySessionSnapshot(history, operation, now);
        } else if (operation.kind === "migrateRecordId") {
            const sourceRecordId = operation.sourceRecordId;
            const targetRecordId = resolveRecordId(history, operation.targetRecordId);
            const resolvedSourceRecordId = resolveRecordId(history, sourceRecordId);
            const invalidCanonicalTarget = !targetRecordId.startsWith("live:");
            const conflictsWithExistingAlias =
                resolvedSourceRecordId !== sourceRecordId && resolvedSourceRecordId !== targetRecordId;
            if (invalidCanonicalTarget || conflictsWithExistingAlias) {
                outcome = {
                    changed: false,
                    result: {
                        status: "ignored",
                        reason: invalidCanonicalTarget ? "invalid-target-alias" : "conflicting-alias",
                        sourceRecordId,
                        recordId: resolvedSourceRecordId,
                    },
                };
            } else {
                const sourceBarrier = Math.max(
                    finiteNumber(history.tombstones[sourceRecordId]),
                    finiteNumber(history.tombstones[resolvedSourceRecordId])
                );
                let changed = applyRecordDeletionBarrier(history, targetRecordId, sourceBarrier);
                if (resolvedSourceRecordId === targetRecordId) {
                    outcome = {
                        changed,
                        result: {
                            status: changed ? "applied" : "unchanged",
                            sourceRecordId,
                            recordId: targetRecordId,
                        },
                    };
                } else {
                    changed = setRecordAlias(history, sourceRecordId, targetRecordId, now) || changed;
                    const sourceEntry = history.entries[sourceRecordId];
                    const targetEntry = history.entries[targetRecordId];
                    if (sourceEntry) {
                        let mergedEntry = mergeEntriesForMigration(sourceEntry, targetEntry, targetRecordId, now);
                        const barrier = Math.max(
                            history.clearedAt,
                            finiteNumber(history.compactedSessionBarrierAt),
                            finiteNumber(history.tombstones[sourceRecordId]),
                            finiteNumber(history.tombstones[targetRecordId])
                        );
                        if (mergedEntry && getEntryStartedAt(mergedEntry) <= barrier) {
                            mergedEntry = retainEntrySessionsAfter(mergedEntry, barrier);
                        }
                        if (mergedEntry) history.entries[targetRecordId] = mergedEntry;
                        else delete history.entries[targetRecordId];
                        delete history.entries[sourceRecordId];
                        history.entries = pruneEntries(history.entries);
                        changed = true;
                    }
                    outcome = {
                        changed,
                        result: {
                            status: changed ? "applied" : "unchanged",
                            sourceRecordId,
                            recordId: targetRecordId,
                        },
                    };
                }
            }
        } else if (operation.kind === "setReplayVideoNo") {
            const recordId = resolveRecordId(history, operation.recordId);
            const entry = history.entries[recordId];
            if (!entry || entry.replayVideoNo === operation.videoNo) {
                outcome = { changed: false, result: { status: entry ? "unchanged" : "missing" } };
            } else {
                history.entries[recordId] = { ...entry, replayVideoNo: operation.videoNo };
                outcome = { changed: true, result: { status: "applied", recordId } };
            }
        } else if (operation.kind === "deleteEntries") {
            let changed = false;
            for (const rawId of operation.entryIds) {
                const id = resolveRecordId(history, rawId);
                const entry = history.entries[id];
                if (entry && getEntryStartedAt(entry) <= operation.cutoffAt) {
                    const retainedEntry = retainEntrySessionsAfter(entry, operation.cutoffAt);
                    if (retainedEntry) history.entries[id] = retainedEntry;
                    else delete history.entries[id];
                    changed = true;
                }
                changed = setTombstone(history, id, operation.cutoffAt) || changed;
            }
            outcome = { changed, result: { status: changed ? "applied" : "unchanged" } };
        } else {
            let changed = false;
            for (const [id, entry] of Object.entries(history.entries)) {
                if (getEntryStartedAt(entry) <= operation.cutoffAt) {
                    const retainedEntry = retainEntrySessionsAfter(entry, operation.cutoffAt);
                    if (retainedEntry) history.entries[id] = retainedEntry;
                    else delete history.entries[id];
                    changed = true;
                }
            }
            if (history.clearedAt < operation.cutoffAt) {
                history.clearedAt = operation.cutoffAt;
                changed = true;
            }
            for (const [id, deletedAt] of Object.entries(history.tombstones)) {
                if (finiteNumber(deletedAt) > history.clearedAt) continue;
                delete history.tombstones[id];
                changed = true;
            }
            outcome = { changed, result: { status: changed ? "applied" : "unchanged" } };
        }

        if (outcome.changed) history.updatedAt = Math.max(Math.round(now), history.updatedAt + 1);
        return { history, ...outcome };
    }

    globalThis.BetterChzzkWatchHistoryStore = {
        HISTORY_MAX_RECORD_ALIASES,
        HISTORY_MAX_TOMBSTONES,
        HISTORY_VERSION,
        MESSAGE_TYPE,
        MESSAGE_VERSION,
        STORAGE_KEY,
        applyMutation,
        normalizeMutation,
        normalizeStoredHistory,
    };
})();
