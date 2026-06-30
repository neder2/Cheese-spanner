(() => {
    const WIDGET_ID = "betterchzzk-monthly-broadcast-time";
    const STYLE_ID = "betterchzzk-monthly-broadcast-time-style";
    const HOST_ATTR = "data-bcmb-host";
    const API_BASE = "https://api.chzzk.naver.com/service/v1/channels";
    const PAGE_SIZE = 30;
    const REFRESH_MS = 10 * 60 * 1000;
    const MINUTE_SECONDS = 60;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
    const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
    const VIDEO_DETAIL_API_BASE = "https://api.chzzk.naver.com/service/v2/videos";
    const DETAIL_FETCH_CONCURRENCY = 5;
    const FETCH_TIMEOUT_MS = 15000;
    const WATCH_HISTORY_STORAGE_KEY = "betterChzzkLiveWatchHistory";
    const WATCH_MATCH_START_TOLERANCE_MS = 60 * 60 * 1000;
    const WATCH_MATCH_OVERLAP_GRACE_MS = 10 * 60 * 1000;
    const SESSION_MERGE_GAP_MS = 60 * 1000;
    const MAX_STATS_CACHE_CHANNELS = 8;
    const MAX_MONTH_CACHE_ENTRIES = 36;
    const MAX_PAGE_CACHE_CHANNELS = 8;
    const MAX_PAGES_PER_CHANNEL_CACHE = 120;
    const MAX_VIDEO_DETAIL_CACHE_ENTRIES = 600;

    const ROUTE_EXCLUSIONS = new Set([
        "category",
        "clips",
        "following",
        "live",
        "lives",
        "schedule",
        "search",
        "studio",
        "timetable",
        "video",
        "videos",
    ]);

    const channelStatsCache = new Map();
    const channelMonthCache = new Map();
    const channelVideoPageCache = new Map();
    const videoDetailCache = new Map();
    const loadingTokens = new Map();
    const calendarLoadingTokens = new Map();

    let currentChannelId = null;
    let observer = null;
    let scheduled = false;
    let scheduleFallbackTimer = 0;
    let lastUrl = location.href;
    let featureOptions = BetterChzzkSettings.normalizeOptions();
    let watchHistoryEntries = [];
    let watchHistoryLoaded = false;
    let watchHistoryLoading = false;
    let watchHistoryRerenderTimer = 0;
    let runtimeInstalled = false;
    let routeListenersInstalled = false;
    let calendarCloseListenerInstalled = false;
    let removeStorageChangeListener = null;
    let removePageChangeDetection = null;
    const storage = globalThis.chrome?.storage?.local;
    const {
        addWatchRangeToRangesByDate,
        bindFeatureOptions,
        collectWatchSessionRanges,
        createMutationObserverSync,
        fetchJson,
        formatKstDateKey: formatDateKey,
        formatKstMonthKey: formatMonthKey,
        formatKstTime: formatKstClock,
        getKstDateKey,
        getKstParts,
        isLastPage,
        isVisible,
        mergeDailySeconds: mergeWatchSessionDailySeconds,
        mergeWatchRanges,
        normSpace,
        normalizeDailySeconds: normalizeWatchDailySeconds,
        onReady,
        pickArray,
        pickChzzkVideoNo,
        pickVideoEndDateText,
        pickVideoStartDateText,
        parseChzzkDate,
        startStorageChangeListener,
        startPageChangeDetection,
        storageGet,
        sumWatchRanges,
        sumWatchRangesByDate,
        touchMapEntry,
    } = BetterChzzk.utils;

    function isFeatureEnabled() {
        return featureOptions.monthlyBroadcastTimeEnabled;
    }

    function isCalendarEnabled() {
        return isFeatureEnabled() && featureOptions.monthlyBroadcastTimeCalendarEnabled;
    }

    function getWindowDays() {
        return featureOptions.monthlyBroadcastTimeWindowDays;
    }

    function getWindowMs() {
        return getWindowDays() * 24 * 60 * 60 * 1000;
    }

    function getWindowLabel() {
        return `최근 ${getWindowDays()}일`;
    }

    function getMaxPages() {
        return featureOptions.monthlyBroadcastTimeMaxPages;
    }

    function getMaxCalendarPages() {
        return featureOptions.monthlyBroadcastTimeMaxCalendarPages;
    }

    function getChannelIdFromUrl() {
        const parts = location.pathname.split("/").filter(Boolean);
        const channelId = parts[0] || "";
        if (!channelId || ROUTE_EXCLUSIONS.has(channelId)) return null;
        if (!/^[a-f0-9]{32}$/i.test(channelId)) return null;
        if (parts.length > 2) return null;

        const subPath = parts[1] || "";
        if (subPath && !["about", "chat", "clips", "community", "info", "videos"].includes(subPath)) {
            return null;
        }

        return channelId;
    }

    function isChannelRoute() {
        return Boolean(getChannelIdFromUrl());
    }

    function hasMountedWidget() {
        return Boolean(
            currentChannelId ||
            document.getElementById(WIDGET_ID) ||
            document.querySelector(`[${HOST_ATTR}="1"]`)
        );
    }

    function removeWidgetIfMounted() {
        if (hasMountedWidget()) removeWidget();
    }

    function injectStyleOnce() {
        BetterChzzk.utils.injectStyleOnce(STYLE_ID, `
[${HOST_ATTR}="1"]{
  align-items:center !important;
}
#${WIDGET_ID}{
  position:relative;
  display:inline-flex;
  align-items:center;
  gap:7px;
  flex:0 0 auto;
  width:max-content;
  max-width:270px;
  height:34px;
  min-height:34px;
  margin:0 10px 0 0;
  padding:0 11px 0 8px;
  border:1px solid rgba(17,17,20,0.08);
  border-radius:17px;
  background:#f0f2f5;
  color:#111114;
  box-shadow:none;
  box-sizing:border-box;
  font-family:"Sandoll Nemony2", "Sandoll Nemony", "Apple SD Gothic Neo", "Apple SD Gothic NEO", "Malgun Gothic", "맑은 고딕", sans-serif;
  line-height:1;
  white-space:nowrap;
  pointer-events:auto;
  vertical-align:middle;
  -webkit-font-smoothing:antialiased;
  transition:background-color 120ms ease, border-color 120ms ease, color 120ms ease;
  cursor:pointer;
}
#${WIDGET_ID}:hover{
  border-color:rgba(0,168,107,0.28);
  background:#e9fbf4;
}
#${WIDGET_ID}::after{
  content:"";
  display:none;
  position:absolute;
  left:0;
  right:0;
  top:100%;
  height:10px;
}
#${WIDGET_ID}:hover::after,
#${WIDGET_ID}:focus::after,
#${WIDGET_ID}:focus-within::after,
#${WIDGET_ID}[data-open="1"]::after{
  display:block;
}
html[dark] #${WIDGET_ID},
body[theme="dark"] #${WIDGET_ID},
[class*="dark"] #${WIDGET_ID}{
  border-color:rgba(157,165,182,0.18);
  background:#24262a;
  color:#f2f4f7;
}
html[dark] #${WIDGET_ID}:hover,
body[theme="dark"] #${WIDGET_ID}:hover,
[class*="dark"] #${WIDGET_ID}:hover{
  border-color:rgba(0,255,163,0.34);
  background:#28332f;
}
#${WIDGET_ID} .bcmb-icon{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  width:22px;
  height:22px;
  min-width:22px;
  border-radius:50%;
  color:#07150f;
  background:#00ffa3;
}
#${WIDGET_ID} .bcmb-icon svg{
  width:14px;
  height:14px;
}
#${WIDGET_ID} .bcmb-body{
  display:flex;
  align-items:center;
  gap:6px;
  min-width:0;
}
#${WIDGET_ID} .bcmb-label{
  color:#697183;
  font-size:12px;
  font-weight:800;
  letter-spacing:0;
}
#${WIDGET_ID} .bcmb-value{
  overflow:hidden;
  color:currentColor;
  font-size:13px;
  font-weight:900;
  line-height:34px;
  text-overflow:ellipsis;
}
#${WIDGET_ID} .bcmb-meta{
  display:none;
}
#${WIDGET_ID} .bcmb-calendar{
  display:none;
  position:absolute;
  top:calc(100% + 8px);
  right:0;
  width:232px;
  padding:12px;
  border:1px solid rgba(17,17,20,0.1);
  border-radius:8px;
  background:#fff;
  color:#111114;
  box-shadow:0 8px 24px rgba(0,0,0,0.16);
  box-sizing:border-box;
  z-index:2147483647;
  cursor:default;
}
#${WIDGET_ID}:hover .bcmb-calendar,
#${WIDGET_ID}:focus .bcmb-calendar,
#${WIDGET_ID}:focus-within .bcmb-calendar,
#${WIDGET_ID}[data-open="1"] .bcmb-calendar{
  display:block;
}
#${WIDGET_ID} .bcmb-calendar-head{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:6px;
  margin-bottom:10px;
}
#${WIDGET_ID} .bcmb-calendar-title{
  display:flex;
  flex:1 1 auto;
  min-width:0;
  flex-direction:column;
  align-items:center;
  gap:2px;
}
#${WIDGET_ID} .bcmb-calendar-month{
  font-size:13px;
  font-weight:900;
}
#${WIDGET_ID} .bcmb-calendar-count{
  color:#00a86b;
  font-size:12px;
  font-weight:900;
}
#${WIDGET_ID} .bcmb-nav{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  flex:0 0 auto;
  width:26px;
  height:26px;
  margin:0;
  padding:0;
  border:1px solid rgba(105,113,131,0.18);
  border-radius:50%;
  background:#f6f7f9;
  color:#111114;
  font-family:inherit;
  font-size:18px;
  font-weight:900;
  line-height:1;
  cursor:pointer;
}
#${WIDGET_ID} .bcmb-nav:hover{
  border-color:rgba(0,168,107,0.35);
  background:#e9fbf4;
}
#${WIDGET_ID} .bcmb-nav:disabled{
  color:#c9cedc;
  background:#f6f7f9;
  cursor:default;
}
#${WIDGET_ID} .bcmb-weekdays,
#${WIDGET_ID} .bcmb-days{
  display:grid;
  grid-template-columns:repeat(7, 1fr);
  gap:4px;
  overflow:visible;
}
#${WIDGET_ID} .bcmb-weekday{
  display:flex;
  align-items:center;
  justify-content:center;
  height:18px;
  color:#697183;
  font-size:11px;
  font-weight:800;
}
#${WIDGET_ID} .bcmb-day{
  position:relative;
  display:flex;
  align-items:center;
  justify-content:center;
  height:24px;
  border-radius:6px;
  color:#8b93a3;
  font-size:12px;
  font-weight:800;
  box-sizing:border-box;
}
#${WIDGET_ID} .bcmb-day-tip{
  display:none;
  position:absolute;
  left:50%;
  bottom:calc(100% + 6px);
  width:max-content;
  min-width:176px;
  max-width:268px;
  padding:7px;
  border:1px solid rgba(255,255,255,0.08);
  border-radius:8px;
  background:#111114;
  color:#fff;
  box-shadow:0 6px 18px rgba(0,0,0,0.2);
  font-size:11px;
  font-weight:700;
  line-height:14px;
  text-align:left;
  white-space:normal;
  transform:translateX(-50%);
  z-index:2147483647;
  pointer-events:none;
}
#${WIDGET_ID} .bcmb-day-tip-title{
  display:block;
  margin-bottom:6px;
  color:#00ffa3;
  font-size:11px;
  font-weight:900;
}
#${WIDGET_ID} .bcmb-day-tip-row{
  display:grid;
  grid-template-columns:48px minmax(0, 1fr);
  gap:7px;
  align-items:center;
  min-height:16px;
}
#${WIDGET_ID} .bcmb-day-tip-row + .bcmb-day-tip-row{
  margin-top:4px;
}
#${WIDGET_ID} .bcmb-day-tip-label{
  color:#9da5b6;
  font-weight:800;
}
#${WIDGET_ID} .bcmb-day-tip-value{
  color:#fff;
  font-weight:900;
  text-align:right;
  word-break:keep-all;
}
#${WIDGET_ID} .bcmb-day-tip-row-broadcast .bcmb-day-tip-label{
  color:#b9c2d2;
}
#${WIDGET_ID} .bcmb-day-tip-row-watch{
  padding-top:4px;
  border-top:1px solid rgba(0,255,163,0.14);
}
#${WIDGET_ID} .bcmb-day-tip-row-watch .bcmb-day-tip-label{
  color:#72f0c7;
}
#${WIDGET_ID} .bcmb-day-tip-row-watch .bcmb-day-tip-value{
  color:#b8ffe8;
  font-weight:800;
}
#${WIDGET_ID} .bcmb-day-tip-item{
  display:block;
  position:relative;
  padding:7px 8px 7px 10px;
  border-left:2px solid rgba(0,255,163,0.48);
  border-radius:6px;
  background:rgba(255,255,255,0.045);
}
#${WIDGET_ID} .bcmb-day-tip-item + .bcmb-day-tip-item{
  margin-top:7px;
}
#${WIDGET_ID} .bcmb-day-tip::after{
  content:"";
  position:absolute;
  left:50%;
  top:100%;
  border:5px solid transparent;
  border-top-color:#111114;
  transform:translateX(-50%);
}
#${WIDGET_ID} .bcmb-day:hover .bcmb-day-tip,
#${WIDGET_ID} .bcmb-day:focus .bcmb-day-tip{
  display:block;
}
#${WIDGET_ID} .bcmb-day[data-has-broadcast="1"],
#${WIDGET_ID} .bcmb-day[data-live="1"]{
  color:#07150f;
  background:rgba(0,255,163,0.24);
}
#${WIDGET_ID} .bcmb-day[data-watch="1"]::before{
  content:"";
  position:absolute;
  top:4px;
  right:4px;
  width:5px;
  height:5px;
  border-radius:50%;
  background:#07150f;
}
#${WIDGET_ID} .bcmb-day[data-level="2"]{
  background:rgba(0,255,163,0.38);
}
#${WIDGET_ID} .bcmb-day[data-level="3"]{
  background:#00ffa3;
}
#${WIDGET_ID} .bcmb-day[data-today="1"]{
  box-shadow:inset 0 0 0 2px #111114;
}
#${WIDGET_ID} .bcmb-day[data-future="1"]{
  color:#c9cedc;
  background:transparent;
}
#${WIDGET_ID} .bcmb-calendar-foot{
  display:grid;
  grid-template-columns:minmax(0, 1fr) auto;
  align-items:end;
  gap:8px;
  margin-top:10px;
  color:#697183;
  font-size:11px;
  font-weight:800;
  line-height:15px;
}
#${WIDGET_ID} .bcmb-calendar-foot-note{
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
#${WIDGET_ID} .bcmb-calendar-watch-total{
  color:#00a86b;
  font-weight:900;
  text-align:right;
  white-space:nowrap;
}
#${WIDGET_ID} .bcmb-calendar[data-loading="1"] .bcmb-days{
  opacity:0.42;
}
#${WIDGET_ID} .bcmb-calendar[data-loading="1"] .bcmb-calendar-count{
  color:#697183;
}
html[dark] #${WIDGET_ID} .bcmb-calendar,
body[theme="dark"] #${WIDGET_ID} .bcmb-calendar,
[class*="dark"] #${WIDGET_ID} .bcmb-calendar{
  border-color:rgba(157,165,182,0.18);
  background:#1b1d20;
  color:#f2f4f7;
}
html[dark] #${WIDGET_ID} .bcmb-nav,
body[theme="dark"] #${WIDGET_ID} .bcmb-nav,
[class*="dark"] #${WIDGET_ID} .bcmb-nav{
  border-color:rgba(157,165,182,0.18);
  background:#24262a;
  color:#f2f4f7;
}
html[dark] #${WIDGET_ID} .bcmb-nav:disabled,
body[theme="dark"] #${WIDGET_ID} .bcmb-nav:disabled,
[class*="dark"] #${WIDGET_ID} .bcmb-nav:disabled{
  color:#697183;
}
html[dark] #${WIDGET_ID} .bcmb-day[data-today="1"],
body[theme="dark"] #${WIDGET_ID} .bcmb-day[data-today="1"],
[class*="dark"] #${WIDGET_ID} .bcmb-day[data-today="1"]{
  box-shadow:inset 0 0 0 2px #f2f4f7;
}
html[dark] #${WIDGET_ID} .bcmb-day[data-watch="1"]::before,
body[theme="dark"] #${WIDGET_ID} .bcmb-day[data-watch="1"]::before,
[class*="dark"] #${WIDGET_ID} .bcmb-day[data-watch="1"]::before{
  background:#00ffa3;
}
#${WIDGET_ID}[data-state="loading"] .bcmb-icon svg{
  animation:bcmb-spin 0.8s linear infinite;
}
#${WIDGET_ID}[data-state="loading"]:not([data-open="1"]):not(:hover):not(:focus):not(:focus-within) .bcmb-calendar{
  display:none !important;
}
#${WIDGET_ID}[data-calendar-disabled="1"] .bcmb-calendar{
  display:none !important;
}
#${WIDGET_ID}[data-state="error"] .bcmb-icon,
#${WIDGET_ID}[data-state="empty"] .bcmb-icon{
  color:#697183;
  background:rgba(105,113,131,0.14);
}
@keyframes bcmb-spin{to{transform:rotate(360deg);}}
@media (max-width: 980px){
  #${WIDGET_ID}{
    max-width:210px;
    margin-right:6px;
    padding-right:9px;
  }
  #${WIDGET_ID} .bcmb-label{display:none;}
}
`);
    }

    function createWidget() {
        injectStyleOnce();

        const widget = document.createElement("div");
        widget.id = WIDGET_ID;
        widget.setAttribute("role", "status");
        widget.setAttribute("aria-live", "polite");
        widget.setAttribute("aria-expanded", "false");
        widget.setAttribute("data-calendar-disabled", isCalendarEnabled() ? "0" : "1");
        widget.tabIndex = 0;
        widget.innerHTML = `
<span class="bcmb-icon" aria-hidden="true">
  <svg viewBox="0 0 24 24">
    <path fill="currentColor" d="M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-2.34-5.66L15 9h7V2l-2.93 2.93A9.96 9.96 0 0 0 12 2Zm1 5h-2v6l5 3 .99-1.73L13 11.9V7Z"/>
  </svg>
</span>
<span class="bcmb-body">
  <span class="bcmb-label">최근 30일</span>
  <span class="bcmb-value">계산 중</span>
  <span class="bcmb-meta">다시보기 기준</span>
</span>
<span class="bcmb-calendar" aria-hidden="true">
  <span class="bcmb-calendar-head">
    <button type="button" class="bcmb-nav" data-bcmb-nav="-1" aria-label="이전 달">‹</button>
    <span class="bcmb-calendar-title">
      <span class="bcmb-calendar-month"></span>
      <span class="bcmb-calendar-count"></span>
    </span>
    <button type="button" class="bcmb-nav" data-bcmb-nav="1" aria-label="다음 달">›</button>
  </span>
  <span class="bcmb-weekdays" aria-hidden="true"></span>
  <span class="bcmb-days"></span>
  <span class="bcmb-calendar-foot"></span>
</span>
`;
        installWidgetInteractions(widget);
        setWidgetState(widget, "loading");
        return widget;
    }

    function installWidgetInteractions(widget) {
        widget.addEventListener("click", (event) => {
            const navButton = event.target?.closest?.("[data-bcmb-nav]");
            if (navButton && widget.contains(navButton)) {
                event.preventDefault();
                event.stopPropagation();
                navigateCalendarMonth(widget, Number(navButton.getAttribute("data-bcmb-nav")) || 0);
                return;
            }
            if (event.target?.closest?.(".bcmb-calendar")) return;
            if (!isCalendarEnabled()) return;
            const open = widget.getAttribute("data-open") === "1";
            setCalendarOpen(widget, !open);
        });

        widget.addEventListener("keydown", (event) => {
            if (!isCalendarEnabled()) return;
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setCalendarOpen(widget, widget.getAttribute("data-open") !== "1");
                return;
            }
            if (event.key === "Escape") setCalendarOpen(widget, false);
        });

        widget.addEventListener("mouseenter", () => flushDeferredCalendarRerender(widget));
        widget.addEventListener("focusin", () => flushDeferredCalendarRerender(widget));

        installCalendarCloseListener();
    }

    function handleCalendarDocumentClick(event) {
        const current = document.getElementById(WIDGET_ID);
        if (!current || current.contains(event.target)) return;
        if (current.getAttribute("data-open") !== "1") return;
        setCalendarOpen(current, false);
    }

    function installCalendarCloseListener() {
        if (calendarCloseListenerInstalled) return;
        calendarCloseListenerInstalled = true;
        document.addEventListener("click", handleCalendarDocumentClick, true);
    }

    function uninstallCalendarCloseListener() {
        if (!calendarCloseListenerInstalled) return;
        calendarCloseListenerInstalled = false;
        document.removeEventListener("click", handleCalendarDocumentClick, true);
    }

    function setCalendarOpen(widget, open) {
        if (!widget) return;
        if (!isCalendarEnabled()) open = false;
        const wasOpen = widget.getAttribute("data-open") === "1";
        widget.setAttribute("data-open", open ? "1" : "0");
        widget.setAttribute("aria-expanded", open ? "true" : "false");
        const calendar = widget.querySelector(".bcmb-calendar");
        if (calendar) calendar.setAttribute("aria-hidden", open ? "false" : "true");
        if (open) flushDeferredCalendarRerender(widget);
        if (!open && wasOpen) resetCalendarToCurrentMonth(widget);
    }

    function isCalendarInteractionActive(widget) {
        if (!widget) return false;
        return widget.getAttribute("data-open") === "1" || widget.matches(":hover, :focus, :focus-within");
    }

    function flushDeferredCalendarRerender(widget) {
        if (!widget || widget.dataset.watchHistoryDirty !== "1") return;
        delete widget.dataset.watchHistoryDirty;
        rerenderCurrentCalendar();
    }

    function resetCalendarToCurrentMonth(widget) {
        if (!widget || !isCalendarEnabled() || !currentChannelId) return;

        const now = getKstParts();
        const selected = getSelectedCalendarMonth(widget);
        if (selected && selected.year === now.year && selected.month === now.month) return;

        setSelectedCalendarMonth(widget, now.year, now.month);

        const cached = getCachedMonthInfo(currentChannelId, now.year, now.month);
        if (cached) {
            renderCalendar(widget, cached);
            return;
        }

        void loadCalendarMonth(widget, currentChannelId, now.year, now.month);
    }

    function setWidgetState(widget, state, value = "계산 중", meta = "다시보기 기준", label = getWindowLabel()) {
        if (!widget) return;
        widget.setAttribute("data-state", state);

        const labelEl = widget.querySelector(".bcmb-label");
        const valueEl = widget.querySelector(".bcmb-value");
        const metaEl = widget.querySelector(".bcmb-meta");
        if (labelEl) labelEl.textContent = label;
        if (valueEl) valueEl.textContent = value;
        if (metaEl) metaEl.textContent = meta;
        widget.removeAttribute("title");
    }

    function getActionControls() {
        const keywords = ["팔로우", "팔로잉", "구독", "구독 선물"];
        return Array.from(document.querySelectorAll("button, a"))
            .filter((el) => {
                if (!isVisible(el)) return false;
                if (el.closest("nav, aside")) return false;
                const text = normSpace([
                    el.textContent,
                    el.getAttribute("aria-label"),
                    el.getAttribute("title"),
                ].filter(Boolean).join(" "));
                if (!keywords.some((keyword) => text.includes(keyword))) return false;
                const rect = el.getBoundingClientRect();
                return rect.top >= 0 && rect.top < Math.min(window.innerHeight, 260) && rect.left > 220;
            })
            .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    }

    function scoreActionHost(host, controls) {
        if (!(host instanceof HTMLElement) || !isVisible(host)) return Number.NEGATIVE_INFINITY;
        const rect = host.getBoundingClientRect();
        if (rect.top < 0 || rect.top > 280 || rect.width < 80 || rect.height < 24) return Number.NEGATIVE_INFINITY;

        const contained = controls.filter((control) => host.contains(control)).length;
        if (!contained) return Number.NEGATIVE_INFINITY;

        const buttonCount = host.querySelectorAll("button, a").length;
        const areaPenalty = Math.round((rect.width * rect.height) / 1000);
        return contained * 1000 + Math.min(buttonCount, 5) * 20 - areaPenalty;
    }

    function findActionHost(controls = getActionControls()) {
        if (!controls.length) return null;

        const candidates = new Set();
        for (const control of controls) {
            let node = control.parentElement;
            let depth = 0;
            while (node && depth < 7) {
                candidates.add(node);
                node = node.parentElement;
                depth++;
            }
        }

        let best = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const candidate of candidates) {
            const score = scoreActionHost(candidate, controls);
            if (score > bestScore) {
                best = candidate;
                bestScore = score;
            }
        }

        return best;
    }

    function findFollowerInfo() {
        return Array.from(document.querySelectorAll("span, strong, em, div, p"))
            .filter((el) => isVisible(el) && /팔로워\s*[\d,.]+/.test(normSpace(el.textContent)))
            .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0] || null;
    }

    function findFallbackHost() {
        const followerInfo = findFollowerInfo();
        if (!followerInfo) return null;

        let node = followerInfo.parentElement;
        let depth = 0;
        while (node && depth < 8) {
            if (node === document.body || node === document.documentElement) break;
            if (node instanceof HTMLElement && isVisible(node)) {
                const rect = node.getBoundingClientRect();
                if (rect.top < 260 && rect.width > 320 && rect.height > 40) return node;
            }
            node = node.parentElement;
            depth++;
        }
        return null;
    }

    function getDirectChildUnder(parent, descendant) {
        if (!parent || !descendant || parent === descendant) return null;

        let node = descendant;
        while (node && node.parentElement && node.parentElement !== parent) {
            node = node.parentElement;
        }

        return node?.parentElement === parent ? node : null;
    }

    function mountWidget() {
        if (!isFeatureEnabled()) {
            removeWidget();
            return null;
        }

        const channelId = getChannelIdFromUrl();
        if (!channelId) {
            removeWidget();
            return null;
        }

        let widget = document.getElementById(WIDGET_ID);
        if (widget && currentChannelId === channelId && widget.isConnected && isVisible(widget)) {
            widget.setAttribute("data-calendar-disabled", isCalendarEnabled() ? "0" : "1");
            if (!isCalendarEnabled()) setCalendarOpen(widget, false);
            renderCachedStats(widget, channelId);
            return widget;
        }

        const controls = getActionControls();
        const host = findActionHost(controls);
        const fallbackHost = host ? null : findFallbackHost();
        if (!host && !fallbackHost) return null;

        if (!widget) widget = createWidget();
        widget.setAttribute("data-calendar-disabled", isCalendarEnabled() ? "0" : "1");
        if (!isCalendarEnabled()) setCalendarOpen(widget, false);

        if (host && tryMountInActionHost(host, widget, controls)) {
            // Mounted next to the channel action buttons.
        } else if (fallbackHost && widget.parentElement !== fallbackHost) {
            widget.style.marginTop = "10px";
            fallbackHost.appendChild(widget);
        } else if (!fallbackHost && widget.parentElement !== host && host) {
            host.appendChild(widget);
        }

        if (currentChannelId !== channelId) {
            currentChannelId = channelId;
            resetSelectedCalendarMonth(widget);
            setWidgetState(widget, "loading");
            loadStats(channelId);
        } else {
            renderCachedStats(widget, channelId);
        }

        return widget;
    }

    function tryMountInActionHost(host, widget, controls = getActionControls()) {
        try {
            host.setAttribute(HOST_ATTR, "1");
            widget.style.marginTop = "";
            const firstControl = controls.find((control) => host.contains(control));
            const anchor = getDirectChildUnder(host, firstControl);
            if (anchor && anchor !== widget) {
                host.insertBefore(widget, anchor);
            } else if (widget.parentElement !== host) {
                host.insertBefore(widget, host.firstChild);
            }
            return widget.parentElement === host;
        } catch (_) {
            return false;
        }
    }

    function removeWidget() {
        const widget = document.getElementById(WIDGET_ID);
        if (widget) widget.remove();
        document.querySelectorAll(`[${HOST_ATTR}="1"]`).forEach((el) => el.removeAttribute(HOST_ATTR));
        currentChannelId = null;
    }

    function extractVideos(json) {
        const content = json?.content ?? json;
        const rows = pickArray(content);
        if (!rows) return [];

        return rows.map((row) => {
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
        }).filter(Boolean);
    }

    function getChannelPageCache(channelId) {
        let cache = channelVideoPageCache.get(channelId);
        if (!cache) {
            cache = new Map();
            touchMapEntry(channelVideoPageCache, channelId, cache, MAX_PAGE_CACHE_CHANNELS);
        } else {
            touchMapEntry(channelVideoPageCache, channelId, cache, MAX_PAGE_CACHE_CHANNELS);
        }
        return cache;
    }

    async function fetchVideoPage(channelId, page) {
        const params = new URLSearchParams({
            sortType: "LATEST",
            pagingType: "PAGE",
            page: String(page),
            size: String(PAGE_SIZE),
        });
        const url = `${API_BASE}/${encodeURIComponent(channelId)}/videos?${params.toString()}`;
        return fetchJson(url, {
            headers: { Accept: "application/json" },
            timeoutMs: FETCH_TIMEOUT_MS,
        });
    }

    async function fetchVideoPageCached(channelId, page) {
        const cache = getChannelPageCache(channelId);
        const cached = cache.get(page);
        if (cached && Date.now() - cached.fetchedAt < REFRESH_MS) {
            touchMapEntry(cache, page, cached, MAX_PAGES_PER_CHANNEL_CACHE);
            return cached.promise;
        }

        const entry = {
            fetchedAt: Date.now(),
            promise: fetchVideoPage(channelId, page).catch((error) => {
                cache.delete(page);
                throw error;
            }),
        };
        touchMapEntry(cache, page, entry, MAX_PAGES_PER_CHANNEL_CACHE);
        return entry.promise;
    }

    function normalizeMatchText(value) {
        return normSpace(value)
            .toLowerCase()
            .replace(/\s*[-|]\s*(?:chzzk|치지직).*$/i, "")
            .replace(/[^\p{L}\p{N}]+/gu, "");
    }

    function getNumericMs(value) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : 0;
    }

    function mergeContinuousWatchSessionDetails(sessionDetails) {
        const merged = [];
        const rows = (Array.isArray(sessionDetails) ? sessionDetails : [])
            .filter((session) => session && typeof session === "object")
            .map((session) => ({
                ...session,
                enteredAt: Number(session.enteredAt) || 0,
                leftAt: Number(session.leftAt) || Number(session.enteredAt) || 0,
                watchedSeconds: Math.max(0, Number(session.watchedSeconds) || 0),
                dailySeconds: normalizeWatchDailySeconds(session.dailySeconds),
                watchedRanges: mergeWatchRanges(session.watchedRanges),
            }))
            .filter((session) => session.id && session.enteredAt > 0 && session.watchedSeconds >= MINUTE_SECONDS)
            .sort((a, b) => a.enteredAt - b.enteredAt || a.leftAt - b.leftAt);

        for (const session of rows) {
            const last = merged[merged.length - 1];
            const lastLeftAt = Number(last?.leftAt) || Number(last?.enteredAt) || 0;
            const shouldMerge = last && lastLeftAt > 0 && session.enteredAt <= lastLeftAt + SESSION_MERGE_GAP_MS;

            if (!shouldMerge) {
                merged.push(session);
                continue;
            }

            last.leftAt = Math.max(lastLeftAt, Number(session.leftAt) || session.enteredAt);
            last.watchedSeconds = Math.max(0, Number(last.watchedSeconds) || 0) + session.watchedSeconds;
            last.dailySeconds = mergeWatchSessionDailySeconds(last.dailySeconds, session.dailySeconds);
            last.watchedRanges = mergeWatchRanges([...(last.watchedRanges || []), ...(session.watchedRanges || [])]);
        }

        return merged;
    }

    function normalizeWatchSessionDetails(value) {
        if (!Array.isArray(value)) return [];
        const sessions = value
            .filter((session) => session && typeof session === "object")
            .map((session) => {
                const enteredAt = Number(session.enteredAt) || Number(session.startedAt) || 0;
                const leftAt = Number(session.leftAt) || Number(session.endedAt) || Number(session.lastWatchedAt) || 0;
                const watchedRanges = mergeWatchRanges(session.watchedRanges);
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

        return mergeContinuousWatchSessionDetails(sessions);
    }

    function sumWatchSessionSeconds(sessionDetails) {
        return sumWatchRanges(collectWatchSessionRanges(sessionDetails));
    }

    function buildWatchDailySeconds(sessionDetails) {
        const rangesByDate = {};
        for (const range of collectWatchSessionRanges(sessionDetails)) {
            addWatchRangeToRangesByDate(rangesByDate, range);
        }
        return sumWatchRangesByDate(rangesByDate);
    }

    function getWatchSessionFirstWatchedAt(sessionDetails) {
        const values = (sessionDetails || []).map((session) => Number(session.enteredAt) || 0).filter((value) => value > 0);
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
                const dailySeconds = hasSessionDetails
                    ? buildWatchDailySeconds(sessionDetails)
                    : normalizeWatchDailySeconds(row.dailySeconds);
                const watchedSeconds = hasSessionDetails
                    ? sumWatchSessionSeconds(sessionDetails)
                    : Math.max(0, Number(row.watchedSeconds) || 0);
                const firstWatchedAt = hasSessionDetails
                    ? getWatchSessionFirstWatchedAt(sessionDetails)
                    : getNumericMs(row.firstWatchedAt);
                const lastWatchedAt = hasSessionDetails
                    ? getWatchSessionLastWatchedAt(sessionDetails)
                    : getNumericMs(row.lastWatchedAt);
                return {
                    id: normSpace(row.id),
                    channelId: normSpace(row.channelId),
                    liveId: normSpace(row.liveId),
                    title: normSpace(row.title),
                    titleKey: normalizeMatchText(row.title),
                    liveOpenMs: parseChzzkDate(row.liveOpenDate)?.getTime() || 0,
                    firstWatchedAt,
                    lastWatchedAt,
                    watchedSeconds,
                    dailySeconds,
                };
            })
            .filter((entry) => entry.id && entry.channelId && entry.watchedSeconds >= MINUTE_SECONDS);
    }

    function refreshWatchHistory({ rerender = true, deferWhenVisible = false } = {}) {
        if (!storage || watchHistoryLoading) return;

        watchHistoryLoading = true;
        storageGet(storage, WATCH_HISTORY_STORAGE_KEY).then((data) => {
            watchHistoryEntries = normalizeWatchHistory(data?.[WATCH_HISTORY_STORAGE_KEY]);
            watchHistoryLoaded = true;
            if (rerender) rerenderCurrentCalendar({ deferWhenVisible });
        }).catch(() => {
            // Preserve the previous behavior: storage read failures only skip watch-history enrichment.
        }).finally(() => {
            watchHistoryLoading = false;
        });
    }

    function ensureWatchHistoryLoaded() {
        if (watchHistoryLoaded || watchHistoryLoading) return;
        refreshWatchHistory({ rerender: true, deferWhenVisible: true });
    }

    function rerenderCurrentCalendar({ deferWhenVisible = false } = {}) {
        if (!currentChannelId) return;
        const widget = document.getElementById(WIDGET_ID);
        const selected = getSelectedCalendarMonth(widget);
        if (!widget || !selected) return;
        if (deferWhenVisible && isCalendarInteractionActive(widget)) {
            widget.dataset.watchHistoryDirty = "1";
            return;
        }
        const month = getCachedMonthInfo(currentChannelId, selected.year, selected.month);
        if (month) renderCalendar(widget, month);
    }

    function scheduleWatchHistoryRerender({ deferWhenVisible = false } = {}) {
        if (watchHistoryRerenderTimer) window.clearTimeout(watchHistoryRerenderTimer);
        watchHistoryRerenderTimer = window.setTimeout(() => {
            watchHistoryRerenderTimer = 0;
            rerenderCurrentCalendar({ deferWhenVisible });
        }, 300);
    }

    function getEntryDailySeconds(entry, dateKey) {
        return Math.max(0, Number(entry?.dailySeconds?.[dateKey]) || 0);
    }

    function entryOverlapsStart(entry, start) {
        if (!entry?.firstWatchedAt || !entry?.lastWatchedAt || !start?.startMs) return false;
        const startMs = start.startMs - WATCH_MATCH_OVERLAP_GRACE_MS;
        const endMs = (start.endMs || start.startMs + start.duration * 1000) + WATCH_MATCH_OVERLAP_GRACE_MS;
        return entry.firstWatchedAt <= endMs && entry.lastWatchedAt >= startMs;
    }

    function entryHasSameLiveOpen(entry, start) {
        return Boolean(
            entry?.liveOpenMs &&
            start?.startMs &&
            Math.abs(entry.liveOpenMs - start.startMs) <= WATCH_MATCH_START_TOLERANCE_MS
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
        if (start.videoNos?.includes(entry.liveId)) return 120;

        let score = 0;
        if (entryHasSameLiveOpen(entry, start)) score += 80;
        if (entryOverlapsStart(entry, start)) score += 60;
        if (entryMatchesStartTitle(entry, start)) score += 30;
        if (entryMatchesStartDate(entry, start)) score += 15;
        return score;
    }

    function getStartWatchInfo(channelId, start) {
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

    function getChannelWatchSeconds(channelId) {
        if (!channelId) return 0;
        return watchHistoryEntries.reduce((sum, entry) => {
            if (entry.channelId !== channelId) return sum;
            return sum + Math.max(0, Number(entry.watchedSeconds) || 0);
        }, 0);
    }

    function formatWatchPercent(percent) {
        const value = Number(percent) || 0;
        if (value > 0 && value < 1) return "<1%";
        return `${Math.round(value)}%`;
    }

    function formatWatchDuration(seconds) {
        const totalSeconds = Math.max(0, Math.round(Number(seconds) || 0));
        if (totalSeconds < 60) return `${totalSeconds}초`;
        return formatDuration(totalSeconds);
    }

    function formatWatchInfo(watchInfo) {
        if (!watchInfo || watchInfo.seconds <= 0) return "0분 (0%)";
        return `${formatWatchDuration(watchInfo.seconds)} (${formatWatchPercent(watchInfo.percent)})`;
    }

    async function fetchVideoDetail(videoNo) {
        if (videoDetailCache.has(videoNo)) {
            const cached = videoDetailCache.get(videoNo);
            touchMapEntry(videoDetailCache, videoNo, cached, MAX_VIDEO_DETAIL_CACHE_ENTRIES);
            return cached;
        }

        const promise = fetchJson(`${VIDEO_DETAIL_API_BASE}/${encodeURIComponent(videoNo)}`, {
            headers: { Accept: "application/json" },
            timeoutMs: FETCH_TIMEOUT_MS,
        }).then((json) => json?.content || null).catch((error) => {
            videoDetailCache.delete(videoNo);
            throw error;
        });

        touchMapEntry(videoDetailCache, videoNo, promise, MAX_VIDEO_DETAIL_CACHE_ENTRIES);
        return promise;
    }

    function mergeVideoDetail(video, detail) {
        if (!video || !detail) return;

        const detailDuration = Number(detail.duration);
        if (Number.isFinite(detailDuration) && detailDuration > 0) {
            video.duration = detailDuration;
        }

        const title = normSpace(detail.videoTitle || detail.title || detail.liveTitle || "");
        if (title) video.title = title;

        const startText = pickVideoStartDateText(detail);
        const endText = pickVideoEndDateText(detail);
        const startedAt = parseChzzkDate(startText);
        const endedAt = parseChzzkDate(endText);

        if (startedAt) {
            video.startedAt = startedAt;
            video.startIsExact = true;
        }
        if (endedAt) video.endedAt = endedAt;
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

    async function hydrateVideoStartDetails(videos, monthInfo, channelId, token, tokenMap = loadingTokens) {
        const targets = videos.filter((video) => shouldFetchStartDetail(video, monthInfo));
        if (!targets.length) return;

        let index = 0;
        const workers = Array.from({ length: Math.min(DETAIL_FETCH_CONCURRENCY, targets.length) }, async () => {
            while (index < targets.length) {
                if (tokenMap.get(channelId) !== token) return;
                const video = targets[index++];
                try {
                    const detail = await fetchVideoDetail(video.videoNo);
                    if (tokenMap.get(channelId) !== token) return;
                    mergeVideoDetail(video, detail);
                } catch (_) {
                    // Fall back to publishDate - duration when the detail endpoint is unavailable.
                }
            }
        });

        await Promise.all(workers);
    }

    function replayOnly(video) {
        return !video.type || video.type.toUpperCase() === "REPLAY";
    }

    function getVideoEndMs(video) {
        if (!video) return null;
        if (video.endedAt) {
            const endMs = video.endedAt.getTime();
            if (Number.isFinite(endMs)) return endMs;
        }
        if (video.startedAt && Number.isFinite(video.duration)) {
            const startMs = video.startedAt.getTime();
            if (Number.isFinite(startMs)) return startMs + video.duration * 1000;
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
            startsByDate: {},
            startKeyIndex: {},
        };
    }

    function getCalendarMonthDisplayName(year, month) {
        const nowParts = getKstParts();
        return year === nowParts.year ? `${month}월` : `${year}년 ${month}월`;
    }

    function getMonthBroadcastSeconds(month) {
        return Object.values(month?.dailySeconds || {})
            .reduce((sum, seconds) => sum + Math.max(0, Number(seconds) || 0), 0);
    }

    function getMonthReplayCount(month) {
        return Object.values(month?.startsByDate || {})
            .reduce((sum, starts) => sum + (Array.isArray(starts) ? starts.length : 0), 0);
    }

    function getMonthAverageSeconds(month) {
        const broadcastDays = Math.max(0, Number(month?.broadcastDayCount) || 0);
        if (broadcastDays <= 0) return 0;
        return getMonthBroadcastSeconds(month) / broadcastDays;
    }

    function formatMonthBroadcastTotal(month) {
        return `총 방송 ${formatDuration(getMonthBroadcastSeconds(month))}`;
    }

    function updateWidgetMonthSummary(widget, month, state = null) {
        if (!widget || !month) return;

        const totalSeconds = getMonthBroadcastSeconds(month);
        const replayCount = getMonthReplayCount(month);
        const broadcastDays = Math.max(0, Number(month.broadcastDayCount) || 0);
        const monthName = getCalendarMonthDisplayName(month.year, month.month);
        const label = `${monthName} 방송: ${broadcastDays}일`;
        const value = `${formatDuration(getMonthAverageSeconds(month))}/일`;
        const limited = month.partial ? "+" : "";
        const meta = replayCount > 0
            ? `총 ${formatDuration(totalSeconds)} · ${replayCount}${limited}개 다시보기`
            : "다시보기 없음";

        setWidgetState(widget, state || (totalSeconds > 0 ? "ready" : "empty"), value, meta, label);
    }

    function updateWidgetMonthLoadingSummary(widget, year, month, state, value, meta) {
        if (!widget) return;
        setWidgetState(widget, state, value, meta, `${getCalendarMonthDisplayName(year, month)} 조회 중`);
    }

    function formatChannelMonthKey(channelId, year, month) {
        return `${channelId}:${formatMonthKey(year, month)}`;
    }

    function shiftMonth(year, month, delta) {
        const index = year * 12 + (month - 1) + delta;
        return {
            year: Math.floor(index / 12),
            month: (index % 12) + 1,
        };
    }

    function compareMonth(aYear, aMonth, bYear, bMonth) {
        return (aYear * 12 + aMonth) - (bYear * 12 + bMonth);
    }

    function isFutureMonth(year, month, nowMs = Date.now()) {
        const nowParts = getKstParts(nowMs);
        return compareMonth(year, month, nowParts.year, nowParts.month) > 0;
    }

    function getSelectedCalendarMonth(widget) {
        const year = Number(widget?.dataset?.calendarYear);
        const month = Number(widget?.dataset?.calendarMonth);
        if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
        return { year, month };
    }

    function setSelectedCalendarMonth(widget, year, month) {
        if (!widget) return;
        widget.dataset.calendarYear = String(year);
        widget.dataset.calendarMonth = String(month);
    }

    function resetSelectedCalendarMonth(widget) {
        if (!widget) return;
        delete widget.dataset.calendarYear;
        delete widget.dataset.calendarMonth;
    }

    function cacheMonthInfo(channelId, monthInfo) {
        if (!channelId || !monthInfo) return;
        touchMapEntry(channelMonthCache, formatChannelMonthKey(channelId, monthInfo.year, monthInfo.month), {
            month: monthInfo,
            fetchedAt: Date.now(),
        }, MAX_MONTH_CACHE_ENTRIES);
    }

    function getCachedMonthInfo(channelId, year, month) {
        const key = formatChannelMonthKey(channelId, year, month);
        const cached = channelMonthCache.get(key);
        if (!cached) return null;
        touchMapEntry(channelMonthCache, key, cached, MAX_MONTH_CACHE_ENTRIES);
        return cached.month || null;
    }

    function formatKstMonthDay(ms) {
        const parts = getKstParts(ms);
        return `${parts.month}/${parts.day}`;
    }

    function addMonthStart(video, monthInfo, nowMs) {
        const startMs = getVideoStartMs(video);
        if (startMs === null || startMs < monthInfo.startMs || startMs >= monthInfo.nextStartMs || startMs > nowMs) {
            return;
        }

        const key = getKstDateKey(startMs);
        const startKey = `${key}-${Math.floor(startMs / 60000)}`;
        const duration = Number(video.duration) || 0;
        if (duration <= 0) return;
        const endMs = getVideoEndMs(video) ?? (startMs + duration * 1000);
        const title = normSpace(video.title);
        const titleKey = normalizeMatchText(title);

        const existing = monthInfo.startKeyIndex[startKey];
        if (existing) {
            monthInfo.dailySeconds[key] = (monthInfo.dailySeconds[key] || 0) + duration;
            existing.duration += duration;
            existing.endMs = Math.max(existing.endMs || 0, endMs);
            existing.videoNos.push(video.videoNo);
            if (title && !existing.title) existing.title = title;
            if (titleKey && !existing.titleKey) existing.titleKey = titleKey;
            return;
        }

        monthInfo.dailySeconds[key] = (monthInfo.dailySeconds[key] || 0) + duration;
        monthInfo.startsByDate[key] = monthInfo.startsByDate[key] || [];
        const entry = {
            time: formatKstClock(startMs),
            startMs,
            endMs,
            duration,
            exact: video.startIsExact === true,
            videoNos: [video.videoNo],
            title,
            titleKey,
        };
        monthInfo.startsByDate[key].push(entry);
        monthInfo.startKeyIndex[startKey] = entry;
    }

    function finalizeMonthInfo(monthInfo) {
        monthInfo.broadcastDayCount = Object.values(monthInfo.dailySeconds)
            .filter((seconds) => seconds >= MINUTE_SECONDS)
            .length;
        return monthInfo;
    }

    async function calculateCalendarMonth(channelId, year, month, token) {
        const now = Date.now();
        const monthInfo = getKstMonthInfo(now, year, month);
        const seen = new Set();
        let pagesLoaded = 0;
        let reachedOlderThanMonth = false;
        const maxCalendarPages = getMaxCalendarPages();

        for (let page = 0; page < maxCalendarPages; page++) {
            if (calendarLoadingTokens.get(channelId) !== token) return null;

            const json = await fetchVideoPageCached(channelId, page);
            const videos = extractVideos(json);
            await hydrateVideoStartDetails(videos, monthInfo, channelId, token, calendarLoadingTokens);
            pagesLoaded++;

            for (const video of videos) {
                if (seen.has(video.videoNo) || !replayOnly(video)) continue;
                seen.add(video.videoNo);
                addMonthStart(video, monthInfo, now);
            }

            reachedOlderThanMonth = videos.length > 0 &&
                videos.every((video) => {
                    const endMs = getVideoEndMs(video);
                    return endMs !== null && endMs < monthInfo.startMs;
                });

            if (isLastPage(json, videos, PAGE_SIZE) || (page > 0 && reachedOlderThanMonth)) break;
        }

        monthInfo.pagesLoaded = pagesLoaded;
        monthInfo.partial = pagesLoaded >= maxCalendarPages && !reachedOlderThanMonth;
        return finalizeMonthInfo(monthInfo);
    }

    async function calculateStats(channelId, token) {
        const now = Date.now();
        const windowDays = getWindowDays();
        const windowStart = now - getWindowMs();
        const maxPages = getMaxPages();
        const seen = new Set();
        let totalSeconds = 0;
        let replayCount = 0;
        let pagesLoaded = 0;
        let oldestEndMs = Number.POSITIVE_INFINITY;
        const monthInfo = getKstMonthInfo(now);
        const oldestNeededMs = Math.min(windowStart, monthInfo.startMs);

        for (let page = 0; page < maxPages; page++) {
            if (loadingTokens.get(channelId) !== token) return null;

            const json = await fetchVideoPageCached(channelId, page);
            const videos = extractVideos(json);
            await hydrateVideoStartDetails(videos, monthInfo, channelId, token);
            pagesLoaded++;

            for (const video of videos) {
                if (seen.has(video.videoNo) || !replayOnly(video)) continue;
                seen.add(video.videoNo);

                const endMs = getVideoEndMs(video);
                if (endMs === null) continue;

                oldestEndMs = Math.min(oldestEndMs, endMs);
                const overlapSeconds = estimateOverlapSeconds(video, windowStart, now);
                if (overlapSeconds >= MINUTE_SECONDS) {
                    totalSeconds += overlapSeconds;
                    replayCount++;
                }

                addMonthStart(video, monthInfo, now);
            }

            const pageIsOlderThanWindow = videos.length > 0 &&
                videos.every((video) => {
                    const endMs = getVideoEndMs(video);
                    return endMs !== null && endMs < oldestNeededMs;
                });
            if (isLastPage(json, videos, PAGE_SIZE) || (page > 0 && pageIsOlderThanWindow)) break;
        }

        finalizeMonthInfo(monthInfo);

        return {
            totalSeconds,
            averageSecondsPerDay: totalSeconds / windowDays,
            replayCount,
            pagesLoaded,
            complete: oldestEndMs < windowStart || pagesLoaded < maxPages,
            month: {
                ...monthInfo,
            },
            fetchedAt: now,
        };
    }

    async function loadStats(channelId) {
        const cached = channelStatsCache.get(channelId);
        if (cached && Date.now() - cached.fetchedAt < REFRESH_MS) {
            touchMapEntry(channelStatsCache, channelId, cached, MAX_STATS_CACHE_CHANNELS);
            renderCachedStats(document.getElementById(WIDGET_ID), channelId);
            return;
        }

        const token = Symbol(channelId);
        loadingTokens.set(channelId, token);

        try {
            const stats = await calculateStats(channelId, token);
            if (!stats || loadingTokens.get(channelId) !== token) return;
            touchMapEntry(channelStatsCache, channelId, stats, MAX_STATS_CACHE_CHANNELS);
            loadingTokens.delete(channelId);
            renderCachedStats(document.getElementById(WIDGET_ID), channelId);
        } catch (error) {
            if (loadingTokens.get(channelId) !== token) return;
            loadingTokens.delete(channelId);
            const widget = document.getElementById(WIDGET_ID);
            if (widget && currentChannelId === channelId) {
                setWidgetState(widget, "error", "계산 실패", error?.message || "다시 시도 예정");
            }
        }
    }

    function renderCachedStats(widget, channelId) {
        if (!widget || currentChannelId !== channelId) return;

        const stats = channelStatsCache.get(channelId);
        if (!stats) {
            if (loadingTokens.has(channelId)) setWidgetState(widget, "loading");
            return;
        }

        cacheMonthInfo(channelId, stats.month);

        if (stats.replayCount <= 0 || stats.totalSeconds <= 0) {
            setSelectedCalendarMonth(widget, stats.month.year, stats.month.month);
            updateWidgetMonthSummary(widget, stats.month, "empty");
            renderCalendar(widget, stats.month);
            return;
        }

        if (!isCalendarEnabled()) {
            const average = formatDuration(stats.averageSecondsPerDay);
            const total = formatDuration(stats.totalSeconds);
            const limited = stats.complete ? "" : "+";
            const monthCount = stats.month?.broadcastDayCount || 0;
            const meta = `총 ${total} · ${stats.replayCount}${limited}개 다시보기`;
            setWidgetState(widget, "ready", `${average}/일`, meta, `이번 달 ${monthCount}일`);
            return;
        }

        const selected = getSelectedCalendarMonth(widget);
        if (!selected) {
            setSelectedCalendarMonth(widget, stats.month.year, stats.month.month);
            updateWidgetMonthSummary(widget, stats.month);
            renderCalendar(widget, stats.month);
            return;
        }

        const selectedMonth = getCachedMonthInfo(channelId, selected.year, selected.month);
        if (selectedMonth) {
            updateWidgetMonthSummary(widget, selectedMonth);
            if (widget.dataset.watchHistoryDirty === "1" && isCalendarInteractionActive(widget)) {
                updateCalendarNav(widget, selectedMonth.year, selectedMonth.month);
                return;
            }
            renderCalendar(widget, selectedMonth);
        }
    }

    async function navigateCalendarMonth(widget, delta) {
        if (!isCalendarEnabled()) return;
        if (!widget || !delta || !currentChannelId) return;
        const selected = getSelectedCalendarMonth(widget) || getKstMonthInfo(Date.now());
        const next = shiftMonth(selected.year, selected.month, delta);
        if (isFutureMonth(next.year, next.month)) return;

        setSelectedCalendarMonth(widget, next.year, next.month);
        const cached = getCachedMonthInfo(currentChannelId, next.year, next.month);
        if (cached) {
            renderCalendar(widget, cached);
            return;
        }

        await loadCalendarMonth(widget, currentChannelId, next.year, next.month);
    }

    async function loadCalendarMonth(widget, channelId, year, month) {
        if (!widget || !channelId) return;
        const token = Symbol(`${channelId}:${formatMonthKey(year, month)}`);
        calendarLoadingTokens.set(channelId, token);
        renderCalendarLoading(widget, year, month);

        try {
            const monthInfo = await calculateCalendarMonth(channelId, year, month, token);
            if (!monthInfo || calendarLoadingTokens.get(channelId) !== token) return;
            calendarLoadingTokens.delete(channelId);
            cacheMonthInfo(channelId, monthInfo);

            const selected = getSelectedCalendarMonth(widget);
            if (selected && selected.year === year && selected.month === month) {
                renderCalendar(widget, monthInfo);
            }
        } catch (_) {
            if (calendarLoadingTokens.get(channelId) !== token) return;
            calendarLoadingTokens.delete(channelId);
            renderCalendarError(widget, year, month);
        }
    }

    function renderCalendarLoading(widget, year, month) {
        if (!isCalendarEnabled()) return;
        const calendar = widget?.querySelector(".bcmb-calendar");
        const monthEl = widget?.querySelector(".bcmb-calendar-month");
        const countEl = widget?.querySelector(".bcmb-calendar-count");
        const footEl = widget?.querySelector(".bcmb-calendar-foot");
        const daysEl = widget?.querySelector(".bcmb-days");
        if (widget) delete widget.dataset.calendarRenderKey;
        if (calendar) calendar.setAttribute("data-loading", "1");
        if (monthEl) monthEl.textContent = `${year}.${String(month).padStart(2, "0")}`;
        if (countEl) countEl.textContent = "불러오는 중";
        if (daysEl) renderBlankCalendarDays(daysEl, getKstMonthInfo(Date.now(), year, month));
        if (footEl) footEl.textContent = "과거 다시보기 기록 조회 중";
        updateWidgetMonthLoadingSummary(widget, year, month, "loading", "계산 중", "과거 다시보기 기록 조회 중");
        updateCalendarNav(widget, year, month);
    }

    function renderCalendarError(widget, year, month) {
        if (!isCalendarEnabled()) return;
        const calendar = widget?.querySelector(".bcmb-calendar");
        const monthEl = widget?.querySelector(".bcmb-calendar-month");
        const countEl = widget?.querySelector(".bcmb-calendar-count");
        const footEl = widget?.querySelector(".bcmb-calendar-foot");
        if (widget) delete widget.dataset.calendarRenderKey;
        if (calendar) calendar.setAttribute("data-loading", "0");
        if (monthEl) monthEl.textContent = `${year}.${String(month).padStart(2, "0")}`;
        if (countEl) countEl.textContent = "조회 실패";
        if (footEl) footEl.textContent = "잠시 후 다시 시도";
        setWidgetState(widget, "error", "조회 실패", "잠시 후 다시 시도", `${getCalendarMonthDisplayName(year, month)} 조회 실패`);
        updateCalendarNav(widget, year, month);
    }

    function updateCalendarNav(widget, year, month) {
        if (!widget) return;
        const loading = widget.querySelector(".bcmb-calendar")?.getAttribute("data-loading") === "1";
        const prev = widget.querySelector('[data-bcmb-nav="-1"]');
        const next = widget.querySelector('[data-bcmb-nav="1"]');
        if (prev) prev.disabled = loading;
        if (next) {
            const shifted = shiftMonth(year, month, 1);
            next.disabled = loading || isFutureMonth(shifted.year, shifted.month);
        }
    }

    function renderBlankCalendarDays(daysEl, month) {
        if (!daysEl || !month) return;
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < month.firstWeekday; i++) {
            const empty = document.createElement("span");
            empty.className = "bcmb-day";
            empty.setAttribute("aria-hidden", "true");
            fragment.appendChild(empty);
        }
        for (let day = 1; day <= month.daysInMonth; day++) {
            const item = document.createElement("span");
            item.className = "bcmb-day";
            item.textContent = String(day);
            item.setAttribute("data-date-key", formatDateKey({ year: month.year, month: month.month, day }));
            item.setAttribute("aria-label", `${month.month}월 ${day}일 조회 중`);
            fragment.appendChild(item);
        }
        daysEl.replaceChildren(fragment);
    }

    function getCalendarDayInfo(month, key) {
        const starts = Array.isArray(month.startsByDate?.[key])
            ? [...month.startsByDate[key]].sort(
                  (a, b) =>
                      Number(a.startMs || 0) - Number(b.startMs || 0) || String(a.time).localeCompare(String(b.time))
              )
            : [];
        const seconds = Math.round(
            Number(month.dailySeconds?.[key]) ||
                starts.reduce((sum, start) => sum + Math.max(0, Number(start.duration) || 0), 0)
        );

        return {
            hasBroadcast: starts.length > 0 || seconds > 0,
            seconds,
            starts,
        };
    }

    function buildCalendarRenderKey(month) {
        const dailyKey = Object.entries(month.dailySeconds || {})
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, seconds]) => `${key}:${Math.round(Number(seconds) || 0)}`)
            .join("|");
        const startKey = Object.entries(month.startsByDate || {})
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, starts]) => {
                const rows = Array.isArray(starts) ? starts : [];
                return `${key}:${rows.map((start) => [
                    start.startMs || 0,
                    start.endMs || 0,
                    Math.round(Number(start.duration) || 0),
                    start.exact ? 1 : 0,
                    (start.videoNos || []).join(","),
                ].join("/")).join(";")}`;
            })
            .join("|");
        const watchKey = buildCalendarWatchRenderKey(month);

        return [
            currentChannelId || "",
            month.year,
            month.month,
            month.pagesLoaded || 0,
            month.partial ? 1 : 0,
            month.broadcastDayCount || 0,
            watchKey,
            dailyKey,
            startKey,
        ].join("::");
    }

    function buildCalendarWatchRenderKey(month) {
        const totalWatchKey = Math.round(getChannelWatchSeconds(currentChannelId));
        const startWatchKey = Object.entries(month?.startsByDate || {})
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, starts]) => {
                const rows = Array.isArray(starts) ? [...starts] : [];
                rows.sort((a, b) => Number(a.startMs || 0) - Number(b.startMs || 0));
                return `${key}:${rows.map((start) => {
                    const watchInfo = getStartWatchInfo(currentChannelId, start);
                    return `${start.startMs || 0}/${formatWatchInfo(watchInfo)}`;
                }).join(";")}`;
            })
            .join("|");
        return `${totalWatchKey}|${startWatchKey}`;
    }

    function renderCalendar(widget, month, { force = false } = {}) {
        if (!isCalendarEnabled()) return;
        if (!widget || !month) return;
        ensureWatchHistoryLoaded();

        const calendar = widget.querySelector(".bcmb-calendar");
        const monthEl = widget.querySelector(".bcmb-calendar-month");
        const countEl = widget.querySelector(".bcmb-calendar-count");
        const weekdaysEl = widget.querySelector(".bcmb-weekdays");
        const daysEl = widget.querySelector(".bcmb-days");
        const footEl = widget.querySelector(".bcmb-calendar-foot");
        if (!monthEl || !countEl || !weekdaysEl || !daysEl || !footEl) return;
        if (calendar) calendar.setAttribute("data-loading", "0");

        const renderKey = buildCalendarRenderKey(month);
        if (!force && widget.dataset.calendarRenderKey === renderKey) {
            delete widget.dataset.watchHistoryDirty;
            updateCalendarNav(widget, month.year, month.month);
            return;
        }
        widget.dataset.calendarRenderKey = renderKey;
        delete widget.dataset.watchHistoryDirty;
        updateWidgetMonthSummary(widget, month);

        monthEl.textContent = `${month.year}.${String(month.month).padStart(2, "0")}`;
        countEl.textContent = formatMonthBroadcastTotal(month);
        updateCalendarNav(widget, month.year, month.month);

        if (!weekdaysEl.children.length) {
            const weekdayFragment = document.createDocumentFragment();
            for (const label of WEEKDAY_LABELS) {
                const item = document.createElement("span");
                item.className = "bcmb-weekday";
                item.textContent = label;
                weekdayFragment.appendChild(item);
            }
            weekdaysEl.appendChild(weekdayFragment);
        }

        const fragment = document.createDocumentFragment();
        for (let i = 0; i < month.firstWeekday; i++) {
            const empty = document.createElement("span");
            empty.className = "bcmb-day";
            empty.setAttribute("aria-hidden", "true");
            fragment.appendChild(empty);
        }

        for (let day = 1; day <= month.daysInMonth; day++) {
            const parts = { year: month.year, month: month.month, day };
            const key = formatDateKey(parts);
            const dayInfo = getCalendarDayInfo(month, key);
            const { hasBroadcast, seconds, starts } = dayInfo;
            const item = document.createElement("span");
            item.className = "bcmb-day";
            item.textContent = String(day);
            item.setAttribute("data-date-key", key);

            if (month.today > 0 && day === month.today) item.setAttribute("data-today", "1");
            if (month.today > 0 && day > month.today) item.setAttribute("data-future", "1");

            if (hasBroadcast) {
                const hasWatchedStart = starts.some((start) => {
                    const watchInfo = getStartWatchInfo(currentChannelId, start);
                    return watchInfo && watchInfo.seconds > 0;
                });
                item.setAttribute("data-has-broadcast", "1");
                item.setAttribute("data-live", "1");
                item.setAttribute("data-level", getCalendarLevel(seconds));
                if (hasWatchedStart) item.setAttribute("data-watch", "1");
                if (starts.length) {
                    item.tabIndex = 0;
                    const tip = document.createElement("span");
                    tip.className = "bcmb-day-tip";
                    tip.appendChild(buildDayTipContent(month, day, starts));
                    item.appendChild(tip);
                    item.setAttribute("aria-label", `${month.month}월 ${day}일 ${buildDayAriaLabel(starts)}`);
                } else {
                    item.setAttribute("aria-label", `${month.month}월 ${day}일 방송 기록 있음`);
                }
            } else {
                item.setAttribute("aria-label", `${month.month}월 ${day}일 방송 없음`);
            }
            fragment.appendChild(item);
        }

        daysEl.replaceChildren(fragment);
        renderCalendarFoot(footEl, month);
    }

    function renderCalendarFoot(footEl, month) {
        const noteEl = document.createElement("span");
        noteEl.className = "bcmb-calendar-foot-note";
        noteEl.textContent = month.partial ? "일부 기록만 표시됨" : "방송 시작일 기준 · KST";

        const totalEl = document.createElement("span");
        totalEl.className = "bcmb-calendar-watch-total";
        totalEl.textContent = `내 시청 시간 ${formatDuration(getChannelWatchSeconds(currentChannelId))}`;

        footEl.replaceChildren(noteEl, totalEl);
    }

    function buildDayTipContent(month, day, starts) {
        const fragment = document.createDocumentFragment();
        const title = document.createElement("span");
        title.className = "bcmb-day-tip-title";
        title.textContent = `${month.month}월 ${day}일 방송`;
        fragment.appendChild(title);

        for (const start of starts) {
            const item = document.createElement("span");
            item.className = "bcmb-day-tip-item";

            const startText = `${start.time}${start.exact ? "" : " 추정"}`;
            const endText = start.endMs
                ? `${formatKstClock(start.endMs)}${formatKstMonthDay(start.endMs) !== `${month.month}/${day}` ? ` (${formatKstMonthDay(start.endMs)})` : ""}`
                : "종료 미상";
            const durationText = formatDuration(start.duration);
            const broadcastText = `${startText} - ${endText} · ${durationText}`;
            const watchInfo = getStartWatchInfo(currentChannelId, start);

            appendTipRow(item, "방송", broadcastText, "broadcast");
            appendTipRow(item, "내 시청", formatWatchInfo(watchInfo), "watch");
            fragment.appendChild(item);
        }

        return fragment;
    }

    function appendTipRow(parent, label, value, type = "") {
        const row = document.createElement("span");
        row.className = `bcmb-day-tip-row${type ? ` bcmb-day-tip-row-${type}` : ""}`;
        if (type) row.setAttribute("data-tip-row", type);

        const labelEl = document.createElement("span");
        labelEl.className = "bcmb-day-tip-label";
        labelEl.textContent = label;

        const valueEl = document.createElement("span");
        valueEl.className = "bcmb-day-tip-value";
        valueEl.textContent = value;

        row.append(labelEl, valueEl);
        parent.appendChild(row);
    }

    function buildDayAriaLabel(starts) {
        return starts.map((start) => {
            const endText = start.endMs ? formatKstClock(start.endMs) : "알 수 없음";
            const watchInfo = getStartWatchInfo(currentChannelId, start);
            return `${start.time} 시작, ${endText} 종료, ${formatDuration(start.duration)} 진행, 내 시청 ${formatWatchInfo(watchInfo)}`;
        }).join(", ");
    }

    function formatDuration(seconds) {
        const totalMinutes = Math.max(0, Math.round(Number(seconds) / 60));
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        if (hours <= 0) return `${minutes}분`;
        if (minutes <= 0) return `${hours}시간`;
        return `${hours}시간 ${minutes}분`;
    }

    function getCalendarLevel(seconds) {
        if (seconds >= 8 * 60 * 60) return "3";
        if (seconds >= 3 * 60 * 60) return "2";
        return "1";
    }

    function isOurNode(node) {
        if (!node || node.nodeType !== 1) return false;
        if (node.id === WIDGET_ID || node.id === STYLE_ID) return true;
        if (typeof node.closest === "function") {
            return Boolean(node.closest(`#${WIDGET_ID}`));
        }
        return false;
    }

    function isOurMutation(mutation) {
        if (isOurNode(mutation.target)) return true;
        const added = mutation.addedNodes ? Array.from(mutation.addedNodes) : [];
        const removed = mutation.removedNodes ? Array.from(mutation.removedNodes) : [];
        if (!added.length && !removed.length) {
            return mutation.type === "attributes" && mutation.attributeName === HOST_ATTR;
        }
        return [...added, ...removed].every((node) => isOurNode(node) || node.nodeType !== 1);
    }

    function hasActiveWidgetForCurrentRoute() {
        return Boolean(currentChannelId && currentChannelId === getChannelIdFromUrl() && document.getElementById(WIDGET_ID));
    }

    function mutationShouldSchedule(mutation) {
        if (isOurMutation(mutation)) return false;

        if (hasActiveWidgetForCurrentRoute() && mutation.type === "attributes") {
            return mutation.target === document.body || mutation.target === document.documentElement;
        }

        return true;
    }

    function schedule() {
        if (!isFeatureEnabled()) {
            removeWidgetIfMounted();
            return;
        }
        if (!isChannelRoute()) {
            removeWidgetIfMounted();
            return;
        }
        if (scheduled) return;
        scheduled = true;
        const run = () => {
            if (!scheduled) return;
            scheduled = false;
            if (scheduleFallbackTimer) {
                window.clearTimeout(scheduleFallbackTimer);
                scheduleFallbackTimer = 0;
            }
            mountWidget();
        };

        requestAnimationFrame(run);
        scheduleFallbackTimer = window.setTimeout(run, 180);
    }

    function startObserver() {
        if (observer) return;
        observer = createMutationObserverSync({
            target: () => document.body || document.documentElement,
            options: {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["class", "style", "hidden", HOST_ATTR],
            },
            onMutations: () => {
                const channelRoute = isChannelRoute();
                if (location.href !== lastUrl) {
                    lastUrl = location.href;
                    if (channelRoute) removeWidget();
                    else removeWidgetIfMounted();
                }
            },
            shouldSchedule: (mutations) => isFeatureEnabled() && isChannelRoute() && mutations.some(mutationShouldSchedule),
            schedule,
        });
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
        window.addEventListener("resize", schedule, true);
    }

    function uninstallRouteListeners() {
        if (!routeListenersInstalled) return;
        routeListenersInstalled = false;
        if (removePageChangeDetection) {
            removePageChangeDetection();
            removePageChangeDetection = null;
        }
        window.removeEventListener("resize", schedule, true);
    }

    function handleWatchHistoryStorageChange(changes, areaName) {
        if (areaName !== "local" || !changes[WATCH_HISTORY_STORAGE_KEY]) return;
        watchHistoryEntries = normalizeWatchHistory(changes[WATCH_HISTORY_STORAGE_KEY].newValue);
        watchHistoryLoaded = true;
        scheduleWatchHistoryRerender({ deferWhenVisible: true });
    }

    function installStorageListener() {
        if (removeStorageChangeListener) return;
        removeStorageChangeListener = startStorageChangeListener(handleWatchHistoryStorageChange);
    }

    function uninstallStorageListener() {
        if (!removeStorageChangeListener) return;
        removeStorageChangeListener();
        removeStorageChangeListener = null;
    }

    function clearRuntimeTimers() {
        scheduled = false;
        if (scheduleFallbackTimer) {
            window.clearTimeout(scheduleFallbackTimer);
            scheduleFallbackTimer = 0;
        }
        if (watchHistoryRerenderTimer) {
            window.clearTimeout(watchHistoryRerenderTimer);
            watchHistoryRerenderTimer = 0;
        }
    }

    function installRuntime() {
        if (runtimeInstalled) return;
        runtimeInstalled = true;
        installRouteListeners();
        installStorageListener();
        startObserver();
        refreshWatchHistory({ rerender: false });
        schedule();
    }

    function teardownRuntime() {
        runtimeInstalled = false;
        clearRuntimeTimers();
        stopObserver();
        uninstallRouteListeners();
        uninstallCalendarCloseListener();
        uninstallStorageListener();
        removeWidgetIfMounted();
    }

    function applyOptions(options) {
        const prev = featureOptions;
        featureOptions = options;
        if (
            prev.monthlyBroadcastTimeWindowDays !== options.monthlyBroadcastTimeWindowDays ||
            prev.monthlyBroadcastTimeMaxPages !== options.monthlyBroadcastTimeMaxPages ||
            prev.monthlyBroadcastTimeMaxCalendarPages !== options.monthlyBroadcastTimeMaxCalendarPages
        ) {
            channelStatsCache.clear();
            channelMonthCache.clear();
            channelVideoPageCache.clear();
            loadingTokens.clear();
            calendarLoadingTokens.clear();
        }

        if (!isFeatureEnabled()) {
            teardownRuntime();
            return;
        }

        installRuntime();

        if (!isChannelRoute()) {
            removeWidgetIfMounted();
            return;
        }

        const widget = document.getElementById(WIDGET_ID);
        if (widget) {
            widget.setAttribute("data-calendar-disabled", isCalendarEnabled() ? "0" : "1");
            if (!isCalendarEnabled()) setCalendarOpen(widget, false);
        }
        schedule();
    }

    bindFeatureOptions(applyOptions);

    onReady(() => {
        if (isFeatureEnabled()) installRuntime();
    });
})();
