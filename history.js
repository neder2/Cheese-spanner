/**
 * history.js — history.html(시청 기록 페이지)의 스크립트로, 로컬에 쌓인 라이브 시청 기록을 달력·목록으로 보여준다.
 *
 * 실행 컨텍스트: 확장 자체 페이지 history.html에서 로드된다. history.html은 shared/data.js를 먼저 script
 * 태그로 로드하고 그다음 이 파일을 로드한다. content script가 아니라 확장 페이지 스크립트다.
 * 하는 일: chrome.storage.local의 기록을 읽어 정규화하고, 월별 달력·목록·요약 통계를 렌더링한다.
 * 검색/정렬, 항목 선택/삭제, 세션(입장~퇴장) 세부 보기를 제공하며, 클릭 시 치지직 API로 다시보기
 * 영상을 찾아 새 탭으로 연다. storage.onChanged를 구독해 다른 곳의 변경도 반영한다.
 * 의존: globalThis.chrome.storage.local, globalThis.chrome.runtime,
 * globalThis.BetterChzzk.utils(shared/data.js가 채움).
 * 통신: chrome.storage.local 키 "betterChzzkLiveWatchHistory"는 읽기와 변경 감지에만 사용한다.
 * 삭제·초기화·다시보기 캐시는 runtime 메시지로 background 단일 writer에 요청한다.
 * api.chzzk.naver.com의 채널 영상 목록/영상 상세 API를 호출해 다시보기 videoNo를 찾는다.
 * 구조(위→아래 순서):
 * - 상수/DOM 참조/전역 상태 선언 (STORAGE_KEY, API_BASE 등, 각 엘리먼트 참조, entries 등 상태 변수)
 * - 제목 이력/표시 텍스트 포맷터 (getEntryTitleRows, formatDateLabel, formatDuration 등)
 * - 세션 정규화/병합 (mergeContinuousSessionDetails, normalizeSessionDetails, normalizeHistory)
 * - background mutation 메시지 전송 헬퍼 (sendWatchHistoryMutation)
 * - 다시보기 매칭 로직 (extractReplayVideos, videoCouldMatchEntry, scoreReplayCandidate,
 *   resolveReplayVideoNo)
 * - 월 선택/집계 헬퍼 (ensureSelectedMonth, getMonthScopeBounds, getUniqueWatchSecondsForMonth)
 * - 목록 정렬/필터/선택 상태 (getVisibleRows, renderSelectionControls, setEntrySelected 등)
 * - 다시보기 열기 흐름 (persistReplayVideoNo, openUrlInNewTab, handleTitleClick)
 * - 렌더링 함수 (renderCalendar, renderList, renderSummary, renderAll)
 * - storage 로드/새로고침과 background 삭제 액션 (loadHistory, refreshHistory, clearHistory,
 *   deleteEntriesByIds)
 * - 이벤트 리스너 등록과 초기 로드 호출 (파일 최하단)
 */
const STORAGE_KEY = "betterChzzkLiveWatchHistory";
const WATCH_HISTORY_MESSAGE_TYPE = "betterChzzk:watch-history-mutation";
const WATCH_HISTORY_MESSAGE_VERSION = 1;
const API_BASE = "https://api.chzzk.naver.com/service/v1/channels";
const VIDEO_DETAIL_API_BASE = "https://api.chzzk.naver.com/service/v2/videos";
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_WATCH_SECONDS = 60;
const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
const VIDEO_PAGE_SIZE = 30;
const REPLAY_LOOKUP_MAX_PAGES = 80;
const FETCH_TIMEOUT_MS = 8000;
const REPLAY_LOOKUP_MAX_DURATION_MS = 20000;
const REPLAY_DETAIL_CANDIDATES_PER_PAGE = 5;
const REPLAY_LOOKUP_MAX_DETAIL_REQUESTS = 20;
const REPLAY_LOOKUP_RESERVED_EXACT_DETAIL_REQUESTS = 5;
const REPLAY_LOOKUP_MAX_CONSECUTIVE_ERRORS = 3;
const REPLAY_LOOKUP_NEGATIVE_CACHE_TTL_MS = 30000;
const START_EXACT_TOLERANCE_MS = 20 * 60 * 1000;
const START_LOOSE_TOLERANCE_MS = 3 * 60 * 60 * 1000;
const TARGET_WINDOW_MS = 7 * DAY_MS;
const MAX_REPLAY_LOOKUP_CACHE_ENTRIES = 80;
const DISPLAY_WATCH_RANGE_MERGE_GAP_MS = 5 * 60 * 1000;
const SESSION_MERGE_GAP_MS = 60 * 1000;
const STORAGE_CHANGE_RELOAD_DEBOUNCE_MS = 2000;

const storage = globalThis.chrome?.storage?.local;
const {
    addTitleHistory,
    addWatchRangeToRangesByDate,
    buildChzzkLiveUrl,
    cleanEntryTitle,
    collectWatchSessionRanges,
    compactSpaces,
    fetchJson,
    formatKstDateTime,
    formatKstMonthKey: formatMonthKey,
    formatKstTime,
    getKstDateScopeBounds: getDateScopeBounds,
    getKstMonthStartMs,
    getKstParts,
    getUniqueWatchTotals,
    isSameKstDate,
    mergeDailySeconds: mergeSessionDailySeconds,
    mergeWatchRanges,
    normalizeChzzkChannelId,
    normalizeChzzkLiveUrl,
    normalizeDailySeconds,
    normalizeForMatch,
    normalizeTitleHistory,
    parseChzzkDate,
    pickArray = () => null,
    pickChzzkVideoNo,
    pickString,
    pickVideoEndDateText,
    pickVideoStartDateText,
    runtimeSendMessage,
    storageGet,
    sumWatchRanges,
    sumWatchRangesByDate,
    touchMapEntry,
} = globalThis.BetterChzzk?.utils || {};

const noticeEl = document.getElementById("notice");
const totalWatchTimeEl = document.getElementById("totalWatchTime");
const totalLiveCountEl = document.getElementById("totalLiveCount");
const monthWatchTimeEl = document.getElementById("monthWatchTime");
const calendarTitleEl = document.getElementById("calendarTitle");
const weekdaysEl = document.getElementById("weekdays");
const calendarDaysEl = document.getElementById("calendarDays");
const calendarFootEl = document.getElementById("calendarFoot");
const listDescriptionEl = document.getElementById("listDescription");
const historyListEl = document.getElementById("historyList");
const historySearchEl = document.getElementById("historySearch");
const historySortEl = document.getElementById("historySort");
const historySortDirectionEl = document.getElementById("historySortDirection");
const prevMonthButton = document.getElementById("prevMonth");
const calendarRefreshButton = document.getElementById("calendarRefresh");
const nextMonthButton = document.getElementById("nextMonth");
const refreshButton = document.getElementById("refresh");
const clearHistoryButton = document.getElementById("clearHistory");
const selectVisibleHistoryEl = document.getElementById("selectVisibleHistory");
const selectionStatusEl = document.getElementById("selectionStatus");
const deleteSelectedHistoryButton = document.getElementById("deleteSelectedHistory");
const messageEl = document.getElementById("message");

let entries = [];
let selectedYear = 0;
let selectedMonth = 0;
let selectedDateKey = "";
let hideMessageTimer = 0;
let storageChangeReloadTimer = 0;
const selectedEntryIds = new Set();
const expandedEntryIds = new Set();
const replayLookupCache = new Map();
const resolvingReplayEntryIds = new Set();

async function sendWatchHistoryMutation(operation) {
    const response = await runtimeSendMessage({
        type: WATCH_HISTORY_MESSAGE_TYPE,
        version: WATCH_HISTORY_MESSAGE_VERSION,
        operation,
    });
    if (!response?.ok) throw new Error(response?.error || "Watch history mutation failed");
    return response.result || {};
}

