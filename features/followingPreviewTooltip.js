/**
 * features/followingPreviewTooltip.js — 팔로잉과 라이브 목록의 호버 미리보기 재생·소리를 관리한다.
 *
 * 동작 위치: isolated world, 팔로잉 사이드바와 /lives·카테고리 라이브 목록.
 * 하는 일: 팔로잉 링크는 tooltip 미리보기를 띄우고, categoryTools가 필터 결과로 만든 복제 카드는
 *   auto-play-info의 실제 HLS를 썸네일 안에서 재생한다. 네이티브 목록 미리보기는 치지직 플레이어를
 *   그대로 사용한다. 옵션이 켜진 상태에서 우클릭하면 팔로잉은 소리를 토글하고 목록 미리보기는
 *   소리를 켜면서 CSS로 확대한다. 팔로잉 영상에는 소리 상태 아이콘과 전환 피드백을 표시하고,
 *   목록 영상에는 우클릭 동작 안내 툴팁만 표시한다. 페이지 이동·포인터 이탈·DOM 제거 시 정리한다.
 * 의존: 전역 BetterChzzkSettings.normalizeOptions, BetterChzzk.utils(bindFeatureOptions,
 *   fetchJson, injectStyleOnce, normalizeChzzkImageUrl, normalizeChzzkMediaUrl, normSpace, onReady,
 *   startPageChangeDetection, storageSet), vendor/hls.light.min.js가 제공하는 전역 window.Hls.
 * 옵션 키: followingPreviewTooltipEnabled, followingPreviewSoundEnabled,
 *   followingPreviewVolumePercent, livePreviewRightClickSoundEnabled.
 * DOM 마커: #betterchzzk-following-preview 툴팁, data-bcfp-tooltip/data-bcfp-active/
 *   data-bcfp-player-mount/data-bcfp-player-state/data-bcfp-sound-feedback/data-bcfp-list-hint 속성,
 *   .bcfp-* 클래스.
 * 통신: 우클릭으로 바꾼 팔로잉 소리 선호도를 chrome.storage.sync에 저장한다.
 *   livePreviewFastHoverPage.js에는 DOM attribute와 CustomEvent로 활성 상태를 전달한다.
 * 구조:
 *   - 상수/스타일: 셀렉터, 지연 시간, 캐시 TTL, STYLE_TEXT(툴팁 CSS) 정의.
 *   - fetchJson/텍스트 유틸: 문자열 정리, 날짜 파싱, 제목 정리(cleanTitle 등).
 *   - DOM 추정: getImageUrl/resolveHoverInfo/extractDomMeta — 호버 링크에서 폴백 메타 추출.
 *   - API 메타: fetchPreviewMeta/fetchAutoPlayInfo/getPreviewMeta — live-detail·auto-play-info
 *     호출과 캐시(previewCache/pendingRequests).
 *   - 재생 소스 선택: selectHlsSource/getPlaybackSource — LLHLS 우선, HLS 그다음으로 고름.
 *   - 비디오 재생: startHlsPlayback/playVideo/requestPreviewVideo/stopPreviewPlayer — Hls
 *     인스턴스 부착, 볼륨/음소거 적용, 자동재생 실패 시 소리 배지 처리.
 *   - 렌더링: createMedia/createBody/renderPreview/positionTooltip — 툴팁 DOM 구성과 배치.
 *   - 이벤트 라이프사이클: scheduleOpen/openPreview/hidePreview/installListeners/
 *     uninstallListeners — 호버 오픈 지연, 옵션 on/off에 따른 리스너 설치·해제.
 */
