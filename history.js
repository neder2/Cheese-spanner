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
 * 화면에 보이는 목록 줄의 채널마다 페이지 수명 동안 한 번 공개 채널 정보를 로그인 정보 없이 조회해
 * 검증된 프로필 사진만 장식 아이콘으로 넣는다. 조회 결과는 어떤 저장소에도 쓰지 않는다.
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
 * - 채널 아이콘 조회·표시 (requestChannelIcons, lookupChannelIcon, syncChannelIcon)
 * - 렌더링 함수 (renderCalendar, renderList, renderSummary, renderAll)
 * - 채널별 시청 순위와 내 채팅·일반 후원 집계/보관 내역 (renderRanking, renderActivity)
 * - 기본 라이브 내역, 순위, 활동 탭과 공통 기간·검색, 10개 단위 페이지 이동
 * - 전체 후원 내역의 증분 갱신과 실시간 기록을 내 후원으로 통합하며 완료된 과거 달은 재조회하지 않음
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
const CHANNEL_ICON_CONCURRENCY = 4;
const CHANNEL_ICON_TIMEOUT_MS = 8000;

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
    getKstDateKey,
    getKstDateScopeBounds: getDateScopeBounds,
    getKstMonthStartMs,
    getKstParts,
    getUniqueWatchTotals,
    isSameKstDate,
    mergeDailySeconds: mergeSessionDailySeconds,
    mergeWatchRanges,
    normalizeChzzkChannelId,
    normalizeChzzkImageUrl,
    normalizeChzzkLiveUrl,
    normalizeDailySeconds,
    normalizeForMatch,
    normalizeTitleHistory,
    normalizeSessionWatchRanges,
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
const monthWatchLabelEl = document.getElementById("monthWatchLabel");
const calendarTitleEl = document.getElementById("calendarTitle");
const weekdaysEl = document.getElementById("weekdays");
const calendarDaysEl = document.getElementById("calendarDays");
const calendarFootEl = document.getElementById("calendarFoot");
const clearDateFilterButton = document.getElementById("clearDateFilter");
const listDescriptionEl = document.getElementById("listDescription");
const historyListEl = document.getElementById("historyList");
const historySearchEl = document.getElementById("historySearch");
const historySortEl = document.getElementById("historySort");
const historyScopeEl = document.getElementById("historyScope");
const channelRankingEl = document.getElementById("channelRanking");
const activityTypeEl = document.getElementById("activityType");
const activityListEl = document.getElementById("activityList");
const activitySummaryEl = document.getElementById("activitySummary");
const donationHistory = globalThis.BetterChzzkDonationHistory;
const donationImportRefresh = document.getElementById("donationImportRefresh");
const donationImportControls = document.getElementById("donationImportControls");
const donationImportCancel = document.getElementById("donationImportCancel");
const donationImportStatus = document.getElementById("donationImportStatus");
const clearDonationImportButton = document.getElementById("clearDonationImport");
const viewTabs = Array.from(document.querySelectorAll("[data-history-view]"));
const viewNames = ["history", "ranking", "activity"];
const selectionToggle = document.getElementById("historySelectionToggle");
const selectionControls = document.getElementById("historySelectionControls");
const VIEW_PAGE_SIZE = 10;
const viewPages = { history: 0, ranking: 0, activity: 0 };
const prevMonthButton = document.getElementById("prevMonth");
const nextMonthButton = document.getElementById("nextMonth");
const refreshButton = document.getElementById("refresh");
const clearHistoryButton = document.getElementById("clearHistory");
const selectVisibleHistoryEl = document.getElementById("selectVisibleHistory");
const selectionStatusEl = document.getElementById("selectionStatus");
const deleteSelectedHistoryButton = document.getElementById("deleteSelectedHistory");
const clearSelectionButton = document.getElementById("clearSelection");
const messageEl = document.getElementById("message");

let entries = [];
let selectedYear = 0;
let selectedMonth = 0;
let selectedDateKey = "";
let hideMessageTimer = 0;
let storageChangeReloadScheduled = false;
let historyLoadGeneration = 0;
let activeHistoryView = "history";
let selectionMode = false;
let importedDonations = null;
let donationImportPort = null;
let donationImportGeneration = 0;
const selectedEntryIds = new Set();
const expandedEntryIds = new Set();
const expandedChatLimits = new Map();
const ENTRY_CHAT_PAGE_SIZE = 50;
const replayLookupCache = new Map();
const resolvingReplayEntryIds = new Set();
// Channel ID -> { status: "queued" | "requesting" | "loading" | "ready" | "failed", url }. Page memory only.
const channelIconStates = new Map();
const channelIconQueue = [];
const channelIconAbortController = new AbortController();
let channelIconActiveLookups = 0;

function resetViewPages() {
    for (const view of viewNames) viewPages[view] = 0;
}

function getPageRows(view, rows) {
    const pageCount = Math.max(1, Math.ceil(rows.length / VIEW_PAGE_SIZE));
    viewPages[view] = Math.max(0, Math.min(viewPages[view], pageCount - 1));
    const previous = document.getElementById(`${view}PrevPage`);
    const next = document.getElementById(`${view}NextPage`);
    const status = document.getElementById(`${view}PageStatus`);
    previous.disabled = viewPages[view] === 0;
    next.disabled = viewPages[view] === pageCount - 1;
    previous.closest("nav").hidden = rows.length <= VIEW_PAGE_SIZE;
    const label = `${viewPages[view] + 1} / ${pageCount}페이지 · 총 ${rows.length.toLocaleString()}개`;
    if (status.textContent !== label) status.textContent = label;
    const start = viewPages[view] * VIEW_PAGE_SIZE;
    return rows.slice(start, start + VIEW_PAGE_SIZE);
}

function setHistoryView(view, { focus = false } = {}) {
    if (!viewNames.includes(view)) return;
    activeHistoryView = view;
    for (const tab of viewTabs) {
        const selected = tab.dataset.historyView === view;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        document.getElementById(tab.getAttribute("aria-controls")).hidden = !selected;
        if (selected && focus) tab.focus({ preventScroll: true });
    }
    historySortEl.hidden = view !== "history";
    selectionToggle.hidden = view !== "history";
    requestChannelIcons(document.getElementById(`${view}Panel`));
}

function getScopeLabel() {
    if (historyScopeEl.value === "all") return "전체 기간";
    return selectedDateKey
        ? formatDateLabel(selectedDateKey)
        : `${selectedYear}.${String(selectedMonth).padStart(2, "0")}`;
}

function matchesHistoryQuery(entry) {
    const query = compactSpaces(historySearchEl.value).toLowerCase();
    return !query || `${getEntryTitles(entry).join(" ")} ${entry.channelName}`.toLowerCase().includes(query);
}

function renderResults() {
    const donations = getDonationView();
    renderList();
    renderRanking(donations);
    renderActivity(donations);
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
    return formatKstRange(startAt, endAt, { seconds: showSeconds });
}