function getEntryTitleRows(entry) {
    const target = {
        channelName: entry?.channelName || "",
        titleHistory: normalizeTitleHistory(entry?.titleHistory, entry?.channelName),
    };
    addTitleHistory(target, entry?.title, entry?.firstWatchedAt || entry?.lastWatchedAt);
    return target.titleHistory || [];
}

function getEntryTitles(entry) {
    return getEntryTitleRows(entry).map((row) => row.title);
}

function getEntryTitleNorms(entry) {
    return getEntryTitles(entry).map(normalizeForMatch).filter(Boolean);
}

function getReplayVideoNo(entry) {
    return pickString(entry?.replayVideoNo, entry?.videoNo);
}

function getReplayUrl(entry) {
    const videoNo = getReplayVideoNo(entry);
    return videoNo ? `https://chzzk.naver.com/video/${encodeURIComponent(videoNo)}` : "";
}

function formatDateLabel(dateKey) {
    const parts = String(dateKey).split("-").map(Number);
    if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) return dateKey;
    return `${parts[0]}.${String(parts[1]).padStart(2, "0")}.${String(parts[2]).padStart(2, "0")}`;
}

function formatWatchRange(range) {
    const startAt = Number(range?.startAt) || 0;
    const endAt = Number(range?.endAt) || 0;
    if (startAt <= 0 || endAt <= startAt) return "";
    const showSeconds = endAt - startAt < 60 * 1000 || formatKstDateTime(startAt) === formatKstDateTime(endAt);
    const formatOptions = { seconds: showSeconds };
    const endText = isSameKstDate(startAt, endAt)
        ? formatKstTime(endAt, formatOptions)
        : formatKstDateTime(endAt, formatOptions);
    return `${formatKstDateTime(startAt, formatOptions)} - ${endText}`;
}

function formatDuration(seconds) {
    const totalSeconds = Math.max(0, Math.round(Number(seconds) || 0));
    const totalMinutes = Math.round(totalSeconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours <= 0 && totalMinutes <= 0) return `${totalSeconds}초`;
    if (hours <= 0) return `${totalMinutes}분`;
    if (minutes <= 0) return `${hours}시간`;
    return `${hours}시간 ${minutes}분`;
}