(() => {
    const STYLE_ID = "betterchzzk-following-preview-style";
    const TOOLTIP_ID = "betterchzzk-following-preview";
    const TOOLTIP_ATTR = "data-bcfp-tooltip";
    const ACTIVE_ATTR = "data-bcfp-active";
    const HOVER_BRIDGE_ATTR = "data-bcfp-hover-bridge";
    const COLLAPSED_SOURCE_ROW_ATTR = "data-bcsf-source-row";
    const LIVE_LINK_SELECTOR = "a[href*='/live/']";
    const MAIN_CONTENT_SELECTOR = "main, [role='main'], #layout-body";
    const FOLLOWING_HREF_RE = /(^|\/)following(?:[/?#]|$)/i;
    const FOLLOWING_TEXT_RE = /\uD314\uB85C\uC789|following|follow/i;
    const SIDE_CONTAINER_SELECTOR = [
        "aside",
        "nav",
        "[class*='aside']",
        "[class*='sidebar']",
        "[class*='side_bar']",
        "[class*='navigation']",
        "[class*='following']",
        "[class*='follow']",
    ].join(", ");
    const DEDICATED_SIDE_CONTAINER_SELECTOR = [
        "aside",
        "[class*='aside']",
        "[class*='sidebar']",
        "[class*='side_bar']",
    ].join(", ");
    const ITEM_MARKER_RE = /(^|[\s_-])(item|channel|following|follow|live)([\s_-]|$)/i;
    const HIDDEN_TEXT_SELECTOR = ["script", "style", "noscript", "svg", "[hidden]", "[aria-hidden='true']"].join(", ");
    const VISUALLY_HIDDEN_TOKEN_RE = /(^|[\s_-])(blind|sr-only|screen-reader|visually-hidden|a11y-hidden)([\s_-]|$)/i;
    const THUMBNAIL_IMAGE_SELECTOR = [
        "img[src*='livecloud-thumb']",
        "img[src*='/thumbnail/image']",
        "img[data-src*='livecloud-thumb']",
        "img[data-src*='/thumbnail/image']",
        "[class*='thumb'] img[src], [class*='thumb'] img[data-src]",
        "[class*='thumbnail'] img[src], [class*='thumbnail'] img[data-src]",
        "[class*='live_image'] img[src], [class*='live_image'] img[data-src]",
        "[class*='liveImage'] img[src], [class*='liveImage'] img[data-src]",
        "img[class*='thumb'][src], img[class*='thumb'][data-src]",
        "img[class*='thumbnail'][src], img[class*='thumbnail'][data-src]",
        "img[class*='live_image'][src], img[class*='live_image'][data-src]",
        "img[class*='liveImage'][src], img[class*='liveImage'][data-src]",
    ].join(", ");
    const THUMBNAIL_MARKER_RE = /(^|[\s_-])(thumb|thumbnail|poster|live[_-]?image|live[_-]?thumb)([\s_-]|$)/i;
    const PROFILE_IMAGE_MARKER_RE =
        /(^|[\s_-])(avatar|profile|profile[_-]?image|image[_-]?profile|channel[_-]?image|channel[_-]?img)([\s_-]|$)|(?:avatar|profile|channel)Image/i;
    const DECORATIVE_IMAGE_MARKER_RE =
        /(^|[\s_-])(badge|verified|certified|certification|official|icon|mark|emblem|check)([\s_-]|$)|(?:verified|certified|official|badge|icon|mark)Image|\uC778\uC99D/i;
    const LIVE_THUMBNAIL_URL_RE = /(?:livecloud-thumb|\/thumbnail\/image|\/livecloud\/)/i;
    const LIVE_DETAIL_API_BASE = "https://api.chzzk.naver.com/service/v2/channels";
    const LIVE_AUTO_PLAY_API_BASE = "https://api.chzzk.naver.com/service/v1/live";
    const HOVER_OPEN_DELAY_MS = 0;
    const FAST_HOVER_CONFIG_EVENT = "betterchzzk:live-preview-fast-hover-options";
    const FAST_HOVER_CONFIG_ATTR = "data-betterchzzk-live-preview-fast-hover-options";
    const FOLLOWING_PREVIEW_FETCH_DELAY_MS = 100;
    const PREVIEW_PLAYBACK_DELAY_MS = 300;
    const PREVIEW_MAX_HEIGHT = 480;
    const PREVIEW_FOCUS_MAX_HEIGHT = 1080;
    const PREVIEW_SOUND_VOLUME_DEFAULT = 15;
    const FETCH_TIMEOUT_MS = 8000;
    const CACHE_TTL_MS = 20000;
    const MAX_CACHE_ENTRIES = 80;
    const CARD_WIDTH = 460;
    const PLAYER_MOUNT_ATTR = "data-bcfp-player-mount";
    const PLAYER_STATE_ATTR = "data-bcfp-player-state";
    const FORCE_MUTED_ATTR = "data-bcfp-force-muted";
    const LIST_EXPANDED_ATTR = "data-bcfp-list-expanded";
    const LIST_HINT_ATTR = "data-bcfp-list-hint";
    const SOUND_FEEDBACK_ATTR = "data-bcfp-sound-feedback";
    const SOUND_FEEDBACK_DURATION_MS = 1000;
    const CATEGORY_CARD_ATTR = "data-bcgt-card";
    const CATEGORY_INJECTED_ATTR = "data-bcgt-injected";
    const CATEGORY_LIVE_ID_ATTR = "data-bcgt-live-id";
    const CATEGORY_CHANNEL_ID_ATTR = "data-bcgt-channel-id";
    const CATEGORY_PREVIEW_HOST_ATTR = "data-bcgt-live-preview-host";
    const CATEGORY_LIVE_ELAPSED_BADGE_ATTR = "data-bcgt-live-elapsed-badge";
    const ELAPSED_REFRESH_MS = 1000;
    const UNKNOWN_TITLE = "\uC81C\uBAA9 \uC5C6\uB294 \uB77C\uC774\uBE0C";
    const LOADING_TITLE = "\uBBF8\uB9AC\uBCF4\uAE30 \uBD88\uB7EC\uC624\uB294 \uC911";
    const ERROR_TITLE = "\uBBF8\uB9AC\uBCF4\uAE30\uB97C \uBD88\uB7EC\uC62C \uC218 \uC5C6\uC2B5\uB2C8\uB2E4";
    const STYLE_TEXT = `
#${TOOLTIP_ID}{
  position:fixed;
  left:0;
  top:0;
  display:none;
  width:${CARD_WIDTH}px;
  max-width:calc(100vw - 16px);
  overflow:hidden;
  border:1px solid rgba(17,17,20,0.16);
  border-radius:8px;
  background:#FFFFFF;
  color:#111114;
  box-shadow:0 18px 48px rgba(0,0,0,0.26);
  font-family:system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size:12px;
  line-height:1.35;
  z-index:2147483647;
  pointer-events:auto;
  box-sizing:border-box;
}
#${TOOLTIP_ID}[data-show="1"]{display:block;}
[${HOVER_BRIDGE_ATTR}="1"]{
  position:fixed;
  background:transparent;
  pointer-events:auto;
  z-index:2147483647;
}
#${TOOLTIP_ID} .bcfp-media{
  position:relative;
  aspect-ratio:16 / 9;
  overflow:hidden;
  background:#05070A;
}
#${TOOLTIP_ID} .bcfp-media img,
#${TOOLTIP_ID} video.bcfp-player{
  display:block;
  width:100%;
  height:100%;
}
#${TOOLTIP_ID} .bcfp-media img{
  object-fit:cover;
}
#${TOOLTIP_ID} video.bcfp-player{
  position:absolute;
  inset:0;
  border:0;
  background:#05070A;
  object-fit:cover;
}
#${TOOLTIP_ID} video.bcfp-player[${PLAYER_STATE_ATTR}="idle"],
#${TOOLTIP_ID} video.bcfp-player[${PLAYER_STATE_ATTR}="loading"],
#${TOOLTIP_ID} video.bcfp-player[${PLAYER_STATE_ATTR}="error"]{
  visibility:hidden;
}
[${CATEGORY_PREVIEW_HOST_ATTR}="1"]{
  position:relative;
  overflow:hidden;
  isolation:isolate;
}
[${CATEGORY_PREVIEW_HOST_ATTR}="1"] video.bcfp-list-player{
  position:absolute;
  inset:0;
  z-index:3;
  display:block;
  width:100%;
  height:100%;
  border:0;
  background:#05070A;
  object-fit:cover;
}
[${CATEGORY_PREVIEW_HOST_ATTR}="1"] video.bcfp-list-player[${PLAYER_STATE_ATTR}="idle"],
[${CATEGORY_PREVIEW_HOST_ATTR}="1"] video.bcfp-list-player[${PLAYER_STATE_ATTR}="loading"],
[${CATEGORY_PREVIEW_HOST_ATTR}="1"] video.bcfp-list-player[${PLAYER_STATE_ATTR}="error"]{
  visibility:hidden;
}
[${LIST_EXPANDED_ATTR}="1"]{
  position:relative !important;
  z-index:2147483646 !important;
  scale:1.45;
  transform-origin:var(--bcfp-expand-origin, center center);
  border-radius:8px;
  box-shadow:0 18px 48px rgba(0,0,0,0.38);
  transition:scale 120ms ease-out, box-shadow 120ms ease-out;
}
[${LIST_EXPANDED_ATTR}="1"] [${CATEGORY_LIVE_ELAPSED_BADGE_ATTR}="1"]{
  opacity:0 !important;
  visibility:hidden !important;
}
#${TOOLTIP_ID} .bcfp-sound-unlock{
  position:absolute;
  right:8px;
  bottom:8px;
  display:flex;
  align-items:center;
  justify-content:center;
  width:30px;
  height:30px;
  border:1px solid rgba(255,255,255,0.64);
  border-radius:999px;
  background:rgba(5,7,10,0.78);
  color:#FFFFFF;
  box-shadow:0 4px 12px rgba(0,0,0,0.32);
  cursor:pointer;
  font-family:inherit;
  font-size:15px;
  line-height:1;
}
#${TOOLTIP_ID} .bcfp-sound-unlock:focus-visible{
  outline:2px solid #00FFA3;
  outline-offset:2px;
}
.bcfp-sound-feedback-host{
  position:relative !important;
}
.bcfp-sound-feedback{
  position:absolute;
  left:8px;
  bottom:8px;
  z-index:2147483647;
  display:flex;
  align-items:center;
  gap:0;
  min-width:26px;
  min-height:26px;
  padding:5px;
  box-sizing:border-box;
  border:1px solid rgba(255,255,255,0.3);
  border-radius:999px;
  background:rgba(5,7,10,0.78);
  color:#FFFFFF;
  box-shadow:0 3px 12px rgba(0,0,0,0.34);
  backdrop-filter:blur(6px);
  pointer-events:auto;
  font-family:system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size:12px;
  font-weight:800;
  line-height:16px;
  white-space:nowrap;
  transition:gap 180ms ease, padding-right 180ms ease, background-color 180ms ease;
}
.bcfp-sound-feedback::after{
  content:attr(data-tooltip);
  position:absolute;
  left:0;
  bottom:calc(100% + 6px);
  width:max-content;
  max-width:180px;
  padding:5px 7px;
  border:1px solid rgba(255,255,255,0.24);
  border-radius:6px;
  background:rgba(5,7,10,0.94);
  color:#FFFFFF;
  box-shadow:0 3px 12px rgba(0,0,0,0.34);
  font-size:11px;
  font-weight:700;
  line-height:15px;
  opacity:0;
  visibility:hidden;
  transform:translateY(3px);
  transition:opacity 120ms ease, transform 120ms ease, visibility 120ms ease;
}
.bcfp-sound-feedback:not([data-expanded="1"]):hover::after{
  opacity:1;
  visibility:visible;
  transform:translateY(0);
  transition-delay:180ms;
}
.bcfp-list-hint-host{
  position:relative !important;
}
.bcfp-list-hint{
  position:absolute;
  left:8px;
  bottom:8px;
  z-index:2147483647;
  max-width:calc(100% - 16px);
  padding:5px 8px;
  box-sizing:border-box;
  border:1px solid rgba(255,255,255,0.24);
  border-radius:6px;
  background:rgba(5,7,10,0.9);
  color:#FFFFFF;
  box-shadow:0 3px 12px rgba(0,0,0,0.34);
  pointer-events:none;
  font-family:system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size:11px;
  font-weight:700;
  line-height:15px;
  white-space:nowrap;
  opacity:0;
  visibility:hidden;
  transform:translateY(3px);
  transition:opacity 120ms ease, transform 120ms ease, visibility 120ms ease;
}
.bcfp-list-hint-host:hover > .bcfp-list-hint{
  opacity:1;
  visibility:visible;
  transform:translateY(0);
  transition-delay:180ms;
}
.bcfp-sound-feedback .bcfp-sound-feedback-icon{
  display:block;
  width:16px;
  height:16px;
  flex:0 0 auto;
  color:#D8DCE3;
}
.bcfp-sound-feedback[data-sound="on"] .bcfp-sound-feedback-icon{
  color:#00FFA3;
}
.bcfp-sound-feedback .bcfp-sound-feedback-label{
  display:block;
  max-width:0;
  overflow:hidden;
  opacity:0;
  transform:translateX(-4px);
  transition:max-width 180ms ease, opacity 120ms ease, transform 180ms ease;
}
.bcfp-sound-feedback[data-expanded="1"]{
  gap:5px;
  padding-right:8px;
  background:rgba(5,7,10,0.88);
}
.bcfp-sound-feedback[data-expanded="1"] .bcfp-sound-feedback-label{
  max-width:80px;
  opacity:1;
  transform:translateX(0);
}
@media (prefers-reduced-motion: reduce){
  .bcfp-sound-feedback,
  .bcfp-sound-feedback::after,
  .bcfp-sound-feedback .bcfp-sound-feedback-label,
  .bcfp-list-hint{transition:none;}
}
#${TOOLTIP_ID} .bcfp-body{
  display:flex;
  flex-direction:column;
  gap:3px;
  min-width:0;
  padding:8px 10px 9px;
}
#${TOOLTIP_ID} .bcfp-channel,
#${TOOLTIP_ID} .bcfp-title,
#${TOOLTIP_ID} .bcfp-meta{
  min-width:0;
  overflow:hidden;
  text-overflow:ellipsis;
}
#${TOOLTIP_ID} .bcfp-channel{
  color:#697183;
  font-size:11px;
  font-weight:800;
  white-space:nowrap;
}
#${TOOLTIP_ID} .bcfp-title{
  display:-webkit-box;
  -webkit-box-orient:vertical;
  -webkit-line-clamp:2;
  color:#111114;
  font-size:14px;
  font-weight:900;
  line-height:1.3;
  overflow:hidden;
  word-break:keep-all;
  overflow-wrap:anywhere;
}
#${TOOLTIP_ID} .bcfp-meta{
  display:flex;
  align-items:center;
  gap:5px;
  color:#697183;
  font-size:11px;
  font-weight:800;
  white-space:nowrap;
}
#${TOOLTIP_ID} .bcfp-meta span:not(:first-child)::before{
  content:"";
  display:inline-block;
  width:3px;
  height:3px;
  margin:0 6px 2px 0;
  border-radius:50%;
  background:currentColor;
  opacity:0.72;
}
#${TOOLTIP_ID}[data-state="loading"] .bcfp-title,
#${TOOLTIP_ID}[data-state="error"] .bcfp-title{
  color:#4F5968;
}
[${ACTIVE_ATTR}="1"]{
  background:rgba(0,255,163,0.12) !important;
  border-radius:6px;
  box-shadow:0 0 0 1px rgba(0,168,107,0.32);
}
html[dark] #${TOOLTIP_ID},
body[theme="dark"] #${TOOLTIP_ID},
[class*="dark"] #${TOOLTIP_ID}{
  border-color:rgba(157,165,182,0.22);
  background:#1B1D20;
  color:#F2F4F7;
  box-shadow:0 20px 54px rgba(0,0,0,0.42);
}
html[dark] #${TOOLTIP_ID} .bcfp-channel,
body[theme="dark"] #${TOOLTIP_ID} .bcfp-channel,
[class*="dark"] #${TOOLTIP_ID} .bcfp-channel,
html[dark] #${TOOLTIP_ID} .bcfp-meta,
body[theme="dark"] #${TOOLTIP_ID} .bcfp-meta,
[class*="dark"] #${TOOLTIP_ID} .bcfp-meta{
  color:#9DA5B6;
}
html[dark] #${TOOLTIP_ID} .bcfp-title,
body[theme="dark"] #${TOOLTIP_ID} .bcfp-title,
[class*="dark"] #${TOOLTIP_ID} .bcfp-title{
  color:#F2F4F7;
}
html[dark] #${TOOLTIP_ID}[data-state="loading"] .bcfp-title,
body[theme="dark"] #${TOOLTIP_ID}[data-state="loading"] .bcfp-title,
[class*="dark"] #${TOOLTIP_ID}[data-state="loading"] .bcfp-title,
html[dark] #${TOOLTIP_ID}[data-state="error"] .bcfp-title,
body[theme="dark"] #${TOOLTIP_ID}[data-state="error"] .bcfp-title,
[class*="dark"] #${TOOLTIP_ID}[data-state="error"] .bcfp-title{
  color:#C6CCD6;
}
html[dark] [${ACTIVE_ATTR}="1"],
body[theme="dark"] [${ACTIVE_ATTR}="1"],
[class*="dark"] [${ACTIVE_ATTR}="1"]{
  background:rgba(0,255,163,0.16) !important;
  box-shadow:0 0 0 1px rgba(0,255,163,0.4);
}
@media (max-width: 520px){
  #${TOOLTIP_ID}{
    width:calc(100vw - 16px);
  }
}
`;
    const {
        bindFeatureOptions,
        fetchJson: sharedFetchJson,
        injectStyleOnce,
        normalizeChzzkImageUrl,
        normalizeChzzkMediaUrl,
        normSpace,
        onReady,
        startPageChangeDetection,
        storageSet,
    } = BetterChzzk.utils;

    let featureOptions = BetterChzzkSettings.normalizeOptions();
    let listenersInstalled = false;
    let tooltip = null;
    let hoverBridge = null;
    let activeInfo = null;
    let pendingInfo = null;
    let openTimer = 0;
    let requestToken = 0;
    let elapsedTimer = 0;
    let activeMeta = null;
    let activeFetchController = null;
    let previewFetchTimer = 0;
    let playerStartTimer = 0;
    let removePageChangeDetection = null;
    let videoRequestSeq = 0;
    let activeVideoRequestId = "";
    let activeVideoSession = null;
    let activeInjectedInfo = null;
    let injectedFetchController = null;
    let injectedRequestToken = 0;
    let injectedDisconnectObserver = null;
    let activeListExpansion = null;
    let listExpansionObserver = null;
    let soundFeedbackEl = null;
    let soundFeedbackSurface = null;
    let soundFeedbackTimer = 0;
    let listHintEl = null;
    let listHintSurface = null;

    const previewCache = new Map();
    const pendingRequests = new Map();

    async function fetchJson(url, { signal, timeoutMs = FETCH_TIMEOUT_MS, ...init } = {}) {
        if (sharedFetchJson) return sharedFetchJson(url, { signal, timeoutMs, ...init });

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

    function compactSpaces(value) {
        return normSpace(value);
    }

    function pickString(...values) {
        for (const value of values) {
            const text = compactSpaces(value);
            if (text) return text;
        }
        return "";
    }

    function pickRawString(...values) {
        for (const value of values) {
            if (typeof value !== "string") continue;
            const text = value.trim();
            if (text) return text;
        }
        return "";
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

    function touchMapEntry(map, key, value, maxSize) {
        map.delete(key);
        map.set(key, value);
        while (map.size > maxSize) {
            const oldestKey = map.keys().next().value;
            if (oldestKey === undefined) break;
            map.delete(oldestKey);
        }
        return value;
    }

    function isFeatureEnabled() {
        return featureOptions.followingPreviewTooltipEnabled;
    }

    function isRightClickSoundEnabled() {
        return featureOptions.livePreviewRightClickSoundEnabled !== false;
    }

    function publishFastHoverOptions() {
        if (!document.documentElement) return;
        document.documentElement.setAttribute(
            FAST_HOVER_CONFIG_ATTR,
            JSON.stringify({ enabled: Boolean(isFeatureEnabled()) })
        );
        window.dispatchEvent(new CustomEvent(FAST_HOVER_CONFIG_EVENT));
    }

    function isLiveListRoute() {
        return /^\/lives\/?$/.test(location.pathname) || /^\/category\/[^/]+\/[^/]+\/lives\/?$/.test(location.pathname);
    }

    function getElementMarker(el) {
        if (!(el instanceof Element)) return "";
        return normSpace(
            `${el.tagName || ""} ${String(el.className || "")} ${el.id || ""} ${el.getAttribute("aria-label") || ""}`
        );
    }

    function isHiddenTextElement(el) {
        if (!(el instanceof Element)) return true;
        if (el.matches(HIDDEN_TEXT_SELECTOR)) return true;

        if (VISUALLY_HIDDEN_TOKEN_RE.test(getElementMarker(el))) return true;

        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return true;
        if (style.clip && style.clip !== "auto") return true;
        if (style.clipPath && style.clipPath !== "none") return true;

        return false;
    }

    function collectReadableText(node, chunks) {
        if (node.nodeType === Node.TEXT_NODE) {
            chunks.push(node.nodeValue || "");
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const el = /** @type {Element} */ (node);
        if (isHiddenTextElement(el)) return;

        for (const child of el.childNodes) collectReadableText(child, chunks);
    }

    function getReadableText(root) {
        if (!root) return "";
        const chunks = [];
        collectReadableText(root, chunks);
        return normSpace(chunks.join(" "));
    }

    function getTextBySelectors(root, selectors) {
        if (!root) return "";
        for (const selector of selectors) {
            const text = getReadableText(root.querySelector(selector));
            if (text) return text;
        }
        return "";
    }

    function normalizeImageUrl(value) {
        const raw = pickString(value);
        if (!raw) return "";

        const withSize = raw.replace(/\{type\}|%7Btype%7D/gi, "480");
        return normalizeChzzkImageUrl(withSize, location.origin);
    }

    function getBackgroundImageUrl(el) {
        if (!(el instanceof Element)) return "";
        const value = getComputedStyle(el).backgroundImage || "";
        const match = value.match(/url\((["']?)(.*?)\1\)/i);
        return normalizeImageUrl(match?.[2] || "");
    }

    function getImageCandidateUrl(el) {
        if (!(el instanceof Element)) return "";

        if (el instanceof HTMLImageElement) {
            return normalizeImageUrl(
                el.currentSrc ||
                    el.getAttribute("src") ||
                    el.getAttribute("data-src") ||
                    el.getAttribute("data-lazy-src") ||
                    ""
            );
        }

        return getBackgroundImageUrl(el);
    }

    function getImageCandidateMarker(el) {
        const parts = [];
        for (let node = el; node instanceof Element && parts.length < 4; node = node.parentElement) {
            parts.push(getElementMarker(node));
        }
        if (el instanceof HTMLImageElement) {
            parts.push(el.getAttribute("alt") || "", el.getAttribute("title") || "", el.getAttribute("src") || "");
        }
        return normSpace(parts.join(" "));
    }

    function isLikelyLiveThumbnail(el, url) {
        if (LIVE_THUMBNAIL_URL_RE.test(url)) return true;
        return THUMBNAIL_MARKER_RE.test(getImageCandidateMarker(el));
    }

    function shouldUseImageCandidate(el, url, { requireThumbnail = true } = {}) {
        if (!url) return false;
        const marker = getImageCandidateMarker(el);
        if (DECORATIVE_IMAGE_MARKER_RE.test(marker)) return false;
        if (PROFILE_IMAGE_MARKER_RE.test(marker)) return false;
        if (isLikelyLiveThumbnail(el, url)) return true;
        return !requireThumbnail;
    }

    function getImageUrl(root) {
        if (!root) return "";

        for (const el of root.querySelectorAll(THUMBNAIL_IMAGE_SELECTOR)) {
            const url = getImageCandidateUrl(el);
            if (shouldUseImageCandidate(el, url, { requireThumbnail: true })) return url;
        }

        for (const img of root.querySelectorAll("img[src], img[data-src], img[data-lazy-src]")) {
            const url = getImageCandidateUrl(img);
            if (shouldUseImageCandidate(img, url, { requireThumbnail: true })) return url;
        }

        for (const el of root.querySelectorAll(
            "[class*='thumb'], [class*='thumbnail'], [class*='live_image'], [class*='liveImage']"
        )) {
            const url = getBackgroundImageUrl(el);
            if (shouldUseImageCandidate(el, url, { requireThumbnail: true })) return url;
        }

        const rootImage = getBackgroundImageUrl(root);
        return shouldUseImageCandidate(root, rootImage, { requireThumbnail: true }) ? rootImage : "";
    }

    function extractChannelIdFromHref(href) {
        try {
            const url = new URL(href, location.origin);
            const match = url.pathname.match(/^\/live\/([^/?#]+)/);
            return match ? decodeURIComponent(match[1]) : "";
        } catch (_) {
            return "";
        }
    }

    function hasFollowingSignal(root) {
        if (!(root instanceof Element)) return false;
        if (FOLLOWING_TEXT_RE.test(getElementMarker(root))) return true;
        if (FOLLOWING_TEXT_RE.test(normSpace(root.textContent))) return true;

        return Array.from(root.querySelectorAll("a[href]")).some((anchor) => {
            const href = anchor.getAttribute("href") || "";
            return FOLLOWING_HREF_RE.test(href);
        });
    }

    function getChildBranchContaining(container, descendant) {
        let branch = descendant;
        while (branch?.parentElement && branch.parentElement !== container) branch = branch.parentElement;
        return branch?.parentElement === container ? branch : null;
    }

    function hasLocalFollowingSignal(container, link) {
        if (FOLLOWING_TEXT_RE.test(getElementMarker(container))) return true;
        if (container.matches(DEDICATED_SIDE_CONTAINER_SELECTOR)) return hasFollowingSignal(container);

        const branch = getChildBranchContaining(container, link);
        return Boolean(branch && hasFollowingSignal(branch));
    }

    function getFollowingSidebarContainer(link) {
        for (let node = link.parentElement; node && node !== document.body; node = node.parentElement) {
            if (!(node instanceof HTMLElement)) continue;

            const marker = getElementMarker(node);
            const isSideLike = node.matches(SIDE_CONTAINER_SELECTOR) || FOLLOWING_TEXT_RE.test(marker);
            if (isSideLike && hasLocalFollowingSignal(node, link)) return node;
        }
        return null;
    }

    function isLikelyItemElement(el) {
        if (!(el instanceof HTMLElement)) return false;
        if (el.matches("li, [role='listitem']")) return true;
        return ITEM_MARKER_RE.test(getElementMarker(el));
    }

    function findItemElement(link, container) {
        let node = link;
        let best = link;

        for (let depth = 0; node?.parentElement && node.parentElement !== document.body && depth < 7; depth += 1) {
            const parent = node.parentElement;
            if (isLikelyItemElement(parent)) best = parent;
            if (parent === container) break;
            if (parent.querySelectorAll(LIVE_LINK_SELECTOR).length > 1 && best !== link) break;
            node = parent;
        }

        return best;
    }

    function extractDomMeta(item, link, channelId) {
        const rawText = getReadableText(item);
        const channelName = pickString(
            getTextBySelectors(item, [
                "[class*='name_text']",
                "[class*='channel_name']",
                "[class*='channelName']",
                "[class*='nickname']",
                "[class*='name']",
            ]),
            link.getAttribute("aria-label"),
            link.getAttribute("title"),
            getReadableText(link),
            channelId
        );
        const title = cleanEntryTitle(
            pickString(
                getTextBySelectors(item, [
                    "[class*='title_text']",
                    "[class*='live_title']",
                    "[class*='liveTitle']",
                    "[class*='title']",
                ]),
                rawText
            ),
            channelName
        );

        return {
            category: "",
            channelId,
            channelName,
            elapsedText: "",
            thumbnailUrl: getImageUrl(item) || getImageUrl(link),
            title: title && title !== channelName ? title : "",
        };
    }

    function resolveHoverInfo(target) {
        if (!(target instanceof Element)) return null;

        const link = target.closest(LIVE_LINK_SELECTOR);
        if (!(link instanceof HTMLAnchorElement)) return null;
        if (link.closest(MAIN_CONTENT_SELECTOR)) return null;

        const channelId = extractChannelIdFromHref(link.getAttribute("href") || "");
        if (!channelId) return null;

        const container = getFollowingSidebarContainer(link);
        if (!container) return null;

        const item = findItemElement(link, container);
        return {
            channelId,
            domMeta: extractDomMeta(item, link, channelId),
            item,
            link,
        };
    }

    function resolveInjectedPreviewInfo(target) {
        if (!(target instanceof Element) || !isLiveListRoute()) return null;

        const host = target.closest(`[${CATEGORY_PREVIEW_HOST_ATTR}="1"]`);
        if (!(host instanceof HTMLElement)) return null;

        const card = host.closest(
            `[${CATEGORY_CARD_ATTR}="1"][${CATEGORY_INJECTED_ATTR}="1"][${CATEGORY_LIVE_ID_ATTR}]`
        );
        if (!(card instanceof HTMLElement)) return null;

        const liveId = compactSpaces(card.getAttribute(CATEGORY_LIVE_ID_ATTR));
        const channelId = pickString(
            card.getAttribute(CATEGORY_CHANNEL_ID_ATTR),
            card.getAttribute("data-bcgt-card-id")
        );
        const link = Array.from(card.querySelectorAll(LIVE_LINK_SELECTOR)).find((anchor) => host.contains(anchor));
        if (!liveId || !channelId || !(link instanceof HTMLAnchorElement)) return null;

        return {
            card,
            channelId,
            domMeta: {
                ...extractDomMeta(card, link, channelId),
                liveId,
            },
            host,
            link,
            liveId,
        };
    }

    function getElapsedStartMs(value) {
        const date = value instanceof Date ? value : parseChzzkDate(value);
        const startMs = date?.getTime?.() || 0;
        return Number.isFinite(startMs) && startMs > 0 ? startMs : 0;
    }

    function formatElapsedFromMs(startMs) {
        if (!startMs) return "";
        const totalSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
        if (!Number.isFinite(totalSeconds)) return "";

        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
    }

    function normalizePreviewMeta(source, fallback = {}) {
        const content = source?.content ?? source ?? {};
        const channel = content.channel || content.channelInfo || content.channelModel || {};
        const channelName = pickString(channel.channelName, channel.name, content.channelName, fallback.channelName);
        const livePlaybackJson = pickRawString(content.livePlaybackJson);
        const previewPlaybackJson = pickRawString(content.previewPlaybackJson);
        const title = cleanEntryTitle(
            pickString(content.liveTitle, content.title, content.broadcastTitle, fallback.title),
            channelName
        );
        const openDate = pickString(content.openDate, content.liveOpenDate, content.startedAt, content.startDate);
        const elapsedStartMs = getElapsedStartMs(openDate) || Number(fallback.elapsedStartMs) || 0;

        return {
            category: pickString(
                content.liveCategoryValue,
                content.liveCategory,
                content.categoryValue,
                content.categoryName,
                fallback.category
            ),
            channelId: fallback.channelId,
            channelName,
            elapsedStartMs,
            elapsedText: formatElapsedFromMs(elapsedStartMs) || fallback.elapsedText || "",
            thumbnailUrl: normalizeImageUrl(
                pickString(
                    content.liveImageUrl,
                    content.thumbnailImageUrl,
                    content.defaultThumbnailImageUrl,
                    content.posterImageUrl,
                    fallback.thumbnailUrl
                )
            ),
            title: title || fallback.title,
            liveId: pickString(content.liveId, fallback.liveId),
            playbackJson: pickRawString(
                livePlaybackJson,
                previewPlaybackJson,
                content.playbackJson,
                fallback.playbackJson
            ),
            isPreviewPlayback: !livePlaybackJson && Boolean(previewPlaybackJson || fallback.isPreviewPlayback),
        };
    }

    function normalizeAutoPlayInfo(source, fallback = {}) {
        const content = source?.content ?? source ?? {};
        const livePlaybackJson = pickRawString(content.livePlaybackJson);
        const previewPlaybackJson = pickRawString(content.previewPlaybackJson);
        const playbackJson = pickRawString(
            livePlaybackJson,
            previewPlaybackJson,
            content.playbackJson,
            fallback.playbackJson
        );

        return {
            ...fallback,
            playbackJson,
            isPreviewPlayback: !livePlaybackJson && Boolean(previewPlaybackJson || fallback.isPreviewPlayback),
        };
    }

    async function fetchPreviewMeta(channelId, fallback, { signal } = {}) {
        const url = `${LIVE_DETAIL_API_BASE}/${encodeURIComponent(channelId)}/live-detail`;
        const json = await fetchJson(url, { signal, timeoutMs: FETCH_TIMEOUT_MS });
        return normalizePreviewMeta(json, fallback);
    }

    async function fetchAutoPlayInfo(liveId, { signal } = {}) {
        const url = `${LIVE_AUTO_PLAY_API_BASE}/${encodeURIComponent(liveId)}/auto-play-info`;
        const json = await fetchJson(url, { signal, timeoutMs: FETCH_TIMEOUT_MS });
        return normalizeAutoPlayInfo(json);
    }

    async function fetchPreviewData(channelId, fallback, { signal } = {}) {
        const meta = await fetchPreviewMeta(channelId, fallback, { signal });
        if (!meta.liveId) return meta;

        try {
            const playback = await fetchAutoPlayInfo(meta.liveId, { signal });
            const normalizedPlayback = normalizeAutoPlayInfo(playback, meta);
            return getPlaybackSource(normalizedPlayback) ? normalizedPlayback : meta;
        } catch (error) {
            if (isAbortError(error)) throw error;
            return meta;
        }
    }

    async function getPreviewMeta(channelId, fallback, { signal } = {}) {
        const now = Date.now();
        const cached = previewCache.get(channelId);
        if (cached && now - cached.cachedAt <= CACHE_TTL_MS) return cached.value;

        if (signal) {
            const value = await fetchPreviewData(channelId, fallback, { signal });
            return touchMapEntry(previewCache, channelId, { cachedAt: Date.now(), value }, MAX_CACHE_ENTRIES).value;
        }

        if (!pendingRequests.has(channelId)) {
            const request = fetchPreviewData(channelId, fallback)
                .then((value) => {
                    touchMapEntry(previewCache, channelId, { cachedAt: Date.now(), value }, MAX_CACHE_ENTRIES);
                    return value;
                })
                .finally(() => pendingRequests.delete(channelId));
            pendingRequests.set(channelId, request);
        }

        return pendingRequests.get(channelId);
    }

    function getCachedPreviewMeta(channelId) {
        const cached = previewCache.get(channelId);
        if (!cached || Date.now() - cached.cachedAt > CACHE_TTL_MS) return null;
        return cached.value;
    }

    async function getInjectedPreviewMeta(info, { signal } = {}) {
        const cacheKey = `list:${info.liveId}`;
        const cached = previewCache.get(cacheKey);
        if (cached && Date.now() - cached.cachedAt <= CACHE_TTL_MS) return cached.value;

        const playback = await fetchAutoPlayInfo(info.liveId, { signal });
        const value = normalizeAutoPlayInfo(playback, {
            ...info.domMeta,
            channelId: info.channelId,
            liveId: info.liveId,
        });
        return touchMapEntry(previewCache, cacheKey, { cachedAt: Date.now(), value }, MAX_CACHE_ENTRIES).value;
    }

    function getTooltip() {
        if (tooltip?.isConnected) return tooltip;

        const el = document.createElement("div");
        el.id = TOOLTIP_ID;
        el.setAttribute(TOOLTIP_ATTR, "1");
        el.addEventListener("pointerleave", handleTooltipPointerLeave);
        document.body.appendChild(el);
        tooltip = el;
        return el;
    }

    function clearHoverBridge() {
        hoverBridge?.remove();
        hoverBridge = null;
    }

    function syncHoverBridge(anchorRect, tipRect) {
        if (!activeInfo?.item?.hasAttribute(COLLAPSED_SOURCE_ROW_ATTR)) {
            clearHoverBridge();
            return;
        }

        let left = 0;
        let right = 0;
        if (tipRect.left >= anchorRect.right) {
            left = anchorRect.right;
            right = tipRect.left;
        } else if (tipRect.right <= anchorRect.left) {
            left = tipRect.right;
            right = anchorRect.left;
        }
        const top = Math.max(anchorRect.top, tipRect.top);
        const bottom = Math.min(anchorRect.bottom, tipRect.bottom);
        if (right <= left || bottom <= top) {
            clearHoverBridge();
            return;
        }

        if (!hoverBridge?.isConnected) {
            hoverBridge = document.createElement("div");
            hoverBridge.setAttribute(HOVER_BRIDGE_ATTR, "1");
            hoverBridge.setAttribute("aria-hidden", "true");
            document.body.appendChild(hoverBridge);
        }
        hoverBridge.style.left = `${Math.round(left)}px`;
        hoverBridge.style.top = `${Math.round(top)}px`;
        hoverBridge.style.width = `${Math.round(right - left)}px`;
        hoverBridge.style.height = `${Math.round(bottom - top)}px`;
    }

    function clearPlayerStartTimer() {
        if (!playerStartTimer) return;
        window.clearTimeout(playerStartTimer);
        playerStartTimer = 0;
    }

    function markPlayerState(video, state) {
        if (!video) return;
        video.setAttribute(PLAYER_STATE_ATTR, state);
    }

    function cleanupVideoElement(video) {
        if (!video) return;

        try {
            video.pause?.();
        } catch (_) {
            // Some test DOMs do not implement media methods.
        }
        try {
            video.removeAttribute("src");
            video.load?.();
        } catch (_) {
            // Some test DOMs do not implement media methods.
        }
    }

    function stopPreviewPlayer(requestId = activeVideoRequestId) {
        clearPlayerStartTimer();
        if (!requestId && !activeVideoSession) return;
        if (requestId && activeVideoRequestId && requestId !== activeVideoRequestId) return;

        const session = activeVideoSession;
        activeVideoSession = null;
        activeVideoRequestId = "";

        try {
            session?.hls?.destroy?.();
        } catch (_) {
            // Destroy should not block tooltip teardown.
        }
        cleanupVideoElement(session?.video);
        markPlayerState(session?.video, "idle");
    }

    function queuePreviewTask(fn) {
        if (typeof queueMicrotask === "function") {
            queueMicrotask(fn);
            return;
        }
        Promise.resolve().then(fn);
    }

    function parsePlaybackJson(value) {
        const raw = pickRawString(value);
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    }

    function getMediaHeight(media) {
        const heights = Array.isArray(media?.encodingTrack)
            ? media.encodingTrack
                  .map(
                      (track) =>
                          Number(track?.videoHeight) ||
                          Number(String(track?.encodingTrackId || "").match(/\d+/)?.[0]) ||
                          0
                  )
                  .filter((height) => height > 0)
            : [];
        return heights.length ? Math.min(...heights) : 0;
    }

    function selectHlsSource(playback) {
        const mediaList = Array.isArray(playback?.media) ? playback.media : [];
        const hlsMedia = mediaList
            .map((media) => {
                const path = pickRawString(media?.path);
                const marker = pickString(media?.mediaId, media?.protocol);
                if (!path || !(/HLS/i.test(marker) || /\.m3u8(?:[?#]|$)/i.test(path))) return null;

                const url = normalizeChzzkMediaUrl(path, location.origin);
                return url ? { media, url } : null;
            })
            .filter(Boolean);

        if (!hlsMedia.length) return null;

        // 일반 HLS는 플레이리스트 끝이 실시간보다 ~30초 뒤라 미리보기가 뒤처져 보인다.
        // 저지연(LLHLS)이 있으면 본방 플레이어처럼 실시간에 붙도록 먼저 고른다.
        const preferred =
            hlsMedia.find(
                ({ media }) =>
                    String(media?.mediaId || "").toUpperCase() === "LLHLS" ||
                    /lowLatency/i.test(String(media?.latency || ""))
            ) ||
            hlsMedia.find(({ media }) => String(media?.mediaId || "").toUpperCase() === "HLS") ||
            hlsMedia.find(({ media }) => getMediaHeight(media) && getMediaHeight(media) <= PREVIEW_MAX_HEIGHT) ||
            hlsMedia[0];

        return {
            lowLatency:
                String(preferred.media?.mediaId || "").toUpperCase() === "LLHLS" ||
                /lowLatency/i.test(String(preferred.media?.latency || "")),
            url: preferred.url,
        };
    }

    function getPlaybackSource(meta) {
        return selectHlsSource(parsePlaybackJson(meta.playbackJson));
    }

    function canPlayNativeHls(video) {
        return Boolean(
            video.canPlayType?.("application/vnd.apple.mpegurl") || video.canPlayType?.("application/x-mpegURL")
        );
    }

    function setPreviewQualityCap(hls, maxHeight, { setStartLevel = false } = {}) {
        const levels = Array.isArray(hls?.levels) ? hls.levels : [];
        if (!levels.length) return null;

        const sorted = levels
            .map((level, index) => ({ height: Number(level?.height) || 0, index }))
            .sort((a, b) => a.height - b.height || a.index - b.index);
        const capped = [...sorted].reverse().find((level) => level.height && level.height <= maxHeight);
        const selected = capped || sorted[0];
        if (!selected) return null;

        hls.autoLevelCapping = selected.index;
        if (setStartLevel) hls.startLevel = selected.index;
        if ("nextAutoLevel" in hls) hls.nextAutoLevel = selected.index;
        return selected.index;
    }

    function getConfiguredPreviewVolume() {
        const raw = Number(featureOptions.followingPreviewVolumePercent);
        const percent = Number.isFinite(raw) ? Math.min(100, Math.max(1, raw)) : PREVIEW_SOUND_VOLUME_DEFAULT;
        return percent / 100;
    }

    function isPreviewSoundEnabled() {
        return Boolean(featureOptions.followingPreviewSoundEnabled);
    }

    function shouldStartPreviewWithSound(video) {
        return !video?.hasAttribute(FORCE_MUTED_ATTR) && isPreviewSoundEnabled();
    }

    function applyPreviewAudioState(video, soundEnabled, { ensureAudible = false } = {}) {
        if (!video) return;

        if (soundEnabled) {
            let volume = getConfiguredPreviewVolume();
            if (ensureAudible && (!(volume > 0) || !Number.isFinite(volume))) {
                volume = PREVIEW_SOUND_VOLUME_DEFAULT / 100;
            }
            video.muted = false;
            video.defaultMuted = false;
            video.volume = volume;
            video.removeAttribute("muted");
            return;
        }

        video.muted = true;
        video.defaultMuted = true;
        video.volume = 0;
        video.setAttribute("muted", "");
    }

    function isAutoplayBlockedError(error) {
        return error?.name === "NotAllowedError";
    }

    function removeSoundUnlockBadge(video) {
        video?.closest(".bcfp-media")?.querySelector(".bcfp-sound-unlock")?.remove();
    }

    function showSoundUnlockBadge(video, requestId) {
        const media = video?.closest(".bcfp-media");
        if (!media) return;

        removeSoundUnlockBadge(video);

        const button = document.createElement("button");
        button.type = "button";
        button.className = "bcfp-sound-unlock";
        button.textContent = "\uD83D\uDD07";
        button.title = "\uBBF8\uB9AC\uBCF4\uAE30 \uC18C\uB9AC \uCF1C\uAE30";
        button.setAttribute("aria-label", "\uBBF8\uB9AC\uBCF4\uAE30 \uC18C\uB9AC \uCF1C\uAE30");
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            unlockPreviewSound(video, requestId);
        });
        media.appendChild(button);
    }

    function revealVideoWhenReady(video, requestId) {
        const reveal = () => {
            if (activeVideoRequestId !== requestId || activeVideoSession?.video !== video || !video.isConnected) return;
            markPlayerState(video, "ready");
        };

        video.addEventListener("playing", reveal, { once: true });
        video.addEventListener("loadeddata", reveal, { once: true });

        if (video.readyState >= 2) reveal();
    }

    function handlePreviewPlayError(video, requestId, error, attemptedSound) {
        if (activeVideoRequestId !== requestId || activeVideoSession?.video !== video || !video.isConnected) return;

        if (attemptedSound && isAutoplayBlockedError(error)) {
            applyPreviewAudioState(video, false);
            syncPreviewOverlayForVideo(video);
            showSoundUnlockBadge(video, requestId);
            runPreviewPlay(video, requestId, false);
            return;
        }

        markPlayerState(video, "error");
    }

    function runPreviewPlay(video, requestId, attemptedSound) {
        let result = null;
        try {
            result = video.play?.();
        } catch (error) {
            handlePreviewPlayError(video, requestId, error, attemptedSound);
            return;
        }

        if (result?.catch) {
            result
                .then(() => {
                    if (activeVideoRequestId === requestId && activeVideoSession?.video === video && attemptedSound)
                        removeSoundUnlockBadge(video);
                })
                .catch((error) => handlePreviewPlayError(video, requestId, error, attemptedSound));
        } else if (attemptedSound) {
            removeSoundUnlockBadge(video);
        }
    }

    function unlockPreviewSound(video, requestId) {
        if (activeVideoRequestId !== requestId || activeVideoSession?.video !== video || !video.isConnected) return;

        applyPreviewAudioState(video, true, { ensureAudible: true });
        syncPreviewOverlayForVideo(video);
        runPreviewPlay(video, requestId, true);
    }

    function playVideo(video, requestId) {
        if (activeVideoRequestId !== requestId || activeVideoSession?.video !== video || !video.isConnected) return;

        revealVideoWhenReady(video, requestId);

        const soundEnabled = shouldStartPreviewWithSound(video);
        applyPreviewAudioState(video, soundEnabled);
        syncPreviewOverlayForVideo(video);
        if (!soundEnabled) removeSoundUnlockBadge(video);
        runPreviewPlay(video, requestId, soundEnabled);
    }

    function startHlsPlayback(video, source, requestId) {
        const HlsCtor = window.Hls;

        if (HlsCtor?.isSupported?.()) {
            const hls = new HlsCtor({
                backBufferLength: 0,
                capLevelToPlayerSize: true,
                enableWorker: false,
                lowLatencyMode: source.lowLatency,
                maxBufferLength: 12,
            });
            const events = HlsCtor.Events || {};
            const manifestParsedEvent = events.MANIFEST_PARSED || "hlsManifestParsed";
            const errorEvent = events.ERROR || "hlsError";

            activeVideoSession = { hls, video };
            hls.on?.(manifestParsedEvent, () => {
                setPreviewQualityCap(hls, PREVIEW_MAX_HEIGHT, { setStartLevel: true });
                playVideo(video, requestId);
            });
            hls.on?.(errorEvent, (_event, data) => {
                if (!data?.fatal) return;
                if (activeVideoRequestId === requestId && activeVideoSession?.video === video)
                    markPlayerState(video, "error");
            });
            hls.attachMedia?.(video);
            hls.loadSource?.(source.url);
            return true;
        }

        if (canPlayNativeHls(video)) {
            activeVideoSession = { hls: null, video };
            video.src = source.url;
            video.addEventListener("loadedmetadata", () => playVideo(video, requestId), { once: true });
            try {
                video.load?.();
            } catch (_) {
                // Native HLS setup should still try play on metadata.
            }
            return true;
        }

        return false;
    }

    function requestPreviewVideo(video, meta, { playbackDelayMs = PREVIEW_PLAYBACK_DELAY_MS } = {}) {
        if (!video?.isConnected || !meta.playbackJson) return;

        const source = getPlaybackSource(meta);
        if (!source?.url) {
            markPlayerState(video, "error");
            return;
        }

        const requestId = `bcfp${Date.now().toString(36)}${(videoRequestSeq += 1).toString(36)}`;
        activeVideoRequestId = requestId;
        video.setAttribute(PLAYER_MOUNT_ATTR, requestId);
        markPlayerState(video, "loading");

        const startPlayer = () => {
            playerStartTimer = 0;
            if (activeVideoRequestId !== requestId || !video.isConnected) return;

            stopPreviewPlayer();
            activeVideoRequestId = requestId;
            applyPreviewAudioState(video, shouldStartPreviewWithSound(video));
            video.autoplay = true;
            video.controls = false;
            video.playsInline = true;

            if (!startHlsPlayback(video, source, requestId)) markPlayerState(video, "error");
        };

        clearPlayerStartTimer();
        if (playbackDelayMs > 0) {
            playerStartTimer = window.setTimeout(startPlayer, playbackDelayMs);
            return;
        }

        queuePreviewTask(startPlayer);
    }

    function createTextEl(className, text) {
        const el = document.createElement("div");
        el.className = className;
        el.textContent = text;
        return el;
    }

    function createMetaRow(meta) {
        const row = document.createElement("div");
        row.className = "bcfp-meta";

        for (const text of [meta.category].filter(Boolean)) {
            const item = document.createElement("span");
            item.textContent = text;
            row.appendChild(item);
        }

        if (meta.elapsedText) {
            const item = document.createElement("span");
            item.dataset.bcfpElapsed = "1";
            item.textContent = meta.elapsedText;
            row.appendChild(item);
        }

        return row;
    }

    function createMedia(meta) {
        const media = document.createElement("div");
        media.className = "bcfp-media";

        if (meta.thumbnailUrl) {
            const img = document.createElement("img");
            img.alt = "";
            img.decoding = "async";
            img.referrerPolicy = "no-referrer";
            img.src = meta.thumbnailUrl;
            media.appendChild(img);
        }

        if (meta.playbackJson) {
            media.dataset.hasPlayer = "1";

            const video = document.createElement("video");
            video.className = "bcfp-player";
            applyPreviewAudioState(video, shouldStartPreviewWithSound(video));
            video.autoplay = true;
            video.controls = false;
            video.playsInline = true;
            video.setAttribute("playsinline", "");
            video.setAttribute(PLAYER_STATE_ATTR, "loading");
            media.appendChild(video);
            queuePreviewTask(() => requestPreviewVideo(video, meta));
        }

        return media;
    }

    function updateMedia(tip, meta) {
        const existingMedia = tip.querySelector(".bcfp-media");

        if (existingMedia?.querySelector(".bcfp-player")) stopPreviewPlayer();

        const media = createMedia(meta);
        if (existingMedia) existingMedia.replaceWith(media);
        else tip.prepend(media);
        syncPreviewOverlayForVideo(media.querySelector("video.bcfp-player"));

        if (meta.channelId) tip.dataset.channelId = meta.channelId;
        else delete tip.dataset.channelId;
    }

    function createBody(meta) {
        const body = document.createElement("div");
        body.className = "bcfp-body";
        body.append(
            createTextEl("bcfp-channel", meta.channelName),
            createTextEl("bcfp-title", meta.title),
            createMetaRow(meta)
        );
        return body;
    }

    function updateBody(tip, meta) {
        const body = createBody(meta);
        const existingBody = tip.querySelector(".bcfp-body");
        if (existingBody) existingBody.replaceWith(body);
        else tip.appendChild(body);
    }

    function stopElapsedTimer() {
        if (elapsedTimer) {
            window.clearInterval(elapsedTimer);
            elapsedTimer = 0;
        }
        activeMeta = null;
    }

    function updateElapsedText() {
        if (!tooltip?.hasAttribute("data-show") || !activeMeta?.elapsedStartMs) return;

        const elapsed = tooltip.querySelector("[data-bcfp-elapsed='1']");
        if (!elapsed) return;

        const nextText = formatElapsedFromMs(activeMeta.elapsedStartMs);
        if (nextText && elapsed.textContent !== nextText) elapsed.textContent = nextText;
    }

    function startElapsedTimer(meta) {
        stopElapsedTimer();
        if (!meta.elapsedStartMs) return;

        activeMeta = meta;
        updateElapsedText();
        elapsedTimer = window.setInterval(updateElapsedText, ELAPSED_REFRESH_MS);
    }

    function renderPreview(meta, state) {
        const tip = getTooltip();
        const displayMeta = {
            ...meta,
            channelName: meta.channelName || meta.channelId || "",
            elapsedText: meta.elapsedStartMs ? formatElapsedFromMs(meta.elapsedStartMs) : meta.elapsedText,
            title: meta.title || (state === "loading" ? LOADING_TITLE : UNKNOWN_TITLE),
        };

        tip.dataset.state = state;
        updateMedia(tip, displayMeta);
        updateBody(tip, displayMeta);
        tip.setAttribute("data-show", "1");
        startElapsedTimer(displayMeta);
        positionTooltip(activeInfo?.item || activeInfo?.link);
    }

    function stopInjectedDisconnectObserver() {
        injectedDisconnectObserver?.disconnect();
        injectedDisconnectObserver = null;
    }

    function startInjectedDisconnectObserver() {
        stopInjectedDisconnectObserver();
        if (!document.body || !activeInjectedInfo) return;

        injectedDisconnectObserver = new MutationObserver(() => {
            if (
                !activeInjectedInfo?.card?.isConnected ||
                !activeInjectedInfo?.host?.isConnected ||
                (activeInjectedInfo.video && !activeInjectedInfo.video.isConnected)
            ) {
                hideInjectedPreview();
            }
        });
        injectedDisconnectObserver.observe(document.body, { childList: true, subtree: true });
    }

    function clearInjectedFetch() {
        if (injectedFetchController) {
            injectedFetchController.abort();
            injectedFetchController = null;
        }
    }

    function renderInjectedPreview(info, meta) {
        if (activeInjectedInfo !== info || !info.card.isConnected || !info.host.isConnected || !meta.playbackJson) {
            return;
        }

        info.host.querySelectorAll("video.bcfp-list-player").forEach((video) => video.remove());
        const video = document.createElement("video");
        video.className = "bcfp-player bcfp-list-player";
        video.autoplay = true;
        video.controls = false;
        video.playsInline = true;
        video.setAttribute("playsinline", "");
        video.setAttribute(FORCE_MUTED_ATTR, "1");
        video.setAttribute(PLAYER_STATE_ATTR, "loading");
        applyPreviewAudioState(video, false);
        info.video = video;
        info.host.appendChild(video);
        syncPreviewOverlayForVideo(video);
        requestPreviewVideo(video, meta, { playbackDelayMs: 0 });
    }

    function hideInjectedPreview() {
        clearInjectedFetch();
        injectedRequestToken += 1;
        stopInjectedDisconnectObserver();

        const info = activeInjectedInfo;
        activeInjectedInfo = null;
        if (!info) return;

        if (activeListExpansion?.card === info.card) restoreListExpansion();
        clearListPreviewHint(info.card);
        info.card.removeAttribute(ACTIVE_ATTR);
        const players = Array.from(
            new Set([info.video, ...info.host.querySelectorAll("video.bcfp-list-player")].filter(Boolean))
        );
        stopPreviewPlayer();
        for (const video of players) {
            cleanupVideoElement(video);
            video.remove();
        }
    }

    function openInjectedPreview(info) {
        if (activeInjectedInfo?.card === info.card && activeInjectedInfo?.liveId === info.liveId) return;

        hidePreview();
        hideInjectedPreview();
        activeInjectedInfo = info;
        info.card.setAttribute(ACTIVE_ATTR, "1");
        startInjectedDisconnectObserver();
        const token = ++injectedRequestToken;
        const controller = new AbortController();
        injectedFetchController = controller;

        getInjectedPreviewMeta(info, { signal: controller.signal })
            .then((meta) => {
                if (injectedFetchController === controller) injectedFetchController = null;
                if (token !== injectedRequestToken || activeInjectedInfo !== info) return;
                renderInjectedPreview(info, meta);
            })
            .catch((error) => {
                if (injectedFetchController === controller) injectedFetchController = null;
                if (!isAbortError(error) && token === injectedRequestToken && activeInjectedInfo === info) {
                    info.card.removeAttribute(ACTIVE_ATTR);
                }
            });
    }

    function positionTooltip(anchor) {
        if (!tooltip || !anchor?.isConnected) return;

        const margin = 8;
        const gap = 10;

        tooltip.style.left = "0px";
        tooltip.style.top = "0px";
        tooltip.style.visibility = "hidden";
        tooltip.setAttribute("data-show", "1");

        const anchorRect = anchor.getBoundingClientRect();
        const tipRect = tooltip.getBoundingClientRect();
        const width = tipRect.width || Math.min(CARD_WIDTH, window.innerWidth - margin * 2);
        const height = tipRect.height || 270;

        let left = anchorRect.right + gap;
        if (left + width > window.innerWidth - margin) left = anchorRect.left - width - gap;
        if (left < margin) left = Math.max(margin, window.innerWidth - width - margin);

        let top = anchorRect.top + (anchorRect.height - height) / 2;
        if (top < margin) top = margin;
        if (top + height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - height - margin);

        tooltip.style.left = `${Math.round(left)}px`;
        tooltip.style.top = `${Math.round(top)}px`;
        tooltip.style.visibility = "";
        syncHoverBridge(anchorRect, {
            bottom: top + height,
            left,
            right: left + width,
            top,
        });
    }

    function clearOpenTimer() {
        if (!openTimer) return;
        window.clearTimeout(openTimer);
        openTimer = 0;
        pendingInfo = null;
    }

    function clearPreviewFetchTimer() {
        if (!previewFetchTimer) return;
        window.clearTimeout(previewFetchTimer);
        previewFetchTimer = 0;
    }

    function abortActiveFetch() {
        if (!activeFetchController) return;
        activeFetchController.abort();
        activeFetchController = null;
    }

    function isAbortError(error) {
        return error?.name === "AbortError";
    }

    function setActiveItem(item) {
        if (activeInfo?.item && activeInfo.item !== item) activeInfo.item.removeAttribute(ACTIVE_ATTR);
        if (item) item.setAttribute(ACTIVE_ATTR, "1");
    }

    function startPreviewMetaRequest(info, token) {
        if (token !== requestToken || activeInfo?.channelId !== info.channelId) return;

        const fetchController = new AbortController();
        activeFetchController = fetchController;

        getPreviewMeta(info.channelId, info.domMeta, { signal: fetchController.signal })
            .then((meta) => {
                if (activeFetchController === fetchController) activeFetchController = null;
                if (token !== requestToken || activeInfo?.channelId !== info.channelId) return;
                renderPreview(meta, "ready");
            })
            .catch((error) => {
                if (activeFetchController === fetchController) activeFetchController = null;
                if (isAbortError(error)) return;
                if (token !== requestToken || activeInfo?.channelId !== info.channelId) return;
                renderPreview({ ...info.domMeta, title: info.domMeta.title || ERROR_TITLE }, "error");
            });
    }

    function openPreview(info) {
        clearPreviewFetchTimer();
        abortActiveFetch();
        stopPreviewPlayer();
        requestToken += 1;
        const token = requestToken;

        setActiveItem(info.item);
        activeInfo = info;
        renderPreview(info.domMeta, "loading");

        const cachedMeta = getCachedPreviewMeta(info.channelId);
        if (cachedMeta) {
            renderPreview(cachedMeta, "ready");
            return;
        }

        previewFetchTimer = window.setTimeout(() => {
            previewFetchTimer = 0;
            startPreviewMetaRequest(info, token);
        }, FOLLOWING_PREVIEW_FETCH_DELAY_MS);
    }

    function hidePreview() {
        clearOpenTimer();
        clearHoverBridge();
        clearPreviewFetchTimer();
        abortActiveFetch();
        stopElapsedTimer();
        stopPreviewPlayer();
        requestToken += 1;

        if (activeInfo?.item) activeInfo.item.removeAttribute(ACTIVE_ATTR);
        activeInfo = null;

        if (tooltip) {
            clearSoundFeedback(tooltip);
            tooltip.removeAttribute("data-show");
            tooltip.removeAttribute("data-state");
            delete tooltip.dataset.channelId;
            tooltip.replaceChildren();
        }
    }

    function scheduleOpen(info) {
        if (activeInfo?.channelId === info.channelId && activeInfo.item === info.item) {
            positionTooltip(info.item);
            return;
        }

        clearOpenTimer();
        if (HOVER_OPEN_DELAY_MS <= 0) {
            if (!info.item.isConnected || !info.link.isConnected) return;
            openPreview(info);
            return;
        }

        pendingInfo = info;
        openTimer = window.setTimeout(() => {
            openTimer = 0;
            if (!pendingInfo || !pendingInfo.item.isConnected || !pendingInfo.link.isConnected) return;
            openPreview(pendingInfo);
            pendingInfo = null;
        }, HOVER_OPEN_DELAY_MS);
    }

    function isVisiblePreviewVideo(video) {
        if (!(video instanceof HTMLVideoElement) || !video.isConnected) return false;
        if (video.classList.contains("bcfp-player")) {
            return video.getAttribute(PLAYER_STATE_ATTR) === "ready";
        }
        if (video.paused || video.readyState < 2) return false;
        const rect = video.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 45) return false;
        const style = getComputedStyle(video);
        return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    }

    function findLiveListCard(target) {
        if (!(target instanceof Element) || !isLiveListRoute()) return null;
        const marked = target.closest(`[${CATEGORY_CARD_ATTR}="1"]`);
        if (marked instanceof HTMLElement) return marked;

        const directAnchor = target.closest(LIVE_LINK_SELECTOR);
        if (directAnchor instanceof HTMLElement && directAnchor.querySelector("video")) return directAnchor;

        let node = target;
        for (let depth = 0; node instanceof HTMLElement && node !== document.body && depth < 7; depth += 1) {
            if (node.querySelector("video") && node.querySelector(LIVE_LINK_SELECTOR)) return node;
            node = node.parentElement;
        }
        return null;
    }

    function findListPreviewVideo(card, target) {
        const direct = target instanceof Element ? target.closest("video") : null;
        if (direct instanceof HTMLVideoElement && card.contains(direct) && isVisiblePreviewVideo(direct)) return direct;
        return Array.from(card.querySelectorAll("video")).find(isVisiblePreviewVideo) || null;
    }

    function getListPreviewSurface(card, video) {
        return (
            video.closest(`[${CATEGORY_PREVIEW_HOST_ATTR}="1"]`) ||
            video.closest(LIVE_LINK_SELECTOR) ||
            video.parentElement ||
            card
        );
    }

    function restoreVideoAudioState(video, state) {
        if (!(video instanceof HTMLVideoElement) || !state) return;
        video.muted = state.muted;
        video.defaultMuted = state.defaultMuted;
        video.volume = state.volume;
        if (state.hadMutedAttribute) video.setAttribute("muted", "");
        else video.removeAttribute("muted");
    }

    function getListExpansionQualityState(video) {
        const session = activeVideoSession;
        if (session?.video !== video || !session?.hls) return null;
        return {
            capLevelToPlayerSize: session.hls.capLevelToPlayerSize !== false,
            hls: session.hls,
            video,
        };
    }

    function applyListFocusQuality(state) {
        if (!state?.hls || activeVideoSession?.hls !== state.hls || activeVideoSession?.video !== state.video) return;
        try {
            state.hls.capLevelToPlayerSize = false;
            setPreviewQualityCap(state.hls, PREVIEW_FOCUS_MAX_HEIGHT);
        } catch (_) {
            // A disappearing preview may destroy its HLS instance during focus teardown.
        }
    }

    function restoreListPreviewQuality(state) {
        if (!state?.hls || activeVideoSession?.hls !== state.hls || activeVideoSession?.video !== state.video) return;
        try {
            state.hls.capLevelToPlayerSize = state.capLevelToPlayerSize;
            setPreviewQualityCap(state.hls, PREVIEW_MAX_HEIGHT);
        } catch (_) {
            // HLS teardown owns the remaining cleanup when the preview is already gone.
        }
    }

    function stopListExpansionObserver() {
        listExpansionObserver?.disconnect();
        listExpansionObserver = null;
    }

    function startListExpansionObserver(state) {
        stopListExpansionObserver();
        if (!(state?.card instanceof HTMLElement)) return;
        listExpansionObserver = new MutationObserver(() => {
            if (activeListExpansion !== state) return;
            if (!state.card.isConnected || !state.surface?.isConnected || !state.video?.isConnected) {
                restoreListExpansion();
            }
        });
        listExpansionObserver.observe(state.card, { childList: true, subtree: true });
    }

    function restoreListExpansion() {
        const state = activeListExpansion;
        activeListExpansion = null;
        stopListExpansionObserver();
        if (!state) return;

        const previewConnected = state.surface?.isConnected && state.video?.isConnected;
        if (!previewConnected) clearListPreviewHint(state.surface);
        state.surface?.removeAttribute(LIST_EXPANDED_ATTR);
        state.surface?.style?.removeProperty("--bcfp-expand-origin");
        restoreListPreviewQuality(state.quality);
        restoreVideoAudioState(state.video, state.audio);
        if (previewConnected) ensureListPreviewHint(state.surface, false);
    }

    function getExpansionOrigin(surface) {
        const rect = surface.getBoundingClientRect();
        const center = rect.left + rect.width / 2;
        if (center < window.innerWidth / 3) return "left center";
        if (center > (window.innerWidth * 2) / 3) return "right center";
        return "center center";
    }

    function expandListPreview(card, video, surface) {
        restoreListExpansion();
        const audio = {
            defaultMuted: video.defaultMuted,
            hadMutedAttribute: video.hasAttribute("muted"),
            muted: video.muted,
            volume: video.volume,
        };
        const quality = getListExpansionQualityState(video);
        const soundApplied = isRightClickSoundEnabled();

        activeListExpansion = { audio, card, quality, soundApplied, surface, video };
        startListExpansionObserver(activeListExpansion);
        surface.style.setProperty("--bcfp-expand-origin", getExpansionOrigin(surface));
        surface.setAttribute(LIST_EXPANDED_ATTR, "1");
        ensureListPreviewHint(surface, true);
        applyListFocusQuality(quality);
        if (!soundApplied) return;

        applyPreviewAudioState(video, true, { ensureAudible: true });
        if (activeVideoSession?.video === video && activeVideoRequestId) {
            runPreviewPlay(video, activeVideoRequestId, true);
        }
    }

    function disableListExpansionSound() {
        const state = activeListExpansion;
        if (!state?.soundApplied) return;
        state.soundApplied = false;
        restoreVideoAudioState(state.video, state.audio);
        ensureListPreviewHint(state.surface, true);
    }

    function syncAudibleActivePreviewVolume() {
        const volume = getConfiguredPreviewVolume();
        const sessionVideo = activeVideoSession?.video;
        if (sessionVideo?.isConnected && !sessionVideo.muted) sessionVideo.volume = volume;

        const focused = activeListExpansion;
        if (
            focused?.soundApplied &&
            focused.video !== sessionVideo &&
            focused.video?.isConnected &&
            !focused.video.muted
        ) {
            focused.video.volume = volume;
        }
    }

    function persistFollowingPreviewSound(enabled) {
        featureOptions = { ...featureOptions, followingPreviewSoundEnabled: enabled };
        if (typeof storageSet !== "function") return;
        void storageSet(globalThis.chrome?.storage?.sync, { followingPreviewSoundEnabled: enabled }).catch(() => {});
    }

    function clearSoundFeedback(container = null) {
        if (container && soundFeedbackEl && !container.contains(soundFeedbackEl)) return;
        if (soundFeedbackTimer) {
            window.clearTimeout(soundFeedbackTimer);
            soundFeedbackTimer = 0;
        }
        soundFeedbackSurface?.classList.remove("bcfp-sound-feedback-host");
        soundFeedbackEl?.remove();
        soundFeedbackEl = null;
        soundFeedbackSurface = null;
    }

    function clearListPreviewHint(container = null) {
        if (container && listHintEl && !container.contains(listHintEl)) return;
        listHintSurface?.classList.remove("bcfp-list-hint-host");
        listHintEl?.remove();
        listHintEl = null;
        listHintSurface = null;
    }

    function getListPreviewHintText() {
        return isRightClickSoundEnabled() ? "우클릭 시 확대 및 소리 재생" : "우클릭 시 확대";
    }

    function ensureListPreviewHint(surface, expanded = surface?.hasAttribute?.(LIST_EXPANDED_ATTR)) {
        if (!(surface instanceof HTMLElement) || !surface.isConnected) return null;
        if (expanded) {
            clearListPreviewHint();
            return null;
        }
        if (listHintSurface !== surface || !listHintEl?.isConnected) clearListPreviewHint();

        if (!listHintEl) {
            const hint = document.createElement("div");
            hint.className = "bcfp-list-hint";
            hint.setAttribute(LIST_HINT_ATTR, "1");
            hint.setAttribute("aria-hidden", "true");

            const surfacePosition = window.getComputedStyle(surface).position;
            if (!surfacePosition || surfacePosition === "static") {
                surface.classList.add("bcfp-list-hint-host");
            }
            surface.appendChild(hint);
            listHintEl = hint;
            listHintSurface = surface;
        }

        listHintEl.textContent = getListPreviewHintText();
        return listHintEl;
    }

    function createSoundFeedbackIcon(soundOn) {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.classList.add("bcfp-sound-feedback-icon");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");

        const speaker = document.createElementNS("http://www.w3.org/2000/svg", "path");
        speaker.setAttribute("fill", "currentColor");
        speaker.setAttribute("d", "M4 9v6h4l5 4V5L8 9H4Z");
        svg.appendChild(speaker);

        const state = document.createElementNS("http://www.w3.org/2000/svg", "path");
        state.setAttribute("fill", "none");
        state.setAttribute("stroke", "currentColor");
        state.setAttribute("stroke-linecap", "round");
        state.setAttribute("stroke-linejoin", "round");
        state.setAttribute("stroke-width", "2");
        state.setAttribute("d", soundOn ? "M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" : "m16 9 5 5m0-5-5 5");
        svg.appendChild(state);
        return svg;
    }

    function updateSoundFeedbackState(feedback, soundOn) {
        feedback.setAttribute("data-sound", soundOn ? "on" : "off");
        feedback.setAttribute("data-tooltip", soundOn ? "우클릭으로 소리 끄기" : "우클릭으로 소리 켜기");
        feedback.setAttribute(
            "aria-label",
            soundOn ? "미리보기 소리 켜짐, 우클릭으로 소리 끄기" : "미리보기 소리 꺼짐, 우클릭으로 소리 켜기"
        );
        feedback.querySelector(".bcfp-sound-feedback-icon")?.replaceWith(createSoundFeedbackIcon(soundOn));
        const label = feedback.querySelector(".bcfp-sound-feedback-label");
        if (label) label.textContent = soundOn ? "소리 켜짐" : "소리 꺼짐";
    }

    function ensureSoundFeedback(surface, soundOn) {
        if (!isRightClickSoundEnabled() || !(surface instanceof HTMLElement) || !surface.isConnected) return null;
        if (soundFeedbackSurface !== surface || !soundFeedbackEl?.isConnected) clearSoundFeedback();

        if (!soundFeedbackEl) {
            const feedback = document.createElement("div");
            feedback.className = "bcfp-sound-feedback";
            feedback.setAttribute(SOUND_FEEDBACK_ATTR, "1");
            feedback.setAttribute("aria-atomic", "true");

            const label = document.createElement("span");
            label.className = "bcfp-sound-feedback-label";
            feedback.append(createSoundFeedbackIcon(soundOn), label);

            const surfacePosition = window.getComputedStyle(surface).position;
            if (!surfacePosition || surfacePosition === "static") {
                surface.classList.add("bcfp-sound-feedback-host");
            }
            surface.appendChild(feedback);
            soundFeedbackEl = feedback;
            soundFeedbackSurface = surface;
        }

        updateSoundFeedbackState(soundFeedbackEl, soundOn);
        return soundFeedbackEl;
    }

    function syncPreviewOverlayForVideo(video) {
        if (!(video instanceof HTMLVideoElement) || !video.isConnected) return null;
        const followingMedia = video.closest(`#${TOOLTIP_ID} .bcfp-media`);
        if (followingMedia instanceof HTMLElement) {
            clearListPreviewHint();
            return ensureSoundFeedback(followingMedia, !video.muted && video.volume > 0);
        }

        const card = findLiveListCard(video);
        const surface = card ? getListPreviewSurface(card, video) : null;
        if (!(surface instanceof HTMLElement)) return null;
        clearSoundFeedback();
        return ensureListPreviewHint(surface);
    }

    function showSoundFeedback(surface, soundOn) {
        const feedback = ensureSoundFeedback(surface, soundOn);
        if (!feedback) return;

        feedback.setAttribute("role", "status");
        feedback.setAttribute("aria-live", "polite");
        feedback.setAttribute("data-expanded", "1");
        if (soundFeedbackTimer) window.clearTimeout(soundFeedbackTimer);
        soundFeedbackTimer = window.setTimeout(() => {
            if (soundFeedbackEl !== feedback) return;
            soundFeedbackTimer = 0;
            feedback.removeAttribute("data-expanded");
        }, SOUND_FEEDBACK_DURATION_MS);
    }

    function toggleFollowingPreviewSound(video) {
        const soundOn = !video.muted && video.volume > 0;
        const nextSoundOn = !soundOn;
        applyPreviewAudioState(video, nextSoundOn, { ensureAudible: nextSoundOn });
        if (nextSoundOn && activeVideoSession?.video === video && activeVideoRequestId) {
            runPreviewPlay(video, activeVideoRequestId, true);
        } else if (!nextSoundOn) {
            removeSoundUnlockBadge(video);
        }
        tooltip?.setAttribute("data-sound", nextSoundOn ? "on" : "off");
        persistFollowingPreviewSound(nextSoundOn);
        return nextSoundOn;
    }

    function handleContextMenu(event) {
        if (!(event.target instanceof Element)) return;

        const followingTip = event.target.closest(`#${TOOLTIP_ID}`);
        if (followingTip && followingTip === tooltip) {
            if (!isRightClickSoundEnabled()) return;
            const media = event.target.closest(".bcfp-media");
            const video = media?.querySelector("video.bcfp-player");
            if (!media || !followingTip.contains(media) || !isVisiblePreviewVideo(video)) return;
            event.preventDefault();
            event.stopPropagation();
            showSoundFeedback(media, toggleFollowingPreviewSound(video));
            return;
        }

        const card = findLiveListCard(event.target);
        if (!card) return;
        const video = findListPreviewVideo(card, event.target);
        if (!video) return;
        const surface = getListPreviewSurface(card, video);
        if (!(surface instanceof HTMLElement) || !surface.contains(event.target)) return;

        event.preventDefault();
        event.stopPropagation();
        if (activeListExpansion?.video === video) {
            restoreListExpansion();
            return;
        }
        expandListPreview(card, video, surface);
    }

    function handleKeyDown(event) {
        if (event.key === "Escape") restoreListExpansion();
    }

    function handlePointerDown(event) {
        if (!activeListExpansion || !(event.target instanceof Node)) return;
        if (!activeListExpansion.surface?.contains(event.target)) restoreListExpansion();
    }

    function handlePageChange() {
        clearSoundFeedback();
        restoreListExpansion();
        clearListPreviewHint();
        hideInjectedPreview();
        hidePreview();
    }

    function handlePointerOver(event) {
        const injectedInfo = resolveInjectedPreviewInfo(event.target);
        if (injectedInfo) {
            openInjectedPreview(injectedInfo);
            return;
        }
        const info = resolveHoverInfo(event.target);
        if (!info) {
            const card = findLiveListCard(event.target);
            const video = card ? findListPreviewVideo(card, event.target) : null;
            if (video) syncPreviewOverlayForVideo(video);
            return;
        }
        hideInjectedPreview();
        scheduleOpen(info);
    }

    function handlePointerOut(event) {
        const related = event.relatedTarget;
        if (
            listHintSurface?.contains(event.target) &&
            !(related instanceof Node && listHintSurface.contains(related)) &&
            !activeInjectedInfo?.card?.contains(listHintSurface)
        ) {
            clearListPreviewHint(listHintSurface);
        }
        if (activeListExpansion && !(related instanceof Node && activeListExpansion.surface?.contains(related))) {
            restoreListExpansion();
        }

        if (activeInjectedInfo) {
            if (related instanceof Node && activeInjectedInfo.card.contains(related)) return;
            const movedToSameCard =
                related instanceof Element && resolveInjectedPreviewInfo(related)?.card === activeInjectedInfo.card;
            if (movedToSameCard) return;
            hideInjectedPreview();
        }

        if (!activeInfo && !pendingInfo) return;

        const current = activeInfo || pendingInfo;
        if (related instanceof Node && current.item?.contains(related)) return;
        if (related instanceof Node && tooltip?.contains(related)) return;
        if (related instanceof Node && hoverBridge?.contains(related)) return;

        const movedToSameItem = related instanceof Element && resolveHoverInfo(related)?.item === current.item;
        if (movedToSameItem) return;

        hidePreview();
    }

    function handleTooltipPointerLeave(event) {
        const related = event.relatedTarget;
        if (related instanceof Node && activeInfo?.item?.contains(related)) return;
        if (related instanceof Node && hoverBridge?.contains(related)) return;
        hidePreview();
    }

    function handlePreviewPlaying(event) {
        if (event.target instanceof HTMLVideoElement) syncPreviewOverlayForVideo(event.target);
    }

    function handleViewportChange() {
        restoreListExpansion();
        if (activeInjectedInfo && (!activeInjectedInfo.card.isConnected || !activeInjectedInfo.host.isConnected)) {
            hideInjectedPreview();
        }
        if (activeInfo?.item?.isConnected) positionTooltip(activeInfo.item);
        else if (activeInfo) hidePreview();
    }

    function installListeners() {
        if (listenersInstalled) return;

        listenersInstalled = true;
        injectStyleOnce(STYLE_ID, STYLE_TEXT);
        document.addEventListener("pointerover", handlePointerOver, true);
        document.addEventListener("pointerout", handlePointerOut, true);
        document.addEventListener("pointerdown", handlePointerDown, true);
        document.addEventListener("contextmenu", handleContextMenu, true);
        document.addEventListener("keydown", handleKeyDown, true);
        document.addEventListener("playing", handlePreviewPlaying, true);
        window.addEventListener("scroll", handleViewportChange, true);
        window.addEventListener("resize", handleViewportChange);
        removePageChangeDetection = startPageChangeDetection(handlePageChange);
    }

    function uninstallListeners() {
        if (!listenersInstalled) return;

        listenersInstalled = false;
        document.removeEventListener("pointerover", handlePointerOver, true);
        document.removeEventListener("pointerout", handlePointerOut, true);
        document.removeEventListener("pointerdown", handlePointerDown, true);
        document.removeEventListener("contextmenu", handleContextMenu, true);
        document.removeEventListener("keydown", handleKeyDown, true);
        document.removeEventListener("playing", handlePreviewPlaying, true);
        window.removeEventListener("scroll", handleViewportChange, true);
        window.removeEventListener("resize", handleViewportChange);

        if (removePageChangeDetection) {
            removePageChangeDetection();
            removePageChangeDetection = null;
        }

        handlePageChange();
        clearSoundFeedback();
        clearListPreviewHint();
        if (tooltip) {
            tooltip.remove();
            tooltip = null;
        }
        document.getElementById(STYLE_ID)?.remove();
    }

    function applyOptions(options) {
        const previousOptions = featureOptions;
        featureOptions = options;
        publishFastHoverOptions();
        if (previousOptions.livePreviewRightClickSoundEnabled !== false && !isRightClickSoundEnabled()) {
            disableListExpansionSound();
            clearSoundFeedback();
        }
        if (previousOptions.livePreviewRightClickSoundEnabled !== options.livePreviewRightClickSoundEnabled) {
            if (listHintSurface?.isConnected) {
                ensureListPreviewHint(listHintSurface, activeListExpansion?.surface === listHintSurface);
            }
            syncPreviewOverlayForVideo(activeVideoSession?.video || activeInjectedInfo?.video);
        }
        if (previousOptions.followingPreviewVolumePercent !== options.followingPreviewVolumePercent) {
            syncAudibleActivePreviewVolume();
        }
        if (isFeatureEnabled()) installListeners();
        else uninstallListeners();
    }

    bindFeatureOptions(applyOptions);
    onReady(() => {
        publishFastHoverOptions();
        if (isFeatureEnabled()) installListeners();
    });
})();