function formatDuration(seconds) {
    const totalSeconds = Math.max(0, Math.round(Number(seconds) || 0));
    const totalMinutes = Math.round(totalSeconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (totalSeconds <= 0) return "0분";
    if (hours <= 0 && totalMinutes <= 0) return `${totalSeconds}초`;
    if (hours <= 0) return `${totalMinutes}분`;
    if (minutes <= 0) return `${hours}시간`;
    return `${hours}시간 ${minutes}분`;
}

// Calendar cells only fit one unit; the full duration stays in the label and tooltip.
function formatCalendarDuration(seconds) {
    const totalMinutes = Math.max(0, Math.round((Number(seconds) || 0) / 60));
    if (totalMinutes < 60) return `${totalMinutes}분`;
    return `${Math.floor(totalMinutes / 60)}시간`;
}

function formatKstRange(startAt, endAt, options) {
    const endText = isSameKstDate(startAt, endAt) ? formatKstTime(endAt, options) : formatKstDateTime(endAt, options);
    return `${formatKstDateTime(startAt, options)} - ${endText}`;
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
            const watchedRanges = normalizeSessionWatchRanges(session);
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
                activities: Array.isArray(row.activities) ? row.activities : [],
                activityDaily: row.activityDaily && typeof row.activityDaily === "object" ? row.activityDaily : {},
                activityCutoffAt: Number(row.activityCutoffAt) || 0,
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
        .filter((entry) => entry.id && (entry.sessionDetails.length > 0 || hasActivityCounts(entry)))
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
    const allRanges = [];
    let residualSeconds = 0;
    for (const entry of entries) {
        const ranges = getRecordedEntryRangesForScope(entry, startMs, endMs);
        allRanges.push(...ranges);
        // Missing/retired ranges cannot prove overlap; preserve their stored duration.
        residualSeconds += Math.max(
            0,
            getStoredWatchSecondsForScope(entry, startMs, endMs) - sumWatchRanges(ranges, 0)
        );
    }
    return sumWatchRanges(allRanges, 0) + residualSeconds;
}

function getRecordedEntryRangesForScope(entry, startMs, endMs) {
    return mergeWatchRanges(
        (entry.sessionDetails || []).flatMap((session) => session.watchedRanges || []),
        0
    )
        .map((range) => ({ startAt: Math.max(startMs, range.startAt), endAt: Math.min(endMs, range.endAt) }))
        .filter((range) => range.endAt > range.startAt);
}

function getUniqueWatchSecondsForMonth(year, month) {
    const { startMs, endMs } = getMonthScopeBounds(year, month);
    return getUniqueWatchSecondsForScope(startMs, endMs);
}

function getHistoryScopeBounds() {
    if (historyScopeEl?.value === "all") return { startMs: -Infinity, endMs: Infinity };
    return selectedDateKey ? getDateScopeBounds(selectedDateKey) : getMonthScopeBounds(selectedYear, selectedMonth);
}

function getEntrySessionsForScope(entry) {
    const bounds = getHistoryScopeBounds();

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

// One sort control: recent/oldest order by when it was watched, longest/shortest by watch time.
function getHistorySortMode() {
    return ["longest", "shortest"].includes(historySortEl?.value) ? "watchTime" : "actualTime";
}

function getHistorySortDirection() {
    return ["oldest", "shortest"].includes(historySortEl?.value) ? "asc" : "desc";
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
    const bounds = getMonthScopeBounds(selectedYear, selectedMonth);
    return entries.filter(
        (entry) => getEntrySecondsForMonth(entry, selectedYear, selectedMonth) > 0 || hasActivityCounts(entry, bounds)
    );
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
    const allRangesByDate = {};
    const { startMs, endMs } = getMonthScopeBounds(year, month);
    for (const entry of entries) {
        const rangesByDate = {};
        for (const range of getRecordedEntryRangesForScope(entry, startMs, endMs)) {
            addWatchRangeToRangesByDate(rangesByDate, range);
            addWatchRangeToRangesByDate(allRangesByDate, range);
        }
        const exactDailySeconds = sumWatchRangesByDate(rangesByDate, 0);
        const dateKeys = new Set([
            ...Object.keys(exactDailySeconds),
            ...Object.keys(entry.dailySeconds || {}).filter((dateKey) =>
                dateKey.startsWith(formatMonthKey(year, month))
            ),
        ]);
        for (const dateKey of dateKeys) {
            const seconds = Math.max(
                0,
                (Number(entry.dailySeconds?.[dateKey]) || 0) - (Number(exactDailySeconds[dateKey]) || 0)
            );
            if (seconds <= 0) continue;
            totals[dateKey] = (Number(totals[dateKey]) || 0) + seconds;
        }
    }
    for (const [dateKey, seconds] of Object.entries(sumWatchRangesByDate(allRangesByDate, 0))) {
        totals[dateKey] = (totals[dateKey] || 0) + seconds;
    }
    return totals;
}

function getCalendarLevel(seconds) {
    if (seconds >= 5 * 60 * 60) return "3";
    if (seconds >= 2 * 60 * 60) return "2";
    return "1";
}

function shiftSelectedMonth(delta) {
    resetViewPages();
    historyScopeEl.value = "month";
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
    historyScopeEl.options[0].textContent = selectedDateKey
        ? formatDateLabel(selectedDateKey)
        : `${selectedYear}.${String(selectedMonth).padStart(2, "0")}`;
    clearDateFilterButton.disabled = !selectedDateKey;
    clearDateFilterButton.hidden = !selectedDateKey;
    renderWeekdays();
    const focusedDate = calendarDaysEl.contains(document.activeElement) ? document.activeElement.dataset.date : null;
    let focusTarget = null;

    const monthKey = formatMonthKey(selectedYear, selectedMonth);
    const totals = getDayTotals(selectedYear, selectedMonth);
    const dayEntriesByDate = buildMonthDayEntryMap(selectedYear, selectedMonth);
    const firstWeekday = new Date(Date.UTC(selectedYear, selectedMonth - 1, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(selectedYear, selectedMonth, 0)).getUTCDate();
    const today = getKstParts();
    const fragment = document.createDocumentFragment();

    calendarTitleEl.textContent = `${selectedYear}년 ${selectedMonth}월`;
    nextMonthButton.disabled = isFutureMonth(selectedYear, selectedMonth + 1);
    const todayIndex = today.year * 10000 + today.month * 100 + today.day;

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
        item.setAttribute("aria-pressed", String(selectedDateKey === dateKey));
        if (dateKey === focusedDate) focusTarget = item;
        item.setAttribute(
            "aria-label",
            `${formatDateLabel(dateKey)} ${seconds > 0 ? formatDuration(seconds) : "시청 기록 없음"}`
        );

        if (today.year === selectedYear && today.month === selectedMonth && today.day === day) {
            item.dataset.today = "1";
            item.setAttribute("aria-current", "date");
        }
        if (selectedDateKey === dateKey) item.dataset.selected = "1";
        if (seconds <= 0 && selectedYear * 10000 + selectedMonth * 100 + day > todayIndex) {
            item.dataset.future = "1";
            item.disabled = true;
        }

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
            resetViewPages();
            historyScopeEl.value = "month";
            selectedDateKey = selectedDateKey === dateKey ? "" : dateKey;
            renderAll();
            calendarDaysEl.querySelector(`[data-date="${dateKey}"]`)?.focus({ preventScroll: true });
        });
        fragment.appendChild(item);
    }

    calendarDaysEl.replaceChildren(fragment);
    if (focusedDate) (focusTarget || prevMonthButton).focus({ preventScroll: true });

    const [, selectedDateMonth, selectedDateDay] = selectedDateKey.split("-").map(Number);
    calendarFootEl.textContent = selectedDateKey
        ? `${selectedDateMonth}월 ${selectedDateDay}일 기록만 보고 있어요.`
        : "날짜를 누르면 그날 본 기록만 보여 줘요.";
}