function formatCalendarDuration(seconds) {
    const totalMinutes = Math.max(0, Math.round((Number(seconds) || 0) / 60));
    if (totalMinutes < 60) return `${totalMinutes}m`;

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${hours}h+` : `${hours}h`;
}

function mergeContinuousSessionDetails(sessionDetails) {
    const merged = [];
    const rows = (Array.isArray(sessionDetails) ? sessionDetails : [])
        .filter((session) => session && typeof session === "object")
        .map((session) => ({
            ...session,
            enteredAt: Number(session.enteredAt) || 0,
            leftAt: Number(session.leftAt) || Number(session.enteredAt) || 0,
            watchedSeconds: Math.max(0, Number(session.watchedSeconds) || 0),
            dailySeconds: normalizeDailySeconds(session.dailySeconds),
            watchedRanges: mergeWatchRanges(session.watchedRanges),
        }))
        .filter((session) => session.id && session.enteredAt > 0 && session.watchedSeconds >= MIN_WATCH_SECONDS)
        .sort((a, b) => a.enteredAt - b.enteredAt || a.leftAt - b.leftAt);

    for (const session of rows) {
        const last = merged[merged.length - 1];
        const lastLeftAt = Number(last?.leftAt) || Number(last?.enteredAt) || 0;
        const shouldMerge = last && lastLeftAt > 0 && session.enteredAt <= lastLeftAt + SESSION_MERGE_GAP_MS;

        if (!shouldMerge) {
            merged.push({ ...session, sourceSessions: [session] });
            continue;
        }

        last.sourceSessions.push(session);
        if (session.title) last.title = session.title;
        last.leftAt = Math.max(lastLeftAt, Number(session.leftAt) || session.enteredAt);
        last.watchedRanges = mergeWatchRanges([...(last.watchedRanges || []), ...(session.watchedRanges || [])]);
        last.closed = last.closed === true && session.closed === true;
        last.legacy = last.legacy === true && session.legacy === true;
    }

    return merged
        .map((session) => {
            const sourceSessions = session.sourceSessions;
            const storedTotals = sourceSessions.reduce(
                (totals, source) => {
                    totals.watchedSeconds += Math.max(0, Number(source.watchedSeconds) || 0);
                    mergeSessionDailySeconds(totals.dailySeconds, source.dailySeconds);
                    return totals;
                },
                { watchedSeconds: 0, dailySeconds: {} }
            );
            const uniqueTotals = getUniqueWatchTotals(storedTotals, sourceSessions);
            const normalized = { ...session, ...uniqueTotals };
            delete normalized.sourceSessions;
            return normalized;
        })
        .sort((a, b) => b.enteredAt - a.enteredAt);
}

function normalizeSessionDetails(row, fallbackEntry) {
    const rawSessions = Array.isArray(row.sessionDetails) ? row.sessionDetails : [];
    const hasRawSessions = Array.isArray(row.sessionDetails);
    const sessions = rawSessions
        .filter((session) => session && typeof session === "object")
        .map((session) => {
            const enteredAt = Number(session.enteredAt) || Number(session.startedAt) || 0;
            const leftAt = Number(session.leftAt) || Number(session.endedAt) || Number(session.lastWatchedAt) || 0;
            const watchedRanges = mergeWatchRanges(session.watchedRanges);
            const watchedSeconds = Math.max(0, Number(session.watchedSeconds) || sumWatchRanges(watchedRanges));
            return {
                id: pickString(session.id) || `${enteredAt}:${leftAt}`,
                title: cleanEntryTitle(pickString(session.title), fallbackEntry?.channelName),
                enteredAt,
                leftAt,
                watchedSeconds,
                dailySeconds: normalizeDailySeconds(session.dailySeconds),
                watchedRanges,
                closed: session.closed === true,
                legacy: false,
            };
        })
        .filter((session) => session.id && session.enteredAt > 0 && session.watchedSeconds >= MIN_WATCH_SECONDS);

    if (sessions.length) return sessions;

    if (hasRawSessions || !fallbackEntry || fallbackEntry.watchedSeconds < MIN_WATCH_SECONDS) return [];
    return [
        {
            id: `legacy:${fallbackEntry.id}`,
            title: cleanEntryTitle(fallbackEntry.title, fallbackEntry.channelName) || "",
            enteredAt: fallbackEntry.firstWatchedAt || fallbackEntry.lastWatchedAt,
            leftAt: fallbackEntry.lastWatchedAt || fallbackEntry.firstWatchedAt,
            watchedSeconds: fallbackEntry.watchedSeconds,
            dailySeconds: { ...fallbackEntry.dailySeconds },
            watchedRanges: [],
            closed: true,
            legacy: true,
        },
    ];
}

function getSessionFirstWatchedAt(sessionDetails) {
    const values = (sessionDetails || []).map((session) => Number(session.enteredAt) || 0).filter((value) => value > 0);
    return values.length ? Math.min(...values) : 0;
}

function getSessionLastWatchedAt(sessionDetails) {
    const values = (sessionDetails || [])
        .map((session) => Number(session.leftAt) || Number(session.enteredAt) || 0)
        .filter((value) => value > 0);
    return values.length ? Math.max(...values) : 0;
}

function normalizeHistory(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const rawEntries = Array.isArray(source.entries)
        ? source.entries
        : source.entries && typeof source.entries === "object"
          ? Object.values(source.entries)
          : [];

    return rawEntries
        .filter((row) => row && typeof row === "object")
        .map((row) => {
            const id = pickString(row.id);
            const channelName = pickString(row.channelName) || "알 수 없는 채널";
            const channelId = normalizeChzzkChannelId(row.channelId);
            const entry = {
                id,
                channelId,
                liveId: pickString(row.liveId),
                replayVideoNo: pickString(row.replayVideoNo, row.videoNo, row.videoId),
                title: cleanEntryTitle(pickString(row.title), channelName) || "제목 없는 라이브",
                titleHistory: normalizeTitleHistory(row.titleHistory, channelName),
                channelName,
                liveOpenDate: pickString(row.liveOpenDate),
                liveUrl: buildChzzkLiveUrl(channelId) || normalizeChzzkLiveUrl(row.liveUrl),
                firstWatchedAt: Number(row.firstWatchedAt) || 0,
                lastWatchedAt: Number(row.lastWatchedAt) || 0,
                watchedSeconds: Math.max(0, Number(row.watchedSeconds) || 0),
                sessions: Math.max(1, Math.round(Number(row.sessions) || 1)),
                dailySeconds: normalizeDailySeconds(row.dailySeconds),
            };
            const sourceSessionDetails = normalizeSessionDetails(row, entry);
            const uniqueTotals = getUniqueWatchTotals(entry, sourceSessionDetails);
            entry.sessionDetails = mergeContinuousSessionDetails(sourceSessionDetails);
            entry.watchedSeconds = uniqueTotals.watchedSeconds;
            entry.dailySeconds = uniqueTotals.dailySeconds;
            const sessionFirstWatchedAt = getSessionFirstWatchedAt(entry.sessionDetails);
            const sessionLastWatchedAt = getSessionLastWatchedAt(entry.sessionDetails);
            if (sessionFirstWatchedAt > 0) {
                entry.firstWatchedAt = entry.firstWatchedAt
                    ? Math.min(entry.firstWatchedAt, sessionFirstWatchedAt)
                    : sessionFirstWatchedAt;
            }
            if (sessionLastWatchedAt > 0) {
                entry.lastWatchedAt = Math.max(entry.lastWatchedAt, sessionLastWatchedAt);
            }
            entry.sessions = Math.max(entry.sessions, entry.sessionDetails.length);
            for (const session of entry.sessionDetails) {
                addTitleHistory(entry, session.title, session.enteredAt, session.leftAt || session.enteredAt);
            }
            addTitleHistory(entry, entry.title, entry.firstWatchedAt || entry.lastWatchedAt);
            return entry;
        })
        .filter((entry) => entry.id && entry.sessionDetails.length > 0)
        .sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);
}

function extractReplayVideos(json) {
    const content = json?.content ?? json;
    const rows = pickArray(content);
    if (!rows) return [];

    return rows
        .map((row) => {
            const videoNo = pickChzzkVideoNo(row);
            if (!videoNo) return null;

            const startText = pickVideoStartDateText(row);
            const endText = pickVideoEndDateText(row);
            return {
                videoNo,
                liveId: pickString(row.liveId, row.liveNo, row.live?.liveId, row.live?.liveNo),
                type: pickString(row.videoType, row.type),
                title: pickString(row.videoTitle, row.title, row.liveTitle),
                titleNorm: normalizeForMatch(pickString(row.videoTitle, row.title, row.liveTitle)),
                duration: Number(row.duration),
                startedAt: parseChzzkDate(startText),
                endedAt: parseChzzkDate(endText),
                publishDate: parseChzzkDate(endText),
            };
        })
        .filter(Boolean);
}

function replayOnly(video) {
    return !video.type || video.type.toUpperCase() === "REPLAY";
}

function getVideoStartMs(video) {
    const startMs = video?.startedAt?.getTime?.();
    return Number.isFinite(startMs) ? startMs : null;
}

function getVideoEndMs(video) {
    const endMs = video?.endedAt?.getTime?.();
    if (Number.isFinite(endMs)) return endMs;

    const startMs = getVideoStartMs(video);
    if (startMs !== null && Number.isFinite(video.duration) && video.duration > 0) {
        return startMs + video.duration * 1000;
    }

    const publishMs = video?.publishDate?.getTime?.();
    return Number.isFinite(publishMs) ? publishMs : null;
}

function getEntryTargetMs(entry) {
    const openMs = parseChzzkDate(entry?.liveOpenDate)?.getTime();
    if (Number.isFinite(openMs)) return openMs;

    const first = Number(entry?.firstWatchedAt) || 0;
    if (first > 0) return first;

    const last = Number(entry?.lastWatchedAt) || 0;
    return last > 0 ? last : 0;
}

async function fetchVideoPage(channelId, page, { signal, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
    const params = new URLSearchParams({
        sortType: "LATEST",
        pagingType: "PAGE",
        page: String(page),
        size: String(VIDEO_PAGE_SIZE),
    });
    const url = `${API_BASE}/${encodeURIComponent(channelId)}/videos?${params.toString()}`;
    return fetchJson(url, {
        headers: { Accept: "application/json" },
        signal,
        timeoutMs,
    });
}

async function fetchVideoDetail(videoNo, { signal, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
    const url = `${VIDEO_DETAIL_API_BASE}/${encodeURIComponent(videoNo)}`;
    const json = await fetchJson(url, {
        headers: { Accept: "application/json" },
        signal,
        timeoutMs,
    });
    return json?.content || null;
}

function mergeVideoDetail(video, detail) {
    if (!video || !detail) return video;

    video.detailLiveId = pickString(detail.liveId, detail.liveNo, detail.live?.liveId, detail.live?.liveNo);
    video.liveId = video.liveId || video.detailLiveId;
    video.title = pickString(video.title, detail.videoTitle, detail.title, detail.liveTitle);
    video.titleNorm = normalizeForMatch(video.title);

    const duration = Number(detail.duration);
    if (Number.isFinite(duration) && duration > 0) video.duration = duration;

    const startText = pickVideoStartDateText(detail);
    const endText = pickVideoEndDateText(detail);
    const startedAt = parseChzzkDate(startText);
    const endedAt = parseChzzkDate(endText);
    if (startedAt) video.startedAt = startedAt;
    if (endedAt) {
        video.endedAt = endedAt;
        video.publishDate = video.publishDate || endedAt;
    }

    return video;
}

function hasConflictingLiveId(entry, video) {
    if (!entry?.liveId || !video) return false;
    return [video.liveId, video.detailLiveId].some((liveId) => liveId && entry.liveId !== liveId);
}

function videoCouldMatchEntry(entry, video) {
    if (!video || !replayOnly(video)) return false;
    if (hasConflictingLiveId(entry, video)) return false;
    if (entry.liveId && video.liveId && entry.liveId === video.liveId) return true;

    const targetMs = getEntryTargetMs(entry);
    const startMs = getVideoStartMs(video);
    const endMs = getVideoEndMs(video);
    if (targetMs > 0 && startMs !== null && Math.abs(startMs - targetMs) <= TARGET_WINDOW_MS) return true;
    if (
        targetMs > 0 &&
        startMs !== null &&
        endMs !== null &&
        targetMs >= startMs - START_LOOSE_TOLERANCE_MS &&
        targetMs <= endMs + START_LOOSE_TOLERANCE_MS
    )
        return true;
    if (targetMs > 0 && startMs === null && endMs !== null && endMs >= targetMs && endMs <= targetMs + TARGET_WINDOW_MS)
        return true;

    return getEntryTitleNorms(entry).some(
        (entryTitle) =>
            video.titleNorm && (video.titleNorm.includes(entryTitle) || entryTitle.includes(video.titleNorm))
    );
}

function scoreReplayCandidate(entry, video) {
    if (hasConflictingLiveId(entry, video)) return Number.NEGATIVE_INFINITY;
    let score = 0;

    if (entry.liveId && video.liveId && entry.liveId === video.liveId) score += 1000;

    const targetMs = getEntryTargetMs(entry);
    const startMs = getVideoStartMs(video);
    const endMs = getVideoEndMs(video);
    if (targetMs > 0 && startMs !== null) {
        const diff = Math.abs(startMs - targetMs);
        if (diff <= START_EXACT_TOLERANCE_MS) score += 420;
        else if (diff <= START_LOOSE_TOLERANCE_MS) score += 220;
        else if (diff <= TARGET_WINDOW_MS) score += 80;
    }
    if (
        targetMs > 0 &&
        startMs !== null &&
        endMs !== null &&
        targetMs >= startMs &&
        targetMs <= endMs + START_LOOSE_TOLERANCE_MS
    ) {
        score += 120;
    }
    if (
        targetMs > 0 &&
        startMs === null &&
        endMs !== null &&
        endMs >= targetMs &&
        endMs <= targetMs + TARGET_WINDOW_MS
    ) {
        score += 80;
    }

    let titleScore = 0;
    for (const entryTitle of getEntryTitleNorms(entry)) {
        if (!entryTitle || !video.titleNorm) continue;
        if (entryTitle === video.titleNorm) titleScore = Math.max(titleScore, 180);
        else if (video.titleNorm.includes(entryTitle) || entryTitle.includes(video.titleNorm)) {
            titleScore = Math.max(titleScore, 90);
        }
    }
    score += titleScore;

    if (replayOnly(video)) score += 20;
    return score;
}

function shouldStopReplayLookup(entry, videos, page) {
    if (page <= 0) return false;

    const targetMs = getEntryTargetMs(entry);
    if (targetMs <= 0 || !videos.length) return false;

    const oldestComparable = videos
        .map((video) => getVideoEndMs(video) ?? getVideoStartMs(video))
        .filter((ms) => Number.isFinite(ms))
        .sort((a, b) => a - b)[0];

    return Number.isFinite(oldestComparable) && oldestComparable < targetMs - TARGET_WINDOW_MS;
}

function compareReplayCandidates(left, right) {
    return right.score - left.score || left.order - right.order;
}

function getReplayLookupFetchTimeout(deadlineAt) {
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    return remainingMs > 0 ? Math.max(1, Math.min(FETCH_TIMEOUT_MS, remainingMs)) : 0;
}

async function resolveReplayVideoNo(entry) {
    const cachedVideoNo = getReplayVideoNo(entry);
    if (cachedVideoNo) return cachedVideoNo;
    if (!entry?.channelId) return "";

    const cacheKey = `${entry.id}:${entry.channelId}:${entry.liveId}:${entry.liveOpenDate}:${getEntryTitles(entry).join("|")}`;
    if (replayLookupCache.has(cacheKey)) {
        const cached = replayLookupCache.get(cacheKey);
        if (cached.expiresAt > 0 && cached.expiresAt <= Date.now()) {
            replayLookupCache.delete(cacheKey);
        } else {
            touchMapEntry(replayLookupCache, cacheKey, cached, MAX_REPLAY_LOOKUP_CACHE_ENTRIES);
            return cached.promise;
        }
    }

    const lookupAbortController = new AbortController();
    const lookupAbortTimer = setTimeout(() => lookupAbortController.abort(), REPLAY_LOOKUP_MAX_DURATION_MS);
    const promise = (async () => {
        const deadlineAt = Date.now() + REPLAY_LOOKUP_MAX_DURATION_MS;
        const candidatesByVideoNo = new Map();
        const detailCandidatesByVideoNo = new Map();
        const attemptedDetailVideoNos = new Set();
        let candidateOrder = 0;
        let detailRequests = 0;
        let consecutivePageErrors = 0;
        let consecutiveDetailErrors = 0;
        let detailLookupStopped = false;

        async function inspectReplayCandidateDetail(candidate) {
            if (
                !candidate ||
                attemptedDetailVideoNos.has(candidate.video.videoNo) ||
                detailLookupStopped ||
                detailRequests >= REPLAY_LOOKUP_MAX_DETAIL_REQUESTS
            ) {
                return "";
            }

            const timeoutMs = getReplayLookupFetchTimeout(deadlineAt);
            if (!timeoutMs || lookupAbortController.signal.aborted) return "";

            attemptedDetailVideoNos.add(candidate.video.videoNo);
            detailRequests += 1;
            let detailFailed = false;
            try {
                mergeVideoDetail(
                    candidate.video,
                    await fetchVideoDetail(candidate.video.videoNo, {
                        signal: lookupAbortController.signal,
                        timeoutMs,
                    })
                );
                consecutiveDetailErrors = 0;
            } catch (_) {
                // The list data is still useful if a bounded detail lookup is unavailable.
                detailFailed = true;
                consecutiveDetailErrors += 1;
            }

            if (hasConflictingLiveId(entry, candidate.video)) {
                candidate.rejected = true;
            } else {
                candidate.score = scoreReplayCandidate(entry, candidate.video);
                if (candidate.score >= 1000) return candidate.video.videoNo;
            }

            if (detailFailed && consecutiveDetailErrors >= REPLAY_LOOKUP_MAX_CONSECUTIVE_ERRORS) {
                detailLookupStopped = true;
            }
            return "";
        }

        for (let page = 0; page < REPLAY_LOOKUP_MAX_PAGES; page++) {
            const timeoutMs = getReplayLookupFetchTimeout(deadlineAt);
            if (!timeoutMs || lookupAbortController.signal.aborted) break;

            let json;
            try {
                json = await fetchVideoPage(entry.channelId, page, {
                    signal: lookupAbortController.signal,
                    timeoutMs,
                });
                consecutivePageErrors = 0;
            } catch (_) {
                consecutivePageErrors += 1;
                if (
                    consecutivePageErrors >= REPLAY_LOOKUP_MAX_CONSECUTIVE_ERRORS ||
                    lookupAbortController.signal.aborted ||
                    getReplayLookupFetchTimeout(deadlineAt) === 0
                ) {
                    break;
                }
                continue;
            }

            const videos = extractReplayVideos(json).filter(replayOnly);
            if (!videos.length && page === 0) break;

            const pageCandidates = new Map();
            for (const video of videos) {
                if (!videoCouldMatchEntry(entry, video)) continue;

                const score = scoreReplayCandidate(entry, video);
                const existing = candidatesByVideoNo.get(video.videoNo);
                if (!existing) {
                    const candidate = { video, score, order: candidateOrder, rejected: false };
                    candidateOrder += 1;
                    candidatesByVideoNo.set(video.videoNo, candidate);
                    pageCandidates.set(video.videoNo, candidate);
                } else {
                    if (score > existing.score && !attemptedDetailVideoNos.has(video.videoNo)) {
                        existing.video = video;
                        existing.score = score;
                    }
                    pageCandidates.set(video.videoNo, existing);
                }
            }

            const pageDetailCandidates = Array.from(pageCandidates.values())
                .sort(compareReplayCandidates)
                .slice(0, REPLAY_DETAIL_CANDIDATES_PER_PAGE);
            for (const candidate of pageDetailCandidates) {
                const previous = detailCandidatesByVideoNo.get(candidate.video.videoNo);
                if (!previous || compareReplayCandidates(candidate, previous) < 0) {
                    detailCandidatesByVideoNo.set(candidate.video.videoNo, candidate);
                }
            }

            const immediateRegularDetailLimit =
                REPLAY_LOOKUP_MAX_DETAIL_REQUESTS - REPLAY_LOOKUP_RESERVED_EXACT_DETAIL_REQUESTS;
            for (const candidate of pageDetailCandidates) {
                const isExactListMatch = candidate.score >= 1000;
                if (!isExactListMatch && detailRequests >= immediateRegularDetailLimit) continue;

                const resolvedVideoNo = await inspectReplayCandidateDetail(candidate);
                if (resolvedVideoNo) return resolvedVideoNo;
            }

            if (shouldStopReplayLookup(entry, videos, page)) break;
            if (videos.length < VIDEO_PAGE_SIZE) break;
        }

        const detailCandidates = Array.from(detailCandidatesByVideoNo.values()).sort(compareReplayCandidates);
        for (const candidate of detailCandidates) {
            if (detailRequests >= REPLAY_LOOKUP_MAX_DETAIL_REQUESTS || detailLookupStopped) break;
            const resolvedVideoNo = await inspectReplayCandidateDetail(candidate);
            if (resolvedVideoNo) return resolvedVideoNo;
        }

        const best = Array.from(candidatesByVideoNo.values())
            .filter((candidate) => !candidate.rejected && !hasConflictingLiveId(entry, candidate.video))
            .sort(compareReplayCandidates)[0];
        return best && best.score >= 220 ? best.video.videoNo : "";
    })().finally(() => clearTimeout(lookupAbortTimer));

    const cacheEntry = { promise: null, expiresAt: 0 };
    const guardedPromise = promise.then(
        (videoNo) => {
            if (!videoNo) cacheEntry.expiresAt = Date.now() + REPLAY_LOOKUP_NEGATIVE_CACHE_TTL_MS;
            return videoNo;
        },
        (error) => {
            if (replayLookupCache.get(cacheKey) === cacheEntry) replayLookupCache.delete(cacheKey);
            throw error;
        }
    );
    cacheEntry.promise = guardedPromise;
    touchMapEntry(replayLookupCache, cacheKey, cacheEntry, MAX_REPLAY_LOOKUP_CACHE_ENTRIES);
    return guardedPromise;
}

function getLatestMonthFromEntries(rows) {
    const latest = rows.find((entry) => entry.lastWatchedAt > 0);
    return latest ? getKstParts(latest.lastWatchedAt) : getKstParts();
}

function ensureSelectedMonth({ resetToLatest = false } = {}) {
    if (selectedYear && selectedMonth && !resetToLatest) return;
    const latest = getLatestMonthFromEntries(entries);
    selectedYear = latest.year;
    selectedMonth = latest.month;
}

function getMonthDateKeys(year, month) {
    const monthKey = formatMonthKey(year, month);
    return (entry) => Object.keys(entry.dailySeconds || {}).filter((key) => key.startsWith(monthKey));
}

function getEntrySecondsForMonth(entry, year, month) {
    return getMonthDateKeys(year, month)(entry).reduce((sum, key) => sum + (Number(entry.dailySeconds[key]) || 0), 0);
}

function getMonthScopeBounds(year, month) {
    return {
        startMs: getKstMonthStartMs(year, month),
        endMs: getKstMonthStartMs(year, month + 1),
    };
}

function getStoredWatchSecondsForScope(record, startMs = -Infinity, endMs = Infinity) {
    if (startMs === -Infinity && endMs === Infinity) {
        return Math.max(0, Number(record?.watchedSeconds) || 0);
    }

    return Object.entries(record?.dailySeconds || {}).reduce((sum, [dateKey, seconds]) => {
        const bounds = getDateScopeBounds(dateKey);
        if (!bounds || bounds.startMs < startMs || bounds.endMs > endMs) return sum;
        return sum + Math.max(0, Number(seconds) || 0);
    }, 0);
}

function getUniqueWatchSecondsForScope(startMs = -Infinity, endMs = Infinity) {
    return entries.reduce((sum, entry) => {
        const exactSeconds = sumWatchRanges(
            collectWatchSessionRanges(entry.sessionDetails, {
                scopeStartMs: startMs,
                scopeEndMs: endMs,
            })
        );
        return sum + Math.max(exactSeconds, getStoredWatchSecondsForScope(entry, startMs, endMs));
    }, 0);
}

function getUniqueWatchSecondsForMonth(year, month) {
    const { startMs, endMs } = getMonthScopeBounds(year, month);
    return getUniqueWatchSecondsForScope(startMs, endMs);
}

function getEntrySessionsForScope(entry) {
    const bounds = selectedDateKey
        ? getDateScopeBounds(selectedDateKey)
        : getMonthScopeBounds(selectedYear, selectedMonth);

    return (entry.sessionDetails || [])
        .map((session) => {
            const scopeRanges = bounds
                ? mergeWatchRanges(
                      collectWatchSessionRanges([session], {
                          scopeStartMs: bounds.startMs,
                          scopeEndMs: bounds.endMs,
                      })
                  )
                : [];
            return {
                ...session,
                scopeSeconds: Math.max(
                    sumWatchRanges(scopeRanges),
                    getStoredWatchSecondsForScope(session, bounds?.startMs, bounds?.endMs)
                ),
                scopeRanges,
            };
        })
        .filter((session) => session.scopeSeconds > 0)
        .sort((a, b) => b.enteredAt - a.enteredAt);
}

function getSessionLatestScopeWatchedAt(session) {
    return mergeWatchRanges(session?.scopeRanges).reduce(
        (latest, range) => Math.max(latest, Number(range.endAt) || 0),
        0
    );
}

function getRowActualWatchedAt(row) {
    const latest = (row?.sessionsForScope || []).reduce(
        (max, session) => Math.max(max, getSessionLatestScopeWatchedAt(session)),
        0
    );
    return latest || Number(row?.entry?.lastWatchedAt) || 0;
}

function getHistorySortMode() {
    return historySortEl?.value === "actualTime" ? "actualTime" : "watchTime";
}

function getHistorySortDirection() {
    return historySortDirectionEl?.value === "asc" ? "asc" : "desc";
}

function compareNumberByDirection(a, b) {
    const direction = getHistorySortDirection() === "asc" ? 1 : -1;
    return (a - b) * direction;
}

function compareVisibleRows(a, b) {
    if (getHistorySortMode() === "actualTime") {
        return (
            compareNumberByDirection(getRowActualWatchedAt(a), getRowActualWatchedAt(b)) ||
            compareNumberByDirection(a.seconds, b.seconds) ||
            compareNumberByDirection(a.entry.lastWatchedAt, b.entry.lastWatchedAt)
        );
    }
    return (
        compareNumberByDirection(a.seconds, b.seconds) ||
        compareNumberByDirection(getRowActualWatchedAt(a), getRowActualWatchedAt(b)) ||
        compareNumberByDirection(a.entry.lastWatchedAt, b.entry.lastWatchedAt)
    );
}

function getMonthEntries() {
    return entries.filter((entry) => getEntrySecondsForMonth(entry, selectedYear, selectedMonth) > 0);
}

function buildMonthDayEntryMap(year, month) {
    const monthKey = formatMonthKey(year, month);
    const rowsByDate = new Map();

    for (const entry of entries) {
        for (const [dateKey, rawSeconds] of Object.entries(entry.dailySeconds || {})) {
            if (!dateKey.startsWith(monthKey)) continue;
            const seconds = Math.max(0, Number(rawSeconds) || 0);
            if (seconds <= 0) continue;
            if (!rowsByDate.has(dateKey)) rowsByDate.set(dateKey, []);
            rowsByDate.get(dateKey).push({ entry, seconds });
        }
    }

    for (const rows of rowsByDate.values()) {
        rows.sort((a, b) => b.seconds - a.seconds || b.entry.lastWatchedAt - a.entry.lastWatchedAt);
    }

    return rowsByDate;
}

function getDayTotals(year, month) {
    const totals = {};
    const { startMs, endMs } = getMonthScopeBounds(year, month);
    for (const entry of entries) {
        const rangesByDate = {};
        for (const range of collectWatchSessionRanges(entry.sessionDetails, {
            scopeStartMs: startMs,
            scopeEndMs: endMs,
        })) {
            addWatchRangeToRangesByDate(rangesByDate, range, {
                scopeStartMs: startMs,
                scopeEndMs: endMs,
            });
        }
        const exactDailySeconds = sumWatchRangesByDate(rangesByDate);
        const dateKeys = new Set([
            ...Object.keys(exactDailySeconds),
            ...Object.keys(entry.dailySeconds || {}).filter((dateKey) =>
                dateKey.startsWith(formatMonthKey(year, month))
            ),
        ]);
        for (const dateKey of dateKeys) {
            const seconds = Math.max(
                Math.max(0, Number(exactDailySeconds[dateKey]) || 0),
                Math.max(0, Number(entry.dailySeconds?.[dateKey]) || 0)
            );
            if (seconds <= 0) continue;
            totals[dateKey] = (Number(totals[dateKey]) || 0) + seconds;
        }
    }
    return totals;
}

function getCalendarLevel(seconds) {
    if (seconds >= 5 * 60 * 60) return "3";
    if (seconds >= 2 * 60 * 60) return "2";
    return "1";
}

function shiftSelectedMonth(delta) {
    const index = selectedYear * 12 + (selectedMonth - 1) + delta;
    selectedYear = Math.floor(index / 12);
    selectedMonth = (index % 12) + 1;
    selectedDateKey = "";
    renderAll();
}

function isFutureMonth(year, month) {
    const now = getKstParts();
    return year > now.year || (year === now.year && month > now.month);
}

function appendText(parent, className, text) {
    const el = document.createElement("span");
    el.className = className;
    el.textContent = text;
    parent.appendChild(el);
    return el;
}

function renderWeekdays() {
    if (weekdaysEl.children.length) return;
    const fragment = document.createDocumentFragment();
    for (const label of WEEKDAY_LABELS) {
        const item = document.createElement("span");
        item.className = "history-weekday";
        item.textContent = label;
        fragment.appendChild(item);
    }
    weekdaysEl.appendChild(fragment);
}

function renderCalendar() {
    renderWeekdays();

    const monthKey = formatMonthKey(selectedYear, selectedMonth);
    const totals = getDayTotals(selectedYear, selectedMonth);
    const dayEntriesByDate = buildMonthDayEntryMap(selectedYear, selectedMonth);
    const firstWeekday = new Date(Date.UTC(selectedYear, selectedMonth - 1, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(selectedYear, selectedMonth, 0)).getUTCDate();
    const today = getKstParts();
    const fragment = document.createDocumentFragment();

    calendarTitleEl.textContent = `${selectedYear}.${String(selectedMonth).padStart(2, "0")}`;
    nextMonthButton.disabled = isFutureMonth(selectedYear, selectedMonth + 1);

    for (let i = 0; i < firstWeekday; i++) {
        const empty = document.createElement("span");
        empty.className = "history-day";
        empty.setAttribute("aria-hidden", "true");
        fragment.appendChild(empty);
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const dateKey = `${monthKey}-${String(day).padStart(2, "0")}`;
        const seconds = Math.round(totals[dateKey] || 0);
        const dayEntries = dayEntriesByDate.get(dateKey) || [];
        const item = document.createElement("button");
        item.type = "button";
        item.className = "history-day";
        item.dataset.date = dateKey;
        item.setAttribute(
            "aria-label",
            `${formatDateLabel(dateKey)} ${seconds > 0 ? formatDuration(seconds) : "시청 기록 없음"}`
        );

        if (today.year === selectedYear && today.month === selectedMonth && today.day === day) item.dataset.today = "1";
        if (selectedDateKey === dateKey) item.dataset.selected = "1";

        appendText(item, "history-day-number", String(day));
        if (seconds > 0) {
            item.dataset.watched = "1";
            item.dataset.level = getCalendarLevel(seconds);
            appendText(item, "history-day-time", formatCalendarDuration(seconds));
            item.title = [
                `${formatDateLabel(dateKey)} · ${formatDuration(seconds)}`,
                ...dayEntries.slice(0, 5).map((row) => `${row.entry.channelName} · ${formatDuration(row.seconds)}`),
            ].join("\n");
        }

        item.addEventListener("click", () => {
            selectedDateKey = selectedDateKey === dateKey ? "" : dateKey;
            renderAll();
        });
        fragment.appendChild(item);
    }

    calendarDaysEl.replaceChildren(fragment);

    const monthSeconds = getUniqueWatchSecondsForMonth(selectedYear, selectedMonth);
    const selectedText = selectedDateKey
        ? `${formatDateLabel(selectedDateKey)} 선택됨 · 다시 누르면 해제됩니다.`
        : "날짜를 선택하면 해당 날짜에 본 라이브만 표시합니다.";
    calendarFootEl.textContent = `${selectedText} 이번 달 총 ${formatDuration(monthSeconds)}.`;
}

function getVisibleRows() {
    const query = compactSpaces(historySearchEl.value).toLowerCase();
    const scopeBounds = selectedDateKey
        ? getDateScopeBounds(selectedDateKey)
        : getMonthScopeBounds(selectedYear, selectedMonth);
    const rows = (selectedDateKey ? entries : getMonthEntries())
        .map((entry) => {
            const sessionsForScope = getEntrySessionsForScope(entry);
            const sessionSeconds = sessionsForScope.reduce((sum, session) => sum + session.scopeSeconds, 0);
            const seconds = Math.max(
                sessionSeconds,
                getStoredWatchSecondsForScope(entry, scopeBounds?.startMs, scopeBounds?.endMs)
            );
            return { entry, seconds, sessionsForScope };
        })
        .filter((row) => row.seconds > 0);

    return rows
        .filter((row) => {
            if (!query) return true;
            const haystack = `${getEntryTitles(row.entry).join(" ")} ${row.entry.channelName}`.toLowerCase();
            return haystack.includes(query);
        })
        .sort(compareVisibleRows);
}

function pruneSelectedEntryIds() {
    const existingIds = new Set(entries.map((entry) => entry.id));
    for (const id of selectedEntryIds) {
        if (!existingIds.has(id)) selectedEntryIds.delete(id);
    }
    for (const id of expandedEntryIds) {
        if (!existingIds.has(id)) expandedEntryIds.delete(id);
    }
}

function getVisibleEntryIds(rows = getVisibleRows()) {
    return rows.map((row) => row.entry.id).filter(Boolean);
}

function renderSelectionControls(rows = getVisibleRows()) {
    pruneSelectedEntryIds();

    const visibleIds = getVisibleEntryIds(rows);
    const visibleSelectedCount = visibleIds.filter((id) => selectedEntryIds.has(id)).length;
    const selectedCount = selectedEntryIds.size;

    selectVisibleHistoryEl.disabled = visibleIds.length === 0;
    selectVisibleHistoryEl.checked = visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;
    selectVisibleHistoryEl.indeterminate = visibleSelectedCount > 0 && visibleSelectedCount < visibleIds.length;

    selectionStatusEl.textContent = selectedCount > 0 ? `선택 ${selectedCount}개` : "선택 0개";
    deleteSelectedHistoryButton.disabled = selectedCount === 0;
    clearHistoryButton.disabled = entries.length === 0;
}

function setEntrySelected(id, selected) {
    if (!id) return;
    if (selected) selectedEntryIds.add(id);
    else selectedEntryIds.delete(id);
    renderList();
}

function setVisibleEntriesSelected(selected) {
    const visibleIds = getVisibleEntryIds();
    for (const id of visibleIds) {
        if (selected) selectedEntryIds.add(id);
        else selectedEntryIds.delete(id);
    }
    renderList();
}

function toggleEntryExpanded(id) {
    if (!id) return;
    if (expandedEntryIds.has(id)) expandedEntryIds.delete(id);
    else expandedEntryIds.add(id);
    renderList();
}

async function persistReplayVideoNo(entry, videoNo) {
    if (!entry?.id || !videoNo) return;

    await sendWatchHistoryMutation({
        kind: "setReplayVideoNo",
        recordId: entry.id,
        videoNo,
    });

    entry.replayVideoNo = videoNo;
}

function openUrlInNewTab(url, pendingWindow = null) {
    if (!url) return;
    if (pendingWindow && !pendingWindow.closed) {
        pendingWindow.location.href = url;
        return;
    }
    window.open(url, "_blank", "noopener");
}

function openPendingReplayWindow() {
    const pendingUrl = globalThis.chrome?.runtime?.getURL ? chrome.runtime.getURL("replay-pending.html") : "";

    try {
        const pendingWindow = window.open(pendingUrl || "", "_blank");
        if (pendingWindow) pendingWindow.opener = null;
        return pendingWindow;
    } catch (_) {
        return null;
    }
}

async function handleTitleClick(event, entry) {
    const replayUrl = getReplayUrl(entry);
    if (replayUrl) return;
    if (!entry?.channelId) return;

    event.preventDefault();

    let pendingWindow = null;
    pendingWindow = openPendingReplayWindow();
    if (!pendingWindow) {
        try {
            pendingWindow = window.open("", "_blank");
            if (pendingWindow) {
                pendingWindow.opener = null;
                pendingWindow.document.title = "다시보기 찾는 중";
                pendingWindow.document.body.textContent = "다시보기를 찾는 중입니다...";
            }
        } catch (_) {
            pendingWindow = null;
        }
    }

    resolvingReplayEntryIds.add(entry.id);
    renderList();
    showMessage("해당 방송의 다시보기를 찾는 중입니다.");

    try {
        const videoNo = await resolveReplayVideoNo(entry);
        if (!videoNo) {
            if (pendingWindow && !pendingWindow.closed) pendingWindow.close();
            showMessage("해당 방송의 다시보기를 찾지 못했습니다.", "error");
            return;
        }

        await persistReplayVideoNo(entry, videoNo);
        openUrlInNewTab(`https://chzzk.naver.com/video/${encodeURIComponent(videoNo)}`, pendingWindow);
        showMessage("다시보기 링크를 찾았습니다.");
    } catch (_) {
        if (pendingWindow && !pendingWindow.closed) pendingWindow.close();
        showMessage("다시보기를 찾지 못했습니다.", "error");
    } finally {
        resolvingReplayEntryIds.delete(entry.id);
        renderList();
    }
}

