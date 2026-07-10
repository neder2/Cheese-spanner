/**
 * features/categoryTools.js — 카테고리/전체 라이브 목록 페이지에 검색·필터 툴바와 팔로워/경과시간 배지를 주입한다.
 *
 * 동작 위치: /lives (전체 라이브) 및 /category/:categoryType/:categoryId/(lives|videos|clips) 라우트의 탭·정렬 줄.
 * 하는 일:
 *   - 탭/정렬 줄 옆에 검색 입력과 필터(팔로워 수, 조회수/시청자 수, 진행 시간 범위) 버튼이 있는 툴바를 DOM에 삽입한다.
 *   - Chzzk API(v1/v2 lives, videos, clips, channels)에서 메타데이터를 페이지네이션으로 받아 캐싱하고,
 *     검색어/필터 조건에 맞는 카드를 기존 DOM 카드를 템플릿 삼아 추가로 주입한 뒤 조건에 안 맞는 카드는 숨긴다.
 *   - 화면에 보이는 채널에 대해 팔로워 수를 조회해 프로필 이미지 옆에 배지로 표시하고, 라이브 카드에는
 *     방송 경과 시간 배지를 썸네일 위에 표시한다(1초 간격 갱신).
 *   - MutationObserver와 scroll 이벤트로 라우트 변화·무한 스크롤을 감지해 자동으로 다음 메타데이터 페이지를 불러온다.
 *   - 옵션 변경 시(bindFeatureOptions) 런타임을 설치/해체하고 배지·툴바 상태를 다시 동기화한다.
 * 의존: 전역 BetterChzzkSettings.normalizeOptions/bindFeatureOptions, 전역 BetterChzzk.utils
 *   (createMutationObserverSync, createThrottledDomSync, fetchJson, normSpace, normalizeCompact, onReady,
 *   setLoadingReason, sleep, startPageChangeDetection, touchMapEntry, injectStyleOnce).
 * 옵션 키: categoryToolsEnabled, categoryToolsMaxMetadataPages, categoryToolsHideGlobalTagSearch,
 *   categoryToolsFollowerBadgesEnabled, categoryToolsLiveElapsedEnabled,
 *   categoryToolsFollowerFilterPreset1~6, categoryToolsViewFilterPreset1~6, categoryToolsDurationFilterPreset1~6,
 *   categoryToolsFollowerFetchMaxPerPass, categoryToolsFollowerFetchConcurrency, categoryToolsFollowerFetchDelayMs.
 * DOM 마커: id betterchzzk-category-tools(바), betterchzzk-category-filter-menu(필터 메뉴),
 *   betterchzzk-category-tools-fallback(정렬 줄을 못 찾을 때 대체 호스트), betterchzzk-category-tools-style;
 *   data-bcgt-* 프리픽스 속성들(카드/주입/숨김/순서/배지 마킹용).
 * 구조 (위→아래 순서):
 *   - 상수/전역 상태, BetterChzzk.utils 구조분해, 옵션 게터 함수들.
 *   - 라우트 판별(getRoute/routeKey)과 탭 줄·정렬 줄·콘텐츠 좌표 탐색 함수들.
 *   - 카드 링크/그리드 탐색과 카드 엔트리 생성(findGrid, getCardEntries 등).
 *   - API URL 조립과 메타데이터 페이지 로드/병합(apiUrl, mergeMetadataPage, ensureMetadata).
 *   - 팔로워 수 캐시·조회(getFollowerCount)와 필터 상태 관리(followerFilter*, viewFilter*, durationFilter*).
 *   - 필터 프리셋 버튼/드래그 선택, 필터 메뉴 빌드(buildMenu)와 위치 계산(positionMenu).
 *   - 주입 카드 생성(buildInjectedCard/buildInjectedLiveCard)과 팔로워·경과시간 배지 동기화.
 *   - 툴바 빌드/마운트(buildToolbar, mountToolbar)와 메인 적용 루프(applyTools).
 *   - MutationObserver 설정(startObserver)과 전역 리스너 설치/해체, 런타임 설치/해체(installRuntime/teardownRuntime).
 *   - 옵션 변경 반영(applyOptions)과 초기 구동(bindFeatureOptions, onReady).
 */