function getVisibleRows() {
    const scopeBounds = getHistoryScopeBounds();
    const rows = (selectedDateKey || historyScopeEl?.value === "all" ? entries : getMonthEntries())
        .map((entry) => {
            const sessionsForScope = getEntrySessionsForScope(entry);
            const sessionSeconds = sessionsForScope.reduce((sum, session) => sum + session.scopeSeconds, 0);
            const seconds = Math.max(
                sessionSeconds,
                getStoredWatchSecondsForScope(entry, scopeBounds?.startMs, scopeBounds?.endMs)
            );
            return { entry, seconds, sessionsForScope };
        })
        .filter((row) => row.seconds > 0 || hasActivityCounts(row.entry, scopeBounds));

    return rows.filter((row) => matchesHistoryQuery(row.entry)).sort(compareVisibleRows);
}

function pruneSelectedEntryIds() {
    const existingIds = new Set(entries.map((entry) => entry.id));
    for (const id of selectedEntryIds) {
        if (!existingIds.has(id)) selectedEntryIds.delete(id);
    }
    for (const id of expandedEntryIds) {
        if (!existingIds.has(id)) expandedEntryIds.delete(id);
    }
    for (const id of expandedChatLimits.keys()) {
        if (!existingIds.has(id)) expandedChatLimits.delete(id);
    }
}

function getVisibleEntryIds(rows = getPageRows("history", getVisibleRows())) {
    return rows.map((row) => row.entry.id).filter(Boolean);
}

function renderSelectionControls(rows = getPageRows("history", getVisibleRows())) {
    pruneSelectedEntryIds();

    const visibleIds = getVisibleEntryIds(rows);
    const visibleSelectedCount = visibleIds.filter((id) => selectedEntryIds.has(id)).length;
    const selectedCount = selectedEntryIds.size;

    selectVisibleHistoryEl.disabled = !selectionMode || visibleIds.length === 0;
    selectionControls.hidden = !selectionMode;
    selectionToggle.setAttribute("aria-pressed", String(selectionMode));
    selectionToggle.textContent = selectionMode ? "선택 취소" : "선택";
    selectionToggle.disabled = !selectionMode && entries.length === 0;
    selectVisibleHistoryEl.checked = visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;
    selectVisibleHistoryEl.indeterminate = visibleSelectedCount > 0 && visibleSelectedCount < visibleIds.length;

    const hiddenCount = selectedCount - visibleSelectedCount;
    selectionStatusEl.textContent = `선택 ${selectedCount}개${hiddenCount > 0 ? ` · 현재 목록 밖 ${hiddenCount}개` : ""}`;
    deleteSelectedHistoryButton.disabled = selectedCount === 0;
    clearSelectionButton.disabled = selectedCount === 0;
    clearHistoryButton.disabled = entries.length === 0 && !importedDonations?.owner;
    clearDonationImportButton.disabled = !importedDonations?.owner;
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

function toggleEntryChats(id) {
    if (expandedChatLimits.has(id)) expandedChatLimits.delete(id);
    else expandedChatLimits.set(id, ENTRY_CHAT_PAGE_SIZE);
    renderList();
}

function getEntryActivitiesForScope(entry, kind, bounds = getHistoryScopeBounds()) {
    return entry.activities.filter(
        (row) =>
            row &&
            row.kind === kind &&
            Number.isSafeInteger(row.at) &&
            row.at >= bounds.startMs &&
            row.at < bounds.endMs
    );
}

function buildEntryChatPanel(entry, counts, panelId) {
    const panel = document.createElement("section");
    panel.id = panelId;
    panel.className = "history-entry-chat-panel";
    panel.setAttribute("aria-label", `${entry.title} 내 채팅`);
    panel.hidden = !expandedChatLimits.has(entry.id);
    if (panel.hidden) return panel;

    const chats = getEntryActivitiesForScope(entry, "chat").sort(
        (a, b) => b.at - a.at || String(a.id).localeCompare(String(b.id))
    );
    const limit = expandedChatLimits.get(entry.id);
    // A broadcast's chats usually share one date; show it once instead of on every row.
    const sameDay = chats.length > 0 && chats.every((chat) => isSameKstDate(chat.at, chats[0].at));
    const metaParts = [
        `내 채팅 ${counts.chatCount.toLocaleString()}개`,
        `내용 보관 ${chats.length.toLocaleString()}개`,
    ];
    if (sameDay) metaParts.push(formatKstDateTime(chats[0].at).slice(0, 10));
    metaParts.push("최근 작성순");
    appendText(panel, "history-activity-meta", metaParts.join(" · "));
    if (!chats.length) {
        const empty = document.createElement("p");
        empty.className = "history-entry-chat-empty";
        empty.textContent =
            counts.chatCount > 0
                ? "이 기간에 보관된 채팅 내용이 없어요. 누적 개수는 유지돼요."
                : "이 기간에 저장된 내 채팅이 없어요.";
        panel.appendChild(empty);
        return panel;
    }

    const list = document.createElement("ol");
    list.className = "history-entry-chat-list";
    list.tabIndex = 0;
    list.setAttribute("aria-label", `${entry.title}의 보관된 내 채팅`);
    for (const chat of chats.slice(0, limit)) {
        const item = document.createElement("li");
        item.dataset.chatId = String(chat.id);
        item.tabIndex = -1;
        const time = document.createElement("time");
        time.className = "history-activity-time";
        time.dateTime = new Date(chat.at).toISOString();
        time.textContent = sameDay
            ? formatKstTime(chat.at, { seconds: true })
            : formatKstDateTime(chat.at, { seconds: true }).slice(5);
        item.appendChild(time);
        appendText(item, "history-activity-text", String(chat.text || "") || "내용 없는 채팅");
        list.appendChild(item);
    }
    panel.appendChild(list);
    if (chats.length > limit) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "secondary-button history-entry-chat-more";
        more.textContent = `채팅 더 보기 (${Math.min(limit, chats.length)}/${chats.length})`;
        more.setAttribute("aria-label", `${entry.title} 내 채팅 더 보기`);
        more.addEventListener("click", () => {
            expandedChatLimits.set(entry.id, limit + ENTRY_CHAT_PAGE_SIZE);
            renderList();
            const next = document.getElementById(panelId)?.querySelector("ol")?.children[limit];
            if (next) {
                next.parentElement.scrollTop = next.offsetTop;
                next.focus({ preventScroll: true });
            }
        });
        panel.appendChild(more);
    }
    return panel;
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
                pendingWindow.document.body.textContent = "다시보기를 찾고 있어요...";
            }
        } catch (_) {
            pendingWindow = null;
        }
    }

    resolvingReplayEntryIds.add(entry.id);
    renderList();
    showMessage("해당 방송의 다시보기를 찾고 있어요.");

    try {
        const videoNo = await resolveReplayVideoNo(entry);
        if (!videoNo) {
            if (pendingWindow && !pendingWindow.closed) pendingWindow.close();
            showMessage("해당 방송의 다시보기를 찾지 못했어요.", "error");
            return;
        }

        await persistReplayVideoNo(entry, videoNo);
        openUrlInNewTab(`https://chzzk.naver.com/video/${encodeURIComponent(videoNo)}`, pendingWindow);
        showMessage("다시보기 링크를 찾았어요.");
    } catch (_) {
        if (pendingWindow && !pendingWindow.closed) pendingWindow.close();
        showMessage("다시보기를 찾지 못했어요.", "error");
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
    const leftText = isSameKstDate(session.enteredAt, session.leftAt)
        ? formatKstTime(session.leftAt)
        : formatKstDateTime(session.leftAt);
    return session.closed ? leftText : `${leftText} 기준`;
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
        return formatKstRange(Math.min(first, last), Math.max(first, last));
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

        // The row heading already shows the broadcast title; repeat it only when this visit differed.
        const titleText = pickString(session.title);
        if (titleText && titleText !== row.entry?.title) appendSessionCell(item, "방송 제목", titleText);
        appendSessionCell(item, session.legacy ? "이전 기록" : "입장", formatKstDateTime(session.enteredAt));
        appendSessionCell(item, "퇴장", session.legacy ? "세부 시간 없음" : formatSessionLeftText(session));
        appendSessionCell(item, "시청", formatDuration(session.scopeSeconds));

        const rangeList = buildSessionWatchRangeList(session);
        if (rangeList) item.appendChild(rangeList);

        list.appendChild(item);
    }

    return list;
}