function getEntryDateLabel(entry) {
    if (selectedDateKey) return formatDateLabel(selectedDateKey);

    const keys = getMonthDateKeys(selectedYear, selectedMonth)(entry).sort();
    if (!keys.length) return `${selectedYear}.${String(selectedMonth).padStart(2, "0")}`;
    if (keys.length === 1) return formatDateLabel(keys[0]);
    return `${formatDateLabel(keys[0])} - ${formatDateLabel(keys[keys.length - 1])}`;
}

function formatSessionLeftText(session) {
    if (!session.leftAt) return "알 수 없음";
    return session.closed ? formatKstDateTime(session.leftAt) : `${formatKstDateTime(session.leftAt)} 기준`;
}

function appendSessionCell(parent, label, value) {
    const cell = document.createElement("span");
    cell.className = "history-session-cell";

    const labelEl = document.createElement("span");
    labelEl.textContent = label;

    const valueEl = document.createElement("strong");
    valueEl.textContent = value;

    cell.append(labelEl, valueEl);
    parent.appendChild(cell);
}

function formatTitleSeenRange(row) {
    const first = Number(row.firstSeenAt) || 0;
    const last = Number(row.lastSeenAt) || 0;
    if (first > 0 && last > 0 && Math.abs(last - first) >= 60000) {
        return `${formatKstDateTime(first)} - ${formatKstDateTime(last)}`;
    }
    if (first > 0) return formatKstDateTime(first);
    if (last > 0) return formatKstDateTime(last);
    return "기록 시각 없음";
}