(() => {
    const BAR_ID = "betterchzzk-category-tools";
    const MENU_ID = "betterchzzk-category-filter-menu";
    const GLOBAL_FALLBACK_ID = "betterchzzk-category-tools-fallback";
    const STYLE_ID = "betterchzzk-category-tools-style";
    const TABS_ATTR = "data-bcgt-tabs";
    const GLOBAL_SORT_ATTR = "data-bcgt-global-sort";
    const CARD_ATTR = "data-bcgt-card";
    const CARD_ID_ATTR = "data-bcgt-card-id";
    const INJECTED_ATTR = "data-bcgt-injected";
    const HIDE_ATTR = "data-bcgt-hide";
    const HIDDEN_TAG_SEARCH_ATTR = "data-bcgt-hidden-tag-search";
    const TAG_SEARCH_ANCHOR_ATTR = "data-bcgt-tag-search-anchor";
    const ORDER_ATTR = "data-bcgt-order";
    const EMPTY_ATTR = "data-bcgt-empty";
    const FOLLOWER_BADGE_ATTR = "data-bcgt-follower-badge";
    const FOLLOWER_BADGE_WRAP_ATTR = "data-bcgt-follower-wrap";
    const LIVE_ELAPSED_BADGE_ATTR = "data-bcgt-live-elapsed-badge";
    const LIVE_THUMB_HOST_ATTR = "data-bcgt-live-thumb-host";
    const API_BASE = "https://api.chzzk.naver.com/service";
    const API_PAGE_SIZE = 50;
    const MAX_FOLLOWER_CACHE_ENTRIES = 1000;
    const FOLLOWER_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
    const DEFAULT_PROFILE_IMAGE_URL =
        "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2080%2080'%3E%3Crect%20width='80'%20height='80'%20rx='40'%20fill='%23E7EAEE'/%3E%3Ccircle%20cx='40'%20cy='31'%20r='14'%20fill='%239DA5B6'/%3E%3Cpath%20d='M18%2068c3-15%2015-24%2022-24s19%209%2022%2024'%20fill='%239DA5B6'/%3E%3C/svg%3E";
    const FOLLOWER_FILTER_PRESET_KEYS = Object.freeze([
        "categoryToolsFollowerFilterPreset1",
        "categoryToolsFollowerFilterPreset2",
        "categoryToolsFollowerFilterPreset3",
        "categoryToolsFollowerFilterPreset4",
        "categoryToolsFollowerFilterPreset5",
        "categoryToolsFollowerFilterPreset6",
    ]);
    const VIEW_FILTER_PRESET_KEYS = Object.freeze([
        "categoryToolsViewFilterPreset1",
        "categoryToolsViewFilterPreset2",
        "categoryToolsViewFilterPreset3",
        "categoryToolsViewFilterPreset4",
        "categoryToolsViewFilterPreset5",
        "categoryToolsViewFilterPreset6",
    ]);
    const DURATION_FILTER_PRESET_KEYS = Object.freeze([
        "categoryToolsDurationFilterPreset1",
        "categoryToolsDurationFilterPreset2",
        "categoryToolsDurationFilterPreset3",
        "categoryToolsDurationFilterPreset4",
        "categoryToolsDurationFilterPreset5",
        "categoryToolsDurationFilterPreset6",
    ]);
    const SECONDS_PER_HOUR = 60 * 60;

    let currentQuery = "";
    let followerFilterMin = 0;
    let followerFilterMax = 0;
    let viewFilterMin = 0;
    let viewFilterMax = 0;
    let durationFilterMin = 0;
    let durationFilterMax = 0;
    let followerFilterCustom = "";
    let followerFilterMaxCustom = "";
    let viewFilterCustom = "";
    let viewFilterMaxCustom = "";
    let durationFilterCustom = "";
    let durationFilterMaxCustom = "";
    let observer = null;
    let applying = false;
    let applyQueued = false;
    let lastUrl = location.href;
    let lastRouteKey = "";
    let orderCounter = 0;
    let metadataKey = "";
    let metadataMap = new Map();
    let metadataLoading = null;
    let metadataNext = null;
    let metadataComplete = false;
    let metadataPagesLoaded = 0;
    let metadataSearchRunning = false;
    let metadataSearchToken = 0;
    let followerHydrateTimer = 0;
    let followerHydrationRefreshing = false;
    let followerHydrationQueued = false;
    let followerHydrationRunToken = 0;
    let lastFollowerRefreshRouteKey = "";
    let lastFollowerRefreshRows = [];
    let lastFollowerHydrateAt = 0;
    let menuPositionScheduled = false;
    let filterOptionDrag = null;
    let suppressNextOptionClick = false;
    let liveElapsedTimer = 0;
    let durationFilterRefreshTimer = 0;
    let featureOptions = BetterChzzkSettings.normalizeOptions();
    let viewFilterSnapshotKey = "";
    let viewFilterSnapshotIds = new Set();
    let viewFilterSnapshotOrder = new Map();
    let viewFilterSnapshotNextOrder = 0;
    let lastUserScrollAt = 0;
    let ignoreScrollTrackingUntil = 0;
    let lastMetadataApplyAt = 0;
    let lastListStateKey = "";
    let cachedGrid = null;
    let cachedGridKey = "";
    let runtimeInstalled = false;
    let globalListenersInstalled = false;
    let removePageChangeDetection = null;

    const METADATA_APPLY_INTERVAL_MS = 260;
    // 검색/필터 자동 탐색은 무한 스크롤처럼 동작한다: 한 번에 이 페이지 수만큼 읽고,
    // 화면을 채울 만큼 스크롤 여지가 생기면 멈췄다가 바닥 근처에서 이어서 탐색한다.
    const METADATA_BATCH_PAGES = 2;
    const AUTO_LOAD_BOTTOM_MARGIN_PX = 600;
    const AUTO_LOAD_APPLY_SETTLE_MS = 250;
    const AUTO_LOAD_SCROLL_THROTTLE_MS = 200;
    const BADGE_SCROLL_THROTTLE_MS = 700;
    const UI_YIELD_EVERY_ITEMS = 24;

    const followerCache = new Map();
    const followerInflight = new Map();
    const loadingReasons = new Set();
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        createThrottledDomSync,
        fetchJson,
        normSpace,
        normalizeCompact: normalize,
        onReady,
        setLoadingReason,
        sleep,
        startPageChangeDetection,
        touchMapEntry,
    } = BetterChzzk.utils;
    const scheduleThrottledApply = createThrottledDomSync(runScheduledApply, 160);

    function isFeatureEnabled() {
        return featureOptions.categoryToolsEnabled;
    }

    function areFollowerBadgesEnabled() {
        return isFeatureEnabled() && featureOptions.categoryToolsFollowerBadgesEnabled;
    }

    function areLiveElapsedBadgesEnabled() {
        return isFeatureEnabled() && featureOptions.categoryToolsLiveElapsedEnabled;
    }

    function shouldHideGlobalTagSearch() {
        return isFeatureEnabled() && featureOptions.categoryToolsHideGlobalTagSearch;
    }

    function getMaxMetadataPages() {
        return featureOptions.categoryToolsMaxMetadataPages;
    }

    function getFollowerFetchMaxPerPass() {
        return featureOptions.categoryToolsFollowerFetchMaxPerPass;
    }

    function getFollowerFetchConcurrency() {
        return featureOptions.categoryToolsFollowerFetchConcurrency;
    }

    function getFollowerFetchDelayMs() {
        return featureOptions.categoryToolsFollowerFetchDelayMs;
    }

    function getRoute() {
        if (/^\/lives\/?$/.test(location.pathname)) {
            return {
                scope: "global-lives",
                tab: "lives",
            };
        }

        const match = location.pathname.match(/^\/category\/([^/]+)\/([^/]+)\/(lives|videos|clips)\/?$/);
        if (!match) return null;
        return {
            scope: "category",
            categoryType: decodeURIComponent(match[1]),
            categoryId: decodeURIComponent(match[2]),
            tab: match[3],
        };
    }

    function routeKey(route) {
        if (!route) return "";
        if (route.scope === "global-lives") return "global-lives/lives";
        return `${route.categoryType}/${route.categoryId}/${route.tab}`;
    }

    function hasMountedTools() {
        return Boolean(
            document.getElementById(BAR_ID) ||
            document.getElementById(MENU_ID) ||
            document.getElementById(GLOBAL_FALLBACK_ID) ||
            document.querySelector(
                `[${CARD_ATTR}="1"],[${INJECTED_ATTR}="1"],[${EMPTY_ATTR}="1"],[${FOLLOWER_BADGE_ATTR}="1"],[${LIVE_ELAPSED_BADGE_ATTR}="1"]`
            )
        );
    }

    function removeToolsIfMounted() {
        if (hasMountedTools() || lastRouteKey || liveElapsedTimer || durationFilterRefreshTimer) removeTools();
    }

    function injectStyleOnce() {
        BetterChzzk.utils.injectStyleOnce(
            STYLE_ID,
            `
[${TABS_ATTR}="1"]{
  display:flex !important;
  align-items:center !important;
  flex-wrap:wrap !important;
  width:100% !important;
  overflow:visible !important;
}
[${GLOBAL_SORT_ATTR}="1"]{
  display:flex !important;
  align-items:center !important;
  flex-wrap:wrap !important;
  overflow:visible !important;
}
#${GLOBAL_FALLBACK_ID}{
  width:100%;
  margin:8px 0 12px;
  padding:0;
  box-sizing:border-box;
}
#${GLOBAL_FALLBACK_ID} #${BAR_ID}{margin-left:0;}
#${BAR_ID}{
  /* 치지직 디자인 토큰 참조(테마 자동 연동) + 토큰이 없을 때의 다크 기준 fallback */
  --bcgt-accent:var(--Content-Brand-Strong, #00FFA3);
  --bcgt-bg:var(--Surface-Neutral-Weakest, #111114);
  --bcgt-bg-hover:var(--Surface-Neutral-Strongest, #DFE2EA);
  --bcgt-bg-elev:var(--Surface-Neutral-Strongest, #DFE2EA);
  --bcgt-border:var(--Surface-Neutral-Weakest, #111114);
  --bcgt-border-strong:var(--Border-Neutral-Strong, #697183);
  --bcgt-text:var(--Content-Neutral-Cool-Base, #9DA5B6);
  --bcgt-text-strong:var(--Content-Neutral-Primary, #FFFFFF);
  --bcgt-text-hover:var(--Content-Neutral-Inverse, #111114);
  --bcgt-text-focus:var(--Content-Neutral-Inverse, #111114);
  --bcgt-text-dim:var(--Content-Neutral-Cool-Weak, #697183);
  --bcgt-font-family:inherit;
  --bcgt-font-size:13px;
  --bcgt-font-weight:400;
  --bcgt-line-height:16px;
  --bcgt-height:28px;
  --bcgt-radius:14px;

  position:relative;
  display:inline-flex;
  align-items:center;
  gap:6px;
  flex:1 1 auto;
  min-width:0;
  margin:0;
  padding:0;
  background:transparent;
  border:0;
  color:var(--bcgt-text);
  font-family:var(--bcgt-font-family);
  font-size:var(--bcgt-font-size);
  font-weight:var(--bcgt-font-weight);
  line-height:var(--bcgt-line-height);
  box-sizing:border-box;
  vertical-align:middle;
  z-index:20;
}
#${BAR_ID}[data-mode="inline"]{
  align-self:center;
  flex:0 0 auto;
  width:auto;
  max-width:100%;
  margin-left:auto;
}
#${BAR_ID}[data-mode="category-inline"]{
  align-self:center;
  flex:0 0 auto;
  width:auto;
  max-width:100%;
  margin-left:auto;
  margin-bottom:8px;
}
#${BAR_ID}[data-mode="inline"] .bcgt-input-wrap{width:220px;}
#${BAR_ID}[data-mode="category-inline"] .bcgt-input-wrap{width:220px;}
#${BAR_ID}[data-mode="inline"] .bcgt-filter-wrap{margin-left:0;}
#${BAR_ID}[data-mode="category-inline"] .bcgt-filter-wrap{margin-left:0;}
#${BAR_ID}[data-mode="global-inline"]{
  align-self:center;
  flex:0 0 auto;
  width:auto;
  max-width:100%;
  margin-left:12px;
}
#${BAR_ID}[data-mode="global-inline"][data-tag-search-hidden="0"]{
  margin-left:auto;
}
#${BAR_ID}[data-mode="global-inline"] .bcgt-input-wrap{width:220px;}
#${BAR_ID}[data-mode="global-inline"][data-tag-search-hidden="0"] .bcgt-input-wrap{width:200px;}
#${BAR_ID}[data-mode="global-inline"] .bcgt-filter-wrap{margin-left:0;}
[${TAG_SEARCH_ANCHOR_ATTR}="1"]{
  flex:0 0 auto !important;
  margin-left:12px !important;
}
#${BAR_ID} .bcgt-input-wrap{
  position:relative;
  flex:0 0 auto;
  width:220px;
  display:flex;
  align-items:center;
  height:var(--bcgt-height);
  padding:0 10px;
  background:var(--bcgt-bg);
  border:1px solid var(--bcgt-border);
  border-radius:var(--bcgt-radius);
  box-sizing:border-box;
  transition:border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease;
}
#${BAR_ID} .bcgt-input-wrap:hover{background:var(--bcgt-bg-hover);border-color:var(--bcgt-border-strong);}
#${BAR_ID} .bcgt-input-wrap:hover input[type="search"],
#${BAR_ID} .bcgt-input-wrap:hover .bcgt-icon,
#${BAR_ID} .bcgt-input-wrap:hover .bcgt-clear{color:var(--bcgt-text-hover);}
#${BAR_ID} .bcgt-input-wrap:focus-within{
  background:var(--bcgt-bg-elev);
  border-color:var(--bcgt-accent);
  box-shadow:0 0 0 1px var(--bcgt-accent);
  color:var(--bcgt-text-strong);
}
#${BAR_ID} .bcgt-input-wrap:focus-within input[type="search"],
#${BAR_ID} .bcgt-input-wrap:focus-within .bcgt-icon,
#${BAR_ID} .bcgt-input-wrap:focus-within .bcgt-clear{color:var(--bcgt-text-focus);}
#${BAR_ID} .bcgt-icon{width:14px;height:14px;flex:0 0 auto;opacity:0.75;margin-right:4px;color:currentColor;}
#${BAR_ID} .bcgt-input-wrap:focus-within .bcgt-icon{opacity:1;}
#${BAR_ID} input[type="search"]{
  flex:1 1 auto;min-width:0;height:100%;padding:0;margin:0;
  border:0;background:transparent;color:var(--bcgt-text-strong);font:inherit;outline:none;
  -webkit-appearance:none;appearance:none;
}
#${BAR_ID} input[type="search"]::-webkit-search-cancel-button{display:none;}
#${BAR_ID} input[type="search"]::placeholder{color:var(--bcgt-text-dim);}
#${BAR_ID} .bcgt-clear{
  display:none;flex:0 0 auto;width:18px;height:18px;margin-left:6px;
  border:0;background:transparent;color:var(--bcgt-text-dim);
  cursor:pointer;padding:0;border-radius:50%;
  align-items:center;justify-content:center;
}
#${BAR_ID} .bcgt-clear:hover{color:var(--bcgt-text-strong);background:var(--Surface-Interaction-Lighten-Hovered, rgba(255,255,255,0.06));}
#${BAR_ID}[data-has-query="1"] .bcgt-clear{display:inline-flex;}
#${BAR_ID} .bcgt-meter{
  display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;
  color:var(--bcgt-text-dim);white-space:nowrap;
  min-height:var(--bcgt-height);
}
#${BAR_ID} .bcgt-spinner{
  width:12px;height:12px;border-radius:50%;
  border:2px solid var(--Border-Neutral-Alpha-Weak, rgba(157,165,182,0.24));
  border-top-color:var(--bcgt-accent);
  animation:bcgt-spin 0.8s linear infinite;flex:0 0 auto;
  visibility:hidden;
}
#${BAR_ID}[data-loading="1"] .bcgt-spinner{visibility:visible;}
@keyframes bcgt-spin{to{transform:rotate(360deg);}}
#${BAR_ID} .bcgt-filter-wrap{position:relative;display:inline-flex;margin-left:auto;}
#${BAR_ID} .bcgt-filter{
  display:inline-flex;
  align-items:center;
  gap:5px;
  height:30px;
  padding:0 12px;
  border:1px solid var(--bcgt-border);
  border-radius:15px;
  background:var(--bcgt-bg);
  color:var(--bcgt-text);
  font:inherit;
  font-weight:700;
  cursor:pointer;
}
#${BAR_ID} .bcgt-filter:hover,
#${BAR_ID}[data-menu-open="1"] .bcgt-filter{
  background:var(--bcgt-bg-hover);
  border-color:var(--bcgt-border-strong);
  color:var(--bcgt-text-hover);
}
#${MENU_ID}{
  /* 메뉴는 BAR 밖 fixed 요소라 토큰 변수를 자체적으로 다시 참조한다(fallback은 다크 기준). */
  --bcgt-menu-bg:var(--Surface-Neutral-Weaker, #1B1D20);
  --bcgt-menu-border:var(--Border-Neutral-Alpha-Weak, rgba(157,165,182,0.24));
  --bcgt-menu-text:var(--Content-Neutral-Primary, #F2F4F7);
  --bcgt-menu-text-sub:var(--Content-Neutral-Cool-Base, #9DA5B6);
  --bcgt-menu-text-dim:var(--Content-Neutral-Cool-Weak, #697183);
  --bcgt-menu-hover:var(--Surface-Interaction-Lighten-Hovered, rgba(255,255,255,0.08));
  --bcgt-menu-field-bg:var(--Surface-Neutral-Weak, #24262A);
  --bcgt-menu-button-bg:var(--Surface-Neutral-Subtle, #24262A);
  --bcgt-menu-checked:var(--Content-Brand-Base, #00E693);
  --bcgt-menu-checked-bg:var(--Surface-Brand-Alpha-Weak, rgba(0,255,163,0.15));
  --bcgt-menu-brand-border:var(--Border-Brand-Alpha-Base, rgba(0,255,163,0.3));
  --bcgt-menu-brand-bg:var(--Surface-Brand-Weaker, #11382C);
  --bcgt-menu-disabled:var(--Content-Neutral-Cool-Weaker, #545A69);

  position:fixed;
  top:0;
  left:0;
  right:auto;
  display:none;
  width:560px;
  max-width:calc(100vw - 16px);
  padding:8px;
  border:1px solid var(--bcgt-menu-border);
  border-radius:8px;
  background:var(--bcgt-menu-bg);
  color:var(--bcgt-menu-text);
  box-shadow:0 10px 30px rgba(0,0,0,0.3);
  font-family:inherit;
  font-size:13px;
  line-height:16px;
  overflow-y:auto;
  transform-origin:bottom right;
  z-index:90;
}
#${MENU_ID}[data-open="1"]{display:block;}
#${MENU_ID} .bcgt-filter-groups{
  display:grid;
  grid-template-columns:minmax(0, 1fr) minmax(0, 1fr);
  gap:12px;
}
#${MENU_ID} .bcgt-filter-group{
  display:flex;
  min-width:0;
  flex-direction:column;
  gap:4px;
}
#${MENU_ID} .bcgt-filter-group[data-filter-group="duration"]{
  grid-column:1 / -1;
}
#${MENU_ID} .bcgt-filter-group[hidden]{display:none;}
#${MENU_ID} .bcgt-option-list{
  display:flex;
  min-width:0;
  flex-direction:column;
  gap:4px;
}
#${MENU_ID} [data-filter-options="duration"]{
  display:grid;
  grid-template-columns:repeat(4, minmax(0, 1fr));
}
#${MENU_ID} .bcgt-filter-title{
  padding:2px 8px 4px;
  color:var(--bcgt-menu-text-sub);
  font-size:12px;
  font-weight:800;
}
#${MENU_ID} .bcgt-option{
  display:flex;
  width:100%;
  height:28px;
  align-items:center;
  padding:0 10px;
  border:0;
  border-radius:6px;
  background:transparent;
  color:var(--bcgt-menu-text);
  font:inherit;
  font-weight:700;
  text-align:left;
  white-space:nowrap;
  cursor:pointer;
  user-select:none;
  touch-action:none;
}
#${MENU_ID} .bcgt-option:hover{background:var(--bcgt-menu-hover);}
#${MENU_ID} .bcgt-option[aria-checked="true"]{color:var(--bcgt-menu-checked);background:var(--bcgt-menu-checked-bg);}
#${MENU_ID} .bcgt-option[data-in-range="1"]{
  color:var(--bcgt-menu-checked);
  background:var(--bcgt-menu-checked-bg);
}
#${MENU_ID} .bcgt-option[data-range-edge="1"]{
  box-shadow:inset 0 0 0 1px var(--bcgt-menu-brand-border);
}
#${MENU_ID} .bcgt-custom{
  display:flex;
  align-items:center;
  gap:6px;
  min-width:0;
  height:34px;
  margin-top:4px;
  padding:0 10px;
  border:1px solid var(--bcgt-menu-border);
  border-radius:7px;
  background:var(--bcgt-menu-field-bg);
  color:var(--bcgt-menu-text);
  font:inherit;
  font-weight:700;
  box-sizing:border-box;
}
#${MENU_ID} .bcgt-custom[data-active="1"]{
  border-color:var(--bcgt-menu-brand-border);
  background:var(--bcgt-menu-checked-bg);
  color:var(--bcgt-menu-checked);
}
#${MENU_ID} .bcgt-custom span{
  flex:0 0 auto;
  color:inherit;
  white-space:nowrap;
}
#${MENU_ID} .bcgt-custom input{
  flex:1 1 auto;
  min-width:0;
  width:0;
  height:100%;
  margin:0;
  padding:0;
  border:0;
  outline:0;
  background:transparent;
  color:var(--bcgt-menu-text);
  font:inherit;
  font-weight:700;
}
#${MENU_ID} .bcgt-custom input::placeholder{color:var(--bcgt-menu-text-dim);}
#${MENU_ID} .bcgt-reset-row{
  display:flex;
  justify-content:flex-end;
  margin-top:10px;
  padding-top:8px;
  border-top:1px solid var(--bcgt-menu-border);
}
#${MENU_ID} .bcgt-reset{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  height:28px;
  padding:0 12px;
  border:1px solid var(--bcgt-menu-border);
  border-radius:6px;
  background:var(--bcgt-menu-button-bg);
  color:var(--bcgt-menu-text);
  font:inherit;
  font-weight:800;
  cursor:pointer;
}
#${MENU_ID} .bcgt-reset:hover:not(:disabled){
  border-color:var(--bcgt-menu-brand-border);
  background:var(--bcgt-menu-brand-bg);
}
#${MENU_ID} .bcgt-reset:disabled{
  color:var(--bcgt-menu-disabled);
  cursor:default;
  opacity:0.62;
}
@media (max-width: 520px){
  #${BAR_ID}[data-mode="global-inline"]{
    flex:1 1 100%;
    width:100%;
    margin:8px 0 0;
  }
  #${BAR_ID}[data-mode="global-inline"] .bcgt-input-wrap{
    flex:1 1 auto;
    width:auto;
    min-width:140px;
  }
  #${BAR_ID}[data-mode="global-inline"] .bcgt-filter-wrap{margin-left:auto;}
  #${MENU_ID}{
    width:calc(100vw - 16px);
    max-height:min(74vh, 560px);
  }
  #${MENU_ID} .bcgt-filter-groups{
    grid-template-columns:1fr;
  }
  #${MENU_ID} [data-filter-options="duration"]{
    grid-template-columns:repeat(2, minmax(0, 1fr));
  }
}
[${FOLLOWER_BADGE_WRAP_ATTR}="1"]{
  display:inline-flex !important;
  flex-direction:column !important;
  align-items:center !important;
  justify-content:flex-start !important;
  gap:2px !important;
  flex:0 0 auto !important;
  max-width:52px !important;
  vertical-align:top !important;
}
[${FOLLOWER_BADGE_ATTR}="1"]{
  display:inline-flex !important;
  align-items:center !important;
  justify-content:center !important;
  min-width:34px !important;
  max-width:48px !important;
  height:14px !important;
  padding:0 4px !important;
  border-radius:3px !important;
  background:#111827 !important;
  color:#DDE7F5 !important;
  font-family:"Sandoll Nemony2", "Apple SD Gothic NEO", "Helvetica Neue", Helvetica, "Malgun Gothic", "맑은 고딕", sans-serif !important;
  font-size:10px !important;
  font-weight:400 !important;
  line-height:14px !important;
  letter-spacing:0 !important;
  white-space:nowrap !important;
  box-sizing:border-box !important;
  overflow:hidden !important;
  text-overflow:ellipsis !important;
  pointer-events:none !important;
}
[${LIVE_THUMB_HOST_ATTR}="1"]{
  position:relative !important;
}
[${LIVE_ELAPSED_BADGE_ATTR}="1"]{
  position:absolute !important;
  right:8px !important;
  bottom:8px !important;
  display:inline-flex !important;
  align-items:center !important;
  justify-content:center !important;
  height:20px !important;
  min-width:48px !important;
  padding:0 7px !important;
  border-radius:4px !important;
  background:rgba(17,24,39,0.86) !important;
  color:#FFFFFF !important;
  font-family:inherit !important;
  font-size:12px !important;
  font-weight:700 !important;
  line-height:20px !important;
  letter-spacing:0 !important;
  white-space:nowrap !important;
  box-sizing:border-box !important;
  opacity:0 !important;
  transform:translateY(2px) !important;
  transition:opacity 120ms ease, transform 120ms ease !important;
  pointer-events:none !important;
  z-index:5 !important;
}
[${LIVE_THUMB_HOST_ATTR}="1"]:hover [${LIVE_ELAPSED_BADGE_ATTR}="1"],
[${LIVE_THUMB_HOST_ATTR}="1"]:focus-within [${LIVE_ELAPSED_BADGE_ATTR}="1"]{
  opacity:1 !important;
  transform:translateY(0) !important;
}
[${HIDE_ATTR}="1"]{display:none !important;}
[${HIDDEN_TAG_SEARCH_ATTR}="1"]{display:none !important;}
[${INJECTED_ATTR}="1"]{list-style:none;}
[${EMPTY_ATTR}="1"]{
  display:flex;
  align-items:center;
  justify-content:center;
  min-height:120px;
  color:var(--Content-Neutral-Cool-Weak, #697183);
  font:inherit;
  font-weight:700;
}
`
        );
    }

    function findTabLineByLabels(labels, minCount, minWidth) {
        const controls = Array.from(document.querySelectorAll("button, a")).filter((el) =>
            labels.includes(normSpace(el.textContent))
        );
        if (controls.length < minCount) return null;

        const counts = new Map();
        for (const control of controls) {
            let node = control.parentElement;
            let depth = 0;
            while (node && depth < 8) {
                counts.set(node, (counts.get(node) || 0) + 1);
                node = node.parentElement;
                depth++;
            }
        }

        let best = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const [node, count] of counts) {
            if (count < minCount) continue;
            const rect = node.getBoundingClientRect();
            if (rect.width < minWidth || rect.height < 24) continue;
            const score = count * 10000 - Math.round(rect.width * rect.height);
            if (score > bestScore) {
                best = node;
                bestScore = score;
            }
        }
        return best;
    }

    function findTabLine(route = getRoute()) {
        if (route?.scope === "global-lives") return null;
        return findTabLineByLabels(["라이브", "동영상", "클립"], 3, 180);
    }

    function findGlobalTabLine() {
        return findTabLineByLabels(["라이브", "동영상"], 2, 100);
    }

    function findGlobalSortLine(context = null) {
        const controls = getGlobalSortControls(context);
        if (controls.length < 3) return null;

        const counts = new Map();
        for (const control of controls) {
            let node = control.parentElement;
            let depth = 0;
            while (node && depth < 8) {
                counts.set(node, (counts.get(node) || 0) + 1);
                node = node.parentElement;
                depth++;
            }
        }

        let best = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const [node, count] of counts) {
            if (count < 3) continue;
            const rect = node.getBoundingClientRect();
            // 정렬 칩의 최소 공통 행만 허용한다. 전체 섹션을 잡으면 툴바가 카드 목록
            // 끝으로 밀리고 네이티브 탭 레이아웃까지 flex로 바뀐다.
            if (rect.width < 100 || rect.height < 24 || rect.height > 120) continue;
            const score = count * 10000 - Math.round(rect.width * rect.height);
            if (score > bestScore) {
                best = node;
                bestScore = score;
            }
        }
        return best;
    }

    function createApplyScanContext(route) {
        return {
            route,
            globalSortControls: null,
            globalSortKey: "",
            globalSortRect: undefined,
            tabLines: new Map(),
            contentLeft: undefined,
            tabBottom: undefined,
            cardLinksByRoot: new WeakMap(),
        };
    }

    function getContextTabLine(context, route = context?.route) {
        if (!context) return findTabLine(route);
        const key = route ? routeKey(route) : "";
        if (!context.tabLines.has(key)) context.tabLines.set(key, findTabLine(route));
        return context.tabLines.get(key);
    }

    function getGlobalSortControls(context = null) {
        if (context?.globalSortControls) return context.globalSortControls;
        const labels = ["인기", "최신", "추천"];
        const byLabel = new Map();
        for (const el of document.querySelectorAll("button, a, [role='button']")) {
            if (!(el instanceof HTMLElement)) continue;
            if (el.closest(`#${BAR_ID}`) || el.closest(`#${MENU_ID}`)) continue;
            const text = normSpace(el.textContent);
            if (!labels.includes(text)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || rect.top >= 220) continue;
            const candidate = { el, area: rect.width * rect.height };
            const existing = byLabel.get(text);
            if (!existing || candidate.area < existing.area) byLabel.set(text, candidate);
        }

        const controls = labels.map((label) => byLabel.get(label)?.el).filter(Boolean);
        if (context) context.globalSortControls = controls;
        return controls;
    }

    function rgbLuminance(value) {
        const match = String(value || "").match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
        if (!match) return null;
        const alpha = match[4] === undefined ? 1 : Number(match[4]);
        if (!Number.isFinite(alpha) || alpha <= 0) return null;
        const r = Number(match[1]);
        const g = Number(match[2]);
        const b = Number(match[3]);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    function activeGlobalSortScore(control) {
        if (!(control instanceof HTMLElement)) return 0;
        let score = 0;
        let node = control;
        let depth = 0;
        while (node instanceof HTMLElement && depth < 4) {
            if (node.getAttribute("aria-selected") === "true") score += 100;
            if (node.getAttribute("aria-current")) score += 100;
            if (/\b(active|selected|current|is_active|is-active)\b/i.test(String(node.className || ""))) score += 80;

            const style = getComputedStyle(node);
            const bgLum = rgbLuminance(style.backgroundColor);
            const textLum = rgbLuminance(style.color);
            if (bgLum !== null && bgLum < 80) score += 30;
            if (textLum !== null && textLum > 180) score += 8;
            if ((Number.parseInt(style.fontWeight, 10) || 0) >= 700) score += 2;

            node = node.parentElement;
            depth++;
        }
        return score;
    }

    function getGlobalSortKey(context = null) {
        if (context?.globalSortKey) return context.globalSortKey;
        const controls = getGlobalSortControls(context);
        const active = controls
            .map((control) => ({ control, score: activeGlobalSortScore(control) }))
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score)[0]?.control;
        const key = normSpace((active || controls[0])?.textContent) || "인기";
        if (context) context.globalSortKey = key;
        return key;
    }

    function listStateKey(route, context = null) {
        if (!route) return "";
        if (route.scope === "global-lives") return `${routeKey(route)}|sort:${getGlobalSortKey(context)}`;
        return routeKey(route);
    }

    function canUseMetadataForCurrentList(route, context = null) {
        if (!route) return false;
        if (route.scope !== "global-lives") return true;
        return getGlobalSortKey(context) === "인기";
    }

    function isGlobalSortClickTarget(target) {
        if (getRoute()?.scope !== "global-lives") return false;
        let node = target instanceof HTMLElement ? target : target?.parentElement;
        let depth = 0;
        while (node instanceof HTMLElement && depth < 5) {
            if (node.closest(`#${BAR_ID}`) || node.closest(`#${MENU_ID}`)) return false;
            if (["인기", "최신", "추천"].includes(normSpace(node.textContent))) return true;
            node = node.parentElement;
            depth++;
        }
        return false;
    }

    function handleGlobalSortClick(event) {
        if (!isGlobalSortClickTarget(event.target)) return;
        const route = getRoute();
        const grid = findGrid(route);
        if (grid) clearInjectedCards(grid);
        resetMetadata(routeKey(route));
        resetViewFilterSnapshot();
        clearFollowerHydrationTimer();
        clearLoading();
        lastListStateKey = "";
        scheduleApply();
    }

    function ensureGlobalFallbackHost(route) {
        const grid = findGrid(route);
        const parent = grid?.parentElement;
        if (!parent) return null;

        let fallback = document.getElementById(GLOBAL_FALLBACK_ID);
        if (!fallback) {
            fallback = document.createElement("div");
            fallback.id = GLOBAL_FALLBACK_ID;
        }
        fallback.setAttribute(GLOBAL_SORT_ATTR, "1");
        if (fallback.parentElement !== parent || fallback.nextSibling !== grid) {
            parent.insertBefore(fallback, grid);
        }
        return fallback;
    }

    function cleanupUnusedGlobalFallback(activeHost) {
        const fallback = document.getElementById(GLOBAL_FALLBACK_ID);
        if (!fallback || fallback === activeHost) return;
        if (fallback.contains(document.getElementById(BAR_ID))) return;
        fallback.remove();
    }

    function isElementVisibleOnPage(element) {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) return false;
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    }

    function rescueInvisibleGlobalToolbar(route, host, bar) {
        if (host?.id === GLOBAL_FALLBACK_ID) return;
        requestAnimationFrame(() => {
            if (getRoute()?.scope !== "global-lives") return;
            if (!bar.isConnected || bar.getAttribute("data-mode") !== "global-inline") return;
            if (isElementVisibleOnPage(bar)) return;

            const fallback = ensureGlobalFallbackHost(route);
            if (!fallback) return;
            fallback.appendChild(bar);
            cleanupUnusedGlobalFallback(fallback);
            syncFontWithHostUi(bar, fallback);
        });
    }

    function getUnionRect(elements) {
        const rects = elements
            .map((el) => el?.getBoundingClientRect?.())
            .filter((rect) => rect && rect.width > 0 && rect.height > 0);
        if (!rects.length) return null;
        const left = Math.min(...rects.map((rect) => rect.left));
        const top = Math.min(...rects.map((rect) => rect.top));
        const right = Math.max(...rects.map((rect) => rect.right));
        const bottom = Math.max(...rects.map((rect) => rect.bottom));
        return {
            left,
            top,
            right,
            bottom,
            width: right - left,
            height: bottom - top,
        };
    }

    function getGlobalSortRect(context = null) {
        if (context?.globalSortRect !== undefined) return context.globalSortRect;
        const controls = getGlobalSortControls(context);
        const rect = getUnionRect(controls);
        if (context) context.globalSortRect = rect;
        return rect;
    }

    function findGlobalTagSearch() {
        const inputs = Array.from(document.querySelectorAll("input")).filter((input) => {
            if (!(input instanceof HTMLElement)) return false;
            if (input.closest(`#${BAR_ID}`) || input.closest(`#${MENU_ID}`)) return false;
            const label = [
                input.getAttribute("placeholder"),
                input.getAttribute("aria-label"),
                input.getAttribute("title"),
            ].join(" ");
            if (!/태그/.test(label)) return false;
            const rect = input.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });
        return inputs[0] || null;
    }

    function findGlobalTagSearchInput() {
        const inputs = Array.from(document.querySelectorAll("input"));
        for (const input of inputs) {
            if (!(input instanceof HTMLElement)) continue;
            if (input.closest(`#${BAR_ID}`) || input.closest(`#${MENU_ID}`)) continue;
            const label = [
                input.getAttribute("placeholder"),
                input.getAttribute("aria-label"),
                input.getAttribute("title"),
            ].join(" ");
            if (!/\uD0DC\uADF8/.test(label)) continue;
            const rect = input.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return input;
        }
        return null;
    }

    function getGlobalTagSearchHost(input) {
        if (!(input instanceof HTMLElement)) return null;
        const inputRect = input.getBoundingClientRect();
        let best = input;
        let node = input.parentElement;
        let depth = 0;

        while (node instanceof HTMLElement && depth < 5) {
            if (
                node.id === BAR_ID ||
                node.id === MENU_ID ||
                node.id === GLOBAL_FALLBACK_ID ||
                node.getAttribute(GLOBAL_SORT_ATTR) === "1"
            ) {
                break;
            }

            const rect = node.getBoundingClientRect();
            const className = String(node.className || "");
            const looksLikeSearchBox =
                rect.width >= inputRect.width &&
                rect.width <= 520 &&
                rect.height >= inputRect.height &&
                rect.height <= 80;
            if (looksLikeSearchBox) best = node;
            if (looksLikeSearchBox && /search/i.test(className)) break;

            node = node.parentElement;
            depth++;
        }

        return best;
    }

    function getDirectChildWithin(parent, descendant) {
        if (!(parent instanceof HTMLElement) || !(descendant instanceof HTMLElement)) return null;
        let node = descendant;
        while (node.parentElement && node.parentElement !== parent) {
            node = node.parentElement;
        }
        return node.parentElement === parent ? node : null;
    }

    function getGlobalTagSearchAnchor(host) {
        const input = findGlobalTagSearchInput() || findGlobalTagSearch();
        const tagHost = getGlobalTagSearchHost(input);
        return getDirectChildWithin(host, tagHost);
    }

    function hideGlobalTagSearch() {
        restoreHiddenGlobalTagSearch();
        const input = findGlobalTagSearchInput() || findGlobalTagSearch();
        const host = getGlobalTagSearchHost(input);
        if (host) host.setAttribute(HIDDEN_TAG_SEARCH_ATTR, "1");
    }

    function restoreHiddenGlobalTagSearch() {
        document
            .querySelectorAll(`[${HIDDEN_TAG_SEARCH_ATTR}="1"]`)
            .forEach((el) => el.removeAttribute(HIDDEN_TAG_SEARCH_ATTR));
        document
            .querySelectorAll(`[${TAG_SEARCH_ANCHOR_ATTR}="1"]`)
            .forEach((el) => el.removeAttribute(TAG_SEARCH_ANCHOR_ATTR));
    }

    function getVisibleHostControls(root) {
        if (!root) return [];
        return Array.from(root.querySelectorAll("button, a")).filter((el) => {
            if (!(el instanceof HTMLElement)) return false;
            if (el.closest(`#${BAR_ID}`) || el.closest(`#${MENU_ID}`)) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });
    }

    function syncFontWithHostUi(bar, host) {
        if (!bar || !host) return;
        const controls = getVisibleHostControls(host);
        const fontSource =
            controls.find((el) => {
                return ["라이브", "동영상", "클립"].includes(normSpace(el.textContent));
            }) || controls[0];
        if (!fontSource) return;

        const fontStyle = getComputedStyle(fontSource);
        bar.style.setProperty("--bcgt-font-family", fontStyle.fontFamily);
        bar.style.setProperty("--bcgt-font-weight", fontStyle.fontWeight);
        bar.style.setProperty("--bcgt-font-size", "13px");
        bar.style.setProperty("--bcgt-line-height", "16px");

        const menu = document.getElementById(MENU_ID);
        if (menu) {
            menu.style.fontFamily = fontStyle.fontFamily;
            menu.style.fontSize = "13px";
            menu.style.lineHeight = "16px";
        }
    }

    function getContentLeft(route = getRoute(), context = null) {
        if (context && context.contentLeft !== undefined) return context.contentLeft;
        let value;
        if (route?.scope === "global-lives") {
            const sortRect = getGlobalSortRect(context);
            value = sortRect ? Math.max(0, Math.floor(sortRect.left) - 8) : 0;
        } else {
            const tabs = getContextTabLine(context, route);
            value = tabs ? Math.max(0, Math.floor(tabs.getBoundingClientRect().left) - 8) : 240;
        }
        if (context) context.contentLeft = value;
        return value;
    }

    function getTabBottom(route = getRoute(), context = null) {
        if (context && context.tabBottom !== undefined) return context.tabBottom;
        let value;
        if (route?.scope === "global-lives") {
            const sortRect = getGlobalSortRect(context);
            value = sortRect ? Math.max(0, Math.floor(sortRect.bottom) - 8) : 0;
        } else {
            const tabs = getContextTabLine(context, route);
            value = tabs ? Math.floor(tabs.getBoundingClientRect().bottom) - 8 : 0;
        }
        if (context) context.tabBottom = value;
        return value;
    }

    function idPattern(route) {
        if (route.tab === "lives") return /\/live\/([^/?#]+)/;
        if (route.tab === "videos") return /\/video\/(\d+)/;
        return /\/clips\/([^/?#]+)/;
    }

    function getItemId(route, href) {
        const match = String(href || "").match(idPattern(route));
        return match ? match[1] : "";
    }

    function isCardLinkCandidate(route, link, rect) {
        if (route.scope !== "global-lives") return true;
        if (rect.width < 160 || rect.height < 90) return false;

        const media = link.querySelector("img, video, canvas");
        if (!media) return true;

        const mediaRect = media.getBoundingClientRect();
        return mediaRect.width >= 120 && mediaRect.height >= 70;
    }

    function findCardLinks(route, root = document, context = null) {
        if (context?.cardLinksByRoot?.has(root)) return context.cardLinksByRoot.get(root);
        const pattern = idPattern(route);
        const contentLeft = getContentLeft(route, context);
        const tabBottom = getTabBottom(route, context);
        const seen = new Set();
        const links = Array.from(root.querySelectorAll("a[href]")).filter((link) => {
            const href = link.getAttribute("href") || "";
            if (!pattern.test(href)) return false;
            const id = getItemId(route, href);
            if (!id) return false;
            const rect = link.getBoundingClientRect();
            const seenKey = `${href}|${Math.round(rect.x)}`;
            if (seen.has(seenKey)) return false;
            if (rect.width <= 0 || rect.height <= 0) return false;
            if (rect.left < contentLeft || rect.top < tabBottom) return false;
            if (!isCardLinkCandidate(route, link, rect)) return false;
            seen.add(seenKey);
            return true;
        });
        context?.cardLinksByRoot?.set(root, links);
        return links;
    }

    function findGrid(route, links = null, context = null) {
        if (!links) links = findCardLinks(route, document, context);
        if (links.length < 2) return null;

        const counts = new Map();
        for (const link of links) {
            let node = link.parentElement;
            let depth = 0;
            while (node && depth < 9) {
                counts.set(node, (counts.get(node) || 0) + 1);
                node = node.parentElement;
                depth++;
            }
        }

        let best = null;
        let bestScore = -1;
        for (const [node, count] of counts) {
            if (count < Math.min(links.length, 3)) continue;
            const rect = node.getBoundingClientRect();
            if (rect.width < 300 || rect.height < 80) continue;
            const childCount = node.children?.length || 0;
            const score = count * 1000 + childCount - Math.round(rect.height / 100);
            if (score > bestScore) {
                best = node;
                bestScore = score;
            }
        }
        if (best) {
            cachedGrid = best;
            cachedGridKey = listStateKey(route, context);
        }
        return best;
    }

    function getCachedGrid(route, context = null) {
        if (!cachedGrid?.isConnected || cachedGridKey !== listStateKey(route, context)) return null;
        if (findCardLinks(route, cachedGrid, context).length < 2) return null;
        return cachedGrid;
    }

    function getCardDomText(card) {
        if (card.__bcgtDomText) return card.__bcgtDomText;

        const parts = [];
        const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const parent = node.parentElement;
                if (parent?.closest?.(`[${FOLLOWER_BADGE_ATTR}="1"]`)) return NodeFilter.FILTER_REJECT;
                if (parent?.closest?.(`[${LIVE_ELAPSED_BADGE_ATTR}="1"]`)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        while (walker.nextNode()) parts.push(walker.currentNode.nodeValue || "");
        const text = normSpace(parts.join(" "));
        card.__bcgtDomText = text;
        return text;
    }

    function createCardEntry(card, id, meta = null) {
        const domText = meta?.id
            ? normSpace([getCardDomText(card), buildMetaSearchText(meta)].join(" "))
            : getCardDomText(card);
        if (meta?.id) card.__bcgtDomText = domText;
        return {
            id,
            card,
            order: Number(card.getAttribute(ORDER_ATTR)) || 0,
            domText,
        };
    }

    function prepareCardIdentity(card, id) {
        if (!(card instanceof HTMLElement) || !id) return;
        const previousId = card.getAttribute(CARD_ID_ATTR);
        if (previousId && previousId !== id) {
            delete card.__bcgtDomText;
            card.removeAttribute(HIDE_ATTR);
            card.removeAttribute(ORDER_ATTR);
            removeFollowerBadge(card);
            removeLiveElapsedBadge(card);
        }
        card.setAttribute(CARD_ID_ATTR, id);
        if (!card.hasAttribute(ORDER_ATTR)) {
            card.setAttribute(ORDER_ATTR, String(orderCounter++));
        }
    }

    function getExistingCardEntries(route) {
        const entries = [];
        const byCard = new Set();
        const byId = new Set();
        for (const card of Array.from(document.querySelectorAll(`[${CARD_ATTR}="1"]`))) {
            if (!(card instanceof HTMLElement) || !card.isConnected) continue;
            const link = Array.from(card.querySelectorAll("a[href]")).find((item) =>
                getItemId(route, item.getAttribute("href"))
            );
            if (!link) continue;
            const id = getItemId(route, link.getAttribute("href"));
            if (!id || byCard.has(card) || byId.has(id)) continue;
            prepareCardIdentity(card, id);
            byCard.add(card);
            byId.add(id);
            entries.push(createCardEntry(card, id));
        }
        return entries;
    }

    function getCardEntries(route, context = null) {
        const existing = getExistingCardEntries(route);
        const cached = getCachedGrid(route, context);
        const grid = cached || findGrid(route, undefined, context);
        if (!grid && existing.length) return existing;
        if (!grid) return [];

        const entries = [...existing];
        const byCard = new Set(existing.map((entry) => entry.card));
        const byId = new Set(existing.map((entry) => entry.id));
        for (const link of findCardLinks(route, grid, context)) {
            const id = getItemId(route, link.getAttribute("href"));
            if (!id) continue;

            let card = link;
            while (card && card.parentElement && card.parentElement !== grid) {
                card = card.parentElement;
            }
            if (!card || card.parentElement !== grid || !(card instanceof HTMLElement)) continue;
            if (byCard.has(card) || byId.has(id)) continue;
            prepareCardIdentity(card, id);
            byCard.add(card);
            byId.add(id);

            card.setAttribute(CARD_ATTR, "1");
            entries.push(createCardEntry(card, id));
        }
        return entries;
    }

    function parseCount(value) {
        const raw = String(value || "")
            .replace(/,/g, "")
            .trim();
        const match = raw.match(/([\d.]+)\s*(만|천)?/);
        if (!match) return 0;
        const base = Number(match[1]);
        if (!Number.isFinite(base)) return 0;
        if (match[2] === "만") return Math.round(base * 10000);
        if (match[2] === "천") return Math.round(base * 1000);
        return Math.round(base);
    }

    function parseViewsFromText(route, text) {
        const value = String(text || "");
        if (route.tab === "lives") {
            const live = value.match(/LIVE\s*([\d,.]+(?:만|천)?)\s*명/) || value.match(/([\d,.]+(?:만|천)?)\s*명/);
            return live ? parseCount(live[1]) : 0;
        }
        if (route.tab === "clips") {
            const clip = value.match(/재생\s*수\s*([\d,.]+(?:만|천)?)/);
            return clip ? parseCount(clip[1]) : 0;
        }
        const video = value.match(/조회수\s*([\d,.]+(?:만|천)?)\s*회/);
        return video ? parseCount(video[1]) : 0;
    }

    function apiUrl(route, cursor = null) {
        if (route.scope === "global-lives") {
            const params = new URLSearchParams({ size: String(API_PAGE_SIZE) });
            if (cursor?.concurrentUserCount !== undefined && cursor?.concurrentUserCount !== null) {
                params.set("concurrentUserCount", String(cursor.concurrentUserCount));
            }
            if (cursor?.liveId !== undefined && cursor?.liveId !== null) {
                params.set("liveId", String(cursor.liveId));
            }
            return `${API_BASE}/v1/lives?${params.toString()}`;
        }

        const type = encodeURIComponent(route.categoryType);
        const id = encodeURIComponent(route.categoryId);
        const params = new URLSearchParams({ size: String(API_PAGE_SIZE) });
        if (route.tab === "clips") {
            params.set("clipUID", cursor?.clipUID ? String(cursor.clipUID) : "");
            params.set("filterType", "WITHIN_THIRTY_DAYS");
            params.set("orderType", "POPULAR");
            params.set(
                "readCount",
                cursor?.readCount !== undefined && cursor?.readCount !== null ? String(cursor.readCount) : ""
            );
            return `${API_BASE}/v1/categories/${type}/${id}/clips?${params.toString()}`;
        }
        if (route.tab === "videos" && cursor) {
            if (cursor.publishDateAt !== undefined && cursor.publishDateAt !== null)
                params.set("publishDateAt", String(cursor.publishDateAt));
            if (cursor.readCount !== undefined && cursor.readCount !== null)
                params.set("readCount", String(cursor.readCount));
        }
        if (route.tab === "lives" && cursor) {
            if (cursor.concurrentUserCount !== undefined && cursor.concurrentUserCount !== null) {
                params.set("concurrentUserCount", String(cursor.concurrentUserCount));
            }
            if (cursor.liveId !== undefined && cursor.liveId !== null) params.set("liveId", String(cursor.liveId));
        }
        return `${API_BASE}/v2/categories/${type}/${id}/${route.tab}?${params.toString()}`;
    }

    function queueFollowerHydrationPass() {
        if (followerHydrateTimer) return;
        followerHydrateTimer = window.setTimeout(() => {
            followerHydrateTimer = 0;
            void refreshFollowerHydrationRows();
        }, getFollowerFetchDelayMs());
    }

    function clearFollowerHydrationTimer() {
        if (!followerHydrateTimer) return;
        window.clearTimeout(followerHydrateTimer);
        followerHydrateTimer = 0;
    }

    function mapApiItem(route, item) {
        if (route.tab === "lives") {
            const channel = item.channel || {};
            return {
                id: String(channel.channelId || ""),
                channelId: String(channel.channelId || ""),
                title: item.liveTitle || "",
                channelName: channel.channelName || "",
                channelImageUrl: channel.channelImageUrl || "",
                thumb: item.liveImageUrl || item.defaultThumbnailImageUrl || "",
                duration: null,
                publishDate: item.openDate || "",
                views: Number(item.concurrentUserCount) || 0,
                categoryName: item.liveCategoryValue || "",
                tags: item.tags || [],
                liveId: Number(item.liveId) || 0,
                adult: Boolean(item.adult),
            };
        }
        if (route.tab === "videos") {
            const channel = item.channel || {};
            return {
                id: String(item.videoNo || ""),
                channelId: String(channel.channelId || ""),
                title: item.videoTitle || "",
                channelName: channel.channelName || "",
                channelImageUrl: channel.channelImageUrl || "",
                thumb: item.thumbnailImageUrl || "",
                duration: typeof item.duration === "number" ? item.duration : null,
                publishDate: item.publishDate || "",
                views: Number(item.readCount) || 0,
                tags: item.tags || [],
            };
        }
        const channel = item.ownerChannel || {};
        return {
            id: String(item.clipUID || ""),
            channelId: String(item.ownerChannelId || channel.channelId || ""),
            title: item.clipTitle || "",
            channelName: channel.channelName || "",
            channelImageUrl: channel.channelImageUrl || "",
            thumb: item.thumbnailImageUrl || "",
            duration: typeof item.duration === "number" ? item.duration : null,
            publishDate: item.createdDate || "",
            views: Number(item.readCount) || 0,
            tags: [],
        };
    }

    function resetMetadata(key = "") {
        metadataKey = key;
        metadataMap = new Map();
        metadataNext = null;
        metadataComplete = false;
        metadataPagesLoaded = 0;
        metadataLoading = null;
        metadataSearchToken++;
        metadataSearchRunning = false;
    }

    function mergeMetadataPage(route, json) {
        const data = json?.content?.data || [];
        for (const item of data) {
            const mapped = mapApiItem(route, item);
            if (!mapped.id) continue;
            delete mapped._bcgtSearchText;
            if (!metadataMap.has(mapped.id)) {
                mapped.order = metadataMap.size;
                metadataMap.set(mapped.id, mapped);
            } else {
                const merged = { ...metadataMap.get(mapped.id), ...mapped };
                delete merged._bcgtSearchText;
                metadataMap.set(mapped.id, merged);
            }
        }
        metadataNext = json?.content?.page?.next || null;
        metadataComplete = !metadataNext || data.length < API_PAGE_SIZE;
        metadataPagesLoaded++;
        return metadataMap;
    }

    async function loadMetadataPage(route, cursor = null) {
        const key = routeKey(route);
        metadataLoading = {
            key,
            promise: fetchJson(apiUrl(route, cursor), { headers: { Accept: "application/json" } })
                .then((json) => {
                    if (metadataKey !== key) return metadataMap;
                    return mergeMetadataPage(route, json);
                })
                .catch(() => {
                    if (metadataKey === key) metadataComplete = true;
                    return metadataMap;
                })
                .finally(() => {
                    if (metadataLoading?.key === key) metadataLoading = null;
                }),
        };
        return metadataLoading.promise;
    }

    async function ensureMetadata(route) {
        const key = routeKey(route);
        if (metadataKey !== key) resetMetadata(key);
        if (metadataMap.size || metadataComplete) return metadataMap;
        if (metadataLoading && metadataLoading.key === key) return metadataLoading.promise;
        return loadMetadataPage(route);
    }

    function isFollowerFetchMiss(value) {
        return Boolean(value && typeof value === "object" && value.type === "miss" && Number.isFinite(value.expiresAt));
    }

    function rememberFollowerFetchMiss(channelId) {
        const miss = {
            type: "miss",
            expiresAt: Date.now() + FOLLOWER_NEGATIVE_CACHE_TTL_MS,
        };
        touchMapEntry(followerCache, channelId, miss, MAX_FOLLOWER_CACHE_ENTRIES);
        return null;
    }

    function readFollowerCache(channelId) {
        if (!channelId || !followerCache.has(channelId)) return { hit: false, count: null };

        const cached = followerCache.get(channelId);
        if (isFollowerFetchMiss(cached)) {
            if (cached.expiresAt > Date.now()) {
                touchMapEntry(followerCache, channelId, cached, MAX_FOLLOWER_CACHE_ENTRIES);
                return { hit: true, count: null };
            }
            followerCache.delete(channelId);
            return { hit: false, count: null };
        }

        touchMapEntry(followerCache, channelId, cached, MAX_FOLLOWER_CACHE_ENTRIES);
        return { hit: true, count: cached };
    }

    async function getFollowerCount(channelId) {
        if (!channelId) return 0;
        const cached = readFollowerCache(channelId);
        if (cached.hit) return cached.count;
        if (followerInflight.has(channelId)) return followerInflight.get(channelId);

        const promise = fetchJson(`${API_BASE}/v1/channels/${encodeURIComponent(channelId)}`, {
            headers: { Accept: "application/json" },
        })
            .then((json) => {
                const rawCount = json?.content?.followerCount;
                if (rawCount === null || rawCount === undefined || rawCount === "")
                    return rememberFollowerFetchMiss(channelId);
                const count = Number(rawCount);
                if (!Number.isFinite(count)) return rememberFollowerFetchMiss(channelId);
                const safeCount = Math.max(0, Math.floor(count));
                touchMapEntry(followerCache, channelId, safeCount, MAX_FOLLOWER_CACHE_ENTRIES);
                return safeCount;
            })
            .catch(() => {
                return rememberFollowerFetchMiss(channelId);
            })
            .finally(() => {
                followerInflight.delete(channelId);
            });
        followerInflight.set(channelId, promise);
        return promise;
    }

    function syncLoadingIndicator() {
        const bar = document.getElementById(BAR_ID);
        if (bar) bar.setAttribute("data-loading", loadingReasons.size ? "1" : "0");
    }

    function setLoading(on, reason = "default") {
        setLoadingReason(loadingReasons, on, reason, syncLoadingIndicator);
    }

    function clearLoading() {
        loadingReasons.clear();
        syncLoadingIndicator();
    }

    async function hydrateFollowerIds(ids, clearWhenDone = true, force = false) {
        if (!force && !hasFollowerFilter()) return false;
        if (force && !hasFollowerFilter() && !areFollowerBadgesEnabled()) return false;
        const targets = ids.filter((id) => id && !readFollowerCache(id).hit);
        const unique = Array.from(new Set(targets));
        if (!unique.length) {
            if (clearWhenDone) setLoading(false, "followers");
            return false;
        }

        const now = Date.now();
        if (now - lastFollowerHydrateAt < getFollowerFetchDelayMs()) {
            queueFollowerHydrationPass();
            return true;
        }
        lastFollowerHydrateAt = now;

        const batch = unique.slice(0, getFollowerFetchMaxPerPass());
        setLoading(true, "followers");
        try {
            const concurrency = getFollowerFetchConcurrency();
            for (let i = 0; i < batch.length; i += concurrency) {
                await Promise.all(batch.slice(i, i + concurrency).map((id) => getFollowerCount(id)));
            }
        } finally {
            if (unique.length > batch.length && (force || hasFollowerFilter())) {
                queueFollowerHydrationPass();
            } else if (clearWhenDone) {
                setLoading(false, "followers");
            }
        }
        return unique.length > batch.length;
    }

    async function hydrateFollowers(rows, clearWhenDone = true, force = false) {
        return hydrateFollowerIds(
            rows.map((row) => row.meta?.channelId),
            clearWhenDone,
            force
        );
    }

    function rememberFollowerRefreshRows(route, rows) {
        lastFollowerRefreshRouteKey = route ? routeKey(route) : "";
        lastFollowerRefreshRows = rows
            .filter((row) => row?.entry?.card?.isConnected)
            .map((row) => {
                const channelId = row.meta?.channelId || inferChannelIdFromCard(route, row.entry);
                return {
                    ...row,
                    meta: { ...row.meta, channelId },
                };
            })
            .filter((row) => row.meta.channelId);
    }

    function getRememberedFollowerRefreshRows(route) {
        if (!route || lastFollowerRefreshRouteKey !== routeKey(route)) return [];
        lastFollowerRefreshRows = lastFollowerRefreshRows.filter((row) => row?.entry?.card?.isConnected);
        return lastFollowerRefreshRows;
    }

    function syncFollowerVisibilityRows(rows) {
        if (!hasFollowerFilter()) return;
        for (const row of rows) {
            setCardHidden(row.entry.card, !passesStickyFilters(row));
        }
    }

    function setCardHidden(card, hidden) {
        if (!(card instanceof HTMLElement)) return;
        if (hidden) {
            if (card.getAttribute(HIDE_ATTR) !== "1") card.setAttribute(HIDE_ATTR, "1");
            return;
        }
        if (card.hasAttribute(HIDE_ATTR)) card.removeAttribute(HIDE_ATTR);
    }

    async function refreshFollowerHydrationRows() {
        if (followerHydrationRefreshing) {
            followerHydrationQueued = true;
            return;
        }
        const route = getRoute();
        const rememberedRows = getRememberedFollowerRefreshRows(route);
        if (!route || !rememberedRows.length) {
            scheduleApply();
            return;
        }

        const rows = hasFollowerFilter() ? rememberedRows : getRowsNearViewport(rememberedRows);
        if (!rows.length) return;

        const hydrationRunToken = ++followerHydrationRunToken;
        followerHydrationRefreshing = true;
        const hydrationRouteKey = routeKey(route);
        try {
            await hydrateFollowers(rows, true, true);
            const currentRoute = getRoute();
            if (!isFeatureEnabled() || !currentRoute || routeKey(currentRoute) !== hydrationRouteKey) return;
            syncFollowerBadges(route, rows);
            syncFollowerVisibilityRows(rows);
        } finally {
            if (hydrationRunToken === followerHydrationRunToken) {
                followerHydrationRefreshing = false;
                const shouldRepeat = followerHydrationQueued;
                followerHydrationQueued = false;
                if (shouldRepeat && isFeatureEnabled() && getRoute()) queueFollowerHydrationPass();
            }
        }
    }

    // 필터가 없을 때 팔로워 배지는 화면 근처 카드만 채운다.
    // 멀리 있는 카드는 스크롤로 가까워질 때 보충 조회한다.
    function getRowsNearViewport(rows) {
        const viewTop = -window.innerHeight * 0.5;
        const viewBottom = window.innerHeight * 2;
        return rows.filter((row) => {
            const card = row.entry?.card;
            if (!(card instanceof HTMLElement)) return false;
            const rect = card.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            return rect.bottom >= viewTop && rect.top <= viewBottom;
        });
    }

    async function hydrateMetadataFollowers(metas, clearWhenDone = true, force = false) {
        return hydrateFollowerIds(
            metas.map((meta) => meta?.channelId),
            clearWhenDone,
            force
        );
    }

    function buildSearchText(row) {
        const meta = row.meta || {};
        const metaText = buildMetaSearchText(meta);
        const card = row.entry?.card;
        const cacheKey = `${row.entry.domText}|${metaText}`;
        if (card?.__bcgtSearchTextKey === cacheKey && card.__bcgtSearchText) return card.__bcgtSearchText;

        const text = normalize([row.entry.domText, metaText].join(" "));
        if (card) {
            card.__bcgtSearchTextKey = cacheKey;
            card.__bcgtSearchText = text;
        }
        return text;
    }

    function hasFollowerFilter() {
        return followerFilterMin > 0 || followerFilterMax > 0;
    }

    function hasViewFilter() {
        return viewFilterMin > 0 || viewFilterMax > 0;
    }

    function hasDurationFilter() {
        return durationFilterMin > 0 || durationFilterMax > 0;
    }

    function hasActiveFilters() {
        return hasFollowerFilter() || hasViewFilter() || hasDurationFilter();
    }

    function activeFilterCount() {
        return (hasFollowerFilter() ? 1 : 0) + (hasViewFilter() ? 1 : 0) + (hasDurationFilter() ? 1 : 0);
    }

    function passesCountRange(value, min, max) {
        const count = Number(value) || 0;
        if (min > 0 && count < min) return false;
        if (max > 0 && count > max) return false;
        return true;
    }

    function passesViewFilter(meta) {
        return passesCountRange(meta?.views, viewFilterMin, viewFilterMax);
    }

    function getLiveElapsedSeconds(meta, now = Date.now()) {
        const start = parseDateTime(meta?.publishDate);
        if (!start || start > now) return null;
        return Math.max(0, Math.floor((now - start) / 1000));
    }

    function passesDurationFilter(meta) {
        if (!hasDurationFilter()) return true;
        const elapsed = getLiveElapsedSeconds(meta);
        if (elapsed === null) return false;
        return passesCountRange(elapsed, durationFilterMin, durationFilterMax);
    }

    function clearDurationFilterRefreshTimer() {
        if (!durationFilterRefreshTimer) return;
        window.clearTimeout(durationFilterRefreshTimer);
        durationFilterRefreshTimer = 0;
    }

    function scheduleDurationFilterRefresh(metadata) {
        clearDurationFilterRefreshTimer();
        if (!hasDurationFilter()) return;

        const now = Date.now();
        let nextAt = Number.POSITIVE_INFINITY;
        for (const meta of metadata || []) {
            const start = parseDateTime(meta?.publishDate);
            if (!start || start > now) continue;
            const elapsed = Math.floor((now - start) / 1000);
            if (durationFilterMin > 0 && elapsed < durationFilterMin) {
                nextAt = Math.min(nextAt, start + durationFilterMin * 1000);
            }
            if (durationFilterMax > 0 && elapsed <= durationFilterMax) {
                nextAt = Math.min(nextAt, start + (durationFilterMax + 1) * 1000);
            }
        }
        if (!Number.isFinite(nextAt)) return;

        const delay = Math.max(50, Math.min(nextAt - now + 50, 2_147_000_000));
        durationFilterRefreshTimer = window.setTimeout(() => {
            durationFilterRefreshTimer = 0;
            scheduleApply();
        }, delay);
    }

    function resetViewFilterSnapshot() {
        viewFilterSnapshotKey = "";
        viewFilterSnapshotIds = new Set();
        viewFilterSnapshotOrder = new Map();
        viewFilterSnapshotNextOrder = 0;
    }

    function getViewFilterSnapshotKey(route, query = normalize(currentQuery)) {
        if (!hasViewFilter()) return "";
        return [
            routeKey(route),
            query,
            viewFilterMin,
            viewFilterMax,
            followerFilterMin,
            followerFilterMax,
            durationFilterMin,
            durationFilterMax,
        ].join("|");
    }

    function syncViewFilterSnapshot(route, query = normalize(currentQuery)) {
        const key = getViewFilterSnapshotKey(route, query);
        if (!key) {
            resetViewFilterSnapshot();
            return "";
        }
        if (key !== viewFilterSnapshotKey) {
            viewFilterSnapshotKey = key;
            viewFilterSnapshotIds = new Set();
            viewFilterSnapshotOrder = new Map();
            viewFilterSnapshotNextOrder = 0;
        }
        return key;
    }

    function rowSnapshotId(row) {
        return row?.entry?.id || row?.meta?.id || "";
    }

    function isViewFilterSnapshotId(id) {
        return Boolean(hasViewFilter() && id && viewFilterSnapshotIds.has(String(id)));
    }

    function isViewFilterSnapshotRow(row) {
        return isViewFilterSnapshotId(rowSnapshotId(row));
    }

    function passesStickyViewFilter(row) {
        return passesViewFilter(row.meta) || isViewFilterSnapshotRow(row);
    }

    function passesStickyFilters(row) {
        if (!passesStickyViewFilter(row)) return false;
        if (!passesDurationFilter(row.meta)) return false;
        return passesFollowerFilter(row.meta);
    }

    function rememberVisibleRows(rows) {
        if (!hasViewFilter() || !viewFilterSnapshotKey) return;
        for (const row of rows) {
            const id = rowSnapshotId(row);
            if (!id || viewFilterSnapshotIds.has(id)) continue;
            viewFilterSnapshotIds.add(id);
            viewFilterSnapshotOrder.set(id, viewFilterSnapshotNextOrder++);
        }
    }

    function getStableVisibleOrder(row) {
        const id = rowSnapshotId(row);
        if (id && viewFilterSnapshotOrder.has(id)) return viewFilterSnapshotOrder.get(id);
        if (hasViewFilter() && viewFilterSnapshotKey) {
            return viewFilterSnapshotNextOrder + (Number(row?.entry?.order) || 0);
        }
        return Number(row?.entry?.order) || 0;
    }

    function passesFollowerFilter(meta) {
        if (!hasFollowerFilter()) return true;
        const channelId = meta?.channelId;
        const cached = channelId ? readFollowerCache(channelId) : { hit: false };
        if (!cached.hit || cached.count === null) return false;
        return passesCountRange(cached.count, followerFilterMin, followerFilterMax);
    }

    function passesMetaFilters(meta, query = "") {
        if (query && !buildMetaSearchText(meta).includes(query)) return false;
        if (!passesViewFilter(meta) && !isViewFilterSnapshotId(meta?.id)) return false;
        if (!passesDurationFilter(meta)) return false;
        return passesFollowerFilter(meta);
    }

    function isFollowerCandidate(meta) {
        if (hasFollowerFilter()) {
            return Boolean(meta?.channelId);
        }
        return false;
    }

    function parseFilterInput(value) {
        const raw = String(value || "")
            .replace(/,/g, "")
            .trim();
        if (!raw) return 0;
        const match = raw.match(/^(\d+(?:\.\d+)?)\s*(만|천)?/);
        if (!match) return 0;
        const base = Number(match[1]);
        if (!Number.isFinite(base)) return 0;
        const unit = match[2];
        if (unit === "만") return Math.max(0, Math.floor(base * 10000));
        if (unit === "천") return Math.max(0, Math.floor(base * 1000));
        return Math.max(0, Math.floor(base));
    }

    function formatFilterInput(value) {
        const number = Math.max(0, Math.floor(Number(value) || 0));
        if (!number) return "";
        if (number >= 10000 && number % 10000 === 0) return `${number / 10000}만`;
        return number.toLocaleString("ko-KR");
    }

    function parseDurationFilterInput(value) {
        const raw = String(value || "")
            .replace(/,/g, "")
            .trim();
        if (!raw) return 0;
        const match = raw.match(/^(\d+(?:\.\d+)?)/);
        if (!match) return 0;
        const hours = Number(match[1]);
        if (!Number.isFinite(hours) || hours <= 0) return 0;
        return Math.floor(hours * SECONDS_PER_HOUR);
    }

    function formatDurationFilterInput(value) {
        const seconds = Math.max(0, Number(value) || 0);
        if (!seconds) return "";
        const hours = seconds / SECONDS_PER_HOUR;
        return String(Number.isInteger(hours) ? hours : Math.round(hours * 100) / 100);
    }

    function parseFilterInputForKind(kind, value) {
        return kind === "duration" ? parseDurationFilterInput(value) : parseFilterInput(value);
    }

    function formatFilterInputForKind(kind, value) {
        return kind === "duration" ? formatDurationFilterInput(value) : formatFilterInput(value);
    }

    function getFilterPresetValues(kind) {
        const keys =
            kind === "followers"
                ? FOLLOWER_FILTER_PRESET_KEYS
                : kind === "duration"
                  ? DURATION_FILTER_PRESET_KEYS
                  : VIEW_FILTER_PRESET_KEYS;
        const scale = kind === "duration" ? SECONDS_PER_HOUR : 1;
        const values = keys
            .map((key) => Math.max(0, Math.floor(Number(featureOptions[key]) || 0)) * scale)
            .filter((value) => value > 0)
            .sort((a, b) => a - b);
        return Array.from(new Set(values));
    }

    function getFilterPresetRanges(kind) {
        const values = getFilterPresetValues(kind);
        const ranges = [{ min: 0, max: 0 }];
        if (!values.length) return ranges;

        ranges.push({ min: 0, max: values[0] });
        for (let i = 1; i < values.length; i++) {
            ranges.push({ min: values[i - 1], max: values[i] });
        }
        ranges.push({ min: values[values.length - 1], max: 0 });
        return ranges;
    }

    function formatFilterOptionLabel(kind, min, max, unit) {
        if (min <= 0 && max <= 0) return "전체";
        if (min <= 0) return `${formatFilterInputForKind(kind, max)}${unit} 이하`;
        if (max <= 0) {
            const suffix = kind === "duration" ? " 이상" : " ~ 최대";
            return `${formatFilterInputForKind(kind, min)}${unit}${suffix}`;
        }
        return `${formatFilterInputForKind(kind, min)}${unit} ~ ${formatFilterInputForKind(kind, max)}${unit}`;
    }

    function buildFilterOptionButtons(kind, unit) {
        return getFilterPresetRanges(kind)
            .map(
                ({ min, max }) =>
                    `<button type="button" class="bcgt-option" data-filter-kind="${kind}" data-filter-min="${min}" data-filter-max="${max}" role="menuitemradio">${formatFilterOptionLabel(kind, min, max, unit)}</button>`
            )
            .join("");
    }

    function syncFilterOptionButtons(menu, route = getRoute()) {
        if (!menu) return;
        const isLiveList = route?.tab === "lives";
        const viewUnit = isLiveList ? "명" : "회";
        const renderKey = [
            getFilterPresetValues("followers").join(","),
            getFilterPresetValues("views").join(","),
            getFilterPresetValues("duration").join(","),
            viewUnit,
        ].join("|");
        if (menu.__bcgtFilterOptionsKey === renderKey) return;

        const followerOptions = menu.querySelector('[data-filter-options="followers"]');
        const viewOptions = menu.querySelector('[data-filter-options="views"]');
        const durationOptions = menu.querySelector('[data-filter-options="duration"]');
        if (followerOptions) followerOptions.innerHTML = buildFilterOptionButtons("followers", "명");
        if (viewOptions) viewOptions.innerHTML = buildFilterOptionButtons("views", viewUnit);
        if (durationOptions) durationOptions.innerHTML = buildFilterOptionButtons("duration", "시간");
        menu.__bcgtFilterOptionsKey = renderKey;
    }

    function getFilterState(kind) {
        if (kind === "followers") {
            return {
                min: followerFilterMin,
                max: followerFilterMax,
                minCustom: followerFilterCustom,
                maxCustom: followerFilterMaxCustom,
            };
        }
        if (kind === "duration") {
            return {
                min: durationFilterMin,
                max: durationFilterMax,
                minCustom: durationFilterCustom,
                maxCustom: durationFilterMaxCustom,
            };
        }
        return {
            min: viewFilterMin,
            max: viewFilterMax,
            minCustom: viewFilterCustom,
            maxCustom: viewFilterMaxCustom,
        };
    }

    function setFilterValue(kind, min, customValue = "", max = 0, maxCustomValue = "") {
        if (kind === "followers") {
            followerFilterMin = min;
            followerFilterMax = max;
            followerFilterCustom = customValue;
            followerFilterMaxCustom = maxCustomValue;
        }
        if (kind === "views") {
            viewFilterMin = min;
            viewFilterMax = max;
            viewFilterCustom = customValue;
            viewFilterMaxCustom = maxCustomValue;
        }
        if (kind === "duration") {
            durationFilterMin = min;
            durationFilterMax = max;
            durationFilterCustom = customValue;
            durationFilterMaxCustom = maxCustomValue;
        }
    }

    function setFilterMin(kind, min, customValue = "") {
        if (kind === "followers") {
            followerFilterMin = min;
            followerFilterCustom = customValue;
        }
        if (kind === "views") {
            viewFilterMin = min;
            viewFilterCustom = customValue;
        }
        if (kind === "duration") {
            durationFilterMin = min;
            durationFilterCustom = customValue;
        }
    }

    function setFilterMax(kind, max, customValue = "") {
        if (kind === "followers") {
            followerFilterMax = max;
            followerFilterMaxCustom = customValue;
        }
        if (kind === "views") {
            viewFilterMax = max;
            viewFilterMaxCustom = customValue;
        }
        if (kind === "duration") {
            durationFilterMax = max;
            durationFilterMaxCustom = customValue;
        }
    }

    function resetDurationFilterState() {
        durationFilterMin = 0;
        durationFilterMax = 0;
        durationFilterCustom = "";
        durationFilterMaxCustom = "";
        clearDurationFilterRefreshTimer();
    }

    function resetFilterState() {
        followerFilterMin = 0;
        followerFilterMax = 0;
        viewFilterMin = 0;
        viewFilterMax = 0;
        followerFilterCustom = "";
        followerFilterMaxCustom = "";
        viewFilterCustom = "";
        viewFilterMaxCustom = "";
        resetDurationFilterState();
        resetViewFilterSnapshot();
    }

    function setFilterRangeFromOptions(kind, firstRange, lastRange) {
        const min = Math.min(firstRange.min, lastRange.min);
        const includesOpenEnd =
            (firstRange.max <= 0 && firstRange.min > 0) || (lastRange.max <= 0 && lastRange.min > 0);
        const max = includesOpenEnd ? 0 : Math.max(firstRange.max || firstRange.min, lastRange.max || lastRange.min);
        if (min === 0 && max === 0) {
            setFilterValue(kind, 0, "", 0, "");
            return;
        }
        if (min === max) {
            setFilterValue(kind, min, min > 0 ? formatFilterInputForKind(kind, min) : "", 0, "");
            return;
        }
        setFilterValue(
            kind,
            min,
            min > 0 ? formatFilterInputForKind(kind, min) : "",
            max,
            formatFilterInputForKind(kind, max)
        );
    }

    function getFilterOptionAtPoint(x, y, kind) {
        const target = document.elementFromPoint(x, y);
        const option = target?.closest?.(".bcgt-option");
        if (!option || option.getAttribute("data-filter-kind") !== kind) return null;
        return option;
    }

    function optionFilterRange(option) {
        return {
            min: Number(option?.getAttribute("data-filter-min")) || 0,
            max: Number(option?.getAttribute("data-filter-max")) || 0,
        };
    }

    function hasFilterOptionRange(range) {
        return Boolean(range && (range.min > 0 || range.max > 0));
    }

    function isFilterRangeActive(kind, range) {
        const state = getFilterState(kind);
        return state.min === range.min && state.max === range.max;
    }

    function updateFilterDrag(event, finish = false) {
        if (!filterOptionDrag) return false;
        const option = getFilterOptionAtPoint(event.clientX, event.clientY, filterOptionDrag.kind);
        if (!option) return filterOptionDrag.moved;

        const range = optionFilterRange(option);
        const moved =
            filterOptionDrag.moved ||
            range.min !== filterOptionDrag.startRange.min ||
            range.max !== filterOptionDrag.startRange.max;
        if (!moved) return false;

        filterOptionDrag.moved = true;
        if (
            range.min !== filterOptionDrag.currentRange.min ||
            range.max !== filterOptionDrag.currentRange.max ||
            finish
        ) {
            filterOptionDrag.currentRange = range;
            setFilterRangeFromOptions(filterOptionDrag.kind, filterOptionDrag.startRange, range);
            updateUiState();
            scheduleMenuPosition();
        }
        return true;
    }

    function endFilterDrag(event) {
        if (!filterOptionDrag) return;
        const moved = updateFilterDrag(event, true);
        filterOptionDrag = null;
        if (!moved) return;
        suppressNextOptionClick = true;
        scheduleApply();
        setTimeout(() => {
            suppressNextOptionClick = false;
        }, 0);
    }

    function buildMetaSearchText(meta) {
        meta = meta || {};
        if (meta?._bcgtSearchText) return meta._bcgtSearchText;
        const text = normalize(
            [meta.title, meta.channelName, meta.categoryName, ...(Array.isArray(meta.tags) ? meta.tags : [])].join(" ")
        );
        if (meta && meta.id) meta._bcgtSearchText = text;
        return text;
    }

    function contentHref(route, meta) {
        if (route.tab === "lives") return `/live/${meta.channelId || meta.id}`;
        if (route.tab === "clips") return `/clips/${meta.id}`;
        return `/video/${meta.id}`;
    }

    function normalizeImageUrl(url) {
        return String(url || "").replace("{type}", "720");
    }

    function formatDuration(seconds) {
        if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
        const total = Math.floor(seconds);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return h > 0
            ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
            : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }

    function parseDateTime(value) {
        const raw = String(value || "").trim();
        if (!raw) return 0;
        const time = new Date(raw.includes("T") ? raw : raw.replace(" ", "T")).getTime();
        return Number.isFinite(time) ? time : 0;
    }

    function formatElapsedSince(value, now = Date.now()) {
        const start = parseDateTime(value);
        if (!start) return "";
        return formatDuration(Math.max(0, (now - start) / 1000));
    }

    function formatDate(value) {
        const date = new Date(String(value || "").replace(" ", "T"));
        if (Number.isNaN(date.getTime())) return "";
        const y = String(date.getFullYear()).slice(-2);
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const d = String(date.getDate()).padStart(2, "0");
        return `${y}.${m}.${d}`;
    }

    function setText(el, text) {
        if (el && text) el.textContent = text;
    }

    function setImageSource(img, url, alt = "") {
        if (!img || !url) return;
        const normalizedUrl = normalizeImageUrl(url);
        img.setAttribute("src", normalizedUrl);
        img.removeAttribute("srcset");
        for (const attr of ["data-src", "data-original", "data-lazy-src"]) {
            if (img.hasAttribute(attr)) img.setAttribute(attr, normalizedUrl);
        }
        const picture = img.closest("picture");
        if (picture) {
            for (const source of picture.querySelectorAll("source")) {
                source.setAttribute("srcset", normalizedUrl);
            }
        }
        if (alt && img.hasAttribute("alt")) img.setAttribute("alt", alt);
    }

    function formatViewerCount(count) {
        const value = Number(count);
        if (!Number.isFinite(value) || value < 0) return "";
        return `${Math.round(value).toLocaleString("ko-KR")}명`;
    }

    function formatCompactFollowerUnit(value) {
        const compact = Math.floor(value * 10) / 10;
        return Number.isInteger(compact) ? String(compact) : compact.toFixed(1);
    }

    function formatFollowerBadgeCount(count) {
        const value = Math.floor(Number(count) || 0);
        if (value <= 0) return "";
        if (value >= 10000) return `${formatCompactFollowerUnit(value / 10000)}만`;
        if (value >= 1000) return `${formatCompactFollowerUnit(value / 1000)}천`;
        return `${value.toLocaleString("ko-KR")}명`;
    }

    function replaceViewerCountText(value, countText) {
        return String(value || "").replace(/([\d,.]+(?:만|천)?\s*명)/g, countText);
    }

    function updateLiveViewerCount(card, count) {
        const countText = formatViewerCount(count);
        if (!countText) return;

        const textNodes = [];
        const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) textNodes.push(walker.currentNode);

        const countPattern = /([\d,.]+(?:만|천)?\s*명)/;
        for (const node of textNodes) {
            const value = node.nodeValue || "";
            if (!countPattern.test(value)) continue;
            node.nodeValue = replaceViewerCountText(value, countText);
        }

        const compactCountPattern = /^(LIVE\s*)?[\d,.]+(?:만|천)?\s*명$/;
        const elements = Array.from(card.querySelectorAll("*")).filter((el) => {
            const text = normSpace(el.textContent);
            if (!compactCountPattern.test(text)) return false;
            return !Array.from(el.children).some((child) => compactCountPattern.test(normSpace(child.textContent)));
        });
        for (const el of elements) {
            el.textContent = replaceViewerCountText(el.textContent, countText);
        }

        for (const el of card.querySelectorAll("[aria-label], [title]")) {
            for (const attr of ["aria-label", "title"]) {
                const value = el.getAttribute(attr);
                if (value && countPattern.test(value)) el.setAttribute(attr, replaceViewerCountText(value, countText));
            }
        }
    }

    function getImageArea(img) {
        if (!img) return 0;
        const rect = img.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return rect.width * rect.height;
        const width = Number(img.getAttribute("width")) || img.naturalWidth || 0;
        const height = Number(img.getAttribute("height")) || img.naturalHeight || 0;
        return width * height;
    }

    function getImagePairs(template, card) {
        const templateImages = Array.from(template.querySelectorAll("img"));
        const cardImages = Array.from(card.querySelectorAll("img"));
        return templateImages
            .map((templateImg, index) => ({ templateImg, img: cardImages[index], index }))
            .filter((pair) => pair.img);
    }

    function pickThumbnailImage(pairs, card) {
        const best = pairs.slice().sort((a, b) => getImageArea(b.templateImg) - getImageArea(a.templateImg))[0];
        return best?.img || card.querySelector("img");
    }

    function pickCardThumbnailImage(card) {
        return (
            Array.from(card.querySelectorAll("img"))
                .filter((img) => !img.closest(`[${FOLLOWER_BADGE_WRAP_ATTR}="1"], [${FOLLOWER_BADGE_ATTR}="1"]`))
                .sort((a, b) => getImageArea(b) - getImageArea(a))[0] || null
        );
    }

    function imageAttrs(img) {
        return [
            img?.getAttribute("class"),
            img?.parentElement?.getAttribute("class"),
            img?.closest("a")?.getAttribute("class"),
            img?.closest("a")?.getAttribute("href"),
            img?.getAttribute("src"),
        ].join(" ");
    }

    function profileImageScore(img, thumbImg) {
        if (!img || img === thumbImg) return 0;
        const attrs = imageAttrs(img);
        const rect = img.getBoundingClientRect();
        const width = rect.width || Number(img.getAttribute("width")) || img.naturalWidth || 0;
        const height = rect.height || Number(img.getAttribute("height")) || img.naturalHeight || 0;
        const area = getImageArea(img);
        const scoreFromAttrs = /profile|avatar|channel|name|creator|streamer|nng-phinf/i.test(attrs) ? 100 : 0;
        const scoreFromShape =
            width > 0 && height > 0 && width <= 96 && height <= 96 && Math.abs(width - height) <= 24 ? 40 : 0;
        const scoreFromSize = area >= 24 * 24 && area <= 96 * 96 ? 20 : 0;
        return scoreFromAttrs + scoreFromShape + scoreFromSize;
    }

    function profileImagePairScore(pair, thumbImg) {
        if (!pair?.img || pair.img === thumbImg) return 0;
        const attrs = [imageAttrs(pair.templateImg), imageAttrs(pair.img)].join(" ");
        const attrScore = /profile|avatar|channel|name|creator|streamer|nng-phinf/i.test(attrs) ? 100 : 0;
        return attrScore + profileImageScore(pair.templateImg, null) + profileImageScore(pair.img, thumbImg);
    }

    function profileImageUrl(meta) {
        return meta?.channelImageUrl || DEFAULT_PROFILE_IMAGE_URL;
    }

    function updateProfileImage(pairs, card, thumbImg, meta) {
        const url = profileImageUrl(meta);
        const profilePair = pairs
            .map((pair) => ({ pair, score: profileImagePairScore(pair, thumbImg) }))
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score)[0]?.pair;
        const profileImg =
            profilePair?.img ||
            Array.from(card.querySelectorAll("img"))
                .map((img) => ({ img, score: profileImageScore(img, thumbImg) }))
                .filter((entry) => entry.score > 0)
                .sort((a, b) => b.score - a.score)[0]?.img;
        setImageSource(profileImg, url, meta.channelName);
        return Boolean(profileImg);
    }

    function updateProfileBackgroundImage(card, meta) {
        const url = profileImageUrl(meta);
        const target = Array.from(card.querySelectorAll("*")).find((el) => {
            if (!(el instanceof HTMLElement)) return false;
            const attrs = [
                el.getAttribute("class"),
                el.parentElement?.getAttribute("class"),
                el.closest("a")?.getAttribute("href"),
                el.style.backgroundImage,
            ].join(" ");
            return /url\(/.test(el.style.backgroundImage) && /profile|avatar|channel|nng-phinf/i.test(attrs);
        });
        if (target) target.style.backgroundImage = `url("${normalizeImageUrl(url)}")`;
    }

    function pickProfileImage(card) {
        const images = Array.from(card.querySelectorAll("img")).filter(
            (img) => !img.closest(`[${FOLLOWER_BADGE_ATTR}="1"]`)
        );
        if (!images.length) return null;

        const thumbImg = images.slice().sort((a, b) => getImageArea(b) - getImageArea(a))[0];
        return (
            images
                .filter((img) => img !== thumbImg)
                .map((img) => ({ img, score: profileImageScore(img, thumbImg) }))
                .filter((entry) => entry.score > 0)
                .sort((a, b) => b.score - a.score)[0]?.img || null
        );
    }

    function unwrapFollowerBadgeHost(wrap) {
        const parent = wrap?.parentNode;
        if (!parent) return;
        while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
        wrap.remove();
    }

    function removeFollowerBadge(card) {
        delete card.__bcgtFollowerBadgeKey;
        card.querySelectorAll(`[${FOLLOWER_BADGE_ATTR}="1"]`).forEach((badge) => badge.remove());
        card.querySelectorAll(`[${FOLLOWER_BADGE_WRAP_ATTR}="1"]`).forEach((wrap) => {
            if (!wrap.querySelector(`[${FOLLOWER_BADGE_ATTR}="1"]`)) unwrapFollowerBadgeHost(wrap);
        });
    }

    function clearFollowerBadges(root = document) {
        root.querySelectorAll(`[${CARD_ATTR}="1"]`).forEach((card) => {
            delete card.__bcgtFollowerBadgeKey;
            delete card.__bcgtProfileImage;
        });
        root.querySelectorAll(`[${FOLLOWER_BADGE_ATTR}="1"]`).forEach((badge) => badge.remove());
        root.querySelectorAll(`[${FOLLOWER_BADGE_WRAP_ATTR}="1"]`).forEach(unwrapFollowerBadgeHost);
    }

    function ensureFollowerBadgeWrap(profileImg) {
        const existing = profileImg.closest(`[${FOLLOWER_BADGE_WRAP_ATTR}="1"]`);
        if (existing) return existing;

        let host = profileImg.closest("a[href], button");
        if (!host || host.querySelectorAll("img").length !== 1) {
            const picture = profileImg.closest("picture");
            if (picture && picture.querySelectorAll("img").length === 1) {
                host = picture;
            } else {
                const parent = profileImg.parentElement;
                host =
                    parent && parent.querySelectorAll("img").length === 1 && normSpace(parent.textContent).length <= 20
                        ? parent
                        : profileImg;
            }
        }

        const parent = host.parentNode;
        if (!parent) return null;
        const wrap = document.createElement("span");
        wrap.setAttribute(FOLLOWER_BADGE_WRAP_ATTR, "1");
        parent.insertBefore(wrap, host);
        wrap.appendChild(host);
        return wrap;
    }

    function getCachedProfileImage(card) {
        const cached = card.__bcgtProfileImage;
        if (cached?.isConnected && card.contains(cached) && !cached.closest(`[${FOLLOWER_BADGE_ATTR}="1"]`)) {
            return cached;
        }
        const profileImg = pickProfileImage(card);
        card.__bcgtProfileImage = profileImg || null;
        return profileImg;
    }

    function syncFollowerBadge(card, meta) {
        const channelId = meta?.channelId;
        const cached = channelId ? readFollowerCache(channelId) : { hit: false, count: 0 };
        const count = cached.hit ? cached.count : 0;
        const label = formatFollowerBadgeCount(count);
        if (!label) {
            if (card.__bcgtFollowerBadgeKey || card.querySelector(`[${FOLLOWER_BADGE_ATTR}="1"]`)) {
                removeFollowerBadge(card);
            }
            return;
        }

        const profileImg = getCachedProfileImage(card);
        if (!profileImg) {
            removeFollowerBadge(card);
            return;
        }

        const wrap = ensureFollowerBadgeWrap(profileImg);
        if (!wrap) return;
        let badge = wrap.querySelector(`[${FOLLOWER_BADGE_ATTR}="1"]`);
        if (!badge) {
            badge = document.createElement("span");
            badge.setAttribute(FOLLOWER_BADGE_ATTR, "1");
            wrap.appendChild(badge);
        }
        const title = `팔로워 ${Math.round(Number(count) || 0).toLocaleString("ko-KR")}명`;
        const renderKey = `${label}|${title}`;
        if (card.__bcgtFollowerBadgeKey === renderKey && badge.textContent === label && badge.title === title) return;
        badge.textContent = label;
        badge.setAttribute("title", title);
        card.__bcgtFollowerBadgeKey = renderKey;
    }

    function inferChannelIdFromCard(route, entry) {
        if (entry?.meta?.channelId) return entry.meta.channelId;
        if (route.tab === "lives" && entry?.id) return entry.id;
        const channelHref = Array.from(entry?.card?.querySelectorAll("a[href]") || [])
            .map((anchor) => anchor.getAttribute("href") || "")
            .find((href) => /^\/[a-f0-9]{32}(?:[/?#]|$)/i.test(href));
        return channelHref ? channelHref.match(/^\/([a-f0-9]{32})/i)?.[1] || "" : "";
    }

    function syncFollowerBadges(route, rows) {
        if (!areFollowerBadgesEnabled()) {
            clearFollowerBadges();
            return;
        }
        for (const row of rows) {
            const channelId = row.meta?.channelId || inferChannelIdFromCard(route, row.entry);
            syncFollowerBadge(row.entry.card, { ...row.meta, channelId });
        }
    }

    function clearLiveElapsedTimer() {
        if (!liveElapsedTimer) return;
        window.clearInterval(liveElapsedTimer);
        liveElapsedTimer = 0;
    }

    function updateLiveElapsedBadgesNow(root = document) {
        const now = Date.now();
        const badges = Array.from(root.querySelectorAll(`[${LIVE_ELAPSED_BADGE_ATTR}="1"]`));
        for (const badge of badges) {
            const start = Number(badge.getAttribute("data-bcgt-live-start")) || 0;
            if (!start) continue;
            const text = formatDuration(Math.max(0, (now - start) / 1000));
            if (text && badge.textContent !== text) badge.textContent = text;
        }
        if (!badges.length) clearLiveElapsedTimer();
    }

    function ensureLiveElapsedTimer() {
        if (document.hidden) return;
        if (liveElapsedTimer) return;
        liveElapsedTimer = window.setInterval(() => updateLiveElapsedBadgesNow(), 1000);
    }

    function handleVisibilityChange() {
        if (document.hidden) {
            clearLiveElapsedTimer();
            return;
        }

        if (document.querySelector(`[${LIVE_ELAPSED_BADGE_ATTR}="1"]`)) {
            updateLiveElapsedBadgesNow();
            ensureLiveElapsedTimer();
        }
    }

    function removeLiveElapsedBadge(card) {
        delete card.__bcgtLiveElapsedHost;
        delete card.__bcgtLiveElapsedKey;
        card.querySelectorAll(`[${LIVE_ELAPSED_BADGE_ATTR}="1"]`).forEach((badge) => badge.remove());
        card.querySelectorAll(`[${LIVE_THUMB_HOST_ATTR}="1"]`).forEach((host) => {
            if (!host.querySelector(`[${LIVE_ELAPSED_BADGE_ATTR}="1"]`)) {
                host.removeAttribute(LIVE_THUMB_HOST_ATTR);
            }
        });
    }

    function clearLiveElapsedBadges(root = document) {
        root.querySelectorAll(`[${CARD_ATTR}="1"]`).forEach((card) => {
            delete card.__bcgtLiveElapsedHost;
            delete card.__bcgtLiveElapsedKey;
        });
        root.querySelectorAll(`[${LIVE_ELAPSED_BADGE_ATTR}="1"]`).forEach((badge) => badge.remove());
        root.querySelectorAll(`[${LIVE_THUMB_HOST_ATTR}="1"]`).forEach((host) =>
            host.removeAttribute(LIVE_THUMB_HOST_ATTR)
        );
        clearLiveElapsedTimer();
    }

    function getLiveThumbnailHost(card, thumbImg) {
        if (!thumbImg) return null;
        const anchor = thumbImg.closest("a[href]");
        if (anchor && card.contains(anchor)) return anchor;
        const picture = thumbImg.closest("picture");
        if (picture?.parentElement && card.contains(picture.parentElement)) return picture.parentElement;
        return thumbImg.parentElement && card.contains(thumbImg.parentElement) ? thumbImg.parentElement : null;
    }

    function getCachedLiveThumbnailHost(card) {
        const cached = card.__bcgtLiveElapsedHost;
        if (cached?.isConnected && card.contains(cached)) return cached;
        const host = getLiveThumbnailHost(card, pickCardThumbnailImage(card));
        card.__bcgtLiveElapsedHost = host || null;
        return host;
    }

    function syncLiveElapsedBadge(card, meta) {
        const label = formatElapsedSince(meta?.publishDate);
        if (!label) {
            removeLiveElapsedBadge(card);
            return;
        }

        const host = getCachedLiveThumbnailHost(card);
        if (!host) {
            removeLiveElapsedBadge(card);
            return;
        }

        if (host.getAttribute(LIVE_THUMB_HOST_ATTR) !== "1") host.setAttribute(LIVE_THUMB_HOST_ATTR, "1");
        let badge = host.querySelector(`[${LIVE_ELAPSED_BADGE_ATTR}="1"]`);
        if (!badge) {
            badge = document.createElement("span");
            badge.setAttribute(LIVE_ELAPSED_BADGE_ATTR, "1");
            host.appendChild(badge);
        }
        const start = String(parseDateTime(meta.publishDate));
        const title = `방송 진행 시간 ${label}`;
        const renderKey = `${label}|${start}|${title}`;
        if (card.__bcgtLiveElapsedKey !== renderKey) {
            if (badge.textContent !== label) badge.textContent = label;
            if (badge.getAttribute("data-bcgt-live-start") !== start) badge.setAttribute("data-bcgt-live-start", start);
            if (badge.getAttribute("title") !== title) badge.setAttribute("title", title);
            card.__bcgtLiveElapsedKey = renderKey;
        }
        ensureLiveElapsedTimer();
    }

    function syncLiveElapsedBadges(route, rows) {
        if (!areLiveElapsedBadgesEnabled() || route?.tab !== "lives") {
            clearLiveElapsedBadges();
            return;
        }
        for (const row of rows) syncLiveElapsedBadge(row.entry.card, row.meta);
        updateLiveElapsedBadgesNow();
    }

    function applyCardAttrs(card, meta) {
        card.setAttribute(INJECTED_ATTR, "1");
        card.setAttribute(CARD_ATTR, "1");
        if (meta?.id) card.setAttribute(CARD_ID_ATTR, String(meta.id));
        card.removeAttribute(HIDE_ATTR);
        card.setAttribute(
            ORDER_ATTR,
            String(Number.isFinite(Number(meta.order)) ? Number(meta.order) : orderCounter++)
        );
    }

    function syncInjectedChannelIdentity(card, channelAnchors, meta) {
        const channelName = normSpace(meta?.channelName);
        if (!channelName) return;

        const explicitName =
            card.querySelector("[class*='name_text']") ||
            channelAnchors
                .map((anchor) =>
                    anchor.querySelector(
                        "[class*='channel_name'], [class*='name_text'], [class*='ellipsis'] > [class*='text']"
                    )
                )
                .find((element) => element && !element.matches(".blind, [class*='blind'], [aria-hidden='true']"));
        if (explicitName) setText(explicitName, channelName);

        for (const anchor of channelAnchors) {
            if (!explicitName) {
                const textTarget = Array.from(anchor.querySelectorAll("strong, span"))
                    .filter((element) => {
                        if (element.matches("[aria-hidden='true'], .blind, [class*='blind']")) return false;
                        return Boolean(normSpace(element.textContent));
                    })
                    .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0];
                if (textTarget) setText(textTarget, channelName);
            }
            anchor.setAttribute("aria-label", `${channelName} 채널로 이동`);
            if (anchor.hasAttribute("title")) anchor.setAttribute("title", channelName);
            for (const label of anchor.querySelectorAll(".blind, [class*='blind']")) {
                if (/채널로 이동/.test(normSpace(label.textContent))) setText(label, `${channelName} 채널로 이동`);
            }
        }
    }

    function buildInjectedLiveCard(route, template, meta) {
        const card = template instanceof HTMLElement ? template.cloneNode(true) : document.createElement("article");
        removeFollowerBadge(card);
        removeLiveElapsedBadge(card);
        applyCardAttrs(card, meta);

        const itemHref = contentHref(route, meta);
        const channelHref = meta.channelId ? `/${meta.channelId}` : "";
        const channelAnchors = [];

        for (const anchor of card.querySelectorAll("a[href]")) {
            const href = anchor.getAttribute("href") || "";
            const hiddenLabels = Array.from(anchor.querySelectorAll(".blind, [class*='blind']"))
                .map((label) => label.textContent || "")
                .join(" ");
            const channelSignal = `${String(anchor.className || "")} ${anchor.getAttribute("aria-label") || ""} ${anchor.getAttribute("title") || ""} ${hiddenLabels}`;
            const isChannelAnchor = /channel|profile|name|채널로 이동/i.test(channelSignal);
            if (getItemId(route, href)) {
                anchor.setAttribute("href", itemHref);
                if (isChannelAnchor) channelAnchors.push(anchor);
            } else if (channelHref && (href.match(/^\/[a-f0-9]{32}/i) || isChannelAnchor)) {
                anchor.setAttribute("href", channelHref);
                channelAnchors.push(anchor);
            }
        }

        const itemAnchors = Array.from(card.querySelectorAll("a[href]")).filter(
            (anchor) => anchor.getAttribute("href") === itemHref
        );
        for (const anchor of itemAnchors) {
            anchor.addEventListener("click", (event) => {
                if (
                    event.defaultPrevented ||
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                )
                    return;
                event.preventDefault();
                window.location.assign(anchor.href);
            });
        }

        const imagePairs = getImagePairs(template, card);
        const thumbImg =
            pickThumbnailImage(imagePairs, card) ||
            itemAnchors.map((anchor) => anchor.querySelector("img")).find(Boolean) ||
            card.querySelector("img");
        setImageSource(thumbImg, meta.thumb, meta.title);
        if (!updateProfileImage(imagePairs, card, thumbImg, meta)) updateProfileBackgroundImage(card, meta);
        updateLiveViewerCount(card, meta.views);

        setText(card.querySelector("a[class*='title'], [class*='title']"), meta.title);
        syncInjectedChannelIdentity(card, channelAnchors, meta);

        const tagContainer = card.querySelector("[class*='information'][class*='link']");
        if (tagContainer) {
            const tagValues = [meta.categoryName, ...(Array.isArray(meta.tags) ? meta.tags : [])].filter(Boolean);
            const tagAnchors = Array.from(tagContainer.querySelectorAll("a"));
            tagAnchors.forEach((anchor, index) => {
                const tag = tagValues[index];
                if (!tag) {
                    anchor.remove();
                    return;
                }
                anchor.setAttribute("href", `/videos?tags=${encodeURIComponent(tag)}`);
                const label = anchor.querySelector("span") || anchor;
                label.textContent = tag;
            });
        }

        syncLiveElapsedBadge(card, meta);
        return card;
    }

    function clearInjectedCards(grid) {
        const root = grid || document;
        root.querySelectorAll(`[${INJECTED_ATTR}="1"]`).forEach((card) => card.remove());
    }

    function buildInjectedCard(route, template, meta) {
        if (route.tab === "lives") return buildInjectedLiveCard(route, template, meta);

        const card = template.cloneNode(true);
        applyCardAttrs(card, meta);

        const itemHref = contentHref(route, meta);
        const channelHref = meta.channelId ? `/${meta.channelId}` : "";
        for (const anchor of card.querySelectorAll("a[href]")) {
            const href = anchor.getAttribute("href") || "";
            if (getItemId(route, href)) {
                anchor.setAttribute("href", itemHref);
            } else if (channelHref && (href.match(/^\/[a-f0-9]{32}/i) || /channel|profile/i.test(anchor.className))) {
                anchor.setAttribute("href", channelHref);
            }
        }

        const itemAnchors = Array.from(card.querySelectorAll("a[href]")).filter(
            (anchor) => anchor.getAttribute("href") === itemHref
        );
        for (const anchor of itemAnchors) {
            anchor.addEventListener("click", (event) => {
                if (
                    event.defaultPrevented ||
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                )
                    return;
                event.preventDefault();
                window.location.assign(anchor.href);
            });
        }
        const imagePairs = getImagePairs(template, card);
        const thumbImg =
            pickThumbnailImage(imagePairs, card) ||
            itemAnchors.map((anchor) => anchor.querySelector("img")).find(Boolean) ||
            card.querySelector("img");
        setImageSource(thumbImg, meta.thumb, meta.title);
        if (!updateProfileImage(imagePairs, card, thumbImg, meta)) updateProfileBackgroundImage(card, meta);
        if (route.tab === "lives") updateLiveViewerCount(card, meta.views);

        setText(card.querySelector("a[class*='title']"), meta.title);
        setText(card.querySelector("[class*='name_text']"), meta.channelName);
        const channelAnchor = card.querySelector("a[class*='channel']");
        if (channelAnchor && !card.querySelector("[class*='name_text']")) setText(channelAnchor, meta.channelName);

        const duration = formatDuration(meta.duration);
        if (duration) setText(card.querySelector("[class*='time']"), duration);

        const date = formatDate(meta.publishDate);
        const infoItem = card.querySelector("[class*='information'] [class*='item']");
        if (date) setText(infoItem, date);

        const tagContainer = card.querySelector("[class*='information'][class*='link']");
        if (tagContainer && Array.isArray(meta.tags)) {
            const tagAnchors = Array.from(tagContainer.querySelectorAll("a"));
            tagAnchors.forEach((anchor, index) => {
                const tag = meta.tags[index];
                if (!tag) {
                    anchor.remove();
                    return;
                }
                anchor.setAttribute("href", `/videos?tags=${encodeURIComponent(tag)}`);
                const label = anchor.querySelector("span") || anchor;
                label.textContent = tag;
            });
        }

        return card;
    }

    function captureScrollAnchor(grid) {
        if (!grid || window.scrollY <= 0) return null;
        const viewportTop = 0;
        const capturedScrollY = window.scrollY;
        const capturedUserScrollAt = lastUserScrollAt;
        const candidates = Array.from(grid.children).filter(
            (child) => child instanceof HTMLElement && child.getAttribute(EMPTY_ATTR) !== "1"
        );
        let best = null;
        for (const child of candidates) {
            const rect = child.getBoundingClientRect();
            if (rect.bottom <= viewportTop) continue;
            if (!best || rect.top < best.top) {
                best = {
                    element: child,
                    top: rect.top,
                    scrollY: capturedScrollY,
                    userScrollAt: capturedUserScrollAt,
                };
            }
        }
        return best;
    }

    function restoreScrollAnchor(anchor) {
        if (!anchor?.element?.isConnected) return;
        if (lastUserScrollAt !== anchor.userScrollAt) return;
        if (Math.abs(window.scrollY - anchor.scrollY) > 2) return;
        const nextTop = anchor.element.getBoundingClientRect().top;
        const delta = nextTop - anchor.top;
        if (Math.abs(delta) > 1) {
            ignoreScrollTrackingUntil = performance.now() + 120;
            window.scrollBy(0, delta);
        }
    }

    async function yieldToUi() {
        await sleep(0);
    }

    function cardImageSignature(card) {
        return Array.from(card?.querySelectorAll?.("img, source, [style]") || [])
            .map((el) =>
                [
                    el.getAttribute?.("src"),
                    el.getAttribute?.("srcset"),
                    el.getAttribute?.("data-src"),
                    el.getAttribute?.("data-original"),
                    el.getAttribute?.("data-lazy-src"),
                    el.getAttribute?.("style"),
                    el.getAttribute?.("class"),
                ].join(" ")
            )
            .join(" ");
    }

    function isRestrictedTemplateCard(card) {
        if (!(card instanceof HTMLElement)) return true;
        const text = normSpace(card.textContent);
        const signature = `${text} ${cardImageSignature(card)}`;
        // "19"\uB97C \uB9E8\uC22B\uC790\uB85C \uB9E4\uCE6D\uD558\uBA74 liveId(19xxxxxx)\uAC00 \uB4E4\uC5B4\uAC04 \uC378\uB124\uC77C URL\uAE4C\uC9C0 \uC804\uBD80 \uC81C\uD55C \uCE74\uB4DC\uB85C \uC624\uD310\uD55C\uB2E4.
        return /(\uC5F0\uB839|\uCCAD\uC18C\uB144|19\s*[+\uAE08]|adult|age[_-]?limit|restricted)/i.test(signature);
    }

    function hasUsableTemplateThumbnail(card) {
        const img = pickCardThumbnailImage(card);
        if (!img) return false;
        const src = [
            img.getAttribute("src"),
            img.getAttribute("srcset"),
            img.getAttribute("data-src"),
            img.getAttribute("data-original"),
            img.getAttribute("data-lazy-src"),
        ].join(" ");
        return getImageArea(img) >= 120 * 68 && !/(adult|age[_-]?limit|restricted)/i.test(src);
    }

    function pickInjectedCardTemplate(entries) {
        return (
            entries
                .filter((entry) => entry.card.getAttribute(INJECTED_ATTR) !== "1")
                .map((entry) => entry.card)
                .find((card) => !isRestrictedTemplateCard(card) && hasUsableTemplateThumbnail(card)) || null
        );
    }

    async function syncInjectedCards(route, grid, entries, metadata, query = normalize(currentQuery)) {
        if (!isAutoLoadActive()) return [];

        if (!canUseMetadataForCurrentList(route)) return [];

        const template = pickInjectedCardTemplate(entries);
        if (!template) return [];

        const renderedIds = new Set(entries.map((entry) => entry.id));
        const fragment = document.createDocumentFragment();
        const injectedEntries = [];
        let builtCount = 0;

        for (const meta of metadata.values()) {
            if (!meta.id || renderedIds.has(meta.id)) continue;
            if (!passesMetaFilters(meta, query)) continue;
            const card = buildInjectedCard(route, template, meta);
            fragment.appendChild(card);
            injectedEntries.push(createCardEntry(card, meta.id, meta));
            renderedIds.add(meta.id);
            builtCount++;

            if (builtCount % UI_YIELD_EVERY_ITEMS === 0) {
                if (fragment.childNodes.length) grid.appendChild(fragment);
                await yieldToUi();
            }
        }

        if (fragment.childNodes.length) grid.appendChild(fragment);
        return injectedEntries;
    }

    function buildMenu() {
        const menu = document.createElement("div");
        menu.id = MENU_ID;
        menu.className = "bcgt-menu";
        menu.setAttribute("role", "menu");
        menu.setAttribute("data-open", "0");
        menu.innerHTML = `
<div class="bcgt-filter-groups">
  <section class="bcgt-filter-group" aria-label="팔로워 수">
    <div class="bcgt-filter-title">팔로워 수</div>
    <div class="bcgt-option-list" data-filter-options="followers"></div>
    <label class="bcgt-custom" data-custom-kind="followers">
      <span>직접</span>
      <input type="text" inputmode="numeric" data-filter-min-input="followers" placeholder="최소" />
      <span>~</span>
      <input type="text" inputmode="numeric" data-filter-max-input="followers" placeholder="최대" />
      <span>명</span>
    </label>
  </section>
  <section class="bcgt-filter-group" aria-label="조회수" data-filter-group="views">
    <div class="bcgt-filter-title" data-view-filter-title>조회수</div>
    <div class="bcgt-option-list" data-filter-options="views"></div>
    <label class="bcgt-custom" data-custom-kind="views">
      <span>직접</span>
      <input type="text" inputmode="numeric" data-filter-min-input="views" placeholder="최소" />
      <span>~</span>
      <input type="text" inputmode="numeric" data-filter-max-input="views" placeholder="최대" />
      <span data-view-filter-unit>회</span>
    </label>
  </section>
  <section class="bcgt-filter-group" aria-label="진행 시간" data-filter-group="duration">
    <div class="bcgt-filter-title">진행 시간</div>
    <div class="bcgt-option-list" data-filter-options="duration"></div>
    <label class="bcgt-custom" data-custom-kind="duration">
      <span>직접</span>
      <input type="text" inputmode="decimal" data-filter-min-input="duration" placeholder="최소" />
      <span>~</span>
      <input type="text" inputmode="decimal" data-filter-max-input="duration" placeholder="최대" />
      <span>시간</span>
    </label>
  </section>
</div>
<div class="bcgt-reset-row">
  <button type="button" class="bcgt-reset" data-filter-reset aria-label="&#54596;&#53552; &#52488;&#44592;&#54868;">&#54596;&#53552; &#52488;&#44592;&#54868;</button>
</div>
`;
        syncFilterOptionButtons(menu);
        const resetButton = menu.querySelector("[data-filter-reset]");
        if (resetButton) {
            resetButton.addEventListener("click", (e) => {
                e.stopPropagation();
                resetFilterState();
                updateUiState();
                scheduleApply();
                scheduleMenuPosition();
            });
        }
        menu.addEventListener("pointermove", (e) => {
            if (!filterOptionDrag) return;
            e.preventDefault();
            updateFilterDrag(e);
        });
        menu.addEventListener("pointerup", (e) => endFilterDrag(e));
        menu.addEventListener("pointercancel", () => {
            filterOptionDrag = null;
        });
        menu.addEventListener("pointerdown", (e) => {
            const option = e.target?.closest?.(".bcgt-option");
            if (!option || !menu.contains(option) || e.button !== 0) return;
            const kind = option.getAttribute("data-filter-kind");
            const range = optionFilterRange(option);
            filterOptionDrag = {
                kind,
                startRange: range,
                currentRange: range,
                moved: false,
            };
            option.setPointerCapture?.(e.pointerId);
        });
        menu.addEventListener("click", (e) => {
            const option = e.target?.closest?.(".bcgt-option");
            if (!option || !menu.contains(option)) return;
            e.stopPropagation();
            if (suppressNextOptionClick) {
                suppressNextOptionClick = false;
                return;
            }
            const kind = option.getAttribute("data-filter-kind");
            const range = optionFilterRange(option);
            if (hasFilterOptionRange(range) && isFilterRangeActive(kind, range)) {
                setFilterValue(kind, 0, "", 0, "");
            } else {
                setFilterRangeFromOptions(kind, range, range);
            }
            updateUiState();
            scheduleApply();
            scheduleMenuPosition();
        });
        for (const input of menu.querySelectorAll("[data-filter-min-input], [data-filter-max-input]")) {
            input.addEventListener("click", (e) => e.stopPropagation());
            input.addEventListener("input", () => {
                const isMax = input.hasAttribute("data-filter-max-input");
                const kind = input.getAttribute(isMax ? "data-filter-max-input" : "data-filter-min-input");
                const value = parseFilterInputForKind(kind, input.value);
                if (isMax) setFilterMax(kind, value, input.value);
                else setFilterMin(kind, value, input.value);
                updateUiState();
                scheduleApply();
            });
            input.addEventListener("keydown", (e) => {
                if (e.key === "Escape") {
                    const isMax = input.hasAttribute("data-filter-max-input");
                    const kind = input.getAttribute(isMax ? "data-filter-max-input" : "data-filter-min-input");
                    input.value = "";
                    if (isMax) setFilterMax(kind, 0, "");
                    else setFilterMin(kind, 0, "");
                    updateUiState();
                    scheduleApply();
                }
            });
        }
        return menu;
    }

    function ensureMenu() {
        let menu = document.getElementById(MENU_ID);
        if (!menu) {
            menu = buildMenu();
            document.body.appendChild(menu);
        }
        return menu;
    }

    function closeMenu() {
        const bar = document.getElementById(BAR_ID);
        const menu = document.getElementById(MENU_ID);
        if (bar) bar.setAttribute("data-menu-open", "0");
        if (menu) menu.setAttribute("data-open", "0");
    }

    function positionMenu() {
        const bar = document.getElementById(BAR_ID);
        const button = bar?.querySelector(".bcgt-filter");
        const menu = document.getElementById(MENU_ID);
        if (
            !bar ||
            !button ||
            !menu ||
            bar.getAttribute("data-menu-open") !== "1" ||
            menu.getAttribute("data-open") !== "1"
        )
            return;

        const buttonRect = button.getBoundingClientRect();
        const scrollTop = menu.scrollTop;
        const menuRect = menu.getBoundingClientRect();
        const width = Math.max(menuRect.width || 560, 320);
        const naturalHeight = Math.max(menu.scrollHeight || menuRect.height || 300, 120);
        const availableAbove = Math.max(0, buttonRect.top - 14);
        const availableBelow = Math.max(0, window.innerHeight - buttonRect.bottom - 14);
        const openBelow = availableBelow > availableAbove;
        const availableHeight = Math.max(120, openBelow ? availableBelow : availableAbove);
        const height = Math.min(naturalHeight, availableHeight);
        const left = Math.min(Math.max(8, buttonRect.right - width), Math.max(8, window.innerWidth - width - 8));
        const top = openBelow
            ? Math.min(window.innerHeight - height - 8, buttonRect.bottom + 6)
            : Math.max(8, buttonRect.top - height - 6);
        const maxHeight = `${Math.floor(availableHeight)}px`;
        if (menu.style.maxHeight !== maxHeight) menu.style.maxHeight = maxHeight;
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
        if (menu.scrollTop !== scrollTop) menu.scrollTop = scrollTop;
    }

    function scheduleMenuPosition() {
        if (menuPositionScheduled) return;
        menuPositionScheduled = true;
        requestAnimationFrame(() => {
            menuPositionScheduled = false;
            positionMenu();
        });
    }

    function handleScrollPositionMenu(event) {
        const menu = document.getElementById(MENU_ID);
        if (!menu) return;
        if (menu && event?.target instanceof Node && menu.contains(event.target)) return;
        const now = performance.now();
        if (now > ignoreScrollTrackingUntil) lastUserScrollAt = now;
        positionMenu();
    }

    function handleViewportChange() {
        if (!document.getElementById(MENU_ID)) return;
        scheduleMenuPosition();
    }

    function updateUiState() {
        const bar = document.getElementById(BAR_ID);
        if (!bar) return;
        bar.setAttribute("data-has-query", currentQuery ? "1" : "0");
        bar.setAttribute("data-has-filter", hasActiveFilters() ? "1" : "0");
        const label = bar.querySelector(".bcgt-filter-label");
        if (label) {
            const count = activeFilterCount();
            label.textContent = count ? `필터 ${count}` : "필터";
        }
        const menu = document.getElementById(MENU_ID);
        const route = getRoute();
        const isLiveList = route?.tab === "lives";
        const viewFilterLabel = isLiveList ? "시청자 수" : "조회수";
        const viewFilterUnit = isLiveList ? "명" : "회";
        syncFilterOptionButtons(menu, route);
        const viewFilterGroup = menu?.querySelector('[data-filter-group="views"]');
        if (viewFilterGroup) viewFilterGroup.setAttribute("aria-label", viewFilterLabel);
        const durationFilterGroup = menu?.querySelector('[data-filter-group="duration"]');
        if (durationFilterGroup) {
            durationFilterGroup.hidden = !isLiveList || !canUseMetadataForCurrentList(route);
        }
        const viewFilterTitle = menu?.querySelector("[data-view-filter-title]");
        if (viewFilterTitle) viewFilterTitle.textContent = viewFilterLabel;
        const viewFilterUnitEl = menu?.querySelector("[data-view-filter-unit]");
        if (viewFilterUnitEl) viewFilterUnitEl.textContent = viewFilterUnit;
        const resetButton = menu?.querySelector("[data-filter-reset]");
        if (resetButton) resetButton.disabled = !hasActiveFilters();
        for (const option of menu?.querySelectorAll(".bcgt-option") || []) {
            const kind = option.getAttribute("data-filter-kind");
            const { min, max: optionMax } = optionFilterRange(option);
            const state = getFilterState(kind);
            const hasRange = state.min > 0 || state.max > 0;
            const optionHasRange = min > 0 || optionMax > 0;
            const optionEnd = optionMax > 0 ? optionMax : min > 0 ? Number.POSITIVE_INFINITY : 0;
            const stateEnd = state.max > 0 ? state.max : Number.POSITIVE_INFINITY;
            const inRange = hasRange && optionHasRange && min >= state.min && optionEnd <= stateEnd;
            const isEdge = inRange && (min === state.min || optionEnd === stateEnd);
            option.setAttribute("aria-checked", state.min === min && state.max === optionMax ? "true" : "false");
            option.setAttribute("data-in-range", inRange ? "1" : "0");
            option.setAttribute("data-range-edge", isEdge ? "1" : "0");
        }
        for (const input of menu?.querySelectorAll("[data-filter-min-input], [data-filter-max-input]") || []) {
            const isMax = input.hasAttribute("data-filter-max-input");
            const kind = input.getAttribute(isMax ? "data-filter-max-input" : "data-filter-min-input");
            const state = getFilterState(kind);
            const value = isMax ? state.maxCustom : state.minCustom;
            if (document.activeElement !== input) input.value = value;
        }
        for (const custom of menu?.querySelectorAll("[data-custom-kind]") || []) {
            const kind = custom.getAttribute("data-custom-kind");
            const state = getFilterState(kind);
            const hasCustomRange = (state.minCustom && state.min > 0) || (state.maxCustom && state.max > 0);
            custom.setAttribute("data-active", hasCustomRange ? "1" : "0");
        }
    }

    function buildToolbar() {
        const bar = document.createElement("div");
        bar.id = BAR_ID;
        bar.setAttribute("data-mode", "inline");
        bar.setAttribute("data-loading", "0");
        bar.setAttribute("data-has-query", "0");
        bar.setAttribute("data-menu-open", "0");
        bar.innerHTML = `
<div class="bcgt-input-wrap">
  <svg class="bcgt-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M10 4a6 6 0 1 0 3.74 10.7l4.28 4.29 1.42-1.42-4.29-4.28A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/>
  </svg>
  <input type="search" placeholder="현재 목록 검색" autocomplete="off" spellcheck="false" />
  <button type="button" class="bcgt-clear" aria-label="지우기" tabindex="-1">
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M18.3 5.71 12 12.01l-6.3-6.3-1.41 1.41 6.3 6.3-6.3 6.3 1.41 1.41 6.3-6.3 6.3 6.3 1.41-1.41-6.3-6.3 6.3-6.3z"/>
    </svg>
  </button>
</div>
<span class="bcgt-meter">
  <span class="bcgt-spinner" aria-hidden="true"></span>
  <span class="bcgt-status" aria-live="polite"></span>
</span>
<span class="bcgt-filter-wrap">
  <button type="button" class="bcgt-filter" aria-haspopup="menu">
    <span class="bcgt-filter-label">필터</span>
    <span aria-hidden="true">▴</span>
  </button>
</span>
`;
        const input = bar.querySelector("input");
        const clear = bar.querySelector(".bcgt-clear");
        const filter = bar.querySelector(".bcgt-filter");
        let isComposing = false;
        let searchApplyTimer = 0;

        const applyInputValue = () => {
            if (searchApplyTimer) {
                window.clearTimeout(searchApplyTimer);
                searchApplyTimer = 0;
            }
            if (!bar.isConnected) return;
            currentQuery = input.value;
            updateUiState();
            scheduleApply();
        };

        const scheduleInputApply = () => {
            if (searchApplyTimer) window.clearTimeout(searchApplyTimer);
            searchApplyTimer = window.setTimeout(applyInputValue, 120);
        };

        input.addEventListener("input", () => {
            if (isComposing) return;
            scheduleInputApply();
        });
        input.addEventListener("compositionstart", () => {
            isComposing = true;
        });
        input.addEventListener("compositionend", () => {
            isComposing = false;
            applyInputValue();
        });
        input.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && currentQuery) {
                input.value = "";
                applyInputValue();
            }
        });
        clear.addEventListener("click", () => {
            input.value = "";
            applyInputValue();
            input.focus();
        });
        filter.addEventListener("click", (e) => {
            e.stopPropagation();
            const open = bar.getAttribute("data-menu-open") === "1";
            if (open) {
                closeMenu();
            } else {
                const menu = ensureMenu();
                bar.setAttribute("data-menu-open", "1");
                menu.setAttribute("data-open", "1");
                updateUiState();
                scheduleMenuPosition();
            }
        });
        updateUiState();
        return bar;
    }

    function mountToolbar(route, context = null) {
        injectStyleOnce();
        let bar = document.getElementById(BAR_ID);
        if (!bar) bar = buildToolbar();
        ensureMenu();

        if (route.scope === "global-lives") {
            const hideTagSearch = shouldHideGlobalTagSearch();
            const tabLine = findGlobalTabLine();
            if (tabLine) {
                // 카테고리 페이지와 동일한 모습이 되도록 콘텐츠 탭(라이브/동영상) 줄 오른쪽에 붙인다.
                if (hideTagSearch) hideGlobalTagSearch();
                else restoreHiddenGlobalTagSearch();
                tabLine.setAttribute(TABS_ATTR, "1");
                bar.setAttribute("data-mode", "category-inline");
                bar.removeAttribute("data-tag-search-hidden");
                bar.style.left = "";
                bar.style.top = "";
                bar.style.width = "";
                if (bar.parentElement !== tabLine) tabLine.appendChild(bar);
                cleanupUnusedGlobalFallback(null);
                document
                    .querySelectorAll(`[${GLOBAL_SORT_ATTR}="1"]`)
                    .forEach((el) => el.removeAttribute(GLOBAL_SORT_ATTR));
                syncFontWithHostUi(bar, tabLine);
            } else {
                const sortLine = findGlobalSortLine(context);
                const host = sortLine || ensureGlobalFallbackHost(route);
                if (!host) return false;
                document.querySelectorAll(`[${TABS_ATTR}="1"]`).forEach((el) => el.removeAttribute(TABS_ATTR));
                document.querySelectorAll(`[${GLOBAL_SORT_ATTR}="1"]`).forEach((el) => {
                    if (el !== host || host.id !== GLOBAL_FALLBACK_ID) el.removeAttribute(GLOBAL_SORT_ATTR);
                });
                if (host.id === GLOBAL_FALLBACK_ID) host.setAttribute(GLOBAL_SORT_ATTR, "1");
                else host.removeAttribute(GLOBAL_SORT_ATTR);
                bar.setAttribute("data-mode", "global-inline");
                bar.setAttribute("data-tag-search-hidden", hideTagSearch ? "1" : "0");
                bar.style.left = "";
                bar.style.top = "";
                bar.style.width = "";
                if (hideTagSearch) {
                    if (bar.parentElement !== host) host.appendChild(bar);
                    hideGlobalTagSearch();
                } else {
                    restoreHiddenGlobalTagSearch();
                    const tagAnchor = getGlobalTagSearchAnchor(host);
                    if (tagAnchor && tagAnchor !== bar) {
                        tagAnchor.setAttribute(TAG_SEARCH_ANCHOR_ATTR, "1");
                        host.insertBefore(bar, tagAnchor);
                    } else if (bar.parentElement !== host) host.appendChild(bar);
                }
                cleanupUnusedGlobalFallback(host);
                syncFontWithHostUi(bar, host);
                rescueInvisibleGlobalToolbar(route, host, bar);
            }
        } else {
            restoreHiddenGlobalTagSearch();
            const tabLine = getContextTabLine(context, route);
            if (!tabLine) return false;
            tabLine.setAttribute(TABS_ATTR, "1");
            bar.setAttribute("data-mode", "category-inline");
            bar.style.left = "";
            bar.style.top = "";
            bar.style.width = "";
            if (bar.parentElement !== tabLine) tabLine.appendChild(bar);
            syncFontWithHostUi(bar, tabLine);
        }

        const key = routeKey(route);
        if (key !== lastRouteKey) {
            currentQuery = "";
            resetFilterState();
            resetMetadata("");
            orderCounter = 0;
            lastFollowerHydrateAt = 0;
            clearFollowerHydrationTimer();
            clearLoading();
            const input = bar.querySelector("input");
            if (input) input.value = "";
            lastRouteKey = key;
            lastListStateKey = "";
            cachedGrid = null;
            cachedGridKey = "";
            updateUiState();
        }
        return true;
    }

    function ensureEmptyMessage(grid) {
        let empty = grid.querySelector(`:scope > [${EMPTY_ATTR}="1"]`);
        if (!empty) {
            empty = document.createElement("div");
            empty.setAttribute(EMPTY_ATTR, "1");
            empty.textContent = "조건에 맞는 결과가 없습니다.";
            grid.appendChild(empty);
        }
        return empty;
    }

    function removeEmptyMessage(grid) {
        const empty = grid.querySelector(`:scope > [${EMPTY_ATTR}="1"]`);
        if (empty) empty.remove();
    }

    function updateStatus(visible, total) {
        const status = document.querySelector(`#${BAR_ID} .bcgt-status`);
        if (!status) return;
        status.textContent = currentQuery || hasActiveFilters() ? `${visible} / ${total}` : "";
    }

    function isAutoLoadActive() {
        return Boolean(normalize(currentQuery)) || hasActiveFilters();
    }

    function queueMetadataSearch(route) {
        if (!route || !isAutoLoadActive() || metadataComplete || metadataPagesLoaded >= getMaxMetadataPages()) {
            if (!isAutoLoadActive()) {
                metadataSearchToken++;
                clearFollowerHydrationTimer();
                clearLoading();
            }
            return;
        }
        const token = ++metadataSearchToken;
        if (metadataSearchRunning) return;

        metadataSearchRunning = true;
        runMetadataSearch(route, token).finally(() => {
            metadataSearchRunning = false;
            if (token !== metadataSearchToken) {
                const nextRoute = getRoute();
                if (nextRoute && isAutoLoadActive()) queueMetadataSearch(nextRoute);
            }
        });
    }

    function hasPendingScrollRoom() {
        const grid = cachedGrid?.isConnected ? cachedGrid : null;
        if (grid) {
            return grid.getBoundingClientRect().bottom > window.innerHeight + AUTO_LOAD_BOTTOM_MARGIN_PX;
        }
        const doc = document.documentElement;
        return doc.scrollHeight - (window.scrollY + window.innerHeight) > AUTO_LOAD_BOTTOM_MARGIN_PX;
    }

    async function runMetadataSearch(route, token) {
        setLoading(true, "metadata");
        try {
            await ensureMetadata(route);
            let pagesThisRun = 0;
            while (
                token === metadataSearchToken &&
                routeKey(route) === routeKey(getRoute()) &&
                isAutoLoadActive() &&
                !metadataComplete &&
                metadataPagesLoaded < getMaxMetadataPages()
            ) {
                if (pagesThisRun >= METADATA_BATCH_PAGES) {
                    scheduleApply();
                    await sleep(AUTO_LOAD_APPLY_SETTLE_MS);
                    if (token !== metadataSearchToken) break;
                    if (hasPendingScrollRoom()) break;
                }
                const cursor = metadataNext;
                if (!cursor) break;
                await loadMetadataPage(route, cursor);
                pagesThisRun += 1;
                const now = performance.now();
                if (now - lastMetadataApplyAt >= METADATA_APPLY_INTERVAL_MS) {
                    lastMetadataApplyAt = now;
                    scheduleApply();
                }
                await sleep(hasFollowerFilter() ? 600 : 80);
            }
            scheduleApply();
        } finally {
            if (token === metadataSearchToken) setLoading(false, "metadata");
        }
    }

    let lastAutoLoadScrollCheckAt = 0;
    let lastBadgeScrollCheckAt = 0;

    function handleAutoLoadScroll() {
        const now = performance.now();
        if (now - lastAutoLoadScrollCheckAt < AUTO_LOAD_SCROLL_THROTTLE_MS) return;
        lastAutoLoadScrollCheckAt = now;

        if (!isFeatureEnabled()) return;

        if (!isAutoLoadActive()) {
            // 필터 미적용: 스크롤로 화면에 새로 들어온 카드의 팔로워 배지만 보충한다.
            if (!areFollowerBadgesEnabled() || !getRoute()) return;
            if (now - lastBadgeScrollCheckAt < BADGE_SCROLL_THROTTLE_MS) return;
            lastBadgeScrollCheckAt = now;
            void refreshFollowerHydrationRows();
            return;
        }

        if (metadataSearchRunning || metadataComplete || metadataPagesLoaded >= getMaxMetadataPages()) return;
        if (hasPendingScrollRoom()) return;

        const route = getRoute();
        if (route) queueMetadataSearch(route);
    }

    async function applyTools() {
        if (!isFeatureEnabled()) {
            removeTools();
            return;
        }

        const route = getRoute();
        if (!route) {
            removeTools();
            return;
        }
        const scanContext = createApplyScanContext(route);
        if (!mountToolbar(route, scanContext)) return;

        const canUseMetadata = canUseMetadataForCurrentList(route, scanContext);
        if (hasDurationFilter() && (route.tab !== "lives" || !canUseMetadata)) {
            resetDurationFilterState();
            resetViewFilterSnapshot();
            updateUiState();
        }
        if (!hasDurationFilter()) clearDurationFilterRefreshTimer();

        let entries = getCardEntries(route, scanContext);
        if (!entries.length) return;
        const grid = entries[0].card.parentElement;
        if (!grid) return;

        const currentListStateKey = listStateKey(route, scanContext);
        if (currentListStateKey !== lastListStateKey) {
            clearInjectedCards(grid);
            resetMetadata(routeKey(route));
            resetViewFilterSnapshot();
            clearFollowerHydrationTimer();
            clearLoading();
            lastListStateKey = currentListStateKey;
            cachedGrid = null;
            cachedGridKey = "";
            scanContext.cardLinksByRoot = new WeakMap();
            entries = getCardEntries(route, scanContext);
        }

        if (!isAutoLoadActive()) {
            resetViewFilterSnapshot();
            clearInjectedCards(grid);
            metadataSearchToken++;
            clearFollowerHydrationTimer();
            clearLoading();
            const metadata = route.tab === "lives" && canUseMetadata ? await ensureMetadata(route) : new Map();
            const visibleRows = entries.map((entry) => ({
                entry,
                meta: {
                    ...(metadata.get(entry.id) || {}),
                    channelId: metadata.get(entry.id)?.channelId || inferChannelIdFromCard(route, entry),
                },
            }));
            rememberFollowerRefreshRows(route, visibleRows);
            syncLiveElapsedBadges(route, visibleRows);
            syncFollowerBadges(route, visibleRows);
            const nearViewportRows = getRowsNearViewport(visibleRows);
            await hydrateFollowers(nearViewportRows, true, true);
            syncFollowerBadges(route, nearViewportRows);
            for (const entry of entries) setCardHidden(entry.card, false);
            removeEmptyMessage(grid);
            updateStatus(entries.length, entries.length);
            return;
        }

        const metadata = canUseMetadata ? await ensureMetadata(route) : new Map();
        scheduleDurationFilterRefresh(metadata.values());
        const query = normalize(currentQuery);
        syncViewFilterSnapshot(route, query);
        const metadataCandidates = Array.from(metadata.values()).filter((meta) => {
            if (!meta?.id) return false;
            if (query && !buildMetaSearchText(meta).includes(query)) return false;
            if (!passesDurationFilter(meta)) return false;
            return passesViewFilter(meta) || isViewFilterSnapshotId(meta.id);
        });

        let followerHydrationPending = false;
        if (hasFollowerFilter()) {
            followerHydrationPending = await hydrateMetadataFollowers(metadataCandidates.filter(isFollowerCandidate));
        }

        const scrollAnchor = captureScrollAnchor(grid);
        const injectedEntries = await syncInjectedCards(route, grid, entries, metadata, query);
        await yieldToUi();
        if (injectedEntries.length) entries = entries.concat(injectedEntries);
        const rows = entries.map((entry) => {
            const meta = metadata.get(entry.id) || {};
            const views =
                Number.isFinite(Number(meta.views)) && Number(meta.views) > 0
                    ? Number(meta.views)
                    : parseViewsFromText(route, entry.domText);
            return {
                entry,
                meta: { ...meta, channelId: meta.channelId || inferChannelIdFromCard(route, entry), views },
            };
        });
        rememberFollowerRefreshRows(route, rows);

        const candidateRows = [];
        let checkedRows = 0;
        for (const row of rows) {
            if (
                (!query || buildSearchText(row).includes(query)) &&
                passesStickyViewFilter(row) &&
                passesDurationFilter(row.meta)
            ) {
                candidateRows.push(row);
            }
            checkedRows++;
            if (checkedRows % UI_YIELD_EVERY_ITEMS === 0) await yieldToUi();
        }

        await hydrateFollowers(rows, !followerHydrationPending, true);
        await yieldToUi();

        const visible = candidateRows
            .filter((row) => passesStickyFilters(row))
            .sort((a, b) => getStableVisibleOrder(a) - getStableVisibleOrder(b));
        rememberVisibleRows(visible);

        const visibleSet = new Set(visible.map((row) => row.entry.card));
        syncLiveElapsedBadges(route, rows);
        syncFollowerBadges(route, rows);
        for (const row of rows) {
            setCardHidden(row.entry.card, !visibleSet.has(row.entry.card));
        }

        if (visible.length) removeEmptyMessage(grid);
        else ensureEmptyMessage(grid);
        restoreScrollAnchor(scrollAnchor);
        updateStatus(visible.length, Math.max(rows.length, metadataCandidates.length));
        if (canUseMetadata) queueMetadataSearch(route);
        else {
            metadataSearchToken++;
            clearLoading();
        }
    }

    function restoreCards() {
        // 시간 모드는 카드로 마킹되지 않은 그리드 자식(사이트 로더 등)도 숨기므로 전부 되살린다.
        document.querySelectorAll(`[${HIDE_ATTR}="1"]`).forEach((el) => setCardHidden(el, false));
        const cards = Array.from(document.querySelectorAll(`[${CARD_ATTR}="1"]`));
        for (const card of cards) {
            setCardHidden(card, false);
            const parent = card.parentElement;
            if (parent) removeEmptyMessage(parent);
        }
    }

    function removeTools() {
        const bar = document.getElementById(BAR_ID);
        const menu = document.getElementById(MENU_ID);
        const fallback = document.getElementById(GLOBAL_FALLBACK_ID);
        if (bar) bar.remove();
        if (menu) menu.remove();
        if (fallback) fallback.remove();
        restoreHiddenGlobalTagSearch();
        clearInjectedCards();
        clearFollowerBadges();
        clearLiveElapsedBadges();
        restoreCards();
        document.querySelectorAll(`[${TABS_ATTR}="1"]`).forEach((el) => el.removeAttribute(TABS_ATTR));
        document.querySelectorAll(`[${GLOBAL_SORT_ATTR}="1"]`).forEach((el) => el.removeAttribute(GLOBAL_SORT_ATTR));
        document.querySelectorAll(`[${CARD_ATTR}="1"]`).forEach((el) => {
            el.removeAttribute(CARD_ATTR);
            el.removeAttribute(INJECTED_ATTR);
            el.removeAttribute(ORDER_ATTR);
        });
        document.querySelectorAll(`[${EMPTY_ATTR}="1"]`).forEach((el) => el.remove());
        currentQuery = "";
        resetFilterState();
        resetViewFilterSnapshot();
        lastRouteKey = "";
        lastListStateKey = "";
        cachedGrid = null;
        cachedGridKey = "";
        resetMetadata("");
        orderCounter = 0;
        lastFollowerHydrateAt = 0;
        followerHydrationRunToken++;
        followerHydrationRefreshing = false;
        followerHydrationQueued = false;
        lastFollowerRefreshRouteKey = "";
        lastFollowerRefreshRows = [];
        lastMetadataApplyAt = 0;
        clearFollowerHydrationTimer();
        clearDurationFilterRefreshTimer();
        clearLoading();
    }

    function runScheduledApply() {
        if (!isFeatureEnabled() || !getRoute()) {
            removeToolsIfMounted();
            return;
        }
        runApply();
    }

    function scheduleApply() {
        if (!isFeatureEnabled()) {
            removeToolsIfMounted();
            return;
        }
        if (!getRoute()) {
            removeToolsIfMounted();
            return;
        }
        scheduleThrottledApply();
    }

    async function runApply() {
        if (applying) {
            applyQueued = true;
            return;
        }
        applying = true;
        try {
            await applyTools();
        } catch (_) {
            // Keep observer-driven retries alive if the page reshapes during async filtering.
        } finally {
            applying = false;
            if (applyQueued) {
                applyQueued = false;
                scheduleApply();
            }
        }
    }

    function isOurNode(node) {
        if (!node || node.nodeType !== 1) return false;
        if (node.id === BAR_ID || node.id === MENU_ID || node.id === GLOBAL_FALLBACK_ID) return true;
        if (node.getAttribute && node.getAttribute(EMPTY_ATTR) === "1") return true;
        if (node.getAttribute && node.getAttribute(INJECTED_ATTR) === "1") return true;
        if (node.getAttribute && node.getAttribute(FOLLOWER_BADGE_ATTR) === "1") return true;
        if (node.getAttribute && node.getAttribute(FOLLOWER_BADGE_WRAP_ATTR) === "1") return true;
        if (node.getAttribute && node.getAttribute(LIVE_ELAPSED_BADGE_ATTR) === "1") return true;
        if (typeof node.closest === "function") {
            if (node.closest(`#${BAR_ID}`)) return true;
            if (node.closest(`#${MENU_ID}`)) return true;
            if (node.closest(`#${GLOBAL_FALLBACK_ID}`)) return true;
            if (node.closest(`[${INJECTED_ATTR}="1"]`)) return true;
            if (node.closest(`[${EMPTY_ATTR}="1"]`)) return true;
            if (node.closest(`[${FOLLOWER_BADGE_ATTR}="1"]`)) return true;
            if (node.closest(`[${FOLLOWER_BADGE_WRAP_ATTR}="1"]`)) return true;
            if (node.closest(`[${LIVE_ELAPSED_BADGE_ATTR}="1"]`)) return true;
        }
        return false;
    }

    function isOurMutation(mutation) {
        if (isOurNode(mutation.target)) return true;
        const added = mutation.addedNodes;
        const removed = mutation.removedNodes;
        if ((!added || added.length === 0) && (!removed || removed.length === 0)) {
            return (
                mutation.type === "attributes" &&
                (mutation.attributeName === TABS_ATTR ||
                    mutation.attributeName === GLOBAL_SORT_ATTR ||
                    mutation.attributeName === CARD_ATTR ||
                    mutation.attributeName === CARD_ID_ATTR ||
                    mutation.attributeName === INJECTED_ATTR ||
                    mutation.attributeName === HIDE_ATTR ||
                    mutation.attributeName === HIDDEN_TAG_SEARCH_ATTR ||
                    mutation.attributeName === TAG_SEARCH_ANCHOR_ATTR ||
                    mutation.attributeName === ORDER_ATTR ||
                    mutation.attributeName === EMPTY_ATTR ||
                    mutation.attributeName === FOLLOWER_BADGE_ATTR ||
                    mutation.attributeName === FOLLOWER_BADGE_WRAP_ATTR ||
                    mutation.attributeName === LIVE_ELAPSED_BADGE_ATTR ||
                    mutation.attributeName === LIVE_THUMB_HOST_ATTR)
            );
        }
        for (const node of added || []) {
            if (node.nodeType === 1 && !isOurNode(node)) return false;
        }
        for (const node of removed || []) {
            if (node.nodeType !== 1) continue;
            if (!isOurNode(node)) return false;
            // 주입 카드 제거는 사이트 재렌더가 지운 것일 수 있어 무시하면 복구가 안 된다.
            // 우리가 지운 경우에도 재적용은 id-set 가드로 멱등이라 한 번 더 도는 비용뿐이다.
            if (node.getAttribute && node.getAttribute(INJECTED_ATTR) === "1") return false;
        }
        return true;
    }

    function startObserver() {
        if (observer) return;
        observer = createMutationObserverSync({
            target: () => document.body || document.documentElement,
            options: {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: [
                    TABS_ATTR,
                    CARD_ATTR,
                    CARD_ID_ATTR,
                    INJECTED_ATTR,
                    HIDE_ATTR,
                    HIDDEN_TAG_SEARCH_ATTR,
                    TAG_SEARCH_ANCHOR_ATTR,
                    ORDER_ATTR,
                    EMPTY_ATTR,
                    FOLLOWER_BADGE_ATTR,
                    FOLLOWER_BADGE_WRAP_ATTR,
                    LIVE_ELAPSED_BADGE_ATTR,
                    LIVE_THUMB_HOST_ATTR,
                ],
            },
            onMutations: () => {
                const route = getRoute();
                if (location.href !== lastUrl) {
                    lastUrl = location.href;
                    if (route) removeTools();
                    else removeToolsIfMounted();
                }
            },
            shouldIgnoreMutations: (mutations) => mutations.every(isOurMutation),
            shouldSchedule: () => isFeatureEnabled() && Boolean(getRoute()),
            schedule: scheduleApply,
        });
    }

    function stopObserver() {
        if (!observer) return;
        observer.disconnectAll?.();
        observer.disconnect();
        observer = null;
    }

    function handleDocumentClick(event) {
        const bar = document.getElementById(BAR_ID);
        const menu = document.getElementById(MENU_ID);
        if (!bar && !menu && getRoute()?.scope !== "global-lives") return;
        handleGlobalSortClick(event);
        if (bar && !bar.contains(event.target) && (!menu || !menu.contains(event.target))) closeMenu();
    }

    function installGlobalListeners() {
        if (globalListenersInstalled) return;
        globalListenersInstalled = true;
        document.addEventListener("click", handleDocumentClick, true);
        document.addEventListener("visibilitychange", handleVisibilityChange, true);
        removePageChangeDetection = startPageChangeDetection(scheduleApply);
        window.addEventListener("resize", handleViewportChange, true);
        window.addEventListener("scroll", handleScrollPositionMenu, true);
        window.addEventListener("scroll", handleAutoLoadScroll, { capture: true, passive: true });
    }

    function uninstallGlobalListeners() {
        if (!globalListenersInstalled) return;
        globalListenersInstalled = false;
        document.removeEventListener("click", handleDocumentClick, true);
        document.removeEventListener("visibilitychange", handleVisibilityChange, true);
        if (removePageChangeDetection) {
            removePageChangeDetection();
            removePageChangeDetection = null;
        }
        window.removeEventListener("resize", handleViewportChange, true);
        window.removeEventListener("scroll", handleScrollPositionMenu, true);
        window.removeEventListener("scroll", handleAutoLoadScroll, true);
    }

    function installRuntime() {
        if (runtimeInstalled) return;
        runtimeInstalled = true;
        startObserver();
        installGlobalListeners();
        scheduleApply();
    }

    function teardownRuntime() {
        runtimeInstalled = false;
        applyQueued = false;
        metadataSearchToken++;
        metadataSearchRunning = false;
        clearFollowerHydrationTimer();
        clearLiveElapsedTimer();
        clearDurationFilterRefreshTimer();
        clearLoading();
        removeToolsIfMounted();
        stopObserver();
        uninstallGlobalListeners();
    }

    function applyOptions(options) {
        const prev = featureOptions;
        featureOptions = options;
        updateUiState();

        if (prev.categoryToolsMaxMetadataPages !== options.categoryToolsMaxMetadataPages) {
            resetMetadata(metadataKey);
        }

        clearFollowerHydrationTimer();

        if (!isFeatureEnabled()) {
            teardownRuntime();
            return;
        }

        installRuntime();

        if (!getRoute()) {
            removeToolsIfMounted();
            return;
        }

        if (!areFollowerBadgesEnabled()) clearFollowerBadges();
        if (!areLiveElapsedBadgesEnabled()) clearLiveElapsedBadges();
        scheduleApply();
    }

    bindFeatureOptions(applyOptions);

    onReady(() => {
        if (isFeatureEnabled()) installRuntime();
    });
})();