// Channel icons are decorative: only a verified profile image is shown, and any failure leaves the text-only row.
function getChannelIconHosts(channelId) {
    return Array.from(document.querySelectorAll("[data-channel-icon-host]")).filter(
        (host) => host.dataset.channelIconHost === channelId
    );
}

function getChannelIcon(host) {
    return host.querySelector(":scope > .history-channel-icon");
}

function createChannelIcon(channelId, state) {
    const icon = document.createElement("img");
    icon.className = "history-channel-icon";
    icon.alt = "";
    icon.decoding = "async";
    icon.setAttribute("referrerpolicy", "no-referrer");
    icon.dataset.channelId = channelId;
    // Hidden icons take no grid or flex space until the image has actually loaded.
    icon.hidden = state.status !== "ready";
    icon.addEventListener(
        "load",
        () => {
            if (state.status === "failed") return;
            state.status = "ready";
            for (const host of getChannelIconHosts(channelId)) {
                const current = getChannelIcon(host);
                if (current?.dataset.channelId === channelId) current.hidden = false;
            }
        },
        { once: true }
    );
    icon.addEventListener(
        "error",
        () => {
            state.status = "failed";
            icon.remove();
            for (const host of getChannelIconHosts(channelId)) getChannelIcon(host)?.remove();
        },
        { once: true }
    );
    icon.src = state.url;
    return icon;
}

// A host shows the icon only while its current channel ID has a verified image; late results re-check it here.
function syncChannelIcon(host) {
    const channelId = host.dataset.channelIconHost;
    const state = channelIconStates.get(channelId);
    const current = getChannelIcon(host);
    if (!state?.url || !["loading", "ready"].includes(state.status)) {
        current?.remove();
        return;
    }
    if (current?.dataset.channelId === channelId) return;
    current?.remove();
    const anchor = host.querySelector(
        ":scope > .history-item-main, :scope > .history-ranking-copy, :scope > .history-activity-channel"
    );
    host.insertBefore(createChannelIcon(channelId, state), anchor);
}

function setChannelIconHost(host, value) {
    const channelId = normalizeChzzkChannelId(value);
    if (!channelId) return;
    host.dataset.channelIconHost = channelId;
    syncChannelIcon(host);
}

async function lookupChannelIcon(channelId) {
    const state = channelIconStates.get(channelId);
    state.status = "requesting";
    let url = "";
    try {
        const json = await fetchJson(`${API_BASE}/${encodeURIComponent(channelId)}`, {
            credentials: "omit",
            headers: { Accept: "application/json" },
            signal: channelIconAbortController.signal,
            timeoutMs: CHANNEL_ICON_TIMEOUT_MS,
        });
        if (json?.code === 200 && json.content?.channelId === channelId) {
            url = normalizeChzzkImageUrl(json.content.channelImageUrl);
        }
    } catch (_) {
        // Failed, timed-out, or cancelled lookups stay text-only and are not retried in this page.
    }
    if (!url || channelIconAbortController.signal.aborted) {
        state.status = "failed";
        return;
    }
    state.status = "loading";
    state.url = url;
    for (const host of getChannelIconHosts(channelId)) syncChannelIcon(host);
}

function pumpChannelIconLookups() {
    while (
        !channelIconAbortController.signal.aborted &&
        channelIconActiveLookups < CHANNEL_ICON_CONCURRENCY &&
        channelIconQueue.length
    ) {
        channelIconActiveLookups += 1;
        lookupChannelIcon(channelIconQueue.shift()).finally(() => {
            channelIconActiveLookups -= 1;
            pumpChannelIconLookups();
        });
    }
}

// Only rows in the visible panel are looked up; each channel is requested at most once per page lifetime.
function requestChannelIcons(root) {
    if (!root || channelIconAbortController.signal.aborted || root.closest("[hidden]")) return;
    for (const host of root.querySelectorAll("[data-channel-icon-host]")) {
        const channelId = host.dataset.channelIconHost;
        if (channelIconStates.has(channelId)) continue;
        channelIconStates.set(channelId, { status: "queued", url: "" });
        channelIconQueue.push(channelId);
    }
    pumpChannelIconLookups();
}

function cancelChannelIconLookups() {
    channelIconAbortController.abort();
    for (const channelId of channelIconQueue.splice(0)) channelIconStates.get(channelId).status = "failed";
}

function buildHistoryEmptyState() {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    const headline = document.createElement("p");
    headline.textContent = entries.length ? "조건에 맞는 시청 기록이 없어요." : "아직 저장된 시청 기록이 없어요.";
    const hint = document.createElement("p");
    hint.className = "history-empty-hint";
    if (entries.length) {
        hint.textContent = "검색어나 기간을 바꾸거나 다른 날짜를 골라 보세요.";
    } else {
        const link = document.createElement("a");
        link.href = "options.html";
        link.textContent = "설정";
        hint.append("라이브를 일정 시간 이상 보면 여기에 기록돼요. 기록 저장 여부는 ", link, "에서 바꿀 수 있어요.");
    }
    empty.append(headline, hint);
    return empty;
}

