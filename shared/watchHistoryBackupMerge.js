/** Pure backup merge planning. The background writer owns every storage operation. */
(() => {
    "use strict";
    const backup = globalThis.BetterChzzkWatchHistoryBackup;
    const { LIMITS } = backup;
    const DEFAULT_MAX_STORAGE_BYTES = 10 * 1024 * 1024;
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const number = (value) => Number(value) || 0;

    function fail(code = "INVALID_FILE") {
        const error = new Error(
            code === "LIMIT_EXCEEDED"
                ? "합친 기록이 보관 개수나 저장 용량 한도를 넘어요. 기존 기록은 변경하지 않았어요."
                : "현재 기록과 백업 파일을 안전하게 합칠 수 없어요. 기록은 변경하지 않았어요."
        );
        error.code = code;
        throw error;
    }

    function stable(value) {
        if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
        if (value && typeof value === "object")
            return `{${Object.keys(value)
                .sort()
                .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
                .join(",")}}`;
        return JSON.stringify(value);
    }

    function equal(a, b) {
        return stable(a) === stable(b);
    }
    function add(a, b) {
        const n = a + b;
        if (!Number.isSafeInteger(n)) fail();
        return n;
    }
    function sumDaily(rows, key = "dailySeconds") {
        const out = {};
        for (const row of rows)
            for (const [date, n] of Object.entries(row[key] || {})) if (n) out[date] = add(out[date] || 0, n);
        return out;
    }
    function positiveMap(value) {
        return Object.fromEntries(Object.entries(value).filter(([, n]) => n > 0));
    }
    function knownSessions(watch) {
        return [...(watch.sessionDetails || []), ...watch.retiredSessionCheckpoints];
    }
    function sorted(rows) {
        return rows.slice().sort((a, b) => a.id.localeCompare(b.id));
    }
    function watchValue(watch) {
        return {
            ...watch,
            sessionDetails: watch.sessionDetails === null ? null : sorted(watch.sessionDetails),
            retiredSessionCheckpoints: sorted(watch.retiredSessionCheckpoints),
            retiredSessionStartedAtBarrier: 0,
        };
    }
    function chatValue(chat) {
        return { messages: sorted(chat.messages), dailyCounts: positiveMap(chat.dailyCounts) };
    }
    function fullyRepresentedWatch(watch) {
        const rows = knownSessions(watch);
        return (
            watch.sessions === rows.length &&
            watch.watchedSeconds === rows.reduce((sum, row) => add(sum, row.watchedSeconds), 0) &&
            equal(positiveMap(watch.dailySeconds), sumDaily(rows))
        );
    }
    function messageDaily(messages) {
        const counts = {};
        for (const row of messages) {
            const date = globalThis.BetterChzzk.utils.getKstDateKey(row.at);
            counts[date] = (counts[date] || 0) + 1;
        }
        return counts;
    }
    function fullyRepresentedChat(chat) {
        return equal(positiveMap(chat.dailyCounts), messageDaily(chat.messages));
    }
    function maxDaily(a, b) {
        const out = { ...a };
        for (const [date, seconds] of Object.entries(b)) out[date] = Math.max(out[date] || 0, seconds);
        return out;
    }

    function mergeRanges(a, b) {
        const rows = [...a, ...b].sort((x, y) => x.startAt - y.startAt || x.endAt - y.endAt);
        const out = [];
        for (const row of rows) {
            const last = out[out.length - 1];
            if (last && row.startAt <= last.endAt + 2000 && row.endAt - last.startAt <= 366 * 86400000)
                last.endAt = Math.max(last.endAt, row.endAt);
            else out.push({ ...row });
        }
        if (out.length > LIMITS.watchedRanges) fail("LIMIT_EXCEEDED");
        return out;
    }

    function rangeTotals(ranges) {
        const utils = globalThis.BetterChzzk.utils;
        const exact = utils.mergeWatchRanges(ranges, 0);
        const byDate = {};
        for (const range of exact) utils.addWatchRangeToRangesByDate(byDate, range);
        return { seconds: utils.sumWatchRanges(exact, 0), daily: utils.sumWatchRangesByDate(byDate, 0) };
    }

    function incompatibleRangeGrowth(before, incoming, mergedRanges) {
        const a = rangeTotals(before.watchedRanges || []);
        const b = rangeTotals(incoming.watchedRanges || []);
        const exact = rangeTotals([...(before.watchedRanges || []), ...(incoming.watchedRanges || [])]);
        const merged = rangeTotals(mergedRanges);
        // Retain pre-existing range rounding and 2-second bridges, but reject a union that invents
        // extra watched intervals beyond the absolute counter's growth and newly bridged gaps.
        if (
            merged.seconds >
            Math.max(a.seconds, b.seconds) +
                Math.abs(before.watchedSeconds - incoming.watchedSeconds) +
                (merged.seconds - exact.seconds) +
                1
        )
            return true;
        for (const [date, seconds] of Object.entries(merged.daily)) {
            if (
                seconds >
                Math.max(a.daily[date] || 0, b.daily[date] || 0) +
                    Math.abs((before.dailySeconds[date] || 0) - (incoming.dailySeconds[date] || 0)) +
                    (seconds - (exact.daily[date] || 0)) +
                    1
            )
                return true;
        }
        return false;
    }

    function mergeWatch(current, incoming) {
        if (equal(watchValue(current), watchValue(incoming)))
            return {
                value: {
                    ...current,
                    retiredSessionStartedAtBarrier: Math.max(
                        current.retiredSessionStartedAtBarrier,
                        incoming.retiredSessionStartedAtBarrier
                    ),
                },
            };
        if (!fullyRepresentedWatch(current) || !fullyRepresentedWatch(incoming)) return { reason: "ambiguous-history" };
        const sessions = new Map();
        for (const row of knownSessions(current)) sessions.set(row.id, clone(row));
        for (const row of knownSessions(incoming)) {
            const before = sessions.get(row.id);
            if (!before) {
                sessions.set(row.id, clone(row));
                continue;
            }
            if (before.enteredAt !== row.enteredAt) return { reason: "identity-conflict" };
            const hasDetails = Array.isArray(before.watchedRanges) || Array.isArray(row.watchedRanges);
            const next = {
                id: row.id,
                title: row.leftAt > before.leftAt ? row.title || before.title : before.title || row.title,
                enteredAt: row.enteredAt,
                leftAt: Math.max(before.leftAt, row.leftAt),
                watchedSeconds: Math.max(before.watchedSeconds, row.watchedSeconds),
                dailySeconds: maxDaily(before.dailySeconds, row.dailySeconds),
                ...(hasDetails
                    ? { watchedRanges: mergeRanges(before.watchedRanges || [], row.watchedRanges || []) }
                    : {}),
                closed: before.closed || row.closed,
                ...(!hasDetails ? { checkpointedAt: Math.max(before.checkpointedAt, row.checkpointedAt) } : {}),
            };
            if (hasDetails && incompatibleRangeGrowth(before, row, next.watchedRanges))
                return { reason: "identity-conflict" };
            sessions.set(row.id, next);
        }
        const rows = Array.from(sessions.values()).sort(
            (a, b) => b.enteredAt - a.enteredAt || a.id.localeCompare(b.id)
        );
        const sessionDetails = rows.filter((row) => Array.isArray(row.watchedRanges));
        const retiredSessionCheckpoints = rows.filter((row) => !Array.isArray(row.watchedRanges));
        if (
            sessionDetails.length > LIMITS.sessionDetails ||
            retiredSessionCheckpoints.length > LIMITS.retiredSessionCheckpoints
        )
            fail("LIMIT_EXCEEDED");
        return {
            value: {
                watchedSeconds: rows.reduce((sum, row) => add(sum, row.watchedSeconds), 0),
                dailySeconds: sumDaily(rows),
                sessions: rows.length,
                sessionDetails:
                    current.sessionDetails === null && incoming.sessionDetails === null ? null : sessionDetails,
                retiredSessionCheckpoints,
                retiredSessionStartedAtBarrier: Math.max(
                    current.retiredSessionStartedAtBarrier,
                    incoming.retiredSessionStartedAtBarrier
                ),
            },
        };
    }

    function mergeChat(current, incoming) {
        if (equal(chatValue(current), chatValue(incoming)))
            return { value: { ...current, cutoffAt: Math.max(current.cutoffAt, incoming.cutoffAt) } };
        const messages = new Map(current.messages.map((row) => [row.id, { ...row }]));
        for (const row of incoming.messages) {
            const before = messages.get(row.id);
            if (
                before &&
                (before.at !== row.at ||
                    before.text !== row.text ||
                    (before.sessionStartedAt &&
                        row.sessionStartedAt &&
                        before.sessionStartedAt !== row.sessionStartedAt))
            )
                return { reason: "identity-conflict" };
        }
        if (!fullyRepresentedChat(current) || !fullyRepresentedChat(incoming)) return { reason: "ambiguous-history" };
        for (const row of incoming.messages) {
            const before = messages.get(row.id);
            messages.set(row.id, before ? { ...row, ...before } : { ...row });
        }
        const rows = Array.from(messages.values()).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
        if (rows.length > LIMITS.messagesPerRecord) fail("LIMIT_EXCEEDED");
        return {
            value: {
                messages: rows,
                dailyCounts: messageDaily(rows),
                cutoffAt: Math.max(current.cutoffAt, incoming.cutoffAt),
            },
        };
    }

    function mergeTitles(current, incoming) {
        const titles = new Map(current.map((row) => [row.title, { ...row }]));
        for (const row of incoming) {
            const old = titles.get(row.title);
            if (!old) titles.set(row.title, { ...row });
            else {
                old.firstSeenAt = Math.min(old.firstSeenAt || row.firstSeenAt, row.firstSeenAt || old.firstSeenAt);
                old.lastSeenAt = Math.max(old.lastSeenAt, row.lastSeenAt);
            }
        }
        if (titles.size > LIMITS.titleHistory) fail("LIMIT_EXCEEDED");
        return Array.from(titles.values()).sort(
            (a, b) => a.firstSeenAt - b.firstSeenAt || a.title.localeCompare(b.title)
        );
    }

    function mergeProjection(current, incoming, now) {
        if (current.channelId && incoming.channelId && current.channelId !== incoming.channelId)
            return { reason: "identity-conflict" };
        const chat = mergeChat(current.chat, incoming.chat);
        if (chat.reason) return chat;
        const watch = mergeWatch(current.watch, incoming.watch);
        if (watch.reason) return watch;
        const newer = incoming.lastWatchedAt > current.lastWatchedAt;
        const value = { ...current, watch: watch.value, chat: chat.value };
        for (const key of ["channelId", "channelName", "title", "liveOpenDate", "liveUrl", "thumbnailUrl"]) {
            if (incoming[key] && (newer || !value[key])) value[key] = incoming[key];
        }
        value.replayVideoNo = current.replayVideoNo || incoming.replayVideoNo;
        value.firstWatchedAt = Math.min(
            current.firstWatchedAt || incoming.firstWatchedAt,
            incoming.firstWatchedAt || current.firstWatchedAt
        );
        value.lastWatchedAt = Math.max(current.lastWatchedAt, incoming.lastWatchedAt);
        value.titleHistory = mergeTitles(current.titleHistory, incoming.titleHistory);
        try {
            backup.validateBackup(
                {
                    kind: backup.KIND,
                    formatVersion: 1,
                    extensionVersion: "0",
                    createdAt: now,
                    records: [value],
                    recordAliases: [],
                },
                { now }
            );
        } catch (error) {
            if (error.code === "LIMIT_EXCEEDED") throw error;
            return { reason: "identity-conflict" };
        }
        return { value };
    }

    function resolve(history, id) {
        const seen = new Set();
        let current = id;
        while (Object.hasOwn(history.recordAliases || {}, current)) {
            if (seen.has(current)) return null;
            seen.add(current);
            const alias = history.recordAliases[current];
            current = typeof alias === "string" ? alias : alias?.targetRecordId;
            if (typeof current !== "string") return null;
        }
        return current;
    }

    function projection(raw, id, now) {
        return backup.projectStoredRecord({ ...raw, id, liveId: id.startsWith("live:") ? id.slice(5) : "" }, { now });
    }

    function hasDonations(raw) {
        return (
            (raw.activities || []).some((row) => row.kind === "donation") ||
            Object.values(raw.activityDaily || {}).some(
                (row) => number(row.donationCount) > 0 || number(row.donationCheese) > 0
            )
        );
    }

    function toStored(record, previous) {
        const out = { ...(previous || {}), ...record };
        delete out.watch;
        delete out.chat;
        Object.assign(out, clone(record.watch));
        if (record.watch.sessionDetails === null) delete out.sessionDetails;
        const donations = (previous?.activities || []).filter((row) => row.kind === "donation");
        out.activities = [
            ...donations,
            ...record.chat.messages.map((row) => ({ ...row, kind: "chat", amount: 0 })),
        ].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
        out.activityDaily = clone(previous?.activityDaily || {});
        for (const [date, counts] of Object.entries(out.activityDaily)) {
            if (Object.hasOwn(record.chat.dailyCounts, date)) counts.chatCount = record.chat.dailyCounts[date];
            else counts.chatCount = 0;
        }
        for (const [date, count] of Object.entries(record.chat.dailyCounts)) {
            if (!out.activityDaily[date])
                out.activityDaily[date] = { chatCount: count, donationCount: 0, donationCheese: 0 };
        }
        out.chatCutoffAt = Math.max(number(previous?.chatCutoffAt ?? previous?.activityCutoffAt), record.chat.cutoffAt);
        return out;
    }

    function capacity(history, maxStorageBytes) {
        const entries = Object.values(history.entries);
        if (entries.length > LIMITS.records || Object.keys(history.recordAliases || {}).length > LIMITS.recordAliases)
            fail("LIMIT_EXCEEDED");
        let activities = 0;
        for (const entry of entries) {
            for (const [key, max] of [
                ["sessionDetails", LIMITS.sessionDetails],
                ["retiredSessionCheckpoints", LIMITS.retiredSessionCheckpoints],
                ["titleHistory", LIMITS.titleHistory],
                ["activities", LIMITS.messagesPerRecord],
            ]) {
                if ((entry[key]?.length || 0) > max) fail("LIMIT_EXCEEDED");
            }
            if (
                Object.keys(entry.dailySeconds || {}).length > LIMITS.dailyEntries ||
                Object.keys(entry.activityDaily || {}).length > LIMITS.dailyEntries
            )
                fail("LIMIT_EXCEEDED");
            activities += entry.activities?.length || 0;
        }
        if (activities > LIMITS.messagesTotal || backup.byteLength(JSON.stringify(history)) > maxStorageBytes)
            fail("LIMIT_EXCEEDED");
    }

    function deletionBarrier(history, relatedIds) {
        return Math.max(
            number(history.clearedAt),
            number(history.compactedSessionBarrierAt ?? history.sessionResetAt),
            ...relatedIds.map((id) => number(history.tombstones?.[id]))
        );
    }

    function restoredByBarrier(history, record, relatedIds) {
        const barrier = deletionBarrier(history, relatedIds);
        if (!barrier) return false;
        const times = [
            ...knownSessions(record.watch).map((row) => row.enteredAt),
            ...record.chat.messages.map((row) => row.sessionStartedAt || row.at),
        ].filter((at) => at > 0);
        const residual = residualWatch(record.watch);
        if (residual.watchedSeconds || residual.sessions) {
            if (record.firstWatchedAt) times.push(record.firstWatchedAt);
            if (record.lastWatchedAt) times.push(record.lastWatchedAt);
        }
        const representedWatch = sumDaily(knownSessions(record.watch));
        const representedChat = messageDaily(record.chat.messages);
        for (const [date, seconds] of Object.entries(record.watch.dailySeconds))
            if (seconds > (representedWatch[date] || 0)) times.push(Date.parse(`${date}T00:00:00+09:00`));
        for (const [date, count] of Object.entries(record.chat.dailyCounts))
            if (count > (representedChat[date] || 0)) times.push(Date.parse(`${date}T00:00:00+09:00`));
        return !times.length || times.some((at) => at <= barrier);
    }

    function residualWatch(watch) {
        const rows = knownSessions(watch);
        const represented = sumDaily(rows);
        return {
            watchedSeconds: Math.max(0, watch.watchedSeconds - rows.reduce((sum, row) => sum + row.watchedSeconds, 0)),
            sessions: Math.max(0, watch.sessions - rows.length),
            dailySeconds: Object.fromEntries(
                Object.entries(watch.dailySeconds)
                    .map(([date, seconds]) => [date, Math.max(0, seconds - (represented[date] || 0))])
                    .filter(([, seconds]) => seconds > 0)
            ),
        };
    }

    function restoreWatchUnion(a, b, sameResidual = false) {
        const residualA = residualWatch(a);
        const residualB = residualWatch(b);
        if (
            sameResidual &&
            (residualA.watchedSeconds || residualA.sessions || Object.keys(residualA.dailySeconds).length) &&
            (residualB.watchedSeconds || residualB.sessions || Object.keys(residualB.dailySeconds).length) &&
            !equal(residualA, residualB)
        )
            fail();
        const toExact = (watch) => {
            const rows = knownSessions(watch);
            return {
                ...watch,
                watchedSeconds: rows.reduce((sum, row) => sum + row.watchedSeconds, 0),
                sessions: rows.length,
                dailySeconds: sumDaily(rows),
            };
        };
        const merged = mergeWatch(toExact(a), toExact(b));
        if (merged.reason) fail();
        const residual = sameResidual
            ? {
                  watchedSeconds: Math.max(residualA.watchedSeconds, residualB.watchedSeconds),
                  sessions: Math.max(residualA.sessions, residualB.sessions),
                  dailySeconds: maxDaily(residualA.dailySeconds, residualB.dailySeconds),
              }
            : {
                  watchedSeconds: add(residualA.watchedSeconds, residualB.watchedSeconds),
                  sessions: add(residualA.sessions, residualB.sessions),
                  dailySeconds: sumDaily([residualA, residualB]),
              };
        merged.value.watchedSeconds = add(merged.value.watchedSeconds, residual.watchedSeconds);
        merged.value.sessions = add(merged.value.sessions, residual.sessions);
        merged.value.dailySeconds = sumDaily([merged.value, residual]);
        return merged.value;
    }

    function restoreScopes(entry) {
        const saved = entry?.backupRestore;
        if (!saved) return [];
        return (Array.isArray(saved.scopes) ? saved.scopes : [saved]).map((scope) => ({
            ...clone(scope),
            recordId: scope.recordId || entry.id,
        }));
    }

    function mergeRestoreScopes(...entries) {
        const scopes = new Map();
        for (const entry of entries) for (const scope of restoreScopes(entry)) scopes.set(stable(scope), scope);
        return scopes.size ? { scopes: Array.from(scopes.values()) } : undefined;
    }

    function retainUncoveredScopes(state, coversWatch, coversChat) {
        if (!state) return undefined;
        const scopes = clone(state.scopes)
            .map((scope) => ({
                ...scope,
                watch: coversWatch
                    ? {
                          watchedSeconds: 0,
                          dailySeconds: {},
                          sessions: 0,
                          sessionDetails: [],
                          retiredSessionCheckpoints: [],
                          retiredSessionStartedAtBarrier: 0,
                      }
                    : scope.watch,
                chat: coversChat ? { messages: [], dailyCounts: {}, cutoffAt: 0 } : scope.chat,
            }))
            .filter(
                (scope) =>
                    scope.watch.watchedSeconds ||
                    scope.watch.sessions ||
                    knownSessions(scope.watch).length ||
                    Object.values(scope.watch.dailySeconds).some(Boolean) ||
                    scope.chat.messages.length ||
                    Object.values(scope.chat.dailyCounts).some(Boolean)
            );
        return scopes.length ? { scopes } : undefined;
    }

    function scopeForFile(record, barrier, now) {
        const watch = clone(record.watch);
        const residual = residualWatch(watch);
        if (watch.sessionDetails !== null)
            watch.sessionDetails = watch.sessionDetails.filter((row) => row.enteredAt <= barrier);
        watch.retiredSessionCheckpoints = watch.retiredSessionCheckpoints.filter((row) => row.enteredAt <= barrier);
        const rows = knownSessions(watch);
        watch.watchedSeconds = residual.watchedSeconds + rows.reduce((sum, row) => sum + row.watchedSeconds, 0);
        watch.sessions = residual.sessions + rows.length;
        watch.dailySeconds = sumDaily([...rows, residual]);
        // Store only necessary numeric snapshots and IDs. Message bodies and display strings remain in their normal fields.
        for (const row of rows) row.title = "";
        const allMessageCounts = messageDaily(record.chat.messages);
        const messages = record.chat.messages
            .filter((row) => (row.sessionStartedAt || row.at) <= barrier)
            .map(({ id, at, sessionStartedAt }) => ({ id, at, ...(sessionStartedAt ? { sessionStartedAt } : {}) }));
        const dailyCounts = messageDaily(messages);
        for (const [date, count] of Object.entries(record.chat.dailyCounts)) {
            const remaining = count - (allMessageCounts[date] || 0);
            if (remaining > 0 && Date.parse(`${date}T00:00:00+09:00`) <= barrier)
                dailyCounts[date] = (dailyCounts[date] || 0) + remaining;
        }
        return { at: now, recordId: record.id, watch, chat: { messages, dailyCounts, cutoffAt: record.chat.cutoffAt } };
    }

    function activeScopeGroups(scopes) {
        const groups = new Map();
        for (const scope of scopes) {
            const previous = groups.get(scope.recordId);
            if (!previous) {
                groups.set(scope.recordId, clone(scope));
                continue;
            }
            previous.watch = restoreWatchUnion(previous.watch, scope.watch, true);
            const oldCounts = messageDaily(previous.chat.messages);
            const nextCounts = messageDaily(scope.chat.messages);
            const messages = new Map([...previous.chat.messages, ...scope.chat.messages].map((row) => [row.id, row]));
            const dailyCounts = messageDaily(Array.from(messages.values()));
            for (const date of new Set([
                ...Object.keys(previous.chat.dailyCounts),
                ...Object.keys(scope.chat.dailyCounts),
            ])) {
                const a = Math.max(0, (previous.chat.dailyCounts[date] || 0) - (oldCounts[date] || 0));
                const b = Math.max(0, (scope.chat.dailyCounts[date] || 0) - (nextCounts[date] || 0));
                if (a && b && a !== b) fail();
                dailyCounts[date] = (dailyCounts[date] || 0) + Math.max(a, b);
            }
            previous.chat = {
                messages: Array.from(messages.values()),
                dailyCounts,
                cutoffAt: Math.max(previous.chat.cutoffAt, scope.chat.cutoffAt),
            };
        }
        return Array.from(groups.values());
    }

    function restoreAfterBarrier(original, retained, cutoffAt) {
        // Different confirmations authorize different snapshots at different times. Filter before unioning
        // their stable IDs; never promote an old scope to another file's newer restoration timestamp.
        const scopes = restoreScopes(original).filter((scope) => scope.at >= cutoffAt);
        if (!scopes.length) return retained;
        const now = Math.max(Date.now(), ...scopes.map((scope) => scope.at));
        const originalProjection = backup.projectStoredRecord(original, { now });
        const metadata = Object.fromEntries(
            [
                "id",
                "channelId",
                "liveId",
                "title",
                "channelName",
                "titleHistory",
                "liveOpenDate",
                "liveUrl",
                "thumbnailUrl",
                "replayVideoNo",
            ].map((key) => [key, originalProjection[key]])
        );
        const cutoffs = {
            activityCutoffAt: number(original.activityCutoffAt),
            chatCutoffAt: number(original.chatCutoffAt ?? original.activityCutoffAt),
        };
        const base = retained || {
            ...metadata,
            ...cutoffs,
            retiredSessionStartedAtBarrier: originalProjection.watch.retiredSessionStartedAtBarrier,
        };
        const current = backup.projectStoredRecord(base, { now });
        const currentSessions = new Map(knownSessions(originalProjection.watch).map((row) => [row.id, row]));
        const available = new Map(
            (original.activities || []).filter((row) => row.kind === "chat").map((row) => [row.id, row])
        );
        const messages = new Map(current.chat.messages.map((row) => [row.id, row]));
        const residualDailyCounts = {};
        for (const scope of activeScopeGroups(scopes)) {
            const restoredWatch = clone(scope.watch);
            for (const row of knownSessions(restoredWatch)) row.title = currentSessions.get(row.id)?.title || "";
            current.watch = restoreWatchUnion(current.watch, restoredWatch);
            const protectedMessages = scope.chat.messages.map((row) => available.get(row.id)).filter(Boolean);
            for (const { id, at, text, sessionStartedAt } of protectedMessages) {
                if (!messages.has(id))
                    messages.set(id, { id, at, text, ...(sessionStartedAt ? { sessionStartedAt } : {}) });
            }
            const protectedCounts = messageDaily(protectedMessages);
            for (const [date, count] of Object.entries(scope.chat.dailyCounts))
                residualDailyCounts[date] =
                    (residualDailyCounts[date] || 0) + Math.max(0, count - (protectedCounts[date] || 0));
            current.chat.cutoffAt = Math.max(current.chat.cutoffAt, scope.chat.cutoffAt);
        }
        current.chat.messages = Array.from(messages.values());
        current.chat.dailyCounts = messageDaily(current.chat.messages);
        for (const [date, count] of Object.entries(residualDailyCounts))
            current.chat.dailyCounts[date] = (current.chat.dailyCounts[date] || 0) + count;
        const sessions = knownSessions(current.watch);
        const first = [
            ...sessions.map((row) => row.enteredAt),
            ...current.chat.messages.map((row) => row.sessionStartedAt || row.at),
        ].filter(Boolean);
        current.firstWatchedAt = first.length ? Math.min(...first) : original.firstWatchedAt || 0;
        current.lastWatchedAt = Math.max(
            0,
            ...sessions.map((row) => row.leftAt),
            ...current.chat.messages.map((row) => row.at)
        );
        const out = toStored(current, retained || cutoffs);
        out.backupRestore = { scopes };
        return out;
    }

    function compactRestoreScope(entry) {
        if (!entry?.backupRestore) return;
        const details = new Set((entry.sessionDetails || []).map((row) => row.id));
        const retired = new Map((entry.retiredSessionCheckpoints || []).map((row) => [row.id, row]));
        const messageIds = new Set((entry.activities || []).filter((row) => row.kind === "chat").map((row) => row.id));
        const scopes = restoreScopes(entry);
        for (const scope of scopes) {
            const checkpoints = new Map();
            for (const row of [...(scope.watch.sessionDetails || []), ...scope.watch.retiredSessionCheckpoints]) {
                if (details.has(row.id) || !retired.has(row.id)) continue;
                const checkpoint = { ...row, checkpointedAt: retired.get(row.id).checkpointedAt };
                delete checkpoint.watchedRanges;
                checkpoints.set(row.id, checkpoint);
            }
            if (scope.watch.sessionDetails !== null)
                scope.watch.sessionDetails = scope.watch.sessionDetails.filter((row) => details.has(row.id));
            scope.watch.retiredSessionCheckpoints = Array.from(checkpoints.values());
            scope.chat.messages = scope.chat.messages.filter((row) => messageIds.has(row.id));
        }
        entry.backupRestore = { scopes };
    }

    function mergeBackup(
        rawHistory,
        rawBackup,
        { now = Date.now(), maxStorageBytes = DEFAULT_MAX_STORAGE_BYTES } = {}
    ) {
        const file = backup.validateBackup(rawBackup, { now });
        if (rawHistory !== undefined && (!rawHistory || typeof rawHistory !== "object" || Array.isArray(rawHistory)))
            fail();
        const history = clone(rawHistory || {});
        const rawEntries =
            history.entries === undefined
                ? []
                : Array.isArray(history.entries)
                  ? history.entries
                  : Object.values(history.entries);
        history.entries = Object.fromEntries(rawEntries.map((row) => [row.id, row]));
        if (Object.keys(history.entries).length !== rawEntries.length) fail();
        history.recordAliases = history.recordAliases || {};
        const canonicalIds = file.records.map((row) => resolve(history, row.id));
        const items = [];
        let changed = false;
        for (let index = 0; index < file.records.length; index++) {
            const record = file.records[index];
            const id = canonicalIds[index];
            const aliases = file.recordAliases.filter((row) => row.targetRecordId === record.id);
            let reason = !id || canonicalIds.filter((value) => value === id).length > 1 ? "identity-conflict" : null;
            const related = new Set([record.id, id, ...aliases.map((row) => row.sourceRecordId)]);
            for (const alias of aliases) {
                const target = resolve(history, alias.sourceRecordId);
                if (target !== alias.sourceRecordId && target !== id) reason = "identity-conflict";
            }
            for (const key of Object.keys(history.entries)) if (resolve(history, key) === id) related.add(key);
            const currentIds = [...related].filter((key) => Object.hasOwn(history.entries, key));
            if (currentIds.some((key) => key !== id && hasDonations(history.entries[key])))
                reason = "identity-conflict";
            let value = clone(record);
            if (id && id !== record.id) {
                value.id = id;
                value.liveId = id.startsWith("live:") ? id.slice(5) : "";
            }
            const currentProjection =
                currentIds.length === 1 ? projection(history.entries[currentIds[0]], id, now) : null;
            if (!reason) {
                const currentProjections = currentIds.map((currentId) =>
                    projection(history.entries[currentId], id, now)
                );
                // A verified alias identifies the broadcast, not the origin of already compacted totals.
                // Equal numbers on two different stored rows cannot prove that their residuals are duplicates.
                if (
                    currentProjections.length > 1 &&
                    currentProjections.some(
                        (row) => !fullyRepresentedWatch(row.watch) || !fullyRepresentedChat(row.chat)
                    )
                )
                    reason = "ambiguous-history";
                for (const current of currentProjections) {
                    if (reason) break;
                    const result = mergeProjection(current, value, now);
                    if (result.reason) {
                        reason = result.reason;
                        break;
                    }
                    value = result.value;
                }
            }
            const aliasChanges = aliases.some((alias) => resolve(history, alias.sourceRecordId) !== id);
            const disposition = reason
                ? "skipped"
                : !currentIds.length
                  ? "added"
                  : currentIds.length === 1 && currentIds[0] === id && equal(currentProjection, value) && !aliasChanges
                    ? "unchanged"
                    : "updated";
            const applies = disposition === "added" || disposition === "updated";
            const restoresDeleted = applies && restoredByBarrier(history, record, [...related]);
            items.push({
                recordId: record.id,
                title: record.title,
                channelName: record.channelName,
                disposition,
                restoresDeleted,
                reason,
            });
            if (!applies) continue;
            const previous = history.entries[id] || (currentIds.length === 1 ? history.entries[currentIds[0]] : null);
            let restoredScopes = mergeRestoreScopes(...currentIds.map((key) => history.entries[key]));
            history.entries[id] = toStored(value, previous);
            if (restoresDeleted) {
                const incomingScope = scopeForFile(record, deletionBarrier(history, [...related]), now);
                // A file may cover the complete watch snapshot while containing only some current chats,
                // or vice versa. Replace only the covered permission; preserve the other part's original time.
                const uncoveredScopes = retainUncoveredScopes(
                    restoredScopes,
                    equal(watchValue(record.watch), watchValue(value.watch)),
                    equal(chatValue(record.chat), chatValue(value.chat))
                );
                restoredScopes = mergeRestoreScopes(
                    { id, backupRestore: uncoveredScopes },
                    {
                        id: record.id,
                        backupRestore: incomingScope,
                    }
                );
            }
            if (restoredScopes) history.entries[id].backupRestore = restoredScopes;
            for (const key of currentIds) if (key !== id) delete history.entries[key];
            for (const alias of aliases)
                if (!Object.hasOwn(history.recordAliases, alias.sourceRecordId)) {
                    history.recordAliases[alias.sourceRecordId] = { targetRecordId: id, migratedAt: alias.migratedAt };
                }
            changed = true;
        }
        if (changed) {
            history.version = Math.max(number(history.version), 3);
            history.updatedAt = Math.max(now, number(history.updatedAt) + 1);
            capacity(history, maxStorageBytes);
        }
        const summary = {
            ...backup.summarizeBackup(file),
            added: 0,
            updated: 0,
            unchanged: 0,
            skipped: 0,
            restored: 0,
        };
        for (const item of items) {
            summary[item.disposition]++;
            if (item.restoresDeleted) summary.restored++;
        }
        const confirmationMeaning = stable({
            clearedAt: history.clearedAt || 0,
            compactedSessionBarrierAt: history.compactedSessionBarrierAt || history.sessionResetAt || 0,
            tombstones: rawHistory?.tombstones || {},
            items: items.map((item, index) => ({
                recordId: item.recordId,
                targetId: canonicalIds[index],
                reason: item.reason,
                restoresDeleted: item.restoresDeleted,
                disposition:
                    item.disposition === "updated" || item.disposition === "unchanged" ? "existing" : item.disposition,
            })),
        });
        return { history: changed ? history : clone(rawHistory || {}), changed, summary, items, confirmationMeaning };
    }

    globalThis.BetterChzzkWatchHistoryBackupMerge = Object.freeze({
        mergeBackup,
        restoreAfterBarrier,
        compactRestoreScope,
        mergeRestoreScopes,
        DEFAULT_MAX_STORAGE_BYTES,
    });
})();