function getTitleHistorySummary(entry) {
    const rows = getEntryTitleRows(entry);
    if (rows.length <= 1) return "";

    const preview = rows
        .slice(0, 2)
        .map((row) => row.title)
        .join(" / ");
    const suffix = rows.length > 2 ? ` 외 ${rows.length - 2}개` : "";
    return `방송 제목 ${rows.length}개 기록됨: ${preview}${suffix}`;
}

function buildTitleHistoryList(entry) {
    const rows = getEntryTitleRows(entry);
    if (rows.length <= 1) return null;

    const list = document.createElement("div");
    list.className = "history-title-list";

    const heading = document.createElement("strong");
    heading.className = "history-title-list-heading";
    heading.textContent = "방송 제목 이력";
    list.appendChild(heading);

    for (const row of rows) {
        const item = document.createElement("div");
        item.className = "history-title-row";

        const time = document.createElement("span");
        time.textContent = formatTitleSeenRange(row);

        const title = document.createElement("strong");
        title.textContent = row.title;

        item.append(time, title);
        list.appendChild(item);
    }

    return list;
}

function hasStoredWatchRanges(session) {
    return mergeWatchRanges(session?.watchedRanges).length > 0;
}

function buildSessionWatchRangeList(session) {
    const exactRanges = mergeWatchRanges(session?.scopeRanges);
    const ranges = mergeWatchRanges(exactRanges, DISPLAY_WATCH_RANGE_MERGE_GAP_MS);
    if (!ranges.length) return null;

    const wrap = document.createElement("div");
    wrap.className = "history-watch-range-list";

    const heading = document.createElement("span");
    heading.className = "history-watch-range-heading";
    heading.textContent = hasStoredWatchRanges(session) ? "시청 시간대" : "추정 시청 시간대";

    const values = document.createElement("span");
    values.className = "history-watch-range-values";

    const rangeTexts = ranges.map(formatWatchRange).filter(Boolean);
    const visible = rangeTexts.slice(0, 4);
    if (rangeTexts.length > visible.length) {
        visible.push(`외 ${rangeTexts.length - visible.length}개`);
    }
    values.textContent = visible.join(" · ");
    values.title = rangeTexts.join("\n");

    wrap.append(heading, values);
    return wrap;
}