function renderList() {
    // Capture focus when rendering, not when an earlier async request started.
    const active = document.activeElement;
    const hadListFocus = historyListEl.contains(active);
    const focusedEntryId = hadListFocus ? active.closest(".history-item")?.dataset.entryId : null;
    const focusedChatId = hadListFocus ? active.closest("[data-chat-id]")?.dataset.chatId : null;
    const chatScrollPositions = new Map(
        Array.from(historyListEl.querySelectorAll(".history-entry-chat-panel")).map((panel) => [
            panel.id,
            panel.querySelector("ol")?.scrollTop || 0,
        ])
    );
    let focusTarget = null;
    const allRows = getVisibleRows();
    const rows = getPageRows("history", allRows);
    historyListEl.dataset.selectionMode = String(selectionMode);
    const fragment = document.createDocumentFragment();
    listDescriptionEl.textContent = `${getScopeLabel()} · ${allRows.length.toLocaleString()}개 기록`;
    renderSelectionControls(rows);

    if (!rows.length) {
        fragment.appendChild(buildHistoryEmptyState());
        historyListEl.replaceChildren(fragment);
        if (hadListFocus) historySearchEl.focus({ preventScroll: true });
        return;
    }

    for (const row of rows) {
        const entry = row.entry;
        const expanded = expandedEntryIds.has(entry.id);
        const item = document.createElement("div");
        item.className = "history-item";
        item.dataset.entryId = entry.id;
        item.dataset.selected = selectedEntryIds.has(entry.id) ? "1" : "0";
        item.dataset.expanded = expanded ? "1" : "0";

        const selectLabel = document.createElement("label");
        selectLabel.className = "history-item-select";
        selectLabel.hidden = !selectionMode;
        selectLabel.setAttribute("aria-label", `${entry.title} 선택`);
        const selectInput = document.createElement("input");
        selectInput.type = "checkbox";
        selectInput.disabled = !selectionMode;
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
        if (title.tagName === "A") title.title = `${entry.title} · ${title.title}`;
        const activityCounts = getActivityCounts(entry, getHistoryScopeBounds());
        const meta = document.createElement("small");
        meta.className = "history-item-meta";
        appendText(meta, "history-item-channel", entry.channelName);
        appendText(meta, "history-item-date", getEntryDateLabel(entry));
        if (row.sessionsForScope.length > 1) {
            appendText(meta, "history-item-visits", `${row.sessionsForScope.length}회 입장`);
        }
        const time = document.createElement("span");
        time.className = "history-item-time";
        time.textContent = row.seconds > 0 ? formatDuration(row.seconds) : "활동만 기록";
        const watchMeta = document.createElement("span");
        watchMeta.className = "history-item-watch";
        if (row.seconds > 0) watchMeta.append("시청 ");
        watchMeta.appendChild(time);
        meta.appendChild(watchMeta);
        if (activityCounts.donationCount) {
            appendText(
                meta,
                "history-item-donation",
                `내 후원 ${activityCounts.donationCheese.toLocaleString()}치즈 (${activityCounts.donationCount.toLocaleString()}회)`
            );
        }
        body.append(title, meta);

        const chatPanelId = `history-chats-${encodeURIComponent(entry.id)}`;
        const chatButton = document.createElement("button");
        chatButton.type = "button";
        chatButton.className = "history-entry-chats";
        const chatsExpanded = expandedChatLimits.has(entry.id);
        chatButton.hidden = !activityCounts.chatCount && !chatsExpanded && !expanded;
        chatButton.textContent = `내 채팅 ${activityCounts.chatCount.toLocaleString()}개`;
        chatButton.setAttribute("aria-expanded", String(chatsExpanded));
        chatButton.setAttribute("aria-controls", chatPanelId);
        chatButton.setAttribute("aria-label", `${entry.title} 내 채팅 ${chatsExpanded ? "접기" : "보기"}`);
        chatButton.addEventListener("click", () => toggleEntryChats(entry.id));

        const expandButton = document.createElement("button");
        expandButton.className = "history-entry-detail";
        expandButton.type = "button";
        expandButton.textContent = "세부";
        expandButton.title = getTitleHistorySummary(entry) || "방송 제목 이력·입장 기록·삭제";
        const detailPanelId = `history-details-${encodeURIComponent(entry.id)}`;
        expandButton.setAttribute("aria-controls", detailPanelId);
        expandButton.setAttribute("aria-expanded", expanded ? "true" : "false");
        expandButton.setAttribute("aria-label", `${entry.title} 세부 기록 ${expanded ? "접기" : "보기"}`);
        expandButton.addEventListener("click", () => toggleEntryExpanded(entry.id));

        const deleteButton = document.createElement("button");
        deleteButton.className = "history-entry-delete";
        deleteButton.type = "button";
        deleteButton.textContent = "이 기록 삭제";
        deleteButton.disabled = !expanded;
        deleteButton.setAttribute("aria-label", `${entry.title} 기록 삭제`);
        deleteButton.addEventListener("click", () => deleteSingleEntry(entry));

        const actions = document.createElement("span");
        actions.className = "history-item-actions";
        actions.append(chatButton, expandButton);

        if (entry.id === focusedEntryId) {
            if (active.matches(".history-item-select input")) focusTarget = selectInput;
            else if (active.matches(".history-entry-detail")) focusTarget = expandButton;
            else if (active.matches(".history-entry-chats"))
                focusTarget = chatButton.hidden ? expandButton : chatButton;
            else if (active.matches(".history-entry-delete")) focusTarget = deleteButton;
            else if (active.matches(".history-item-title-link") && title.tagName === "A") focusTarget = title;
        }

        item.append(selectLabel, body, actions);
        setChannelIconHost(item, entry.channelId);
        const chatPanel = buildEntryChatPanel(entry, activityCounts, chatPanelId);
        item.appendChild(chatPanel);
        if (entry.id === focusedEntryId) {
            if (active.matches(".history-entry-chat-more"))
                focusTarget = chatPanel.querySelector(".history-entry-chat-more") || chatButton;
            else if (active.matches(".history-entry-chat-list"))
                focusTarget = chatPanel.querySelector("ol") || chatButton;
            else if (focusedChatId)
                focusTarget =
                    Array.from(chatPanel.querySelectorAll("[data-chat-id]")).find(
                        (row) => row.dataset.chatId === focusedChatId
                    ) || chatButton;
        }
        const detailPanel = document.createElement("section");
        detailPanel.id = detailPanelId;
        detailPanel.className = "history-entry-details";
        detailPanel.hidden = !expanded;
        detailPanel.setAttribute("aria-label", `${entry.title} 세부 기록`);
        if (expanded) {
            const titleHistoryList = buildTitleHistoryList(entry);
            if (titleHistoryList) detailPanel.appendChild(titleHistoryList);
            if (row.sessionsForScope.length) detailPanel.appendChild(buildSessionList(row));
        }
        detailPanel.appendChild(deleteButton);
        item.appendChild(detailPanel);
        fragment.appendChild(item);
    }

    historyListEl.replaceChildren(fragment);
    for (const [panelId, scrollTop] of chatScrollPositions) {
        const list = document.getElementById(panelId)?.querySelector("ol");
        if (list && scrollTop > 0) list.scrollTop = scrollTop;
    }
    if (hadListFocus) (focusTarget || historySearchEl).focus({ preventScroll: true });
    requestChannelIcons(historyListEl);
}

function renderSummary() {
    const totalSeconds = getUniqueWatchSecondsForScope();
    const monthSeconds = getUniqueWatchSecondsForMonth(selectedYear, selectedMonth);

    totalWatchTimeEl.textContent = formatDuration(totalSeconds);
    totalLiveCountEl.textContent = `${entries.filter((entry) => entry.watchedSeconds > 0).length}개`;
    monthWatchTimeEl.textContent = formatDuration(monthSeconds);
    monthWatchLabelEl.textContent = `${selectedMonth}월 시청`;
    document.getElementById("donationImportUpdated").textContent = importedDonations?.updatedAt
        ? `마지막 갱신: ${formatKstDateTime(importedDonations.updatedAt)}`
        : "아직 갱신한 내역이 없어요.";

    if (storage) {
        noticeEl.dataset.state = "saved";
        const importedCount = Object.values(importedDonations?.months || {}).reduce(
            (sum, rows) => sum + rows.length,
            0
        );
        noticeEl.textContent =
            !entries.length && importedCount ? `로컬 후원 · ${importedCount}건` : `로컬 기록 · ${entries.length}개`;
    }
}

function renderAll() {
    ensureSelectedMonth();
    renderSummary();
    renderCalendar();
    renderResults();
}

function getActivityCounts(entry, { startMs = -Infinity, endMs = Infinity } = {}) {
    const result = { chatCount: 0, donationCount: 0, donationCheese: 0 };
    for (const [date, counts] of Object.entries(entry.activityDaily || {})) {
        const bounds = getDateScopeBounds(date);
        if (!bounds || bounds.startMs < startMs || bounds.endMs > endMs) continue;
        for (const key of Object.keys(result)) {
            if (Number.isSafeInteger(counts?.[key]) && counts[key] > 0) result[key] += counts[key];
        }
    }
    return result;
}

function hasActivityCounts(entry, bounds) {
    const counts = getActivityCounts(entry, bounds);
    return counts.chatCount > 0 || counts.donationCount > 0;
}

