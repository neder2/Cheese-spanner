/**
 * features/videoSearch.js — 채널 다시보기(/videos) 탭에 제목·댓글 검색 바를 주입한다.
 *
 * 동작 위치: https://chzzk.naver.com/<channelId>/videos 경로의 영상 그리드
 * 하는 일: 채널의 영상 목록을 페이지네이션 API로 전부 인덱싱해 제목/댓글 텍스트로 필터링한다.
 *   기존 그리드 카드를 템플릿으로 복제해 검색 결과 카드를 만들고, 원본 카드는 숨긴다.
 *   댓글 검색은 별도로 영상별 인기 댓글을 지연 로딩하며, 댓글 히트 아이콘과 툴팁을 붙인다.
 *   MutationObserver와 라우트 변경 감지로 SPA 네비게이션에도 검색 바를 재마운트한다.
 * 의존: BetterChzzkSettings(shared/settings.js), BetterChzzk.utils(content.js)
 * 옵션 키: videoSearchEnabled, videoSearchCommentEnabled, videoSearchMaxPages,
 *   videoSearchRenderBatchSize, videoSearchCommentDelayMs, videoSearchCommentMaxVideos,
 *   videoSearchCommentMaxPagesPerVideo
 * DOM 마커: #betterchzzk-video-search-bar, data-bcvs-grid, data-bcvs-card, data-bcvs-hide,
 *   data-bcvs-injected, data-bcvs-load-more, data-bcvs-comment-icon, data-bcvs-comment-tooltip,
 *   data-bcvs-comment-video-no
 * 구조:
 *   - 옵션/상태 변수 선언, BetterChzzk.utils 구조분해 (파일 상단)
 *   - 채널 영상 인덱스 구축: fetchPage, extractVideos, buildIndex, applyFilterDuringIndex
 *   - 댓글 검색: fetchCommentPage, hydrateVideoComments, scheduleCommentSearch, runCommentSearch
 *   - 카드 템플릿 캡처/적용: captureTemplate, buildInjectedCard, applyPlaybackProgress
 *   - 검색 바 UI: buildBar, findFilterPillGroup, syncBarWithHostUi
 *   - 필터 적용/렌더: applyFilter, buildLoadMoreControl, updateStatus
 *   - 댓글 히트 아이콘/툴팁: attachCommentMatch, showCommentTooltip, alignCommentIconsToTagRows
 *   - 마운트 수명주기: ensureBarMounted, removeBar, startObserver, installRuntime, applyOptions
 */