function buildSessionList(row) {
    const list = document.createElement("div");
    list.className = "history-session-list";

    for (const session of row.sessionsForScope) {
        const item = document.createElement("div");
        item.className = "history-session-item";
        if (session.legacy) item.dataset.legacy = "1";

        const titleText = pickString(session.title, row.entry?.title);
        if (titleText) appendSessionCell(item, "방제", titleText);
        appendSessionCell(item, session.legacy ? "이전 기록" : "입장", formatKstDateTime(session.enteredAt));
        appendSessionCell(item, "퇴장", session.legacy ? "세부 시간 없음" : formatSessionLeftText(session));
        appendSessionCell(item, "시청", formatDuration(session.scopeSeconds));

        const rangeList = buildSessionWatchRangeList(session);
        if (rangeList) item.appendChild(rangeList);

        list.appendChild(item);
    }

    return list;
}

function renderList() {
    const rows = getVisibleRows();
    const fragment = document.createDocumentFragment();
    const scopeText = selectedDateKey
        ? `${formatDateLabel(selectedDateKey)} 시청 기록`
        : `${selectedYear}.${String(selectedMonth).padStart(2, "0")} 시청 기록`;
    listDescriptionEl.textContent = scopeText;
    renderSelectionControls(rows);

    if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "history-empty";
        empty.textContent = entries.length ? "조건에 맞는 시청 기록이 없습니다." : "아직 저장된 시청 기록이 없습니다.";
        fragment.appendChild(empty);
        historyListEl.replaceChildren(fragment);
        return;
    }

    for (const row of rows) {
        const entry = row.entry;
        const expanded = expandedEntryIds.has(entry.id);
        const item = document.createElement("div");
        item.className = "history-item";
        item.dataset.selected = selectedEntryIds.has(entry.id) ? "1" : "0";
        item.dataset.expanded = expanded ? "1" : "0";

        const selectLabel = document.createElement("label");
        selectLabel.className = "history-item-select";
        selectLabel.setAttribute("aria-label", `${entry.title} 선택`);
        const selectInput = document.createElement("input");
        selectInput.type = "checkbox";
        selectInput.checked = selectedEntryIds.has(entry.id);
        selectInput.addEventListener("change", () => setEntrySelected(entry.id, selectInput.checked));
        selectLabel.appendChild(selectInput);

        const body = document.createElement("span");
        body.className = "history-item-main";
        const replayUrl = getReplayUrl(entry);
        const fallbackUrl = replayUrl || (entry.channelId ? "#" : entry.liveUrl);
        const title = document.createElement(fallbackUrl ? "a" : "strong");
        if (fallbackUrl) {
            title.className = "history-item-title-link";
            title.href = fallbackUrl;
            title.target = "_blank";
            title.rel = "noopener";
            title.title = replayUrl ? "다시보기 열기" : entry.channelId ? "다시보기 찾기" : "방송국 열기";
            if (entry.channelId) title.addEventListener("click", (event) => handleTitleClick(event, entry));
            if (resolvingReplayEntryIds.has(entry.id)) title.dataset.loading = "1";
        }
        title.textContent = entry.title;
        const meta = document.createElement("small");
        meta.textContent = `${entry.channelName} · ${getEntryDateLabel(entry)} · ${row.sessionsForScope.length}회 입장`;
        body.append(title, meta);
        const titleHistorySummary = getTitleHistorySummary(entry);
        if (titleHistorySummary) {
            const titleHistory = document.createElement("small");
            titleHistory.className = "history-title-history";
            titleHistory.textContent = titleHistorySummary;
            titleHistory.title = getEntryTitleRows(entry)
                .map((row) => `${formatTitleSeenRange(row)} · ${row.title}`)
                .join("\n");
            body.appendChild(titleHistory);
        }

        const time = document.createElement("span");
        time.className = "history-item-time";
        time.textContent = formatDuration(row.seconds);

        const actions = document.createElement("div");
        actions.className = "history-item-actions";

        const expandButton = document.createElement("button");
        expandButton.className = "history-entry-detail";
        expandButton.type = "button";
        expandButton.textContent = expanded ? "접기" : "세부";
        expandButton.setAttribute("aria-expanded", expanded ? "true" : "false");
        expandButton.setAttribute("aria-label", `${entry.title} 입장 기록 ${expanded ? "접기" : "보기"}`);
        expandButton.addEventListener("click", () => toggleEntryExpanded(entry.id));

        const deleteButton = document.createElement("button");
        deleteButton.className = "history-entry-delete";
        deleteButton.type = "button";
        deleteButton.textContent = "삭제";
        deleteButton.setAttribute("aria-label", `${entry.title} 기록 삭제`);
        deleteButton.addEventListener("click", () => deleteSingleEntry(entry));
        actions.append(time, expandButton, deleteButton);

        item.append(selectLabel, body, actions);
        if (expanded) {
            const titleHistoryList = buildTitleHistoryList(entry);
            if (titleHistoryList) item.appendChild(titleHistoryList);
            item.appendChild(buildSessionList(row));
        }
        fragment.appendChild(item);
    }

    historyListEl.replaceChildren(fragment);
}