function getDonationView() {
    const bounds = getHistoryScopeBounds();
    const query = compactSpaces(historySearchEl.value).toLowerCase();
    const rows = [];
    const groups = new Map();
    const cutoffs = new Map();
    let incomplete = false;
    const add = (id, count, amount) => {
        const total = groups.get(id) || { count: 0, amount: 0 };
        total.count += Number.isSafeInteger(count) && count > 0 ? count : 0;
        total.amount += Number.isSafeInteger(amount) && amount > 0 ? amount : 0;
        groups.set(id, total);
    };
    for (const [month, imported] of Object.entries(importedDonations?.months || {})) {
        // Older saved snapshots may also include purchases made during the request.
        cutoffs.set(month, Math.max(importedDonations.monthStartedAt[month] || 0, ...imported.map((row) => row.at)));
        for (const row of imported) {
            if (
                row.at < bounds.startMs ||
                row.at >= bounds.endMs ||
                (query && !row.channelName.toLowerCase().includes(query))
            )
                continue;
            rows.push(row);
            add(row.channelId, 1, row.amount);
        }
    }
    for (const entry of entries) {
        if (query && !entry.channelName.toLowerCase().includes(query)) continue;
        const id = entry.channelId || `entry:${entry.id}`;
        const retained = new Map();
        for (const activity of getEntryActivitiesForScope(entry, "donation", bounds)) {
            if (!Number.isSafeInteger(activity.amount) || activity.amount <= 0) continue;
            const date = getKstDateKey(activity.at);
            const cutoff = cutoffs.get(date.slice(0, 7));
            const covered =
                cutoff !== undefined &&
                activity.at <= cutoff &&
                String(activity.id || "").startsWith(`${importedDonations.owner}:`);
            if (covered) continue;
            rows.push({ ...activity, channelId: entry.channelId, channelName: entry.channelName });
            const daily = retained.get(date) || { count: 0, amount: 0 };
            daily.count++;
            daily.amount += activity.amount;
            retained.set(date, daily);
        }
        for (const [date, daily] of Object.entries(entry.activityDaily || {})) {
            const day = getDateScopeBounds(date);
            if (!day || day.startMs < bounds.startMs || day.endMs > bounds.endMs) continue;
            const cutoff = cutoffs.get(date.slice(0, 7));
            if (cutoff === undefined || day.startMs > cutoff) {
                add(id, daily.donationCount || 0, daily.donationCheese || 0);
            } else {
                const current = retained.get(date);
                if (current) add(id, current.count, current.amount);
                if (
                    day.endMs > cutoff &&
                    entry.activityCutoffAt > cutoff &&
                    daily.donationCount > (current?.count || 0)
                )
                    incomplete = true;
            }
        }
    }
    rows.sort((a, b) => b.at - a.at);
    const totals = Array.from(groups.values()).reduce(
        (sum, group) => ({ count: sum.count + group.count, amount: sum.amount + group.amount }),
        { count: 0, amount: 0 }
    );
    return { rows, groups, incomplete, ...totals };
}

function renderRanking(donations = getDonationView()) {
    const bounds = getHistoryScopeBounds();
    const groups = new Map();
    for (const entry of entries) {
        if (!matchesHistoryQuery(entry)) continue;
        const seconds = getStoredWatchSecondsForScope(entry, bounds.startMs, bounds.endMs);
        if (seconds <= 0) continue;
        const id = entry.channelId || `entry:${entry.id}`;
        if (!groups.has(id))
            groups.set(id, {
                id,
                name: entry.channelName,
                count: 0,
                ranges: [],
                residual: 0,
                ...getActivityCounts({}),
            });
        const group = groups.get(id);
        const ranges = getRecordedEntryRangesForScope(entry, bounds.startMs, bounds.endMs);
        group.ranges.push(...ranges);
        group.residual += Math.max(0, seconds - sumWatchRanges(ranges, 0));
        group.count += 1;
        const counts = getActivityCounts(entry, bounds);
        for (const key of Object.keys(counts)) group[key] += counts[key];
    }
    const ranked = Array.from(groups.values())
        .map((group) => ({ ...group, seconds: sumWatchRanges(group.ranges, 0) + group.residual }))
        .sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name, "ko") || a.id.localeCompare(b.id));
    const fragment = document.createDocumentFragment();
    document.getElementById("rankingDescription").textContent =
        `${getScopeLabel()} · ${ranked.length}개 채널 · 시청 시간순 (같은 채널의 겹친 시간 제외)`;
    const pageRows = getPageRows("ranking", ranked);
    const maxSeconds = ranked[0]?.seconds || 0;
    channelRankingEl.start = viewPages.ranking * VIEW_PAGE_SIZE + 1;
    pageRows.forEach((group, index) => {
        const item = document.createElement("li");
        item.dataset.channelId = group.id;
        appendText(item, "history-ranking-position", String(viewPages.ranking * VIEW_PAGE_SIZE + index + 1));
        const copy = document.createElement("div");
        copy.className = "history-ranking-copy";
        appendText(copy, "history-ranking-name", group.name);
        const meta = [`${group.count}개 방송`];
        if (group.chatCount) meta.push(`내 채팅 ${group.chatCount.toLocaleString()}개`);
        const donated = donations.groups.get(group.id);
        if (donated?.count)
            meta.push(`내 후원 ${donated.amount.toLocaleString()}치즈 (${donated.count.toLocaleString()}회)`);
        appendText(copy, "history-activity-meta", meta.join(" · "));
        item.appendChild(copy);
        appendText(item, "history-ranking-time", formatDuration(group.seconds));
        // The bar spans the name and time columns so a long duration does not shorten it.
        const bar = document.createElement("span");
        bar.className = "history-ranking-bar";
        bar.setAttribute("aria-hidden", "true");
        bar.style.setProperty("--ratio", String(maxSeconds > 0 ? Math.min(1, group.seconds / maxSeconds) : 0));
        item.appendChild(bar);
        setChannelIconHost(item, group.id);
        fragment.appendChild(item);
    });
    if (!ranked.length) {
        const empty = document.createElement("li");
        empty.className = "history-empty";
        empty.textContent = "이 기간에 저장된 시청 기록이 없어요.";
        fragment.appendChild(empty);
    }
    channelRankingEl.replaceChildren(fragment);
    requestChannelIcons(channelRankingEl);
}

// Consecutive rows from one broadcast or channel share a heading instead of repeating it on every row.
function appendActivityRows(fragment, rows) {
    let previousGroup = null;
    for (const row of rows) {
        const item = document.createElement("li");
        if (row.group !== previousGroup) {
            previousGroup = row.group;
            item.dataset.groupStart = "1";
            const heading = document.createElement("div");
            heading.className = "history-activity-group";
            appendText(heading, "history-activity-channel", row.channelName);
            if (row.title) appendText(heading, "history-activity-broadcast", row.title).title = row.title;
            setChannelIconHost(heading, row.channelId);
            item.appendChild(heading);
        }
        const line = document.createElement("div");
        line.className = "history-activity-line";
        const time = document.createElement("time");
        time.className = "history-activity-time";
        if (Number.isFinite(row.at)) time.dateTime = new Date(row.at).toISOString();
        time.textContent = formatKstDateTime(row.at, { seconds: true });
        line.appendChild(time);
        appendText(line, "history-activity-text", row.text);
        if (row.amount !== undefined) {
            appendText(line, "history-ranking-time", `${Number(row.amount).toLocaleString()}치즈`);
        }
        item.appendChild(line);
        fragment.appendChild(item);
    }
}

// Donation refresh tools only matter for the donation list, but a running refresh keeps its progress and cancel
// button reachable after switching to chats; the usual rule returns once it ends.
function syncDonationImportVisibility() {
    const isDonation = activityTypeEl.value === "donation";
    donationImportControls.hidden = !isDonation && !donationImportPort;
    donationImportRefresh.hidden = !isDonation;
    document.getElementById("donationImportDescription").hidden = !isDonation;
}