(() => {
    const BAR_ID = "betterchzzk-video-search-bar";
    const STYLE_ID = "betterchzzk-video-search-style";
    const GRID_MARK_ATTR = "data-bcvs-grid";
    const CARD_MARK_ATTR = "data-bcvs-card";
    const HIDE_ATTR = "data-bcvs-hide";
    const INJECTED_ATTR = "data-bcvs-injected";
    const LOAD_MORE_ATTR = "data-bcvs-load-more";
    const COMMENT_ICON_ATTR = "data-bcvs-comment-icon";
    const COMMENT_TOOLTIP_ATTR = "data-bcvs-comment-tooltip";
    const COMMENT_VIDEO_ATTR = "data-bcvs-comment-video-no";

    const API_BASE = "https://api.chzzk.naver.com/service/v1/channels";
    const PAGE_SIZE = 30;
    const COMMENT_PAGE_SIZE = 30;
    const COMMENT_FETCH_CONCURRENCY = 3;
    const INDEX_APPLY_INTERVAL_MS = 260;
    const INDEX_CACHE_TTL_MS = 5 * 60 * 1000;
    const MAX_INDEX_CACHE_CHANNELS = 8;

    const channelIndex = new Map();
    const loadingReasons = new Set();
    let featureOptions = BetterChzzkSettings.normalizeOptions();
    let currentChannelId = null;
    let currentQuery = "";
    let observer = null;
    let lastUrl = location.href;
    let activeFetchToken = 0;
    let commentSearchTimer = 0;
    let commentSearchToken = 0;
    let commentSearchRunning = false;
    let commentSearchPending = false;
    let currentGrid = null;
    let cardTemplate = null;
    let lastFilterKey = null;
    let visibleMatchLimit = featureOptions.videoSearchRenderBatchSize;
    let commentTooltip = null;
    let commentTooltipHideTimer = 0;
    let activeCommentTooltipIcon = null;
    let commentTooltipOpenedAt = 0;
    let lastIndexApplyAt = 0;
    let lastCommentApplyAt = 0;
    let commentApplyTimer = 0;
    let commentAlignFrame = 0;
    let activeIndexAbortController = null;
    let activeCommentAbortController = null;
    let runtimeInstalled = false;
    let routeListenersInstalled = false;
    let removePageChangeDetection = null;
    let commentTooltipListenersInstalled = false;
    let filterPillGroupCache = null;
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        createThrottledDomSync,
        fetchChzzkCommentPage,
        fetchJson,
        isLastPage,
        normSpace,
        normalizeCompact: normalize,
        onReady,
        pickArray,
        pickChzzkVideoNo,
        setLoadingReason,
        sleep,
        startPageChangeDetection,
    } = BetterChzzk.utils;
    const scheduleThrottledMount = createThrottledDomSync(runScheduledMount, 160);

    function isFeatureEnabled() {
        return featureOptions.videoSearchEnabled;
    }

    function isCommentSearchEnabled() {
        return isFeatureEnabled() && featureOptions.videoSearchCommentEnabled;
    }

    function getMaxPages() {
        return featureOptions.videoSearchMaxPages;
    }

    function getRenderBatchSize() {
        return featureOptions.videoSearchRenderBatchSize;
    }

    function getCommentDelayMs() {
        return featureOptions.videoSearchCommentDelayMs;
    }

    function getCommentMaxVideos() {
        return featureOptions.videoSearchCommentMaxVideos;
    }

    function getCommentMaxPagesPerVideo() {
        return featureOptions.videoSearchCommentMaxPagesPerVideo;
    }

    function isVideosTab() {
        return /^\/[^/]+\/videos\/?($|\?)/.test(location.pathname);
    }

    function hasMountedSearch() {
        return Boolean(
            document.getElementById(BAR_ID) ||
            currentGrid ||
            currentChannelId ||
            document.querySelector(
                `[${GRID_MARK_ATTR}="1"],[${CARD_MARK_ATTR}="1"],[${HIDE_ATTR}="1"],[${INJECTED_ATTR}="1"],[${LOAD_MORE_ATTR}="1"],[${COMMENT_ICON_ATTR}="1"]`
            )
        );
    }

    function removeBarIfMounted() {
        if (hasMountedSearch()) removeBar();
    }

    function getChannelIdFromUrl() {
        const m = location.pathname.match(/^\/([^/]+)\/videos/);
        return m ? m[1] : null;
    }

    function injectStyleOnce() {
        BetterChzzk.utils.injectStyleOnce(
            STYLE_ID,
            `
#${BAR_ID}{
  --bcvs-accent:var(--Content-Brand-Strong, #00FFA3);
  --bcvs-bg:var(--Surface-Neutral-Base, #2E3033);
  --bcvs-bg-hover:var(--Surface-Neutral-Strongest, #DFE2EA);
  --bcvs-bg-elev:var(--Surface-Neutral-Strongest, #DFE2EA);
  --bcvs-border:var(--Border-Neutral-Weak, #2E3033);
  --bcvs-border-strong:var(--Border-Neutral-Strong, #697183);
  --bcvs-text:var(--Content-Neutral-Cool-Base, #9DA5B6);
  --bcvs-text-strong:var(--Content-Neutral-Cool-Strong, #C9CEDC);
  --bcvs-input-text:color-mix(in srgb, var(--bcvs-text-strong) 82%, #FFFFFF);
  --bcvs-text-hover:var(--Content-Neutral-Inverse, #111114);
  --bcvs-text-focus:var(--Content-Neutral-Inverse, #111114);
  --bcvs-text-dim:var(--Content-Neutral-Cool-Weak, #697183);
  --bcvs-font-family:inherit;
  --bcvs-font-size:13px;
  --bcvs-font-weight:400;
  --bcvs-line-height:16px;
  --bcvs-height:28px;
  --bcvs-radius:14px;

  position:relative;
  display:inline-flex;
  align-items:center;
  gap:6px;
  margin:0;
  padding:0;
  background:transparent;
  border:0;
  color:var(--bcvs-text);
  font-family:var(--bcvs-font-family);
  font-size:var(--bcvs-font-size);
  font-weight:var(--bcvs-font-weight);
  line-height:var(--bcvs-line-height);
  box-sizing:border-box;
  vertical-align:middle;
}
html[dark] #${BAR_ID},
body[theme="dark"] #${BAR_ID},
.theme_dark #${BAR_ID}{
  --bcvs-input-text:var(--bcvs-text-strong);
}
#${BAR_ID} .bcvs-input-wrap{
  position:relative;
  flex:0 0 auto;
  width:220px;
  display:flex;
  align-items:center;
  height:var(--bcvs-height);
  padding:0 10px;
  background:var(--bcvs-bg);
  border:1px solid var(--bcvs-border);
  border-radius:var(--bcvs-radius);
  transition:border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease;
  box-sizing:border-box;
}
#${BAR_ID}[data-mode="inline"]{align-self:center;margin-left:6px;}
#${BAR_ID}[data-mode="block"]{display:flex;width:100%;margin:16px 0 20px;font-size:14px;}
#${BAR_ID}[data-mode="block"] .bcvs-input-wrap{flex:1 1 auto;width:auto;height:36px;padding:0 12px;border-radius:6px;}
#${BAR_ID} .bcvs-input-wrap:hover{background:var(--bcvs-bg-hover);border-color:var(--bcvs-border-strong);}
#${BAR_ID} .bcvs-input-wrap:hover input[type="search"],
#${BAR_ID} .bcvs-input-wrap:hover .bcvs-icon,
#${BAR_ID} .bcvs-input-wrap:hover .bcvs-clear{color:var(--bcvs-text-hover);}
#${BAR_ID} .bcvs-input-wrap:focus-within{
  background:var(--bcvs-bg-elev);
  border-color:var(--bcvs-accent);
  box-shadow:0 0 0 1px var(--bcvs-accent);
  color:var(--bcvs-text-strong);
}
#${BAR_ID} .bcvs-input-wrap:focus-within input[type="search"],
#${BAR_ID} .bcvs-input-wrap:focus-within .bcvs-icon,
#${BAR_ID} .bcvs-input-wrap:focus-within .bcvs-clear{color:var(--bcvs-text-focus);}
#${BAR_ID} .bcvs-icon{width:14px;height:14px;flex:0 0 auto;opacity:0.75;margin-right:4px;color:currentColor;}
#${BAR_ID}[data-mode="block"] .bcvs-icon{width:16px;height:16px;margin-right:8px;}
#${BAR_ID} .bcvs-input-wrap:focus-within .bcvs-icon{opacity:1;}
#${BAR_ID} input[type="search"]{
  flex:1 1 auto;min-width:0;height:100%;padding:0;margin:0;
  border:0;background:transparent;color:var(--bcvs-input-text);font:inherit;outline:none;
  -webkit-appearance:none;appearance:none;
}
#${BAR_ID} input[type="search"]::-webkit-search-cancel-button{display:none;}
#${BAR_ID} input[type="search"]::placeholder{color:var(--bcvs-text-dim);}
#${BAR_ID} .bcvs-clear{
  display:none;flex:0 0 auto;width:18px;height:18px;margin-left:6px;
  border:0;background:transparent;color:var(--bcvs-text-dim);
  cursor:pointer;padding:0;border-radius:50%;
  align-items:center;justify-content:center;
}
#${BAR_ID} .bcvs-clear:hover{color:var(--bcvs-text-strong);background:var(--Surface-Interaction-Lighten-Hovered, rgba(255,255,255,0.06));}
#${BAR_ID}[data-has-query="1"] .bcvs-clear{display:inline-flex;}
#${BAR_ID} .bcvs-meter{
  display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;
  color:var(--bcvs-text-dim);white-space:nowrap;
  min-height:var(--bcvs-height);
}
#${BAR_ID} .bcvs-spinner{
  width:12px;height:12px;border-radius:50%;
  border:2px solid var(--Border-Neutral-Alpha-Weak, rgba(157,165,182,0.24));
  border-top-color:var(--bcvs-accent);
  animation:bcvs-spin 0.8s linear infinite;flex:0 0 auto;
  visibility:hidden;
}
#${BAR_ID}[data-loading="1"] .bcvs-spinner{visibility:visible;}
@keyframes bcvs-spin{to{transform:rotate(360deg);}}
[${HIDE_ATTR}="1"]{display:none !important;}
[${LOAD_MORE_ATTR}]{
  display:flex;
  align-items:center;
  justify-content:center;
  min-height:72px;
}
[${LOAD_MORE_ATTR}] button{
  height:36px;
  padding:0 16px;
  border:1px solid var(--Border-Neutral-Weak, #2E3033);
  border-radius:8px;
  background:var(--Surface-Neutral-Base, #2E3033);
  color:var(--Content-Neutral-Cool-Strong, #C9CEDC);
  font:inherit;
  cursor:pointer;
}
[${LOAD_MORE_ATTR}] button:hover{
  border-color:var(--Border-Neutral-Strong, #697183);
  color:#fff;
}
.bcvs-comment-card,
.bcvs-comment-host{
  position:relative !important;
  align-self:start !important;
}
.bcvs-comment-hit{
  display:inline-flex !important;
  align-items:center;
  justify-content:center;
  position:absolute !important;
  left:auto !important;
  top:auto !important;
  right:6px !important;
  bottom:0 !important;
  width:30px !important;
  height:30px !important;
  min-width:30px !important;
  min-height:30px !important;
  max-width:30px !important;
  max-height:30px !important;
  margin:0 !important;
  padding:0 !important;
  border:1px solid var(--Border-Neutral-Alpha-Weak, rgba(157,165,182,0.28));
  border-radius:50%;
  background:var(--Surface-Neutral-Alpha-Inverse-Strongest, rgba(27,29,32,0.94));
  color:var(--Content-Neutral-Cool-Base, #9DA5B6);
  box-shadow:0 2px 8px rgba(0,0,0,0.24);
  box-sizing:border-box;
  cursor:default;
  pointer-events:auto !important;
  user-select:none;
  font-size:0 !important;
  line-height:0 !important;
  transform:none !important;
  z-index:60;
}
.bcvs-comment-hit svg{
  display:block;
  width:19px;
  height:19px;
  flex:0 0 auto;
}
.bcvs-comment-hit:hover,
.bcvs-comment-hit:focus-visible,
.bcvs-comment-hit[data-active="1"]{
  border-color:var(--Border-Brand-Alpha-Base, rgba(0,255,163,0.5));
  background:var(--Surface-Brand-Alpha-Weak, rgba(0,255,163,0.16));
  color:var(--Content-Brand-Base, #00E693);
  outline:none;
}
.bcvs-comment-tooltip{
  display:none;
  position:fixed;
  left:0;
  top:0;
  width:max-content;
  max-width:min(460px, calc(100vw - 32px));
  padding:8px 10px;
  border:1px solid var(--Border-Neutral-Alpha-Weak, rgba(157,165,182,0.22));
  border-radius:6px;
  background:var(--Surface-Neutral-Weaker, #1B1D20);
  color:var(--Content-Neutral-Primary, #F2F4F7);
  box-shadow:0 10px 30px rgba(0,0,0,0.3);
  font-family:inherit;
  font-size:12px;
  font-weight:500;
  line-height:17px;
  white-space:normal;
  text-align:left;
  word-break:break-word;
  max-height:320px;
  overflow-y:auto;
  z-index:2147483647;
  pointer-events:auto;
}
.bcvs-comment-tooltip-line{
  display:block;
  min-height:17px;
  margin:1px 0;
  padding:1px 4px;
  border:1px solid transparent;
  border-radius:4px;
  white-space:pre-wrap;
  box-sizing:border-box;
}
.bcvs-comment-tooltip-line[data-hit="1"]{
  border-color:var(--Border-Brand-Alpha-Base, rgba(0,255,163,0.5));
  background:var(--Surface-Brand-Alpha-Weak, rgba(0,255,163,0.14));
  color:var(--Content-Brand-Base, #00E693);
}
.bcvs-comment-tooltip[data-show="1"]{
  display:block;
}
@media (max-width: 520px){
  .bcvs-comment-tooltip{
    max-width:calc(100vw - 16px);
    max-height:260px;
  }
}
`
        );
    }

    function findCardLinks(root = document) {
        const links = [];
        for (const a of root.querySelectorAll('a[href*="/video/"]')) {
            if (/\/video\/\d+/.test(a.getAttribute("href") || "")) links.push(a);
        }
        return links;
    }

    function getVideoNoFromHref(href) {
        const m = (href || "").match(/\/video\/(\d+)/);
        return m ? m[1] : null;
    }

    function findGrid() {
        const links = findCardLinks();
        if (links.length < 2) return null;

        const counts = new Map();
        for (const a of links) {
            let p = a.parentElement;
            let depth = 0;
            while (p && depth < 8) {
                counts.set(p, (counts.get(p) || 0) + 1);
                p = p.parentElement;
                depth++;
            }
        }

        let bestParent = null;
        let bestCount = 0;
        for (const [el, count] of counts) {
            if (count <= bestCount) continue;
            if ((el.children?.length || 0) < 2) continue;
            bestParent = el;
            bestCount = count;
        }

        if (!bestParent) return null;

        let grid = bestParent;
        while (grid.parentElement && grid.children.length === 1) {
            grid = grid.parentElement;
        }
        return grid;
    }

    function pickPublishDate(video) {
        return video.publishDate || video.publishDateAt || video.liveOpenDate || "";
    }

    function extractVideos(json) {
        const content = json?.content ?? json;
        const arr = pickArray(content);
        if (!arr) return [];
        return arr
            .map((v) => {
                const videoNo = pickChzzkVideoNo(v);
                const title = v.videoTitle ?? v.title ?? v.subject ?? "";
                if (!videoNo || !title) return null;
                const readCount = v.readCount ?? v.videoReadCount ?? v.viewCount ?? null;
                const readCountNumber =
                    readCount === null || readCount === undefined || readCount === "" ? null : Number(readCount);
                const livePv = v.livePv ?? v.livePlaybackCount ?? v.liveViewCount ?? null;
                const livePvNumber = livePv === null || livePv === undefined || livePv === "" ? null : Number(livePv);
                return {
                    videoNo,
                    title: String(title),
                    titleNorm: normalize(title),
                    thumb: v.thumbnailImageUrl || v.thumbnailUrl || v.thumbnail || "",
                    duration: typeof v.duration === "number" ? v.duration : null,
                    publishDate: pickPublishDate(v),
                    readCount: Number.isFinite(readCountNumber) ? readCountNumber : null,
                    livePv: Number.isFinite(livePvNumber) ? livePvNumber : null,
                    watchTimeline: v.watchTimeline || null,
                    progressRatio: getWatchProgressRatio(v.watchTimeline, v.duration),
                    type: v.videoType || v.type || "",
                    commentActive: v.commentActive !== false,
                    commentTexts: [],
                    commentNorm: "",
                    commentFetched: v.commentActive === false,
                    commentLoading: false,
                    commentError: null,
                };
            })
            .filter(Boolean);
    }

    function abortController(controller) {
        try {
            controller?.abort();
        } catch (_) {
            // Already aborted or unavailable.
        }
    }

    function isCompleteIndexFresh(entry, now = Date.now()) {
        const completedAt = Number(entry?.completedAt) || 0;
        const age = now - completedAt;
        return Boolean(entry?.complete && completedAt > 0 && age >= 0 && age < INDEX_CACHE_TTL_MS);
    }

    function shouldStartIndexBuild(entry) {
        return !entry || (!isCompleteIndexFresh(entry) && (!entry.loading || entry.loadingToken !== activeFetchToken));
    }

    function touchChannelIndex(channelId, entry) {
        if (!channelId || !entry) return;
        channelIndex.delete(channelId);
        channelIndex.set(channelId, entry);
        while (channelIndex.size > MAX_INDEX_CACHE_CHANNELS) {
            const oldestKey = channelIndex.keys().next().value;
            if (!oldestKey) break;
            channelIndex.delete(oldestKey);
        }
    }

    async function fetchPage(channelId, page, signal = undefined) {
        const url = `${API_BASE}/${encodeURIComponent(channelId)}/videos?sortType=LATEST&pagingType=PAGE&page=${page}&size=${PAGE_SIZE}`;
        return fetchJson(url, {
            headers: { Accept: "application/json" },
            signal,
        });
    }

    async function fetchCommentPage(videoNo, offset, signal = undefined) {
        return fetchChzzkCommentPage({
            limit: COMMENT_PAGE_SIZE,
            objectId: videoNo,
            offset,
            orderType: "POPULAR",
            signal,
        });
    }

    function collectCommentTexts(value, out = []) {
        if (!value) return out;
        if (Array.isArray(value)) {
            for (const item of value) collectCommentTexts(item, out);
            return out;
        }
        if (typeof value !== "object") return out;

        const comment = value.comment;
        if (comment && typeof comment === "object" && typeof comment.content === "string") {
            out.push(comment.content);
        } else if (typeof value.content === "string" && value.commentType) {
            out.push(value.content);
        }

        if (Array.isArray(value.replyComments)) collectCommentTexts(value.replyComments, out);
        return out;
    }

    function cleanCommentText(text) {
        return String(text || "")
            .replace(/\r\n?/g, "\n")
            .split("\n")
            .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    function uniqueCommentTexts(texts) {
        const seen = new Set();
        const out = [];
        for (const text of texts) {
            const cleaned = cleanCommentText(text);
            if (!cleaned) continue;
            const key = normalize(cleaned);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(cleaned);
        }
        return out;
    }

    function extractCommentTexts(content) {
        const texts = [];
        collectCommentTexts(content?.bestComments, texts);
        collectCommentTexts(content?.comments?.data, texts);
        return uniqueCommentTexts(texts);
    }

    async function hydrateVideoComments(video, token, signal = undefined) {
        if (!isCommentSearchEnabled()) return;
        if (!video || video.commentFetched || video.commentLoading || video.commentActive === false) return;

        video.commentLoading = true;
        let shouldMarkFetched = true;
        try {
            const texts = [];
            for (let page = 0; page < getCommentMaxPagesPerVideo(); page++) {
                if (token !== commentSearchToken || signal?.aborted) {
                    shouldMarkFetched = false;
                    break;
                }
                const content = await fetchCommentPage(video.videoNo, page * COMMENT_PAGE_SIZE, signal);
                const pageTexts = extractCommentTexts(content);
                texts.push(...pageTexts);

                const rows = content?.comments?.data;
                if (!Array.isArray(rows) || rows.length < COMMENT_PAGE_SIZE) break;
            }
            video.commentTexts = uniqueCommentTexts(texts);
            video.commentNorm = normalize(video.commentTexts.join(" "));
            video.commentError = null;
        } catch (e) {
            if (signal?.aborted || e?.name === "AbortError") {
                shouldMarkFetched = false;
                return;
            }
            video.commentError = e.message || String(e);
        } finally {
            if (shouldMarkFetched) video.commentFetched = true;
            video.commentLoading = false;
        }
    }

    async function buildIndex(channelId) {
        const existing = channelIndex.get(channelId);
        if (isCompleteIndexFresh(existing)) {
            touchChannelIndex(channelId, existing);
            return existing;
        }
        if (existing && existing.loading && existing.loadingToken === activeFetchToken) return existing;

        abortController(activeIndexAbortController);
        activeIndexAbortController = new AbortController();
        const signal = activeIndexAbortController.signal;
        const token = ++activeFetchToken;
        const entry =
            existing && !existing.complete
                ? existing
                : {
                      videos: [],
                      seen: new Set(),
                      complete: false,
                      completedAt: 0,
                      error: null,
                      loading: false,
                      loadingToken: 0,
                  };
        let reachedBoundary = false;
        let failed = false;
        entry.complete = false;
        entry.completedAt = 0;
        entry.error = null;
        entry.failedAt = 0;
        entry.loading = true;
        entry.loadingToken = token;
        touchChannelIndex(channelId, entry);

        setLoading(true);
        lastIndexApplyAt = 0;
        try {
            for (let page = 0; page < getMaxPages(); page++) {
                if (token !== activeFetchToken) return entry;
                let json;
                try {
                    json = await fetchPage(channelId, page, signal);
                } catch (e) {
                    if (signal.aborted || e?.name === "AbortError") return entry;
                    entry.error = e.message || String(e);
                    entry.failedAt = Date.now();
                    failed = true;
                    break;
                }
                if (token !== activeFetchToken || !currentQuery) return entry;
                const videos = extractVideos(json);
                if (!videos.length && page === 0) {
                    entry.error = "no-data";
                    reachedBoundary = true;
                    break;
                }
                for (const v of videos) {
                    if (entry.seen.has(v.videoNo)) continue;
                    entry.seen.add(v.videoNo);
                    entry.videos.push(v);
                }
                applyFilterDuringIndex();
                if (isLastPage(json, videos, PAGE_SIZE)) {
                    reachedBoundary = true;
                    break;
                }
                if (page === getMaxPages() - 1) reachedBoundary = true;
            }
            entry.complete = !failed && reachedBoundary;
            entry.completedAt = entry.complete ? Date.now() : 0;
        } finally {
            if (entry.loadingToken === token) {
                entry.loading = false;
                entry.loadingToken = 0;
            }
            if (activeIndexAbortController?.signal === signal) {
                activeIndexAbortController = null;
            }
            if (token === activeFetchToken) {
                setLoading(false);
                updateStatus();
                applyFilter();
            }
        }
        return entry;
    }

    function applyFilterDuringIndex() {
        updateStatus();
        const now = performance.now();
        if (now - lastIndexApplyAt < INDEX_APPLY_INTERVAL_MS) return;

        lastIndexApplyAt = now;
        applyFilter();
    }

    function setLoading(on, reason = "index") {
        setLoadingReason(loadingReasons, on, reason, () => {
            const bar = document.getElementById(BAR_ID);
            if (bar) bar.setAttribute("data-loading", loadingReasons.size ? "1" : "0");
        });
    }

    function stopActiveFetch() {
        activeFetchToken++;
        abortController(activeIndexAbortController);
        activeIndexAbortController = null;
        setLoading(false, "index");
        cancelCommentSearch();
    }

    function getEntry() {
        return currentChannelId ? channelIndex.get(currentChannelId) : null;
    }

    function filterVideosByNormalizedQuery(videos, normalizedQuery) {
        if (!normalizedQuery) return videos;
        return videos.filter((v) => v.titleNorm.includes(normalizedQuery) || hasCommentMatchNorm(v, normalizedQuery));
    }

    function hasCommentMatchNorm(video, normalizedQuery) {
        return Boolean(normalizedQuery && video?.commentNorm && video.commentNorm.includes(normalizedQuery));
    }

    function getCommentMatchText(video, query) {
        const q = normalize(query);
        if (!q || !Array.isArray(video?.commentTexts)) return "";
        const text = video.commentTexts.find((item) => normalize(item).includes(q));
        if (text) return cleanCommentText(text);
        return "";
    }

    function cancelCommentSearch() {
        commentSearchToken++;
        commentSearchPending = false;
        if (commentSearchTimer) {
            window.clearTimeout(commentSearchTimer);
            commentSearchTimer = 0;
        }
        if (commentApplyTimer) {
            window.clearTimeout(commentApplyTimer);
            commentApplyTimer = 0;
        }
        abortController(activeCommentAbortController);
        activeCommentAbortController = null;
        setLoading(false, "comments");
    }

    function applyCommentSearchFilter() {
        if (commentApplyTimer) {
            window.clearTimeout(commentApplyTimer);
            commentApplyTimer = 0;
        }
        lastCommentApplyAt = performance.now();
        lastFilterKey = null;
        applyFilter();
        updateStatus();
    }

    function scheduleCommentSearchFilterApply({ force = false } = {}) {
        updateStatus();
        if (force) {
            applyCommentSearchFilter();
            return;
        }

        const now = performance.now();
        const remaining = INDEX_APPLY_INTERVAL_MS - (now - lastCommentApplyAt);
        if (remaining <= 0) {
            applyCommentSearchFilter();
            return;
        }
        if (commentApplyTimer) return;
        commentApplyTimer = window.setTimeout(applyCommentSearchFilter, remaining);
    }

    function shouldFetchCommentsForQuery(video, query) {
        if (!video || !query) return false;
        if (video.titleNorm.includes(query)) return false;
        if (video.commentFetched || video.commentLoading || video.commentActive === false) return false;
        return true;
    }

    function scheduleCommentSearch() {
        if (!isCommentSearchEnabled()) {
            cancelCommentSearch();
            return;
        }

        const query = normalize(currentQuery);
        if (!query) {
            cancelCommentSearch();
            return;
        }

        if (commentSearchTimer) window.clearTimeout(commentSearchTimer);
        const token = ++commentSearchToken;
        abortController(activeCommentAbortController);
        activeCommentAbortController = null;
        commentSearchTimer = window.setTimeout(() => {
            commentSearchTimer = 0;
            startCommentSearch(token);
        }, getCommentDelayMs());
    }

    function startCommentSearch(token) {
        if (commentSearchRunning) {
            commentSearchPending = true;
            return;
        }
        runCommentSearch(token).catch(() => {});
    }

    async function runCommentSearch(token) {
        commentSearchRunning = true;
        abortController(activeCommentAbortController);
        activeCommentAbortController = new AbortController();
        const signal = activeCommentAbortController.signal;
        setLoading(true, "comments");
        let fetchedCount = 0;

        try {
            while (
                token === commentSearchToken &&
                currentChannelId &&
                isCommentSearchEnabled() &&
                fetchedCount < getCommentMaxVideos()
            ) {
                const query = normalize(currentQuery);
                if (!query) break;

                const entry = getEntry();
                if (!entry) break;

                const remaining = getCommentMaxVideos() - fetchedCount;
                const targets = entry.videos
                    .filter((video) => shouldFetchCommentsForQuery(video, query))
                    .slice(0, remaining);

                if (!targets.length) {
                    if (entry.loading && !entry.complete) {
                        await sleep(250);
                        continue;
                    }
                    break;
                }

                for (let i = 0; i < targets.length; i += COMMENT_FETCH_CONCURRENCY) {
                    if (token !== commentSearchToken || !normalize(currentQuery)) return;
                    if (signal.aborted) return;
                    const batch = targets.slice(i, i + COMMENT_FETCH_CONCURRENCY);
                    await Promise.all(batch.map((video) => hydrateVideoComments(video, token, signal)));
                    fetchedCount += batch.length;
                    scheduleCommentSearchFilterApply();
                    if (fetchedCount >= getCommentMaxVideos()) break;
                }
            }
        } finally {
            if (token === commentSearchToken && normalize(currentQuery)) {
                scheduleCommentSearchFilterApply({ force: true });
            }
            if (activeCommentAbortController?.signal === signal) activeCommentAbortController = null;
            commentSearchRunning = false;
            setLoading(false, "comments");
            if ((commentSearchPending || token !== commentSearchToken) && normalize(currentQuery)) {
                commentSearchPending = false;
                startCommentSearch(commentSearchToken);
            }
        }
    }

    function updateStatus() {
        const bar = document.getElementById(BAR_ID);
        if (!bar) return;
        const status = bar.querySelector(".bcvs-status");
        if (!status) return;
        const entry = getEntry();
        if (!entry) {
            status.textContent = "";
            return;
        }
        const total = entry.videos.length;
        if (entry.error && !total) {
            status.textContent = `오류: ${entry.error}`;
            return;
        }
        if (!currentQuery) {
            status.textContent = entry.loading ? `${total}개 로딩중` : total ? `${total}개` : "";
            return;
        }
        const matches = filterVideosByNormalizedQuery(entry.videos, normalize(currentQuery));
        status.textContent = entry.complete
            ? `${matches.length} / ${total}`
            : entry.loading
              ? `${matches.length} / ${total} (로딩중)`
              : `${matches.length} / ${total}`;
    }

    function computePath(root, target) {
        const path = [];
        let node = target;
        while (node && node !== root) {
            const parent = node.parentElement;
            if (!parent) return null;
            const idx = Array.prototype.indexOf.call(parent.children, node);
            if (idx < 0) return null;
            path.unshift(idx);
            node = parent;
        }
        return node === root ? path : null;
    }

    function applyPath(root, path) {
        if (!path) return null;
        let node = root;
        for (const i of path) {
            if (!node || !node.children || !node.children[i]) return null;
            node = node.children[i];
        }
        return node;
    }

    function getLeafElements(root) {
        return Array.from(root.querySelectorAll("*")).filter((el) => el.children.length === 0);
    }

    function findElementByPredicate(root, predicate, { leafOnly = false } = {}) {
        let best = null;
        let bestChildCount = Infinity;

        for (const el of root.querySelectorAll("*")) {
            if (leafOnly && el.children.length > 0) continue;
            if (!predicate(normSpace(el.textContent || ""))) continue;
            if (leafOnly) return el;

            const childCount = el.children.length;
            if (childCount < bestChildCount) {
                best = el;
                bestChildCount = childCount;
                if (childCount === 0) break;
            }
        }

        return best;
    }

    function findElementByExactText(root, text) {
        const target = normSpace(text);
        if (!target) return null;
        return findElementByPredicate(root, (t) => t === target);
    }

    function findElementByContainsText(root, text) {
        const target = normSpace(text);
        if (!target) return null;
        return findElementByPredicate(root, (t) => {
            return t.length >= 5 && (t.includes(target) || target.includes(t));
        });
    }

    function findDurationLeaf(root) {
        return findElementByPredicate(root, (t) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(t), { leafOnly: true });
    }

    function findDateLeaf(root) {
        return findElementByPredicate(root, looksLikeDateText, { leafOnly: true });
    }

    function looksLikePlaybackStateText(text) {
        return /이어\s*보기|시청\s*중|재생\s*기록|보던\s*곳|남은\s*시간|%/.test(text);
    }

    function findViewCountElements(root, video) {
        const candidates = [];

        for (const el of getLeafElements(root)) {
            const text = normSpace(el.textContent || "");
            if (!text || looksLikePlaybackStateText(text)) continue;
            if (/(조회수|views?)/i.test(text) && /\d/.test(text)) candidates.push(el);
        }

        if (candidates.length) return candidates;

        if (!video || typeof video.readCount !== "number" || !Number.isFinite(video.readCount)) return [];
        const n = Math.max(0, Math.floor(video.readCount));
        const variants = [formatCountNumber(n), n.toLocaleString("ko-KR"), String(n)].map((v) => normalize(v));

        for (const el of getLeafElements(root)) {
            const raw = normSpace(el.textContent || "");
            if (!/(회|views?)/i.test(raw) || looksLikePlaybackStateText(raw)) continue;
            const text = normalize(raw);
            if (variants.some((v) => v && text.includes(v))) candidates.push(el);
        }

        return candidates;
    }

    function findViewCountElement(root, video) {
        return (
            findViewCountElements(root, video)[0] ||
            findElementByPredicate(root, (t) => {
                if (looksLikePlaybackStateText(t)) return false;
                if (!/(조회수|views?)/i.test(t) || !/\d/.test(t)) return false;
                const text = normalize(t);
                return !/\d+\s*(분|시간|일|주|개월|년)\s*전/.test(text);
            })
        );
    }

    function findLivePvElements(root) {
        return getLeafElements(root).filter((el) => {
            const text = normSpace(el.textContent || "");
            return /\d/.test(text) && /시청된\s*라이브/.test(text);
        });
    }

    function formatCountNumber(value) {
        const n = Math.max(0, Math.floor(value));
        return n.toLocaleString("ko-KR");
    }

    function trimDecimal(value) {
        const text = value.toFixed(1);
        return text.endsWith(".0") ? text.slice(0, -2) : text;
    }

    function formatLivePvNumber(value) {
        const n = Math.max(0, Math.floor(value));
        if (n >= 10000) return `${trimDecimal(Math.floor(n / 1000) / 10)}만`;
        return n.toLocaleString("ko-KR");
    }

    function formatReadCountText(readCount, fallbackText) {
        if (typeof readCount !== "number" || !Number.isFinite(readCount)) return "";
        const countText = formatCountNumber(readCount);
        const original = normSpace(fallbackText);
        if (/조회수/.test(original)) {
            const replaced = original.replace(/조회수\s*[\d,.]+(?:\s*회)?/, `조회수 ${countText}회`);
            return replaced === original ? `조회수 ${countText}회` : replaced;
        }
        if (/views?/i.test(original) && !/[가-힣]/.test(original)) {
            return original.replace(/[\d,.]+/, countText) || `${countText} views`;
        }
        return `조회수 ${countText}회`;
    }

    function formatLivePvText(livePv, fallbackText) {
        if (typeof livePv !== "number" || !Number.isFinite(livePv) || livePv < 10000) return "";
        const countText = formatLivePvNumber(livePv);
        const original = normSpace(fallbackText);
        if (/시청된\s*라이브/.test(original)) {
            const replaced = original.replace(
                /[\d,.]+(?:\.\d+)?\s*만?\s*회\s*시청된\s*라이브/,
                `${countText}회 시청된 라이브`
            );
            return replaced === original ? `${countText}회 시청된 라이브` : replaced;
        }
        return `${countText}회 시청된 라이브`;
    }

    function getNumber(value) {
        if (value === null || value === undefined || value === "") return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    function getObjectNumberByKeys(obj, keys, depth = 0) {
        if (!obj || typeof obj !== "object" || depth > 4) return null;
        const wanted = new Set(keys.map((k) => k.toLowerCase()));

        for (const [key, value] of Object.entries(obj)) {
            const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
            if (wanted.has(normalizedKey)) {
                const n = getNumber(value);
                if (n !== null) return n;
            }
        }

        for (const value of Object.values(obj)) {
            if (value && typeof value === "object") {
                const n = getObjectNumberByKeys(value, keys, depth + 1);
                if (n !== null) return n;
            }
        }

        return null;
    }

    function getWatchProgressRatio(watchTimeline, duration) {
        if (!watchTimeline) return null;

        const durationNumber = getNumber(duration);
        const ratioFromNumber = (value) => {
            const n = getNumber(value);
            if (n === null || n <= 0) return null;
            if (n <= 1) return Math.min(n, 1);
            if (n <= 100) return Math.min(n / 100, 1);
            if (durationNumber && durationNumber > 0) return Math.min(n / durationNumber, 1);
            return null;
        };

        if (typeof watchTimeline !== "object") return ratioFromNumber(watchTimeline);

        const ratio = getObjectNumberByKeys(watchTimeline, [
            "progress",
            "progressrate",
            "progressratio",
            "watchratio",
            "playedratio",
            "percent",
            "percentage",
        ]);
        const ratioValue = ratioFromNumber(ratio);
        if (ratioValue !== null) return ratioValue;

        const seconds = getObjectNumberByKeys(watchTimeline, [
            "watchtime",
            "watchsecond",
            "watchseconds",
            "lastwatchtime",
            "lastwatchsecond",
            "lastwatchseconds",
            "lastplaybacktime",
            "lastplaybacksecond",
            "lastplaybackseconds",
            "lastplaybackposition",
            "lastplaytime",
            "currenttime",
            "currentsecond",
            "currentseconds",
            "playtime",
            "playseconds",
            "position",
            "offset",
            "timeline",
        ]);

        if (seconds === null || !durationNumber || durationNumber <= 0) return null;
        return Math.min(seconds / durationNumber, 1);
    }

    function getPlaybackStateElements(card) {
        const progressSelector = [
            "progress",
            '[role="progressbar"]',
            "[aria-valuenow][aria-valuemax]",
            '[class*="progress" i]',
            '[class*="history" i]',
            '[class*="played" i]',
            '[class*="playback" i]',
            '[class*="resume" i]',
        ].join(",");

        const candidates = [];
        for (const el of card.querySelectorAll(progressSelector)) {
            if (!(el instanceof HTMLElement)) continue;
            if (el === card) continue;
            if (el.querySelector('a[href*="/video/"], img')) continue;
            candidates.push(el);
        }

        for (const el of card.querySelectorAll("*")) {
            if (!(el instanceof HTMLElement)) continue;
            if (el.querySelector('a[href*="/video/"], img')) continue;
            if (looksLikePlaybackStateText(normSpace(el.textContent || ""))) candidates.push(el);
        }

        return Array.from(new Set(candidates));
    }

    function removeClonedPlaybackState(card) {
        const candidates = getPlaybackStateElements(card);
        for (const el of candidates) {
            if (!(el instanceof HTMLElement)) continue;
            if (el === card) continue;

            el.removeAttribute("aria-valuenow");
            el.removeAttribute("aria-valuetext");
            el.removeAttribute("aria-valuemin");
            el.removeAttribute("aria-valuemax");

            el.remove();
        }
    }

    function capturePlaybackTemplates(root) {
        return getPlaybackStateElements(root)
            .map((el) => {
                const parent = el.parentElement;
                if (!parent) return null;
                return {
                    node: el.cloneNode(true),
                    parentPath: computePath(root, parent),
                    index: Array.prototype.indexOf.call(parent.children, el),
                };
            })
            .filter((item) => item && item.parentPath && item.index >= 0);
    }

    function updatePlaybackElementProgress(root, ratio) {
        const clampedRatio = Math.max(0, Math.min(1, ratio));
        const percent = Math.round(clampedRatio * 1000) / 10;

        const updateElement = (el) => {
            if (el instanceof HTMLProgressElement) {
                el.max = 100;
                el.value = percent;
            }

            if (el.hasAttribute("aria-valuenow") || el.getAttribute("role") === "progressbar") {
                el.setAttribute("aria-valuemin", "0");
                el.setAttribute("aria-valuemax", "100");
                el.setAttribute("aria-valuenow", String(percent));
                el.setAttribute("aria-valuetext", `${percent}%`);
            }

            const className = String(el.className || "");
            const style = el.getAttribute("style") || "";
            if (/progress|played|playback|resume|history/i.test(className) || /width\s*:|scaleX\(/i.test(style)) {
                if (/scaleX\(/i.test(style)) {
                    el.style.transform = `scaleX(${clampedRatio})`;
                } else {
                    el.style.width = `${percent}%`;
                }
            }
        };

        if (root instanceof HTMLElement) updateElement(root);
        for (const el of root.querySelectorAll("*")) {
            if (el instanceof HTMLElement) updateElement(el);
        }
    }

    function applyPlaybackProgress(card, tpl, video) {
        const ratio = getWatchProgressRatio(video.watchTimeline, video.duration) ?? video.progressRatio;
        if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0) return;

        const template = (tpl.playbackTemplates || []).find(
            (item) => !looksLikePlaybackStateText(normSpace(item.node.textContent || ""))
        );
        if (!template) return;

        const parent = applyPath(card, template.parentPath);
        if (!parent) return;

        const node = template.node.cloneNode(true);
        updatePlaybackElementProgress(node, ratio);
        const before = parent.children[template.index] || null;
        parent.insertBefore(node, before);
    }

    function captureTemplate() {
        if (cardTemplate && cardTemplate.node) return cardTemplate;
        if (!currentGrid) return null;
        const entry = getEntry();
        if (!entry || !entry.videos.length) return null;

        for (const child of currentGrid.children) {
            if (!(child instanceof HTMLElement)) continue;
            if (child.getAttribute(INJECTED_ATTR) === "1") continue;
            const link = child.querySelector('a[href*="/video/"]');
            const href = link?.getAttribute("href") || "";
            const videoNo = getVideoNoFromHref(href);
            if (!videoNo) continue;

            const tplVideo = entry.videos.find((v) => v.videoNo === videoNo);
            if (!tplVideo) continue;

            const cloned = child.cloneNode(true);

            const titleEl =
                findElementByExactText(cloned, tplVideo.title) || findElementByContainsText(cloned, tplVideo.title);
            const titlePath = titleEl ? computePath(cloned, titleEl) : null;

            const durEl = findDurationLeaf(cloned);
            const durPath = durEl ? computePath(cloned, durEl) : null;

            const dateEl = findDateLeaf(cloned);
            const datePath = dateEl ? computePath(cloned, dateEl) : null;

            const viewEls = findViewCountElements(cloned, tplVideo);
            const viewPaths = viewEls.map((el) => computePath(cloned, el)).filter(Boolean);
            const viewEl = viewEls[0] || findViewCountElement(cloned, tplVideo);
            const viewPath = viewEl ? computePath(cloned, viewEl) : null;
            const livePvPaths = findLivePvElements(cloned)
                .map((el) => computePath(cloned, el))
                .filter(Boolean);
            const playbackTemplates = capturePlaybackTemplates(cloned);

            cardTemplate = {
                node: cloned,
                tplVideo,
                titlePath,
                durPath,
                datePath,
                livePvPaths,
                viewPaths,
                viewPath,
                playbackTemplates,
            };
            return cardTemplate;
        }
        return null;
    }

    function formatDuration(sec) {
        if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return "";
        const s = Math.floor(sec);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        const pad = (n) => String(n).padStart(2, "0");
        return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
    }

    function formatDate(iso) {
        if (!iso) return "";
        const raw = String(iso).trim();
        const direct = raw.match(/(\d{2}|\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
        if (direct) {
            const y = direct[1].slice(-2);
            const m = String(direct[2]).padStart(2, "0");
            const day = String(direct[3]).padStart(2, "0");
            return `${y}.${m}.${day}`;
        }

        const dateValue = typeof iso === "number" || /^\d{11,}$/.test(raw) ? Number(raw) : raw.replace(" ", "T");
        const d = new Date(dateValue);
        if (Number.isNaN(d.getTime())) return raw;
        const y = String(d.getFullYear()).slice(-2);
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}.${m}.${day}`;
    }

    function looksLikeDateText(text) {
        const t = String(text || "").trim();
        const absolute = t.match(/^(?:(\d{2}|\d{4})[.\-/])?(\d{1,2})[.\-/](\d{1,2})$/);
        if (absolute) {
            const hasYear = Boolean(absolute[1]);
            const month = Number(absolute[2]);
            const day = Number(absolute[3]);
            if (!hasYear && !/^\d{2}[.\-/]\d{2}$/.test(t)) return false;
            return month >= 1 && month <= 12 && day >= 1 && day <= 31;
        }
        return /^\d+\s*(?:\uBD84|\uC2DC\uAC04|\uC77C|\uC8FC|\uAC1C\uC6D4|\uB144)\s*\uC804$/.test(t);
    }

    function clearCommentTooltipClose() {
        if (!commentTooltipHideTimer) return;
        window.clearTimeout(commentTooltipHideTimer);
        commentTooltipHideTimer = 0;
    }

    function hideCommentTooltip() {
        clearCommentTooltipClose();
        if (activeCommentTooltipIcon) {
            activeCommentTooltipIcon.removeAttribute("data-active");
            activeCommentTooltipIcon.setAttribute("aria-expanded", "false");
        }
        if (commentTooltip) {
            commentTooltip.removeAttribute("data-show");
            commentTooltip.style.visibility = "";
        }
        activeCommentTooltipIcon = null;
    }

    function scheduleCommentTooltipClose() {
        clearCommentTooltipClose();
        commentTooltipHideTimer = window.setTimeout(hideCommentTooltip, 650);
    }

    function handleCommentTooltipScroll() {
        if (activeCommentTooltipIcon?.isConnected) positionCommentTooltip(activeCommentTooltipIcon);
        else hideCommentTooltip();
    }

    function handleCommentTooltipResize() {
        scheduleCommentIconAlign();
    }

    function installCommentTooltipListeners() {
        if (commentTooltipListenersInstalled) return;
        commentTooltipListenersInstalled = true;
        window.addEventListener("scroll", handleCommentTooltipScroll, true);
        window.addEventListener("resize", handleCommentTooltipResize);
        document.addEventListener("pointermove", handleCommentTooltipPointerMove, true);
        document.addEventListener("pointerdown", handleCommentTooltipPointerDown, true);
    }

    function uninstallCommentTooltipListeners() {
        if (!commentTooltipListenersInstalled) return;
        commentTooltipListenersInstalled = false;
        window.removeEventListener("scroll", handleCommentTooltipScroll, true);
        window.removeEventListener("resize", handleCommentTooltipResize);
        document.removeEventListener("pointermove", handleCommentTooltipPointerMove, true);
        document.removeEventListener("pointerdown", handleCommentTooltipPointerDown, true);
    }

    function removeCommentTooltip() {
        hideCommentTooltip();
        if (commentTooltip) commentTooltip.remove();
        commentTooltip = null;
        uninstallCommentTooltipListeners();
    }

    function getOpenCommentTooltipState() {
        if (!activeCommentTooltipIcon || commentTooltip?.getAttribute("data-show") !== "1") return null;
        return {
            videoNo: activeCommentTooltipIcon.getAttribute(COMMENT_VIDEO_ATTR) || "",
            text: activeCommentTooltipIcon.__bcvsCommentText || "",
            query: activeCommentTooltipIcon.__bcvsCommentQuery || currentQuery,
        };
    }

    function isPointInRect(x, y, rect, padding = 0) {
        return (
            x >= rect.left - padding &&
            x <= rect.right + padding &&
            y >= rect.top - padding &&
            y <= rect.bottom + padding
        );
    }

    function isPointerInCommentSurface(e) {
        if (!activeCommentTooltipIcon || !commentTooltip?.getAttribute("data-show")) return false;
        if (performance.now() - commentTooltipOpenedAt < 800) return true;
        const iconRect = activeCommentTooltipIcon.getBoundingClientRect();
        const tooltipRect = commentTooltip.getBoundingClientRect();
        const bridgeRect = {
            left: Math.min(iconRect.left, tooltipRect.left),
            right: Math.max(iconRect.right, tooltipRect.right),
            top: Math.min(iconRect.top, tooltipRect.top),
            bottom: Math.max(iconRect.bottom, tooltipRect.bottom),
        };
        return (
            isPointInRect(e.clientX, e.clientY, iconRect, 6) ||
            isPointInRect(e.clientX, e.clientY, tooltipRect, 6) ||
            isPointInRect(e.clientX, e.clientY, bridgeRect, 10)
        );
    }

    function handleCommentTooltipPointerMove(e) {
        if (!activeCommentTooltipIcon) return;
        if (isPointerInCommentSurface(e)) {
            clearCommentTooltipClose();
        } else {
            scheduleCommentTooltipClose();
        }
    }

    function handleCommentTooltipPointerDown(e) {
        if (!activeCommentTooltipIcon) return;
        if (
            e.target instanceof Node &&
            (activeCommentTooltipIcon.contains(e.target) || commentTooltip?.contains(e.target))
        ) {
            return;
        }
        hideCommentTooltip();
    }

    function positionCommentTooltip(anchor) {
        if (!commentTooltip || !anchor?.isConnected) return;

        const margin = 8;
        const gap = 4;
        const maxWidth = Math.max(160, Math.min(460, window.innerWidth - margin * 2));

        commentTooltip.style.maxWidth = `${maxWidth}px`;
        commentTooltip.style.left = "0px";
        commentTooltip.style.top = "0px";
        commentTooltip.style.visibility = "hidden";
        commentTooltip.setAttribute("data-show", "1");

        const anchorRect = anchor.getBoundingClientRect();
        const tipRect = commentTooltip.getBoundingClientRect();
        const maxLeft = Math.max(margin, window.innerWidth - tipRect.width - margin);
        const left = Math.min(Math.max(margin, anchorRect.right - tipRect.width), maxLeft);
        let top = anchorRect.top - tipRect.height - gap;

        if (top < margin) top = anchorRect.bottom + gap;
        if (top + tipRect.height > window.innerHeight - margin) {
            top = Math.max(margin, window.innerHeight - tipRect.height - margin);
        }

        commentTooltip.style.left = `${Math.round(left)}px`;
        commentTooltip.style.top = `${Math.round(top)}px`;
        commentTooltip.style.visibility = "";
    }

    function getCommentTooltip() {
        if (commentTooltip?.isConnected) return commentTooltip;

        const tooltip = document.createElement("div");
        tooltip.className = "bcvs-comment-tooltip";
        tooltip.setAttribute(COMMENT_TOOLTIP_ATTR, "1");
        document.body.appendChild(tooltip);
        commentTooltip = tooltip;
        installCommentTooltipListeners();

        return tooltip;
    }

    function renderCommentTooltipText(tooltip, text, query) {
        tooltip.replaceChildren();
        const q = normalize(query);
        const lines = String(text || "")
            .replace(/\r\n?/g, "\n")
            .split("\n");

        for (const line of lines) {
            const lineEl = document.createElement("span");
            lineEl.className = "bcvs-comment-tooltip-line";
            if (q && normalize(line).includes(q)) {
                lineEl.setAttribute("data-hit", "1");
            }
            lineEl.textContent = line;
            tooltip.appendChild(lineEl);
        }
    }

    function scrollCommentTooltipToHit(tooltip) {
        const hit = tooltip.querySelector('.bcvs-comment-tooltip-line[data-hit="1"]');
        if (!(hit instanceof HTMLElement)) {
            tooltip.scrollTop = 0;
            return;
        }

        const targetTop = hit.offsetTop - Math.max(0, (tooltip.clientHeight - hit.offsetHeight) / 2);
        tooltip.scrollTop = Math.max(0, targetTop);
    }

    function showCommentTooltip(anchor, text, query) {
        if (!text) {
            hideCommentTooltip();
            return;
        }
        clearCommentTooltipClose();
        if (activeCommentTooltipIcon && activeCommentTooltipIcon !== anchor) {
            activeCommentTooltipIcon.removeAttribute("data-active");
            activeCommentTooltipIcon.setAttribute("aria-expanded", "false");
        }
        const tooltip = getCommentTooltip();
        renderCommentTooltipText(tooltip, text, query);
        activeCommentTooltipIcon = anchor;
        commentTooltipOpenedAt = performance.now();
        anchor.setAttribute("data-active", "1");
        anchor.setAttribute("aria-expanded", "true");
        positionCommentTooltip(anchor);
        scrollCommentTooltipToHit(tooltip);
    }

    function restoreCommentTooltipState(state) {
        if (!state?.videoNo || !currentGrid?.isConnected) return;
        let icon = null;
        for (const el of currentGrid.querySelectorAll(`[${COMMENT_ICON_ATTR}="1"]`)) {
            if (el.getAttribute(COMMENT_VIDEO_ATTR) !== state.videoNo) continue;
            icon = el;
            break;
        }
        if (!(icon instanceof HTMLElement)) {
            hideCommentTooltip();
            return;
        }
        showCommentTooltip(
            icon,
            icon.__bcvsCommentText || state.text || "",
            icon.__bcvsCommentQuery || state.query || currentQuery
        );
    }

    function toggleCommentTooltip(anchor, text, query) {
        if (activeCommentTooltipIcon === anchor && commentTooltip?.getAttribute("data-show") === "1") {
            hideCommentTooltip();
            return;
        }
        showCommentTooltip(anchor, text, query);
    }

    function getCommentTagLineBottom(card, icon) {
        let imageBottom = 0;
        for (const img of card.querySelectorAll("img")) {
            const bottom = img.getBoundingClientRect().bottom;
            if (Number.isFinite(bottom)) imageBottom = Math.max(imageBottom, bottom);
        }
        const titleText = normSpace(card.querySelector('a[href*="/video/"]')?.getAttribute("aria-label") || "");
        let bottom = 0;

        for (const el of card.querySelectorAll("button, a, span, div")) {
            if (!(el instanceof HTMLElement)) continue;
            if (el === icon || el.closest(`[${COMMENT_ICON_ATTR}="1"]`)) continue;
            if (el.querySelector("img")) continue;

            const text = normSpace(el.textContent || "");
            if (!text || text.length > 24) continue;
            if (titleText && text === titleText) continue;
            if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(text)) continue;
            if (/^\d+(?:\.\d+)?\s*만?회/.test(text) || text.includes("\uC870\uD68C\uC218")) continue;
            if (looksLikeDateText(text)) continue;

            const rect = el.getBoundingClientRect();
            if (rect.width < 12 || rect.width > 120 || rect.height < 14 || rect.height > 34) continue;
            if (imageBottom && rect.top < imageBottom + 18) continue;

            bottom = Math.max(bottom, rect.bottom);
        }

        return bottom;
    }

    function alignCommentIconsToTagRows() {
        if (!currentGrid?.isConnected) return;
        const updates = [];
        for (const card of currentGrid.querySelectorAll(`[${INJECTED_ATTR}="1"]`)) {
            if (!(card instanceof HTMLElement)) continue;
            const icon = card.querySelector(`[${COMMENT_ICON_ATTR}="1"]`);
            if (!(icon instanceof HTMLElement)) continue;

            const tagBottom = getCommentTagLineBottom(card, icon);
            if (!tagBottom) {
                updates.push({ icon, top: null });
                continue;
            }

            const cardRect = card.getBoundingClientRect();
            const iconHeight = icon.getBoundingClientRect().height || 30;
            updates.push({ icon, top: Math.round(tagBottom - cardRect.top - iconHeight) });
        }
        for (const { icon, top } of updates) {
            if (top === null) {
                icon.style.removeProperty("top");
                icon.style.setProperty("bottom", "0px", "important");
            } else {
                icon.style.setProperty("top", `${top}px`, "important");
                icon.style.setProperty("bottom", "auto", "important");
            }
        }
        if (activeCommentTooltipIcon?.isConnected) positionCommentTooltip(activeCommentTooltipIcon);
    }

    function scheduleCommentIconAlign() {
        if (commentAlignFrame) return;
        commentAlignFrame = requestAnimationFrame(() => {
            commentAlignFrame = 0;
            alignCommentIconsToTagRows();
            if (!activeCommentTooltipIcon?.isConnected) hideCommentTooltip();
        });
    }

    function attachCommentMatch(card, video) {
        if (!isCommentSearchEnabled()) return;
        const commentText = getCommentMatchText(video, currentQuery);
        if (!commentText) return;

        card.classList.add("bcvs-comment-card");
        const icon = document.createElement("span");
        icon.className = "bcvs-comment-hit";
        icon.setAttribute(COMMENT_ICON_ATTR, "1");
        icon.setAttribute(COMMENT_VIDEO_ATTR, video.videoNo);
        icon.setAttribute("aria-label", "\uB9E4\uCE6D\uB41C \uB313\uAE00 \uBCF4\uAE30");
        icon.setAttribute("role", "button");
        icon.setAttribute("aria-expanded", "false");
        icon.tabIndex = 0;
        icon.innerHTML = `
<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path d="M7.25 5.25h9.5A3.25 3.25 0 0 1 20 8.5v3a3.25 3.25 0 0 1-3.25 3.25h-4.3L8.2 17.9A.75.75 0 0 1 7 17.3v-2.6a3.25 3.25 0 0 1-3-3.2v-3a3.25 3.25 0 0 1 3.25-3.25Z" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M8.45 9.2h7.1M8.45 11.85h4.9" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"/>
</svg>
`;
        const tooltipText = commentText;
        icon.__bcvsCommentText = tooltipText;
        icon.__bcvsCommentQuery = currentQuery;
        icon.addEventListener("pointerdown", (e) => {
            e.stopPropagation();
        });
        icon.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleCommentTooltip(icon, tooltipText, currentQuery);
        });
        icon.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                toggleCommentTooltip(icon, tooltipText, currentQuery);
            } else if (e.key === "Escape") {
                hideCommentTooltip();
            }
        });
        card.appendChild(icon);
    }

    function buildInjectedCard(video) {
        const tpl = captureTemplate();
        if (!tpl) return null;
        const card = tpl.node.cloneNode(true);
        card.setAttribute(INJECTED_ATTR, "1");

        for (const a of card.querySelectorAll("a")) {
            const href = a.getAttribute("href") || "";
            if (/\/video\/\d+/.test(href)) {
                a.setAttribute("href", href.replace(/\/video\/\d+/, `/video/${video.videoNo}`));
            }
            if (a.hasAttribute("aria-label")) a.setAttribute("aria-label", video.title);
            if (a.hasAttribute("title")) a.setAttribute("title", video.title);
        }

        for (const img of card.querySelectorAll("img")) {
            if (video.thumb) {
                img.setAttribute("src", video.thumb);
                img.removeAttribute("srcset");
                img.setAttribute("alt", video.title);
            }
        }

        if (video.thumb) {
            for (const source of card.querySelectorAll("source")) {
                source.removeAttribute("srcset");
            }
        }

        const titleEl = applyPath(card, tpl.titlePath);
        if (titleEl) titleEl.textContent = video.title;

        const durEl = applyPath(card, tpl.durPath);
        if (durEl && typeof video.duration === "number") {
            const formatted = formatDuration(video.duration);
            if (formatted) durEl.textContent = formatted;
        }

        const dateEl =
            applyPath(card, tpl.datePath) || findElementByPredicate(card, looksLikeDateText, { leafOnly: true });
        if (dateEl && video.publishDate) {
            const formatted = formatDate(video.publishDate);
            if (formatted) dateEl.textContent = formatted;
        }

        const viewPaths = tpl.viewPaths?.length ? tpl.viewPaths : tpl.viewPath ? [tpl.viewPath] : [];
        for (const viewPath of viewPaths) {
            const viewEl = applyPath(card, viewPath);
            if (!viewEl) continue;
            const readCountText = formatReadCountText(video.readCount, viewEl.textContent);
            if (readCountText) {
                viewEl.textContent = readCountText;
                viewEl.style.visibility = "";
            } else {
                viewEl.textContent = "";
                viewEl.style.visibility = "hidden";
            }
        }

        for (const livePvPath of tpl.livePvPaths || []) {
            const livePvEl = applyPath(card, livePvPath);
            if (!livePvEl) continue;
            const livePvText = formatLivePvText(video.livePv, livePvEl.textContent);
            if (livePvText) {
                livePvEl.textContent = livePvText;
            } else {
                livePvEl.remove();
            }
        }

        attachCommentMatch(card, video);
        removeClonedPlaybackState(card);
        applyPlaybackProgress(card, tpl, video);
        return card;
    }

    function clearInjectedCards({ preserveCommentTooltip = false } = {}) {
        if (!currentGrid) return;
        if (!preserveCommentTooltip) hideCommentTooltip();
        for (const c of currentGrid.querySelectorAll(`[${INJECTED_ATTR}="1"], [${LOAD_MORE_ATTR}="1"]`)) {
            c.remove();
        }
    }

    function buildLoadMoreControl(remaining) {
        const wrap = document.createElement("div");
        wrap.setAttribute(LOAD_MORE_ATTR, "1");

        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `더 보기 (${remaining}개 남음)`;
        button.addEventListener("click", () => {
            visibleMatchLimit += getRenderBatchSize();
            lastFilterKey = null;
            applyFilter();
            updateStatus();
        });

        wrap.appendChild(button);
        return wrap;
    }

    function findPagination() {
        if (!currentGrid) return null;
        const root = currentGrid.parentElement?.parentElement || currentGrid.parentElement || document.body;

        const byClass = root.querySelector(
            '[class*="pagination" i], [class*="Pagination"], [class*="paging" i], [class*="Paging"], [class*="paginator" i], nav[aria-label*="페이지"]'
        );
        if (byClass && !byClass.contains(document.getElementById(BAR_ID))) return byClass;

        const buttons = Array.from(root.querySelectorAll("button, a"));
        for (const b of buttons) {
            const t = (b.textContent || "").trim();
            const aria = b.getAttribute("aria-label") || "";
            if (/다음 페이지|이전 페이지|next page|prev/i.test(aria) || /^(이전|다음|<|>)$/.test(t)) {
                let p = b.parentElement;
                let depth = 0;
                while (p && p !== root && depth < 5) {
                    const siblings = p.querySelectorAll("button, a");
                    if (siblings.length >= 3) return p;
                    p = p.parentElement;
                    depth++;
                }
            }
        }
        return null;
    }

    function setPaginationHidden(hidden) {
        const pag = findPagination();
        if (!pag) return;
        if (hidden) pag.setAttribute(HIDE_ATTR, "1");
        else pag.removeAttribute(HIDE_ATTR);
    }

    function applyFilter() {
        if (!currentGrid || !currentGrid.isConnected) return;

        const entry = getEntry();

        if (!entry || !currentQuery) {
            clearInjectedCards();
            for (const child of currentGrid.children) {
                if (child instanceof HTMLElement) child.removeAttribute(HIDE_ATTR);
            }
            setPaginationHidden(false);
            lastFilterKey = "off";
            return;
        }

        setPaginationHidden(true);
        const normalizedQuery = normalize(currentQuery);

        const tpl = captureTemplate();
        if (!tpl) {
            setPaginationHidden(false);
            return;
        }

        const matches = filterVideosByNormalizedQuery(entry.videos, normalizedQuery);
        const renderedMatches = matches.slice(0, visibleMatchLimit);
        const remainingMatches = Math.max(0, matches.length - renderedMatches.length);
        const stateKey = !entry || entry.videos.length === 0 ? "loading" : entry.complete ? "done" : "partial";
        const expected = matches
            .map((v) => {
                const commentCount = Array.isArray(v.commentTexts) ? v.commentTexts.length : 0;
                const commentHit = hasCommentMatchNorm(v, normalizedQuery) ? "c" : "t";
                return `${v.videoNo}:${commentHit}:${v.commentFetched ? 1 : 0}:${commentCount}`;
            })
            .join(",");
        const key = `on|${stateKey}|${visibleMatchLimit}|${expected}`;

        const existingInjected = currentGrid.querySelectorAll(`[${INJECTED_ATTR}="1"]`);
        if (key === lastFilterKey && existingInjected.length === renderedMatches.length) {
            for (const child of currentGrid.children) {
                if (!(child instanceof HTMLElement)) continue;
                if (child.getAttribute(INJECTED_ATTR) === "1") continue;
                if (child.getAttribute(LOAD_MORE_ATTR) === "1") continue;
                child.setAttribute(HIDE_ATTR, "1");
            }
            return;
        }
        lastFilterKey = key;

        const openCommentTooltipState = getOpenCommentTooltipState();
        clearInjectedCards({ preserveCommentTooltip: Boolean(openCommentTooltipState) });

        for (const child of currentGrid.children) {
            if (!(child instanceof HTMLElement)) continue;
            child.setAttribute(HIDE_ATTR, "1");
        }

        if (!matches.length) return;

        const fragment = document.createDocumentFragment();
        for (const video of renderedMatches) {
            const card = buildInjectedCard(video);
            if (card) fragment.appendChild(card);
        }
        if (remainingMatches > 0) {
            fragment.appendChild(buildLoadMoreControl(remainingMatches));
        }
        currentGrid.insertBefore(fragment, currentGrid.firstChild);
        const afterRender = () => {
            alignCommentIconsToTagRows();
            restoreCommentTooltipState(openCommentTooltipState);
        };
        requestAnimationFrame(afterRender);
        window.setTimeout(afterRender, 120);
    }

    function buildBar() {
        injectStyleOnce();

        const bar = document.createElement("div");
        bar.id = BAR_ID;
        bar.setAttribute("data-loading", "0");
        bar.innerHTML = `
<div class="bcvs-input-wrap">
  <svg class="bcvs-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M10 4a6 6 0 1 0 3.74 10.7l4.28 4.29 1.42-1.42-4.29-4.28A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/>
  </svg>
  <input type="search" placeholder="이 채널의 영상 제목 검색" autocomplete="off" spellcheck="false" />
  <button type="button" class="bcvs-clear" aria-label="지우기" tabindex="-1">
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M18.3 5.71 12 12.01l-6.3-6.3-1.41 1.41 6.3 6.3-6.3 6.3 1.41 1.41 6.3-6.3 6.3 6.3 1.41-1.41-6.3-6.3 6.3-6.3z"/>
    </svg>
  </button>
</div>
<span class="bcvs-meter">
  <span class="bcvs-spinner" aria-hidden="true"></span>
  <span class="bcvs-status" aria-live="polite"></span>
</span>
`;

        const input = bar.querySelector("input");
        const clearBtn = bar.querySelector(".bcvs-clear");

        const setQuery = (val) => {
            const prevNorm = normalize(currentQuery);
            const nextNorm = normalize(val);
            if (prevNorm !== nextNorm) {
                visibleMatchLimit = getRenderBatchSize();
                lastFilterKey = null;
            }
            currentQuery = val;
            bar.setAttribute("data-has-query", val ? "1" : "0");
            if (!nextNorm) {
                stopActiveFetch();
            } else {
                const entry = getEntry();
                if (currentChannelId && shouldStartIndexBuild(entry)) {
                    buildIndex(currentChannelId);
                }
                scheduleCommentSearch();
            }
            applyFilter();
            updateStatus();
        };

        input.addEventListener("input", () => setQuery(input.value));

        clearBtn.addEventListener("click", () => {
            input.value = "";
            setQuery("");
            input.focus();
        });

        input.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && currentQuery) {
                input.value = "";
                setQuery("");
            }
        });

        return bar;
    }

    function findFilterPillGroup() {
        if (filterPillGroupCache?.isConnected) return filterPillGroupCache;
        filterPillGroupCache = null;

        const labels = ["전체", "지난 방송", "업로드한 영상"];
        const candidates = Array.from(document.querySelectorAll("button, a, span, div")).filter((el) => {
            const t = (el.textContent || "").trim();
            return labels.includes(t);
        });
        if (candidates.length < 2) return null;

        const counts = new Map();
        for (const el of candidates) {
            let p = el.parentElement;
            let depth = 0;
            while (p && depth < 6) {
                counts.set(p, (counts.get(p) || 0) + 1);
                p = p.parentElement;
                depth++;
            }
        }

        let best = null;
        let bestCount = 0;
        for (const [el, count] of counts) {
            if (count <= bestCount) continue;
            if ((el.children?.length || 0) < 2) continue;
            best = el;
            bestCount = count;
        }
        filterPillGroupCache = best;
        return filterPillGroupCache;
    }

    function parseCssRgb(value) {
        const m = String(value || "").match(/rgba?\(([^)]+)\)/i);
        if (!m) return null;
        const parts = m[1].split(",").map((v) => Number.parseFloat(v));
        if (parts.length < 3 || parts.some((n, i) => i < 3 && !Number.isFinite(n))) return null;
        return {
            r: parts[0],
            g: parts[1],
            b: parts[2],
            a: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1,
        };
    }

    function isTransparentColor(value) {
        const rgb = parseCssRgb(value);
        return !rgb || rgb.a === 0;
    }

    function isDarkColor(value) {
        const rgb = parseCssRgb(value);
        if (!rgb) return false;
        return rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114 < 96;
    }

    function getVisibleControls(root) {
        if (!root) return [];
        return Array.from(root.querySelectorAll("button, a")).filter((el) => {
            if (!(el instanceof HTMLElement)) return false;
            if (el.closest(`#${BAR_ID}`)) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });
    }

    function syncBarWithHostUi(bar, host) {
        if (!bar || !host) return;
        const controls = getVisibleControls(host);
        if (!controls.length) return;

        const fontSource = controls[0];
        const fontStyle = getComputedStyle(fontSource);
        bar.style.setProperty("--bcvs-font-family", fontStyle.fontFamily);
        bar.style.setProperty("--bcvs-font-size", fontStyle.fontSize);
        bar.style.setProperty("--bcvs-font-weight", fontStyle.fontWeight);
        bar.style.setProperty("--bcvs-line-height", fontStyle.lineHeight);

        const styleSource =
            controls.find((el) => {
                const cs = getComputedStyle(el);
                return !isTransparentColor(cs.backgroundColor) && !isDarkColor(cs.color);
            }) || controls.find((el) => !isTransparentColor(getComputedStyle(el).backgroundColor));

        if (!styleSource) return;

        const cs = getComputedStyle(styleSource);
        const rect = styleSource.getBoundingClientRect();
        if (rect.height > 0) bar.style.setProperty("--bcvs-height", `${Math.round(rect.height)}px`);
        if (cs.borderRadius) bar.style.setProperty("--bcvs-radius", cs.borderRadius);
        if (!isTransparentColor(cs.backgroundColor)) {
            bar.style.setProperty("--bcvs-bg", cs.backgroundColor);
            // hover/focus 반전색은 CSS의 치지직 토큰(--Surface-Neutral-Strongest 등)이
            // 테마에 맞게 처리하므로 여기서 덮어쓰지 않는다.
        }
        if (cs.borderColor) bar.style.setProperty("--bcvs-border", cs.borderColor);
        if (cs.color) bar.style.setProperty("--bcvs-text", cs.color);
    }

    function ensureBarMounted() {
        if (!isFeatureEnabled()) {
            removeBar();
            return;
        }

        if (!isVideosTab()) {
            removeBar();
            return;
        }

        const channelId = getChannelIdFromUrl();
        if (!channelId) return;

        const grid = findGrid();
        if (!grid) return;
        grid.setAttribute(GRID_MARK_ATTR, "1");
        const gridChanged = currentGrid !== grid;
        currentGrid = grid;
        if (gridChanged) {
            cardTemplate = null;
            lastFilterKey = null;
        }

        let bar = document.getElementById(BAR_ID);
        if (!bar) {
            bar = buildBar();
        }

        const pillGroup = findFilterPillGroup();
        if (pillGroup) {
            bar.setAttribute("data-mode", "inline");
            syncBarWithHostUi(bar, pillGroup);
            if (bar.parentElement !== pillGroup) {
                pillGroup.appendChild(bar);
            }
        } else {
            bar.setAttribute("data-mode", "block");
            const desiredParent = grid.parentElement || grid;
            if (bar.parentElement !== desiredParent || bar.nextSibling !== grid) {
                desiredParent.insertBefore(bar, grid);
            }
        }

        if (currentChannelId !== channelId) {
            currentChannelId = channelId;
            currentQuery = "";
            visibleMatchLimit = getRenderBatchSize();
            const input = bar.querySelector("input");
            if (input) input.value = "";
            bar.removeAttribute("data-has-query");
            stopActiveFetch();
            applyFilter();
            updateStatus();
        } else if (gridChanged || currentQuery) {
            applyFilter();
            updateStatus();
        }
    }

    function removeBar() {
        removeCommentTooltip();
        const bar = document.getElementById(BAR_ID);
        if (bar) bar.remove();
        document.querySelectorAll(`[${INJECTED_ATTR}="1"]`).forEach((el) => el.remove());
        document.querySelectorAll(`[${HIDE_ATTR}="1"]`).forEach((el) => el.removeAttribute(HIDE_ATTR));
        document.querySelectorAll(`[${GRID_MARK_ATTR}="1"]`).forEach((el) => el.removeAttribute(GRID_MARK_ATTR));
        document.querySelectorAll(`[${CARD_MARK_ATTR}="1"]`).forEach((el) => el.removeAttribute(CARD_MARK_ATTR));
        currentQuery = "";
        visibleMatchLimit = getRenderBatchSize();
        currentChannelId = null;
        currentGrid = null;
        cardTemplate = null;
        filterPillGroupCache = null;
        lastFilterKey = null;
        activeFetchToken++;
        cancelCommentSearch();
    }

    function isOurNode(node) {
        if (!node || node.nodeType !== 1) return false;
        if (node.id === BAR_ID) return true;
        if (node.getAttribute && node.getAttribute(INJECTED_ATTR) === "1") return true;
        if (node.getAttribute && node.getAttribute(LOAD_MORE_ATTR) === "1") return true;
        if (node.getAttribute && node.getAttribute(COMMENT_ICON_ATTR) === "1") return true;
        if (node.getAttribute && node.getAttribute(COMMENT_TOOLTIP_ATTR) === "1") return true;
        if (node.getAttribute && node.getAttribute(COMMENT_VIDEO_ATTR)) return true;
        if (typeof node.closest === "function") {
            if (node.closest(`#${BAR_ID}`)) return true;
            if (node.closest(`[${INJECTED_ATTR}="1"]`)) return true;
            if (node.closest(`[${LOAD_MORE_ATTR}="1"]`)) return true;
            if (node.closest(`[${COMMENT_ICON_ATTR}="1"]`)) return true;
            if (node.closest(`[${COMMENT_TOOLTIP_ATTR}="1"]`)) return true;
            if (node.closest(`[${COMMENT_VIDEO_ATTR}]`)) return true;
        }
        return false;
    }

    function isIgnorableMutationNode(node) {
        return node.nodeType !== 1 || isOurNode(node);
    }

    function isOurMutation(m) {
        if (isOurNode(m.target)) return true;
        const added = m.addedNodes || [];
        const removed = m.removedNodes || [];
        if (!added.length && !removed.length) {
            if (
                m.type === "attributes" &&
                (m.attributeName === HIDE_ATTR ||
                    m.attributeName === CARD_MARK_ATTR ||
                    m.attributeName === INJECTED_ATTR ||
                    m.attributeName === LOAD_MORE_ATTR)
            ) {
                return true;
            }
            return false;
        }
        for (const n of added) {
            if (!isIgnorableMutationNode(n)) return false;
        }
        for (const n of removed) {
            if (!isIgnorableMutationNode(n)) return false;
        }
        return true;
    }

    function runScheduledMount() {
        if (!isFeatureEnabled() || !isVideosTab()) {
            removeBarIfMounted();
            return;
        }
        ensureBarMounted();
    }

    function schedule() {
        if (!isFeatureEnabled()) {
            removeBarIfMounted();
            return;
        }
        if (!isVideosTab()) {
            removeBarIfMounted();
            return;
        }
        scheduleThrottledMount();
    }

    function startObserver() {
        if (observer) return;
        let urlChanged = false;
        observer = createMutationObserverSync({
            target: () => document.body || document.documentElement,
            options: { childList: true, subtree: true },
            onMutations: () => {
                urlChanged = location.href !== lastUrl;
                if (urlChanged) {
                    lastUrl = location.href;
                    const newChannel = getChannelIdFromUrl();
                    if (newChannel !== currentChannelId) removeBar();
                }
            },
            shouldIgnoreMutations: (mutations) => !urlChanged && (!isVideosTab() || mutations.every(isOurMutation)),
            shouldSchedule: () => {
                if (!isFeatureEnabled() || !isVideosTab()) {
                    if (urlChanged) removeBarIfMounted();
                    return false;
                }
                return true;
            },
            schedule,
        });
    }

    function removeCommentSurfaces() {
        if (commentAlignFrame) {
            cancelAnimationFrame(commentAlignFrame);
            commentAlignFrame = 0;
        }
        removeCommentTooltip();
        document.querySelectorAll(`[${COMMENT_ICON_ATTR}="1"]`).forEach((el) => el.remove());
    }

    function stopObserver() {
        if (!observer) return;
        observer.disconnectAll?.();
        observer.disconnect();
        observer = null;
    }

    function installRouteListeners() {
        if (routeListenersInstalled) return;
        routeListenersInstalled = true;
        removePageChangeDetection = startPageChangeDetection(schedule);
    }

    function uninstallRouteListeners() {
        if (!routeListenersInstalled) return;
        routeListenersInstalled = false;
        if (removePageChangeDetection) {
            removePageChangeDetection();
            removePageChangeDetection = null;
        }
    }

    function installRuntime() {
        if (runtimeInstalled) return;
        runtimeInstalled = true;
        startObserver();
        installRouteListeners();
        schedule();
    }

    function teardownRuntime() {
        runtimeInstalled = false;
        stopActiveFetch();
        removeBarIfMounted();
        removeCommentTooltip();
        stopObserver();
        uninstallRouteListeners();
    }

    function applyOptions(options) {
        const wasEnabled = isFeatureEnabled();
        const wasCommentEnabled = isCommentSearchEnabled();
        const previousOptions = featureOptions;
        featureOptions = options;

        if (!isFeatureEnabled()) {
            teardownRuntime();
            return;
        }

        installRuntime();

        if (!isVideosTab()) {
            removeBarIfMounted();
            return;
        }

        if (previousOptions.videoSearchMaxPages !== options.videoSearchMaxPages) {
            channelIndex.clear();
            activeFetchToken++;
            lastFilterKey = null;
        }

        const commentLimitsChanged =
            previousOptions.videoSearchCommentMaxVideos !== options.videoSearchCommentMaxVideos ||
            previousOptions.videoSearchCommentMaxPagesPerVideo !== options.videoSearchCommentMaxPagesPerVideo ||
            previousOptions.videoSearchCommentDelayMs !== options.videoSearchCommentDelayMs;

        if (commentLimitsChanged) {
            cancelCommentSearch();
            for (const entry of channelIndex.values()) {
                for (const video of entry.videos || []) {
                    video.commentTexts = [];
                    video.commentNorm = "";
                    video.commentFetched = video.commentActive === false;
                    video.commentLoading = false;
                    video.commentError = null;
                }
            }
            lastFilterKey = null;
        }

        if (!wasEnabled) {
            visibleMatchLimit = getRenderBatchSize();
        }

        if (previousOptions.videoSearchRenderBatchSize !== options.videoSearchRenderBatchSize) {
            visibleMatchLimit = getRenderBatchSize();
            lastFilterKey = null;
        }

        if (wasCommentEnabled && !isCommentSearchEnabled()) {
            cancelCommentSearch();
            removeCommentSurfaces();
            lastFilterKey = null;
        }

        if ((!wasCommentEnabled || commentLimitsChanged) && isCommentSearchEnabled() && currentQuery) {
            scheduleCommentSearch();
        }

        if (currentQuery && currentChannelId) {
            const entry = getEntry();
            if (shouldStartIndexBuild(entry)) buildIndex(currentChannelId);
        }

        schedule();
    }

    bindFeatureOptions(applyOptions);

    onReady(() => {
        if (isFeatureEnabled()) installRuntime();
    });
})();
