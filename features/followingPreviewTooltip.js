/**
 * features/followingPreviewTooltip.js — 팔로잉 사이드바 라이브 링크 호버 시 라이브 미리보기 툴팁을 띄운다.
 *
 * 동작 위치: isolated world, chzzk.naver.com 전역의 팔로잉 사이드바(a[href*='/live/'] 링크 영역).
 * 하는 일: pointerover/pointerout으로 호버 대상을 감지해 DOM에서 채널명/제목/썸네일을 우선
 *   추정(domMeta)한 뒤 tooltip을 즉시 표시하고, live-detail 및 auto-play-info API로 실제 방송
 *   정보와 HLS 재생 경로(playbackJson)를 받아온다. 팝업/새 창/외부 프레임 폴백 없이 인라인 video
 *   요소로 재생하며, HLS 소스가 있으면 전역 Hls로 붙이고 없으면 네이티브 HLS 재생을 시도한다.
 *   자동재생이 소리와 함께 막히면 소리 켜기 배지를 보여주고 무음으로 재생한다. 페이지 이동/포인터
 *   이탈 시 플레이어를 정리하고 툴팁을 숨긴다.
 * 의존: 전역 BetterChzzkSettings.normalizeOptions, BetterChzzk.utils(bindFeatureOptions,
 *   fetchJson, getMainVideoElement, injectStyleOnce, normSpace, onReady,
 *   startPageChangeDetection), vendor/hls.light.min.js가 제공하는 전역 window.Hls.
 * 옵션 키: followingPreviewTooltipEnabled, followingPreviewSoundEnabled.
 * DOM 마커: #betterchzzk-following-preview 툴팁, data-bcfp-tooltip/data-bcfp-active/
 *   data-bcfp-player-mount/data-bcfp-player-state 속성, .bcfp-* 클래스.
 * 통신: 없음(다른 파일과 CustomEvent·storage 키를 주고받지 않음).
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
    const LIVE_LINK_SELECTOR = "a[href*='/live/']";
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
    const PREVIEW_FETCH_DELAY_MS = 100;
    const PREVIEW_PLAYBACK_DELAY_MS = 300;
    const PREVIEW_MAX_HEIGHT = 480;
    const PREVIEW_SOUND_VOLUME_DEFAULT = 15;
    const LIVE_PLAYER_VOLUME_STORAGE_KEY = "live-player-volume";
    const FETCH_TIMEOUT_MS = 8000;
    const CACHE_TTL_MS = 20000;
    const MAX_CACHE_ENTRIES = 80;
    const CARD_WIDTH = 460;
    const PLAYER_MOUNT_ATTR = "data-bcfp-player-mount";
    const PLAYER_STATE_ATTR = "data-bcfp-player-state";
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
        getMainVideoElement,
        injectStyleOnce,
        normSpace,
        onReady,
        startPageChangeDetection,
    } = BetterChzzk.utils;

    let featureOptions = BetterChzzkSettings.normalizeOptions();
    let listenersInstalled = false;
    let tooltip = null;
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

    function normalizeUrl(value) {
        const raw = pickString(value);
        if (!raw) return "";

        const withSize = raw.replace(/\{type\}|%7Btype%7D/gi, "480");
        if (/^(?:https?:|data:|blob:)/i.test(withSize)) return withSize;
        if (withSize.startsWith("//")) return `${location.protocol}${withSize}`;

        try {
            return new URL(withSize, location.origin).href;
        } catch (_) {
            return withSize;
        }
    }

    function normalizeImageUrl(value) {
        return normalizeUrl(value);
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

    function getFollowingSidebarContainer(link) {
        for (let node = link.parentElement; node && node !== document.body; node = node.parentElement) {
            if (!(node instanceof HTMLElement)) continue;

            const marker = getElementMarker(node);
            const isSideLike = node.matches(SIDE_CONTAINER_SELECTOR) || FOLLOWING_TEXT_RE.test(marker);
            if (isSideLike && hasFollowingSignal(node)) return node;
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
            playbackJson: pickRawString(fallback.playbackJson),
            isPreviewPlayback: Boolean(fallback.isPreviewPlayback),
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
            return normalizeAutoPlayInfo(playback, meta);
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
        const hlsMedia = mediaList.filter((media) => {
            const path = pickRawString(media?.path);
            const marker = pickString(media?.mediaId, media?.protocol);
            return path && (/HLS/i.test(marker) || /\.m3u8(?:[?#]|$)/i.test(path));
        });

        if (!hlsMedia.length) return null;

        // 일반 HLS는 플레이리스트 끝이 실시간보다 ~30초 뒤라 미리보기가 뒤처져 보인다.
        // 저지연(LLHLS)이 있으면 본방 플레이어처럼 실시간에 붙도록 먼저 고른다.
        const preferred =
            hlsMedia.find(
                (media) =>
                    String(media?.mediaId || "").toUpperCase() === "LLHLS" ||
                    /lowLatency/i.test(String(media?.latency || ""))
            ) ||
            hlsMedia.find((media) => String(media?.mediaId || "").toUpperCase() === "HLS") ||
            hlsMedia.find((media) => getMediaHeight(media) && getMediaHeight(media) <= PREVIEW_MAX_HEIGHT) ||
            hlsMedia[0];

        return {
            lowLatency:
                String(preferred?.mediaId || "").toUpperCase() === "LLHLS" ||
                /lowLatency/i.test(String(preferred?.latency || "")),
            url: normalizeUrl(preferred.path),
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

    function capPreviewLevel(hls) {
        const levels = Array.isArray(hls?.levels) ? hls.levels : [];
        if (!levels.length) return;

        const sorted = levels
            .map((level, index) => ({ height: Number(level?.height) || 0, index }))
            .sort((a, b) => a.height - b.height || a.index - b.index);
        const capped = [...sorted].reverse().find((level) => level.height && level.height <= PREVIEW_MAX_HEIGHT);
        const selected = capped || sorted[0];
        if (!selected) return;

        hls.autoLevelCapping = selected.index;
        hls.startLevel = selected.index;
        hls.nextLevel = selected.index;
    }

    function normalizePlayerVolume(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return null;
        if (parsed >= 0 && parsed <= 1) return parsed;
        if (parsed > 1 && parsed <= 100) return parsed / 100;
        return null;
    }

    function readStoredPlayerVolume() {
        try {
            const storage = window.localStorage;
            if (!storage) return null;

            // CHZZK stores the main player volume as {"value":N} under this key.
            const liveVolume = parseStoredVolume(storage.getItem(LIVE_PLAYER_VOLUME_STORAGE_KEY));
            if (liveVolume !== null) return liveVolume;

            const embedCandidates = [];
            for (let index = 0; index < storage.length; index += 1) {
                const key = storage.key(index);
                if (!key || !key.endsWith("player-volume") || key.endsWith("-muted")) continue;
                if (key.startsWith("embed")) {
                    embedCandidates.push(key);
                    continue;
                }

                const volume = parseStoredVolume(storage.getItem(key));
                if (volume !== null) return volume;
            }

            for (const key of embedCandidates) {
                const volume = parseStoredVolume(storage.getItem(key));
                if (volume !== null) return volume;
            }
        } catch (_error) {
            return null;
        }

        return null;
    }

    function parseStoredVolume(raw) {
        if (raw == null) return null;
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
                return normalizePlayerVolume(parsed.value);
            }
            return normalizePlayerVolume(parsed);
        } catch (_error) {
            return normalizePlayerVolume(raw);
        }
    }

    function getPreferredPlayerVolume() {
        const mainVideo = typeof getMainVideoElement === "function" ? getMainVideoElement() : null;
        if (mainVideo && Number.isFinite(mainVideo.volume)) {
            return mainVideo.volume;
        }

        const stored = readStoredPlayerVolume();
        if (stored !== null) return stored;

        return PREVIEW_SOUND_VOLUME_DEFAULT / 100;
    }

    function isPreviewSoundEnabled() {
        return Boolean(featureOptions.followingPreviewSoundEnabled);
    }

    function applyPreviewAudioState(video, soundEnabled) {
        if (!video) return;

        if (soundEnabled) {
            video.muted = false;
            video.defaultMuted = false;
            video.volume = getPreferredPlayerVolume();
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

        applyPreviewAudioState(video, true);
        runPreviewPlay(video, requestId, true);
    }

    function playVideo(video, requestId) {
        if (activeVideoRequestId !== requestId || activeVideoSession?.video !== video || !video.isConnected) return;

        revealVideoWhenReady(video, requestId);

        const soundEnabled = isPreviewSoundEnabled();
        applyPreviewAudioState(video, soundEnabled);
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
                capPreviewLevel(hls);
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

    function requestPreviewVideo(video, meta) {
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
            applyPreviewAudioState(video, isPreviewSoundEnabled());
            video.autoplay = true;
            video.controls = false;
            video.playsInline = true;

            if (!startHlsPlayback(video, source, requestId)) markPlayerState(video, "error");
        };

        clearPlayerStartTimer();
        if (PREVIEW_PLAYBACK_DELAY_MS > 0) {
            playerStartTimer = window.setTimeout(startPlayer, PREVIEW_PLAYBACK_DELAY_MS);
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
            video.title = `${meta.channelName || meta.channelId} \uB77C\uC774\uBE0C \uBBF8\uB9AC\uBCF4\uAE30`;
            applyPreviewAudioState(video, isPreviewSoundEnabled());
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
        }, PREVIEW_FETCH_DELAY_MS);
    }

    function hidePreview() {
        clearOpenTimer();
        clearPreviewFetchTimer();
        abortActiveFetch();
        stopElapsedTimer();
        stopPreviewPlayer();
        requestToken += 1;

        if (activeInfo?.item) activeInfo.item.removeAttribute(ACTIVE_ATTR);
        activeInfo = null;

        if (tooltip) {
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

    function handlePointerOver(event) {
        const info = resolveHoverInfo(event.target);
        if (!info) return;
        scheduleOpen(info);
    }

    function handlePointerOut(event) {
        if (!activeInfo && !pendingInfo) return;

        const current = activeInfo || pendingInfo;
        const related = event.relatedTarget;
        if (related instanceof Node && current.item?.contains(related)) return;
        if (related instanceof Node && tooltip?.contains(related)) return;

        const movedToSameItem = related instanceof Element && resolveHoverInfo(related)?.item === current.item;
        if (movedToSameItem) return;

        hidePreview();
    }

    function handleTooltipPointerLeave(event) {
        const related = event.relatedTarget;
        if (related instanceof Node && activeInfo?.item?.contains(related)) return;
        hidePreview();
    }

    function handleViewportChange() {
        if (activeInfo?.item?.isConnected) positionTooltip(activeInfo.item);
        else hidePreview();
    }

    function installListeners() {
        if (listenersInstalled) return;

        listenersInstalled = true;
        injectStyleOnce(STYLE_ID, STYLE_TEXT);
        document.addEventListener("pointerover", handlePointerOver, true);
        document.addEventListener("pointerout", handlePointerOut, true);
        window.addEventListener("scroll", handleViewportChange, true);
        window.addEventListener("resize", handleViewportChange);
        removePageChangeDetection = startPageChangeDetection(hidePreview);
    }

    function uninstallListeners() {
        if (!listenersInstalled) return;

        listenersInstalled = false;
        document.removeEventListener("pointerover", handlePointerOver, true);
        document.removeEventListener("pointerout", handlePointerOut, true);
        window.removeEventListener("scroll", handleViewportChange, true);
        window.removeEventListener("resize", handleViewportChange);

        if (removePageChangeDetection) {
            removePageChangeDetection();
            removePageChangeDetection = null;
        }

        hidePreview();
        if (tooltip) {
            tooltip.remove();
            tooltip = null;
        }
        document.getElementById(STYLE_ID)?.remove();
    }

    function applyOptions(options) {
        featureOptions = options;
        if (isFeatureEnabled()) installListeners();
        else uninstallListeners();
    }

    bindFeatureOptions(applyOptions);
    onReady(() => {
        if (isFeatureEnabled()) installListeners();
    });
})();