function renderActivity(donations = getDonationView()) {
    const bounds = getHistoryScopeBounds();
    const isDonation = activityTypeEl.value === "donation";
    syncDonationImportVisibility();
    if (isDonation) {
        document.getElementById("donationImportDescription").textContent = donations.incomplete
            ? "갱신 이후 후원 일부의 상세 기록이 정리되어 합계에 빠질 수 있어요. 후원 내역을 갱신해 주세요."
            : "갱신한 내역과 이후 새 후원을 함께 보여 줘요. 같은 기간을 중복해서 더하지 않으며, 후원은 채널명으로 검색해요.";
        activitySummaryEl.textContent = `내 후원 ${donations.amount.toLocaleString()}치즈 (${donations.count.toLocaleString()}회)`;
        const fragment = document.createDocumentFragment();
        appendActivityRows(
            fragment,
            getPageRows("activity", donations.rows).map((row) => ({
                group: row.channelId || row.channelName,
                channelId: row.channelId,
                channelName: row.channelName,
                at: row.at,
                amount: row.amount,
                text: row.text || "메시지 없는 후원",
            }))
        );
        if (!donations.rows.length) {
            const empty = document.createElement("li");
            empty.className = "history-empty";
            empty.textContent = "이 조건에 보관된 후원이 없어요. 후원 내역 갱신으로 확인할 수 있어요.";
            fragment.appendChild(empty);
        }
        activityListEl.replaceChildren(fragment);
        requestChannelIcons(activityListEl);
        return;
    }
    const matching = entries.filter(matchesHistoryQuery);
    const totals = matching.reduce(
        (sum, entry) => {
            const counts = getActivityCounts(entry, bounds);
            for (const key of Object.keys(sum)) sum[key] += counts[key];
            return sum;
        },
        { chatCount: 0, donationCount: 0, donationCheese: 0 }
    );
    activitySummaryEl.textContent = `수집된 내 채팅 ${totals.chatCount.toLocaleString()}개 · 내 후원 ${donations.amount.toLocaleString()}치즈 (${donations.count.toLocaleString()}회)`;
    const rows = matching
        .flatMap((entry) =>
            getEntryActivitiesForScope(entry, activityTypeEl.value, bounds).map((activity) => ({ entry, activity }))
        )
        .sort((a, b) => b.activity.at - a.activity.at || String(a.activity.id).localeCompare(String(b.activity.id)));
    const fragment = document.createDocumentFragment();
    appendActivityRows(
        fragment,
        getPageRows("activity", rows).map(({ entry, activity }) => ({
            group: entry.id,
            channelId: entry.channelId,
            channelName: entry.channelName,
            title: entry.title,
            at: activity.at,
            amount: activity.kind === "donation" ? activity.amount : undefined,
            text: String(activity.text || "") || (activity.kind === "donation" ? "메시지 없는 후원" : "내용 없는 채팅"),
        }))
    );
    if (!rows.length) {
        const empty = document.createElement("li");
        empty.className = "history-empty";
        empty.textContent = "이 조건에 보관된 내역이 없어요.";
        fragment.appendChild(empty);
    }
    activityListEl.replaceChildren(fragment);
    requestChannelIcons(activityListEl);
}

function hideMessage() {
    clearTimeout(hideMessageTimer);
    hideMessageTimer = 0;
    const hadFocus = messageEl.contains(document.activeElement);
    messageEl.classList.remove("is-visible");
    messageEl.classList.add("hidden");
    if (hadFocus) refreshButton.focus({ preventScroll: true });
}

function showMessage(text, type = "success", source = "") {
    clearTimeout(hideMessageTimer);
    hideMessageTimer = 0;
    const hadFocus = messageEl.contains(document.activeElement);
    const copy = document.createElement("span");
    copy.className = "message-text";
    copy.textContent = text;
    messageEl.replaceChildren(copy);
    if (type === "error") {
        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "message-close";
        dismiss.setAttribute("aria-label", "오류 안내 닫기");
        dismiss.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>';
        dismiss.addEventListener("click", hideMessage);
        messageEl.append(dismiss);
    }
    messageEl.dataset.type = type;
    messageEl.dataset.source = source;
    messageEl.classList.remove("hidden");
    messageEl.classList.add("is-visible");
    if (hadFocus) (messageEl.querySelector(".message-close") || refreshButton).focus({ preventScroll: true });

    if (type !== "error") hideMessageTimer = setTimeout(hideMessage, 1800);
}

async function loadHistory({ resetToLatest = false, silent = false } = {}) {
    const generation = ++historyLoadGeneration;
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
        if (generation !== historyLoadGeneration) return false;
        entries = normalizeHistory(data[STORAGE_KEY]);
        importedDonations = donationHistory?.normalizeLedger(data[STORAGE_KEY]?.donationImport) || null;
        pruneSelectedEntryIds();
        if (resetToLatest) {
            resetViewPages();
            selectedYear = 0;
            selectedMonth = 0;
            selectedDateKey = "";
            selectedEntryIds.clear();
            expandedEntryIds.clear();
            expandedChatLimits.clear();
        }
        ensureSelectedMonth({ resetToLatest });
        renderAll();
        if (messageEl.dataset.type === "error" && messageEl.dataset.source === "load") hideMessage();
        return true;
    } catch (_) {
        if (generation !== historyLoadGeneration) return false;
        noticeEl.dataset.state = "dirty";
        noticeEl.textContent = "불러오기 실패";
        showMessage("시청 기록을 불러오지 못했어요. 새로고침 버튼을 눌러 다시 시도해 주세요.", "error", "load");
        return false;
    }
}

function scheduleStorageChangeReload() {
    if (storageChangeReloadScheduled) return;
    storageChangeReloadScheduled = true;
    queueMicrotask(() => {
        storageChangeReloadScheduled = false;
        loadHistory({ silent: true });
    });
}

async function refreshHistory() {
    if (await loadHistory({ silent: false })) {
        showMessage("시청 기록을 새로고침했어요.");
    }
}

async function clearHistory() {
    if (!confirm("이 브라우저에 저장된 시청 기록을 모두 삭제할까요?")) return;

    try {
        await sendWatchHistoryMutation({ kind: "clearHistory", cutoffAt: Date.now() });
        entries = [];
        importedDonations = null;
        resetViewPages();
        selectedDateKey = "";
        selectedEntryIds.clear();
        expandedEntryIds.clear();
        expandedChatLimits.clear();
        ensureSelectedMonth({ resetToLatest: true });
        renderAll();
        showMessage("시청 기록을 삭제했어요.");
    } catch (_) {
        showMessage("시청 기록을 삭제하지 못했어요.", "error");
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
            expandedChatLimits.delete(id);
        }
        pruneSelectedEntryIds();
        renderAll();
        showMessage(successMessage || "선택한 시청 기록을 삭제했어요.");
        return true;
    } catch (_) {
        showMessage("시청 기록을 삭제하지 못했어요.", "error");
        return false;
    }
}

async function deleteSelectedEntries() {
    const count = selectedEntryIds.size;
    if (count <= 0) return;
    const visibleIds = new Set(getVisibleEntryIds());
    const hiddenCount = Array.from(selectedEntryIds).filter((id) => !visibleIds.has(id)).length;
    const hiddenNotice = hiddenCount > 0 ? ` 현재 목록 밖의 기록 ${hiddenCount}개도 함께 삭제돼요.` : "";
    if (!confirm(`선택한 시청 기록 ${count}개를 삭제할까요?${hiddenNotice}`)) return;

    await deleteEntriesByIds(selectedEntryIds, `선택한 시청 기록 ${count}개를 삭제했어요.`);
}