function renderSummary() {
    const totalSeconds = getUniqueWatchSecondsForScope();
    const monthSeconds = getUniqueWatchSecondsForMonth(selectedYear, selectedMonth);

    totalWatchTimeEl.textContent = formatDuration(totalSeconds);
    totalLiveCountEl.textContent = `${entries.length}개`;
    monthWatchTimeEl.textContent = formatDuration(monthSeconds);

    if (storage) {
        noticeEl.dataset.state = "saved";
        noticeEl.textContent = `로컬 기록 · ${entries.length}개`;
    }
}

function renderAll() {
    ensureSelectedMonth();
    renderSummary();
    renderCalendar();
    renderList();
}

function showMessage(text, type = "success") {
    clearTimeout(hideMessageTimer);
    messageEl.textContent = text;
    messageEl.dataset.type = type;
    messageEl.classList.remove("hidden");
    messageEl.classList.add("is-visible");

    hideMessageTimer = setTimeout(() => {
        messageEl.classList.remove("is-visible");
        messageEl.classList.add("hidden");
    }, 1800);
}

async function loadHistory({ resetToLatest = false, silent = false } = {}) {
    if (!storage) {
        noticeEl.dataset.state = "dirty";
        noticeEl.textContent = "저장소 사용 불가";
        entries = [];
        renderAll();
        return false;
    }

    if (!silent) {
        noticeEl.dataset.state = "loading";
        noticeEl.textContent = "불러오는 중";
    }

    try {
        const data = await storageGet(storage, STORAGE_KEY);
        entries = normalizeHistory(data[STORAGE_KEY]);
        pruneSelectedEntryIds();
        if (resetToLatest) {
            selectedYear = 0;
            selectedMonth = 0;
            selectedDateKey = "";
            selectedEntryIds.clear();
            expandedEntryIds.clear();
        }
        ensureSelectedMonth({ resetToLatest });
        renderAll();
        return true;
    } catch (_) {
        noticeEl.dataset.state = "dirty";
        noticeEl.textContent = "불러오기 실패";
        showMessage("시청 기록을 불러오지 못했습니다.", "error");
        return false;
    }
}

