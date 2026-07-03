(() => {
    const CLOCK_ID = "betterchzzk-vod-broadcast-clock";
    const STYLE_ID = "betterchzzk-vod-broadcast-clock-style";
    const TITLE_HISTORY_WRAP_ID = "betterchzzk-vod-title-history";
    const TITLE_HISTORY_BUTTON_ID = "betterchzzk-vod-title-history-toggle";
    const TITLE_HISTORY_PANEL_ID = "betterchzzk-vod-title-history-panel";
    const WATCH_HISTORY_STORAGE_KEY = "betterChzzkLiveWatchHistory";
    const VIDEO_DETAIL_API_BASE = "https://api.chzzk.naver.com/service/v2/videos";
    const VOD_TIME_SELECTOR = "div.pzp-vod-time, div.pzp-pc__vod-time, div.pzp-pc-vod-time";
    const LEFT_BUTTONS_SELECTOR = [
        "div.pzp-pc__bottom-buttons--left",
        "div.pzp-pc-bottom-buttons--left",
        "div[class*='pzp'][class*='bottom-buttons'][class*='left']",
    ].join(", ");
    const RIGHT_BUTTONS_SELECTOR = [
        "div.pzp-pc__bottom-buttons--right",
        "div.pzp-pc-bottom-buttons--right",
        "div[class*='pzp'][class*='bottom-buttons'][class*='right']",
    ].join(", ");
    const BUTTON_SELECTOR = "button, [role='button']";
    const CLIP_BUTTON_TERMS = ["클립", "clip", "scissor", "가위"];
    const VOD_TITLE_SELECTOR = [
        "h1",
        "h2",
        "h3",
        "[class*='video_information_title']",
        "[class*='video-info-title']",
        "[class*='videoInfoTitle']",
        "[class*='VideoInfo_title']",
        "[class*='vod_title']",
    ].join(", ");
    const RELEVANT_DOM_SELECTOR = [
        "video",
        VOD_TIME_SELECTOR,
        LEFT_BUTTONS_SELECTOR,
        RIGHT_BUTTONS_SELECTOR,
        VOD_TITLE_SELECTOR,
        `#${CLOCK_ID}`,
        `#${TITLE_HISTORY_WRAP_ID}`,
        `#${TITLE_HISTORY_BUTTON_ID}`,
        `#${TITLE_HISTORY_PANEL_ID}`,
    ].join(", ");
    const FETCH_TIMEOUT_MS = 8000;
    const DOM_SYNC_THROTTLE_MS = 120;
    const PAGE_CHANGE_DELAY_MS = 500;
    const CONTROL_AREA_BEFORE_VIDEO_BOTTOM = 150;
    const CONTROL_AREA_AFTER_VIDEO_BOTTOM = 110;
    const CONTROL_AREA_MAX_HEIGHT = 96;
    const HISTORY_START_TOLERANCE_MS = 3 * 60 * 60 * 1000;
    const VOD_SPLIT_SEGMENT_MS = 17 * 60 * 60 * 1000;
    const VOD_SPLIT_OFFSET_TOLERANCE_MS = 45 * 60 * 1000;
    const VOD_SPLIT_MIN_OFFSET_MS = VOD_SPLIT_SEGMENT_MS - VOD_SPLIT_OFFSET_TOLERANCE_MS;
    const MAX_DETAIL_CACHE_ENTRIES = 100;
    const MAX_HISTORY_INFO_CACHE_ENTRIES = 100;

    const {
        addTitleHistory,
        bindFeatureOptions,
        cleanEntryTitle,
        cleanTitle,
        createMutationObserverSync,
        createThrottledDomSync,
        fetchJson,
        getKstParts,
        getMainVideoElement,
        getVodVideoNoFromPath,
        injectStyleOnce,
        isSameKstDate: sameKstDate,
        isVisible,
        mutationMatchesSelector,
        normalizeCompact,
        normalizeForMatch,
        normalizeTitleHistory,
        onReady,
        pad2,
        parseChzzkDate,
        pickVideoEndDateText,
        pickVideoStartDateText,
        pickLargestVisible,
        pickString,
        startPageChangeDetection,
        startStorageChangeListener,
        storageGet,
        touchMapEntry,
    } = BetterChzzk.utils;

    let featureOptions = BetterChzzkSettings.normalizeOptions();
    let attachedVideo = null;
    let clockEl = null;
    let clockTextEl = null;
    let clockAnchorEl = null;
    let currentVideoNo = "";
    let currentStartMs = NaN;
    let currentOriginalStartMs = NaN;
    let currentSegmentOffsetMs = 0;
    let currentStartSource = "";
    let currentHistoryInfo = null;
    let titleHistoryExpanded = false;
    let metadataState = "idle";
    let metadataToken = 0;
    let pageChangeTimer = 0;
    let lastUrl = location.href;
    let domObserver = null;
    let domObserverMode = "";
    let removePageChangeDetection = null;
    let runtimeInstalled = false;
    let pageListenersInstalled = false;
    let removeStorageChangeListener = null;
    let startupSyncTimer = 0;
    const detailCache = new Map();
    const historyInfoCache = new Map();
    const storage = globalThis.chrome?.storage?.local;
    let watchHistorySnapshot = null;
    let watchHistorySnapshotPromise = null;

    const scheduleSync = createThrottledDomSync(syncVodBroadcastClock, DOM_SYNC_THROTTLE_MS);

    function isClockEnabled() {
        return featureOptions.vodBroadcastClockEnabled === true;
    }

    function isTitleHistoryEnabled() {
        return featureOptions.liveWatchHistoryEnabled !== false;
    }

    function isVodFeatureEnabled() {
        return isClockEnabled() || isTitleHistoryEnabled();
    }

    function getVideoNoFromUrl() {
        return getVodVideoNoFromPath();
    }

    function isVodRoute() {
        return Boolean(getVideoNoFromUrl());
    }

    function getMainVideo() {
        if (typeof getMainVideoElement === "function") return getMainVideoElement();
        return pickLargestVisible(document.querySelectorAll("video")) || document.querySelector("video");
    }

    function getVisibleArea(el) {
        if (!(el instanceof HTMLElement) || !el.isConnected) return 0;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return 0;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return 0;
        return rect.width * rect.height;
    }

    function isVideoUsable(video) {
        return video instanceof HTMLVideoElement && video.isConnected && getVisibleArea(video) > 0;
    }

    function isInLikelyVideoControlArea(el, video) {
        if (!(el instanceof HTMLElement) || !(video instanceof HTMLVideoElement)) return false;
        if (typeof isVisible === "function" && !isVisible(video)) return false;

        const elRect = el.getBoundingClientRect();
        const videoRect = video.getBoundingClientRect();
        if (elRect.width <= 0 || elRect.height <= 0) return false;

        const centerX = elRect.left + elRect.width / 2;
        const centerY = elRect.top + elRect.height / 2;
        const horizontallyInsideVideo = centerX >= videoRect.left - 36 && centerX <= videoRect.right + 36;
        const nearVideoBottom =
            centerY >= videoRect.bottom - CONTROL_AREA_BEFORE_VIDEO_BOTTOM &&
            centerY <= videoRect.bottom + CONTROL_AREA_AFTER_VIDEO_BOTTOM;

        return horizontallyInsideVideo && nearVideoBottom && elRect.height <= CONTROL_AREA_MAX_HEIGHT;
    }

    function findLeftButtonsContainer(video) {
        const candidates = [];
        for (const el of document.querySelectorAll(LEFT_BUTTONS_SELECTOR)) {
            if (!(el instanceof HTMLElement) || getVisibleArea(el) <= 0) continue;
            if (video instanceof HTMLVideoElement && !isInLikelyVideoControlArea(el, video)) continue;

            const rect = el.getBoundingClientRect();
            candidates.push({ el, width: rect.width, left: rect.left });
        }

        if (!candidates.length) return null;
        candidates.sort((a, b) => a.left - b.left || a.width - b.width);
        return candidates[0].el;
    }

    function findRightButtonsContainer(video) {
        const candidates = [];
        for (const el of document.querySelectorAll(RIGHT_BUTTONS_SELECTOR)) {
            if (!(el instanceof HTMLElement) || getVisibleArea(el) <= 0) continue;
            if (video instanceof HTMLVideoElement && !isInLikelyVideoControlArea(el, video)) continue;

            const rect = el.getBoundingClientRect();
            candidates.push({ el, width: rect.width, left: rect.left });
        }

        if (!candidates.length) return null;
        candidates.sort((a, b) => a.left - b.left || b.width - a.width);
        return candidates[0].el;
    }

    function containsAnyTerm(value, terms) {
        const text = normalizeCompact(value);
        return terms.some((term) => text.includes(normalizeCompact(term)));
    }

    function getHistoryEntries(raw) {
        const source = raw && typeof raw === "object" ? raw : {};
        const rawEntries = Array.isArray(source.entries)
            ? source.entries
            : source.entries && typeof source.entries === "object"
              ? Object.values(source.entries)
              : [];

        return rawEntries
            .filter((row) => row && typeof row === "object")
            .map((row) => {
                const channelName = pickString(row.channelName);
                const entry = {
                    id: pickString(row.id),
                    channelId: pickString(row.channelId),
                    liveId: pickString(row.liveId),
                    replayVideoNo: pickString(row.replayVideoNo, row.videoNo, row.videoId),
                    title: cleanEntryTitle(pickString(row.title), channelName),
                    channelName,
                    liveOpenDate: pickString(row.liveOpenDate),
                    firstWatchedAt: Number(row.firstWatchedAt) || 0,
                    lastWatchedAt: Number(row.lastWatchedAt) || 0,
                    titleHistory: normalizeTitleHistory(row.titleHistory, channelName),
                };
                addTitleHistory(entry, entry.title, entry.firstWatchedAt || entry.lastWatchedAt);
                return entry;
            })
            .filter((entry) => entry.id && entry.titleHistory.length);
    }

    function getWatchHistorySnapshot() {
        if (!storage) return Promise.resolve(null);
        if (watchHistorySnapshot) return Promise.resolve(watchHistorySnapshot);
        if (watchHistorySnapshotPromise) return watchHistorySnapshotPromise;

        watchHistorySnapshotPromise = storageGet(storage, WATCH_HISTORY_STORAGE_KEY)
            .then((data) => {
                watchHistorySnapshot = data?.[WATCH_HISTORY_STORAGE_KEY] || null;
                return watchHistorySnapshot;
            })
            .finally(() => {
                watchHistorySnapshotPromise = null;
            });

        return watchHistorySnapshotPromise;
    }

    function invalidateWatchHistorySnapshot() {
        watchHistorySnapshot = null;
        watchHistorySnapshotPromise = null;
        historyInfoCache.clear();
        currentHistoryInfo = null;
        if (isVodRoute()) scheduleSync();
    }

    function clearWatchHistorySnapshotCache() {
        watchHistorySnapshot = null;
        watchHistorySnapshotPromise = null;
        historyInfoCache.clear();
        currentHistoryInfo = null;
    }

    function getVideoDetailLiveId(detail) {
        return pickString(detail?.liveId, detail?.liveNo, detail?.live?.liveId, detail?.live?.liveNo);
    }

    function getVideoDetailChannelId(detail) {
        return pickString(
            detail?.channelId,
            detail?.channel?.channelId,
            detail?.channel?.id,
            detail?.channel?.channelNo
        );
    }

    function getVideoDetailChannelName(detail) {
        return pickString(detail?.channelName, detail?.channel?.channelName, detail?.channel?.name);
    }

    function getVideoDetailTitle(detail) {
        return cleanEntryTitle(
            pickString(detail?.videoTitle, detail?.title, detail?.liveTitle),
            getVideoDetailChannelName(detail)
        );
    }

    function getHistoryChannelMatch(entry, detail) {
        const entryChannelId = pickString(entry?.channelId);
        const detailChannelId = getVideoDetailChannelId(detail);
        if (entryChannelId && detailChannelId) {
            return entryChannelId === detailChannelId ? "same" : "different";
        }

        const entryChannelName = normalizeForMatch(entry?.channelName);
        const detailChannelName = normalizeForMatch(getVideoDetailChannelName(detail));
        if (entryChannelName && detailChannelName) {
            return entryChannelName === detailChannelName ? "same" : "different";
        }

        return "unknown";
    }

    function getVideoDurationSeconds(detail) {
        const duration = Number(detail?.duration);
        return Number.isFinite(duration) && duration > 0 ? duration : NaN;
    }

    function getEntryStartMs(entry) {
        const openMs = parseChzzkDate(entry?.liveOpenDate)?.getTime();
        if (Number.isFinite(openMs)) return openMs;
        const first = Number(entry?.firstWatchedAt) || 0;
        if (first > 0) return first;
        const last = Number(entry?.lastWatchedAt) || 0;
        return last > 0 ? last : NaN;
    }

    function getVideoEndMsFromDetail(detail) {
        const startMs = getStartMsFromDetail(detail);
        const duration = getVideoDurationSeconds(detail);
        if (Number.isFinite(startMs) && Number.isFinite(duration)) return startMs + duration * 1000;

        const publishMs = parseChzzkDate(detail?.publishDate)?.getTime();
        return Number.isFinite(publishMs) ? publishMs : NaN;
    }

    function entryOverlapsVideoWindow(entry, detail) {
        const videoStartMs = getStartMsFromDetail(detail);
        const videoEndMs = getVideoEndMsFromDetail(detail);
        if (!Number.isFinite(videoStartMs) || !Number.isFinite(videoEndMs)) return false;

        const entryStartMs = Number(entry?.firstWatchedAt) || getEntryStartMs(entry);
        const entryEndMs = Number(entry?.lastWatchedAt) || entryStartMs;
        if (!Number.isFinite(entryStartMs) || !Number.isFinite(entryEndMs)) return false;

        const toleranceMs = 10 * 60 * 1000;
        return entryEndMs >= videoStartMs - toleranceMs && entryStartMs <= videoEndMs + toleranceMs;
    }

    function scoreHistoryMatch(entry, videoNo, detail) {
        let score = 0;

        const channelMatch = getHistoryChannelMatch(entry, detail);
        if (channelMatch === "different") return Number.NEGATIVE_INFINITY;

        const replayVideoNoMatches = Boolean(entry.replayVideoNo && entry.replayVideoNo === videoNo);
        if (replayVideoNoMatches) score += 1000;

        const liveId = getVideoDetailLiveId(detail);
        const liveIdMatches = Boolean(entry.liveId && liveId && entry.liveId === liveId);
        if (liveIdMatches) score += 650;

        const sameChannel = channelMatch === "same";
        if (sameChannel) {
            score += 80;
            if (entryOverlapsVideoWindow(entry, detail)) score += 360;
        }

        if (!replayVideoNoMatches && !liveIdMatches && !sameChannel) return score;

        const startMs = getStartMsFromDetail(detail);
        const entryStartMs = getEntryStartMs(entry);
        if (Number.isFinite(startMs) && Number.isFinite(entryStartMs)) {
            const diff = Math.abs(startMs - entryStartMs);
            if (diff <= 20 * 60 * 1000) score += 300;
            else if (diff <= HISTORY_START_TOLERANCE_MS) score += 120;
        }

        const videoTitleNorm = normalizeForMatch(getVideoDetailTitle(detail));
        if (videoTitleNorm) {
            let titleScore = 0;
            for (const row of entry.titleHistory) {
                const titleNorm = normalizeForMatch(row.title);
                if (!titleNorm) continue;
                if (titleNorm === videoTitleNorm) titleScore = Math.max(titleScore, 120);
                else if (titleNorm.includes(videoTitleNorm) || videoTitleNorm.includes(titleNorm)) {
                    titleScore = Math.max(titleScore, 60);
                }
            }
            score += titleScore;
        }

        return score;
    }

    function findHistoryInfo(videoNo, detail, entries) {
        let best = null;

        for (const entry of entries) {
            const score = scoreHistoryMatch(entry, videoNo, detail);
            if (!best || score > best.score) best = { entry, score };
        }

        if (!best || best.score < 180) return null;
        return {
            entryId: best.entry.id,
            channelName: best.entry.channelName,
            replayTitle: getVideoDetailTitle(detail),
            titleRows: normalizeTitleHistory(best.entry.titleHistory, best.entry.channelName),
        };
    }

    function loadHistoryInfo(videoNo, detail, token) {
        currentHistoryInfo = null;
        if (!storage || !videoNo) {
            scheduleSync();
            return;
        }

        const cacheKey = `${videoNo}:${getVideoDetailLiveId(detail)}:${pickStartDateText(detail)}`;
        if (historyInfoCache.has(cacheKey)) {
            currentHistoryInfo = touchMapEntry(
                historyInfoCache,
                cacheKey,
                historyInfoCache.get(cacheKey),
                MAX_HISTORY_INFO_CACHE_ENTRIES
            );
            scheduleSync();
            return;
        }

        getWatchHistorySnapshot()
            .then((historySnapshot) => {
                if (metadataToken !== token || currentVideoNo !== videoNo) return;
                const entries = getHistoryEntries(historySnapshot);
                const info = findHistoryInfo(videoNo, detail, entries);
                touchMapEntry(historyInfoCache, cacheKey, info, MAX_HISTORY_INFO_CACHE_ENTRIES);
                currentHistoryInfo = info;
                scheduleSync();
            })
            .catch(() => {
                if (metadataToken !== token || currentVideoNo !== videoNo) return;
                currentHistoryInfo = null;
                scheduleSync();
            });
    }

    function getCandidateText(el) {
        return [el?.getAttribute?.("aria-label"), el?.getAttribute?.("title"), el?.textContent].join(" ");
    }

    function getDirectChildUnder(host, target) {
        if (!(host instanceof HTMLElement) || !(target instanceof HTMLElement) || !host.contains(target)) return null;

        let node = target;
        while (node.parentElement && node.parentElement !== host) {
            node = node.parentElement;
        }
        return node.parentElement === host ? node : null;
    }

    function findRightClockReference(container) {
        if (!(container instanceof HTMLElement)) return null;

        const controls = Array.from(container.querySelectorAll(BUTTON_SELECTOR))
            .filter((el) => el instanceof HTMLElement && getVisibleArea(el) > 0)
            .map((el) => ({
                el,
                directChild: getDirectChildUnder(container, el),
                left: el.getBoundingClientRect().left,
                isClip: containsAnyTerm(getCandidateText(el), CLIP_BUTTON_TERMS),
            }))
            .filter((item) => item.directChild instanceof HTMLElement);

        if (controls.length) {
            controls.sort((a, b) => {
                if (a.isClip !== b.isClip) return a.isClip ? -1 : 1;
                return a.left - b.left;
            });
            return controls[0].directChild;
        }

        const children = Array.from(container.children || []).filter(
            (child) => child instanceof HTMLElement && child.id !== CLOCK_ID && getVisibleArea(child) > 0
        );
        children.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        return children[0] || null;
    }

    function findVodTimeElement() {
        return pickLargestVisible(document.querySelectorAll(VOD_TIME_SELECTOR));
    }

    function findClockAnchor(video) {
        return findRightButtonsContainer(video) || findLeftButtonsContainer(video) || findVodTimeElement();
    }

    function injectClockStyleOnce() {
        injectStyleOnce(
            STYLE_ID,
            `
#${CLOCK_ID}{
  display:inline-flex;
  align-items:center;
  gap:4px;
  height:24px;
  min-width:0;
  margin-left:8px;
  margin-right:0;
  padding:0 8px;
  color:#fff;
  background:rgba(0,0,0,0.38);
  border:1px solid rgba(255,255,255,0.2);
  border-radius:9999px;
  font-family:inherit;
  font-size:14px;
  font-weight:700;
  line-height:20px;
  letter-spacing:0;
  white-space:nowrap;
  pointer-events:none;
  user-select:none;
  font-variant-numeric:tabular-nums;
  flex:0 0 auto;
  align-self:center;
  order:9998;
  box-sizing:border-box;
  text-shadow:0 1px 2px rgba(0,0,0,0.45);
}
#${CLOCK_ID}[data-bcbc-placement="right-controls"]{
  margin-left:0;
  margin-right:8px;
  order:0;
}
#${CLOCK_ID}[data-bcbc-placement="left-controls"]{
  margin-left:8px;
  margin-right:0;
}
#${CLOCK_ID}[data-bcbc-placement="time-inline"]{
  margin-left:8px;
  margin-right:0;
}
#${CLOCK_ID} .bcbc-label{
  opacity:0.7;
  font-weight:600;
}
#${CLOCK_ID} .bcbc-time{
  min-width:0;
}
#${TITLE_HISTORY_WRAP_ID}{
  position:relative;
  display:inline-flex;
  align-items:center;
  flex:0 0 auto;
  align-self:center;
  width:24px;
  height:24px;
  margin-left:8px;
  vertical-align:middle;
  line-height:1;
  z-index:20;
}
#${TITLE_HISTORY_BUTTON_ID}{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  width:24px;
  height:24px;
  min-width:24px;
  margin:0;
  padding:0;
  border:1px solid rgba(0,0,0,0.12);
  border-radius:999px;
  color:#141517;
  background:#eef1f5;
  font-family:inherit;
  font-size:0;
  font-weight:800;
  line-height:1;
  letter-spacing:0;
  vertical-align:middle;
  white-space:nowrap;
  cursor:pointer;
}
#${TITLE_HISTORY_BUTTON_ID} .bcbc-title-history-chevron{
  display:block;
  width:7px;
  height:7px;
  margin-top:-3px;
  border-right:2px solid currentColor;
  border-bottom:2px solid currentColor;
  transform:rotate(45deg);
  transition:transform 120ms ease, margin-top 120ms ease;
}
#${TITLE_HISTORY_BUTTON_ID}:focus-visible{
  outline:2px solid rgba(0,168,107,0.45);
  outline-offset:2px;
}
#${TITLE_HISTORY_BUTTON_ID}:hover{
  background:#e3e7ed;
}
#${TITLE_HISTORY_BUTTON_ID}[aria-expanded="true"]{
  color:#00875a;
  background:rgba(0,168,107,0.12);
  border-color:rgba(0,168,107,0.28);
}
#${TITLE_HISTORY_BUTTON_ID}[aria-expanded="true"] .bcbc-title-history-chevron{
  margin-top:3px;
  transform:rotate(225deg);
}
#${TITLE_HISTORY_PANEL_ID}{
  position:fixed;
  left:var(--bcbc-title-history-left, 12px);
  top:var(--bcbc-title-history-top, 12px);
  z-index:2147483646;
  display:grid;
  gap:0;
  width:max-content;
  max-width:min(760px, calc(100vw - 24px));
  max-height:min(360px, calc(100vh - 24px));
  overflow:auto;
  margin:0;
  padding:6px 8px;
  border:1px solid rgba(0,0,0,0.1);
  border-radius:8px;
  color:#141517;
  background:rgba(255,255,255,0.96);
  box-shadow:0 8px 24px rgba(0,0,0,0.08);
  font-family:inherit;
  box-sizing:border-box;
}
#${TITLE_HISTORY_PANEL_ID}[hidden]{
  display:none!important;
}
#${TITLE_HISTORY_PANEL_ID} .bcbc-title-history-row{
  display:grid;
  grid-template-columns:max-content max-content;
  gap:12px;
  align-items:center;
  min-width:0;
  padding:5px 0;
  border-top:1px solid rgba(0,0,0,0.08);
}
#${TITLE_HISTORY_PANEL_ID} .bcbc-title-history-row:first-of-type{
  border-top:0;
  padding-top:0;
}
#${TITLE_HISTORY_PANEL_ID} .bcbc-title-history-time,
#${TITLE_HISTORY_PANEL_ID} .bcbc-title-history-title{
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
#${TITLE_HISTORY_PANEL_ID} .bcbc-title-history-time{
  color:#7b8493;
  font-size:12px;
  font-weight:800;
}
#${TITLE_HISTORY_PANEL_ID} .bcbc-title-history-title{
  display:block;
  max-width:min(560px, calc(100vw - 190px));
  color:#141517;
  font-size:13px;
  font-weight:900;
}
@media (prefers-color-scheme: dark){
  #${TITLE_HISTORY_BUTTON_ID}{
    border-color:rgba(255,255,255,0.16);
    color:#f2f4f7;
    background:rgba(255,255,255,0.12);
  }
  #${TITLE_HISTORY_BUTTON_ID}:hover{
    background:rgba(255,255,255,0.18);
  }
  #${TITLE_HISTORY_BUTTON_ID}[aria-expanded="true"]{
    color:#00ffa3;
    background:rgba(0,255,163,0.12);
    border-color:rgba(0,255,163,0.28);
  }
  #${TITLE_HISTORY_PANEL_ID}{
    border-color:rgba(255,255,255,0.14);
    color:#f2f4f7;
    background:rgba(24,26,29,0.96);
    box-shadow:0 8px 24px rgba(0,0,0,0.24);
  }
  #${TITLE_HISTORY_PANEL_ID} .bcbc-title-history-row{
    border-top-color:rgba(255,255,255,0.1);
  }
  #${TITLE_HISTORY_PANEL_ID} .bcbc-title-history-time{
    color:#8a93a2;
  }
  #${TITLE_HISTORY_PANEL_ID} .bcbc-title-history-title{
    color:#f2f4f7;
  }
}
@media (max-width: 720px){
  #${CLOCK_ID} .bcbc-label{display:none;}
  #${TITLE_HISTORY_PANEL_ID}{
    max-width:calc(100vw - 24px);
  }
  #${TITLE_HISTORY_PANEL_ID} .bcbc-title-history-row{
    grid-template-columns:max-content minmax(0,1fr);
    gap:8px;
  }
  #${TITLE_HISTORY_PANEL_ID} .bcbc-title-history-title{
    max-width:calc(100vw - 130px);
  }
}
`
        );
    }

    function getClockElement() {
        if (clockEl?.isConnected) return clockEl;
        clockEl = document.getElementById(CLOCK_ID);
        clockTextEl = clockEl?.querySelector(".bcbc-time") || null;
        return clockEl;
    }

    function createClockElement() {
        injectClockStyleOnce();

        const el = document.createElement("span");
        el.id = CLOCK_ID;
        el.setAttribute("aria-live", "off");
        el.innerHTML = `<span class="bcbc-label">방송시각</span><span class="bcbc-time"></span>`;

        clockEl = el;
        clockTextEl = el.querySelector(".bcbc-time");
        return el;
    }

    function syncClockTypography(clock, anchorEl) {
        if (!(clock instanceof HTMLElement) || !(anchorEl instanceof HTMLElement)) return;
        const style = getComputedStyle(anchorEl);
        clock.style.fontFamily = style.fontFamily;
        clock.style.fontSize = style.fontSize;
        clock.style.opacity = style.opacity;
        clock.style.visibility = style.visibility;
        clock.style.transition = style.transition;
    }

    function findClockInsertAfter(timeEl) {
        if (!(timeEl instanceof HTMLElement)) return timeEl;

        const next = timeEl.nextElementSibling;
        if (next instanceof HTMLElement && next.id === "betterchzzk-skip-pill") return next;
        return timeEl;
    }

    function mountClock(clock, anchorEl) {
        if (!(clock instanceof HTMLElement) || !(anchorEl instanceof HTMLElement)) return false;

        clockAnchorEl = anchorEl;

        if (anchorEl.matches?.(RIGHT_BUTTONS_SELECTOR)) {
            const reference = findRightClockReference(anchorEl);
            syncClockTypography(clock, reference || anchorEl);
            clock.setAttribute("data-bcbc-placement", "right-controls");

            if (reference instanceof HTMLElement) {
                if (clock.parentElement !== anchorEl) {
                    if (clock.parentElement) clock.remove();
                    anchorEl.insertBefore(clock, reference);
                } else if (clock.nextElementSibling !== reference) {
                    anchorEl.insertBefore(clock, reference);
                }
                return true;
            }

            if (clock.parentElement !== anchorEl) {
                if (clock.parentElement) clock.remove();
                anchorEl.insertBefore(clock, anchorEl.firstChild);
            }
            return true;
        }

        syncClockTypography(clock, anchorEl);
        if (anchorEl.matches?.(LEFT_BUTTONS_SELECTOR)) {
            clock.setAttribute("data-bcbc-placement", "left-controls");
            if (clock.parentElement !== anchorEl) {
                if (clock.parentElement) clock.remove();
                anchorEl.appendChild(clock);
            }
            return true;
        }

        clock.setAttribute("data-bcbc-placement", "time-inline");
        const insertAfter = findClockInsertAfter(anchorEl);
        if (!insertAfter?.parentElement) return false;
        if (clock.parentElement === insertAfter.parentElement && clock.previousElementSibling === insertAfter)
            return true;

        if (clock.parentElement) clock.remove();
        insertAfter.insertAdjacentElement("afterend", clock);
        return true;
    }

    function removeClock() {
        const clock = getClockElement();
        if (clock) clock.remove();
        if (clock) clock.removeAttribute("data-bcbc-placement");
        clockEl = null;
        clockTextEl = null;
        clockAnchorEl = null;
    }

    function pickStartDateText(detail) {
        return pickVideoStartDateText(detail);
    }

    function getStartMsFromDetail(detail) {
        const startDate = parseChzzkDate(pickStartDateText(detail));
        const startMs = startDate?.getTime();
        return Number.isFinite(startMs) ? startMs : NaN;
    }

    function getEndMsFromDetailForSplit(detail) {
        const endText = pickString(
            pickVideoEndDateText?.(detail),
            detail?.liveCloseDate,
            detail?.closeDate,
            detail?.broadcastCloseDate,
            detail?.live?.closeDate,
            detail?.live?.liveCloseDate
        );
        const endMs = parseChzzkDate(endText)?.getTime();
        return Number.isFinite(endMs) ? endMs : NaN;
    }

    function getSplitVodSegmentOffsetMs(detail, originalStartMs) {
        if (!Number.isFinite(originalStartMs)) return 0;

        const durationSeconds = getVideoDurationSeconds(detail);
        if (!Number.isFinite(durationSeconds)) return 0;

        const endMs = getEndMsFromDetailForSplit(detail);
        if (!Number.isFinite(endMs)) return 0;

        const inferredSegmentStartMs = endMs - durationSeconds * 1000;
        const rawOffsetMs = inferredSegmentStartMs - originalStartMs;
        if (!Number.isFinite(rawOffsetMs) || rawOffsetMs < VOD_SPLIT_MIN_OFFSET_MS) return 0;

        const segmentIndex = Math.round(rawOffsetMs / VOD_SPLIT_SEGMENT_MS);
        if (segmentIndex <= 0) return 0;

        const alignedOffsetMs = segmentIndex * VOD_SPLIT_SEGMENT_MS;
        const driftMs = Math.abs(rawOffsetMs - alignedOffsetMs);
        if (driftMs > VOD_SPLIT_OFFSET_TOLERANCE_MS) return 0;

        return alignedOffsetMs;
    }

    function getVodSegmentStartInfo(detail) {
        const originalStartMs = getStartMsFromDetail(detail);
        if (!Number.isFinite(originalStartMs)) {
            return {
                originalStartMs: NaN,
                segmentOffsetMs: 0,
                segmentStartMs: NaN,
            };
        }

        const segmentOffsetMs = getSplitVodSegmentOffsetMs(detail, originalStartMs);
        return {
            originalStartMs,
            segmentOffsetMs,
            segmentStartMs: originalStartMs + segmentOffsetMs,
        };
    }

    function fetchVideoDetail(videoNo) {
        if (detailCache.has(videoNo)) {
            const cached = detailCache.get(videoNo);
            touchMapEntry(detailCache, videoNo, cached, MAX_DETAIL_CACHE_ENTRIES);
            return cached;
        }

        const promise = fetchJson(`${VIDEO_DETAIL_API_BASE}/${encodeURIComponent(videoNo)}`, {
            headers: { Accept: "application/json" },
            timeoutMs: FETCH_TIMEOUT_MS,
        })
            .then((json) => json?.content || null)
            .catch((error) => {
                detailCache.delete(videoNo);
                throw error;
            });

        touchMapEntry(detailCache, videoNo, promise, MAX_DETAIL_CACHE_ENTRIES);
        return promise;
    }

    function resetMetadata() {
        currentStartMs = NaN;
        currentOriginalStartMs = NaN;
        currentSegmentOffsetMs = 0;
        currentStartSource = "";
        currentHistoryInfo = null;
        titleHistoryExpanded = false;
        metadataState = "idle";
        metadataToken += 1;
    }

    function loadMetadata(videoNo) {
        const token = ++metadataToken;
        currentStartMs = NaN;
        currentOriginalStartMs = NaN;
        currentSegmentOffsetMs = 0;
        currentStartSource = "";
        currentHistoryInfo = null;
        titleHistoryExpanded = false;
        metadataState = "loading";

        fetchVideoDetail(videoNo)
            .then((detail) => {
                if (metadataToken !== token || currentVideoNo !== videoNo) return;

                const startInfo = getVodSegmentStartInfo(detail);
                if (Number.isFinite(startInfo.segmentStartMs)) {
                    currentStartMs = startInfo.segmentStartMs;
                    currentOriginalStartMs = startInfo.originalStartMs;
                    currentSegmentOffsetMs = startInfo.segmentOffsetMs;
                    currentStartSource = pickStartDateText(detail);
                    metadataState = "ready";
                } else {
                    currentStartMs = NaN;
                    currentOriginalStartMs = NaN;
                    currentSegmentOffsetMs = 0;
                    currentStartSource = "";
                    metadataState = "unavailable";
                }
                loadHistoryInfo(videoNo, detail, token);
                scheduleSync();
            })
            .catch(() => {
                if (metadataToken !== token || currentVideoNo !== videoNo) return;
                currentStartMs = NaN;
                currentOriginalStartMs = NaN;
                currentSegmentOffsetMs = 0;
                currentStartSource = "";
                currentHistoryInfo = null;
                metadataState = "error";
                loadHistoryInfo(videoNo, null, token);
                scheduleSync();
            });
    }

    function ensureRouteMetadata(videoNo) {
        if (currentVideoNo === videoNo) return;
        currentVideoNo = videoNo;
        clockAnchorEl = null;
        removeClock();
        removeTitleHistoryExpander();
        loadMetadata(videoNo);
    }

    function formatKstClock(ms, startMs) {
        const parts = getKstParts(ms);
        const timeText = `${pad2(parts.hours)}:${pad2(parts.minutes)}:${pad2(parts.seconds)}`;
        if (sameKstDate(ms, startMs)) return timeText;
        return `${parts.month}/${parts.day} ${timeText}`;
    }

    function formatFullKst(ms) {
        const parts = getKstParts(ms);
        return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hours)}:${pad2(parts.minutes)}:${pad2(parts.seconds)} KST`;
    }

    function formatDuration(seconds) {
        const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
        const s = totalSeconds % 60;
        const m = Math.floor(totalSeconds / 60) % 60;
        const h = Math.floor(totalSeconds / 3600);
        if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
        return `${m}:${pad2(s)}`;
    }

    // eslint-disable-next-line no-unused-vars
    function formatTitleSeenRange(row) {
        const first = Number(row.firstSeenAt) || 0;
        const last = Number(row.lastSeenAt) || 0;
        if (first > 0 && last > 0 && Math.abs(last - first) >= 60000) {
            return `${formatFullKst(first)} - ${formatFullKst(last)}`;
        }
        if (first > 0) return formatFullKst(first);
        if (last > 0) return formatFullKst(last);
        return "기록 시각 없음";
    }

    function formatShortKst(ms) {
        const value = Number(ms) || 0;
        if (value <= 0) return "";
        const parts = getKstParts(value);
        return `${parts.year}.${pad2(parts.month)}.${pad2(parts.day)} ${pad2(parts.hours)}:${pad2(parts.minutes)}`;
    }

    function formatShortKstTime(ms) {
        const value = Number(ms) || 0;
        if (value <= 0) return "";
        const parts = getKstParts(value);
        return `${pad2(parts.hours)}:${pad2(parts.minutes)}`;
    }

    function formatTitleSeenShortRange(row) {
        const first = Number(row.firstSeenAt) || 0;
        const last = Number(row.lastSeenAt) || 0;
        const firstText = formatShortKst(first);
        const lastText = formatShortKst(last);
        if (firstText && lastText && firstText !== lastText) {
            if (sameKstDate(first, last)) return `${firstText}-${formatShortKstTime(last)}`;
            return `${firstText} - ${lastText}`;
        }
        return firstText || lastText || "기록 시각 없음";
    }

    function getDistinctTitleRows(rows, channelName = "") {
        const byTitle = new Map();
        for (const row of normalizeTitleHistory(rows, channelName)) {
            const key = normalizeForMatch(row.title);
            if (!key) continue;
            const existing = byTitle.get(key);
            if (existing) {
                existing.firstSeenAt = Math.min(existing.firstSeenAt, row.firstSeenAt);
                existing.lastSeenAt = Math.max(existing.lastSeenAt, row.lastSeenAt);
            } else {
                byTitle.set(key, { ...row });
            }
        }
        return Array.from(byTitle.values()).sort(
            (a, b) => a.firstSeenAt - b.firstSeenAt || a.lastSeenAt - b.lastSeenAt
        );
    }

    function getPreviousTitleRows() {
        const rows = getDistinctTitleRows(currentHistoryInfo?.titleRows || [], currentHistoryInfo?.channelName);
        if (!rows.length) return [];

        const currentTitleNorm = normalizeForMatch(currentHistoryInfo?.replayTitle);
        if (!currentTitleNorm) return rows.length > 1 ? rows : [];

        return rows.filter((row) => normalizeForMatch(row.title) !== currentTitleNorm);
    }

    function getElementTitleText(el) {
        if (!(el instanceof HTMLElement)) return "";
        const clone = el.cloneNode(true);
        for (const node of clone.querySelectorAll(
            `#${TITLE_HISTORY_WRAP_ID}, #${TITLE_HISTORY_BUTTON_ID}, #${TITLE_HISTORY_PANEL_ID}`
        )) {
            node.remove();
        }
        return cleanTitle(clone.textContent || "");
    }

    function setAttributeIfChanged(el, name, value) {
        if (!(el instanceof Element)) return;
        const next = String(value);
        if (el.getAttribute(name) !== next) el.setAttribute(name, next);
    }

    function setElementTitleIfChanged(el, value) {
        if (!(el instanceof HTMLElement)) return;
        const next = String(value);
        if (el.title !== next) el.title = next;
    }

    function applyClockTitle(clock, lines) {
        setElementTitleIfChanged(clock, lines.join("\n"));
    }

    function findVodTitleElement(video) {
        const expectedTitle = cleanTitle(currentHistoryInfo?.replayTitle);
        const expectedNorm = normalizeForMatch(expectedTitle);
        if (!expectedNorm) return null;

        const videoRect = video instanceof HTMLVideoElement ? video.getBoundingClientRect() : null;
        const candidates = [];
        for (const el of document.querySelectorAll(VOD_TITLE_SELECTOR)) {
            if (!(el instanceof HTMLElement) || !el.isConnected || getVisibleArea(el) <= 0) continue;
            if (el.id === TITLE_HISTORY_BUTTON_ID || el.id === TITLE_HISTORY_PANEL_ID) continue;
            if (el.closest?.(`#${TITLE_HISTORY_PANEL_ID}`)) continue;

            const text = getElementTitleText(el);
            const textNorm = normalizeForMatch(text);
            if (!textNorm) continue;
            if (textNorm !== expectedNorm && !textNorm.includes(expectedNorm) && !expectedNorm.includes(textNorm))
                continue;

            const rect = el.getBoundingClientRect();
            const tagName = el.tagName.toUpperCase();
            const className = String(el.className || "").toLowerCase();
            const belowVideo = videoRect ? rect.top >= videoRect.bottom - 24 : true;
            const horizontalDistance = videoRect ? Math.abs(rect.left - videoRect.left) : rect.left;
            let score = 0;
            if (textNorm === expectedNorm) score += 600;
            if (tagName === "H1" || tagName === "H2") score += 160;
            if (className.includes("title") || className.includes("video")) score += 90;
            if (belowVideo) score += 80;
            score -= Math.max(0, horizontalDistance) / 20;
            score -= Math.max(0, rect.top) / 200;
            candidates.push({ el, score });
        }

        candidates.sort((a, b) => b.score - a.score);
        return candidates[0]?.el || null;
    }

    function removeTitleHistoryExpander() {
        document.getElementById(TITLE_HISTORY_WRAP_ID)?.remove();
        document.getElementById(TITLE_HISTORY_BUTTON_ID)?.remove();
        document.getElementById(TITLE_HISTORY_PANEL_ID)?.remove();
    }

    function renderTitleHistoryPanel(panel, rows) {
        const fragment = document.createDocumentFragment();

        for (const row of rows) {
            const item = document.createElement("div");
            item.className = "bcbc-title-history-row";

            const time = document.createElement("span");
            time.className = "bcbc-title-history-time";
            time.textContent = formatTitleSeenShortRange(row);

            const title = document.createElement("strong");
            title.className = "bcbc-title-history-title";
            title.textContent = row.title;

            item.append(time, title);
            fragment.appendChild(item);
        }

        panel.replaceChildren(fragment);
        panel.hidden = !titleHistoryExpanded;
    }

    function setPanelStyleValue(panel, name, value) {
        if (panel.style.getPropertyValue(name) !== value) {
            panel.style.setProperty(name, value);
        }
    }

    function positionTitleHistoryPanel(anchor, panel) {
        if (!titleHistoryExpanded || !(anchor instanceof HTMLElement) || !(panel instanceof HTMLElement)) return;

        const anchorRect = anchor.getBoundingClientRect();
        const viewportWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
        const viewportHeight = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
        const margin = 12;
        const maxWidth = Math.max(180, Math.min(760, viewportWidth - margin * 2));

        if (panel.style.maxWidth !== `${maxWidth}px`) panel.style.maxWidth = `${maxWidth}px`;

        const panelRect = panel.getBoundingClientRect();
        const panelWidth = Math.min(panelRect.width || maxWidth, maxWidth);
        const panelHeight = Math.min(panelRect.height || 0, Math.max(160, viewportHeight - margin * 2));
        const maxLeft = Math.max(margin, viewportWidth - margin - panelWidth);
        const left = Math.min(Math.max(margin, anchorRect.left), maxLeft);
        const preferredTop = anchorRect.bottom + 6;
        const maxTop = Math.max(margin, viewportHeight - margin - panelHeight);
        const top = Math.min(Math.max(margin, preferredTop), maxTop);

        setPanelStyleValue(panel, "--bcbc-title-history-left", `${Math.round(left)}px`);
        setPanelStyleValue(panel, "--bcbc-title-history-top", `${Math.round(top)}px`);
    }

    function syncTitleHistoryExpander(video) {
        const rows = getPreviousTitleRows();
        if (!rows.length) {
            titleHistoryExpanded = false;
            removeTitleHistoryExpander();
            return;
        }

        const titleEl = findVodTitleElement(video);
        if (!(titleEl instanceof HTMLElement)) {
            removeTitleHistoryExpander();
            return;
        }

        let wrap = document.getElementById(TITLE_HISTORY_WRAP_ID);
        if (!(wrap instanceof HTMLElement)) {
            wrap?.remove();
            wrap = document.createElement("span");
            wrap.id = TITLE_HISTORY_WRAP_ID;
        }
        if (wrap.parentElement !== titleEl.parentElement || wrap.previousElementSibling !== titleEl) {
            wrap.remove();
            titleEl.insertAdjacentElement("afterend", wrap);
        }

        let button = document.getElementById(TITLE_HISTORY_BUTTON_ID);
        if (!(button instanceof HTMLButtonElement)) {
            button?.remove();
            button = document.createElement("button");
            button.id = TITLE_HISTORY_BUTTON_ID;
            button.type = "button";
            button.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                titleHistoryExpanded = !titleHistoryExpanded;
                scheduleSync();
            });
        }
        if (!button.querySelector(".bcbc-title-history-chevron")) {
            const chevron = document.createElement("span");
            chevron.className = "bcbc-title-history-chevron";
            chevron.setAttribute("aria-hidden", "true");
            button.replaceChildren(chevron);
        }
        if (button.parentElement !== wrap) {
            button.remove();
            wrap.appendChild(button);
        }

        let panel = document.getElementById(TITLE_HISTORY_PANEL_ID);
        if (!(panel instanceof HTMLElement)) {
            panel = document.createElement("div");
            panel.id = TITLE_HISTORY_PANEL_ID;
        }
        if (panel.parentElement !== document.body) {
            panel.remove();
            document.body.appendChild(panel);
        }

        const titleHistoryLabel = titleHistoryExpanded ? "이전 방제 접기" : `이전 방제 ${rows.length}개 보기`;
        setAttributeIfChanged(button, "aria-controls", TITLE_HISTORY_PANEL_ID);
        setAttributeIfChanged(button, "aria-expanded", titleHistoryExpanded ? "true" : "false");
        setAttributeIfChanged(button, "aria-label", titleHistoryLabel);
        setElementTitleIfChanged(button, titleHistoryLabel);

        renderTitleHistoryPanel(panel, rows);
        positionTitleHistoryPanel(wrap, panel);
    }

    function getBroadcastTimeMs(video) {
        if (!Number.isFinite(currentStartMs)) return NaN;
        const currentTime = Number(video?.currentTime);
        if (!Number.isFinite(currentTime) || currentTime < 0) return NaN;
        return currentStartMs + Math.floor(currentTime) * 1000;
    }

    function updateClockText(clock, video) {
        const broadcastMs = getBroadcastTimeMs(video);
        if (!Number.isFinite(broadcastMs)) {
            const text = "--:--:--";
            if (!clockTextEl || !clock.contains(clockTextEl)) {
                clockTextEl = clock.querySelector(".bcbc-time");
            }
            if (clockTextEl && clockTextEl.textContent !== text) clockTextEl.textContent = text;

            const stateText =
                metadataState === "loading"
                    ? "방송 시작 시간을 가져오는 중입니다."
                    : "방송 시작 시간을 찾지 못했습니다.";
            applyClockTitle(clock, [stateText]);
            setAttributeIfChanged(clock, "aria-label", `현재 방송 시각 ${text}`);
            return true;
        }

        const text = formatKstClock(broadcastMs, currentStartMs);
        if (!clockTextEl || !clock.contains(clockTextEl)) {
            clockTextEl = clock.querySelector(".bcbc-time");
        }
        if (clockTextEl && clockTextEl.textContent !== text) clockTextEl.textContent = text;

        const title = [
            `방송 기준 시작: ${formatFullKst(currentStartMs)}`,
            `현재 재생 위치: ${formatDuration(video.currentTime)}`,
            `현재 방송 시각: ${formatFullKst(broadcastMs)}`,
        ];
        if (currentSegmentOffsetMs > 0) {
            title.push(`분할 VOD 보정: +${formatDuration(currentSegmentOffsetMs / 1000)}`);

            if (Number.isFinite(currentOriginalStartMs)) {
                title.push(`원본 방송 시작: ${formatFullKst(currentOriginalStartMs)}`);
            }
        }
        if (currentStartSource) title.push(`원본 시작 시간: ${currentStartSource}`);
        applyClockTitle(clock, title);
        setAttributeIfChanged(clock, "aria-label", `현재 방송 시각 ${text}`);
        return true;
    }

    function detachVideoListeners() {
        if (!attachedVideo) return;
        attachedVideo.removeEventListener("timeupdate", scheduleSync, true);
        attachedVideo.removeEventListener("seeked", scheduleSync, true);
        attachedVideo.removeEventListener("loadedmetadata", scheduleSync, true);
        attachedVideo.removeEventListener("durationchange", scheduleSync, true);
        attachedVideo.removeEventListener("play", scheduleSync, true);
        attachedVideo.removeEventListener("pause", scheduleSync, true);
        attachedVideo = null;
    }

    function attachVideoListeners(video) {
        if (attachedVideo === video) return;
        detachVideoListeners();
        if (!(video instanceof HTMLVideoElement)) return;

        attachedVideo = video;
        attachedVideo.addEventListener("timeupdate", scheduleSync, true);
        attachedVideo.addEventListener("seeked", scheduleSync, true);
        attachedVideo.addEventListener("loadedmetadata", scheduleSync, true);
        attachedVideo.addEventListener("durationchange", scheduleSync, true);
        attachedVideo.addEventListener("play", scheduleSync, true);
        attachedVideo.addEventListener("pause", scheduleSync, true);
    }

    function clearRouteState() {
        currentVideoNo = "";
        resetMetadata();
        removeClock();
        removeTitleHistoryExpander();
        detachVideoListeners();
    }

    function syncVodBroadcastClock() {
        if (!isVodFeatureEnabled() || !isVodRoute()) {
            clearRouteState();
            return;
        }

        const videoNo = getVideoNoFromUrl();
        ensureRouteMetadata(videoNo);

        const video = getMainVideo();
        if (isTitleHistoryEnabled()) syncTitleHistoryExpander(video);
        else removeTitleHistoryExpander();

        if (!isClockEnabled()) {
            removeClock();
            detachVideoListeners();
            return;
        }

        attachVideoListeners(video);

        if (!isVideoUsable(video)) {
            removeClock();
            return;
        }

        if (!Number.isFinite(currentStartMs)) {
            removeClock();
            return;
        }

        const anchorEl =
            clockAnchorEl?.isConnected && getVisibleArea(clockAnchorEl) > 0 ? clockAnchorEl : findClockAnchor(video);
        if (!(anchorEl instanceof HTMLElement)) {
            removeClock();
            return;
        }

        const clock = getClockElement() || createClockElement();
        if (!mountClock(clock, anchorEl)) {
            removeClock();
            return;
        }

        if (!updateClockText(clock, video)) removeClock();
    }

    function handlePageChange() {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        clockAnchorEl = null;
        if (pageChangeTimer) clearTimeout(pageChangeTimer);

        if (!isVodRoute()) {
            clearRouteState();
            refreshDomObserverConfig();
            return;
        }

        refreshDomObserverConfig();
        pageChangeTimer = setTimeout(() => {
            pageChangeTimer = 0;
            scheduleSync();
        }, PAGE_CHANGE_DELAY_MS);
    }

    function clearRuntimeTimers() {
        if (pageChangeTimer) {
            clearTimeout(pageChangeTimer);
            pageChangeTimer = 0;
        }
        if (startupSyncTimer) {
            clearTimeout(startupSyncTimer);
            startupSyncTimer = 0;
        }
    }

    function mutationCouldAffectClock(mutation) {
        if (mutationMatchesSelector(mutation, RELEVANT_DOM_SELECTOR)) return true;
        return (
            mutation.target instanceof Element &&
            Boolean(mutation.target.closest?.(`${LEFT_BUTTONS_SELECTOR}, ${RIGHT_BUTTONS_SELECTOR}`))
        );
    }

    function getDomObserverConfig(mode) {
        if (mode !== "vod") {
            return {
                childList: true,
                subtree: true,
            };
        }

        return {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "style", "hidden", "aria-hidden"],
        };
    }

    function refreshDomObserverConfig() {
        if (!domObserver || !document.body) return;
        const nextMode = isVodFeatureEnabled() && isVodRoute() ? "vod" : "idle";
        if (domObserverMode === nextMode) return;

        domObserver.disconnect();
        domObserver.observe(document.body, getDomObserverConfig(nextMode));
        domObserverMode = nextMode;
    }

    function startDomObserver() {
        if (domObserver) return;

        domObserver = createMutationObserverSync({
            onMutations(mutations) {
                handlePageChange();
                if (!isVodFeatureEnabled() || !isVodRoute()) return;
                if (mutations.some(mutationCouldAffectClock)) scheduleSync();
            },
            onBodyReady() {
                refreshDomObserverConfig();
                scheduleSync();
            },
        });

        refreshDomObserverConfig();
    }

    function stopDomObserver() {
        if (domObserver) {
            domObserver.disconnectAll?.();
            domObserver.disconnect();
            domObserver = null;
            domObserverMode = "";
        }
    }

    function handleVisibilityChange() {
        if (!document.hidden) scheduleSync();
    }

    function handleTitleHistoryViewportChange() {
        if (titleHistoryExpanded) scheduleSync();
    }

    function handleWatchHistoryStorageChange(changes, areaName) {
        if (areaName !== "local" || !changes[WATCH_HISTORY_STORAGE_KEY]) return;
        invalidateWatchHistorySnapshot();
    }

    function installPageListeners() {
        if (pageListenersInstalled) return;
        pageListenersInstalled = true;
        document.addEventListener("visibilitychange", handleVisibilityChange, true);
        window.addEventListener("resize", handleTitleHistoryViewportChange, true);
        window.addEventListener("scroll", handleTitleHistoryViewportChange, true);
    }

    function uninstallPageListeners() {
        if (!pageListenersInstalled) return;
        pageListenersInstalled = false;
        document.removeEventListener("visibilitychange", handleVisibilityChange, true);
        window.removeEventListener("resize", handleTitleHistoryViewportChange, true);
        window.removeEventListener("scroll", handleTitleHistoryViewportChange, true);
    }

    function installStorageChangeListener() {
        if (removeStorageChangeListener) return;
        removeStorageChangeListener = startStorageChangeListener(handleWatchHistoryStorageChange);
    }

    function uninstallStorageChangeListener() {
        if (!removeStorageChangeListener) return;
        removeStorageChangeListener();
        removeStorageChangeListener = null;
    }

    function installRuntime() {
        if (runtimeInstalled) return;
        runtimeInstalled = true;
        injectClockStyleOnce();
        if (!removePageChangeDetection) {
            removePageChangeDetection = startPageChangeDetection(handlePageChange);
        }
        startDomObserver();
        installPageListeners();
        installStorageChangeListener();
        scheduleSync();
        if (!startupSyncTimer) {
            startupSyncTimer = setTimeout(() => {
                startupSyncTimer = 0;
                scheduleSync();
            }, 800);
        }
    }

    function teardownRuntime() {
        runtimeInstalled = false;
        clearRuntimeTimers();
        clearRouteState();
        clearWatchHistorySnapshotCache();
        stopDomObserver();
        uninstallPageListeners();
        uninstallStorageChangeListener();
        if (removePageChangeDetection) {
            removePageChangeDetection();
            removePageChangeDetection = null;
        }
    }

    function applyOptions(options) {
        featureOptions = options;
        if (!isVodFeatureEnabled()) {
            teardownRuntime();
            return;
        }

        installRuntime();
        refreshDomObserverConfig();

        scheduleSync();
    }

    bindFeatureOptions(applyOptions);

    onReady(() => {
        if (isVodFeatureEnabled()) installRuntime();
    });
})();