async function deleteSingleEntry(entry) {
    if (!entry?.id) return;
    if (!confirm(`"${entry.title}" 시청 기록을 삭제할까요?`)) return;

    await deleteEntriesByIds([entry.id], "시청 기록 1개를 삭제했어요.");
}

prevMonthButton.addEventListener("click", () => shiftSelectedMonth(-1));
clearDateFilterButton.addEventListener("click", () => {
    const previousDate = selectedDateKey;
    resetViewPages();
    historyScopeEl.value = "month";
    selectedDateKey = "";
    renderAll();
    (calendarDaysEl.querySelector(`[data-date="${previousDate}"]`) || prevMonthButton).focus({
        preventScroll: true,
    });
});
nextMonthButton.addEventListener("click", () => {
    if (!nextMonthButton.disabled) shiftSelectedMonth(1);
});
refreshButton.addEventListener("click", refreshHistory);
clearHistoryButton.addEventListener("click", clearHistory);
historySearchEl.addEventListener("input", () => {
    resetViewPages();
    renderResults();
});
historySortEl.addEventListener("change", () => {
    viewPages.history = 0;
    renderList();
});
historyScopeEl.addEventListener("change", () => {
    selectedDateKey = "";
    resetViewPages();
    renderAll();
});
activityTypeEl.addEventListener("change", () => {
    viewPages.activity = 0;
    renderActivity();
});
selectionToggle.addEventListener("click", () => {
    selectionMode = !selectionMode;
    if (!selectionMode) selectedEntryIds.clear();
    renderList();
    selectionToggle.focus({ preventScroll: true });
});

for (const tab of viewTabs) {
    tab.addEventListener("click", () => setHistoryView(tab.dataset.historyView));
    tab.addEventListener("keydown", (event) => {
        const index = viewTabs.indexOf(tab);
        const rtl = getComputedStyle(document.documentElement).direction === "rtl";
        const step = event.key === "ArrowRight" ? (rtl ? -1 : 1) : event.key === "ArrowLeft" ? (rtl ? 1 : -1) : 0;
        let next = step ? (index + step + viewTabs.length) % viewTabs.length : null;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = viewTabs.length - 1;
        if (next === null) return;
        event.preventDefault();
        setHistoryView(viewTabs[next].dataset.historyView, { focus: true });
    });
}
for (const view of viewNames) {
    for (const [suffix, step] of [
        ["PrevPage", -1],
        ["NextPage", 1],
    ]) {
        document.getElementById(`${view}${suffix}`).addEventListener("click", () => {
            viewPages[view] += step;
            renderResults();
            const panel = document.getElementById(`${view}Panel`);
            panel.focus({ preventScroll: true });
            panel.scrollIntoView?.({ block: "start" });
        });
    }
}
selectVisibleHistoryEl.addEventListener("change", () => setVisibleEntriesSelected(selectVisibleHistoryEl.checked));
deleteSelectedHistoryButton.addEventListener("click", deleteSelectedEntries);
clearSelectionButton.addEventListener("click", () => {
    selectedEntryIds.clear();
    renderList();
    (selectVisibleHistoryEl.disabled ? historySearchEl : selectVisibleHistoryEl).focus({ preventScroll: true });
});

if (globalThis.chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local" || !changes[STORAGE_KEY]) return;
        scheduleStorageChangeReload();
    });
}

function setDonationImportBusy(busy) {
    donationImportControls.setAttribute("aria-busy", String(busy));
    donationImportRefresh.disabled = busy;
    donationImportCancel.hidden = !busy;
    donationImportCancel.disabled = !busy;
    syncDonationImportVisibility();
}

function showDonationImportStatus(text, error = false) {
    donationImportStatus.textContent = text;
    donationImportStatus.dataset.error = String(error);
}

// Like `done`, a refresh that ends in an error lands on the donation list, where its status and the retry button
// are shown, instead of writing the error into tools hidden behind the chat list.
function showDonationImportFailure(text) {
    if (activityTypeEl.value !== "donation") {
        activityTypeEl.value = "donation";
        viewPages.activity = 0;
        renderActivity();
    }
    showDonationImportStatus(text, true);
}

donationImportRefresh.addEventListener("click", () => {
    if (donationImportPort) return;
    try {
        const generation = ++donationImportGeneration;
        const port = chrome.runtime.connect({ name: donationHistory.PORT_NAME });
        donationImportPort = port;
        setDonationImportBusy(true);
        showDonationImportStatus("로그인 상태와 후원 내역을 확인하고 있어요.");
        const finish = () => {
            if (donationImportPort !== port) return;
            donationImportPort = null;
            setDonationImportBusy(false);
            port.disconnect();
        };
        port.onDisconnect.addListener(() => {
            const error = chrome.runtime.lastError;
            if (donationImportPort !== port) return;
            donationImportPort = null;
            setDonationImportBusy(false);
            showDonationImportFailure(
                error ? "가져오기 연결이 끊겼어요. 다시 시도해 주세요." : "가져오기가 중단됐어요. 다시 시도해 주세요."
            );
        });
        port.onMessage.addListener(async (message) => {
            if (donationImportPort !== port) return;
            if (message.type === "progress") {
                showDonationImportStatus(
                    `${message.month} · ${message.monthIndex}/${message.monthCount}개월 · ${message.page}/${message.pages}페이지 · 일반 후원 ${message.count}건 확인`
                );
            } else if (message.type === "saving") {
                donationImportCancel.disabled = true;
                showDonationImportStatus("확인한 후원 내역을 저장하고 있어요.");
            } else if (message.type === "error") {
                finish();
                showDonationImportFailure(message.message);
            } else if (message.type === "done") {
                finish();
                activityTypeEl.value = "donation";
                historyScopeEl.value = "all";
                selectedDateKey = "";
                resetViewPages();
                await loadHistory({ silent: true });
                if (generation !== donationImportGeneration) return;
                showDonationImportStatus(`${message.monthCount}개월을 확인해 후원 내역을 갱신했어요.`);
                donationImportRefresh.focus({ preventScroll: true });
            }
        });
        port.postMessage({ type: "start" });
    } catch (error) {
        donationImportPort?.disconnect();
        donationImportPort = null;
        setDonationImportBusy(false);
        showDonationImportFailure(error.message || "가져오기를 시작하지 못했어요.");
    }
});

donationImportCancel.addEventListener("click", () => {
    donationImportPort?.postMessage({ type: "cancel" });
    donationImportCancel.disabled = true;
    showDonationImportStatus("가져오기를 취소하고 있어요.");
});
window.addEventListener("pagehide", () => donationImportPort?.disconnect());
window.addEventListener("pagehide", cancelChannelIconLookups);
clearDonationImportButton.addEventListener("click", async () => {
    if (!confirm("갱신으로 받은 후원 내역과 조회 상태를 초기화할까요? 실시간으로 저장한 기록은 유지돼요.")) return;
    try {
        await sendWatchHistoryMutation({ kind: "clearDonationImport", cutoffAt: Date.now() });
        await loadHistory({ silent: true });
        showMessage("후원 갱신 기록을 초기화했어요. 다음 갱신은 전체 기간을 조회해요.");
    } catch (_) {
        showMessage("후원 갱신 기록을 초기화하지 못했어요.", "error");
    }
});

setHistoryView(activeHistoryView);
globalThis.BetterChzzkHistoryBackup?.init({ reload: () => loadHistory({ silent: true }) });
loadHistory({ resetToLatest: true });