function scheduleStorageChangeReload() {
    if (storageChangeReloadTimer) window.clearTimeout(storageChangeReloadTimer);
    storageChangeReloadTimer = window.setTimeout(() => {
        storageChangeReloadTimer = 0;
        loadHistory({ silent: true });
    }, STORAGE_CHANGE_RELOAD_DEBOUNCE_MS);
}

async function refreshHistory() {
    if (await loadHistory({ silent: false })) {
        showMessage("시청 기록을 새로고침했습니다.");
    }
}

async function clearHistory() {
    if (!confirm("이 브라우저에 저장된 시청 기록을 모두 삭제할까요?")) return;

    try {
        await sendWatchHistoryMutation({ kind: "clearHistory", cutoffAt: Date.now() });
        entries = [];
        selectedDateKey = "";
        selectedEntryIds.clear();
        expandedEntryIds.clear();
        ensureSelectedMonth({ resetToLatest: true });
        renderAll();
        showMessage("시청 기록을 삭제했습니다.");
    } catch (_) {
        showMessage("시청 기록을 삭제하지 못했습니다.", "error");
    }
}

async function deleteEntriesByIds(ids, successMessage) {
    const targets = new Set(Array.from(ids || []).filter(Boolean));
    if (!targets.size) return false;

    try {
        await sendWatchHistoryMutation({
            kind: "deleteEntries",
            entryIds: Array.from(targets),
            cutoffAt: Date.now(),
        });
        entries = entries.filter((entry) => !targets.has(entry.id));
        for (const id of targets) {
            selectedEntryIds.delete(id);
            expandedEntryIds.delete(id);
        }
        pruneSelectedEntryIds();
        renderAll();
        showMessage(successMessage || "선택한 시청 기록을 삭제했습니다.");
        return true;
    } catch (_) {
        showMessage("시청 기록을 삭제하지 못했습니다.", "error");
        return false;
    }
}

async function deleteSelectedEntries() {
    const count = selectedEntryIds.size;
    if (count <= 0) return;
    if (!confirm(`선택한 시청 기록 ${count}개를 삭제할까요?`)) return;

    await deleteEntriesByIds(selectedEntryIds, `선택한 시청 기록 ${count}개를 삭제했습니다.`);
}

async function deleteSingleEntry(entry) {
    if (!entry?.id) return;
    if (!confirm(`"${entry.title}" 시청 기록을 삭제할까요?`)) return;

    await deleteEntriesByIds([entry.id], "시청 기록 1개를 삭제했습니다.");
}

prevMonthButton.addEventListener("click", () => shiftSelectedMonth(-1));
calendarRefreshButton.addEventListener("click", refreshHistory);
nextMonthButton.addEventListener("click", () => {
    if (!nextMonthButton.disabled) shiftSelectedMonth(1);
});
refreshButton.addEventListener("click", refreshHistory);
clearHistoryButton.addEventListener("click", clearHistory);
historySearchEl.addEventListener("input", renderList);
historySortEl.addEventListener("change", renderList);
historySortDirectionEl.addEventListener("change", renderList);
selectVisibleHistoryEl.addEventListener("change", () => setVisibleEntriesSelected(selectVisibleHistoryEl.checked));
deleteSelectedHistoryButton.addEventListener("click", deleteSelectedEntries);

if (globalThis.chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local" || !changes[STORAGE_KEY]) return;
        scheduleStorageChangeReload();
    });
}

loadHistory({ resetToLatest: true });
