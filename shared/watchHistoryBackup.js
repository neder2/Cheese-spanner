/**
 * 시청 기록 백업 파일의 순수 변환·검사. 저장 원본을 허용 목록으로 투영하며 IO는 호출자가 소유해요.
 */
(() => {
    "use strict";

    const KIND = "cheese-spanner.watch-history-backup";
    const FORMAT_VERSION = 1;
    const DAY_MS = 86400000;
    const KST_OFFSET_MS = 9 * 3600000;
    const FUTURE_SKEW_MS = 300000;
    const LIMITS = Object.freeze({
        maxBytes: 16 * 1024 * 1024,
        records: 2000,
        recordAliases: 2000,
        sessionDetails: 300,
        retiredSessionCheckpoints: 1000,
        watchedRanges: 200,
        titleHistory: 20,
        messagesPerRecord: 500,
        messagesTotal: 3000,
        dailyEntries: 400,
    });
    const RECORD_FIELDS = [
        "id",
        "channelId",
        "liveId",
        "channelName",
        "title",
        "titleHistory",
        "liveOpenDate",
        "liveUrl",
        "thumbnailUrl",
        "replayVideoNo",
        "firstWatchedAt",
        "lastWatchedAt",
        "watch",
        "chat",
    ];
    const SESSION_FIELDS = ["id", "title", "enteredAt", "leftAt", "watchedSeconds", "dailySeconds", "closed"];

    function fail(code = "INVALID_FILE") {
        const messages = {
            INVALID_FILE: "백업 파일의 형식이나 기록 내용이 올바르지 않아요. 원본 파일을 다시 확인해 주세요.",
            UNSUPPORTED_VERSION: "지원하지 않는 백업 파일 버전이에요. 확장 프로그램 버전을 확인해 주세요.",
            LIMIT_EXCEEDED: "백업 파일의 크기나 기록 수가 보관 한도를 넘어요. 기록은 변경하지 않았어요.",
        };
        const error = new Error(messages[code]);
        error.code = code;
        throw error;
    }

    function byteLength(text) {
        if (typeof text !== "string") fail();
        let bytes = 0;
        for (let index = 0; index < text.length; index++) {
            const unit = text.charCodeAt(index);
            if (unit < 0x80) bytes++;
            else if (unit < 0x800) bytes += 2;
            else if (
                unit >= 0xd800 &&
                unit <= 0xdbff &&
                index + 1 < text.length &&
                text.charCodeAt(index + 1) >= 0xdc00 &&
                text.charCodeAt(index + 1) <= 0xdfff
            ) {
                bytes += 4;
                index++;
            } else bytes += 3;
        }
        return bytes;
    }

    function context(options = {}) {
        const now = options.now ?? Date.now();
        const maxBytes = options.maxBytes ?? LIMITS.maxBytes;
        if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail();
        return { now, maxBytes, bytes: 0 };
    }

    function spend(ctx, bytes) {
        ctx.bytes += bytes;
        if (ctx.bytes > ctx.maxBytes) fail("LIMIT_EXCEEDED");
    }

    function object(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) fail();
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== null && Object.getPrototypeOf(prototype) !== null) fail();
        if (Object.getOwnPropertySymbols(value).length) fail();
        for (const key of Object.keys(value)) {
            if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value")) fail();
        }
        return value;
    }

    function fields(value, required, ctx, optional = []) {
        object(value);
        const keys = Object.keys(value);
        if (
            required.some((key) => !Object.hasOwn(value, key)) ||
            keys.some((key) => !required.includes(key) && !optional.includes(key))
        )
            fail();
        // A lower byte bound stops oversized trees early; the exact serialized size is checked at the end.
        spend(ctx, 2 + keys.reduce((sum, key) => sum + key.length + 3, 0));
        return value;
    }

    function array(value, max, ctx) {
        if (!Array.isArray(value)) fail();
        if (value.length > max) fail("LIMIT_EXCEEDED");
        if (ctx) spend(ctx, 2);
        return value;
    }

    function string(value, max, ctx, required = false) {
        if (typeof value !== "string" || (required && !value.trim())) fail();
        if (value.length > max) fail("LIMIT_EXCEEDED");
        if (ctx) spend(ctx, byteLength(JSON.stringify(value)));
        return value;
    }

    function integer(value, ctx) {
        if (!Number.isSafeInteger(value) || value < 0) fail();
        if (ctx) spend(ctx, String(value).length);
        return value;
    }

    function timestamp(value, ctx, required = false) {
        integer(value, ctx);
        if ((required && !value) || value > ctx.now + FUTURE_SKEW_MS) fail();
        return value;
    }

    function safeAdd(a, b) {
        const result = a + b;
        if (!Number.isSafeInteger(result)) fail();
        return result;
    }

    function kstDate(at) {
        return new Date(at + KST_OFFSET_MS).toISOString().slice(0, 10);
    }

    function dateStart(date, ctx) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail();
        const utc = Date.parse(`${date}T00:00:00Z`);
        if (
            !Number.isFinite(utc) ||
            new Date(utc).toISOString().slice(0, 10) !== date ||
            utc - KST_OFFSET_MS < 0 ||
            date > kstDate(ctx.now + FUTURE_SKEW_MS)
        )
            fail();
        return utc - KST_OFFSET_MS;
    }

    function daily(value, ctx) {
        object(value);
        const entries = Object.entries(value);
        if (entries.length > LIMITS.dailyEntries) fail("LIMIT_EXCEEDED");
        const out = {};
        spend(ctx, 2);
        for (const [date, count] of entries) {
            dateStart(date, ctx);
            spend(ctx, date.length + 3);
            out[date] = integer(count, ctx);
        }
        entries.reduce((sum, [, count]) => safeAdd(sum, count), 0);
        return out;
    }

    function recordId(value, ctx) {
        string(value, 240, ctx, true);
        if (!/^(?:live|channel):[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*$/.test(value)) fail();
        return value;
    }

    function url(value, ctx, { live = false, channelId = "" } = {}) {
        string(value, 2000, ctx);
        if (!value) return "";
        let parsed;
        try {
            parsed = new URL(value);
        } catch {
            fail();
        }
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.hash) fail();
        for (const key of parsed.searchParams.keys()) {
            if (/^(?:token|access_token|authorization|cookie|password|secret|credential|api_key)$/i.test(key)) fail();
        }
        if (live) {
            if (
                parsed.hostname !== "chzzk.naver.com" ||
                parsed.search ||
                !/^\/live\/[A-Za-z0-9_-]{1,100}\/?$/.test(parsed.pathname) ||
                (channelId && parsed.pathname.replace(/\/$/, "") !== `/live/${channelId}`)
            )
                fail();
        } else if (
            !(
                ["chzzk.naver.com", "livecloud-thumb.akamaized.net", "pstatic.net"].includes(parsed.hostname) ||
                parsed.hostname.endsWith(".pstatic.net") ||
                parsed.hostname.endsWith(".chzzk.naver.com")
            )
        )
            fail();
        return value;
    }

    function titleRow(value, ctx) {
        fields(value, ["title", "firstSeenAt", "lastSeenAt"], ctx);
        const out = {
            title: string(value.title, 500, ctx, true),
            firstSeenAt: timestamp(value.firstSeenAt, ctx),
            lastSeenAt: timestamp(value.lastSeenAt, ctx),
        };
        if (out.firstSeenAt && out.lastSeenAt && out.lastSeenAt < out.firstSeenAt) fail();
        return out;
    }

    function session(value, ctx, retired = false) {
        fields(value, [...SESSION_FIELDS, retired ? "checkpointedAt" : "watchedRanges"], ctx);
        const out = {
            id: string(value.id, 160, ctx, true),
            title: string(value.title, 500, ctx),
            enteredAt: timestamp(value.enteredAt, ctx, true),
            leftAt: timestamp(value.leftAt, ctx, true),
            watchedSeconds: integer(value.watchedSeconds, ctx),
            dailySeconds: daily(value.dailySeconds, ctx),
        };
        if (
            out.id !== out.id.trim() ||
            out.leftAt < out.enteredAt ||
            out.watchedSeconds > Math.ceil((out.leftAt - out.enteredAt) / 1000)
        )
            fail();
        for (const [date, seconds] of Object.entries(out.dailySeconds)) {
            if (seconds > 0 && (date < kstDate(out.enteredAt) || date > kstDate(out.leftAt))) fail();
            const start = dateStart(date, ctx);
            const available = Math.max(0, Math.min(out.leftAt, start + DAY_MS) - Math.max(out.enteredAt, start));
            if (seconds > Math.ceil(available / 1000) + 1) fail();
        }
        // The collector floors the session total and rounds each positive day's total independently.
        // For n represented days, sum(round(day)) - floor(sum(day)) cannot exceed ceil(n / 2).
        const positiveDailySeconds = Object.values(out.dailySeconds).filter((seconds) => seconds > 0);
        const dailyTotal = positiveDailySeconds.reduce((sum, seconds) => safeAdd(sum, seconds), 0);
        if (dailyTotal - out.watchedSeconds > Math.ceil(positiveDailySeconds.length / 2)) fail();
        if (typeof value.closed !== "boolean") fail();
        spend(ctx, value.closed ? 4 : 5);
        if (retired) {
            out.closed = value.closed;
            out.checkpointedAt = timestamp(value.checkpointedAt, ctx, true);
            if (out.checkpointedAt < out.enteredAt) fail();
        } else {
            out.watchedRanges = array(value.watchedRanges, LIMITS.watchedRanges, ctx).map((range) => {
                fields(range, ["startAt", "endAt"], ctx);
                const startAt = timestamp(range.startAt, ctx, true);
                const endAt = timestamp(range.endAt, ctx, true);
                if (startAt < out.enteredAt || endAt > out.leftAt || endAt <= startAt || endAt - startAt > 366 * DAY_MS)
                    fail();
                return { startAt, endAt };
            });
            out.closed = value.closed;
        }
        return out;
    }

    function watch(value, ctx) {
        fields(
            value,
            [
                "watchedSeconds",
                "dailySeconds",
                "sessions",
                "sessionDetails",
                "retiredSessionCheckpoints",
                "retiredSessionStartedAtBarrier",
            ],
            ctx
        );
        const out = {
            watchedSeconds: integer(value.watchedSeconds, ctx),
            dailySeconds: daily(value.dailySeconds, ctx),
            sessions: integer(value.sessions, ctx),
            sessionDetails:
                value.sessionDetails === null
                    ? null
                    : array(value.sessionDetails, LIMITS.sessionDetails, ctx).map((row) => session(row, ctx)),
            retiredSessionCheckpoints: array(
                value.retiredSessionCheckpoints,
                LIMITS.retiredSessionCheckpoints,
                ctx
            ).map((row) => session(row, ctx, true)),
            retiredSessionStartedAtBarrier: timestamp(value.retiredSessionStartedAtBarrier, ctx),
        };
        if (out.sessionDetails === null) spend(ctx, 4);
        const known = [...(out.sessionDetails || []), ...out.retiredSessionCheckpoints];
        const ids = new Set();
        const representedDaily = {};
        let representedSeconds = 0;
        for (const row of known) {
            if (ids.has(row.id)) fail();
            ids.add(row.id);
            representedSeconds = safeAdd(representedSeconds, row.watchedSeconds);
            for (const [date, seconds] of Object.entries(row.dailySeconds))
                representedDaily[date] = safeAdd(representedDaily[date] || 0, seconds);
        }
        if (out.sessions < known.length || out.watchedSeconds < representedSeconds) fail();
        for (const [date, seconds] of Object.entries(representedDaily))
            if ((out.dailySeconds[date] || 0) < seconds) fail();
        const positiveDays = Object.values(out.dailySeconds).filter((seconds) => seconds > 0);
        const dailyTotal = positiveDays.reduce((sum, seconds) => safeAdd(sum, seconds), 0);
        const knownRounding = known.reduce(
            (sum, row) => sum + Math.ceil(Object.values(row.dailySeconds).filter((seconds) => seconds > 0).length / 2),
            0
        );
        // Compacted/legacy sessions retain only aggregates. Bound their possible rounding by their count
        // and represented days instead of pretending that all residual daily totals are exact details.
        const residualSessions = Math.max(out.sessions - known.length, out.watchedSeconds > representedSeconds ? 1 : 0);
        const rounding = knownRounding + residualSessions * Math.ceil(positiveDays.length / 2);
        if (dailyTotal - out.watchedSeconds > rounding) fail();
        return out;
    }

    function chat(value, ctx) {
        fields(value, ["messages", "dailyCounts", "cutoffAt"], ctx);
        const ids = new Set();
        const representedDaily = {};
        const messages = array(value.messages, LIMITS.messagesPerRecord, ctx).map((row) => {
            fields(row, ["id", "at", "text"], ctx, ["sessionStartedAt"]);
            const out = {
                id: string(row.id, 180, ctx, true),
                at: timestamp(row.at, ctx, true),
                text: string(row.text, 400, ctx),
            };
            const match = out.id.match(/^([A-Za-z0-9_-]{1,128}):(\d{13}):1$/);
            if (!match || Number(match[2]) !== out.at || out.at < Date.UTC(2020, 0, 1) || ids.has(out.id)) fail();
            ids.add(out.id);
            if (Object.hasOwn(row, "sessionStartedAt")) {
                out.sessionStartedAt = timestamp(row.sessionStartedAt, ctx, true);
                if (out.sessionStartedAt > out.at) fail();
            }
            const date = kstDate(out.at);
            representedDaily[date] = (representedDaily[date] || 0) + 1;
            return out;
        });
        const dailyCounts = daily(value.dailyCounts, ctx);
        for (const [date, count] of Object.entries(representedDaily)) if ((dailyCounts[date] || 0) < count) fail();
        return { messages, dailyCounts, cutoffAt: timestamp(value.cutoffAt, ctx) };
    }

    function record(value, ctx) {
        fields(value, RECORD_FIELDS, ctx);
        const out = {
            id: recordId(value.id, ctx),
            channelId: string(value.channelId, 100, ctx),
            liveId: string(value.liveId, 240, ctx),
            channelName: string(value.channelName, 240, ctx),
            title: string(value.title, 500, ctx),
            titleHistory: array(value.titleHistory, LIMITS.titleHistory, ctx).map((row) => titleRow(row, ctx)),
            liveOpenDate: string(value.liveOpenDate, 240, ctx),
            liveUrl: url(value.liveUrl, ctx, { live: true, channelId: value.channelId }),
            thumbnailUrl: url(value.thumbnailUrl, ctx),
            replayVideoNo: string(value.replayVideoNo, 240, ctx),
            firstWatchedAt: timestamp(value.firstWatchedAt, ctx),
            lastWatchedAt: timestamp(value.lastWatchedAt, ctx),
            watch: watch(value.watch, ctx),
            chat: chat(value.chat, ctx),
        };
        if (
            (out.channelId && !/^[A-Za-z0-9_-]{1,100}$/.test(out.channelId)) ||
            (out.replayVideoNo && !/^\d+$/.test(out.replayVideoNo)) ||
            (out.liveId && !/^[A-Za-z0-9_-]+$/.test(out.liveId))
        )
            fail();
        if (out.id.startsWith("live:")) {
            if (out.id !== `live:${out.liveId}`) fail();
        } else if (!out.channelId || out.id.split(":")[1] !== out.channelId || out.liveId) fail();
        if (out.firstWatchedAt && out.lastWatchedAt && out.lastWatchedAt < out.firstWatchedAt) fail();
        for (const row of [...(out.watch.sessionDetails || []), ...out.watch.retiredSessionCheckpoints]) {
            if (
                (out.firstWatchedAt && row.enteredAt < out.firstWatchedAt) ||
                (out.lastWatchedAt && row.leftAt > out.lastWatchedAt)
            )
                fail();
        }
        if (out.liveOpenDate) {
            const date = out.liveOpenDate.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
            if (!date) fail();
            dateStart(date, ctx);
            const text = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(out.liveOpenDate)
                ? `${out.liveOpenDate.replace(" ", "T")}+09:00`
                : out.liveOpenDate;
            const at = Date.parse(text);
            if (!Number.isFinite(at) || at <= 0 || at > ctx.now + FUTURE_SKEW_MS) fail();
        }
        return out;
    }

    function validateBackup(value, options = {}) {
        const ctx = context(options);
        fields(value, ["kind", "formatVersion", "extensionVersion", "createdAt", "records", "recordAliases"], ctx);
        if (value.kind !== KIND) fail();
        if (value.formatVersion !== FORMAT_VERSION) fail("UNSUPPORTED_VERSION");
        spend(ctx, KIND.length + 3);
        const extensionVersion = string(value.extensionVersion, 100, ctx, true);
        if (!/^\d+(?:\.\d+){0,3}$/.test(extensionVersion)) fail();
        const createdAt = timestamp(value.createdAt, ctx, true);
        const records = array(value.records, LIMITS.records, ctx).map((row) => record(row, ctx));
        const byId = new Map();
        let messagesTotal = 0;
        let chatsTotal = 0;
        for (const row of records) {
            if (byId.has(row.id)) fail();
            byId.set(row.id, row);
            messagesTotal += row.chat.messages.length;
            for (const count of Object.values(row.chat.dailyCounts)) chatsTotal = safeAdd(chatsTotal, count);
        }
        if (messagesTotal > LIMITS.messagesTotal) fail("LIMIT_EXCEEDED");
        const sources = new Set();
        const recordAliases = array(value.recordAliases, LIMITS.recordAliases, ctx).map((row) => {
            fields(row, ["sourceRecordId", "targetRecordId", "migratedAt"], ctx);
            const sourceRecordId = recordId(row.sourceRecordId, ctx);
            const targetRecordId = recordId(row.targetRecordId, ctx);
            const migratedAt = timestamp(row.migratedAt, ctx, true);
            const target = byId.get(targetRecordId);
            if (
                !sourceRecordId.startsWith("channel:") ||
                !targetRecordId.startsWith("live:") ||
                !target ||
                sourceRecordId.split(":")[1] !== target.channelId ||
                sources.has(sourceRecordId) ||
                byId.has(sourceRecordId)
            )
                fail();
            sources.add(sourceRecordId);
            return { sourceRecordId, targetRecordId, migratedAt };
        });
        const backup = {
            kind: KIND,
            formatVersion: FORMAT_VERSION,
            extensionVersion,
            createdAt,
            records,
            recordAliases,
        };
        if (byteLength(JSON.stringify(backup)) > ctx.maxBytes) fail("LIMIT_EXCEEDED");
        return backup;
    }

    function parseBackup(text, options = {}) {
        const ctx = context(options);
        if (byteLength(text) > ctx.maxBytes) fail("LIMIT_EXCEEDED");
        let value;
        try {
            value = JSON.parse(text);
        } catch {
            fail();
        }
        return validateBackup(value, options);
    }

    // Only documented legacy scalar representations are converted; malformed values are not discarded.
    function storedNumber(value, fallback = 0) {
        if (value === undefined || value === null) return fallback;
        if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
        return value;
    }

    function storedString(value) {
        if (value === undefined || value === null) return "";
        return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
    }

    function storedDaily(value) {
        if (value === undefined || value === null) return {};
        object(value);
        if (Object.keys(value).length > LIMITS.dailyEntries) fail("LIMIT_EXCEEDED");
        return Object.fromEntries(Object.entries(value).map(([date, count]) => [date, storedNumber(count)]));
    }

    function storedSession(value, retired = false) {
        object(value);
        const out = {
            id: storedString(value.id),
            title: storedString(value.title),
            enteredAt: storedNumber(value.enteredAt) || storedNumber(value.startedAt),
            leftAt: storedNumber(value.leftAt) || storedNumber(value.endedAt) || storedNumber(value.lastWatchedAt),
            watchedSeconds: storedNumber(value.watchedSeconds),
            dailySeconds: storedDaily(value.dailySeconds),
        };
        if (!retired)
            out.watchedRanges = array(value.watchedRanges ?? [], LIMITS.watchedRanges).map((row) => {
                object(row);
                return { startAt: storedNumber(row.startAt), endAt: storedNumber(row.endAt) };
            });
        out.closed = value.closed === undefined ? false : value.closed;
        if (retired) out.checkpointedAt = storedNumber(value.checkpointedAt, out.leftAt || out.enteredAt);
        return out;
    }

    function storedTitle(value) {
        if (typeof value === "string") return { title: value, firstSeenAt: 0, lastSeenAt: 0 };
        object(value);
        const firstSeenAt = storedNumber(value.firstSeenAt ?? value.seenAt ?? value.createdAt);
        return {
            title: storedString(value.title ?? value.name ?? value.value),
            firstSeenAt,
            lastSeenAt: storedNumber(value.lastSeenAt ?? value.updatedAt, firstSeenAt),
        };
    }

    function storedReplayVideoNo(value) {
        for (const candidate of [value.replayVideoNo, value.videoNo, value.videoId]) {
            const text = storedString(candidate);
            string(text, 240);
            if (text.trim()) return text.trim();
        }
        return "";
    }

    function storedLiveUrl(value, channelId) {
        const raw = storedString(value);
        string(raw, 2000);
        if (!raw.trim()) return channelId ? `https://chzzk.naver.com/live/${channelId}` : "";
        let parsed;
        let linkedChannelId;
        try {
            parsed = new URL(raw.trim());
            const match = parsed.pathname.match(/^\/live\/([^/]+)\/?$/);
            if (!match) fail();
            linkedChannelId = decodeURIComponent(match[1]);
        } catch {
            fail();
        }
        if (
            parsed.protocol !== "https:" ||
            parsed.hostname !== "chzzk.naver.com" ||
            parsed.username ||
            parsed.password ||
            parsed.port ||
            !/^[A-Za-z0-9_-]{1,100}$/.test(linkedChannelId) ||
            (channelId && linkedChannelId !== channelId)
        )
            fail();
        for (const key of parsed.searchParams.keys()) {
            if (/^(?:token|access_token|authorization|cookie|password|secret|credential|api_key)$/i.test(key)) fail();
        }
        // The existing live-link normalizer accepts encoded channel IDs, a trailing slash, query and hash.
        // Check its source identity and origin before emitting the canonical address used by the history page.
        return `https://chzzk.naver.com/live/${linkedChannelId}`;
    }

    function projectRecord(value, id = value.id) {
        object(value);
        const messages = array(value.activities ?? [], LIMITS.messagesPerRecord)
            .filter((row) => {
                object(row);
                if (!["chat", "donation"].includes(row.kind)) fail();
                return row.kind === "chat";
            })
            .map((row) => ({
                id: storedString(row.id),
                at: storedNumber(row.at),
                text: storedString(row.text),
                ...(row.sessionStartedAt === undefined ? {} : { sessionStartedAt: storedNumber(row.sessionStartedAt) }),
            }));
        const dailyCounts = {};
        for (const [date, counts] of Object.entries(object(value.activityDaily ?? {}))) {
            object(counts);
            const count = storedNumber(counts.chatCount);
            if (count !== 0) dailyCounts[date] = count;
        }
        const rawChannelId = storedString(value.channelId);
        string(rawChannelId, 100);
        const channelId = rawChannelId.trim();
        return {
            id,
            channelId,
            liveId:
                id.startsWith("live:") && (!value.liveId || id !== value.id) ? id.slice(5) : storedString(value.liveId),
            channelName: storedString(value.channelName),
            title: storedString(value.title),
            titleHistory: array(value.titleHistory ?? [], LIMITS.titleHistory).map(storedTitle),
            liveOpenDate: storedString(value.liveOpenDate),
            liveUrl: storedLiveUrl(value.liveUrl, channelId),
            thumbnailUrl: storedString(value.thumbnailUrl),
            replayVideoNo: storedReplayVideoNo(value),
            firstWatchedAt: storedNumber(value.firstWatchedAt),
            lastWatchedAt: storedNumber(value.lastWatchedAt),
            watch: {
                watchedSeconds: storedNumber(value.watchedSeconds),
                dailySeconds: storedDaily(value.dailySeconds),
                sessions: storedNumber(value.sessions),
                sessionDetails:
                    value.sessionDetails == null
                        ? null
                        : array(value.sessionDetails, LIMITS.sessionDetails).map((row) => storedSession(row)),
                retiredSessionCheckpoints: array(
                    value.retiredSessionCheckpoints ?? [],
                    LIMITS.retiredSessionCheckpoints
                ).map((row) => storedSession(row, true)),
                retiredSessionStartedAtBarrier: storedNumber(value.retiredSessionStartedAtBarrier),
            },
            chat: { messages, dailyCounts, cutoffAt: storedNumber(value.chatCutoffAt ?? value.activityCutoffAt) },
        };
    }

    function hasContent(row) {
        return (
            row.watch.watchedSeconds !== 0 ||
            row.watch.sessions !== 0 ||
            (row.watch.sessionDetails || []).length > 0 ||
            row.watch.retiredSessionCheckpoints.length > 0 ||
            Object.values(row.watch.dailySeconds).some((count) => count !== 0) ||
            row.chat.messages.length > 0 ||
            Object.values(row.chat.dailyCounts).some((count) => count !== 0)
        );
    }

    function createBackup(history, options = {}) {
        const ctx = context(options);
        const source = history === undefined ? {} : object(history);
        const rawEntries =
            source.entries === undefined
                ? []
                : Array.isArray(source.entries)
                  ? source.entries
                  : Object.values(object(source.entries));
        array(rawEntries, LIMITS.records);
        const rawAliases = object(source.recordAliases ?? {});
        if (Object.keys(rawAliases).length > LIMITS.recordAliases) fail("LIMIT_EXCEEDED");
        const aliases = Object.entries(rawAliases).map(([sourceRecordId, row]) => ({
            sourceRecordId,
            targetRecordId: typeof row === "string" ? row : object(row).targetRecordId,
            migratedAt: storedNumber(typeof row === "string" ? source.updatedAt : row.migratedAt),
        }));
        const bySource = new Map(aliases.map((row) => [row.sourceRecordId, row]));
        const records = rawEntries
            .map((row) => {
                object(row);
                const id = recordId(row.id, ctx);
                return projectRecord(row, recordId(bySource.get(id)?.targetRecordId ?? id, ctx));
            })
            .filter(hasContent);
        const targets = new Set(records.map((row) => row.id));
        const recordAliases = aliases.filter((row) => targets.has(row.targetRecordId));
        return validateBackup(
            {
                kind: KIND,
                formatVersion: FORMAT_VERSION,
                extensionVersion: options.extensionVersion,
                createdAt: options.createdAt ?? ctx.now,
                records,
                recordAliases,
            },
            options
        );
    }

    function projectStoredRecord(value, options = {}) {
        return validateBackup(
            {
                kind: KIND,
                formatVersion: FORMAT_VERSION,
                extensionVersion: "0",
                createdAt: options.now ?? Date.now(),
                records: [projectRecord(value)],
                recordAliases: [],
            },
            options
        ).records[0];
    }

    function summarizeBackup(backup) {
        let periodStartAt = null;
        let periodEndAt = null;
        let storedChats = 0;
        let totalChats = 0;
        const include = (at) => {
            if (!at) return;
            periodStartAt = periodStartAt === null ? at : Math.min(periodStartAt, at);
            periodEndAt = periodEndAt === null ? at : Math.max(periodEndAt, at);
        };
        for (const row of backup.records) {
            const datedTimes = new Set();
            const includeObserved = (at) => {
                if (at) datedTimes.add(kstDate(at));
                include(at);
            };
            for (const session of [...(row.watch.sessionDetails || []), ...row.watch.retiredSessionCheckpoints]) {
                includeObserved(session.enteredAt);
                includeObserved(session.leftAt);
            }
            if (row.watch.watchedSeconds || row.watch.sessions) {
                includeObserved(row.firstWatchedAt);
                includeObserved(row.lastWatchedAt);
            }
            for (const message of row.chat.messages) includeObserved(message.at);
            const dates = new Set([...Object.keys(row.watch.dailySeconds), ...Object.keys(row.chat.dailyCounts)]);
            for (const date of dates) {
                if (!row.watch.dailySeconds[date] && !row.chat.dailyCounts[date]) continue;
                if (datedTimes.has(date)) continue;
                const start = Date.parse(`${date}T00:00:00+09:00`);
                include(start);
                include(Math.min(start + DAY_MS - 1, Math.max(start, backup.createdAt)));
            }
            storedChats += row.chat.messages.length;
            for (const count of Object.values(row.chat.dailyCounts)) totalChats = safeAdd(totalChats, count);
        }
        return {
            exportedAt: backup.createdAt,
            periodStartAt,
            periodEndAt,
            records: backup.records.length,
            storedChats,
            totalChats,
        };
    }

    globalThis.BetterChzzkWatchHistoryBackup = Object.freeze({
        KIND,
        FORMAT_VERSION,
        LIMITS,
        byteLength,
        createBackup,
        projectStoredRecord,
        validateBackup,
        parseBackup,
        summarizeBackup,
    });
})();
